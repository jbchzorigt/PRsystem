"""ХУР (XYP) citizen register port and evidence rules (RC-DEC-046).

Pure domain: no database code. Only a server-held, encrypted lookup result can
make an identity XYP_VERIFIED (bound in StayService._xyp_identity); the
browser never asserts it.
"""
from typing import Protocol

from prsystem.common import DomainError
from prsystem.guest_identity import calendar_date, registration_number, text

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

