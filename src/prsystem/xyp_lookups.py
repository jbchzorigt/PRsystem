"""Server-held ХУР lookups for Reception (RC-DEC-046).

The adapter is called outside database transactions. Receipts keep only the
lookup id; citizen data lives in the encrypted xyp_lookup envelope.
"""
import secrets
from datetime import timedelta

from psycopg.types.json import Jsonb

from prsystem.booking_inventory import scope
from prsystem.common import DomainError
from prsystem.guest_identity import registration_number
from prsystem.postgres.connection import transaction
from prsystem.stays import StayService
from prsystem.xyp import XypNotFound, XypUnavailable, citizen_evidence

LOOKUP_LIMIT = 20
LOOKUP_WINDOW = timedelta(minutes=10)
LOOKUP_TTL = timedelta(minutes=15)


class XypLookups(StayService):
    def __init__(self, auth, vault, gateway=None):
        super().__init__(auth, vault)
        self.gateway = gateway

    def ask(self, number):
        if self.gateway is None:
            return 'UNAVAILABLE', 'NOT_CONFIGURED', None
        try:
            return 'FOUND', None, citizen_evidence(number, self.gateway.citizen(number))
        except XypNotFound:
            return 'NOT_FOUND', None, None
        except XypUnavailable as exc:
            return 'UNAVAILABLE', exc.reason, None
        except Exception:  # A crashing adapter must not block manual fallback.
            return 'UNAVAILABLE', 'PROVIDER_ERROR', None

    def view(self, conn, tenant, lookup):
        scope(conn, tenant)
        status, envelope, expires = conn.execute('SELECT status,envelope,expires_at FROM prsystem.xyp_lookup WHERE tenant_id=%s AND id=%s',
                                                 (tenant, lookup)).fetchone()
        result = dict(lookup_id=lookup, status=status, expires_at=expires.isoformat())
        if envelope:
            citizen = self.vault.open(envelope, tenant, lookup, 'xyp-lookup')
            result['citizen'] = dict(family_name=citizen['family_name'], given_name=citizen['given_name'],
                                     date_of_birth=citizen['date_of_birth'], nationality='MN')
        return result

    def begin(self, conn, bearer, tenant, document_number, consent, key):
        actor = self._actor(conn, bearer, tenant)
        number, _ = registration_number(document_number)
        if consent is not True:
            raise DomainError('XYP_CONSENT_REQUIRED')
        token = self.vault.fingerprint('guest-exact-identity', ['MN_REG_NO', 'MN', number])
        command = dict(action='XYP_LOOKUP', fingerprint=self.vault.fingerprint('xyp-lookup-command', [tenant, token]))
        return actor, number, token, command, self._receipt(conn, tenant, key, actor, command)

    def lookup(self, bearer, tenant, document_number, consent, key):
        if self.vault is None:
            raise DomainError('IDENTITY_VAULT_UNAVAILABLE')
        with transaction(self.auth.dsn) as conn:
            actor, number, token, command, replay = self.begin(conn, bearer, tenant, document_number, consent, key)
            if replay is not None:
                return self.view(conn, tenant, replay['lookup_id'])
            scope(conn, tenant)
            recent = conn.execute('SELECT count(*) FROM prsystem.xyp_lookup WHERE tenant_id=%s AND actor_id=%s AND created_at>clock_timestamp()-%s',
                                  (tenant, actor, LOOKUP_WINDOW)).fetchone()[0]
            if recent >= LOOKUP_LIMIT:
                raise DomainError('XYP_LOOKUP_LIMIT')
            consent_at = conn.execute('SELECT clock_timestamp()').fetchone()[0]
        status, reason, citizen = self.ask(number)  # never inside a database transaction
        with transaction(self.auth.dsn) as conn:
            actor, number, token, command, replay = self.begin(conn, bearer, tenant, document_number, consent, key)
            if replay is not None:  # a concurrent retry with the same key committed first
                return self.view(conn, tenant, replay['lookup_id'])
            scope(conn, tenant)
            lookup = secrets.token_hex(16)
            now = conn.execute('SELECT clock_timestamp()').fetchone()[0]
            envelope = Jsonb(self.vault.seal(citizen, tenant, lookup, 'xyp-lookup')) if citizen else None
            conn.execute('''INSERT INTO prsystem.xyp_lookup(tenant_id,id,actor_id,lookup_token,status,reason,envelope,consent_at,created_at,expires_at)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''', (tenant, lookup, actor, token, status, reason, envelope, consent_at, now, now + LOOKUP_TTL))
            self.event(conn, tenant, actor, 'XYP_LOOKUP', lookup, dict(status=status, reason=reason))
            self._save_receipt(conn, tenant, key, actor, command, dict(lookup_id=lookup))
            return self.view(conn, tenant, lookup)
