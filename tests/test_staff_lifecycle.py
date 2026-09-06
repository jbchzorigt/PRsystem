"""Invitation/reset API and internal email boundary against real PostgreSQL."""

import secrets
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

from postgres_support import ADMIN_DSN
from staff_support import StaffApiCase

if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from prsystem.auth import StaffAuth
    from prsystem.common import DomainError
    from prsystem.staff_lifecycle import StaffLifecycle


@unittest.skipUnless(ADMIN_DSN, "PRSYSTEM_TEST_ADMIN_DSN is not set")
class StaffLifecycleTests(StaffApiCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.token_key = secrets.token_bytes(32)
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                "GRANT SELECT ON prsystem.staff_link, prsystem.staff_mail_intent, prsystem.password_reset_request, prsystem.staff_command_receipt TO {}",
                "GRANT INSERT ON prsystem.staff_link, prsystem.staff_mail_intent, prsystem.password_reset_request, prsystem.staff_command_receipt, prsystem.staff_lifecycle_event TO {}",
                "GRANT INSERT (id, email, password_hash, display_name) ON prsystem.staff_account TO {}",
                "GRANT INSERT (tenant_id, account_id, status, roles) ON prsystem.staff_membership TO {}",
                "GRANT UPDATE (verified_at) ON prsystem.staff_account TO {}",
                "GRANT UPDATE (status) ON prsystem.staff_membership TO {}",
                "GRANT UPDATE (state) ON prsystem.staff_link TO {}",
                "GRANT UPDATE (delivered_at) ON prsystem.staff_mail_intent TO {}",
                "GRANT UPDATE (processed_at) ON prsystem.password_reset_request TO {}",
            ):
                conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp()
        self.email = self.account + "@example.com"
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.staff_account SET email = %s WHERE id = %s", (self.email, self.account))
        self.admin = self.token()
        self.auth = StaffAuth(self.app_dsn, self.settings)
        self.flow = StaffLifecycle(self.auth, self.token_key)
        self.target_email = uuid4().hex + "@example.com"

    def invite(self, **overrides):
        payload = {"email": self.target_email, "name": "Test Staff", "roles": ["RECEPTION"], "idempotency_key": "invite"}
        payload.update(overrides)
        return self.client.post(f"/hotels/{self.tenant}/staff/invitations", json=payload, headers=self.headers(self.admin))

    def invitation(self, **overrides):
        response = self.invite(**overrides)
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def change(self, result, action, **overrides):
        body = {"expected_revision": result["revision"], "idempotency_key": action}
        body.update(overrides)
        return self.client.post(f"/hotels/{self.tenant}/staff/{result['account_id']}/invitations/{action}",
                                json=body, headers=self.headers(self.admin))

    def accept(self, token, password=None):
        return self.client.post("/auth/invitations/accept", json={"token": token, "password": password or self.password})

    def request_reset(self, email=None):
        response = self.client.post("/auth/password/reset/request", json={"email": email or self.email})
        self.assertEqual(response.status_code, 202, response.text)
        with psycopg.connect(self.owner_dsn) as conn:
            request_id = conn.execute("SELECT id FROM prsystem.password_reset_request WHERE email = %s ORDER BY created_at DESC, id DESC LIMIT 1",
                                      (email or self.email,)).fetchone()[0]
        return request_id

    def reset_link(self):
        self.flow.process_reset_request(self.request_reset())
        with psycopg.connect(self.owner_dsn) as conn:
            link_id = conn.execute("SELECT id FROM prsystem.staff_link WHERE account_id = %s AND purpose = 'RESET' AND state = 'ACTIVE'",
                                   (self.account,)).fetchone()[0]
        return self.flow.prepare_delivery(link_id)

    def reset(self, token, password="New reset password 2026!"):
        return self.client.post("/auth/password/reset/complete", json={"token": token, "password": password})

    def test_invite_pending_then_recipient_activates_without_secret_leak(self):
        result = self.invitation(email=self.target_email.upper())
        envelope = self.flow.prepare_delivery(result["invitation_id"])
        self.assertEqual(envelope.recipient, self.target_email)
        self.assertNotIn(envelope.token, str(result))
        self.assertNotIn(envelope.token, repr(envelope))
        with psycopg.connect(self.owner_dsn) as conn:
            for table in ("staff_link", "staff_mail_intent", "staff_command_receipt", "staff_lifecycle_event"):
                rows = conn.execute(sql.SQL("SELECT row_to_json(t) FROM prsystem.{} t").format(sql.Identifier(table))).fetchall()
                self.assertNotIn(envelope.token, str(rows))
        pending_login = self.client.post("/auth/login", json={"email": self.target_email, "password": self.password, "tenant_id": self.tenant})
        self.assertEqual(pending_login.status_code, 401)
        self.assertEqual(self.accept(envelope.token).status_code, 200)
        login = self.client.post("/auth/login", json={"email": self.target_email, "password": self.password, "tenant_id": self.tenant})
        self.assertEqual(login.status_code, 200)
        self.assertEqual(self.me(login.json()["access_token"]).json()["roles"], ["RECEPTION"])
        self.assertEqual(self.accept(envelope.token).status_code, 400)

    def test_existing_account_password_is_required_and_never_overwritten(self):
        target = uuid4().hex
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("INSERT INTO prsystem.staff_account (id, email, password_hash, verified_at) VALUES (%s, %s, %s, now())",
                         (target, self.target_email, self.password_hash))
            conn.execute("INSERT INTO prsystem.staff_membership (tenant_id, account_id, status, roles) VALUES (%s, %s, 'ACTIVE', ARRAY['RECEPTION'])",
                         (self.other, target))
        result = self.invitation()
        self.assertEqual(result["account_id"], target)
        envelope = self.flow.prepare_delivery(result["invitation_id"])
        self.assertEqual(self.accept(envelope.token, "Someone else's password").status_code, 401)
        self.assertEqual(self.accept(envelope.token).status_code, 200)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute("SELECT password_hash, auth_epoch FROM prsystem.staff_account WHERE id = %s", (target,)).fetchone(), (self.password_hash, 0))

    def test_idempotency_and_canonical_membership(self):
        first = self.invitation()
        self.assertEqual(self.invitation(), first)
        self.assertEqual(self.invite(name="Different name").status_code, 409)
        self.assertEqual(self.invite(idempotency_key="different-key").status_code, 409)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.staff_link WHERE account_id = %s", (first["account_id"],)).fetchone()[0], 1)

    def test_resend_revoke_revision_and_old_link_invalidation(self):
        original = self.invitation()
        old = self.flow.prepare_delivery(original["invitation_id"])
        response = self.change(original, "resend")
        self.assertEqual(response.status_code, 200, response.text)
        resent = response.json()
        fresh = self.flow.prepare_delivery(resent["invitation_id"])
        self.assertEqual(resent["revision"], original["revision"] + 1)
        self.assertEqual(self.change(original, "resend").json(), resent)
        self.assertIsNone(self.flow.prepare_delivery(old.link_id))
        self.assertEqual(self.accept(old.token).status_code, 400)
        self.assertEqual(self.change(original, "revoke").status_code, 409)
        revoked = self.change(resent, "revoke")
        self.assertEqual(revoked.status_code, 200)
        self.assertEqual(self.accept(fresh.token).status_code, 400)
        self.assertEqual(self.invite(idempotency_key="new-create").status_code, 409)

    def test_role_package_and_primary_admin_cannot_be_bypassed(self):
        for role in ("HOTEL_ADMIN", "POLICE_ADMIN", "OPERATION_ADMIN", "RESTAURANT_MANAGER"):
            self.assertEqual(self.invite(roles=[role], idempotency_key=role).status_code, 403)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.hotel_access SET package_mnt = 20000 WHERE tenant_id = %s", (self.tenant,))
        for role in ("CLEANER", "MANAGER_PLUS"):
            self.assertEqual(self.invite(roles=[role], idempotency_key=role).status_code, 403)
        self.update_membership(roles=["MANAGER"])
        self.admin = self.token()
        self.assertEqual(self.invite().status_code, 403)

    def test_cross_tenant_and_suspended_actor_cannot_invite(self):
        body = {"email": self.target_email, "name": "Staff", "roles": ["RECEPTION"], "idempotency_key": "cross"}
        response = self.client.post(f"/hotels/{self.other}/staff/invitations", json=body, headers=self.headers(self.admin))
        self.assertEqual(response.status_code, 403)
        self.update_membership(status="SUSPENDED")
        self.assertEqual(self.invite().status_code, 401)

    def test_accept_rechecks_package_and_suspended_membership(self):
        result = self.invitation(roles=["CLEANER"])
        envelope = self.flow.prepare_delivery(result["invitation_id"])
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.hotel_access SET package_mnt = 20000 WHERE tenant_id = %s", (self.tenant,))
        self.assertEqual(self.accept(envelope.token).status_code, 403)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.hotel_access SET package_mnt = 30000 WHERE tenant_id = %s", (self.tenant,))
            conn.execute("UPDATE prsystem.staff_membership SET status = 'SUSPENDED' WHERE tenant_id = %s AND account_id = %s", (self.tenant, result["account_id"]))
        self.assertEqual(self.accept(envelope.token).status_code, 400)

    def test_expired_link_cannot_activate(self):
        result = self.invitation()
        token = self.flow.prepare_delivery(result["invitation_id"]).token
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.staff_link SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE id = %s", (result["invitation_id"],))
        self.assertEqual(self.accept(token).status_code, 400)

    def test_expiry_during_password_hash_rolls_back_activation(self):
        result = self.invitation()
        token = self.flow.prepare_delivery(result["invitation_id"]).token
        real_hash = self.auth.passwords.hash

        def expire_then_hash(password):
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute("UPDATE prsystem.staff_link SET created_at = now() - interval '1 hour', expires_at = now() - interval '1 second' WHERE id = %s", (result["invitation_id"],))
            return real_hash(password)

        with patch.object(type(self.auth.passwords), "hash", side_effect=expire_then_hash):
            with self.assertRaisesRegex(DomainError, "INVALID_LINK"):
                self.flow.accept(token, self.password, self.peer)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute("SELECT verified_at, password_hash FROM prsystem.staff_account WHERE id = %s", (result["account_id"],)).fetchone(), (None, "!"))

    def test_concurrent_accept_and_resend_have_one_winner(self):
        result = self.invitation()
        token = self.flow.prepare_delivery(result["invitation_id"]).token
        barrier = Barrier(2)

        def run(index):
            barrier.wait(timeout=10)
            return self.accept(token) if index == 0 else self.change(result, "resend")

        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(run, range(2)))
        self.assertEqual(sum(r.status_code == 200 for r in responses), 1, [r.text for r in responses])
        self.assertIn(responses[0].status_code, (200, 400))
        self.assertIn(responses[1].status_code, (200, 409))

    def test_concurrent_duplicate_create_has_one_mail_intent(self):
        barrier = Barrier(2)

        def run(_):
            barrier.wait(timeout=10)
            return self.invite()

        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(run, range(2)))
        self.assertEqual([r.status_code for r in responses], [201, 201])
        self.assertEqual(responses[0].json(), responses[1].json())
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.staff_link WHERE account_id = %s", (responses[0].json()["account_id"],)).fetchone()[0], 1)

    def test_reset_unknown_email_has_same_response_and_no_email_intent(self):
        known = self.request_reset()
        unknown_email = uuid4().hex + "@example.com"
        unknown = self.request_reset(unknown_email)
        self.flow.process_reset_request(known)
        self.flow.process_reset_request(unknown)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.staff_account WHERE email = %s", (unknown_email,)).fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.staff_link WHERE account_id = %s AND purpose = 'RESET'", (self.account,)).fetchone()[0], 1)

    def test_reset_revokes_all_sessions_without_changing_roles_or_status(self):
        a, b = self.token(), self.token(self.other)
        envelope = self.reset_link()
        self.assertEqual(envelope.recipient, self.email)
        self.assertEqual(self.reset(envelope.token).status_code, 204)
        self.assertEqual(self.me(a).status_code, 401)
        self.assertEqual(self.me(b).status_code, 401)
        self.assertEqual(self.reset(envelope.token).status_code, 400)
        self.assertEqual(self.login(password="New reset password 2026!").status_code, 200)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute("SELECT status, roles FROM prsystem.staff_membership WHERE account_id = %s", (self.account,)).fetchall(),
                             [("ACTIVE", ["HOTEL_ADMIN"]), ("ACTIVE", ["HOTEL_ADMIN"])])

    def test_reset_does_not_reactivate_a_suspended_account(self):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.staff_account SET status = 'SUSPENDED' WHERE id = %s", (self.account,))
        envelope = self.reset_link()
        self.assertEqual(self.reset(envelope.token).status_code, 204)
        self.assertEqual(self.login(password="New reset password 2026!").status_code, 401)

    def test_new_reset_supersedes_old_and_out_of_order_worker_is_safe(self):
        old = self.reset_link()
        first, latest = self.request_reset(), self.request_reset()
        self.flow.process_reset_request(latest)
        self.flow.process_reset_request(first)
        self.flow.process_reset_request(latest)
        self.assertEqual(self.reset(old.token).status_code, 400)
        with psycopg.connect(self.owner_dsn) as conn:
            links = conn.execute("SELECT id FROM prsystem.staff_link WHERE account_id = %s AND purpose = 'RESET' AND state = 'ACTIVE'", (self.account,)).fetchall()
        self.assertEqual(len(links), 1)
        self.assertNotEqual(links[0][0], old.link_id)

    def test_password_change_invalidates_outstanding_reset(self):
        envelope = self.reset_link()
        response = self.client.post("/auth/password/change", headers=self.headers(self.admin),
            json={"current_password": self.password, "new_password": "Changed before reset 2026!"})
        self.assertEqual(response.status_code, 204)
        self.assertEqual(self.reset(envelope.token).status_code, 400)
        self.assertIsNone(self.flow.prepare_delivery(envelope.link_id))

    def test_reset_and_invite_tokens_cannot_be_interchanged(self):
        invitation = self.invitation()
        invite_token = self.flow.prepare_delivery(invitation["invitation_id"]).token
        reset_token = self.reset_link().token
        self.assertEqual(self.reset(invite_token).status_code, 400)
        self.assertEqual(self.accept(reset_token).status_code, 400)

    def test_concurrent_reset_is_single_use(self):
        token = self.reset_link().token
        barrier = Barrier(2)

        def run(_):
            barrier.wait(timeout=10)
            return self.reset(token)

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(run, range(2)))
        self.assertEqual(sorted(r.status_code for r in results), [204, 400])

    def test_mail_failure_retries_same_secret_and_ack_is_durable(self):
        result = self.invitation()
        original = self.flow.prepare_delivery(result["invitation_id"])

        def failing_transport(envelope):
            raise RuntimeError("test transport unavailable")

        with self.assertRaises(RuntimeError):
            self.flow.deliver(original.link_id, failing_transport)
        self.assertEqual(self.flow.prepare_delivery(original.link_id), original)
        delivered = []
        self.assertTrue(self.flow.deliver(original.link_id, delivered.append))
        self.assertEqual(delivered, [original])
        self.assertFalse(self.flow.deliver(original.link_id, delivered.append))

    def test_wrong_mail_key_and_client_override_fail_closed(self):
        result = self.invitation()
        wrong = StaffLifecycle(self.auth, secrets.token_bytes(32))
        with self.assertRaisesRegex(DomainError, "TOKEN_KEY_MISMATCH"):
            wrong.prepare_delivery(result["invitation_id"])
        self.assertEqual(self.invite(password="Admin must not choose this").status_code, 422)
        response = self.client.post("/auth/password/reset/request", json={"email": self.email, "recipient": "other@example.com"})
        self.assertEqual(response.status_code, 422)

    def test_deferred_mail_failure_rolls_back_account_membership_receipt_and_link(self):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_mail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test mail failure'; END; $$")
            conn.execute("CREATE CONSTRAINT TRIGGER fail_mail_commit AFTER INSERT ON prsystem.staff_mail_intent DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.fail_mail_commit()")
        try:
            self.assertEqual(self.invite().status_code, 503)
            with psycopg.connect(self.owner_dsn) as conn:
                self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.staff_account WHERE email = %s", (self.target_email,)).fetchone()[0], 0)
                self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.staff_command_receipt WHERE tenant_id = %s", (self.tenant,)).fetchone()[0], 0)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute("DROP TRIGGER fail_mail_commit ON prsystem.staff_mail_intent")
                conn.execute("DROP FUNCTION prsystem.fail_mail_commit()")

    def test_invitation_and_reset_audit_cannot_be_rewritten(self):
        self.invitation()
        with psycopg.connect(self.app_dsn, autocommit=True) as conn:
            for query in ("DELETE FROM prsystem.staff_lifecycle_event", "UPDATE prsystem.staff_command_receipt SET result = '{}'",
                          "UPDATE prsystem.staff_link SET token_hash = 'tampered'"):
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    conn.execute(query)
