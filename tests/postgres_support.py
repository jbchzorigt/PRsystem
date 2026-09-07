"""Disposable PostgreSQL database with a restricted cash application role."""

import os
import unittest
from uuid import uuid4

ADMIN_DSN = os.environ.get("PRSYSTEM_TEST_ADMIN_DSN")
if ADMIN_DSN:
    import psycopg
    from psycopg import sql
    from psycopg.conninfo import make_conninfo
    from prsystem.postgres.migrate import migrate


class PostgresCase(unittest.TestCase):
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
        migrate(cls.owner_dsn)
        with psycopg.connect(cls.owner_dsn) as conn:
            for grant in (
                "GRANT USAGE ON SCHEMA prsystem TO {}",
                "GRANT SELECT ON prsystem.cash_book, prsystem.cash_drawer, prsystem.cash_transfer, "
                "prsystem.cash_event, prsystem.cash_receipt, prsystem.cash_outbox TO {}",
                "GRANT SELECT ON prsystem.staff_open_work TO {}",
                "GRANT SELECT ON prsystem.reception_shift,prsystem.shift_handover TO {}",
                "GRANT SELECT (tenant_id,id,drawer_id,shift_id,amount_mnt,state) ON prsystem.guest_refund TO {}",
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
