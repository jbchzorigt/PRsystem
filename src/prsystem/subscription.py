"""LIFE-DEC-008: narrow subscription gate, AFTER authentication/authorization.

All facts must be loaded by a trusted application adapter, never from HTTP
request fields. This module neither authenticates users nor grants roles.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum

from .common import identifier, timestamp


class Action(StrEnum):
    RENEW = "subscription.renew"
    HELP = "help"
    LOGOUT = "logout"
    BOOKING_CREATE = "booking.create"
    CHECK_IN = "stay.check_in"
    ORDER_CREATE = "restaurant.order_create"
    CONFIGURE = "configuration.update"
    EXPORT = "report.export"
    DETAIL = "obligation.detail"
    CHECKOUT = "stay.checkout"
    SETTLE_STAY = "stay.settle"
    CHECKOUT_REPORT = "stay.checkout_report"
    DISPUTE_RESOLVE = "stay.dispute_resolve"
    ORDER_COMPLETE = "restaurant.order_complete"
    REFUND = "payment.refund"
    TRANSFER_FINISH = "cash.transfer_finish"
    SHIFT_CLOSE = "cash.shift_close"
    RECONCILE = "system.reconcile"


class RootKind(StrEnum):
    STAY = "checked_in_stay"
    ORDER = "paid_order"
    SHIFT = "open_shift"
    TRANSFER = "pending_transfer"
    PAYMENT = "payment_intent"


COMPLETION_ROOTS = {
    Action.DETAIL: frozenset(RootKind),
    Action.CHECKOUT: frozenset({RootKind.STAY}),
    Action.SETTLE_STAY: frozenset({RootKind.STAY}),
    Action.CHECKOUT_REPORT: frozenset({RootKind.STAY}),
    Action.DISPUTE_RESOLVE: frozenset({RootKind.STAY}),
    Action.ORDER_COMPLETE: frozenset({RootKind.ORDER}),
    Action.REFUND: frozenset({RootKind.STAY, RootKind.ORDER, RootKind.PAYMENT}),
    Action.TRANSFER_FINISH: frozenset({RootKind.TRANSFER}),
    Action.SHIFT_CLOSE: frozenset({RootKind.SHIFT}),
    Action.RECONCILE: frozenset({RootKind.STAY, RootKind.ORDER, RootKind.PAYMENT,
                               RootKind.TRANSFER, RootKind.SHIFT}),
}


@dataclass(frozen=True)
class AccessFacts:
    tenant_id: str
    authenticated: bool
    account_active: bool
    membership_active: bool
    permission_granted: bool
    package_granted: bool
    resource_scope_granted: bool
    resource_state_granted: bool
    tenant_security_suspended: bool = False
    system_actor: bool = False


@dataclass(frozen=True)
class Obligation:
    tenant_id: str
    root_id: str
    kind: RootKind
    recorded_started_at: datetime
    eligible_at_lock: bool


@dataclass(frozen=True)
class AccessDecision:
    allowed: bool
    code: str


def subscription_gate(
    action: Action, facts: AccessFacts, expires_at: datetime,
    now: datetime, obligation: Obligation | None = None,
) -> AccessDecision:
    """Return a deny-by-default decision, with an exclusive lock boundary."""
    timestamp(now)
    timestamp(expires_at)
    identifier(facts.tenant_id)
    if not isinstance(action, Action):
        return AccessDecision(False, "UNKNOWN_ACTION")
    if not facts.authenticated:
        return AccessDecision(False, "UNAUTHENTICATED")
    # Logout must remain possible for a revoked/expired account/session.
    if action == Action.LOGOUT:
        return AccessDecision(True, "LOGOUT")
    if not facts.account_active or not facts.membership_active:
        return AccessDecision(False, "SECURITY_SUSPENDED")
    if not (facts.permission_granted and facts.resource_scope_granted
            and facts.resource_state_granted):
        return AccessDecision(False, "FORBIDDEN")
    if obligation is not None:
        identifier(obligation.root_id)
        timestamp(obligation.recorded_started_at)
        if obligation.tenant_id != facts.tenant_id:
            return AccessDecision(False, "TENANT_MISMATCH")
        if obligation.recorded_started_at > now:
            return AccessDecision(False, "INVALID_OBLIGATION_TIME")
    if action in {Action.RENEW, Action.HELP}:
        return AccessDecision(True, "ACCOUNT_SERVICE")
    if facts.tenant_security_suspended:
        return AccessDecision(False, "SECURITY_SUSPENDED")
    if action == Action.RECONCILE:
        if not facts.system_actor or obligation is None:
            return AccessDecision(False, "SYSTEM_OBLIGATION_REQUIRED")
    elif facts.system_actor:
        return AccessDecision(False, "SYSTEM_ACTION_FORBIDDEN")
    if not facts.package_granted:
        return AccessDecision(False, "PACKAGE_REQUIRED")
    locked_at = expires_at + timedelta(hours=48)
    if now < locked_at:
        return AccessDecision(True, "SUBSCRIPTION_ACTIVE_OR_GRACE")
    allowed_roots = COMPLETION_ROOTS.get(action, frozenset())
    if (obligation is not None and obligation.kind in allowed_roots
            and obligation.eligible_at_lock
            and obligation.recorded_started_at < locked_at):
        return AccessDecision(True, "EXISTING_OBLIGATION_COMPLETION")
    return AccessDecision(False, "SUBSCRIPTION_EXPIRED")
