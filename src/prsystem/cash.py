"""CASH-DEC-011 immutable cash reducer.

The adapter must authorize commands, load authoritative cash/shift/count facts,
and atomically CAS the returned revision with events and idempotency receipt.
This is not a database or an HTTP API. No mutation occurs on rejection.
"""

from dataclasses import dataclass, replace
from datetime import datetime
from enum import StrEnum

from .common import DomainError, identifier, money, timestamp


class TransferState(StrEnum):
    PENDING = "PENDING"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


@dataclass(frozen=True)
class Drawer:
    id: str
    shift_id: str
    posted: int
    reserved: int = 0

    @property
    def available(self) -> int:
        return self.posted - self.reserved


@dataclass(frozen=True)
class Transfer:
    id: str
    source_id: str
    destination_id: str
    source_shift_id: str
    destination_shift_id: str
    amount: int
    state: TransferState = TransferState.PENDING


@dataclass(frozen=True)
class ReserveTransfer:
    transfer_id: str
    source_id: str
    destination_id: str
    amount: int


@dataclass(frozen=True)
class ConfirmTransfer:
    transfer_id: str
    counted_amount: int


@dataclass(frozen=True)
class CancelTransfer:
    transfer_id: str
    returned_amount: int
    reason: str


@dataclass(frozen=True)
class SpendCash:
    drawer_id: str
    amount: int
    financial_reference: str
    reason: str


CashCommand = ReserveTransfer | ConfirmTransfer | CancelTransfer | SpendCash


@dataclass(frozen=True)
class CashContext:
    tenant_id: str
    actor_id: str
    idempotency_key: str
    expected_revision: int
    recorded_at: datetime
    authorized: bool
    shift_id: str | None = None


@dataclass(frozen=True)
class CashEvent:
    kind: str
    reference: str
    drawer_id: str
    shift_id: str
    posted_delta: int
    reserved_delta: int
    actor_id: str
    recorded_at: datetime


@dataclass(frozen=True)
class Receipt:
    key: str
    actor_id: str
    command: CashCommand


@dataclass(frozen=True)
class RefundHold:
    """Read-only canonical cash refund reservation, loaded by the adapter."""
    id: str
    drawer_id: str
    shift_id: str
    amount: int


@dataclass(frozen=True)
class CashBook:
    tenant_id: str
    drawers: tuple[Drawer, ...]
    transfers: tuple[Transfer, ...] = ()
    events: tuple[CashEvent, ...] = ()
    receipts: tuple[Receipt, ...] = ()
    revision: int = 0
    refund_holds: tuple[RefundHold, ...] = ()

    def drawer(self, drawer_id: str) -> Drawer:
        for drawer in self.drawers:
            if drawer.id == drawer_id:
                return drawer
        raise DomainError("DRAWER_NOT_FOUND")

    def transfer(self, transfer_id: str) -> Transfer:
        for transfer in self.transfers:
            if transfer.id == transfer_id:
                return transfer
        raise DomainError("TRANSFER_NOT_FOUND")

    def can_close_shift(self, shift_id: str) -> bool:
        if not any(d.shift_id == shift_id for d in self.drawers):
            raise DomainError("SHIFT_NOT_FOUND")
        return not any(t.state == TransferState.PENDING
                       and shift_id in {t.source_shift_id, t.destination_shift_id}
                       for t in self.transfers) and not any(h.shift_id == shift_id for h in self.refund_holds)

    def validate(self) -> None:
        identifier(self.tenant_id)
        if type(self.revision) is not int or self.revision < 0:
            raise DomainError("INVALID_REVISION")
        if (len({d.id for d in self.drawers}) != len(self.drawers)
                or len({d.shift_id for d in self.drawers}) != len(self.drawers)
                or len({t.id for t in self.transfers}) != len(self.transfers)
                or len({r.key for r in self.receipts}) != len(self.receipts)
                or len({h.id for h in self.refund_holds}) != len(self.refund_holds)):
            raise DomainError("DUPLICATE_AGGREGATE_ID")
        for t in self.transfers:
            identifier(t.id)
            money(t.amount, positive=True)
            if not isinstance(t.state, TransferState) or t.source_id == t.destination_id:
                raise DomainError("INVALID_TRANSFER")
            source = self.drawer(t.source_id)
            destination = self.drawer(t.destination_id)
            if t.state == TransferState.PENDING and (
                    source.shift_id != t.source_shift_id
                    or destination.shift_id != t.destination_shift_id):
                raise DomainError("SHIFT_BINDING_CHANGED")
        for hold in self.refund_holds:
            identifier(hold.id)
            money(hold.amount, positive=True)
            if self.drawer(hold.drawer_id).shift_id != hold.shift_id:
                raise DomainError('SHIFT_BINDING_CHANGED')
        for d in self.drawers:
            identifier(d.id)
            identifier(d.shift_id)
            money(d.posted)
            money(d.reserved)
            expected = sum(t.amount for t in self.transfers
                           if t.source_id == d.id and t.state == TransferState.PENDING)
            expected += sum(h.amount for h in self.refund_holds if h.drawer_id == d.id)
            if d.reserved != expected or d.available < 0:
                raise DomainError("CASH_INVARIANT_VIOLATION")


