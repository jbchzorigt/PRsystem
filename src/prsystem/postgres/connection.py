"""Owned application transactions with a non-owner PostgreSQL role."""

from contextlib import closing, contextmanager

import psycopg

from prsystem.common import DomainError


@contextmanager
def transaction(dsn):
    with closing(psycopg.connect(dsn, connect_timeout=5)) as conn, conn:
        conn.execute("SET LOCAL lock_timeout = '5s'")
        conn.execute("SET LOCAL statement_timeout = '15s'")
        unsafe = conn.execute("""SELECT r.rolsuper OR r.rolbypassrls OR EXISTS (
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'prsystem' AND c.relkind = 'r'
              AND pg_has_role(current_user, c.relowner, 'USAGE'))
            FROM pg_roles r WHERE r.rolname = current_user""").fetchone()[0]
        if unsafe:
            raise DomainError("UNSAFE_DATABASE_ROLE")
        yield conn
