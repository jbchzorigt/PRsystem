import { GROUP_ROLES, LOGIN_PRINCIPALS } from './bootstrap';

/**
 * The exact ownership contract for every object a migration creates.
 *
 * Ownership carries implicit rights that no grant reconciliation takes back: an
 * owner can drop the object, disable its RLS, and re-grant it to anybody. So it
 * is not enough to check that an owner is *one of* the four kernel owner roles —
 * `prsystem_maintenance_fn` owning `platform.job_run` would pass that test and
 * would hand the maintenance function owner the ability to rewrite the job
 * ledger it is supposed to be constrained by. Every object has one expected
 * owner, named here.
 */

export const KERNEL_OWNERS = {
  /** DDL owner. Owns everything not listed as an exception below. */
  migrate: 'prsystem_migrate',
  /** Owns the two append-only audit writers and nothing else. */
  auditWriter: 'prsystem_audit_writer',
  /** Owns the partitioned audit parents, their partitions, and the partition functions. */
  partitionMgr: 'prsystem_partition_mgr',
  /** Owns the D-09 scheduler and maintenance wrappers. */
  maintenanceFn: 'prsystem_maintenance_fn',
} as const;

/** Schemas the migration owns end to end. `public` is handled separately. */
export const KERNEL_SCHEMAS = ['platform', 'audit', 'police_audit', 'police', 'drizzle'] as const;

/** Everything in a kernel schema that is not named below belongs to the DDL owner. */
export const DEFAULT_KERNEL_OWNER: string = KERNEL_OWNERS.migrate;

/**
 * Objects whose owner is deliberately *not* the DDL owner.
 *
 * Keyed by `schema.name`. A partition's expected owner is its parent's, resolved
 * through `pg_inherits` rather than by name pattern, because partition names are
 * generated per month and a name-shaped rule stops covering them the moment the
 * naming changes.
 */
export const OWNERSHIP_MANIFEST: Readonly<Record<string, string>> = {
  // Partitioned audit parents. Their partitions inherit this expectation.
  'audit.platform_event': KERNEL_OWNERS.partitionMgr,
  'police_audit.security_event': KERNEL_OWNERS.partitionMgr,

  // Append-only audit writers.
  'audit.append_platform_audit_event': KERNEL_OWNERS.auditWriter,
  'police_audit.append_police_security_event': KERNEL_OWNERS.auditWriter,

  // Partition maintenance.
  'platform.ensure_month_partitions': KERNEL_OWNERS.partitionMgr,
  'platform.partition_horizon': KERNEL_OWNERS.partitionMgr,
  'platform.check_partition_horizon': KERNEL_OWNERS.partitionMgr,

  // D-09 scheduler and maintenance wrappers.
  'platform.assert_exact_role_closure': KERNEL_OWNERS.maintenanceFn,
  'platform.schedule_maintenance_job': KERNEL_OWNERS.maintenanceFn,
  'platform.begin_worker_job': KERNEL_OWNERS.maintenanceFn,
  'platform.finish_worker_job': KERNEL_OWNERS.maintenanceFn,
  'platform.maintenance_expire_idempotency_keys': KERNEL_OWNERS.maintenanceFn,
};

/**
 * Roles that must own nothing at all, anywhere in the database.
 *
 * Every project role that is not one of the four kernel owners: the runtimes,
 * both readers, the D-09 scheduler, the break-glass role and every canonical
 * login. Checked across the whole database rather than the kernel schemas, so a
 * runtime role that acquired ownership of something in `public` is caught too.
 */
export function rolesThatOwnNothing(): ReadonlySet<string> {
  const owners = new Set<string>(Object.values(KERNEL_OWNERS));
  return new Set(
    [...GROUP_ROLES, ...Object.keys(LOGIN_PRINCIPALS)].filter((role) => !owners.has(role)),
  );
}

/** PostgreSQL's own owner of `public` since 15. Resolves to the database owner. */
export const PG_DATABASE_OWNER = 'pg_database_owner';

export interface OwnedObject {
  readonly kind: 'database' | 'schema' | 'relation' | 'function';
  readonly name: string;
  readonly owner: string;
  /** For a partition, its parent's qualified name. Null otherwise. */
  readonly parent: string | null;
  readonly secdef: boolean;
}

/**
 * Every object the manifest covers, in one query.
 *
 * Extension members are excluded: `btree_gist` and `pgcrypto` install their
 * functions into `public` owned by whoever ran `CREATE EXTENSION`, and those are
 * not kernel objects. `pg_depend.deptype = 'e'` is the catalogue's own record of
 * that, so the exclusion is a fact rather than a name list to maintain.
 */
const MANIFEST_QUERY = `
  SELECT 'database'::text AS kind, d.datname AS name,
         pg_get_userbyid(d.datdba) AS owner, NULL::text AS parent, false AS secdef
    FROM pg_database d
   WHERE d.datname = current_database()
  UNION ALL
  SELECT 'schema', n.nspname, pg_get_userbyid(n.nspowner), NULL, false
    FROM pg_namespace n
   WHERE n.nspname = ANY($1) OR n.nspname = 'public'
  UNION ALL
  SELECT 'relation', n.nspname || '.' || c.relname, pg_get_userbyid(c.relowner),
         (SELECT pn.nspname || '.' || pc.relname
            FROM pg_inherits i
            JOIN pg_class pc ON pc.oid = i.inhparent
            JOIN pg_namespace pn ON pn.oid = pc.relnamespace
           WHERE i.inhrelid = c.oid),
         false
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = ANY($1)
     AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
     AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.objid = c.oid AND e.deptype = 'e')
  UNION ALL
  SELECT 'function', n.nspname || '.' || p.proname, pg_get_userbyid(p.proowner), NULL, p.prosecdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = ANY($1)
     AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.objid = p.oid AND e.deptype = 'e')
  ORDER BY 1, 2`;