def execute(book: CashBook, command: CashCommand, ctx: CashContext) -> CashBook:
    """Compute a new snapshot; callers MUST persist with atomic revision CAS.

    A replay returns the current snapshot unchanged. Authorization is checked
    even on replay. A reused key with another actor/payload is a conflict.
    """
    book.validate()
    identifier(ctx.actor_id)
    identifier(ctx.idempotency_key)
    timestamp(ctx.recorded_at)
    if ctx.tenant_id != book.tenant_id or not ctx.authorized:
        raise DomainError("FORBIDDEN")
    for receipt in book.receipts:
        if receipt.key == ctx.idempotency_key:
            if receipt.actor_id != ctx.actor_id or receipt.command != command:
                raise DomainError("IDEMPOTENCY_CONFLICT")
            return book
    if type(ctx.expected_revision) is not int or ctx.expected_revision != book.revision:
        raise DomainError("REVISION_CONFLICT")
    drawers = {d.id: d for d in book.drawers}
    transfers = {t.id: t for t in book.transfers}
    events = list(book.events)

    def post(d: Drawer, kind: str, ref: str, amount: int = 0, reserve: int = 0) -> None:
        drawers[d.id] = replace(d, posted=d.posted + amount, reserved=d.reserved + reserve)
        events.append(CashEvent(kind, ref, d.id, d.shift_id, amount, reserve,
                                ctx.actor_id, ctx.recorded_at))

    if isinstance(command, ReserveTransfer):
        identifier(command.transfer_id)
        money(command.amount, positive=True)
        if command.transfer_id in transfers:
            raise DomainError("TRANSFER_EXISTS")
        source = book.drawer(command.source_id)
        dest = book.drawer(command.destination_id)
        if source.id == dest.id:
            raise DomainError("SAME_DRAWER")
        if command.amount > source.available:
            raise DomainError("INSUFFICIENT_AVAILABLE_CASH")
        transfers[command.transfer_id] = Transfer(
            command.transfer_id, source.id, dest.id, source.shift_id, dest.shift_id,
            command.amount,
        )
        post(source, "TRANSFER_RESERVED", command.transfer_id, reserve=command.amount)
    elif isinstance(command, (ConfirmTransfer, CancelTransfer)):
        transfer = book.transfer(command.transfer_id)
        if transfer.state != TransferState.PENDING:
            raise DomainError("TRANSFER_TERMINAL")
        source = book.drawer(transfer.source_id)
        dest = book.drawer(transfer.destination_id)
        if (source.shift_id != transfer.source_shift_id
                or dest.shift_id != transfer.destination_shift_id):
            raise DomainError("SHIFT_BINDING_CHANGED")
        if isinstance(command, ConfirmTransfer):
            money(command.counted_amount)
            if ctx.shift_id != dest.shift_id:
                raise DomainError("RECIPIENT_SHIFT_REQUIRED")
            if command.counted_amount != transfer.amount:
                raise DomainError("COUNT_MISMATCH")
            post(source, "TRANSFER_OUT", transfer.id, -transfer.amount, -transfer.amount)
            post(dest, "TRANSFER_IN", transfer.id, transfer.amount)
            transfers[transfer.id] = replace(transfer, state=TransferState.COMPLETED)
        else:
            money(command.returned_amount)
            identifier(command.reason)
            if ctx.shift_id != source.shift_id:
                raise DomainError("SOURCE_SHIFT_REQUIRED")
            if command.returned_amount != transfer.amount:
                raise DomainError("CASH_RETURN_NOT_CONFIRMED")
            post(source, "TRANSFER_CANCELLED", transfer.id, reserve=-transfer.amount)
            transfers[transfer.id] = replace(transfer, state=TransferState.CANCELLED)
    elif isinstance(command, SpendCash):
        money(command.amount, positive=True)
        identifier(command.financial_reference)
        identifier(command.reason)
        source = book.drawer(command.drawer_id)
        if ctx.shift_id != source.shift_id:
            raise DomainError("SOURCE_SHIFT_REQUIRED")
        if any(e.kind == "CASH_DEBIT" and e.reference == command.financial_reference
               for e in book.events):
            raise DomainError("FINANCIAL_REFERENCE_EXISTS")
        if command.amount > source.available:
            raise DomainError("INSUFFICIENT_AVAILABLE_CASH")
        post(source, "CASH_DEBIT", command.financial_reference, -command.amount)
    else:
        raise DomainError("UNKNOWN_COMMAND")
    result = CashBook(book.tenant_id, tuple(drawers.values()), tuple(transfers.values()),
                      tuple(events), book.receipts + (Receipt(ctx.idempotency_key,
                      ctx.actor_id, command),), book.revision + 1, book.refund_holds)
    result.validate()
    return result
