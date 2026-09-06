"""Apply packaged migrations atomically with an owner credential, never the app role."""

import hashlib
import os
from importlib.resources import files

import psycopg


def migrate(dsn: str) -> None:
    with psycopg.connect(dsn) as conn:
        conn.execute("SELECT pg_advisory_xact_lock(731910028)")
        conn.execute("CREATE SCHEMA IF NOT EXISTS prsystem")
        conn.execute("""CREATE TABLE IF NOT EXISTS prsystem.schema_migrations (
            name text PRIMARY KEY, checksum text NOT NULL,
            applied_at timestamptz NOT NULL DEFAULT now())""")
        for path in sorted(files("prsystem.postgres").joinpath("migrations").iterdir(),
                           key=lambda item: item.name):
            if not path.name.endswith(".sql"):
                continue
            source = path.read_bytes()
            checksum = hashlib.sha256(source).hexdigest()
            existing = conn.execute(
                "SELECT checksum FROM prsystem.schema_migrations WHERE name = %s",
                (path.name,),
            ).fetchone()
            if existing:
                if existing[0] != checksum:
                    raise RuntimeError(f"Migration checksum changed: {path.name}")
                continue
            conn.execute(source.decode("utf-8"), prepare=False)
            conn.execute("INSERT INTO prsystem.schema_migrations (name, checksum) VALUES (%s, %s)",
                         (path.name, checksum))


if __name__ == "__main__":
    migrate(os.environ["PRSYSTEM_MIGRATION_DSN"])
