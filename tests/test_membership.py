"""Membership revocation/queue integrity on real PostgreSQL and restricted roles."""

import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

from postgres_support import ADMIN_DSN
from staff_support import StaffApiCase

if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from prsystem.auth import StaffAuth, digest
    from prsystem.common import DomainError
    from prsystem.membership import MembershipService
    from prsystem.postgres.connection import transaction


@unittest.skipUnless(ADMIN_DSN, "PRSYSTEM_TEST_ADMIN_DSN is not set")
class MembershipTests(StaffApiCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                "GRANT SELECT ON prsystem.staff_link, prsystem.staff_command_receipt, prsystem.staff_open_work, prsystem.staff_work_exception TO {}",
                "GRANT INSERT ON prsystem.staff_command_receipt, prsystem.staff_change_event, prsystem.staff_open_work, prsystem.staff_work_exception TO {}",
                "GRANT UPDATE (status, roles) ON prsystem.staff_membership TO {}",
                "GRANT UPDATE (state) ON prsystem.staff_link, prsystem.staff_open_work TO {}",
                "GRANT UPDATE (claimant_id, revision) ON prsystem.staff_work_exception TO {}",
            ):
                conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp()
        self.admin = self.token()
        self.target, self.target_token = self.add_staff(["RECEPTION", "CLEANER"])
        self.manager, self.manager_token = self.add_staff(["MANAGER"])
        self.flow = MembershipService(StaffAuth(self.app_dsn, self.settings))

    def add_staff(self, roles, tenant=None):
        account = uuid4().hex
        tenant = tenant or self.tenant
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("INSERT INTO prsystem.staff_account (id, email, password_hash, verified_at) VALUES (%s, %s, %s, now())",
                         (account, account + "@example.test", self.password_hash))
            conn.execute("INSERT INTO prsystem.staff_membership (tenant_id, account_id, status, roles) VALUES (%s, %s, 'ACTIVE', %s)",
                         (tenant, account, roles))
        return account, self.login_staff(account, tenant)

    def login_staff(self, account, tenant=None):
        r = self.client.post("/auth/login", json={"email": account + "@example.test", "password": self.password, "tenant_id": tenant or self.tenant})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["access_token"]

    def change(self, action="suspend", target=None, revision=0, token=None, tenant=None, **extra):
        body = {"expected_revision": revision, "idempotency_key": action, "reason": "Staff lifecycle test"}
        body.update(extra)
        return self.client.post(f"/hotels/{tenant or self.tenant}/staff/{target or self.target}/{action}",
                                json=body, headers=self.headers(token or self.admin))

    def register(self, kind="SHIFT", source="sa", owner=None):
        with transaction(self.app_dsn) as conn:
            return self.flow.register_open_work(conn, self.tenant, owner or self.target, kind, source)

    def queue(self, token=None, tenant=None, **params):
        return self.client.get(f"/hotels/{tenant or self.tenant}/staff-work/exceptions",
                               headers=self.headers(token or self.manager_token), params=params)

    def claim(self, queue_id, token=None, revision=0, key="claim"):
        return self.client.post(f"/hotels/{self.tenant}/staff-work/exceptions/{queue_id}/claim",
            headers=self.headers(token or self.manager_token), json={"expected_revision": revision, "idempotency_key": key})

    def test_scope_revocation_preserves_other_hotel_and_history(self):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("INSERT INTO prsystem.staff_membership (tenant_id, account_id, status, roles) VALUES (%s, %s, 'ACTIVE', ARRAY['RECEPTION'])", (self.other, self.target))
        other_token = self.login_staff(self.target, self.other)
        r = self.change()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["revision"], 1)
        self.assertEqual(self.me(self.target_token).status_code, 401)
        self.assertEqual(self.me(other_token).status_code, 200)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.staff_membership WHERE account_id = %s", (self.target,)).fetchone()[0], 2)
            self.assertEqual(conn.execute("SELECT auth_epoch FROM prsystem.staff_account WHERE id = %s", (self.target,)).fetchone()[0], 0)
            event = conn.execute("SELECT actor_id, target_id, details FROM prsystem.staff_change_event WHERE tenant_id = %s", (self.tenant,)).fetchone()
            self.assertEqual(event[:2], (self.account, self.target))
            self.assertEqual(event[2]["before"]["status"], "ACTIVE")

    def test_roles_change_requires_new_login(self):
        r = self.change("roles", roles=["MANAGER"])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.me(self.target_token).status_code, 401)
        fresh = self.login_staff(self.target)
        self.assertEqual(self.me(fresh).json()["roles"], ["MANAGER"])

    def test_terminate_and_reactivate_reuses_member_never_restores_sessions(self):
        self.assertEqual(self.change("terminate").status_code, 200)
        self.assertEqual(self.change("reactivate", revision=1).status_code, 200)
        self.assertEqual(self.me(self.target_token).status_code, 401)
        self.assertEqual(self.me(self.login_staff(self.target)).status_code, 200)
        self.assertEqual(self.change("reactivate", revision=2, idempotency_key="again").status_code, 409)

    def test_primary_cannot_be_suspended_terminated_or_demoted(self):
        for action, extra in [("suspend", {}), ("terminate", {}), ("roles", {"roles": ["MANAGER"]})]:
            r = self.change(action, target=self.account, **extra)
            self.assertEqual(r.json()["code"], "PRIMARY_ADMIN_PROTECTED")
        self.assertEqual(self.me(self.admin).status_code, 200)

    def test_primary_can_add_operational_role_with_fresh_session(self):
        r = self.change("roles", target=self.account, roles=["HOTEL_ADMIN", "MANAGER"])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.queue(self.admin).status_code, 401)
        self.assertEqual(self.queue(self.token()).status_code, 200)

    def test_primary_grants_duplicate_and_unknown_roles_denied(self):
        for roles in [["HOTEL_ADMIN"], ["RECEPTION", "RECEPTION"], ["OPERATION"], ["RESTAURANT_MANAGER"]]:
            self.assertEqual(self.change("roles", roles=roles).status_code, 403)

    def test_manager_reception_and_cross_tenant_cannot_mutate(self):
        for token in [self.manager_token, self.target_token]:
            self.assertEqual(self.change(token=token).status_code, 403)
        self.assertEqual(self.change(tenant=self.other).status_code, 403)
        self.assertEqual(self.change(target=uuid4().hex).status_code, 404)

    def test_package_downgrade_allows_revocation_but_blocks_role_restore(self):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.hotel_access SET package_mnt = 20000 WHERE tenant_id = %s", (self.tenant,))
        self.assertEqual(self.change("roles", roles=["CLEANER"]).status_code, 403)
        self.assertEqual(self.change().status_code, 200)
        self.assertEqual(self.change("reactivate", revision=1).status_code, 403)
        self.assertEqual(self.change("roles", revision=1, roles=["RECEPTION"]).status_code, 200)
        self.assertEqual(self.change("reactivate", revision=2).status_code, 200)

    def test_subscription_and_security_gate_apply(self):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.hotel_access SET expires_at = now() - interval '3 days' WHERE tenant_id = %s", (self.tenant,))
        self.assertEqual(self.change().json()["code"], "SUBSCRIPTION_EXPIRED")
        self.assertEqual(self.queue().json()["code"], "SUBSCRIPTION_EXPIRED")
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.hotel_access SET security_suspended = true WHERE tenant_id = %s", (self.tenant,))
        self.assertEqual(self.change().json()["code"], "SECURITY_SUSPENDED")

    def test_reason_revision_and_transition_validation(self):
        for extra in [{"reason": "   "}, {"expected_revision": True}, {"reason": ""}, {"unexpected": 1}]:
            self.assertEqual(self.change(**extra).status_code, 422)
        self.assertEqual(self.change("reactivate").status_code, 409)
        self.assertEqual(self.change(revision=1).json()["code"], "REVISION_CONFLICT")
        self.assertEqual(self.change().status_code, 200)
        self.assertEqual(self.change(revision=1, idempotency_key="another").status_code, 409)

    def test_idempotency_replay_and_conflict_create_one_event(self):
        first = self.change()
        self.assertEqual(self.change().json(), first.json())
        self.assertEqual(self.change(reason="changed").json()["code"], "IDEMPOTENCY_CONFLICT")
        with psycopg.connect(self.owner_dsn) as conn:
            for table in ["staff_change_event", "staff_command_receipt"]:
                count = conn.execute(sql.SQL("SELECT count(*) FROM prsystem.{} WHERE tenant_id = %s").format(sql.Identifier(table)), (self.tenant,)).fetchone()[0]
                self.assertEqual(count, 1)

    def test_concurrent_role_and_suspend_one_revision_wins(self):
        barrier = Barrier(2)
        def run(action):
            barrier.wait()
            return self.change(action, **({"roles": ["MANAGER"]} if action == "roles" else {})).status_code
        with ThreadPoolExecutor(2) as pool:
            self.assertEqual(sorted(pool.map(run, ["roles", "suspend"])), [200, 409])

    def test_concurrent_duplicate_suspend_returns_same_receipt(self):
        barrier = Barrier(2)
        def run(_):
            barrier.wait()
            return self.change().json()
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(run, range(2)))
        self.assertEqual(results[0], results[1])
        self.assertEqual(results[0]["revision"], 1)

    def test_suspension_queues_shift_and_cleaning_without_moving_cash(self):
        work = self.register()
        self.assertEqual(self.register(), work)
        self.register("CLEANING_TASK", "task-1")
        result = self.change()
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(len(result.json()["exception_ids"]), 2)
        items = self.queue().json()
        self.assertEqual({r["reason"] for r in items}, {"TAKEOVER_REQUIRED", "REASSIGNMENT_REQUIRED"})
        self.assertTrue(all(r["original_owner_id"] == self.target and r["assignment_version"] == 0 for r in items))
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute("SELECT posted, reserved, shift_id FROM prsystem.cash_drawer WHERE tenant_id = %s", (self.tenant,)).fetchone(), (100000, 0, "sa"))
        with self.assertRaisesRegex(DomainError, "ACCOUNT_NOT_ACTIVE_VERIFIED"):
            self.register("CLEANING_TASK", "late-task")

    def test_role_removal_only_blocks_affected_work(self):
        self.register()
        self.register("CLEANING_TASK", "task-1")
        self.assertEqual(self.change("roles", roles=["CLEANER"]).status_code, 200)
        items = self.queue().json()
        self.assertEqual([r["kind"] for r in items], ["SHIFT"])
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute("SELECT state FROM prsystem.staff_open_work WHERE tenant_id = %s AND kind = 'CLEANING_TASK'", (self.tenant,)).fetchone()[0], "OPEN")

    def test_register_loses_race_to_suspension_and_cannot_escape_queue(self):
        with psycopg.connect(self.owner_dsn) as owner, ThreadPoolExecutor(1) as pool:
            owner.execute("UPDATE prsystem.staff_account SET auth_epoch = auth_epoch + 1 WHERE id = %s", (self.target,))
            future = pool.submit(self.register, "CLEANING_TASK", "late-task")
            self.assertTrue(self.wait_for_app_lock(owner))
            owner.execute("UPDATE prsystem.staff_membership SET status = 'SUSPENDED' WHERE tenant_id = %s AND account_id = %s", (self.tenant, self.target))
            owner.commit()
            with self.assertRaisesRegex(DomainError, "ACCOUNT_NOT_ACTIVE_VERIFIED"):
                future.result(timeout=10)
        self.assertEqual(self.queue().json(), [])

    def test_suspension_waits_for_registration_then_captures_it(self):
        with transaction(self.app_dsn) as source, ThreadPoolExecutor(1) as pool:
            self.flow.register_open_work(source, self.tenant, self.target, "CLEANING_TASK", "task-1")
            future = pool.submit(self.change)
            self.assertTrue(self.wait_for_app_lock(source))
            source.commit()
            result = future.result(timeout=10)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(len(self.queue().json()), 1)

    def test_queue_scope_permissions_and_keyset_pagination(self):
        self.register()
        self.register("CLEANING_TASK", "task-1")
        self.assertEqual(self.change().status_code, 200)
        self.assertEqual(self.queue(self.admin).status_code, 403)
        self.assertEqual(self.queue(tenant=self.other).status_code, 403)
        first = self.queue(limit=1).json()
        second = self.queue(limit=1, after=first[0]["id"]).json()
        self.assertEqual(len(second), 1)
        self.assertNotEqual(first[0]["id"], second[0]["id"])
        self.assertEqual(self.queue(limit=101).status_code, 422)
        _, plus = self.add_staff(["MANAGER_PLUS"])
        self.assertEqual(self.queue(plus).status_code, 200)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.hotel_access SET package_mnt = 25000 WHERE tenant_id = %s", (self.tenant,))
        self.assertEqual(self.queue(plus).status_code, 403)

    def test_claim_race_has_one_winner_and_no_ownership_change(self):
        self.register()
        self.change()
        item = self.queue().json()[0]
        _, second_token = self.add_staff(["MANAGER"])
        barrier = Barrier(2)
        def run(token):
            barrier.wait()
            return self.claim(item["id"], token, key=uuid4().hex).status_code
        with ThreadPoolExecutor(2) as pool:
            self.assertEqual(sorted(pool.map(run, [self.manager_token, second_token])), [200, 409])
        self.assertEqual(self.queue().json()[0]["original_owner_id"], self.target)

    def test_claim_replay_permissions_and_missing_exception(self):
        self.register()
        self.change()
        item = self.queue().json()[0]
        self.assertEqual(self.claim(item["id"], self.admin).status_code, 403)
        first = self.claim(item["id"])
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(self.claim(item["id"]).json(), first.json())
        self.assertEqual(self.claim(item["id"], revision=1, key="repeat").json(), first.json())
        self.assertEqual(self.claim(uuid4().hex, key="missing").status_code, 404)

    def test_suspended_claimant_releases_claim_for_another_manager(self):
        self.register()
        self.change()
        item = self.queue().json()[0]
        self.assertEqual(self.claim(item["id"]).status_code, 200)
        self.assertEqual(self.change(target=self.manager, idempotency_key="suspend-manager").status_code, 200)
        self.assertEqual(self.queue().status_code, 401)
        _, second_token = self.add_staff(["MANAGER"])
        item = self.queue(second_token).json()[0]
        self.assertIsNone(item["claimant_id"])
        self.assertEqual(item["revision"], 2)
        self.assertEqual(self.claim(item["id"], second_token, revision=2, key="new-manager").status_code, 200)

    def test_reactivation_does_not_unblock_work_or_restore_old_session(self):
        self.register()
        self.change()
        self.assertEqual(self.change("reactivate", revision=1).status_code, 200)
        self.assertEqual(self.me(self.target_token).status_code, 401)
        self.assertEqual(len(self.queue().json()), 1)
        with self.assertRaisesRegex(DomainError, "WORK_SOURCE_CONFLICT"):
            self.register()

    def test_pending_invite_revoked_and_unverified_reactivation_denied(self):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.staff_account SET verified_at = NULL WHERE id = %s", (self.target,))
            conn.execute("UPDATE prsystem.staff_membership SET status = 'PENDING' WHERE tenant_id = %s AND account_id = %s", (self.tenant, self.target))
            conn.execute("""INSERT INTO prsystem.staff_link (id, purpose, account_id, tenant_id, inviter_id, membership_revision, issued_epoch, token_hash, expires_at)
                VALUES (%s, 'INVITE', %s, %s, %s, 1, 1, %s, now() + interval '1 day')""",
                (uuid4().hex, self.target, self.tenant, self.account, digest(uuid4().hex)))
        self.assertEqual(self.change(revision=1).status_code, 200)
        self.assertEqual(self.change("reactivate", revision=2).json()["code"], "ACCOUNT_NOT_ACTIVE_VERIFIED")
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute("SELECT state FROM prsystem.staff_link WHERE account_id = %s", (self.target,)).fetchone()[0], "REVOKED")

    def test_commit_failure_rolls_back_membership_session_queue_event_and_receipt(self):
        self.register()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_change_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test change failure'; END; $$")
            conn.execute("CREATE CONSTRAINT TRIGGER fail_change_commit AFTER INSERT ON prsystem.staff_change_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.fail_change_commit()")
        try:
            self.assertEqual(self.change().status_code, 503)
            self.assertEqual(self.me(self.target_token).status_code, 200)
            self.assertEqual(self.queue().json(), [])
            with psycopg.connect(self.owner_dsn) as conn:
                self.assertEqual(conn.execute("SELECT status, revision FROM prsystem.staff_membership WHERE tenant_id = %s AND account_id = %s", (self.tenant, self.target)).fetchone(), ("ACTIVE", 0))
                self.assertEqual(conn.execute("SELECT state FROM prsystem.staff_open_work WHERE tenant_id = %s", (self.tenant,)).fetchone()[0], "OPEN")
                for table in ["staff_change_event", "staff_command_receipt"]:
                    self.assertEqual(conn.execute(sql.SQL("SELECT count(*) FROM prsystem.{} WHERE tenant_id = %s").format(sql.Identifier(table)), (self.tenant,)).fetchone()[0], 0)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute("DROP TRIGGER fail_change_commit ON prsystem.staff_change_event")
                conn.execute("DROP FUNCTION prsystem.fail_change_commit()")

    def test_restricted_role_cannot_rewrite_primary_audit_or_work_ownership(self):
        with psycopg.connect(self.app_dsn, autocommit=True) as conn:
            for query in ["UPDATE prsystem.staff_membership SET is_primary = false", "DELETE FROM prsystem.staff_change_event",
                          "UPDATE prsystem.staff_command_receipt SET result = '{}'", "UPDATE prsystem.staff_open_work SET owner_id = 'other'"]:
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    conn.execute(query)
