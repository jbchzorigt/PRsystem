import { resolve } from 'node:path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

/**
 * Versioned migration runner (ADR-0004, CLAUDE.md §10).
 *
 * Versioned SQL files only — schema push is never the migration strategy, and
 * there are no down-migrations. Drizzle records every applied file in
 * `drizzle.__drizzle_migrations`, so a second run applies nothing: re-running the
 * journal is a safe no-op, which is the `Idempotence` assertion of GATE-MIGR.
 */

/** Absolute path of the migration folder shipped with this package. */
export const MIGRATIONS_FOLDER = resolve(__dirname, '..', 'migrations');

export interface MigrationOutcome {
  /** Migrations recorded in the ledger before this run. */
  readonly appliedBefore: number;
  /** Migrations recorded in the ledger after this run. */
  readonly appliedAfter: number;
}

async function ledgerCount(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM information_schema.tables
      WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'`,
  );
  if (result.rows[0]?.count === '0') {
    return 0;
  }

  const applied = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
  );
  return Number(applied.rows[0]?.count ?? '0');
}

/**
 * Applies every pending migration to `connectionString` and reports how many
 * were recorded before and after. Equal counts mean the run was a no-op.
 */
export async function runMigrations(
  connectionString: string,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<MigrationOutcome> {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const appliedBefore = await ledgerCount(pool);
    await migrate(drizzle(pool), { migrationsFolder });
    const appliedAfter = await ledgerCount(pool);
    return { appliedBefore, appliedAfter };
  } finally {
    await pool.end();
  }
}
