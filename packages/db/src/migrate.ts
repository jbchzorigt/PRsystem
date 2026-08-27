import { resolve } from 'node:path';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { assertMigrationPrincipal } from './principal-guard';

/**
 * Versioned migration runner (ADR-0004, CLAUDE.md §10).
 *
 * Versioned SQL files only — schema push is never the migration strategy, and
 * there are no down-migrations.
 *
 * Everything happens on **one physical session**: verify the principal, take a
 * database-wide advisory lock, `SET ROLE` to the DDL group, apply the journal,
 * then reset. The lock is what makes two runners against an empty database safe;
 * the `SET ROLE` is what makes every object owned by `prsystem_migrate` rather
 * than by whichever login happened to run the deploy.
 */

/** Absolute path of the migration folder shipped with this package. */
export const MIGRATIONS_FOLDER = resolve(__dirname, '..', 'migrations');

/** The role every migration-created object must end up owned by. */
export const MIGRATION_ROLE = 'prsystem_migrate';

/**
 * Advisory lock key for journal application. Database-scoped, which is correct:
 * the journal is per database.
 */
export const MIGRATION_LOCK_KEY = 4_021_970_301;

export interface MigrationOutcome {
  /** Migrations recorded in the ledger before this run. */
  readonly appliedBefore: number;
  /** Migrations recorded in the ledger after this run. */
  readonly appliedAfter: number;
}

export interface RunMigrationsOptions {
  readonly migrationsFolder?: string;
  /**
   * Verify the connection is a restricted migration principal before applying
   * anything. Default on, and never off in an application or CI run.
   */
  readonly verifyPrincipal?: boolean;
}

/** Anything that can run a query — a Client or a Pool. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

async function ledgerCount(client: Client): Promise<number> {
  const present = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM information_schema.tables
      WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'`,
  );
  if (present.rows[0]?.count === '0') return 0;

  const applied = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
  );
  return Number(applied.rows[0]?.count ?? '0');
}

export async function runMigrations(
  connectionString: string,
  options: string | RunMigrationsOptions = {},
): Promise<MigrationOutcome> {
  const resolved: RunMigrationsOptions =
    typeof options === 'string' ? { migrationsFolder: options } : options;
  const migrationsFolder = resolved.migrationsFolder ?? MIGRATIONS_FOLDER;

  // A single Client, not a Pool: the advisory lock, the SET ROLE and the journal
  // application must all be the same backend, or the lock protects nothing.
  const client = new Client({ connectionString });
  await client.connect();

  let locked = false;
  try {
    if (resolved.verifyPrincipal ?? true) {
      await assertMigrationPrincipal(client);
    }

    // Session-level: held across the whole journal, released explicitly below.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    locked = true;

    // Objects are owned by the group, never by the deploying login.
    await client.query(`SET ROLE ${MIGRATION_ROLE}`);

    // Read *after* the lock: another runner may have applied the journal while
    // this one waited, which is exactly the case that must be a clean no-op.
    const appliedBefore = await ledgerCount(client);
    await migrate(drizzle(client), { migrationsFolder });
    const appliedAfter = await ledgerCount(client);

    return { appliedBefore, appliedAfter };
  } finally {
    try {
      await client.query('RESET ROLE');
      if (locked) await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } catch {
      // The session is ending either way; the lock dies with it.
    }
    await client.end();
  }
}
