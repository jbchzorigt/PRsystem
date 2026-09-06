"""Staff identity service. All session/account/membership facts come from PostgreSQL."""

import hashlib
import secrets
from dataclasses import dataclass
from datetime import timedelta
from uuid import uuid4

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from prsystem.common import DomainError
from prsystem.postgres.connection import transaction
from prsystem.subscription import AccessFacts, Action, subscription_gate


@dataclass(frozen=True)
class AuthSettings:
    # Implementation defaults for staff only; configurable before deployment.
    absolute_seconds: int = 8 * 60 * 60
    idle_seconds: int = 30 * 60
    login_window_seconds: int = 5 * 60
    login_email_limit: int = 5
    login_ip_limit: int = 30

    def __post_init__(self):
        if any(type(value) is not int or value <= 0 for value in vars(self).values()):
            raise ValueError("Authentication settings must be positive integers")


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class StaffAuth:
    def __init__(self, dsn: str, settings: AuthSettings = AuthSettings()):
        self.dsn = dsn
        self.settings = settings
        self.passwords = PasswordHasher()
        self._dummy_hash = self.passwords.hash(secrets.token_urlsafe(32))

    @staticmethod
    def _verify(hasher, encoded, password):
        try:
            return hasher.verify(encoded, password)
        except (VerificationError, InvalidHashError):
            return False

    def _rate_limit(self, identity: str, peer: str, purpose="login"):
        buckets = sorted([(digest(f"{purpose}:identity:{identity}"), self.settings.login_email_limit),
                          (digest(f"{purpose}:peer:{peer}"), self.settings.login_ip_limit)])
        limited = False
        # Commit attempts even when credentials fail or the limit is exceeded.
        with transaction(self.dsn) as conn:
            for key, limit in buckets:
                count = conn.execute("""INSERT INTO prsystem.auth_rate_bucket VALUES (%s, clock_timestamp(), 1)
                    ON CONFLICT (key) DO UPDATE SET
                        attempts = CASE WHEN auth_rate_bucket.window_started + %s <= clock_timestamp()
                            THEN 1 ELSE auth_rate_bucket.attempts + 1 END,
                        window_started = CASE WHEN auth_rate_bucket.window_started + %s <= clock_timestamp()
                            THEN clock_timestamp() ELSE auth_rate_bucket.window_started END
                    RETURNING attempts""", (key, timedelta(seconds=self.settings.login_window_seconds),
                                             timedelta(seconds=self.settings.login_window_seconds))).fetchone()[0]
                limited |= count > limit
        if limited:
            raise DomainError("RATE_LIMITED")

    @staticmethod
    def _audit(conn, kind, account, tenant):
        conn.execute("INSERT INTO prsystem.auth_event (id, kind, actor_id, tenant_id) VALUES (%s, %s, %s, %s)",
                     (str(uuid4()), kind, account, tenant))

    def login(self, email: str, password: str, tenant: str, peer: str):
        email = email.strip().lower()
        self._rate_limit(email, peer)
        with transaction(self.dsn) as conn:
            # Shared order for identity operations: account -> session -> membership -> hotel.
            account = conn.execute("""SELECT id, password_hash, status, verified_at, auth_epoch
                FROM prsystem.staff_account WHERE email = %s FOR UPDATE""", (email,)).fetchone()
            valid = self._verify(self.passwords, account[1] if account else self._dummy_hash, password)
            if not valid or not account or account[2] != "ACTIVE" or account[3] is None:
                raise DomainError("INVALID_CREDENTIALS")
            membership = conn.execute("""SELECT revision FROM prsystem.staff_membership
                WHERE tenant_id = %s AND account_id = %s AND status = 'ACTIVE' FOR SHARE""",
                (tenant, account[0])).fetchone()
            if membership is None:
                raise DomainError("INVALID_CREDENTIALS")
            epoch = account[4]
            if self.passwords.check_needs_rehash(account[1]):
                epoch = conn.execute("""UPDATE prsystem.staff_account SET password_hash = %s
                    WHERE id = %s RETURNING auth_epoch""", (self.passwords.hash(password), account[0])).fetchone()[0]
            token = secrets.token_urlsafe(32)
            now = conn.execute("SELECT clock_timestamp()").fetchone()[0]
            expires = now + timedelta(seconds=self.settings.absolute_seconds)
            conn.execute("""INSERT INTO prsystem.staff_session
                (token_hash, tenant_id, account_id, auth_epoch, membership_revision, created_at, expires_at, last_seen_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                (digest(token), tenant, account[0], epoch, membership[0], now, expires, now))
            self._audit(conn, "LOGIN", account[0], tenant)
            return {"access_token": token, "token_type": "bearer", "expires_at": expires}

    def _authenticate(self, conn, token, tenant=None):
        if not isinstance(token, str) or not 20 <= len(token) <= 256:
            raise DomainError("UNAUTHENTICATED")
        key = digest(token)
        identity = conn.execute("SELECT account_id FROM prsystem.staff_session WHERE token_hash = %s", (key,)).fetchone()
        if identity is None:
            raise DomainError("UNAUTHENTICATED")
        account = conn.execute("""SELECT id, status, verified_at, auth_epoch, password_hash
            FROM prsystem.staff_account WHERE id = %s FOR UPDATE""", (identity[0],)).fetchone()
        session = conn.execute("""SELECT tenant_id, auth_epoch, membership_revision, expires_at, last_seen_at, revoked_at
            FROM prsystem.staff_session WHERE token_hash = %s FOR UPDATE""", (key,)).fetchone()
        membership = conn.execute("""SELECT status, revision, roles FROM prsystem.staff_membership
            WHERE tenant_id = %s AND account_id = %s FOR SHARE""", (session[0], account[0])).fetchone()
        now = conn.execute("SELECT clock_timestamp()").fetchone()[0]
        if (account[1] != "ACTIVE" or account[2] is None or session[5] is not None
                or session[1] != account[3] or membership[0] != "ACTIVE" or session[2] != membership[1]
                or now >= session[3] or now >= session[4] + timedelta(seconds=self.settings.idle_seconds)):
            raise DomainError("UNAUTHENTICATED")
        if tenant is not None and tenant != session[0]:
            raise DomainError("FORBIDDEN")
        conn.execute("UPDATE prsystem.staff_session SET last_seen_at = %s WHERE token_hash = %s", (now, key))
        return {"account_id": account[0], "tenant_id": session[0], "roles": membership[2],
                "membership_revision": membership[1], "expires_at": session[3]}, account[4]

    def me(self, token):
        with transaction(self.dsn) as conn:
            principal, _ = self._authenticate(conn, token)
            return principal

    def logout(self, token):
        # Idempotent, including expired/revoked sessions; no privilege is granted.
        with transaction(self.dsn) as conn:
            row = conn.execute("""UPDATE prsystem.staff_session SET revoked_at = clock_timestamp()
                WHERE token_hash = %s AND revoked_at IS NULL RETURNING account_id, tenant_id""",
                (digest(token),)).fetchone()
            if row:
                self._audit(conn, "LOGOUT", *row)

    def logout_all(self, token):
        with transaction(self.dsn) as conn:
            principal, _ = self._authenticate(conn, token)
            conn.execute("UPDATE prsystem.staff_account SET auth_epoch = auth_epoch + 1 WHERE id = %s",
                         (principal["account_id"],))
            self._audit(conn, "LOGOUT_ALL", principal["account_id"], None)

    def change_password(self, token, current_password, new_password, peer):
        if not 12 <= len(new_password) <= 128:
            raise DomainError("INVALID_PASSWORD")
        self._rate_limit(digest(token), peer, "password-change")
        with transaction(self.dsn) as conn:
            principal, encoded = self._authenticate(conn, token)
            if not self._verify(self.passwords, encoded, current_password):
                raise DomainError("INVALID_CREDENTIALS")
            conn.execute("UPDATE prsystem.staff_account SET password_hash = %s WHERE id = %s",
                         (self.passwords.hash(new_password), principal["account_id"]))
            self._audit(conn, "PASSWORD_CHANGED", principal["account_id"], None)

    def cash_drawers(self, token, tenant):
        denied = None
        with transaction(self.dsn) as conn:
            principal, _ = self._authenticate(conn, token, tenant)
            hotel = conn.execute("""SELECT package_mnt, expires_at, security_suspended FROM prsystem.hotel_access
                WHERE tenant_id = %s FOR SHARE""", (tenant,)).fetchone()
            now = conn.execute("SELECT clock_timestamp()").fetchone()[0]
            # Full hotel cash visibility is explicitly HOTEL_ADMIN only (doc 18).
            facts = AccessFacts(tenant, True, True, True, "HOTEL_ADMIN" in principal["roles"],
                                hotel[0] in (20000, 25000, 30000), True, True, hotel[2])
            decision = subscription_gate(Action.EXPORT, facts, hotel[1], now)
            if not decision.allowed:
                denied = decision.code
                self._audit(conn, "CASH_READ_DENIED", principal["account_id"], tenant)
            else:
                conn.execute("SELECT set_config('prsystem.tenant_id', %s, true)", (tenant,))
                rows = conn.execute("""SELECT b.revision, d.id, d.shift_id, d.posted, d.reserved
                    FROM prsystem.cash_book b LEFT JOIN prsystem.cash_drawer d ON d.tenant_id = b.tenant_id
                    WHERE b.tenant_id = %s ORDER BY d.id""", (tenant,)).fetchall()
                if not rows:
                    raise DomainError("CASH_BOOK_NOT_FOUND")
                result = {"revision": rows[0][0], "drawers": [
                    {"id": r[1], "shift_id": r[2], "posted": r[3], "reserved": r[4], "available": r[3] - r[4]}
                    for r in rows if r[1] is not None]}
        if denied:
            raise DomainError(denied)
        return result
