import unittest
from dataclasses import replace
from datetime import datetime, timezone

from prsystem.common import DomainError
from prsystem.settlement import (
    BookingState, Eligibility, RefundObligation, SettlementFacts,
    assess_settlement, commission_mnt, payout_batch_at, refund_command_amount,
)


class SettlementTests(unittest.TestCase):
    def setUp(self):
        self.one_night = SettlementFacts(BookingState.NO_SHOW, 100_000, 100_000,
                                         RefundObligation(0, 0))

    def test_one_night_no_show_and_late_cancellation_need_no_refund(self):
        for state in [BookingState.NO_SHOW, BookingState.CANCELLED_GUEST]:
            with self.subTest(state=state):
                facts = replace(self.one_night, booking_state=state)
                self.assertEqual(assess_settlement(facts), Eligibility.ELIGIBLE)
                self.assertIsNone(refund_command_amount(facts.room_refund))

    def test_multiple_nights_wait_for_confirmed_refund(self):
        facts = replace(self.one_night, captured_room_amount=300_000,
                        room_refund=RefundObligation(200_000, 0))
        self.assertEqual(assess_settlement(facts), Eligibility.HELD)
        self.assertEqual(assess_settlement(replace(facts, room_refund=RefundObligation(200_000, 100_000))), Eligibility.HELD)
        paid = replace(facts, room_refund=RefundObligation(200_000, 200_000))
        self.assertEqual(assess_settlement(paid), Eligibility.ELIGIBLE)

    def test_zero_refund_does_not_bypass_other_holds(self):
        for facts in [replace(self.one_night, chargeback_open=True),
                      replace(self.one_night, reconciliation_open=True),
                      replace(self.one_night, additional_refunds=(RefundObligation(100_000, 0),))]:
            with self.subTest(facts=facts):
                self.assertEqual(assess_settlement(facts), Eligibility.HELD)

    def test_no_payout_for_non_terminal_booking_or_full_refund(self):
        for state in [BookingState.CONFIRMED, BookingState.CHECKED_IN]:
            self.assertEqual(assess_settlement(replace(self.one_night, booking_state=state)), Eligibility.NOT_ELIGIBLE)
        facts = SettlementFacts(BookingState.CANCELLED_HOTEL, 100_000, 0,
                                RefundObligation(100_000, 100_000))
        self.assertEqual(assess_settlement(facts), Eligibility.NO_PAYABLE)
        self.assertEqual(commission_mnt(facts.retained_room_amount, 500), 0)

    def test_corrupt_financial_facts_rejected(self):
        with self.assertRaisesRegex(DomainError, "ROOM_PAYMENT_NOT_BALANCED"):
            replace(self.one_night, retained_room_amount=90_000)
        with self.assertRaisesRegex(DomainError, "HOTEL_CANCELLATION_REQUIRES_FULL_REFUND"):
            replace(self.one_night, booking_state=BookingState.CANCELLED_HOTEL)
        with self.assertRaisesRegex(DomainError, "REFUND_EXCEEDS_OBLIGATION"):
            RefundObligation(0, 1)
        with self.assertRaisesRegex(DomainError, "INVALID_MNT"):
            RefundObligation(-1, 0)

    def test_half_up_integer_commission(self):
        self.assertEqual(commission_mnt(100_000, 500), 5_000)
        self.assertEqual(commission_mnt(1, 5_000), 1)
        self.assertEqual(commission_mnt(1, 4_999), 0)
        for rate in [-1, 10_001, 0.5, True]:
            with self.assertRaisesRegex(DomainError, "INVALID_COMMISSION_RATE"):
                commission_mnt(100, rate)

    def test_batch_uses_eligibility_local_date_at_midnight_and_year_boundary(self):
        for utc, local_date in [("2026-09-06T15:59:59+00:00", "2026-09-07"),
                                ("2026-09-06T16:00:00+00:00", "2026-09-08"),
                                ("2026-12-31T16:00:00+00:00", "2027-01-02")]:
            with self.subTest(utc=utc):
                result = payout_batch_at(datetime.fromisoformat(utc))
                self.assertEqual(result.isoformat(), local_date + "T12:00:00+08:00")
        with self.assertRaisesRegex(DomainError, "TIMEZONE_REQUIRED"):
            payout_batch_at(datetime(2026, 9, 6))

    def test_completed_stay_with_resolved_duplicate_capture_is_eligible(self):
        facts = replace(self.one_night, booking_state=BookingState.COMPLETED,
                        additional_refunds=(RefundObligation(100_000, 100_000),))
        self.assertEqual(assess_settlement(facts), Eligibility.ELIGIBLE)
