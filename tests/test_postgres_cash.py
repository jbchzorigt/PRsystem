"""Real PostgreSQL tests. Use an isolated server; setup creates a disposable DB/role."""

import os
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timezone
from threading import Barrier
from uuid import uuid4

from prsystem.cash import CancelTransfer, CashContext, ConfirmTransfer, ReserveTransfer, SpendCash
from prsystem.common import DomainError

ADMIN_DSN = os.environ.get("PRSYSTEM_TEST_ADMIN_DSN")
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from psycopg.conninfo import make_conninfo
    from prsystem.postgres.cash import PostgresCash
    from prsystem.postgres.migrate import migrate


@unittest.skipUnless(ADMIN_DSN, "PRSYSTEM_TEST_ADMIN_DSN is not set")
class PostgresCashTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.database = "prsystem_test_" + uuid4().hex
        cls.role = "cash_test_" + uuid4().hex
        password = uuid4().hex
        with psycopg.connect(ADMIN_DSN, autocommit=True) as conn:
            conn.execute(sql.SQL("CREATE ROLE {} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD {}")
                         .format(sql.Identifier(cls.role), sql.Literal(password)))
            conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(cls.database)))
        cls.addClassCleanup(cls.cleanup_database)
        cls.owner_dsn = make_conninfo(ADMIN_DSN, dbname=cls.database)
        cls.app_dsn = make_conninfo(cls.owner_dsn, user=cls.role, password=password)
        migrate(cls.owner_dsn)
        migrate(cls.owner_dsn)  # Already-applied migrations must be a no-op.
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                "GRANT USAGE ON SCHEMA prsystem TO {}",
                "GRANT SELECT ON prsystem.cash_book, prsystem.cash_drawer, prsystem.cash_transfer, "
                "prsystem.cash_event, prsystem.cash_receipt, prsystem.cash_outbox TO {}",
                "GRANT UPDATE (revision) ON prsystem.cash_book TO {}",
                "GRANT UPDATE (posted, reserved) ON prsystem.cash_drawer TO {}",
                "GRANT UPDATE (state) ON prsystem.cash_transfer TO {}",
                "GRANT INSERT ON prsystem.cash_transfer, prsystem.cash_event, "
                "prsystem.cash_receipt, prsystem.cash_outbox TO {}",
            ):
                conn.execute(sql.SQL(grant).format(sql.Identifier(cls.role)))

    @classmethod
    def cleanup_database(cls):
        with psycopg.connect(ADMIN_DSN, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(cls.database)))
            conn.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(cls.role)))

    def setUp(self):
        self.tenant = uuid4().hex
        self.other = uuid4().hex
        with psycopg.connect(self.owner_dsn) as conn:
            for tenant in (self.tenant, self.other):
                conn.execute("INSERT INTO prsystem.cash_book (tenant_id) VALUES (%s)", (tenant,))
                conn.execute("""INSERT INTO prsystem.cash_drawer (tenant_id, id, shift_id, posted)
                    VALUES (%s, 'a', 'sa', 100000), (%s, 'b', 'sb', 0)""", (tenant, tenant))
        # Test-only authorization fixture. Production must supply the real policy.
        self.allowed = True
        self.adapter = PostgresCash(self.app_dsn, authorize=lambda conn, cmd, ctx:
                                    self.allowed and ctx.actor_id == "actor" and ctx.tenant_id == self.tenant)
        self.ctx = CashContext(self.tenant, "actor", "reserve", 0,
                               datetime(2026, 9, 6, tzinfo=timezone.utc), False, "sa")
        self.reserve = ReserveTransfer("t", "a", "b", 80000)

    def snapshot(self, tenant=None):
        with psycopg.connect(self.owner_dsn) as conn:
            tenant = tenant or self.tenant
            result = {}
            for table in ("cash_book", "cash_drawer", "cash_transfer", "cash_event", "cash_receipt", "cash_outbox"):
                result[table] = conn.execute(sql.SQL("SELECT * FROM prsystem.{} WHERE tenant_id = %s ORDER BY 1, 2")
                                            .format(sql.Identifier(table)), (tenant,)).fetchall()
            return result

    def test_reserve_confirm_paired_posting_and_outbox(self):
        self.assertEqual(self.adapter.execute(self.reserve, self.ctx).revision, 1)
        result = self.adapter.execute(ConfirmTransfer("t", 80000),
            replace(self.ctx, idempotency_key="confirm", expected_revision=1, shift_id="sb"))
        self.assertEqual(result.revision, 2)
        state = self.snapshot()
        self.assertEqual([row[3:] for row in state["cash_drawer"]], [(20000, 0), (80000, 0)])
        self.assertEqual(state["cash_transfer"][0][-1], "COMPLETED")
        self.assertEqual(len(state["cash_event"]), 3)
        self.assertEqual(sum(row[7] for row in state["cash_event"]), 0)
        self.assertEqual(len(state["cash_receipt"]), 2)
        self.assertEqual(len(state["cash_outbox"]), 2)

    def test_replay_returns_original_revision_without_new_posting(self):
        self.adapter.execute(self.reserve, self.ctx)
        self.adapter.execute(CancelTransfer("t", 80000, "returned"),
                             replace(self.ctx, idempotency_key="cancel", expected_revision=1))
        before = self.snapshot()
        result = self.adapter.execute(self.reserve, self.ctx)
        self.assertTrue(result.replayed)
        self.assertEqual(result.revision, 1)
        self.assertEqual(self.snapshot(), before)

    def test_replay_payload_conflict_and_invalid_numeric_types(self):
        self.adapter.execute(self.reserve, self.ctx)
        for amount, error in [(70000, "IDEMPOTENCY_CONFLICT"), (80000.0, "INVALID_MNT"), (True, "INVALID_MNT")]:
            with self.subTest(amount=amount), self.assertRaisesRegex(DomainError, error):
                self.adapter.execute(replace(self.reserve, amount=amount), self.ctx)

    def test_revoked_authorization_denies_even_replay(self):
        self.adapter.execute(self.reserve, self.ctx)
        self.allowed = False
        before = self.snapshot()
        with self.assertRaisesRegex(DomainError, "FORBIDDEN"):
            self.adapter.execute(self.reserve, replace(self.ctx, authorized=True))
        self.assertEqual(self.snapshot(), before)

    def test_cross_tenant_command_denied_by_authorizer(self):
        before = self.snapshot(self.other)
        with self.assertRaisesRegex(DomainError, "FORBIDDEN"):
            self.adapter.execute(self.reserve, replace(self.ctx, tenant_id=self.other, authorized=True))
        self.assertEqual(self.snapshot(self.other), before)

    def test_concurrent_last_cash_has_one_winner_and_safe_retry(self):
        barrier = Barrier(2)
        commands = [self.reserve, SpendCash("a", 50000, "expense", "approved")]

        def run(index):
            barrier.wait(timeout=10)
            try:
                return self.adapter.execute(commands[index], replace(self.ctx, idempotency_key=str(index)))
            except DomainError as exc:
                return str(exc)

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(run, range(2)))
        self.assertEqual(results.count("REVISION_CONFLICT"), 1)
        loser = results.index("REVISION_CONFLICT")
        before = self.snapshot()
        with self.assertRaisesRegex(DomainError, "INSUFFICIENT_AVAILABLE_CASH"):
            self.adapter.execute(commands[loser], replace(self.ctx, idempotency_key=str(loser), expected_revision=1))
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(len(before["cash_event"]), 1)

    def test_concurrent_duplicate_posts_once(self):
        barrier = Barrier(2)

        def run(_):
            barrier.wait(timeout=10)
            return self.adapter.execute(self.reserve, self.ctx)

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(run, range(2)))
        self.assertEqual(sum(result.replayed for result in results), 1)
        self.assertEqual(len(self.snapshot()["cash_event"]), 1)
        self.assertEqual(len(self.snapshot()["cash_outbox"]), 1)

    def test_financial_reference_and_terminal_transfer_cannot_repeat(self):
        debit = SpendCash("a", 10000, "expense", "approved")
        self.adapter.execute(debit, self.ctx)
        with self.assertRaisesRegex(DomainError, "FINANCIAL_REFERENCE_EXISTS"):
            self.adapter.execute(debit, replace(self.ctx, idempotency_key="again", expected_revision=1))
        self.adapter.execute(self.reserve, replace(self.ctx, idempotency_key="transfer", expected_revision=1))
        self.adapter.execute(CancelTransfer("t", 80000, "returned"),
                             replace(self.ctx, idempotency_key="cancel", expected_revision=2))
        with self.assertRaisesRegex(DomainError, "TRANSFER_TERMINAL"):
            self.adapter.execute(ConfirmTransfer("t", 80000),
                                 replace(self.ctx, idempotency_key="confirm", expected_revision=3, shift_id="sb"))

    def test_deferred_commit_failure_rolls_back_every_table(self):
        before = self.snapshot()
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("""CREATE FUNCTION prsystem.fail_cash_commit() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN RAISE EXCEPTION 'injected commit failure'; END; $$""")
            conn.execute("""CREATE CONSTRAINT TRIGGER fail_cash_commit AFTER INSERT ON prsystem.cash_outbox
                DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.fail_cash_commit()""")
        try:
            with self.assertRaisesRegex(psycopg.errors.RaiseException, "injected commit failure"):
                self.adapter.execute(self.reserve, self.ctx)
            self.assertEqual(self.snapshot(), before)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute("DROP TRIGGER fail_cash_commit ON prsystem.cash_outbox")
                conn.execute("DROP FUNCTION prsystem.fail_cash_commit()")
        self.assertEqual(self.adapter.execute(self.reserve, self.ctx).revision, 1)

    def test_rls_filters_reads_rejects_writes_and_resets_after_commit(self):
        with psycopg.connect(self.app_dsn, autocommit=True) as conn:
            self.assertEqual(conn.execute("SELECT * FROM prsystem.cash_drawer").fetchall(), [])
            with conn.transaction():
                conn.execute("SELECT set_config('prsystem.tenant_id', %s, true)", (self.tenant,))
                rows = conn.execute("SELECT tenant_id FROM prsystem.cash_drawer").fetchall()
                self.assertEqual(rows, [(self.tenant,), (self.tenant,)])
                self.assertEqual(conn.execute("UPDATE prsystem.cash_drawer SET posted = 0 WHERE tenant_id = %s",
                                              (self.other,)).rowcount, 0)
            self.assertEqual(conn.execute("SELECT * FROM prsystem.cash_drawer").fetchall(), [])
            with self.assertRaises(psycopg.errors.InsufficientPrivilege), conn.transaction():
                conn.execute("SELECT set_config('prsystem.tenant_id', %s, true)", (self.tenant,))
                conn.execute("""INSERT INTO prsystem.cash_transfer VALUES
                    (%s, 'bad', 'a', 'b', 'sa', 'sb', 1, 'PENDING')""", (self.other,))

    def test_cross_tenant_foreign_key_rejected(self):
        with psycopg.connect(self.owner_dsn) as conn:
            conn.execute("INSERT INTO prsystem.cash_drawer VALUES (%s, 'other-only', 'sc', 0, 0)", (self.other,))
        with psycopg.connect(self.app_dsn) as conn:
            conn.execute("SELECT set_config('prsystem.tenant_id', %s, true)", (self.tenant,))
            with self.assertRaises(psycopg.errors.ForeignKeyViolation), conn.transaction():
                conn.execute("""INSERT INTO prsystem.cash_transfer VALUES
                    (%s, 'bad', 'a', 'other-only', 'sa', 'sc', 1, 'PENDING')""", (self.tenant,))

    def test_runtime_cannot_rewrite_audit_receipts_or_schema(self):
        self.adapter.execute(self.reserve, self.ctx)
        statements = [
            "UPDATE prsystem.cash_event SET reference = 'tampered'",
            "DELETE FROM prsystem.cash_receipt",
            "UPDATE prsystem.cash_outbox SET topic = 'tampered'",
            "UPDATE prsystem.cash_drawer SET shift_id = 'tampered'",
            "UPDATE prsystem.cash_transfer SET amount = 1",
            "CREATE TABLE prsystem.tampered (id int)",
        ]
        with psycopg.connect(self.app_dsn, autocommit=True) as conn:
            for statement in statements:
                with self.subTest(statement=statement), self.assertRaises(psycopg.errors.InsufficientPrivilege), conn.transaction():
                    conn.execute("SELECT set_config('prsystem.tenant_id', %s, true)", (self.tenant,))
                    conn.execute(statement)

    def test_superuser_connection_is_rejected(self):
        unsafe = PostgresCash(self.owner_dsn, authorize=lambda *args: True)
        with self.assertRaisesRegex(DomainError, "UNSAFE_DATABASE_ROLE"):
            unsafe.execute(self.reserve, self.ctx)

    def test_migration_checksum_mismatch_is_rejected(self):
        with psycopg.connect(self.owner_dsn) as conn:
            original = conn.execute("SELECT checksum FROM prsystem.schema_migrations").fetchone()[0]
            conn.execute("UPDATE prsystem.schema_migrations SET checksum = 'tampered'")
        try:
            with self.assertRaisesRegex(RuntimeError, "Migration checksum changed"):
                migrate(self.owner_dsn)
        finally:
            with psycopg.connect(self.owner_dsn) as conn:
                conn.execute("UPDATE prsystem.schema_migrations SET checksum = %s", (original,))
