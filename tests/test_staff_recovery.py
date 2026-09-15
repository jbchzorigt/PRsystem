"""Recovery and denial auditing with actual PostgreSQL transactions."""

import secrets
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

from postgres_support import ADMIN_DSN
from staff_support import StaffApiCase

if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from prsystem.auth import StaffAuth
    from prsystem.staff_lifecycle import StaffLifecycle
    from prsystem.membership import MembershipService
    from prsystem.postgres.connection import transaction


@unittest.skipUnless(ADMIN_DSN, "PRSYSTEM_TEST_ADMIN_DSN is not set")
class StaffRecoveryTests(StaffApiCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.token_key = secrets.token_bytes(32)
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                "GRANT SELECT ON prsystem.staff_link, prsystem.staff_mail_intent, prsystem.password_reset_request, prsystem.staff_command_receipt, prsystem.staff_open_work, prsystem.staff_work_exception TO {}",
                "GRANT INSERT ON prsystem.staff_link, prsystem.staff_mail_intent, prsystem.password_reset_request, prsystem.staff_command_receipt, prsystem.staff_lifecycle_event, prsystem.staff_change_event, prsystem.staff_open_work, prsystem.staff_work_exception TO {}",
                "GRANT INSERT (id, email, password_hash, display_name) ON prsystem.staff_account TO {}",
                "GRANT INSERT (tenant_id, account_id, status, roles) ON prsystem.staff_membership TO {}",
                "GRANT UPDATE (verified_at) ON prsystem.staff_account TO {}",
                "GRANT UPDATE (status, roles) ON prsystem.staff_membership TO {}",
                "GRANT UPDATE (state) ON prsystem.staff_link, prsystem.staff_open_work TO {}",
                "GRANT UPDATE (claimant_id, revision) ON prsystem.staff_work_exception TO {}",
                "GRANT UPDATE (processed_at) ON prsystem.password_reset_request TO {}",
            ):
                conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp()
        self.admin = self.token()
        self.auth = StaffAuth(self.app_dsn, self.settings)
        self.links = StaffLifecycle(self.auth, self.token_key)
        self.members = MembershipService(self.auth)
        self.target, self.target_token = self.add_staff(["RECEPTION"])

    def add_staff(self, roles):
        account = uuid4().hex
        email = account + "@example.com"
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("INSERT INTO prsystem.staff_account (id, email, password_hash, verified_at) VALUES (%s, %s, %s, now())", (account, email, self.password_hash))
            conn.execute("INSERT INTO prsystem.staff_membership (tenant_id, account_id, status, roles) VALUES (%s, %s, 'ACTIVE', %s)", (self.tenant, account, roles))
        login = self.client.post('/auth/login', json={"email": email, "password": self.password, "tenant_id": self.tenant})
        self.assertEqual(login.status_code, 200, login.text)
        return account, login.json()['access_token']

    def post(self, action, target=None, revision=0, key=None, token=None, tenant=None, **extra):
        return self.client.post(f"/hotels/{tenant or self.tenant}/staff/{target or self.target}/{action}",
            headers=self.headers(token or self.admin), json={"expected_revision": revision, "idempotency_key": key or action, **extra})

    def invite_suspended(self):
        result = self.links.invite(self.admin, self.tenant, uuid4().hex + '@example.com', 'Pending Staff', ['RECEPTION'], 'invite')
        self.old_link = self.links.prepare_delivery(result['invitation_id'])
        self.assertEqual(self.post('suspend', target=result['account_id'], key='suspend-invite', reason='Invitation paused').status_code, 200)
        return result['account_id']

    def test_admin_reset_is_canonical_secret_free_and_idempotent(self):
        first = self.post('password/reset')
        self.assertEqual(first.status_code, 202, first.text)
        self.assertEqual(first.json(), {'status': 'ACCEPTED'})
        self.assertEqual(self.post('password/reset').json(), first.json())
        with psycopg.connect(self.owner_dsn) as conn:
            rows = conn.execute('SELECT id, email FROM prsystem.password_reset_request WHERE email = %s', (self.target+'@example.com',)).fetchall()
            self.assertEqual(len(rows), 1)
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.staff_lifecycle_event WHERE tenant_id = %s AND kind = %s', (self.tenant, 'ADMIN_RESET_REQUESTED')).fetchone()[0], 1)
        self.links.process_reset_request(rows[0][0])
        with psycopg.connect(self.owner_dsn) as conn:
            link = conn.execute("SELECT id FROM prsystem.staff_link WHERE account_id = %s AND purpose = 'RESET'", (self.target,)).fetchone()[0]
        envelope = self.links.prepare_delivery(link)
        self.assertEqual(envelope.recipient, self.target+'@example.com')
        self.assertNotIn(envelope.token, first.text)
        self.links.complete_reset(envelope.token, 'New recipient password 2026!', self.peer)
        self.assertEqual(self.me(self.target_token).status_code, 401)

    def test_admin_reset_cannot_override_recipient_password_or_scope(self):
        for extra in [{'email': 'wrong@example.com'}, {'password': 'Wrong password'}, {'recipient': 'wrong@example.com'}]:
            self.assertEqual(self.post('password/reset', **extra).status_code, 422)
        self.assertEqual(self.post('password/reset', token=self.target_token).status_code, 403)
        self.assertEqual(self.post('password/reset', tenant=self.other).status_code, 403)
        self.assertEqual(self.post('password/reset', revision=1).status_code, 409)
        self.assertEqual(self.post('password/reset', target=uuid4().hex).status_code, 404)

    def test_admin_reset_does_not_reactivate_membership(self):
        self.assertEqual(self.post('suspend', reason='No access').status_code, 200)
        self.assertEqual(self.post('password/reset', revision=1).status_code, 202)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT status FROM prsystem.staff_membership WHERE tenant_id = %s AND account_id = %s', (self.tenant, self.target)).fetchone()[0], 'SUSPENDED')

    def test_admin_reset_concurrent_retry_queues_once(self):
        barrier = Barrier(2)
        def run(_):
            barrier.wait(timeout=10)
            return self.post('password/reset').status_code
        with ThreadPoolExecutor(2) as pool:
            self.assertEqual(list(pool.map(run, range(2))), [202, 202])
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.password_reset_request WHERE email = %s', (self.target+'@example.com',)).fetchone()[0], 1)

    def test_recover_unverified_invite_uses_same_member_and_requires_acceptance(self):
        target = self.invite_suspended()
        r = self.post('invitations/recover', target=target, revision=1, reason='Resume onboarding')
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()['revision'], 2)
        self.assertEqual(self.post('invitations/recover', target=target, revision=1, reason='Resume onboarding').json(), r.json())
        self.assertIsNone(self.links.prepare_delivery(self.old_link.link_id))
        old = self.client.post('/auth/invitations/accept', json={'token': self.old_link.token, 'password': self.password})
        self.assertEqual(old.status_code, 400)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT status FROM prsystem.staff_membership WHERE tenant_id = %s AND account_id = %s', (self.tenant, target)).fetchone()[0], 'PENDING')
            self.assertIsNone(conn.execute('SELECT verified_at FROM prsystem.staff_account WHERE id = %s', (target,)).fetchone()[0])
        fresh = self.links.prepare_delivery(r.json()['invitation_id'])
        self.assertEqual(self.links.accept(fresh.token, self.password, self.peer)['state'], 'ACTIVE')

    def test_recovery_denies_verified_global_suspend_package_and_blank_reason(self):
        self.post('suspend', reason='Pause')
        self.assertEqual(self.post('invitations/recover', revision=1, reason='Resume').json()['code'], 'VERIFIED_ACCOUNT_REQUIRES_REACTIVATION')
        target = self.invite_suspended()
        self.assertEqual(self.post('invitations/recover', target=target, revision=1, reason='   ').status_code, 422)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.staff_account SET status = 'SUSPENDED' WHERE id = %s", (target,))
        self.assertEqual(self.post('invitations/recover', target=target, revision=1, reason='Resume').status_code, 403)
        self.assertEqual(self.post('password/reset', target=target, revision=1).json()['code'], 'ACCOUNT_NOT_VERIFIED')

    def test_recover_and_terminate_race_one_revision_wins(self):
        target = self.invite_suspended()
        barrier = Barrier(2)
        def run(action):
            barrier.wait(timeout=10)
            return self.post(action, target=target, revision=1, reason='Concurrent change').status_code
        with ThreadPoolExecutor(2) as pool:
            self.assertEqual(sorted(pool.map(run, ['invitations/recover', 'terminate'])), [200, 409])

    def test_recovery_mail_commit_failure_rolls_back_state_link_and_receipt(self):
        target = self.invite_suspended()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_recovery_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END; $$")
            conn.execute("CREATE CONSTRAINT TRIGGER fail_recovery_commit AFTER INSERT ON prsystem.staff_mail_intent DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.fail_recovery_commit()")
        try:
            self.assertEqual(self.post('invitations/recover', target=target, revision=1, reason='Resume').status_code, 503)
            with psycopg.connect(self.owner_dsn) as conn:
                self.assertEqual(conn.execute('SELECT status, revision FROM prsystem.staff_membership WHERE tenant_id = %s AND account_id = %s', (self.tenant, target)).fetchone(), ('SUSPENDED', 1))
                self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.staff_command_receipt WHERE tenant_id = %s AND key = 'invitations/recover'", (self.tenant,)).fetchone()[0], 0)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('DROP TRIGGER fail_recovery_commit ON prsystem.staff_mail_intent')
                conn.execute('DROP FUNCTION prsystem.fail_recovery_commit()')

    def test_denied_audit_survives_rollback_and_contains_no_request_secrets(self):
        secret_reason = 'do-not-log-this-request-body'
        r = self.post('roles', roles=['HOTEL_ADMIN'], reason=secret_reason)
        self.assertEqual(r.status_code, 403)
        with psycopg.connect(self.owner_dsn) as conn:
            event = conn.execute('SELECT row_to_json(e) FROM prsystem.staff_denied_event e WHERE requested_tenant_id = %s', (self.tenant,)).fetchone()[0]
            self.assertEqual(event['actor_id'], self.account)
            self.assertEqual(event['target_id'], self.target)
            self.assertEqual(event['action'], '/hotels/{tenant_id}/staff/{account_id}/roles')
            self.assertNotIn(secret_reason, str(event))
            self.assertNotIn(self.admin, str(event))
            self.assertEqual(conn.execute('SELECT revision FROM prsystem.staff_membership WHERE tenant_id = %s AND account_id = %s', (self.tenant, self.target)).fetchone()[0], 0)

    def test_unknown_bearer_cannot_spoof_audit_actor_or_target(self):
        fake = secrets.token_urlsafe(32)
        self.assertEqual(self.post('suspend', token=fake, target=fake, reason='Denied').status_code, 401)
        with psycopg.connect(self.owner_dsn) as conn:
            event = conn.execute('SELECT row_to_json(e) FROM prsystem.staff_denied_event e WHERE requested_tenant_id = %s', (self.tenant,)).fetchone()[0]
            self.assertIsNone(event['actor_id'])
            self.assertIsNone(event['target_id'])
            self.assertNotIn(fake, str(event))

    def test_denied_audit_cannot_be_rewritten_and_failure_is_closed(self):
        with psycopg.connect(self.app_dsn, autocommit=True) as conn:
            for query in ['DELETE FROM prsystem.staff_denied_event', "UPDATE prsystem.staff_denied_event SET code = 'ALLOW'"]:
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    conn.execute(query)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute(sql.SQL('REVOKE INSERT ON prsystem.staff_denied_event FROM {}').format(sql.Identifier(self.role)))
        try:
            self.assertEqual(self.post('password/reset', token=self.target_token).status_code, 503)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute(sql.SQL('GRANT INSERT ON prsystem.staff_denied_event TO {}').format(sql.Identifier(self.role)))

    def claimed_work(self):
        manager, token = self.add_staff(['MANAGER_PLUS'])
        with transaction(self.app_dsn) as conn:
            self.members.register_open_work(conn, self.tenant, self.target, 'SHIFT', 'sa')
        result = self.members.change(self.admin, self.tenant, self.target, 'SUSPEND', 0, 'suspend', 'Unavailable')
        queue_id = result['exception_ids'][0]
        self.members.claim(token, self.tenant, queue_id, 0, 'claim')
        return manager, queue_id

    def recover_claim(self, queue_id, token, revision=1, key='recover'):
        return self.client.post(f'/hotels/{self.tenant}/staff-work/exceptions/{queue_id}/recover', headers=self.headers(token),
            json={'expected_revision': revision, 'idempotency_key': key, 'reason': 'Previous claimant unavailable'})

    def test_global_suspended_claimant_recovered_without_work_reassignment(self):
        manager, queue_id = self.claimed_work()
        replacement, token = self.add_staff(['MANAGER'])
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.staff_account SET status = 'SUSPENDED' WHERE id = %s", (manager,))
        r = self.recover_claim(queue_id, token)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.recover_claim(queue_id, token).json(), r.json())
        self.assertEqual(r.json()['claimant_id'], replacement)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT owner_id, assignment_version, state FROM prsystem.staff_open_work WHERE tenant_id = %s', (self.tenant,)).fetchone(), (self.target, 0, 'BLOCKED'))

    def test_eligible_claimant_cannot_be_stolen_and_hotel_lock_not_bypassed(self):
        _, queue_id = self.claimed_work()
        _, token = self.add_staff(['MANAGER'])
        self.assertEqual(self.recover_claim(queue_id, token).json()['code'], 'CLAIMANT_STILL_ELIGIBLE')
        self.assertEqual(self.recover_claim(queue_id, self.admin).status_code, 403)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.hotel_access SET expires_at = now() - interval '3 days' WHERE tenant_id = %s", (self.tenant,))
        self.assertEqual(self.recover_claim(queue_id, token).json()['code'], 'SUBSCRIPTION_EXPIRED')

    def test_package_ineligible_claimant_recovery_race_has_one_winner(self):
        _, queue_id = self.claimed_work()
        _, a = self.add_staff(['MANAGER'])
        _, b = self.add_staff(['MANAGER'])
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('UPDATE prsystem.hotel_access SET package_mnt = 25000 WHERE tenant_id = %s', (self.tenant,))
        barrier = Barrier(2)
        def run(token):
            barrier.wait(timeout=10)
            return self.recover_claim(queue_id, token, key=uuid4().hex).status_code
        with ThreadPoolExecutor(2) as pool:
            self.assertEqual(sorted(pool.map(run, [a, b])), [200, 409])
