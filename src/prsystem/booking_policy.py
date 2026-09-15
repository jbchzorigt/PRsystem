"""Stage-four booking rules (docs/09 and docs/11).

Inputs are trusted, persisted service facts, never browser payment flags. These
pure decisions must be applied under the repository's category/booking lock.
They neither authenticate a booker nor reserve inventory or move money.
"""
from dataclasses import dataclass
from datetime import datetime, time, timedelta
from enum import StrEnum

from .common import DomainError, identifier, money, timestamp
from .settlement import BookingState, RefundObligation, SettlementFacts, commission_mnt
from .stay_policy import HOTEL_ZONE, overlaps, stay_terms


@dataclass(frozen=True)
class Contract:
    tenant_id: str
    contract_id: str
    version: int
    rate_bps: int
    valid_from: datetime
    valid_until: datetime

    def __post_init__(self):
        identifier(self.tenant_id)
        identifier(self.contract_id)
        _version(self.version)
        commission_mnt(0, self.rate_bps)
        timestamp(self.valid_from)
        timestamp(self.valid_until)
        if self.valid_until <= self.valid_from:
            raise DomainError('INVALID_CONTRACT_INTERVAL')

    def require_current(self, now):
        timestamp(now)
        if not self.valid_from <= now < self.valid_until:
            raise DomainError('BOOKING_CONTRACT_REQUIRED')


def _version(value):
    if type(value) is not int or value < 1:
        raise DomainError('INVALID_CONFIG_VERSION')


@dataclass(frozen=True)
class OnlineQuote:
    tenant_id: str
    category_id: str
    quoted_at: datetime
    planned_checkin_at: datetime
    planned_checkout_at: datetime
    nights: int
    unit_price: int
    amount_mnt: int
    price_source: str
    price_source_id: str
    price_version: int
    hotel_settings_version: int
    checkout_time: time
    cleaning_buffer_minutes: int
    contract_id: str
    contract_version: int
    commission_rate_bps: int
    cancellation_policy: str
    free_cancel_until: datetime
    no_show_cutoff: datetime


def quote_nights(*, tenant_id, category_id, now, arrival, nights,
                 category_price, category_version, hotel_price,
                 hotel_version, checkout_time, cleaning_buffer_minutes, contract):
    """No physical-room tariff argument exists: BK-DEC-012/013."""
    identifier(tenant_id)
    identifier(category_id)
    timestamp(now)
    timestamp(arrival)
    _version(category_version)
    _version(hotel_version)
    if not isinstance(contract, Contract):
        raise DomainError('BOOKING_CONTRACT_REQUIRED')
    if contract.tenant_id != tenant_id:
        raise DomainError('TENANT_MISMATCH')
    contract.require_current(now)
    if arrival < now:
        raise DomainError('BOOKING_ARRIVAL_IN_PAST')
    if (not isinstance(checkout_time, time) or checkout_time.tzinfo is not None
            or checkout_time.second or checkout_time.microsecond):
        raise DomainError('INVALID_CHECKOUT_TIME')
    if (type(cleaning_buffer_minutes) is not int
            or not 0 <= cleaning_buffer_minutes <= 2**31 - 1):
        raise DomainError('INVALID_CLEANING_BUFFER')
    for price in (category_price, hotel_price):
        if price is not None:
            money(price, positive=True)
    if category_price is not None:
        rate, source, source_id, version = category_price, 'CATEGORY', category_id, category_version
    elif hotel_price is not None:
        rate, source, source_id, version = hotel_price, 'HOTEL', tenant_id, hotel_version
    else:
        raise DomainError('STAY_SETTINGS_REQUIRED')
    end, total = stay_terms('NIGHTLY', nights, arrival, now, rate, checkout_time)
    try:
        deadline = arrival - timedelta(hours=24)
        cutoff = datetime.combine(arrival.astimezone(HOTEL_ZONE).date(), time(23, 59, 59), HOTEL_ZONE)
        # Verify that the complete inventory interval is representable as well.
        end + timedelta(minutes=cleaning_buffer_minutes)
    except (OverflowError, ValueError) as exc:
        raise DomainError('INVALID_STAY_DURATION') from exc
    return OnlineQuote(tenant_id, category_id, now, arrival, end, nights, rate,
                       total, source, source_id, version, hotel_version, checkout_time,
                       cleaning_buffer_minutes, contract.contract_id, contract.version,
                       contract.rate_bps, 'PAY-DEC-007', deadline, cutoff)


@dataclass(frozen=True)
class CancellationAmounts:
    settlement: SettlementFacts
    commission_mnt: int
    hotel_payable_mnt: int


def cancel_confirmed(quote, *, current_state, outcome, now):
    """Authorize actors separately; terminal cancellation releases inventory now.

    Positive refunds remain obligations, not evidence of provider completion.
    """
    timestamp(now)
    if current_state != BookingState.CONFIRMED:
        raise DomainError('BOOKING_NOT_CONFIRMED')
    if outcome not in {BookingState.CANCELLED_GUEST, BookingState.CANCELLED_HOTEL, BookingState.NO_SHOW}:
        raise DomainError('INVALID_BOOKING_TRANSITION')
    if now < quote.quoted_at:
        raise DomainError('INVALID_BOOKING_TIME')
    if outcome == BookingState.NO_SHOW and now <= quote.no_show_cutoff:
        raise DomainError('NO_SHOW_CUTOFF_NOT_PASSED')
    free = outcome == BookingState.CANCELLED_HOTEL or (outcome == BookingState.CANCELLED_GUEST and now <= quote.free_cancel_until)
    retained = 0 if free else min(quote.amount_mnt, quote.unit_price)
    facts = SettlementFacts(outcome, quote.amount_mnt, retained,
                            RefundObligation(quote.amount_mnt - retained, 0))
    commission = commission_mnt(retained, quote.commission_rate_bps)
    return CancellationAmounts(facts, commission, retained - commission)


