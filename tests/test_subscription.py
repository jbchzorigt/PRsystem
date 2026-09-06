import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone

from prsystem.subscription import (
    AccessFacts, Action, Obligation, RootKind, subscription_gate,
)


class SubscriptionTests(unittest.TestCase):
    def setUp(self):
        self.expiry = datetime(2026, 9, 1, tzinfo=timezone.utc)
        self.lock = self.expiry + timedelta(hours=48)
        self.facts = AccessFacts("hotel-a", True, True, True, True, True, True, True)
        self.stay = Obligation("hotel-a", "stay-1", RootKind.STAY,
                               self.lock - timedelta(seconds=1), True)

    def decision(self, action=Action.CHECKOUT, **kw):
        return subscription_gate(action, kw.get("facts", self.facts), self.expiry,
                                 kw.get("now", self.lock), kw.get("root", self.stay))

    def test_grace_exclusive_boundary(self):
        self.assertTrue(self.decision(Action.CHECK_IN, now=self.lock-timedelta(microseconds=1)).allowed)
        self.assertFalse(self.decision(Action.CHECK_IN).allowed)

    def test_new_work_is_denied_even_with_old_root(self):
        for action in [Action.CHECK_IN, Action.BOOKING_CREATE, Action.ORDER_CREATE,
                       Action.CONFIGURE, Action.EXPORT]:
            with self.subTest(action=action):
                self.assertEqual(self.decision(action).code, "SUBSCRIPTION_EXPIRED")

    def test_existing_stay_completion_and_child_work_allowed(self):
        for action in [Action.CHECKOUT, Action.SETTLE_STAY, Action.CHECKOUT_REPORT,
                       Action.DISPUTE_RESOLVE, Action.REFUND, Action.DETAIL]:
            with self.subTest(action=action):
                self.assertTrue(self.decision(action, now=self.lock+timedelta(days=10)).allowed)

    def test_missing_ineligible_boundary_and_future_roots_fail(self):
        for root in [None, replace(self.stay, eligible_at_lock=False),
                     replace(self.stay, recorded_started_at=self.lock),
                     replace(self.stay, recorded_started_at=self.lock+timedelta(seconds=1))]:
            with self.subTest(root=root):
                self.assertFalse(self.decision(root=root).allowed)

    def test_wrong_root_cannot_unlock_action(self):
        self.assertFalse(self.decision(Action.ORDER_COMPLETE).allowed)
        order = replace(self.stay, kind=RootKind.ORDER)
        self.assertTrue(self.decision(Action.ORDER_COMPLETE, root=order).allowed)
        self.assertFalse(self.decision(root=order).allowed)

    def test_security_role_entitlement_state_and_scope_still_apply(self):
        for field in ["authenticated", "account_active", "membership_active",
                      "permission_granted", "package_granted", "resource_scope_granted",
                      "resource_state_granted"]:
            with self.subTest(field=field):
                self.assertFalse(self.decision(facts=replace(self.facts, **{field: False})).allowed)
        self.assertFalse(self.decision(facts=replace(self.facts, tenant_security_suspended=True)).allowed)

    def test_cross_tenant_fails_even_during_grace(self):
        other = replace(self.stay, tenant_id="hotel-b")
        self.assertEqual(self.decision(root=other).code, "TENANT_MISMATCH")
        self.assertFalse(self.decision(root=other, now=self.lock-timedelta(microseconds=1)).allowed)

    def test_renewal_requires_authorized_actor_but_not_package(self):
        self.assertTrue(self.decision(Action.RENEW, facts=replace(self.facts, package_granted=False)).allowed)
        self.assertFalse(self.decision(Action.RENEW, facts=replace(self.facts, permission_granted=False)).allowed)
        # OPS security suspension permits renewal, without restoring operations.
        suspended = replace(self.facts, tenant_security_suspended=True)
        self.assertTrue(self.decision(Action.RENEW, facts=suspended).allowed)
        self.assertFalse(self.decision(facts=suspended).allowed)

    def test_system_reconciliation_needs_authenticated_service_and_old_intent(self):
        service = replace(self.facts, system_actor=True)
        intent = replace(self.stay, kind=RootKind.PAYMENT)
        self.assertTrue(self.decision(Action.RECONCILE, facts=service, root=intent).allowed)
        self.assertFalse(self.decision(Action.RECONCILE, root=intent).allowed)
        self.assertFalse(self.decision(Action.RECONCILE, facts=service, root=None).allowed)
        self.assertFalse(self.decision(Action.CHECKOUT, facts=service).allowed)

    def test_unknown_action_fails_closed_and_logout_survives_revocation(self):
        self.assertFalse(self.decision("stay.checkout").allowed)
        self.assertTrue(self.decision(Action.LOGOUT, facts=replace(self.facts, account_active=False)).allowed)

    def test_naive_time_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "TIMEZONE_REQUIRED"):
            self.decision(now=datetime(2026, 9, 3))
