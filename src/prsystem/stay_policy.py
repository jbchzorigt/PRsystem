"""STAY-DEC-009/014: immutable initial dates and integer MNT pricing."""
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo
from prsystem.common import DomainError, money, timestamp

HOTEL_ZONE = ZoneInfo('Asia/Ulaanbaatar')


def actual_time(recorded, opened, requested=None, reason=None):
    timestamp(recorded); timestamp(opened)
    actual = recorded if requested is None else requested
    timestamp(actual)
    day_start = datetime.combine(recorded.astimezone(HOTEL_ZONE).date(), time(), HOTEL_ZONE)
    earliest = max(recorded - timedelta(minutes=120), opened, day_start)
    if not earliest <= actual <= recorded:
        raise DomainError('ACTUAL_TIME_OUT_OF_RANGE')
    if actual < recorded and (not isinstance(reason, str) or not reason.strip() or len(reason) > 1000):
        raise DomainError('INVALID_REASON')
    return actual


def stay_terms(kind, units, actual, recorded, unit_price, checkout_time):
    timestamp(actual); timestamp(recorded); money(unit_price, positive=True)
    if kind not in {'HOURLY', 'NIGHTLY'} or type(units) is not int or units < 1:
        raise DomainError('INVALID_STAY_DURATION')
    try:
        if kind == 'HOURLY':
            end = actual + timedelta(minutes=units * 30)
            amount = (unit_price * units + 1) // 2  # ROUND_HALF_UP, exactly once.
        else:
            day = actual.astimezone(HOTEL_ZONE).date() + timedelta(days=units)
            end = datetime.combine(day, checkout_time, HOTEL_ZONE)
            amount = unit_price * units
        money(amount, positive=True)
    except (OverflowError, ValueError) as exc:
        raise DomainError('INVALID_STAY_DURATION') from exc
    if end <= recorded:
        raise DomainError('STAY_ALREADY_ENDED')
    return end, amount


def overlaps(start, end, other_start, other_end, buffer_minutes=0, other_buffer_minutes=0):
    """Half-open occupancy plus each stay's own following cleaning buffer."""
    try:
        return start < other_end + timedelta(minutes=other_buffer_minutes) and other_start < end + timedelta(minutes=buffer_minutes)
    except OverflowError as exc:
        raise DomainError('INVALID_STAY_DURATION') from exc
