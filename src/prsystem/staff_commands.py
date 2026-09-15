"""Shared authenticated staff commands; no email key is required."""

from psycopg.types.json import Jsonb

from prsystem.auth import digest
from prsystem.common import DomainError, identifier
from prsystem.subscription import AccessFacts, Action, subscription_gate


class StaffCommands:
    def __init__(self, auth):
        self.auth = auth

    @staticmethod
    def _lock_accounts(conn, ids):
        conn.execute("SELECT id FROM prsystem.staff_account WHERE id = ANY(%s) ORDER BY id FOR UPDATE", (list(ids),)).fetchall()

    def _admin(self, conn, bearer, tenant, target=None):
        actor = conn.execute("SELECT account_id FROM prsystem.staff_session WHERE token_hash = %s", (digest(bearer),)).fetchone()
        if actor is None:
            raise DomainError("UNAUTHENTICATED")
        self._lock_accounts(conn, {actor[0], target} - {None})
        principal, _ = self.auth._authenticate(conn, bearer, tenant)
        hotel = conn.execute("""SELECT package_mnt, expires_at, security_suspended FROM prsystem.hotel_access
            WHERE tenant_id = %s FOR SHARE""", (tenant,)).fetchone()
        facts = AccessFacts(tenant, True, True, True, "HOTEL_ADMIN" in principal["roles"], True, True, True, hotel[2])
        decision = subscription_gate(Action.CONFIGURE, facts, hotel[1], conn.execute("SELECT clock_timestamp()").fetchone()[0])
        if not decision.allowed:
            raise DomainError(decision.code)
        return principal["account_id"], hotel[0]

    @staticmethod
    def _roles(roles, package):
        allowed = {"MANAGER", "RECEPTION"}
        if package >= 25000:
            allowed.add("CLEANER")
        if package == 30000:
            allowed.add("MANAGER_PLUS")
        if not roles or len(set(roles)) != len(roles) or not set(roles) <= allowed:
            raise DomainError("ROLE_NOT_ALLOWED")

    @staticmethod
    def _receipt(conn, tenant, key, actor, command):
        identifier(key)
        # Serialize even a conflicting same key addressing a different account.
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (f"staff-command:{tenant}:{key}",))
        row = conn.execute("SELECT actor_id, command, result FROM prsystem.staff_command_receipt WHERE tenant_id = %s AND key = %s",
                           (tenant, key)).fetchone()
        if row:
            if row[0] != actor or row[1] != command:
                raise DomainError("IDEMPOTENCY_CONFLICT")
            return row[2]

    @staticmethod
    def _save_receipt(conn, tenant, key, actor, command, result):
        conn.execute("INSERT INTO prsystem.staff_command_receipt VALUES (%s, %s, %s, %s, %s)",
                     (tenant, key, actor, Jsonb(command), Jsonb(result)))

