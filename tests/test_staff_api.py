"""Staff API security behavior against a real PostgreSQL server and restricted role."""

import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from time import monotonic, sleep
from uuid import uuid4

from postgres_support import ADMIN_DSN, PostgresCase

if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from argon2 import PasswordHasher
    from fastapi.testclient import TestClient
    from prsystem.api import create_app
    from prsystem.auth import AuthSettings, digest


from staff_support import StaffApiCase


@unittest.skipUnless(ADMIN_DSN, "PRSYSTEM_TEST_ADMIN_DSN is not set")
class StaffApiTests(StaffApiCase):
    def test_login_opaque_hashed_session_and_private_response(self):
        response = self.login()
        self.assertEqual(response.status_code, 200, response.text)
        token = response.json()["access_token"]
        self.assertGreaterEqual(len(token), 40)
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertNotIn("set-cookie", response.headers)
        principal = self.me(token).json()
        self.assertEqual(principal["account_id"], self.account)
        self.assertEqual(principal["roles"], ["HOTEL_ADMIN"])
        with psycopg.connect(self.owner_dsn) as conn:
            stored = conn.execute("SELECT token_hash FROM prsystem.staff_session WHERE account_id = %s", (self.account,)).fetchone()[0]
            audit = conn.execute("SELECT kind FROM prsystem.auth_event WHERE actor_id = %s", (self.account,)).fetchall()
        self.assertEqual(stored, digest(token))
        self.assertNotEqual(stored, token)
        self.assertEqual(audit, [("LOGIN",)])
        self.assertNotIn("password", str(principal))

    def test_invalid_unknown_inactive_and_wrong_scope_have_same_error(self):
        responses = [self.login(password="wrong"), self.login(tenant="unknown"),
                     self.client.post("/auth/login", json={"email": "unknown@example.test", "password": self.password,
                                                           "tenant_id": self.tenant})]
        self.update_membership(status="PENDING")
        responses.append(self.login())
        for response in responses:
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.json(), {"code": "INVALID_CREDENTIALS"})

    def test_unverified_or_suspended_account_cannot_login(self):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.staff_account SET verified_at = NULL WHERE id = %s", (self.account,))
        self.assertEqual(self.login().status_code, 401)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.staff_account SET verified_at = now(), status = 'SUSPENDED' WHERE id = %s", (self.account,))
        self.assertEqual(self.login().status_code, 401)

    def test_missing_malformed_unknown_tokens_are_unauthenticated(self):
        for headers in [{}, {"Authorization": "Basic abc"}, self.headers("short"), self.headers("x" * 43)]:
            with self.subTest(headers=headers):
                self.assertEqual(self.client.get("/auth/me", headers=headers).status_code, 401)
                self.assertEqual(self.client.get(f"/hotels/{self.tenant}/cash/drawers", headers=headers).status_code, 401)

    def test_cash_read_scoped_to_session_even_with_two_memberships(self):
        a, b = self.token(), self.token(self.other)
        self.assertEqual(self.cash(a).json()["drawers"][0]["available"], 100000)
        self.assertEqual(self.cash(b, self.other).json()["drawers"][0]["available"], 900000)
        self.assertEqual(self.cash(a, self.other).status_code, 403)
        self.assertEqual(self.cash(b).status_code, 403)

    def test_manager_reception_cleaner_cannot_inherit_full_cash_report(self):
        for roles in [["MANAGER"], ["MANAGER_PLUS"], ["RECEPTION"], ["CLEANER"], ["MANAGER", "RECEPTION"]]:
            self.update_membership(roles=roles)
            self.assertEqual(self.cash(self.token()).status_code, 403)
        with psycopg.connect(self.owner_dsn) as conn:
            count = conn.execute("SELECT count(*) FROM prsystem.auth_event WHERE actor_id = %s AND kind = 'CASH_READ_DENIED'",
                                 (self.account,)).fetchone()[0]
        self.assertEqual(count, 5)

    def test_client_authorization_fields_and_validation_secrets_are_rejected(self):
        for extra in [{"authorized": True}, {"roles": ["HOTEL_ADMIN"]}, {"account_id": self.account}]:
            response = self.login(**extra)
            self.assertEqual(response.status_code, 422)
            self.assertEqual(response.json(), {"code": "INVALID_REQUEST"})
            self.assertNotIn(self.password, response.text)
        response = self.client.post("/auth/password/change", json={"current_password": self.password,
                                                                 "new_password": "secret-short"})
        self.assertNotIn(self.password, response.text)
        self.assertNotIn("secret-short", response.text)
        self.assertEqual(self.client.post(f"/hotels/{self.tenant}/cash/spend", json={"authorized": True}).status_code, 404)

    def test_membership_suspension_only_revokes_its_hotel_and_cannot_revive(self):
        a, b = self.token(), self.token(self.other)
        self.update_membership(status="SUSPENDED")
        self.assertEqual(self.me(a).status_code, 401)
        self.assertEqual(self.me(b).status_code, 200)
        self.update_membership(status="ACTIVE")
        self.assertEqual(self.me(a).status_code, 401)
        self.assertEqual(self.me(self.token()).status_code, 200)

    def test_role_change_requires_new_login(self):
        token = self.token()
        self.update_membership(roles=["RECEPTION"])
        self.assertEqual(self.me(token).status_code, 401)
        fresh = self.token()
        self.assertEqual(self.me(fresh).json()["roles"], ["RECEPTION"])
        self.assertEqual(self.cash(fresh).status_code, 403)

    def test_password_change_revokes_all_devices_and_hotels(self):
        tokens = [self.token(), self.token(), self.token(self.other)]
        new = "A new staff password 2026!"
        response = self.client.post("/auth/password/change", headers=self.headers(tokens[0]),
                                   json={"current_password": self.password, "new_password": new})
        self.assertEqual(response.status_code, 204, response.text)
        for token in tokens:
            self.assertEqual(self.me(token).status_code, 401)
        self.assertEqual(self.login().status_code, 401)
        self.assertEqual(self.login(password=new).status_code, 200)
        with psycopg.connect(self.owner_dsn) as conn:
            roles = conn.execute("SELECT roles, status FROM prsystem.staff_membership WHERE account_id = %s", (self.account,)).fetchall()
        self.assertEqual(roles, [(["HOTEL_ADMIN"], "ACTIVE"), (["HOTEL_ADMIN"], "ACTIVE")])

    def test_incorrect_current_password_does_not_revoke_or_change_password(self):
        token = self.token()
        response = self.client.post("/auth/password/change", headers=self.headers(token),
            json={"current_password": "wrong", "new_password": "A new staff password 2026!"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.me(token).status_code, 200)
        self.assertEqual(self.login().status_code, 200)

    def test_logout_is_idempotent_and_leaves_other_device(self):
        a, b = self.token(), self.token()
        for _ in range(2):
            self.assertEqual(self.client.post("/auth/logout", headers=self.headers(a)).status_code, 204)
        self.assertEqual(self.me(a).status_code, 401)
        self.assertEqual(self.me(b).status_code, 200)
        with psycopg.connect(self.owner_dsn) as conn:
            count = conn.execute("SELECT count(*) FROM prsystem.auth_event WHERE actor_id = %s AND kind = 'LOGOUT'",
                                 (self.account,)).fetchone()[0]
        self.assertEqual(count, 1)

    def test_logout_all_revokes_sessions_in_both_hotels(self):
        a, b = self.token(), self.token(self.other)
        self.assertEqual(self.client.post("/auth/logout-all", headers=self.headers(a)).status_code, 204)
        self.assertEqual(self.me(a).status_code, 401)
        self.assertEqual(self.me(b).status_code, 401)

    def test_absolute_and_idle_expiry_do_not_refresh_dead_sessions(self):
        for absolute in (True, False):
            token = self.token()
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute("""UPDATE prsystem.staff_session SET created_at = now() - interval '9 hours',
                    last_seen_at = now() - interval '31 minutes',
                    expires_at = CASE WHEN %s THEN now() - interval '1 second' ELSE expires_at END
                    WHERE token_hash = %s""", (absolute, digest(token)))
            self.assertEqual(self.me(token).status_code, 401)
            self.assertEqual(self.client.post("/auth/logout", headers=self.headers(token)).status_code, 204)

    def test_subscription_expiry_or_security_suspension_denies_cash_but_not_identity(self):
        token = self.token()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.hotel_access SET expires_at = now() - interval '49 hours' WHERE tenant_id = %s", (self.tenant,))
        self.assertEqual(self.cash(token).json(), {"code": "SUBSCRIPTION_EXPIRED"})
        self.assertEqual(self.me(token).status_code, 200)
        self.assertEqual(self.login().status_code, 200)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.hotel_access SET expires_at = now() + interval '1 day', security_suspended = true WHERE tenant_id = %s", (self.tenant,))
        self.assertEqual(self.cash(token).json(), {"code": "SECURITY_SUSPENDED"})
        self.assertEqual(self.me(token).status_code, 200)

    def test_global_suspension_and_reactivation_never_restore_old_sessions(self):
        a, b = self.token(), self.token(self.other)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.staff_account SET status = 'SUSPENDED' WHERE id = %s", (self.account,))
        self.assertEqual(self.me(a).status_code, 401)
        self.assertEqual(self.me(b).status_code, 401)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("UPDATE prsystem.staff_account SET status = 'ACTIVE' WHERE id = %s", (self.account,))
        self.assertEqual(self.me(a).status_code, 401)
        self.assertEqual(self.me(self.token()).status_code, 200)

    def test_login_limit_persists_across_application_instances(self):
        settings = replace(self.settings, login_email_limit=2)
        with TestClient(create_app(self.app_dsn, settings), client=(self.peer, 12345)) as first:
            self.assertEqual(self.login(password="wrong", client=first).status_code, 401)
            self.assertEqual(self.login(password="wrong", client=first).status_code, 401)
        with TestClient(create_app(self.app_dsn, settings), client=(uuid4().hex, 12345)) as second:
            response = self.login(client=second)
            self.assertEqual(response.status_code, 429)
            self.assertIn("retry-after", response.headers)

    def test_ip_limit_cannot_be_bypassed_by_forwarded_header_or_rotating_email(self):
        settings = replace(self.settings, login_ip_limit=2)
        with TestClient(create_app(self.app_dsn, settings), client=(self.peer, 12345)) as client:
            for index, expected in enumerate([401, 401, 429]):
                response = client.post("/auth/login", headers={"X-Forwarded-For": str(index)},
                    json={"email": f"{uuid4().hex}@example.test", "password": "wrong", "tenant_id": self.tenant})
                self.assertEqual(response.status_code, expected)

    def test_committed_suspension_wins_against_waiting_login(self):
        with psycopg.connect(self.owner_dsn) as owner, ThreadPoolExecutor(max_workers=1) as pool:
            owner.execute("SELECT * FROM prsystem.staff_membership WHERE tenant_id = %s FOR UPDATE", (self.tenant,))
            future = pool.submit(self.login)
            waiting = self.wait_for_app_lock(owner)
            owner.execute("UPDATE prsystem.staff_membership SET status = 'SUSPENDED' WHERE tenant_id = %s", (self.tenant,))
            owner.commit()
            self.assertTrue(waiting, "Login must contend on the authoritative membership lock")
            self.assertEqual(future.result(timeout=10).status_code, 401)
        with psycopg.connect(self.owner_dsn) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM prsystem.staff_session WHERE account_id = %s", (self.account,)).fetchone()[0], 0)

    def test_runtime_role_cannot_provision_accounts_or_rewrite_audit_or_cash(self):
        statements = ["DELETE FROM prsystem.auth_event", "UPDATE prsystem.auth_event SET kind = 'LOGIN'",
                      "INSERT INTO prsystem.staff_account (id, email, password_hash) VALUES ('x', 'x@example.test', 'x')",
                      "UPDATE prsystem.cash_drawer SET posted = 0"]
        with psycopg.connect(self.app_dsn, autocommit=True) as conn:
            for statement in statements:
                with self.subTest(statement=statement), self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    conn.execute(statement)

    def test_logout_does_not_lock_session_while_waiting_for_account(self):
        token = self.token()
        with psycopg.connect(self.owner_dsn) as owner, ThreadPoolExecutor(max_workers=1) as pool:
            owner.execute("SELECT id FROM prsystem.staff_account WHERE id = %s FOR UPDATE", (self.account,))
            future = pool.submit(self.client.post, "/auth/logout", headers=self.headers(token))
            waiting = self.wait_for_app_lock(owner)
            # If logout held this row first, an authenticated request holding the
            # account could deadlock with logout's audit foreign-key check.
            row = owner.execute("SELECT revoked_at FROM prsystem.staff_session WHERE token_hash = %s FOR UPDATE NOWAIT",
                                (digest(token),)).fetchone()
            owner.commit()
            self.assertTrue(waiting)
            self.assertIsNone(row[0])
            self.assertEqual(future.result(timeout=10).status_code, 204)

    def test_privileged_database_role_fails_closed_without_leaking_details(self):
        with TestClient(create_app(self.owner_dsn, self.settings)) as client:
            response = self.login(client=client)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"code": "SERVICE_UNAVAILABLE"})
        self.assertNotIn(self.email, response.text)
        self.assertNotIn(self.password, response.text)
