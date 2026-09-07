"""Invitation/reset workflows. Email transport is an injected internal boundary."""

import hmac
import secrets
from dataclasses import dataclass, field
from datetime import timedelta

from email_validator import EmailNotValidError, validate_email
from psycopg.types.json import Jsonb

from prsystem.auth import StaffAuth, digest
from prsystem.staff_commands import StaffCommands
from prsystem.common import DomainError, identifier
from prsystem.postgres.connection import transaction
from prsystem.subscription import AccessFacts, Action, subscription_gate


def normalized_email(value):
    try:
        if not value.isascii():
            raise DomainError("INVALID_EMAIL")
        return validate_email(value.strip(), check_deliverability=False, allow_smtputf8=False).normalized.lower()
    except EmailNotValidError:
        raise DomainError("INVALID_EMAIL") from None


@dataclass(frozen=True)
class MailEnvelope:
    link_id: str
    purpose: str
    recipient: str = field(repr=False)
    token: str = field(repr=False)


class StaffLifecycle(StaffCommands):
    def __init__(self, auth: StaffAuth, token_key: bytes, *, invite_hours=24, reset_minutes=30):
        if not isinstance(token_key, bytes) or len(token_key) < 32:
            raise ValueError("A deployment token key of at least 32 bytes is required")
        if type(invite_hours) is not int or invite_hours <= 0 or type(reset_minutes) is not int or reset_minutes <= 0:
            raise ValueError("Link lifetimes must be positive integers")
        self.auth, self._key = auth, token_key
        self.invite_ttl, self.reset_ttl = timedelta(hours=invite_hours), timedelta(minutes=reset_minutes)

    def _token(self, purpose, link_id):
        mac = hmac.digest(self._key, f"prsystem:{purpose}:{link_id}".encode(), "sha256").hex()
        return f"{link_id}.{mac}"

    @staticmethod
    def _event(conn, kind, actor, target, tenant, link, details=None):
        conn.execute("""INSERT INTO prsystem.staff_lifecycle_event (id, kind, actor_id, target_id, tenant_id, link_id, details)
            VALUES (%s, %s, %s, %s, %s, %s, %s)""", (secrets.token_hex(16), kind, actor, target, tenant, link, Jsonb(details or {})))

    def admin_reset(self, bearer, tenant, target, revision, key, peer):
        self.auth._rate_limit(digest(bearer), peer, "admin-reset")
        command = {"action": "ADMIN_RESET", "account_id": target, "revision": revision}
        with transaction(self.auth.dsn) as conn:
            actor, _ = self._admin(conn, bearer, tenant, target)
            replay = self._receipt(conn, tenant, key, actor, command)
            if replay is not None:
                return replay
            member = conn.execute("""SELECT revision FROM prsystem.staff_membership
                WHERE tenant_id = %s AND account_id = %s FOR SHARE""", (tenant, target)).fetchone()
            if member is None:
                raise DomainError("MEMBERSHIP_NOT_FOUND")
            if type(revision) is not int or member[0] != revision:
                raise DomainError("REVISION_CONFLICT")
            account = conn.execute("SELECT email, verified_at FROM prsystem.staff_account WHERE id = %s", (target,)).fetchone()
            if account[1] is None:
                raise DomainError("ACCOUNT_NOT_VERIFIED")
            request_id = secrets.token_hex(16)
            conn.execute("INSERT INTO prsystem.password_reset_request (id, email) VALUES (%s, %s)", (request_id, account[0]))
            self._event(conn, "ADMIN_RESET_REQUESTED", actor, target, tenant, None, {"request_id": request_id, "revision": revision})
            result = {"status": "ACCEPTED"}
            self._save_receipt(conn, tenant, key, actor, command, result)
            return result

    def recover_invite(self, bearer, tenant, target, revision, key, reason):
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 1000:
            raise DomainError("INVALID_REASON")
        command = {"action": "RECOVER_INVITE", "account_id": target, "revision": revision, "reason": reason}
        with transaction(self.auth.dsn) as conn:
            actor, package = self._admin(conn, bearer, tenant, target)
            replay = self._receipt(conn, tenant, key, actor, command)
            if replay is not None:
                return replay
            member = conn.execute("""SELECT status, roles, revision, is_primary FROM prsystem.staff_membership
                WHERE tenant_id = %s AND account_id = %s FOR UPDATE""", (tenant, target)).fetchone()
            if member is None:
                raise DomainError("MEMBERSHIP_NOT_FOUND")
            if type(revision) is not int or revision != member[2]:
                raise DomainError("REVISION_CONFLICT")
            if member[3]:
                raise DomainError("PRIMARY_ADMIN_PROTECTED")
            if member[0] not in {"SUSPENDED", "TERMINATED"}:
                raise DomainError("INVALID_MEMBERSHIP_TRANSITION")
            account = conn.execute("SELECT status, verified_at, auth_epoch FROM prsystem.staff_account WHERE id = %s", (target,)).fetchone()
            if account[0] != "ACTIVE":
                raise DomainError("SECURITY_SUSPENDED")
            if account[1] is not None:
                raise DomainError("VERIFIED_ACCOUNT_REQUIRES_REACTIVATION")
            self._roles(member[1], package)
            new_revision = conn.execute("""UPDATE prsystem.staff_membership SET status = 'PENDING'
                WHERE tenant_id = %s AND account_id = %s RETURNING revision""", (tenant, target)).fetchone()[0]
            conn.execute("""UPDATE prsystem.staff_session SET revoked_at = clock_timestamp()
                WHERE tenant_id = %s AND account_id = %s AND revoked_at IS NULL""", (tenant, target))
            result = self._issue(conn, "INVITE", target, account[2], tenant, actor, new_revision)
            self._event(conn, "INVITE_RECOVERED", actor, target, tenant, result["invitation_id"],
                        {"reason": reason, "previous_status": member[0], "revision": new_revision})
            self._save_receipt(conn, tenant, key, actor, command, result)
            return result

    def _issue(self, conn, purpose, account, epoch, tenant=None, inviter=None, revision=None):
        conn.execute("""UPDATE prsystem.staff_link SET state = 'SUPERSEDED'
            WHERE purpose = %s AND account_id = %s AND tenant_id IS NOT DISTINCT FROM %s AND state = 'ACTIVE'""",
            (purpose, account, tenant))
        link_id = secrets.token_hex(16)
        expires = conn.execute("SELECT clock_timestamp() + %s", (self.invite_ttl if purpose == "INVITE" else self.reset_ttl,)).fetchone()[0]
        conn.execute("""INSERT INTO prsystem.staff_link
            (id, purpose, account_id, tenant_id, inviter_id, membership_revision, issued_epoch, token_hash, expires_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (link_id, purpose, account, tenant, inviter, revision, epoch, digest(self._token(purpose, link_id)), expires))
        conn.execute("INSERT INTO prsystem.staff_mail_intent (link_id) VALUES (%s)", (link_id,))
        return {"account_id": account, "revision": revision, "invitation_id": link_id, "state": "ACTIVE", "expires_at": expires.isoformat()}

    def invite(self, bearer, tenant, email, name, roles, key):
        email = normalized_email(email)
        identifier(name)
        command = {"action": "invite", "email": email, "name": name, "roles": roles}
        with transaction(self.auth.dsn) as conn:
            # Serialize account creation by normalized email before account locks.
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (f"staff-email:{email}",))
            target = conn.execute("SELECT id, status, auth_epoch FROM prsystem.staff_account WHERE email = %s", (email,)).fetchone()
            actor, package = self._admin(conn, bearer, tenant, target[0] if target else None)
            self._roles(roles, package)
            replay = self._receipt(conn, tenant, key, actor, command)
            if replay:
                return replay
            if target is None:
                target = (secrets.token_hex(16), "ACTIVE", 0)
                # Unverified placeholder has no usable password; invitee chooses it.
                conn.execute("""INSERT INTO prsystem.staff_account (id, email, password_hash, display_name)
                    VALUES (%s, %s, '!', %s)""", (target[0], email, name))
            else:
                target = conn.execute("SELECT id, status, auth_epoch FROM prsystem.staff_account WHERE id = %s", (target[0],)).fetchone()
            if target[1] != "ACTIVE":
                raise DomainError("SECURITY_SUSPENDED")
            member = conn.execute("SELECT status FROM prsystem.staff_membership WHERE tenant_id = %s AND account_id = %s FOR UPDATE",
                                  (tenant, target[0])).fetchone()
            if member:
                raise DomainError("MEMBERSHIP_EXISTS")
            conn.execute("""INSERT INTO prsystem.staff_membership (tenant_id, account_id, status, roles)
                VALUES (%s, %s, 'PENDING', %s)""", (tenant, target[0], roles))
            result = self._issue(conn, "INVITE", target[0], target[2], tenant, actor, 0)
            self._event(conn, "INVITE_CREATED", actor, target[0], tenant, result["invitation_id"])
            self._save_receipt(conn, tenant, key, actor, command, result)
            return result

    def change_invite(self, bearer, tenant, target, revision, key, *, resend):
        command = {"action": "resend" if resend else "revoke", "account_id": target, "revision": revision}
        with transaction(self.auth.dsn) as conn:
            actor, package = self._admin(conn, bearer, tenant, target)
            replay = self._receipt(conn, tenant, key, actor, command)
            if replay:
                return replay
            member = conn.execute("""SELECT status, roles, revision FROM prsystem.staff_membership
                WHERE tenant_id = %s AND account_id = %s FOR UPDATE""", (tenant, target)).fetchone()
            if member is None:
                raise DomainError("MEMBERSHIP_NOT_FOUND")
            if type(revision) is not int or revision != member[2]:
                raise DomainError("REVISION_CONFLICT")
            if member[0] != "PENDING":
                raise DomainError("MEMBERSHIP_NOT_PENDING")
            self._roles(member[1], package)
            account = conn.execute("SELECT status, auth_epoch FROM prsystem.staff_account WHERE id = %s", (target,)).fetchone()
            if account[0] != "ACTIVE":
                raise DomainError("SECURITY_SUSPENDED")
            new_revision = conn.execute("""UPDATE prsystem.staff_membership SET revision = revision + 1
                WHERE tenant_id = %s AND account_id = %s RETURNING revision""", (tenant, target)).fetchone()[0]
            if resend:
                result = self._issue(conn, "INVITE", target, account[1], tenant, actor, new_revision)
            else:
                row = conn.execute("""UPDATE prsystem.staff_link SET state = 'REVOKED'
                    WHERE tenant_id = %s AND account_id = %s AND purpose = 'INVITE' AND state = 'ACTIVE' RETURNING id""",
                    (tenant, target)).fetchone()
                if row is None:
                    raise DomainError("INVALID_LINK")
                result = {"account_id": target, "revision": new_revision, "invitation_id": row[0], "state": "REVOKED"}
            self._event(conn, "INVITE_RESENT" if resend else "INVITE_REVOKED", actor, target, tenant, result["invitation_id"])
            self._save_receipt(conn, tenant, key, actor, command, result)
            return result

    @staticmethod
    def _link(conn, token, purpose):
        row = conn.execute("""SELECT id, account_id, tenant_id, inviter_id, membership_revision, issued_epoch
            FROM prsystem.staff_link WHERE token_hash = %s AND purpose = %s AND state = 'ACTIVE'
            AND expires_at > clock_timestamp()""", (digest(token), purpose)).fetchone()
        if row is None:
            raise DomainError("INVALID_LINK")
        return row

    @staticmethod
    def _consume(conn, link_id):
        # Recheck after password hashing/lock waits, immediately before commit.
        consumed = conn.execute("""UPDATE prsystem.staff_link SET state = 'ACCEPTED'
            WHERE id = %s AND state = 'ACTIVE' AND expires_at > clock_timestamp() RETURNING id""", (link_id,)).fetchone()
        if consumed is None:
            raise DomainError("INVALID_LINK")

    def accept(self, token, password, peer):
        self.auth._rate_limit(digest(token), peer, "invite-accept")
        with transaction(self.auth.dsn) as conn:
            link = self._link(conn, token, "INVITE")
            self._lock_accounts(conn, {link[1], link[3]})
            # Target and inviter membership locks precede the shared hotel lock.
            members = {r[0]: r[1:] for r in conn.execute("""SELECT account_id, status, roles, revision FROM prsystem.staff_membership
                WHERE tenant_id = %s AND account_id = ANY(%s) ORDER BY account_id FOR UPDATE""", (link[2], [link[1], link[3]]))}
            link = self._link(conn, token, "INVITE")
            target = conn.execute("SELECT status, verified_at, password_hash FROM prsystem.staff_account WHERE id = %s", (link[1],)).fetchone()
            inviter = conn.execute("SELECT status, verified_at FROM prsystem.staff_account WHERE id = %s", (link[3],)).fetchone()
            member, author = members[link[1]], members[link[3]]
            if (target[0] != "ACTIVE" or inviter[0] != "ACTIVE" or inviter[1] is None
                    or member[0] != "PENDING" or member[2] != link[4]
                    or author[0] != "ACTIVE" or "HOTEL_ADMIN" not in author[1]):
                raise DomainError("INVALID_LINK")
            hotel = conn.execute("SELECT package_mnt, expires_at, security_suspended FROM prsystem.hotel_access WHERE tenant_id = %s FOR SHARE", (link[2],)).fetchone()
            self._roles(member[1], hotel[0])
            facts = AccessFacts(link[2], True, True, True, True, True, True, True, hotel[2])
            decision = subscription_gate(Action.CONFIGURE, facts, hotel[1], conn.execute("SELECT clock_timestamp()").fetchone()[0])
            if not decision.allowed:
                raise DomainError(decision.code)
            if target[1] is None:
                if not 12 <= len(password) <= 128:
                    raise DomainError("INVALID_PASSWORD")
                conn.execute("UPDATE prsystem.staff_account SET password_hash = %s, verified_at = clock_timestamp() WHERE id = %s",
                             (self.auth.passwords.hash(password), link[1]))
            elif not self.auth._verify(self.auth.passwords, target[2], password):
                raise DomainError("INVALID_CREDENTIALS")
            # Existing users reauthenticate with their existing password here;
            # it is never overwritten by an invitation or by the inviter.
            revision = conn.execute("UPDATE prsystem.staff_membership SET status = 'ACTIVE' WHERE tenant_id = %s AND account_id = %s RETURNING revision",
                                    (link[2], link[1])).fetchone()[0]
            self._consume(conn, link[0])
            self._event(conn, "INVITE_ACCEPTED", link[1], link[1], link[2], link[0])
            return {"account_id": link[1], "tenant_id": link[2], "revision": revision, "state": "ACTIVE"}

    def request_reset(self, email, peer):
        email = normalized_email(email)
        self.auth._rate_limit(email, peer, "reset-request")
        # Same enqueue path for existing and unknown addresses; no account lookup
        # on the public request path or account-existence-dependent response.
        with transaction(self.auth.dsn) as conn:
            conn.execute("INSERT INTO prsystem.password_reset_request (id, email) VALUES (%s, %s)", (secrets.token_hex(16), email))

    def process_reset_request(self, request_id):
        """Internal worker operation. Does not send email or return a secret."""
        with transaction(self.auth.dsn) as conn:
            request = conn.execute("SELECT email FROM prsystem.password_reset_request WHERE id = %s", (request_id,)).fetchone()
            if request is None:
                return
            account = conn.execute("SELECT id, verified_at, auth_epoch FROM prsystem.staff_account WHERE email = %s FOR UPDATE", (request[0],)).fetchone()
            job = conn.execute("SELECT processed_at, created_at FROM prsystem.password_reset_request WHERE id = %s FOR UPDATE", (request_id,)).fetchone()
            if job[0] is not None:
                return
            conn.execute("UPDATE prsystem.password_reset_request SET processed_at = clock_timestamp() WHERE id = %s", (request_id,))
            newer = conn.execute("""SELECT 1 FROM prsystem.password_reset_request WHERE email = %s
                AND (created_at, id) > (%s, %s) LIMIT 1""", (request[0], job[1], request_id)).fetchone()
            if account is None or account[1] is None or newer:
                return
            result = self._issue(conn, "RESET", account[0], account[2])
            self._event(conn, "RESET_REQUESTED", None, account[0], None, result["invitation_id"])

    def complete_reset(self, token, password, peer):
        if not 12 <= len(password) <= 128:
            raise DomainError("INVALID_PASSWORD")
        self.auth._rate_limit(digest(token), peer, "reset-complete")
        with transaction(self.auth.dsn) as conn:
            link = self._link(conn, token, "RESET")
            self._lock_accounts(conn, {link[1]})
            link = self._link(conn, token, "RESET")
            account = conn.execute("SELECT auth_epoch, verified_at FROM prsystem.staff_account WHERE id = %s", (link[1],)).fetchone()
            if account[1] is None or account[0] != link[5]:
                raise DomainError("INVALID_LINK")
            conn.execute("UPDATE prsystem.staff_account SET password_hash = %s WHERE id = %s",
                         (self.auth.passwords.hash(password), link[1]))
            self._consume(conn, link[0])
            self._event(conn, "PASSWORD_RESET", link[1], link[1], None, link[0])

    def prepare_delivery(self, link_id):
        """Trusted transport boundary only. Never expose its result to hotel APIs.

        Delivery may race a revocation after this transaction; consumption still
        revalidates the token. Duplicate delivery contains the same one-use token.
        """
        with transaction(self.auth.dsn) as conn:
            row = conn.execute("""SELECT l.purpose, l.token_hash, a.email, l.issued_epoch, a.auth_epoch, l.account_id, l.tenant_id, l.membership_revision, l.restaurant_id
                FROM prsystem.staff_mail_intent m JOIN prsystem.staff_link l ON l.id = m.link_id
                JOIN prsystem.staff_account a ON a.id = l.account_id
                WHERE l.id = %s AND l.state = 'ACTIVE' AND l.expires_at > clock_timestamp() AND m.delivered_at IS NULL""", (link_id,)).fetchone()
            if row is None or (row[0] == "RESET" and row[3] != row[4]):
                return None
            if row[0] == "INVITE":
                member = conn.execute("SELECT status, revision FROM prsystem.staff_membership WHERE tenant_id = %s AND account_id = %s",
                                      (row[6], row[5])).fetchone()
                if member != ("PENDING", row[7]):
                    return None
            if row[0] == "RESTAURANT_INVITE":
                member = conn.execute("SELECT status, revision FROM prsystem.restaurant_membership WHERE restaurant_id = %s AND account_id = %s",
                                      (row[8], row[5])).fetchone()
                if member != ("PENDING", row[7]):
                    return None
            token = self._token(row[0], link_id)
            if not hmac.compare_digest(digest(token), row[1]):
                raise DomainError("TOKEN_KEY_MISMATCH")
            return MailEnvelope(link_id, row[0], row[2], token)

    def deliver(self, link_id, transport):
        """Inject a real approved transport in deployment; tests use an in-memory sink."""
        envelope = self.prepare_delivery(link_id)
        if envelope is None:
            return False
        transport(envelope)  # No network call while holding a database transaction.
        with transaction(self.auth.dsn) as conn:
            conn.execute("UPDATE prsystem.staff_mail_intent SET delivered_at = clock_timestamp() WHERE link_id = %s AND delivered_at IS NULL", (link_id,))
        return True
