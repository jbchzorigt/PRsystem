import { resolve } from 'node:path';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { approvedOperatorOwnersFromEnv } from './bootstrap';
import { assertMigrationPrincipal } from './principal-guard';
import { MigrationOwnershipError, assertOwnershipManifest } from './ownership-manifest';

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

export { MigrationOwnershipError } from './ownership-manifest';

export interface MigrationOutcome {
  /** Migrations recorded in the ledger before this run. */
  readonly appliedBefore: number;
  /** Migrations recorded in the ledger after this run. */
  readonly appliedAfter: number;
}

export interface RunMigrationsOptions {
  readonly migrationsFolder?: string;
  /**
   * Operator identities allowed to own the database and schema `public`.
   *
   * Defaults to `PRSYSTEM_APPROVED_OPERATOR_OWNERS`. One of the two must be
   * present: the runner refuses to migrate a database whose ownership it has
   * not been told how to judge.
   */
  readonly approvedOperatorOwners?: readonly string[];
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

/**
 * Refuses to migrate a database whose ownership has drifted.
 *
 * Delegates to the exact manifest: every object has one expected owner, not
 * merely an owner drawn from the set of kernel owner roles. Being one of the
 * four was never sufficient — `prsystem_maintenance_fn` owning
 * `platform.job_run` would have passed, and would have handed the maintenance
 * function owner the ability to rewrite the very ledger constraining it.
 */
async function assertMigrationOwnership(
  client: Client,
  approved: ReadonlySet<string>,
): Promise<void> {
  await assertOwnershipManifest(client, approved);
}

/**
 * The approved operator owners for this run, or a refusal.
 *
 * Mandatory. A deployment that has not declared which operator identity owns its
 * database has not declared its ownership contract at all, and a runner that
 * quietly skipped the check in that case would be strictest exactly where it was
 * configured and silent everywhere else.
 */
function requireApprovedOwners(options: RunMigrationsOptions): ReadonlySet<string> {
  const configured = options.approvedOperatorOwners ?? approvedOperatorOwnersFromEnv();
  const names = (configured ?? []).map((name) => name.trim()).filter((name) => name.length > 0);
  if (names.length === 0) {
    throw new MigrationOwnershipError(
      'PRSYSTEM_APPROVED_OPERATOR_OWNERS is required and must name at least one operator ' +
        'identity allowed to own the database. There is no default: the migration principal ' +
        'never owns the database, so any inferred value would either refuse every real ' +
        'deployment or approve every owner. ' +
        'See docs/implementation/database-bootstrap-runbook.md',
    );
  }
  return new Set(names);
}

export async function runMigrations(
  connectionString: string,
  options: string | RunMigrationsOptions = {},
): Promise<MigrationOutcome> {
  const resolved: RunMigrationsOptions =
    typeof options === 'string' ? { migrationsFolder: options } : options;
  const migrationsFolder = resolved.migrationsFolder ?? MIGRATIONS_FOLDER;

  // Before a connection is even opened: missing ownership configuration stops
  // the run, not a later statement.
  const approved = requireApprovedOwners(resolved);

  // A single Client, not a Pool: the advisory lock, the SET ROLE and the journal
  // application must all be the same backend, or the lock protects nothing.
  const client = new Client({ connectionString });
  await client.connect();

  let locked = false;
  try {
    // Unconditional. There is no option to switch this off: an option to skip
    // the principal check in a test is an option to ship with it skipped, and
    // the check is the only thing standing between a mis-set connection string
    // and a migration applied by a superuser.
    await assertMigrationPrincipal(client);

    // Session-level: held across the whole journal, released explicitly below.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    locked = true;

    // Objects are owned by the group, never by the deploying login.
    await client.query(`SET ROLE ${MIGRATION_ROLE}`);

    // Ownership, before a single statement of new DDL runs.
    //
    // The role graph can be perfect while the database itself has been handed to
    // a runtime: ownership carries implicit rights no grant reconciliation takes
    // back, so applying an upgrade onto a drifted database would be creating new
    // objects inside something already escapable. Checked again afterwards,
    // because a migration could in principle change it.
    await assertMigrationOwnership(client, approved);

    // Read *after* the lock: another runner may have applied the journal while
    // this one waited, which is exactly the case that must be a clean no-op.
    const appliedBefore = await ledgerCount(client);
    await migrate(drizzle(client), { migrationsFolder });
    const appliedAfter = await ledgerCount(client);

    await assertMigrationOwnership(client, approved);

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
