"""PAY-DEC-010 pure payout assessment; never performs a provider command."""

from dataclasses import dataclass
from datetime import datetime, time, timedelta
from enum import StrEnum
from zoneinfo import ZoneInfo

from .common import DomainError, money, timestamp

ULAANBAATAR = ZoneInfo("Asia/Ulaanbaatar")


class BookingState(StrEnum):
    CONFIRMED = "CONFIRMED"
    CHECKED_IN = "CHECKED_IN"
    COMPLETED = "COMPLETED"
    CANCELLED_GUEST = "CANCELLED_GUEST"
    CANCELLED_HOTEL = "CANCELLED_HOTEL"
    NO_SHOW = "NO_SHOW"


class Eligibility(StrEnum):
    NOT_ELIGIBLE = "NOT_ELIGIBLE"
    HELD = "HELD"
    ELIGIBLE = "ELIGIBLE"
    NO_PAYABLE = "NO_PAYABLE"


@dataclass(frozen=True)
class RefundObligation:
    due: int
    provider_confirmed: int

    def __post_init__(self) -> None:
        money(self.due)
        money(self.provider_confirmed)
        if self.provider_confirmed > self.due:
            raise DomainError("REFUND_EXCEEDS_OBLIGATION")


@dataclass(frozen=True)
class SettlementFacts:
    booking_state: BookingState
    captured_room_amount: int
    retained_room_amount: int
    room_refund: RefundObligation
    additional_refunds: tuple[RefundObligation, ...] = ()
    chargeback_open: bool = False
    reconciliation_open: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.booking_state, BookingState):
            raise DomainError("INVALID_BOOKING_STATE")
        money(self.captured_room_amount)
        money(self.retained_room_amount)
        if self.retained_room_amount + self.room_refund.due != self.captured_room_amount:
            raise DomainError("ROOM_PAYMENT_NOT_BALANCED")
        if self.booking_state == BookingState.CANCELLED_HOTEL and self.retained_room_amount:
            raise DomainError("HOTEL_CANCELLATION_REQUIRES_FULL_REFUND")


def assess_settlement(facts: SettlementFacts) -> Eligibility:
    if facts.booking_state not in {
        BookingState.COMPLETED, BookingState.CANCELLED_GUEST,
        BookingState.CANCELLED_HOTEL, BookingState.NO_SHOW,
    }:
        return Eligibility.NOT_ELIGIBLE
    if (facts.chargeback_open or facts.reconciliation_open
            or any(r.provider_confirmed != r.due
                   for r in (facts.room_refund, *facts.additional_refunds))):
        return Eligibility.HELD
    if facts.retained_room_amount == 0:
        return Eligibility.NO_PAYABLE
    return Eligibility.ELIGIBLE


def refund_command_amount(refund: RefundObligation) -> int | None:
    """None means no command needed; adapter must deduplicate pending attempts."""
    remaining = refund.due - refund.provider_confirmed
    return remaining or None


def commission_mnt(retained_amount: int, rate_basis_points: int) -> int:
    money(retained_amount)
    if type(rate_basis_points) is not int or not 0 <= rate_basis_points <= 10_000:
        raise DomainError("INVALID_COMMISSION_RATE")
    return (retained_amount * rate_basis_points + 5_000) // 10_000


def payout_batch_at(eligible_at: datetime) -> datetime:
    """D+1 noon from the FIRST persisted eligibility event, never from poll time."""
    timestamp(eligible_at)
    day = eligible_at.astimezone(ULAANBAATAR).date() + timedelta(days=1)
    return datetime.combine(day, time(12), tzinfo=ULAANBAATAR)
