import { resolve } from 'node:path';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { approvedOperatorOwnersFromEnv, projectRoles } from './bootstrap';
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

/** Raised when ownership has drifted, before any new DDL is applied. */
export class MigrationOwnershipError extends Error {
  override readonly name = 'MigrationOwnershipError';
}

export interface MigrationOutcome {
  /** Migrations recorded in the ledger before this run. */
  readonly appliedBefore: number;
  /** Migrations recorded in the ledger after this run. */
  readonly appliedAfter: number;
}

export interface RunMigrationsOptions {
  readonly migrationsFolder?: string;
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
 * Covers the database, schema `public`, the kernel schemas and the objects
 * already inside them. A runtime, reader, scheduler, Police or Worker role that
 * owns any of these holds rights the design never granted and that no ACL
 * reconciliation can revoke.
 */
async function assertMigrationOwnership(client: Client): Promise<void> {
  const approved = approvedOperatorOwnersFromEnv();
  // Two rules, deliberately different in strength.
  //
  // "No project role may own a kernel object" is unconditional: it needs no
  // configuration and it is the property that actually matters.
  //
  // "The owner must be one of these named operators" is an explicit tightening a
  // deployment opts into through PRSYSTEM_APPROVED_OPERATOR_OWNERS. The runner
  // cannot infer it — the migration principal never owns the database, so there
  // is no honest default: one would refuse every real deployment, the other
  // would approve every owner.
  const approvedSet = approved === undefined ? undefined : new Set(approved);

  /** The four roles that legitimately own kernel objects. */
  const kernelOwners = new Set([
    'prsystem_migrate',
    'prsystem_audit_writer',
    'prsystem_partition_mgr',
    'prsystem_maintenance_fn',
  ]);
  // Every project role may own the *database* or `public`: none of them should.
  const forbiddenForDatabase = projectRoles();
  // Kernel schemas and relations are owned by the DDL owner and its three
  // function owners; every other project role — runtime, reader, scheduler,
  // Police, Worker, any login — is drift.
  const forbiddenForKernel = new Set(
    [...forbiddenForDatabase].filter((role) => !kernelOwners.has(role)),
  );

  const owners = await client.query<{ kind: string; name: string; owner: string }>(
    `SELECT 'database' AS kind, d.datname AS name, pg_get_userbyid(d.datdba) AS owner
       FROM pg_database d WHERE d.datname = current_database()
     UNION ALL
     SELECT 'schema', n.nspname, pg_get_userbyid(n.nspowner)
       FROM pg_namespace n
      WHERE n.nspname IN ('public', 'platform', 'audit', 'police_audit', 'police')
     UNION ALL
     SELECT 'relation', n.nspname || '.' || c.relname, pg_get_userbyid(c.relowner)
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('platform', 'audit', 'police_audit', 'police')
        AND c.relkind IN ('r', 'p', 'v', 'm', 'S')`,
  );

  for (const row of owners.rows) {
    const isDatabaseScope =
      row.kind === 'database' || (row.kind === 'schema' && row.name === 'public');
    const forbidden = isDatabaseScope ? forbiddenForDatabase : forbiddenForKernel;
    if (forbidden.has(row.owner)) {
      throw new MigrationOwnershipError(
        `${row.kind} ${row.name} is owned by the project role ${row.owner}; ` +
          `no runtime, reader, scheduler, Police, Worker or login role may own it`,
      );
    }
  }

  // The database and `public` additionally need an approved operator owner.
  // `pg_database_owner` resolves to the database owner, which is checked here.
  for (const row of owners.rows.filter(
    (candidate) =>
      candidate.kind === 'database' || (candidate.kind === 'schema' && candidate.name === 'public'),
  )) {
    if (approvedSet === undefined) continue;
    if (row.owner === 'pg_database_owner') continue;
    if (!approvedSet.has(row.owner)) {
      throw new MigrationOwnershipError(
        `${row.kind} ${row.name} is owned by ${row.owner}, which is not an approved operator ` +
          `owner (approved: ${[...approvedSet].join(', ')}). Set ` +
          `PRSYSTEM_APPROVED_OPERATOR_OWNERS to declare the operator identities this deployment uses.`,
      );
    }
  }

  // And a kernel object's owner must be one of the four, even when the role is
  // not a project role at all.
  for (const row of owners.rows.filter(
    (candidate) =>
      candidate.kind === 'relation' || (candidate.kind === 'schema' && candidate.name !== 'public'),
  )) {
    if (!kernelOwners.has(row.owner)) {
      throw new MigrationOwnershipError(
        `${row.kind} ${row.name} is owned by ${row.owner}, which is not a kernel owner role`,
      );
    }
  }
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
    await assertMigrationOwnership(client);

    // Read *after* the lock: another runner may have applied the journal while
    // this one waited, which is exactly the case that must be a clean no-op.
    const appliedBefore = await ledgerCount(client);
    await migrate(drizzle(client), { migrationsFolder });
    const appliedAfter = await ledgerCount(client);

    await assertMigrationOwnership(client);

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
