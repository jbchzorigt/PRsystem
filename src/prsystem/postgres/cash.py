"""Atomic cash persistence, not a public command/authentication endpoint.

The mandatory authorizer runs inside the same locked transaction, including on
replay. It must verify server-side account, membership, action, subscription,
shift/count and financial source approval facts. There is no permissive default.
"""

from collections.abc import Callable
from contextlib import closing
from dataclasses import asdict, dataclass, replace

import psycopg
from psycopg.types.json import Jsonb

from prsystem.cash import (
    CancelTransfer, CashBook, CashCommand, CashContext, CashEvent, ConfirmTransfer,
    Drawer, ReserveTransfer, SpendCash, Transfer, TransferState, execute,
)
from prsystem.common import DomainError, identifier, money, timestamp

Authorizer = Callable[[psycopg.Connection, CashCommand, CashContext], bool]


@dataclass(frozen=True)
class CashResult:
    revision: int
    replayed: bool


class PostgresCash:
    def __init__(self, dsn: str, *, authorize: Authorizer):
        self._dsn = dsn
        self._authorize = authorize

    def execute(self, command: CashCommand, ctx: CashContext) -> CashResult:
        identifier(ctx.tenant_id)
        identifier(ctx.actor_id)
        identifier(ctx.idempotency_key)
        timestamp(ctx.recorded_at)
        if type(command) not in (ReserveTransfer, ConfirmTransfer, CancelTransfer, SpendCash):
            raise DomainError("UNKNOWN_COMMAND")
        if isinstance(command, (ReserveTransfer, SpendCash)):
            money(command.amount, positive=True)
        elif isinstance(command, ConfirmTransfer):
            money(command.counted_amount)
        else:
            money(command.returned_amount)
        payload = {"type": type(command).__name__, "fields": asdict(command)}
        # One owned connection means returning successfully implies COMMIT succeeded.
        # Psycopg's connection context can raise during COMMIT before close().
        # The outer closing context also releases the connection on that path.
        with closing(psycopg.connect(self._dsn, connect_timeout=5)) as conn, conn:
            conn.execute("SET LOCAL lock_timeout = '5s'")
            conn.execute("SET LOCAL statement_timeout = '15s'")
            unsafe = conn.execute("""SELECT r.rolsuper OR r.rolbypassrls OR EXISTS (
                SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'prsystem' AND c.relkind = 'r'
                  AND pg_has_role(current_user, c.relowner, 'USAGE'))
                FROM pg_roles r WHERE r.rolname = current_user""").fetchone()[0]
            if unsafe:
                raise DomainError("UNSAFE_DATABASE_ROLE")
            conn.execute("SELECT set_config('prsystem.tenant_id', %s, true)", (ctx.tenant_id,))
            root = conn.execute("""SELECT revision FROM prsystem.cash_book
                WHERE tenant_id = %s FOR UPDATE""", (ctx.tenant_id,)).fetchone()
            if root is None:
                raise DomainError("CASH_BOOK_NOT_FOUND")
            if self._authorize(conn, command, ctx) is not True:
                raise DomainError("FORBIDDEN")
            receipt = conn.execute("""SELECT actor_id, command, revision
                FROM prsystem.cash_receipt WHERE tenant_id = %s AND key = %s""",
                (ctx.tenant_id, ctx.idempotency_key)).fetchone()
            if receipt:
                # Python considers True == 1; compare JSONB in SQL for typed payload equality.
                same = conn.execute("SELECT %s::jsonb = %s::jsonb",
                                    (Jsonb(receipt[1]), Jsonb(payload))).fetchone()[0]
                if receipt[0] != ctx.actor_id or not same:
                    raise DomainError("IDEMPOTENCY_CONFLICT")
                return CashResult(receipt[2], True)
            book = self._load(conn, command, ctx.tenant_id, root[0])
            result = execute(book, command, replace(ctx, authorized=True))
            self._persist(conn, book, result, command, ctx, payload)
            return CashResult(result.revision, False)

    @staticmethod
    def _load(conn, command, tenant, revision):
        drawers = tuple(Drawer(*row) for row in conn.execute("""
            SELECT id, shift_id, posted, reserved FROM prsystem.cash_drawer
            WHERE tenant_id = %s ORDER BY id""", (tenant,)))
        target = getattr(command, "transfer_id", None)
        transfers = tuple(Transfer(*row[:-1], TransferState(row[-1])) for row in conn.execute("""
            SELECT id, source_id, destination_id, source_shift_id, destination_shift_id, amount, state
            FROM prsystem.cash_transfer WHERE tenant_id = %s AND (state = 'PENDING' OR id = %s)
            ORDER BY id""", (tenant, target)))
        # Query only the relevant financial reference, never the full ledger history.
        events = ()
        if isinstance(command, SpendCash):
            events = tuple(CashEvent(*row) for row in conn.execute("""
                SELECT kind, reference, drawer_id, shift_id, posted_delta, reserved_delta, actor_id, recorded_at
                FROM prsystem.cash_event WHERE tenant_id = %s AND kind = 'CASH_DEBIT' AND reference = %s""",
                (tenant, command.financial_reference)))
        return CashBook(tenant, drawers, transfers, events, revision=revision)

    @staticmethod
    def _persist(conn, before, after, command, ctx, payload):
        for drawer in after.drawers:
            if drawer != before.drawer(drawer.id):
                conn.execute("""UPDATE prsystem.cash_drawer SET posted = %s, reserved = %s
                    WHERE tenant_id = %s AND id = %s""",
                    (drawer.posted, drawer.reserved, after.tenant_id, drawer.id))
        if isinstance(command, ReserveTransfer):
            transfer = after.transfer(command.transfer_id)
            conn.execute("""INSERT INTO prsystem.cash_transfer
                (tenant_id, id, source_id, destination_id, source_shift_id, destination_shift_id, amount, state)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                (after.tenant_id, transfer.id, transfer.source_id, transfer.destination_id,
                 transfer.source_shift_id, transfer.destination_shift_id, transfer.amount, transfer.state.value))
        elif isinstance(command, (ConfirmTransfer, CancelTransfer)):
            conn.execute("""UPDATE prsystem.cash_transfer SET state = %s
                WHERE tenant_id = %s AND id = %s""",
                (after.transfer(command.transfer_id).state.value, after.tenant_id, command.transfer_id))
        events = after.events[len(before.events):]
        for ordinal, event in enumerate(events):
            conn.execute("""INSERT INTO prsystem.cash_event
                (tenant_id, revision, ordinal, kind, reference, drawer_id, shift_id,
                 posted_delta, reserved_delta, actor_id, recorded_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (after.tenant_id, after.revision, ordinal, event.kind, event.reference,
                 event.drawer_id, event.shift_id, event.posted_delta, event.reserved_delta,
                 event.actor_id, event.recorded_at))
        conn.execute("""INSERT INTO prsystem.cash_receipt (tenant_id, key, actor_id, command, revision)
            VALUES (%s, %s, %s, %s, %s)""",
            (after.tenant_id, ctx.idempotency_key, ctx.actor_id, Jsonb(payload), after.revision))
        conn.execute("""INSERT INTO prsystem.cash_outbox (tenant_id, revision, topic, payload, recorded_at)
            VALUES (%s, %s, 'cash.changed', %s, %s)""",
            (after.tenant_id, after.revision, Jsonb({"command_key": ctx.idempotency_key,
             "event_count": len(events)}), ctx.recorded_at))
        conn.execute("UPDATE prsystem.cash_book SET revision = %s WHERE tenant_id = %s",
                     (after.revision, after.tenant_id))