class HoldState(StrEnum):
    ACTIVE = 'ACTIVE'
    CONSUMED = 'CONSUMED'
    EXPIRED = 'EXPIRED'
    CANCELLED = 'CANCELLED'


class CaptureDisposition(StrEnum):
    CONFIRM = 'CONFIRM'
    ALREADY_APPLIED = 'ALREADY_APPLIED'
    DUPLICATE_CAPTURE = 'DUPLICATE_CAPTURE'
    LATE_PAYMENT_AFTER_HOLD = 'LATE_PAYMENT_AFTER_HOLD'
    REFUND_TERMINAL_BOOKING = 'REFUND_TERMINAL_BOOKING'


@dataclass(frozen=True)
class PaymentWindow:
    created_at: datetime
    expires_at: datetime

    @classmethod
    def open(cls, now):
        timestamp(now)
        try:
            return cls(now, now + timedelta(minutes=10))
        except OverflowError as exc:
            raise DomainError('INVALID_BOOKING_TIME') from exc

    def __post_init__(self):
        timestamp(self.created_at)
        timestamp(self.expires_at)
        if self.expires_at - self.created_at != timedelta(minutes=10):
            raise DomainError('INVALID_HOLD_WINDOW')

    def invoice_deadline(self, now):
        timestamp(now)
        if now < self.created_at:
            raise DomainError('INVALID_BOOKING_TIME')
        if now >= self.expires_at:
            raise DomainError('HOLD_EXPIRED')
        # Switching gateways cannot restart the original ten-minute timer.
        return self.expires_at

    def expiry_due(self, now):
        timestamp(now)
        if now < self.created_at:
            raise DomainError('INVALID_BOOKING_TIME')
        return now >= self.expires_at


def capture_disposition(*, hold_state, applied_capture, incoming_capture):
    """Called only after an exact amount/merchant/provider status query succeeds.

    At expiry, the adapter must query once, lock, re-read hold state, then either
    consume ACTIVE inventory or persist EXPIRED. Wall-clock time alone cannot
    reopen a terminal hold. Capture IDs are globally namespaced provider keys.
    """
    if not isinstance(hold_state, HoldState):
        raise DomainError('INVALID_HOLD_STATE')
    identifier(incoming_capture)
    if applied_capture is not None:
        identifier(applied_capture)
        if applied_capture == incoming_capture:
            return CaptureDisposition.ALREADY_APPLIED
        return CaptureDisposition.DUPLICATE_CAPTURE
    if hold_state == HoldState.CONSUMED:
        raise DomainError('APPLIED_CAPTURE_REQUIRED')
    if hold_state == HoldState.ACTIVE:
        return CaptureDisposition.CONFIRM
    if hold_state == HoldState.EXPIRED:
        return CaptureDisposition.LATE_PAYMENT_AFTER_HOLD
    return CaptureDisposition.REFUND_TERMINAL_BOOKING


@dataclass(frozen=True)
class InventoryInterval:
    starts_at: datetime
    ends_at: datetime
    buffer_minutes: int = 0

    def __post_init__(self):
        timestamp(self.starts_at)
        timestamp(self.ends_at)
        if self.ends_at <= self.starts_at:
            raise DomainError('INVALID_INVENTORY_INTERVAL')
        if type(self.buffer_minutes) is not int or not 0 <= self.buffer_minutes <= 2**31 - 1:
            raise DomainError('INVALID_CLEANING_BUFFER')
        try:
            self.ends_at + timedelta(minutes=self.buffer_minutes)
        except OverflowError as exc:
            raise DomainError('INVALID_INVENTORY_INTERVAL') from exc

    def overlaps(self, other):
        return overlaps(self.starts_at, self.ends_at, other.starts_at, other.ends_at,
                        self.buffer_minutes, other.buffer_minutes)


def unassigned_capacity(candidate, *, eligible_room_intervals, category_reservations):
    """Conservative whole-stay capacity; no early physical-room assignment.

    The adapter supplies ACTIVE/configuration-eligible rooms with canonical
    stay/room-reservation intervals. Unassigned category holds/bookings appear
    only in category_reservations. A consumed reservation must be removed when
    its stay occupancy is added. Dirty alone does not remove future inventory.
    Every overlapping unassigned reservation consumes one unit; this may
    undercount disjoint reservations, but never promises fragmented capacity.
    A repository lock/recheck is mandatory before creating/consuming a hold.
    """
    available = sum(not any(candidate.overlaps(busy) for busy in intervals)
                    for intervals in eligible_room_intervals.values())
    reserved = sum(candidate.overlaps(busy) for busy in category_reservations)
    return max(0, available - reserved)
