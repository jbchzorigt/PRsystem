import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timezone
from threading import Barrier, Lock

from prsystem.cash import (
    CancelTransfer, CashBook, CashContext, ConfirmTransfer, Drawer,
    ReserveTransfer, SpendCash, TransferState, execute,
)
from prsystem.common import DomainError


class CashTests(unittest.TestCase):
    def setUp(self):
        self.book = CashBook("h", (Drawer("a", "sa", 100_000), Drawer("b", "sb", 0)))
        self.now = datetime(2026, 9, 6, tzinfo=timezone.utc)

    def context(self, key="k", book=None, **kw):
        base = CashContext("h", "actor", key, (book or self.book).revision,
                           self.now, True, "sa")
        return replace(base, **kw)

    def reserve(self):
        return execute(self.book, ReserveTransfer("t", "a", "b", 80_000), self.context())

    def test_pending_transfer_reserves_without_posting(self):
        result = self.reserve()
        self.assertEqual((result.drawer("a").posted, result.drawer("a").reserved,
                          result.drawer("a").available), (100_000, 80_000, 20_000))
        self.assertEqual(result.drawer("b").posted, 0)
        self.assertFalse(result.can_close_shift("sa"))
        self.assertFalse(result.can_close_shift("sb"))
        self.assertEqual(self.book.drawer("a").reserved, 0)

    def test_reserved_cash_cannot_be_spent_but_remainder_can(self):
        b = self.reserve()
        with self.assertRaisesRegex(DomainError, "INSUFFICIENT_AVAILABLE_CASH"):
            execute(b, SpendCash("a", 50_000, "expense-1", "approved"), self.context("debit", b))
        result = execute(b, SpendCash("a", 20_000, "expense-1", "approved"), self.context("debit", b))
        self.assertEqual(result.drawer("a").available, 0)

    def test_confirm_posts_paired_movements_and_preserves_total(self):
        b = self.reserve()
        c = self.context("confirm", b, shift_id="sb")
        result = execute(b, ConfirmTransfer("t", 80_000), c)
        self.assertEqual((result.drawer("a").posted, result.drawer("a").reserved), (20_000, 0))
        self.assertEqual(result.drawer("b").posted, 80_000)
        self.assertEqual(sum(d.posted for d in result.drawers), 100_000)
        self.assertEqual(sum(e.posted_delta for e in result.events), 0)
        self.assertTrue(result.can_close_shift("sa"))
        self.assertTrue(result.can_close_shift("sb"))
        self.assertEqual(result.transfer("t").state, TransferState.COMPLETED)
        self.assertIs(execute(result, ConfirmTransfer("t", 80_000), c), result)

    def test_cancel_requires_full_physical_return_in_source_shift(self):
        b = self.reserve()
        for amount in [0, 79_999]:
            with self.subTest(amount=amount), self.assertRaisesRegex(DomainError, "CASH_RETURN_NOT_CONFIRMED"):
                execute(b, CancelTransfer("t", amount, "returned"), self.context("cancel", b))
        with self.assertRaisesRegex(DomainError, "SOURCE_SHIFT_REQUIRED"):
            execute(b, CancelTransfer("t", 80_000, "returned"), self.context("cancel", b, shift_id="sb"))
        result = execute(b, CancelTransfer("t", 80_000, "returned"), self.context("cancel", b))
        self.assertEqual(result.drawer("a").available, 100_000)
        self.assertEqual(result.drawer("b").posted, 0)
        self.assertEqual(result.transfer("t").state, TransferState.CANCELLED)

    def test_wrong_recipient_count_and_shift_rejected(self):
        b = self.reserve()
        with self.assertRaisesRegex(DomainError, "RECIPIENT_SHIFT_REQUIRED"):
            execute(b, ConfirmTransfer("t", 80_000), self.context("c", b))
        with self.assertRaisesRegex(DomainError, "COUNT_MISMATCH"):
            execute(b, ConfirmTransfer("t", 79_999), self.context("c", b, shift_id="sb"))
        changed = replace(b, drawers=(replace(b.drawers[0], shift_id="new"), b.drawers[1]))
        with self.assertRaisesRegex(DomainError, "SHIFT_BINDING_CHANGED"):
            execute(changed, ConfirmTransfer("t", 80_000), self.context("c", changed, shift_id="sb"))

    def test_idempotent_replay_and_conflicting_payload(self):
        b = self.reserve()
        self.assertIs(execute(b, ReserveTransfer("t", "a", "b", 80_000), self.context()), b)
        for cmd in [ReserveTransfer("t", "a", "b", 90_000), SpendCash("a", 10_000, "x", "r")]:
            with self.assertRaisesRegex(DomainError, "IDEMPOTENCY_CONFLICT"):
                execute(b, cmd, self.context())
        with self.assertRaisesRegex(DomainError, "IDEMPOTENCY_CONFLICT"):
            execute(b, ReserveTransfer("t", "a", "b", 80_000), self.context(actor_id="other"))

    def test_financial_reference_unique_even_with_new_key(self):
        cmd = SpendCash("a", 20_000, "expense-1", "approved")
        b = execute(self.book, cmd, self.context("debit"))
        with self.assertRaisesRegex(DomainError, "FINANCIAL_REFERENCE_EXISTS"):
            execute(b, cmd, self.context("different-key", b))

    def test_terminal_transfer_cannot_be_cancelled_with_new_key(self):
        b = self.reserve()
        done = execute(b, ConfirmTransfer("t", 80_000), self.context("c", b, shift_id="sb"))
        with self.assertRaisesRegex(DomainError, "TRANSFER_TERMINAL"):
            execute(done, CancelTransfer("t", 80_000, "r"), self.context("cancel", done))

    def test_bad_values_and_cross_tenant_rejected(self):
        for amount in [0, -1, 0.5, True, "100", 2**63]:
            with self.subTest(amount=amount), self.assertRaisesRegex(DomainError, "INVALID_MNT"):
                execute(self.book, ReserveTransfer("t", "a", "b", amount), self.context())
        for c in [self.context(tenant_id="other"), self.context(authorized=False)]:
            with self.assertRaisesRegex(DomainError, "FORBIDDEN"):
                execute(self.book, ReserveTransfer("t", "a", "b", 100), c)
        with self.assertRaisesRegex(DomainError, "SAME_DRAWER"):
            execute(self.book, ReserveTransfer("t", "a", "a", 100), self.context())

    def test_stale_revision_cannot_overwrite_reservation(self):
        b = self.reserve()
        with self.assertRaisesRegex(DomainError, "REVISION_CONFLICT"):
            execute(b, SpendCash("a", 50_000, "e", "approved"), self.context("d"))

    def test_competing_reservation_and_debit_with_atomic_cas_harness(self):
        # Test-only persistence harness, NOT a PostgreSQL concurrency test.
        state = [self.book]
        mutex = Lock()
        barrier = Barrier(2)
        cmds = [ReserveTransfer("t", "a", "b", 80_000),
                SpendCash("a", 50_000, "expense", "approved")]

        def commit(i):
            snapshot = self.book
            proposal = execute(snapshot, cmds[i], self.context(str(i)))
            barrier.wait(timeout=5)
            with mutex:
                if state[0].revision != snapshot.revision:
                    return False
                state[0] = proposal
                return True

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(commit, range(2)))
        self.assertEqual(sum(results), 1)
        winner = state[0]
        loser = results.index(False)
        with self.assertRaisesRegex(DomainError, "INSUFFICIENT_AVAILABLE_CASH"):
            execute(winner, cmds[loser], self.context(str(loser), winner))
        winner.validate()
