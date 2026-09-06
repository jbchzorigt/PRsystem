"""Shared validation for authoritative domain values."""

from datetime import datetime

MAX_MNT = 2**63 - 1


class DomainError(ValueError):
    """Stable error code for a rejected command; no state has changed."""


def money(value: int, *, positive: bool = False) -> None:
    if type(value) is not int or not (int(positive) <= value <= MAX_MNT):
        raise DomainError("INVALID_MNT")


def timestamp(value: datetime) -> None:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise DomainError("TIMEZONE_REQUIRED")


def identifier(value: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise DomainError("INVALID_IDENTIFIER")