/**
 * Objects owned by a role that must own nothing, anywhere in the database.
 *
 * System schemas are excluded, and so are indexes and TOAST relations: none of
 * those can be given an owner independently of the table they belong to, so
 * reporting them names an artefact instead of the object an operator has to
 * fix. The table itself is still reported.
 */
const STRAY_OWNERSHIP_QUERY = `
  SELECT 'schema'::text AS kind, n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner
    FROM pg_namespace n
   WHERE pg_get_userbyid(n.nspowner) = ANY($1)
     AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
  UNION ALL
  SELECT 'relation', n.nspname || '.' || c.relname, pg_get_userbyid(c.relowner)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE pg_get_userbyid(c.relowner) = ANY($1) AND c.relkind IN ('r','p','v','m','S')
     AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
  UNION ALL
  SELECT 'function', n.nspname || '.' || p.proname, pg_get_userbyid(p.proowner)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE pg_get_userbyid(p.proowner) = ANY($1)
     AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
  UNION ALL
  SELECT 'database', d.datname, pg_get_userbyid(d.datdba)
    FROM pg_database d
   WHERE d.datname = current_database() AND pg_get_userbyid(d.datdba) = ANY($1)
   ORDER BY 1, 2`;

export interface ManifestClient {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

/** Raised when ownership has drifted, before any new DDL is applied. */
export class MigrationOwnershipError extends Error {
  override readonly name = 'MigrationOwnershipError';
}

/** The owner every object is required to have. */
export function expectedOwnerOf(object: Pick<OwnedObject, 'name' | 'parent'>): string {
  const direct = OWNERSHIP_MANIFEST[object.name];
  if (direct !== undefined) return direct;
  if (object.parent !== null) {
    // A partition belongs to whoever owns its parent.
    return OWNERSHIP_MANIFEST[object.parent] ?? DEFAULT_KERNEL_OWNER;
  }
  return DEFAULT_KERNEL_OWNER;
}

/**
 * Validates the whole manifest against the live catalogue.
 *
 * @param approved operator identities allowed to own the database and `public`.
 *        Mandatory: there is no honest default, because the migration principal
 *        never owns the database.
 */
export async function assertOwnershipManifest(
  client: ManifestClient,
  approved: ReadonlySet<string>,
): Promise<void> {
  if (approved.size === 0) {
    throw new MigrationOwnershipError(
      'PRSYSTEM_APPROVED_OPERATOR_OWNERS is required and must name at least one operator ' +
        'identity allowed to own the database. There is no default: the migration principal ' +
        'never owns the database, so any inferred value would either refuse every real ' +
        'deployment or approve every owner.',
    );
  }

  const strays = await client.query<{ kind: string; name: string; owner: string }>(
    STRAY_OWNERSHIP_QUERY,
    [[...rolesThatOwnNothing()]],
  );
  const stray = strays.rows[0];
  if (stray !== undefined) {
    // Ordered and counted. An unordered `rows[0]` reported whichever object the
    // planner happened to return first — for a table it was as likely to name
    // the primary-key index as the table — so the same drift produced different
    // messages on different runs.
    const others = strays.rows.length - 1;
    throw new MigrationOwnershipError(
      `${stray.kind} ${stray.name} is owned by ${stray.owner}, which must own nothing: ` +
        'no runtime, reader, scheduler, break-glass or login role may own any object' +
        (others > 0 ? ` (and ${String(others)} further object(s))` : ''),
    );
  }

  const objects = await client.query<OwnedObject>(MANIFEST_QUERY, [[...KERNEL_SCHEMAS]]);

  const databaseRow = objects.rows.find((row) => row.kind === 'database');
  if (databaseRow === undefined) {
    throw new MigrationOwnershipError('could not read the owner of the current database');
  }
  if (!approved.has(databaseRow.owner)) {
    throw new MigrationOwnershipError(
      `database ${databaseRow.name} is owned by ${databaseRow.owner}, which is not an approved ` +
        `operator owner (approved: ${[...approved].join(', ')})`,
    );
  }

  for (const row of objects.rows) {
    if (row.kind === 'database') continue;

    if (row.kind === 'schema' && row.name === 'public') {
      // `pg_database_owner` resolves to the database owner, already approved above.
      if (row.owner === PG_DATABASE_OWNER || approved.has(row.owner)) continue;
      throw new MigrationOwnershipError(
        `schema public is owned by ${row.owner}, which is not an approved operator owner ` +
          `(approved: ${[...approved].join(', ')})`,
      );
    }

    const expected = expectedOwnerOf(row);
    if (row.owner !== expected) {
      throw new MigrationOwnershipError(
        `${row.kind} ${row.name} is owned by ${row.owner}; the manifest requires ${expected}` +
          (row.secdef ? ' (SECURITY DEFINER)' : ''),
      );
    }
  }
}
