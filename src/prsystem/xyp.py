"""ХУР (XYP) citizen register port and evidence rules (RC-DEC-046).

Pure domain: no database driver imports. Only a server-held, encrypted lookup
result can make an identity XYP_VERIFIED; the browser never asserts it.
"""
from typing import Protocol

from prsystem.booking_inventory import scope
from prsystem.common import DomainError, identifier
from prsystem.guest_identity import calendar_date, registration_number, text, validate_identity

REASONS = frozenset({'NOT_CONFIGURED', 'TIMEOUT', 'PROVIDER_ERROR', 'INVALID_EVIDENCE'})
# Real adapters must answer or raise XypUnavailable('TIMEOUT') within this bound.
TIMEOUT_SECONDS = 10


class XypUnavailable(Exception):
    """Network, timeout, missing configuration or an unusable answer."""

    def __init__(self, reason='PROVIDER_ERROR'):
        super().__init__(reason)
        self.reason = reason if reason in REASONS else 'PROVIDER_ERROR'


class XypNotFound(Exception):
    """The register has no citizen for this РД."""


class XypGateway(Protocol):
    def citizen(self, document_number: str) -> dict: ...


def citizen_evidence(document_number, raw):
    """Accept only a complete answer whose birth date matches the РД encoding."""
    try:
        result = dict(family_name=text(raw['family_name']), given_name=text(raw['given_name']),
                      date_of_birth=calendar_date(raw['date_of_birth']).isoformat())
    except (DomainError, KeyError, TypeError) as exc:
        raise XypUnavailable('INVALID_EVIDENCE') from exc
    if registration_number(document_number)[1].isoformat() != result['date_of_birth']:
        raise XypUnavailable('INVALID_EVIDENCE')
    return dict(result, document_number=document_number)


MANUAL_FIELDS = ('document_number', 'family_name', 'given_name', 'date_of_birth', 'nationality')


def bind(conn, vault, tenant, guest, on_date):
    """Resolve a Mongolian РД guest through its server-held, unused, unexpired ХУР lookup."""
    lookup = guest.get('xyp_lookup_id')
    if lookup is None:
        raise DomainError('XYP_LOOKUP_REQUIRED')
    identifier(lookup)
    scope(conn, tenant)
    row = conn.execute('''SELECT status,reason,lookup_token,envelope,stay_id,expires_at<=clock_timestamp()
        FROM prsystem.xyp_lookup WHERE tenant_id=%s AND id=%s FOR UPDATE''', (tenant, lookup)).fetchone()
    if not row:
        raise DomainError('XYP_LOOKUP_NOT_FOUND')
    status, reason, token, envelope, stay, expired = row
    if stay is not None:
        raise DomainError('XYP_LOOKUP_USED')
    if expired:
        raise DomainError('XYP_LOOKUP_EXPIRED')
    if status == 'FOUND':
        if any(guest.get(name) is not None for name in MANUAL_FIELDS):
            raise DomainError('XYP_VERIFIED_FIELDS_LOCKED')
        citizen = vault.open(envelope, tenant, lookup, 'xyp-lookup')
        identity, exact = validate_identity(dict(citizen, identity_type='MN_REG_NO', nationality='MN'), on_date)
        identity['provenance'] = 'XYP_VERIFIED'
    else:
        identity, exact = validate_identity({k: v for k, v in guest.items() if k != 'xyp_lookup_id'}, on_date)
        if vault.fingerprint('guest-exact-identity', list(exact)) != token:
            raise DomainError('XYP_LOOKUP_MISMATCH')
        identity['xyp_fallback'] = dict(status=status, reason=reason)
    return identity, exact, lookup
