"""Independent contract examples for restaurant rules; no provider credentials."""
import unittest
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone

from prsystem.common import DomainError, MAX_MNT
from prsystem.restaurant_policy import Order, ZONE, invoice_expiry, opening_window, quote_items

NOW = datetime(2026, 9, 14, 12, tzinfo=ZONE)  # Monday


class RestaurantPolicyTests(unittest.TestCase):
    def order(self):
        return Order('invoice', 'merchant', 12000, NOW, NOW + timedelta(minutes=15))

    def paid(self, now=NOW, eligible=True, **extra):
        values = dict(merchant_id='merchant', invoice_id='invoice', amount_mnt=12000,
                      currency='MNT', payment_id='capture', eligible=eligible)
        values.update(extra)
        return self.order().capture(now, **values)

    def result(self, order, now, **extra):
        values = dict(attempt_id=order.refund_attempt_id, merchant_id='merchant', invoice_id='invoice',
                      amount_mnt=12000, currency='MNT', succeeded=True, provider_id='refund')
        values.update(extra)
        return order.refund_result(now, **values)

    def hours(self, opens='09:00', closes='18:00'):
        return [dict(day=d, closed=False, opens=opens, closes=closes) for d in range(7)]

    def test_invoice_ends_at_closing_and_exact_boundary_is_closed(self):
        now = NOW.replace(hour=17, minute=55)
        self.assertEqual(invoice_expiry(self.hours(), [], now), NOW.replace(hour=18))
        self.assertIsNone(opening_window(self.hours(), [], NOW.replace(hour=18)))
        self.assertEqual(invoice_expiry(self.hours(), [], NOW), NOW + timedelta(minutes=15))

    def test_overnight_previous_weekday_and_timezone(self):
        hours = self.hours('18:00', '02:00')
        hours[0]['closed'] = True
        monday = NOW.replace(hour=1)
        self.assertEqual(opening_window(hours, [], monday)[1], monday.replace(hour=2))
        self.assertEqual(opening_window(hours, [], monday.astimezone(timezone.utc))[1], monday.replace(hour=2))
        self.assertIsNone(opening_window(hours, [], NOW.replace(hour=20)))

    def test_special_closure_cuts_overnight_and_prevents_previous_day_leak(self):
        hours = self.hours('18:00', '02:00')
        sunday = NOW - timedelta(days=1)
        sunday = sunday.replace(hour=23, minute=55)
        self.assertEqual(invoice_expiry(hours, [NOW.date()], sunday), NOW.replace(hour=0))
        self.assertIsNone(opening_window(hours, [NOW.date()], NOW.replace(hour=1)))
        self.assertIsNone(opening_window(hours, [sunday.date()], NOW.replace(hour=1)))

    def test_schedule_validation(self):
        cases = [[], self.hours('09:00', '09:00'), self.hours('9:00', '18:00'), self.hours('99:00', '18:00')]
        duplicate = self.hours(); duplicate[0]['day'] = 1; cases.append(duplicate)
        boolean = self.hours(); boolean[0]['day'] = True; cases.append(boolean)
        for hours in cases:
            with self.subTest(hours=hours), self.assertRaises(DomainError):
                opening_window(hours, [], NOW)
        with self.assertRaisesRegex(DomainError, 'CLOSURES'):
            opening_window(self.hours(), ['2026-09-14'], NOW)
        with self.assertRaisesRegex(DomainError, 'TIMEZONE'):
            opening_window(self.hours(), [], NOW.replace(tzinfo=None))

    def test_cart_snapshots_only_authoritative_prices(self):
        catalog = {'a': dict(name='Soup', price_mnt=4000, active=True, available=True)}
        lines, total = quote_items(catalog, {'a': 3})
        catalog['a']['price_mnt'] = 100
        self.assertEqual(total, 12000)
        self.assertEqual(lines[0], dict(item_id='a', name='Soup', unit_price_mnt=4000, quantity=3, amount_mnt=12000))

    def test_cart_rejects_unavailable_boolean_and_overflow(self):
        item = dict(name='Soup', price_mnt=4000, active=True, available=True)
        for qty in (True, 0, -1, 101, '1'):
            with self.subTest(qty=qty), self.assertRaises(DomainError):
                quote_items({'a': item}, {'a': qty})
        for catalog in ({}, {'a': dict(item, available=False)}, {'a': dict(item, active=False)}):
            with self.assertRaisesRegex(DomainError, 'UNAVAILABLE'):
                quote_items(catalog, {'a': 1})
        with self.assertRaisesRegex(DomainError, 'INVALID_MNT'):
            quote_items({'a': dict(item, price_mnt=MAX_MNT)}, {'a': 2})

    def test_payment_rejects_each_mismatched_authority_field(self):
        for field, value in [('merchant_id', 'other'), ('invoice_id', 'other'), ('amount_mnt', 11999), ('currency', 'USD')]:
            with self.subTest(field=field), self.assertRaisesRegex(DomainError, 'PAYMENT_MISMATCH'):
                self.paid(**{field: value})

    def test_capture_replay_retains_progress_and_second_capture_is_not_hidden(self):
        paid = self.paid().accept(NOW, 15)
        replay = paid.capture(NOW, merchant_id='merchant', invoice_id='invoice', amount_mnt=12000,
                              currency='MNT', payment_id='capture', eligible=False)
        self.assertEqual(replay, paid)
        with self.assertRaisesRegex(DomainError, 'DUPLICATE_CAPTURE'):
            paid.capture(NOW, merchant_id='merchant', invoice_id='invoice', amount_mnt=12000,
                         currency='MNT', payment_id='second', eligible=True)

    def test_exact_expiry_capture_mandatory_without_prior_expiry_job(self):
        now = NOW + timedelta(minutes=15)
        paid = self.paid(now)
        self.assertEqual((paid.order, paid.fulfillment, paid.payment, paid.refund_policy, paid.refund_request, paid.refund),
                         ('CANCELLED', 'CANCELLED', 'PAID', 'MANDATORY', 'APPROVED', 'NONE'))
        self.assertEqual(paid.refund_reason, 'PAID_AFTER_INVOICE_EXPIRY')
        with self.assertRaises(DomainError):
            paid.accept(now, 15)

    def test_inactivation_late_capture_never_reopens_order(self):
        cancelled = self.order().expire(NOW, inactive=True)
        paid = cancelled.capture(NOW, merchant_id='merchant', invoice_id='invoice', amount_mnt=12000,
                                 currency='MNT', payment_id='capture', eligible=True)
        self.assertEqual((paid.order, paid.refund_request), ('CANCELLED', 'APPROVED'))
        self.assertEqual(self.paid(eligible=False).refund_policy, 'MANDATORY')

    def test_new_closure_after_invoice_requires_refund(self):
        paid=self.paid(within_hours=False)
        self.assertEqual((paid.order,paid.refund_reason),('CANCELLED','PAID_AFTER_INVOICE_EXPIRY'))

    def test_paid_order_survives_expiry_and_inactivation(self):
        paid = self.paid()
        self.assertEqual(paid.expire(NOW + timedelta(hours=3), inactive=True), paid)
        with self.assertRaisesRegex(DomainError, 'NOT_EXPIRED'):
            self.order().expire(NOW)

    def test_unpaid_cannot_accept_and_eta_is_fixed_selection(self):
        with self.assertRaises(DomainError):
            self.order().accept(NOW, 15)
        for eta in (True, 0, 16, 90, '15'):
            with self.subTest(eta=eta), self.assertRaisesRegex(DomainError, 'INVALID_RESTAURANT_ETA'):
                self.paid().accept(NOW, eta)
        for eta in (15, 30, 45, 60):
            self.assertEqual(self.paid().accept(NOW, eta).promised_ready_at, NOW + timedelta(minutes=eta))

    def test_acceptance_sla_is_warning_only(self):
        paid = self.paid()
        for minute, warning, reception in [(4, False, False), (5, True, False), (9, True, False), (10, True, True), (100, True, True)]:
            alerts = paid.alerts(NOW + timedelta(minutes=minute))
            self.assertEqual((alerts['acceptance_warning'], alerts['acceptance_reception']), (warning, reception))
        self.assertEqual((paid.order, paid.refund), ('CONFIRMED', 'NONE'))

    def test_refund_wins_acceptance_race(self):
        now = NOW + timedelta(minutes=10)
        with self.assertRaisesRegex(DomainError, 'NOT_AVAILABLE'):
            self.paid().request_refund(now - timedelta(microseconds=1))
        cancelled = self.paid().request_refund(now)
        self.assertEqual((cancelled.refund_policy, cancelled.refund_request), ('MANDATORY', 'APPROVED'))
        with self.assertRaises(DomainError):
            cancelled.accept(now, 15)
        with self.assertRaises(DomainError):
            cancelled.decide_refund(now, False, 'PREPARATION_STARTED')

    def test_acceptance_wins_race_and_checkout_request_is_discretionary(self):
        now = NOW + timedelta(minutes=10)
        accepted = self.paid().accept(now, 15)
        requested = accepted.request_refund(now, checkout=True)
        self.assertEqual((requested.refund_policy, requested.refund_request, requested.fulfillment),
                         ('DISCRETIONARY', 'OPEN', 'ACCEPTED'))
        self.assertEqual(requested.fulfill(now, 'PREPARING').fulfillment, 'PREPARING')

    def test_eta_refund_exact_boundary(self):
        accepted = self.paid().accept(NOW, 15)
        self.assertTrue(accepted.alerts(NOW + timedelta(minutes=15))['eta_warning'])
        self.assertFalse(accepted.alerts(NOW + timedelta(minutes=29))['eta_refund_available'])
        with self.assertRaisesRegex(DomainError, 'NOT_AVAILABLE'):
            accepted.request_refund(NOW + timedelta(minutes=30) - timedelta(microseconds=1))
        self.assertEqual(accepted.request_refund(NOW + timedelta(minutes=30)).refund_policy, 'DISCRETIONARY')

    def test_discretionary_rejection_requires_predefined_reason(self):
        now = NOW + timedelta(minutes=30)
        requested = self.paid().accept(NOW, 15).request_refund(now)
        with self.assertRaisesRegex(DomainError, 'REASON_REQUIRED'):
            requested.decide_refund(now, False, 'anything')
        rejected = requested.decide_refund(now, False, 'PREPARATION_STARTED')
        self.assertEqual((rejected.order, rejected.fulfillment, rejected.refund_request), ('CONFIRMED', 'ACCEPTED', 'REJECTED'))
        self.assertFalse(rejected.alerts(now + timedelta(hours=1))['link_paused'])

    def test_approved_discretionary_cancels_unfinished(self):
        now = NOW + timedelta(minutes=30)
        approved = self.paid().accept(NOW, 15).request_refund(now).decide_refund(now, True)
        self.assertEqual((approved.order, approved.fulfillment, approved.refund_policy, approved.refund),
                         ('CANCELLED', 'CANCELLED', 'DISCRETIONARY', 'NONE'))

    def test_delivery_evidence_survives_approval(self):
        now = NOW + timedelta(minutes=30)
        order = self.paid().accept(NOW, 15).request_refund(now)
        for state in ('PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED_TO_ROOM'):
            order = order.fulfill(now, state)
        approved = order.decide_refund(now, True)
        self.assertEqual((approved.order, approved.fulfillment), ('COMPLETED', 'DELIVERED_TO_ROOM'))

    def test_checkout_choice_requires_informed_guest_and_correct_delivery(self):
        order = self.paid().accept(NOW, 15)
        with self.assertRaisesRegex(DomainError, 'HANDOFF_REQUIRED'):
            order.checkout_handoff(NOW, 'RECEPTION', False)
        order = order.checkout_handoff(NOW, 'GUEST_PICKUP', True)
        order = order.fulfill(NOW, 'PREPARING').fulfill(NOW, 'READY')
        with self.assertRaisesRegex(DomainError, 'HANDOFF_CONFLICT'):
            order.fulfill(NOW, 'HANDED_TO_RECEPTION')
        self.assertEqual(order.fulfill(NOW, 'PICKED_UP_BY_GUEST').order, 'COMPLETED')

    def test_fulfillment_cannot_skip_or_reopen(self):
        with self.assertRaises(DomainError):
            self.paid().fulfill(NOW, 'READY')
        order = self.paid().accept(NOW, 15).cannot_fulfill(NOW)
        self.assertEqual(order.refund_policy, 'MANDATORY')
        with self.assertRaises(DomainError):
            order.fulfill(NOW, 'PREPARING')

    def test_refund_sla_requires_provider_resolution(self):
        now = NOW + timedelta(minutes=10)
        order = self.paid().request_refund(now)
        for minute, reminder, escalation, paused in [(4, False, False, False), (5, True, False, False), (10, True, True, False), (30, True, True, True)]:
            alerts = order.alerts(now + timedelta(minutes=minute))
            self.assertEqual((alerts['refund_reminder'], alerts['refund_escalation'], alerts['link_paused']), (reminder, escalation, paused))
        later = now + timedelta(minutes=30)
        pending = order.begin_refund(later, 'attempt1')
        failed = self.result(pending, later, succeeded=False)
        self.assertEqual((failed.refund, failed.refund_request, failed.payment), ('FAILED', 'APPROVED', 'PAID'))
        self.assertTrue(failed.alerts(later)['link_paused'])
        with self.assertRaisesRegex(DomainError, 'ATTEMPT_CHANGED'):
            failed.begin_refund(later, 'attempt2')
        retried = failed.begin_refund(later, 'attempt1')
        resolved = self.result(retried, later)
        self.assertEqual((resolved.refund, resolved.refund_request, resolved.payment), ('REFUNDED', 'RESOLVED', 'PAID'))
        self.assertFalse(resolved.alerts(later)['link_paused'])
        self.assertEqual(self.result(resolved, later), resolved)

    def test_stale_and_mismatched_refund_results_rejected(self):
        now = NOW + timedelta(minutes=10)
        pending = self.paid().request_refund(now).begin_refund(now, 'attempt')
        for field, value in [('attempt_id', 'old'), ('merchant_id', 'other'), ('invoice_id', 'other'),
                             ('amount_mnt', 11999), ('currency', 'USD'), ('succeeded', 1)]:
            with self.subTest(field=field), self.assertRaisesRegex(DomainError, 'REFUND_MISMATCH'):
                self.result(pending, now, **{field: value})

    def test_server_time_cannot_precede_recorded_event(self):
        accepted = self.paid().accept(NOW + timedelta(minutes=10), 15)
        with self.assertRaisesRegex(DomainError, 'CLOCK_CONFLICT'):
            accepted.fulfill(NOW, 'PREPARING')


if __name__ == '__main__':
    unittest.main()
