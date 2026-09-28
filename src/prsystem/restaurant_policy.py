"""Restaurant ordering decisions (docs/08).

Only trusted, persisted facts belong here. A caller must authenticate the realm,
lock the order/link, verify provider results and atomically save state plus events.
These decisions never debit hotel cash, deposit or checkout balances.
"""
from dataclasses import dataclass, replace
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from prsystem.common import DomainError, identifier, money, timestamp

ZONE = ZoneInfo('Asia/Ulaanbaatar')
TERMINAL = frozenset({'DELIVERED_TO_ROOM', 'HANDED_TO_RECEPTION', 'PICKED_UP_BY_GUEST', 'CANCELLED'})
DELIVERED = TERMINAL - {'CANCELLED'}
REJECTION_REASONS = frozenset({'PREPARATION_STARTED', 'FOOD_READY', 'OUT_FOR_DELIVERY', 'HANDED_OVER'})


def opening_window(weekly_hours, closures, now):
    """Return the containing interval; special closure dates cut overnight hours.

    Weekdays use Python's Monday=0. Endpoints are half open; equal opening and
    closing times are invalid rather than an implicit 24-hour opening.
    """
    timestamp(now)
    if not isinstance(weekly_hours, (tuple, list)) or len(weekly_hours) != 7:
        raise DomainError('INVALID_RESTAURANT_SCHEDULE')
    days = {}
    for entry in weekly_hours:
        if not isinstance(entry, dict):
            raise DomainError('INVALID_RESTAURANT_SCHEDULE')
        day = entry.get('day')
        if type(day) is not int or not 0 <= day <= 6 or day in days or type(entry.get('closed')) is not bool:
            raise DomainError('INVALID_RESTAURANT_SCHEDULE')
        if entry['closed']:
            days[day] = None
            continue
        try:
            values = [entry[k] for k in ('opens', 'closes')]
            if any(not isinstance(v, str) or len(v) != 5 or v[2] != ':' for v in values):
                raise ValueError
            start, end = (time.fromisoformat(v) for v in values)
        except (ValueError, KeyError, TypeError):
            raise DomainError('INVALID_RESTAURANT_SCHEDULE') from None
        if start == end:
            raise DomainError('INVALID_RESTAURANT_SCHEDULE')
        days[day] = start, end
    if not isinstance(closures, (tuple, list, set, frozenset)) or any(type(d) is not date for d in closures):
        raise DomainError('INVALID_RESTAURANT_CLOSURES')
    local = now.astimezone(ZONE)
    today = local.date()
    if today in closures:
        return None
    windows = []
    for origin in (today - timedelta(days=1), today):
        hours = days[origin.weekday()]
        if hours is None or origin in closures:
            continue
        start, end = (datetime.combine(origin, t, ZONE) for t in hours)
        if end < start:
            end += timedelta(days=1)
        if end.date() in closures:
            end = datetime.combine(end.date(), time(), ZONE)
        if start <= local < end:
            windows.append((start, end))
    return max(windows, key=lambda w: w[1]) if windows else None


def invoice_expiry(weekly_hours, closures, now, ttl=timedelta(minutes=15)):
    if not isinstance(ttl, timedelta) or not timedelta(0) < ttl <= timedelta(minutes=15):
        raise DomainError('INVALID_INVOICE_TTL')
    window = opening_window(weekly_hours, closures, now)
    if window is None:
        raise DomainError('RESTAURANT_CLOSED')
    return min(now + ttl, window[1])


def quote_items(catalog, quantities):
    """Catalog comes from locked server records; the cart supplies IDs/counts only."""
    if not isinstance(quantities, dict) or not 1 <= len(quantities) <= 100:
        raise DomainError('INVALID_RESTAURANT_CART')
    lines, total = [], 0
    for item_id, quantity in sorted(quantities.items()):
        identifier(item_id)
        if type(quantity) is not int or not 1 <= quantity <= 100:
            raise DomainError('INVALID_RESTAURANT_QUANTITY')
        item = catalog.get(item_id)
        if not item or not item['active'] or not item['available']:
            raise DomainError('RESTAURANT_ITEM_UNAVAILABLE')
        money(item['price_mnt'], positive=True)
        amount = item['price_mnt'] * quantity
        total += amount
        money(total, positive=True)
        lines.append(dict(item_id=item_id, name=item['name'], unit_price_mnt=item['price_mnt'],
                          quantity=quantity, amount_mnt=amount))
    return tuple(lines), total


