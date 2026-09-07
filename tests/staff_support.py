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


class StaffApiCase(PostgresCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.password = "Staff test password 2026!"
        cls.password_hash = PasswordHasher().hash(cls.password)
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                "REVOKE INSERT ON prsystem.cash_transfer, prsystem.cash_event, prsystem.cash_receipt, prsystem.cash_outbox FROM {}",
                "REVOKE UPDATE (revision) ON prsystem.cash_book FROM {}",
                "REVOKE UPDATE (posted, reserved) ON prsystem.cash_drawer FROM {}",
                "REVOKE UPDATE (state) ON prsystem.cash_transfer FROM {}",
                "GRANT SELECT ON prsystem.staff_account, prsystem.hotel_access, prsystem.staff_membership, "
                "prsystem.staff_session, prsystem.auth_rate_bucket TO {}",
                "GRANT INSERT ON prsystem.staff_session, prsystem.auth_rate_bucket, prsystem.auth_event TO {}",
                "GRANT INSERT ON prsystem.staff_denied_event TO {}",
                "GRANT UPDATE (password_hash, auth_epoch) ON prsystem.staff_account TO {}",
                "GRANT UPDATE (last_seen_at, revoked_at) ON prsystem.staff_session TO {}",
                "GRANT UPDATE (attempts, window_started) ON prsystem.auth_rate_bucket TO {}",
                # Row-lock privilege only: no lifecycle mutation endpoint exists yet.
                "GRANT UPDATE (revision) ON prsystem.staff_membership TO {}",
                "GRANT UPDATE (security_suspended) ON prsystem.hotel_access TO {}",
            ):
                conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    def setUp(self):
        self.tenant, self.other, self.account = (uuid4().hex for _ in range(3))
        self.email = self.account + "@example.test"
        self.peer = uuid4().hex
        self.settings = AuthSettings(login_email_limit=50, login_ip_limit=200)
        self.client = TestClient(create_app(self.app_dsn, self.settings, token_key=getattr(self, "token_key", None)), client=(self.peer, 12345))
        self.addCleanup(self.client.close)
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("INSERT INTO prsystem.staff_account (id, email, password_hash, verified_at) VALUES (%s, %s, %s, now())",
                         (self.account, self.email, self.password_hash))
            for tenant, amount in [(self.tenant, 100000), (self.other, 900000)]:
                conn.execute("INSERT INTO prsystem.hotel_access VALUES (%s, 30000, now() + interval '30 days', false)", (tenant,))
                conn.execute("""INSERT INTO prsystem.staff_membership
                    (tenant_id, account_id, status, roles, is_primary) VALUES (%s, %s, 'ACTIVE', ARRAY['HOTEL_ADMIN'], true)""",
                    (tenant, self.account))
                conn.execute("INSERT INTO prsystem.cash_book (tenant_id) VALUES (%s)", (tenant,))
                conn.execute("INSERT INTO prsystem.cash_drawer VALUES (%s, 'a', 'sa', %s, 0)", (tenant, amount))

    def login(self, tenant=None, password=None, client=None, **extra):
        return (client or self.client).post("/auth/login", json={"email": self.email,
            "password": password or self.password, "tenant_id": tenant or self.tenant, **extra})

    def token(self, tenant=None):
        response = self.login(tenant)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["access_token"]

    @staticmethod
    def headers(token):
        return {"Authorization": "Bearer " + token}

    def me(self, token):
        return self.client.get("/auth/me", headers=self.headers(token))

    def cash(self, token, tenant=None):
        return self.client.get(f"/hotels/{tenant or self.tenant}/cash/drawers", headers=self.headers(token))

    def update_membership(self, status=None, roles=None):
        with psycopg.connect(self.owner_dsn) as conn:
            if status:
                conn.execute("UPDATE prsystem.staff_membership SET status = %s WHERE tenant_id = %s AND account_id = %s",
                             (status, self.tenant, self.account))
            if roles:
                conn.execute("""UPDATE prsystem.staff_membership SET roles = %s, is_primary = %s
                    WHERE tenant_id = %s AND account_id = %s""", (roles, "HOTEL_ADMIN" in roles, self.tenant, self.account))

    def wait_for_app_lock(self, owner):
        # Use fresh observer transactions: pg_stat_activity snapshots inside the
        # long-lived owner transaction can hide a newly connected waiter.
        with psycopg.connect(self.owner_dsn, autocommit=True) as observer:
            deadline = monotonic() + 4
            while monotonic() < deadline:
                waiting = observer.execute("""SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                    WHERE datname = current_database() AND usename = %s
                      AND %s = ANY(pg_blocking_pids(pid)))""", (self.role, owner.info.backend_pid)).fetchone()[0]
                if waiting:
                    return True
                sleep(0.02)
        return False
