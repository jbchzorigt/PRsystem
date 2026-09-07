"""Restaurant identity and cross-realm protections against real PostgreSQL."""

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
    from prsystem.restaurant_identity import RestaurantIdentity
    from prsystem.staff_lifecycle import StaffLifecycle
    from prsystem.mail_worker import MailWorker, SMTPSettings, SMTPTransport


@unittest.skipUnless(ADMIN_DSN, 'PRSYSTEM_TEST_ADMIN_DSN is not set')
class RestaurantIdentityTests(StaffApiCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.token_key = secrets.token_bytes(32)
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                'GRANT SELECT ON prsystem.restaurant, prsystem.hotel_restaurant, prsystem.staff_link, prsystem.staff_mail_intent, prsystem.staff_command_receipt, prsystem.password_reset_request TO {}',
                'GRANT INSERT ON prsystem.restaurant, prsystem.hotel_restaurant, prsystem.restaurant_membership, prsystem.restaurant_staff_event, prsystem.staff_link, prsystem.staff_mail_intent, prsystem.staff_command_receipt, prsystem.password_reset_request, prsystem.staff_lifecycle_event TO {}',
                'GRANT INSERT (id, email, password_hash, display_name) ON prsystem.staff_account TO {}',
                'GRANT UPDATE (verified_at) ON prsystem.staff_account TO {}',
                'GRANT UPDATE (revision) ON prsystem.restaurant, prsystem.hotel_restaurant TO {}',
                'GRANT UPDATE (status, revision) ON prsystem.restaurant_membership TO {}',
                'GRANT UPDATE (state) ON prsystem.staff_link TO {}',
                'GRANT UPDATE (processed_at) ON prsystem.password_reset_request TO {}',
                'GRANT UPDATE (delivered_at) ON prsystem.staff_mail_intent TO {}',
            ):
                conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def setUp(self):
        super().setUp()
        self.email = self.account + '@example.com'
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('UPDATE prsystem.staff_account SET email = %s WHERE id = %s', (self.email, self.account))
        self.update_membership(roles=['HOTEL_ADMIN', 'MANAGER_PLUS'])
        self.owner = self.token()
        self.target_email = uuid4().hex + '@example.com'
        self.auth = StaffAuth(self.app_dsn, self.settings)
        self.links = StaffLifecycle(self.auth, self.token_key)
        self.flow = RestaurantIdentity(self.auth, self.links)

    def register(self, **extra):
        data = {'name': 'Test Restaurant', 'category': 'Restaurant', 'description': 'Test venue',
                'address': 'Ulaanbaatar test address', 'latitude': 47.92, 'longitude': 106.92, 'phone': '+976 99112233',
                'weekly_hours': [{'day': i, 'closed': False, 'opens': '18:00', 'closes': '02:00'} for i in range(7)],
                'email': self.target_email, 'manager_name': 'Restaurant Staff', 'idempotency_key': 'register'}
        data.update(extra)
        return self.client.post(f'/hotels/{self.tenant}/restaurants', json=data, headers=self.headers(self.owner))

    def venue(self, **extra):
        result = self.register(**extra)
        self.assertEqual(result.status_code, 201, result.text)
        return result.json()

    def accept(self, result, password=None):
        envelope = self.links.prepare_delivery(result['invitation']['invitation_id'])
        self.assertIsNotNone(envelope)
        return self.client.post('/auth/restaurants/invitations/accept', json={'token': envelope.token, 'password': password or self.password})

    def restaurant_login(self, result, email=None, password=None):
        return self.client.post('/auth/restaurants/login', json={'restaurant_id': result['restaurant_id'], 'email': email or self.target_email, 'password': password or self.password})

    def restaurant_token(self, result, email=None):
        response = self.restaurant_login(result, email)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['access_token']

    def profile(self, result, token, tenant=None):
        return self.client.get(f"/hotels/{tenant or self.tenant}/restaurants/{result['restaurant_id']}/profile", headers=self.headers(token))

    def change(self, result, action, revision=0, token=None, tenant=None, **extra):
        body = {'expected_revision': revision, 'idempotency_key': action}
        if action not in {'invitations/resend', 'invitations/revoke'}:
            body['reason'] = 'Staff update'
        body.update(extra)
        return self.client.post(f"/hotels/{tenant or self.tenant}/restaurants/{result['restaurant_id']}/staff/{result['invitation']['account_id']}/{action}",
                                json=body, headers=self.headers(token or self.owner))

    def invite(self, result, email, token=None, **extra):
        data = {'email': email, 'name': 'Another Restaurant Staff', 'idempotency_key': 'invite'}
        data.update(extra)
        return self.client.post(f"/hotels/{self.tenant}/restaurants/{result['restaurant_id']}/staff/invitations", json=data, headers=self.headers(token or self.owner))

    def test_registration_pending_identity_and_inactive_link_are_atomic(self):
        result = self.venue()
        self.assertFalse(result['active'])
        self.assertEqual(self.restaurant_login(result).status_code, 401)
        self.assertEqual(self.accept(result).status_code, 200)
        token = self.restaurant_token(result)
        principal = self.me(token).json()
        self.assertEqual(principal['roles'], ['RESTAURANT_MANAGER'])
        self.assertEqual(principal['restaurant_id'], result['restaurant_id'])
        self.assertIsNone(principal['tenant_id'])
        profile = self.profile(result, token)
        self.assertEqual(profile.status_code, 200, profile.text)
        self.assertFalse(profile.json()['active'])
        self.assertEqual(profile.json()['weekly_hours'][0]['closes'], '02:00')
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.staff_membership WHERE account_id = %s', (principal['account_id'],)).fetchone()[0], 0)

    def test_registration_replay_conflict_and_no_secret_storage(self):
        result = self.venue()
        self.assertEqual(self.venue(), result)
        self.assertEqual(self.register(name='Changed venue').status_code, 409)
        envelope = self.links.prepare_delivery(result['invitation']['invitation_id'])
        self.assertNotIn(envelope.token, str(result))
        with psycopg.connect(self.owner_dsn) as conn:
            for table in ['staff_link', 'staff_mail_intent', 'staff_command_receipt', 'restaurant_staff_event']:
                data = conn.execute(sql.SQL('SELECT row_to_json(t) FROM prsystem.{} t').format(sql.Identifier(table))).fetchall()
                self.assertNotIn(envelope.token, str(data))

    def test_form_rejects_privilege_scope_and_invalid_schedule_overrides(self):
        for extra in [{'roles': ['HOTEL_ADMIN']}, {'created_by': self.account}, {'active': True}, {'latitude': 91.0},
                      {'phone': ''}, {'weekly_hours': [{'day': 0, 'closed': True}] * 7}, {'name': '   '}]:
            self.assertEqual(self.register(**extra).status_code, 422)

    def test_registration_requires_manager_plus_and_30000_package(self):
        for roles in [['HOTEL_ADMIN'], ['HOTEL_ADMIN', 'MANAGER'], ['HOTEL_ADMIN', 'RECEPTION']]:
            self.update_membership(roles=roles)
            self.owner = self.token()
            self.assertEqual(self.register().status_code, 403)
        self.update_membership(roles=['HOTEL_ADMIN', 'MANAGER_PLUS'])
        self.owner = self.token()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('UPDATE prsystem.hotel_access SET package_mnt = 25000 WHERE tenant_id = %s', (self.tenant,))
        self.assertEqual(self.register().json()['code'], 'PACKAGE_REQUIRED')

    def test_other_manager_plus_cannot_manage_someone_elses_restaurant(self):
        result = self.venue()
        other = uuid4().hex
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('INSERT INTO prsystem.staff_account (id, email, password_hash, verified_at) VALUES (%s, %s, %s, now())',
                         (other, other+'@example.com', self.password_hash))
            conn.execute("INSERT INTO prsystem.staff_membership (tenant_id, account_id, status, roles) VALUES (%s, %s, 'ACTIVE', ARRAY['MANAGER_PLUS'])", (self.tenant, other))
        response = self.client.post('/auth/login', json={'tenant_id': self.tenant, 'email': other+'@example.com', 'password': self.password})
        token = response.json()['access_token']
        self.assertEqual(self.invite(result, uuid4().hex+'@example.com', token).status_code, 403)
        self.assertEqual(self.change(result, 'suspend', token=token).status_code, 403)

    def test_existing_account_uses_existing_password_and_no_hotel_privilege_is_inherited(self):
        result = self.venue(email=self.email)
        self.assertEqual(self.accept(result, 'Not the current password').status_code, 401)
        self.assertEqual(self.accept(result).status_code, 200)
        token = self.restaurant_token(result, self.email)
        self.assertEqual(self.cash(token).status_code, 403)
        self.assertEqual(self.me(self.owner).json()['roles'], ['HOTEL_ADMIN', 'MANAGER_PLUS'])
        self.assertEqual(self.profile(result, self.owner).status_code, 403)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT password_hash, auth_epoch FROM prsystem.staff_account WHERE id = %s', (self.account,)).fetchone(), (self.password_hash, 0))

    def test_restaurant_session_cannot_cross_restaurant_or_hotel_scope(self):
        first = self.venue()
        self.accept(first)
        token = self.restaurant_token(first)
        second = self.venue(email=uuid4().hex+'@example.com', idempotency_key='second')
        self.assertEqual(self.profile(second, token).status_code, 403)
        self.assertEqual(self.profile(first, token, self.other).status_code, 403)
        self.assertEqual(self.cash(token).status_code, 403)
        self.assertEqual(self.invite(first, uuid4().hex+'@example.com', token).status_code, 403)

    def test_purpose_isolation_and_single_use_acceptance(self):
        result = self.venue()
        envelope = self.links.prepare_delivery(result['invitation']['invitation_id'])
        self.assertEqual(self.client.post('/auth/invitations/accept', json={'token': envelope.token, 'password': self.password}).status_code, 400)
        self.assertEqual(self.client.post('/auth/password/reset/complete', json={'token': envelope.token, 'password': self.password}).status_code, 400)
        self.assertEqual(self.accept(result).status_code, 200)
        self.assertEqual(self.client.post('/auth/restaurants/invitations/accept', json={'token': envelope.token, 'password': self.password}).status_code, 400)

    def test_resend_revoke_revision_and_fresh_link_delivery(self):
        result = self.venue()
        old = self.links.prepare_delivery(result['invitation']['invitation_id'])
        resent = self.change(result, 'invitations/resend')
        self.assertEqual(resent.status_code, 200, resent.text)
        self.assertEqual(self.change(result, 'invitations/resend').json(), resent.json())
        self.assertIsNone(self.links.prepare_delivery(old.link_id))
        self.assertEqual(self.change(result, 'invitations/revoke').status_code, 409)
        self.assertEqual(self.change(result, 'invitations/revoke', revision=1).status_code, 200)
        self.assertIsNone(self.links.prepare_delivery(resent.json()['invitation_id']))
        self.assertEqual(self.invite(result, self.target_email).status_code, 409)

    def test_suspend_and_reactivate_only_revoke_this_restaurant(self):
        first = self.venue(email=self.email)
        second = self.venue(email=self.email, idempotency_key='second')
        self.accept(first)
        self.accept(second)
        first_token = self.restaurant_token(first, self.email)
        second_token = self.restaurant_token(second, self.email)
        self.assertEqual(self.change(first, 'suspend', revision=1).status_code, 200)
        self.assertEqual(self.me(first_token).status_code, 401)
        self.assertEqual(self.me(second_token).status_code, 200)
        self.assertEqual(self.me(self.owner).status_code, 200)
        self.assertEqual(self.change(first, 'reactivate', revision=2).status_code, 200)
        self.assertEqual(self.me(first_token).status_code, 401)
        self.assertEqual(self.restaurant_login(first, self.email).status_code, 200)

    def test_unverified_recovery_returns_pending_and_new_invitation(self):
        result = self.venue()
        old = self.links.prepare_delivery(result['invitation']['invitation_id'])
        self.assertEqual(self.change(result, 'terminate').status_code, 200)
        self.assertEqual(self.change(result, 'reactivate', revision=1).status_code, 403)
        recovered = self.change(result, 'recover', revision=1)
        self.assertEqual(recovered.status_code, 200, recovered.text)
        self.assertEqual(self.restaurant_login(result).status_code, 401)
        self.assertIsNone(self.links.prepare_delivery(old.link_id))
        self.assertEqual(self.accept({'restaurant_id': result['restaurant_id'], 'invitation': recovered.json()}).status_code, 200)

    def test_accept_rechecks_inviter_current_role_and_package(self):
        result = self.venue()
        self.update_membership(roles=['HOTEL_ADMIN'])
        self.assertEqual(self.accept(result).status_code, 400)
        self.update_membership(roles=['HOTEL_ADMIN', 'MANAGER_PLUS'])
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute('UPDATE prsystem.hotel_access SET package_mnt = 25000 WHERE tenant_id = %s', (self.tenant,))
        self.assertEqual(self.accept(result).status_code, 403)

    def test_global_account_suspend_blocks_login_and_cannot_be_recovered_by_inviter(self):
        result = self.venue()
        self.accept(result)
        token = self.restaurant_token(result)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.staff_account SET status = 'SUSPENDED' WHERE id = %s", (result['invitation']['account_id'],))
        self.assertEqual(self.me(token).status_code, 401)
        self.assertEqual(self.restaurant_login(result).status_code, 401)
        self.assertEqual(self.change(result, 'suspend', revision=1).status_code, 200)
        self.assertEqual(self.change(result, 'reactivate', revision=2).status_code, 403)

    def test_hotel_suspension_preserves_separate_restaurant_identity(self):
        result = self.venue(email=self.email)
        self.accept(result)
        restaurant_token = self.restaurant_token(result, self.email)
        self.update_membership(status='SUSPENDED')
        self.assertEqual(self.me(self.owner).status_code, 401)
        self.assertEqual(self.me(restaurant_token).status_code, 200)

    def test_expired_subscription_blocks_resource_access_but_logout_remains_available(self):
        result = self.venue()
        self.accept(result)
        token = self.restaurant_token(result)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.hotel_access SET expires_at = now() - interval '3 days' WHERE tenant_id = %s", (self.tenant,))
        self.assertEqual(self.profile(result, token).json()['code'], 'SUBSCRIPTION_EXPIRED')
        self.assertEqual(self.me(token).status_code, 200)
        self.assertEqual(self.client.post('/auth/logout', headers=self.headers(token)).status_code, 204)
        self.assertEqual(self.me(token).status_code, 401)

    def test_global_logout_and_password_change_revoke_both_realms(self):
        result = self.venue(email=self.email)
        self.accept(result)
        token = self.restaurant_token(result, self.email)
        self.assertEqual(self.client.post('/auth/logout-all', headers=self.headers(token)).status_code, 204)
        self.assertEqual(self.me(token).status_code, 401)
        self.assertEqual(self.me(self.owner).status_code, 401)
        self.owner = self.token()
        token = self.restaurant_token(result, self.email)
        response = self.client.post('/auth/password/change', headers=self.headers(token),
            json={'current_password': self.password, 'new_password': 'New shared password 2026!'})
        self.assertEqual(response.status_code, 204, response.text)
        self.assertEqual(self.me(self.owner).status_code, 401)
        self.assertEqual(self.me(token).status_code, 401)

    def test_password_reset_revokes_restaurant_sessions_without_restoring_membership(self):
        result = self.venue()
        self.accept(result)
        token = self.restaurant_token(result)
        self.links.request_reset(self.target_email, self.peer)
        with psycopg.connect(self.owner_dsn) as conn:
            request = conn.execute('SELECT id FROM prsystem.password_reset_request WHERE email = %s', (self.target_email,)).fetchone()[0]
        self.links.process_reset_request(request)
        with psycopg.connect(self.owner_dsn) as conn:
            reset_id = conn.execute("SELECT id FROM prsystem.staff_link WHERE account_id = %s AND purpose = 'RESET' AND state = 'ACTIVE'", (result['invitation']['account_id'],)).fetchone()[0]
        reset = self.links.prepare_delivery(reset_id)
        self.links.complete_reset(reset.token, 'New reset restaurant password!', self.peer)
        self.assertEqual(self.me(token).status_code, 401)
        self.assertEqual(self.restaurant_login(result, password='New reset restaurant password!').status_code, 200)

    def test_multi_hotel_link_requires_creator_permission_in_destination_hotel(self):
        result = self.venue()
        self.accept(result)
        token = self.restaurant_token(result)
        destination = self.token(self.other)
        path = f"/hotels/{self.other}/restaurants/{result['restaurant_id']}/link"
        self.assertEqual(self.client.post(path, json={'idempotency_key': 'link'}, headers=self.headers(destination)).status_code, 403)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.staff_membership SET roles = ARRAY['HOTEL_ADMIN', 'MANAGER_PLUS'] WHERE tenant_id = %s AND account_id = %s", (self.other, self.account))
        destination = self.token(self.other)
        self.assertEqual(self.client.post(path, json={'idempotency_key': 'link'}, headers=self.headers(destination)).status_code, 201)
        self.assertEqual(self.profile(result, token, self.other).status_code, 200)
        self.assertEqual(self.profile(result, token).status_code, 200)

    def test_restaurant_denial_audit_resolves_real_scope_and_no_secret(self):
        result = self.venue()
        self.accept(result)
        token = self.restaurant_token(result)
        self.assertEqual(self.profile(result, self.owner).status_code, 403)
        self.assertEqual(self.cash(token).status_code, 403)
        with psycopg.connect(self.owner_dsn) as conn:
            rows = conn.execute('SELECT row_to_json(e) FROM prsystem.staff_denied_event e WHERE requested_tenant_id = %s', (self.tenant,)).fetchall()
            self.assertTrue(any(r[0]['actor_restaurant_id'] == result['restaurant_id'] for r in rows))
            self.assertNotIn(token, str(rows))

    def test_mail_boundary_maps_restaurant_purpose_and_never_uses_hotel_accept(self):
        result = self.venue()
        envelope = self.links.prepare_delivery(result['invitation']['invitation_id'])
        self.assertEqual(envelope.purpose, 'RESTAURANT_INVITE')
        message = SMTPTransport(SMTPSettings('smtp.example.com', 'sender@example.com', 'https://staff.example.com', 'user', 'pass')).message(envelope)
        self.assertIn('/staff/restaurant-accept#token=', message.get_content())
        delivered = []
        self.assertTrue(self.links.deliver(envelope.link_id, delivered.append))
        self.assertEqual(delivered, [envelope])
        self.assertFalse(self.links.deliver(envelope.link_id, delivered.append))

    def test_accept_resend_race_has_one_success(self):
        result = self.venue()
        token = self.links.prepare_delivery(result['invitation']['invitation_id']).token
        barrier = Barrier(2)
        def run(index):
            barrier.wait(timeout=10)
            return (self.client.post('/auth/restaurants/invitations/accept', json={'token': token, 'password': self.password})
                    if index == 0 else self.change(result, 'invitations/resend')).status_code
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(run, range(2)))
        self.assertEqual(results.count(200), 1, results)
        self.assertTrue(all(code in {200, 400, 409} for code in results))

    def test_concurrent_duplicate_registration_has_one_venue_and_invite(self):
        barrier = Barrier(2)
        def run(_):
            barrier.wait(timeout=10)
            return self.register()
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(run, range(2)))
        self.assertEqual([r.status_code for r in results], [201, 201])
        self.assertEqual(results[0].json(), results[1].json())
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.restaurant WHERE created_by = %s', (self.account,)).fetchone()[0], 1)

    def test_concurrent_membership_changes_use_one_revision(self):
        result = self.venue()
        self.accept(result)
        barrier = Barrier(2)
        def run(action):
            barrier.wait(timeout=10)
            return self.change(result, action, revision=1).status_code
        with ThreadPoolExecutor(2) as pool:
            self.assertEqual(sorted(pool.map(run, ['suspend', 'terminate'])), [200, 409])

    def test_expiry_during_hashing_rolls_back_acceptance(self):
        result = self.venue()
        envelope = self.links.prepare_delivery(result['invitation']['invitation_id'])
        real_hash = self.auth.passwords.hash
        def expire(password):
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute("UPDATE prsystem.staff_link SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' WHERE id = %s", (envelope.link_id,))
            return real_hash(password)
        with patch.object(type(self.auth.passwords), 'hash', side_effect=expire):
            with self.assertRaisesRegex(DomainError, 'INVALID_LINK'):
                self.flow.accept(envelope.token, self.password, self.peer)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertIsNone(conn.execute('SELECT verified_at FROM prsystem.staff_account WHERE id = %s', (result['invitation']['account_id'],)).fetchone()[0])

    def test_deferred_mail_failure_rolls_back_registration_account_and_receipt(self):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("CREATE FUNCTION prsystem.fail_restaurant_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test mail commit'; END; $$")
            conn.execute('CREATE CONSTRAINT TRIGGER fail_restaurant_commit AFTER INSERT ON prsystem.staff_mail_intent DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.fail_restaurant_commit()')
        try:
            self.assertEqual(self.register().status_code, 503)
            with psycopg.connect(self.owner_dsn) as conn:
                self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.restaurant WHERE created_by = %s', (self.account,)).fetchone()[0], 0)
                self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.staff_account WHERE email = %s', (self.target_email,)).fetchone()[0], 0)
                self.assertEqual(conn.execute('SELECT count(*) FROM prsystem.staff_command_receipt WHERE tenant_id = %s', (self.tenant,)).fetchone()[0], 0)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute('DROP TRIGGER fail_restaurant_commit ON prsystem.staff_mail_intent')
                conn.execute('DROP FUNCTION prsystem.fail_restaurant_commit()')

    def test_database_constraints_prevent_mixed_scope_sessions_and_token_binding(self):
        result = self.venue()
        self.accept(result)
        token = self.restaurant_token(result)
        from prsystem.auth import digest
        with psycopg.connect(self.owner_dsn, autocommit=True) as conn:
            with self.assertRaises(psycopg.errors.CheckViolation):
                conn.execute('UPDATE prsystem.staff_session SET tenant_id = %s WHERE token_hash = %s', (self.tenant, digest(token)))
            with self.assertRaises(psycopg.errors.CheckViolation):
                conn.execute('UPDATE prsystem.staff_link SET tenant_id = %s WHERE id = %s', (self.tenant, result['invitation']['invitation_id']))
        with psycopg.connect(self.app_dsn, autocommit=True) as conn:
            for query in ["UPDATE prsystem.restaurant SET created_by = 'someone'", 'DELETE FROM prsystem.restaurant_staff_event',
                          "UPDATE prsystem.restaurant_membership SET restaurant_id = 'other'", "UPDATE prsystem.staff_link SET sponsor_tenant_id = 'other'"]:
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    conn.execute(query)
