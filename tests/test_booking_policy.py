import unittest
from dataclasses import FrozenInstanceError, replace
from datetime import datetime, time, timedelta, timezone

from prsystem.booking_policy import (
    Contract, PaymentWindow, HoldState, CaptureDisposition, InventoryInterval,
    quote_nights, cancel_confirmed, capture_disposition, unassigned_capacity,
)
from prsystem.common import DomainError, MAX_MNT
from prsystem.settlement import BookingState, Eligibility, assess_settlement, refund_command_amount

UTC = timezone.utc


class BookingPolicyTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 9, 8, tzinfo=UTC)
        self.arrival = datetime(2026, 9, 10, 6, tzinfo=UTC)
        self.contract = Contract('hotel-1', 'contract-1', 2, 375, self.now, self.now + timedelta(days=365))

    def quote(self, **changes):
        values = dict(tenant_id='hotel-1', category_id='standard', now=self.now,
                      arrival=self.arrival, nights=3, category_price=85000,
                      category_version=4, hotel_price=100000, hotel_version=7,
                      checkout_time=time(12), cleaning_buffer_minutes=30,
                      contract=self.contract)
        return quote_nights(**(values | changes))

    def test_nightly_category_snapshot_and_local_calendar(self):
        quote = self.quote()
        self.assertEqual((quote.unit_price, quote.amount_mnt), (85000, 255000))
        self.assertEqual((quote.price_source, quote.price_source_id, quote.price_version), ('CATEGORY', 'standard', 4))
        self.assertEqual(quote.planned_checkout_at.isoformat(), '2026-09-13T12:00:00+08:00')
        self.assertEqual((quote.contract_version, quote.commission_rate_bps), (2, 375))
        with self.assertRaises(FrozenInstanceError):
            quote.amount_mnt = 1

    def test_hotel_fallback_has_its_own_version_not_category_version(self):
        quote = self.quote(category_price=None)
        self.assertEqual((quote.unit_price, quote.price_source, quote.price_source_id, quote.price_version), (100000, 'HOTEL', 'hotel-1', 7))
        with self.assertRaisesRegex(DomainError, 'STAY_SETTINGS_REQUIRED'):
            self.quote(category_price=None, hotel_price=None)

    def test_invalid_override_does_not_silently_fall_back(self):
        for price in (0, -1, 1.5, True):
            with self.subTest(price=price), self.assertRaisesRegex(DomainError, 'INVALID_MNT'):
                self.quote(category_price=price)

    def test_contract_is_explicit_and_interval_is_valid(self):
        with self.assertRaisesRegex(DomainError, 'BOOKING_CONTRACT_REQUIRED'):
            self.quote(contract=None)
        with self.assertRaisesRegex(DomainError, 'INVALID_CONTRACT_INTERVAL'):
            replace(self.contract, valid_until=self.now)

    def test_contract_time_boundary(self):
        contract = replace(self.contract, valid_from=self.now-timedelta(days=1), valid_until=self.now)
        with self.assertRaisesRegex(DomainError, 'BOOKING_CONTRACT_REQUIRED'):
            self.quote(contract=contract)
        self.quote(contract=replace(contract, valid_until=self.now+timedelta(microseconds=1)))
        with self.assertRaisesRegex(DomainError, 'BOOKING_CONTRACT_REQUIRED'):
            self.quote(contract=replace(self.contract, valid_from=self.now+timedelta(microseconds=1)))

    def test_another_hotels_contract_cannot_authorize_a_quote(self):
        with self.assertRaisesRegex(DomainError, 'TENANT_MISMATCH'):
            self.quote(contract=replace(self.contract, tenant_id='another-hotel'))

    def test_invalid_commission_and_version_rejected(self):
        for rate in (None, -1, 10001, 0.5, True):
            with self.subTest(rate=rate), self.assertRaisesRegex(DomainError, 'INVALID_COMMISSION_RATE'):
                replace(self.contract, rate_bps=rate)
        with self.assertRaisesRegex(DomainError, 'INVALID_CONFIG_VERSION'):
            self.quote(category_version=True)
        self.assertEqual(self.quote(contract=replace(self.contract, rate_bps=0)).commission_rate_bps, 0)

    def test_past_naive_arrival_and_non_integer_nights_rejected(self):
        for arrival in (self.now-timedelta(microseconds=1), self.arrival.replace(tzinfo=None)):
            with self.subTest(arrival=arrival), self.assertRaises(DomainError):
                self.quote(arrival=arrival)
        for nights in (0, -1, 1.5, True):
            with self.subTest(nights=nights), self.assertRaisesRegex(DomainError, 'INVALID_STAY_DURATION'):
                self.quote(nights=nights)

    def test_year_boundary_and_early_arrival_still_end_next_day(self):
        quote = self.quote(arrival=datetime(2026, 12, 31, 16, 30, tzinfo=UTC), nights=1)
        self.assertEqual(quote.planned_checkout_at.isoformat(), '2027-01-02T12:00:00+08:00')
        self.assertEqual(quote.no_show_cutoff.isoformat(), '2027-01-01T23:59:59+08:00')

    def test_money_date_buffer_and_checkout_overflow_fail_closed(self):
        for changes in (dict(category_price=MAX_MNT), dict(nights=10**20),
                        dict(cleaning_buffer_minutes=-1), dict(checkout_time=time(12,0,1)),
                        dict(checkout_time=time(12,tzinfo=UTC))):
            with self.subTest(changes=changes), self.assertRaises(DomainError):
                self.quote(**changes)

    def cancel(self, quote=None, **changes):
        return cancel_confirmed(quote or self.quote(), **(dict(current_state=BookingState.CONFIRMED,
            outcome=BookingState.CANCELLED_GUEST, now=self.arrival-timedelta(hours=24)) | changes))

    def test_exact_free_cancellation_deadline_and_one_microsecond_after(self):
        free = self.cancel()
        self.assertEqual((free.settlement.room_refund.due, free.hotel_payable_mnt), (255000, 0))
        late = self.cancel(now=self.arrival-timedelta(hours=24)+timedelta(microseconds=1))
        self.assertEqual((late.settlement.retained_room_amount, late.settlement.room_refund.due), (85000, 170000))
        self.assertEqual((late.commission_mnt, late.hotel_payable_mnt), (3188, 81812))
        self.assertEqual(assess_settlement(late.settlement), Eligibility.HELD)

    def test_one_night_no_show_needs_no_zero_refund_command(self):
        quote = self.quote(nights=1)
        with self.assertRaisesRegex(DomainError, 'NO_SHOW_CUTOFF_NOT_PASSED'):
            self.cancel(quote, outcome=BookingState.NO_SHOW, now=quote.no_show_cutoff)
        result = self.cancel(quote, outcome=BookingState.NO_SHOW, now=quote.no_show_cutoff+timedelta(microseconds=1))
        self.assertIsNone(refund_command_amount(result.settlement.room_refund))
        self.assertEqual(assess_settlement(result.settlement), Eligibility.ELIGIBLE)

    def test_hotel_cancellation_always_full_refund_no_commission(self):
        result = self.cancel(outcome=BookingState.CANCELLED_HOTEL, now=self.arrival+timedelta(days=1))
        self.assertEqual(result.settlement.room_refund.due, 255000)
        self.assertEqual((result.commission_mnt, result.hotel_payable_mnt), (0, 0))

    def test_cannot_cancel_checked_in_or_terminal_booking(self):
        for state in (BookingState.CHECKED_IN, BookingState.COMPLETED, BookingState.NO_SHOW):
            with self.subTest(state=state), self.assertRaisesRegex(DomainError, 'BOOKING_NOT_CONFIRMED'):
                self.cancel(current_state=state)
        with self.assertRaisesRegex(DomainError, 'INVALID_BOOKING_TRANSITION'):
            self.cancel(outcome=BookingState.COMPLETED)

    def test_tariff_and_contract_edits_do_not_reprice_original_cancellation(self):
        original = self.quote()
        changed = self.quote(category_price=200000, contract=replace(self.contract, rate_bps=1000, version=3))
        old = self.cancel(original, now=self.arrival)
        new = self.cancel(changed, now=self.arrival)
        self.assertEqual((old.commission_mnt, new.commission_mnt), (3188, 20000))
        self.assertEqual(original.amount_mnt, 255000)

    def test_provider_switch_reuses_original_hold_deadline(self):
        window = PaymentWindow.open(self.now)
        self.assertEqual(window.invoice_deadline(self.now+timedelta(minutes=9)), self.now+timedelta(minutes=10))
        self.assertFalse(window.expiry_due(window.expires_at-timedelta(microseconds=1)))
        self.assertTrue(window.expiry_due(window.expires_at))
        with self.assertRaisesRegex(DomainError, 'HOLD_EXPIRED'):
            window.invoice_deadline(window.expires_at)

    def test_invalid_payment_window_and_time_rejected(self):
        with self.assertRaisesRegex(DomainError, 'INVALID_HOLD_WINDOW'):
            PaymentWindow(self.now, self.now+timedelta(minutes=11))
        with self.assertRaisesRegex(DomainError, 'INVALID_BOOKING_TIME'):
            PaymentWindow.open(self.now).expiry_due(self.now-timedelta(seconds=1))
        with self.assertRaisesRegex(DomainError, 'INVALID_BOOKING_TIME'):
            PaymentWindow.open(datetime.max.replace(tzinfo=UTC))

    def disposition(self, state, applied=None, incoming='QPAY:merchant:payment-1'):
        return capture_disposition(hold_state=state, applied_capture=applied, incoming_capture=incoming)

    def test_verified_payment_cannot_reopen_expired_or_cancelled_hold(self):
        self.assertEqual(self.disposition(HoldState.ACTIVE), CaptureDisposition.CONFIRM)
        self.assertEqual(self.disposition(HoldState.EXPIRED), CaptureDisposition.LATE_PAYMENT_AFTER_HOLD)
        self.assertEqual(self.disposition(HoldState.CANCELLED), CaptureDisposition.REFUND_TERMINAL_BOOKING)

    def test_replayed_capture_and_second_capture_have_different_dispositions(self):
        for state in HoldState:
            self.assertEqual(self.disposition(state, 'QPAY:merchant:payment-1'), CaptureDisposition.ALREADY_APPLIED)
            self.assertEqual(self.disposition(state, 'KHAAN:merchant:payment-2'), CaptureDisposition.DUPLICATE_CAPTURE)
        with self.assertRaisesRegex(DomainError, 'APPLIED_CAPTURE_REQUIRED'):
            self.disposition(HoldState.CONSUMED)

    def test_half_open_room_interval_and_own_cleaning_buffer(self):
        before = InventoryInterval(self.arrival-timedelta(days=1), self.arrival, 30)
        adjacent = InventoryInterval(self.arrival+timedelta(minutes=30), self.arrival+timedelta(days=1))
        self.assertFalse(before.overlaps(adjacent))
        self.assertTrue(before.overlaps(replace(adjacent, starts_at=adjacent.starts_at-timedelta(microseconds=1))))

    def test_inventory_does_not_combine_fragments_from_different_rooms(self):
        candidate = InventoryInterval(self.arrival, self.arrival+timedelta(days=2))
        first = InventoryInterval(self.arrival, self.arrival+timedelta(days=1))
        second = InventoryInterval(first.ends_at, candidate.ends_at)
        self.assertEqual(unassigned_capacity(candidate, eligible_room_intervals={'a': [first], 'b': [second]}, category_reservations=[]), 0)

    def test_unassigned_claims_consume_category_capacity_without_room_assignment(self):
        candidate = InventoryInterval(self.arrival, self.arrival+timedelta(days=1))
        rooms = {'a': [], 'b': []}
        for claims, expected in (([], 2), ([candidate], 1), ([candidate, candidate], 0), ([candidate]*3, 0)):
            self.assertEqual(unassigned_capacity(candidate, eligible_room_intervals=rooms, category_reservations=claims), expected)

    def test_category_reservation_to_stay_does_not_double_count(self):
        candidate = InventoryInterval(self.arrival, self.arrival+timedelta(days=1))
        before = unassigned_capacity(candidate, eligible_room_intervals={'a': [], 'b': []}, category_reservations=[candidate])
        after = unassigned_capacity(candidate, eligible_room_intervals={'a': [candidate], 'b': []}, category_reservations=[])
        self.assertEqual((before, after), (1, 1))

    def test_invalid_inventory_interval_rejected(self):
        for end, buffer in ((self.arrival, 0), (self.arrival-timedelta(seconds=1), 0), (self.arrival+timedelta(days=1), True)):
            with self.subTest(end=end, buffer=buffer), self.assertRaises(DomainError):
                InventoryInterval(self.arrival, end, buffer)
