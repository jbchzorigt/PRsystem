"""Server-held ХУР lookups for Reception (RC-DEC-046).

The adapter is called outside database transactions. Receipts keep only the
lookup id; citizen data lives in the encrypted xyp_lookup envelope.
"""
import secrets
from datetime import timedelta
from threading import BoundedSemaphore, Thread
from time import monotonic

from psycopg.types.json import Jsonb

from prsystem.booking_inventory import scope
from prsystem.common import DomainError
from prsystem.guest_identity import registration_number
from prsystem.postgres.connection import transaction
from prsystem.stays import StayService
from prsystem.xyp import TIMEOUT_SECONDS, XypNotFound, XypUnavailable, citizen_evidence

LOOKUP_LIMIT = 20
LOOKUP_WINDOW = timedelta(minutes=10)
LOOKUP_TTL = timedelta(minutes=15)
# At most this many adapter calls in flight, even while ХУР hangs. Each runs on a daemon thread,
# so a hung call never blocks process exit and no queue keeps a РД in memory.
ADAPTER_SLOTS = BoundedSemaphore(8)


class XypLookups(StayService):
    def __init__(self, auth, vault, gateway=None):
        super().__init__(auth, vault)
        self.gateway = gateway

    def ask(self, number):
        """Return (status, reason, citizen, error_type); error_type names an unexpected adapter crash."""
        if self.gateway is None:
            return 'UNAVAILABLE', 'NOT_CONFIGURED', None, None
        deadline = monotonic() + TIMEOUT_SECONDS
        if not ADAPTER_SLOTS.acquire(timeout=TIMEOUT_SECONDS):  # every slot is held by a hung call
            return 'UNAVAILABLE', 'TIMEOUT', None, None
        box = {}
        def call():
            try:
                box['answer'] = self.gateway.citizen(number)
            except Exception as exc:
                box['error'] = exc
            finally:
                ADAPTER_SLOTS.release()
        worker = Thread(target=call, name='xyp', daemon=True)
        try:
            worker.start()
        except RuntimeError:  # no thread could start: give the slot back
            ADAPTER_SLOTS.release()
            return 'UNAVAILABLE', 'PROVIDER_ERROR', None, 'RuntimeError'
        worker.join(max(0, deadline - monotonic()))
        if worker.is_alive():  # its late answer is discarded; the call keeps its slot until it returns
            return 'UNAVAILABLE', 'TIMEOUT', None, None
        try:
            if 'error' in box:
                raise box['error']
            return 'FOUND', None, citizen_evidence(number, box['answer']), None
        except TimeoutError:  # an adapter's socket.timeout is a TIMEOUT by design, not a crash
            return 'UNAVAILABLE', 'TIMEOUT', None, None
        except XypNotFound:
            return 'NOT_FOUND', None, None, None
        except XypUnavailable as exc:
            return 'UNAVAILABLE', exc.reason, None, None
        except Exception as exc:  # A crashing adapter must not block manual fallback.
            return 'UNAVAILABLE', 'PROVIDER_ERROR', None, type(exc).__name__  # the type only: messages may hold a РД

    def view(self, conn, tenant, lookup):
        scope(conn, tenant)
        status, reason, envelope, expires = conn.execute('SELECT status,reason,envelope,expires_at FROM prsystem.xyp_lookup WHERE tenant_id=%s AND id=%s',
                                                         (tenant, lookup)).fetchone()
        result = dict(lookup_id=lookup, status=status, expires_at=expires.isoformat())
        if reason is not None:  # UNAVAILABLE only (DB CHECK); a category, never registry data
            result['reason'] = reason
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

    @staticmethod
    def limit(conn, tenant, actor):
        """Serialized per actor: begin() holds the actor's staff_account row lock."""
        scope(conn, tenant)
        recent = conn.execute('''SELECT count(*) FROM prsystem.xyp_lookup WHERE tenant_id=%s AND actor_id=%s
            AND created_at>clock_timestamp()-%s AND reason IS DISTINCT FROM 'NOT_CONFIGURED' ''',
                              (tenant, actor, LOOKUP_WINDOW)).fetchone()[0]
        if recent >= LOOKUP_LIMIT:
            raise DomainError('XYP_LOOKUP_LIMIT')

    def lookup(self, bearer, tenant, document_number, consent, key):
        if self.vault is None:
            raise DomainError('IDENTITY_VAULT_UNAVAILABLE')
        with transaction(self.auth.dsn) as conn:
            actor, number, token, command, replay = self.begin(conn, bearer, tenant, document_number, consent, key)
            if replay is not None:
                return self.view(conn, tenant, replay['lookup_id'])
            if self.gateway is not None:  # NOT_CONFIGURED lookups never reach ХУР
                self.limit(conn, tenant, actor)
            consent_at = conn.execute('SELECT clock_timestamp()').fetchone()[0]
        status, reason, citizen, error = self.ask(number)  # never inside a database transaction
        with transaction(self.auth.dsn) as conn:
            actor, number, token, command, replay = self.begin(conn, bearer, tenant, document_number, consent, key)
            if replay is not None:  # a concurrent retry with the same key committed first
                return self.view(conn, tenant, replay['lookup_id'])
            scope(conn, tenant)  # the INSERT needs it even when limit() is skipped
            if self.gateway is not None:  # again: concurrent requests all passed the first count
                self.limit(conn, tenant, actor)
            lookup = secrets.token_hex(16)
            now = conn.execute('SELECT clock_timestamp()').fetchone()[0]
            envelope = Jsonb(self.vault.seal(citizen, tenant, lookup, 'xyp-lookup')) if citizen else None
            conn.execute('''INSERT INTO prsystem.xyp_lookup(tenant_id,id,actor_id,lookup_token,status,reason,envelope,consent_at,created_at,expires_at)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''', (tenant, lookup, actor, token, status, reason, envelope, consent_at, now, now + LOOKUP_TTL))
            self.event(conn, tenant, actor, 'XYP_LOOKUP', lookup, dict(status=status, reason=reason, **({'error': error} if error else {})))
            self._save_receipt(conn, tenant, key, actor, command, dict(lookup_id=lookup))
            return self.view(conn, tenant, lookup)