@dataclass(frozen=True)
class Order:
    invoice_id: str
    merchant_id: str
    amount_mnt: int
    created_at: datetime
    expires_at: datetime
    order: str = 'PENDING_PAYMENT'
    fulfillment: str = 'NOT_STARTED'
    payment: str = 'PENDING'
    refund_policy: str = 'NONE'
    refund_request: str = 'NONE'
    refund: str = 'NONE'
    handoff: str = 'ROOM'
    payment_id: str | None = None
    confirmed_at: datetime | None = None
    accepted_at: datetime | None = None
    promised_ready_at: datetime | None = None
    refund_requested_at: datetime | None = None
    refund_reason: str | None = None
    refund_attempt_id: str | None = None
    refund_provider_id: str | None = None

    def __post_init__(self):
        identifier(self.invoice_id)
        identifier(self.merchant_id)
        money(self.amount_mnt, positive=True)
        timestamp(self.created_at)
        timestamp(self.expires_at)
        if self.expires_at <= self.created_at:
            raise DomainError('INVALID_INVOICE_INTERVAL')
        for value in (self.confirmed_at, self.accepted_at, self.promised_ready_at, self.refund_requested_at):
            if value is not None:
                timestamp(value)

    def _now(self, now):
        timestamp(now)
        if now < max(v for v in (self.created_at, self.confirmed_at, self.accepted_at, self.refund_requested_at) if v is not None):
            raise DomainError('RESTAURANT_CLOCK_CONFLICT')

    def _mandatory(self, now, reason):
        # Delivery evidence is retained even if a subsequent refund is approved.
        terminal = self.fulfillment in DELIVERED
        return replace(self, order=self.order if terminal else 'CANCELLED',
                       fulfillment=self.fulfillment if terminal else 'CANCELLED',
                       refund_policy='MANDATORY', refund_request='APPROVED',
                       refund_requested_at=now, refund_reason=reason)

    def expire(self, now, *, inactive=False):
        self._now(now)
        if self.payment != 'PENDING':
            return self
        if not inactive and now < self.expires_at:
            raise DomainError('INVOICE_NOT_EXPIRED')
        return replace(self, order='CANCELLED', fulfillment='CANCELLED', payment='EXPIRED')

    def capture(self, now, *, merchant_id, invoice_id, amount_mnt, currency, payment_id, eligible, within_hours=True):
        """Apply a server-verified capture, never a browser or raw webhook flag."""
        self._now(now)
        identifier(payment_id)
        money(amount_mnt, positive=True)
        if (merchant_id, invoice_id, amount_mnt, currency) != (self.merchant_id, self.invoice_id, self.amount_mnt, 'MNT'):
            raise DomainError('RESTAURANT_PAYMENT_MISMATCH')
        if type(eligible) is not bool or type(within_hours) is not bool:
            raise DomainError('INVALID_REQUEST')
        if self.payment == 'PAID':
            if payment_id != self.payment_id:
                raise DomainError('RESTAURANT_DUPLICATE_CAPTURE')
            return self
        captured = replace(self, payment='PAID', payment_id=payment_id, confirmed_at=now)
        if now >= self.expires_at or not within_hours:
            return captured._mandatory(now, 'PAID_AFTER_INVOICE_EXPIRY')
        if not eligible or self.order == 'CANCELLED':
            return captured._mandatory(now, 'RESTAURANT_OR_ITEM_INACTIVE_AT_PAYMENT')
        return replace(captured, order='CONFIRMED', fulfillment='AWAITING_ACCEPTANCE')

    def accept(self, now, eta_minutes):
        self._now(now)
        if type(eta_minutes) is not int or eta_minutes not in {15, 30, 45, 60}:
            raise DomainError('INVALID_RESTAURANT_ETA')
        if self.order != 'CONFIRMED' or self.fulfillment != 'AWAITING_ACCEPTANCE' or self.payment != 'PAID':
            raise DomainError('RESTAURANT_TRANSITION_CONFLICT')
        return replace(self, fulfillment='ACCEPTED', accepted_at=now,
                       promised_ready_at=now + timedelta(minutes=eta_minutes))

    def fulfill(self, now, target):
        self._now(now)
        transitions = {'ACCEPTED': {'PREPARING'}, 'PREPARING': {'READY'},
                       'READY': {'OUT_FOR_DELIVERY', 'HANDED_TO_RECEPTION', 'PICKED_UP_BY_GUEST'},
                       'OUT_FOR_DELIVERY': {'DELIVERED_TO_ROOM', 'HANDED_TO_RECEPTION', 'PICKED_UP_BY_GUEST'}}
        if self.order != 'CONFIRMED' or target not in transitions.get(self.fulfillment, set()):
            raise DomainError('RESTAURANT_TRANSITION_CONFLICT')
        required = {'DELIVERED_TO_ROOM': 'ROOM', 'HANDED_TO_RECEPTION': 'RECEPTION', 'PICKED_UP_BY_GUEST': 'GUEST_PICKUP'}
        if target in required and self.handoff != required[target]:
            raise DomainError('RESTAURANT_HANDOFF_CONFLICT')
        return replace(self, fulfillment=target, order='COMPLETED' if target in DELIVERED else self.order)

    def request_refund(self, now, *, checkout=False):
        self._now(now)
        if self.payment != 'PAID' or self.refund_request != 'NONE' or self.fulfillment == 'CANCELLED':
            raise DomainError('RESTAURANT_TRANSITION_CONFLICT')
        if self.accepted_at is None:
            if self.confirmed_at is None or now < self.confirmed_at + timedelta(minutes=10):
                raise DomainError('RESTAURANT_REFUND_NOT_AVAILABLE')
            return self._mandatory(now, 'ACCEPTANCE_TIMEOUT')
        if not checkout and (self.promised_ready_at is None or now < self.promised_ready_at + timedelta(minutes=15) or self.fulfillment in TERMINAL):
            raise DomainError('RESTAURANT_REFUND_NOT_AVAILABLE')
        return replace(self, refund_policy='DISCRETIONARY', refund_request='OPEN',
                       refund_requested_at=now, refund_reason='CHECKOUT_REQUEST' if checkout else 'ETA_TIMEOUT')

    def cannot_fulfill(self, now):
        self._now(now)
        if self.payment != 'PAID' or self.fulfillment in TERMINAL or self.refund_request not in {'NONE', 'OPEN', 'REJECTED'}:
            raise DomainError('RESTAURANT_TRANSITION_CONFLICT')
        return self._mandatory(now, 'RESTAURANT_CANNOT_FULFILL')

    def decide_refund(self, now, approve, reason=None):
        self._now(now)
        if type(approve) is not bool or self.refund_policy != 'DISCRETIONARY' or self.refund_request != 'OPEN':
            raise DomainError('RESTAURANT_TRANSITION_CONFLICT')
        if not approve:
            if reason not in REJECTION_REASONS:
                raise DomainError('RESTAURANT_REFUND_REASON_REQUIRED')
            return replace(self, refund_request='REJECTED', refund_reason=reason)
        return replace(self, refund_request='APPROVED',
                       order=self.order if self.fulfillment in DELIVERED else 'CANCELLED',
                       fulfillment=self.fulfillment if self.fulfillment in DELIVERED else 'CANCELLED')

    def begin_refund(self, now, attempt_id):
        self._now(now)
        identifier(attempt_id)
        if self.refund_request != 'APPROVED' or self.refund not in {'NONE', 'FAILED'}:
            raise DomainError('RESTAURANT_TRANSITION_CONFLICT')
        if self.refund_attempt_id is not None and attempt_id != self.refund_attempt_id:
            raise DomainError('RESTAURANT_REFUND_ATTEMPT_CHANGED')
        return replace(self, refund='PENDING', refund_attempt_id=attempt_id)

    def refund_result(self, now, *, attempt_id, merchant_id, invoice_id, amount_mnt, currency, succeeded, provider_id):
        """A trusted provider result for this exact refund attempt only."""
        self._now(now)
        money(amount_mnt, positive=True)
        identifier(provider_id)
        if type(succeeded) is not bool or (attempt_id, merchant_id, invoice_id, amount_mnt, currency) != (
                self.refund_attempt_id, self.merchant_id, self.invoice_id, self.amount_mnt, 'MNT'):
            raise DomainError('RESTAURANT_REFUND_MISMATCH')
        if self.refund == 'REFUNDED' and succeeded and self.refund_provider_id == provider_id:
            return self
        if self.refund_request != 'APPROVED' or self.refund not in {'PENDING', 'FAILED'}:
            raise DomainError('RESTAURANT_TRANSITION_CONFLICT')
        return replace(self, refund='REFUNDED' if succeeded else 'FAILED',
                       refund_request='RESOLVED' if succeeded else 'APPROVED', refund_provider_id=provider_id)

    def checkout_handoff(self, now, mode, guest_informed):
        self._now(now)
        if guest_informed is not True or mode not in {'RECEPTION', 'GUEST_PICKUP', 'REFUND_REQUEST'}:
            raise DomainError('RESTAURANT_HANDOFF_REQUIRED')
        if self.payment != 'PAID' or self.fulfillment in TERMINAL:
            raise DomainError('RESTAURANT_TRANSITION_CONFLICT')
        result = replace(self, handoff=mode)
        return result.request_refund(now, checkout=True) if mode == 'REFUND_REQUEST' else result

    def alerts(self, now):
        """Time-derived warnings; evaluating a timer cannot move money or cancel."""
        self._now(now)
        acceptance = self.fulfillment == 'AWAITING_ACCEPTANCE' and self.confirmed_at is not None
        pending = self.refund_request in {'OPEN', 'APPROVED'} and self.refund_requested_at is not None
        unfinished = self.fulfillment not in TERMINAL and self.promised_ready_at is not None
        return dict(
            acceptance_warning=bool(acceptance and now >= self.confirmed_at + timedelta(minutes=5)),
            acceptance_reception=bool(acceptance and now >= self.confirmed_at + timedelta(minutes=10)),
            eta_warning=bool(unfinished and now >= self.promised_ready_at),
            eta_refund_available=bool(unfinished and now >= self.promised_ready_at + timedelta(minutes=15)),
            refund_reminder=bool(pending and now >= self.refund_requested_at + timedelta(minutes=5)),
            refund_escalation=bool(pending and now >= self.refund_requested_at + timedelta(minutes=10)),
            link_paused=bool(pending and now >= self.refund_requested_at + timedelta(minutes=30)))
