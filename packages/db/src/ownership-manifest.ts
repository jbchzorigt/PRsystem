import { GROUP_ROLES, LOGIN_PRINCIPALS, projectRoles } from './roles';

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
};

/**
 * Functions whose owner is deliberately *not* the DDL owner, keyed by exact
 * signature.
 *
 * By `schema.name` alone, an added overload inherited the exception: creating a
 * second `platform.schedule_maintenance_job(...)` with different arguments and
 * giving it to `prsystem_maintenance_fn` matched the entry for the real one and
 * passed. PostgreSQL identifies a function by its argument types, so the
 * manifest does too — an overload nobody declared falls under the default owner
 * and is refused there.
 */
export const FUNCTION_OWNERSHIP_MANIFEST: Readonly<Record<string, string>> = {
  // Append-only audit writers.
  'audit.append_platform_audit_event(p_action text, p_outcome text, p_target_type text, p_target_ref text, p_reason text, p_payload jsonb)':
    KERNEL_OWNERS.auditWriter,
  'police_audit.append_police_security_event(p_action text, p_outcome text, p_case_ref text, p_reason text, p_payload jsonb)':
    KERNEL_OWNERS.auditWriter,

  // Partition maintenance.
  'platform.ensure_month_partitions(p_schema text, p_table text, p_from timestamp with time zone, p_months integer)':
    KERNEL_OWNERS.partitionMgr,
  'platform.partition_horizon(p_schema text, p_table text)': KERNEL_OWNERS.partitionMgr,
  'platform.check_partition_horizon(p_threshold integer)': KERNEL_OWNERS.partitionMgr,

  // D-09 scheduler and maintenance wrappers.
  'platform.assert_exact_role_closure(p_login text, p_group text)': KERNEL_OWNERS.maintenanceFn,
  'platform.schedule_maintenance_job(p_job_name text, p_hotel_id uuid, p_executor_identity text)':
    KERNEL_OWNERS.maintenanceFn,
  'platform.begin_worker_job(p_job_name text, p_hotel_id uuid)': KERNEL_OWNERS.maintenanceFn,
  'platform.finish_worker_job(p_job_run_id uuid, p_state text, p_error_name text)':
    KERNEL_OWNERS.maintenanceFn,
  'platform.maintenance_expire_idempotency_keys(p_job_run_id uuid)': KERNEL_OWNERS.maintenanceFn,
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

/**
 * The three narrow owners, which own only what the manifest names.
 *
 * They were excluded from the reverse census entirely, so any of them could own
 * an arbitrary relation or function anywhere outside the kernel schemas — in
 * `public`, or in a schema an operator created — and nothing looked. Owning an
 * object means being able to drop it, disable its RLS and re-grant it, so
 * "narrow owner" has to mean narrow everywhere, not narrow inside five schemas.
 */
export const NARROW_OWNERS: readonly string[] = [
  KERNEL_OWNERS.auditWriter,
  KERNEL_OWNERS.partitionMgr,
  KERNEL_OWNERS.maintenanceFn,
];

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
 * not kernel objects. `pg_depend` is the catalogue's own record of that, so the
 * exclusion is a fact rather than a name list to maintain.
 *
 * The dependency is matched on its full identity — `classid`, `objid`,
 * `objsubid`, `refclassid` and `deptype`. OIDs are unique within a catalogue and
 * not across them, so `objid = c.oid` alone compares an OID from `pg_class`
 * against OIDs recorded for `pg_proc`, `pg_type` and every other catalogue.
 *
 * This exclusion governs which objects the *expected-owner* comparison covers.
 * It is not an exemption from the narrow-owner census, which reports extension
 * membership and refuses regardless.
 */
const MANIFEST_QUERY = `
  -- ::text on every name. The first branch of a UNION fixes the column type,
  -- and pg_database.datname is of type name, which truncates at 63 bytes: long
  -- enough to cut a function signature in half and make it match nothing.
  SELECT 'database'::text AS kind, d.datname::text AS name,
         pg_get_userbyid(d.datdba)::text AS owner, NULL::text AS parent, false AS secdef
    FROM pg_database d
   WHERE d.datname = current_database()
  UNION ALL
  SELECT 'schema', n.nspname::text, pg_get_userbyid(n.nspowner)::text, NULL, false
    FROM pg_namespace n
   WHERE n.nspname = ANY($1) OR n.nspname = 'public'
  UNION ALL
  SELECT 'relation', n.nspname || '.' || c.relname, pg_get_userbyid(c.relowner)::text,
         (SELECT pn.nspname || '.' || pc.relname
            FROM pg_inherits i
            JOIN pg_class pc ON pc.oid = i.inhparent
            JOIN pg_namespace pn ON pn.oid = pc.relnamespace
           WHERE i.inhrelid = c.oid),
         false
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = ANY($1)
     AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
     AND NOT EXISTS (
       SELECT 1 FROM pg_depend e
        WHERE e.classid = 'pg_class'::regclass
          AND e.objid = c.oid
          AND e.objsubid = 0
          AND e.refclassid = 'pg_extension'::regclass
          AND e.deptype = 'e')
  UNION ALL
  SELECT 'function',
         n.nspname || '.' || p.proname || '(' ||
           pg_get_function_identity_arguments(p.oid) || ')',
         pg_get_userbyid(p.proowner)::text, NULL, p.prosecdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = ANY($1)
     AND NOT EXISTS (
       SELECT 1 FROM pg_depend e
        WHERE e.classid = 'pg_proc'::regclass
          AND e.objid = p.oid
          AND e.objsubid = 0
          AND e.refclassid = 'pg_extension'::regclass
          AND e.deptype = 'e')
  ORDER BY 1, 2`;

/**
 * Every object a role owns, from PostgreSQL's own ownership dependency.
 *
 * `pg_shdepend` with `deptype = 'o'` and `refclassid = pg_authid` *is* the
 * catalogue's record of ownership, so it covers every ownable class rather than
 * the three a hand-written scan happened to query. Foreign tables, enums,
 * domains, composite types, foreign data wrappers, servers, extensions and
 * everything else arrive without being enumerated here — which is the point: a
 * class nobody thought of is reported rather than silently skipped.
 *
 * `class` is the catalogue the object lives in. `name` is resolved for the
 * classes this census knows how to name, and is null otherwise, which the
 * caller treats as a failure: an unrecognised ownable class must fail closed.
 *
 * Extension membership is reported, not used as an exemption. It is matched on
 * the full dependency identity — `classid`, `objid`, `refclassid` and
 * `deptype` — because OIDs are unique per catalogue and not across them, so
 * matching on `objid` alone compares an OID from one catalogue against an OID
 * from another.
 */
const OWNERSHIP_CENSUS_QUERY = `
  WITH owned AS (
    SELECT d.classid, d.objid, r.rolname AS owner
      FROM pg_shdepend d
      JOIN pg_roles r ON r.oid = d.refobjid
     WHERE d.deptype = 'o'
       AND d.refclassid = 'pg_authid'::regclass
       AND d.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
       AND r.rolname = ANY($1)
  )
  SELECT o.owner::text AS owner,
         o.classid::regclass::text AS class,
         CASE o.classid
           WHEN 'pg_class'::regclass THEN (
             SELECT n.nspname || '.' || c.relname
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.oid = o.objid)
           WHEN 'pg_proc'::regclass THEN (
             SELECT n.nspname || '.' || p.proname || '(' ||
                    pg_get_function_identity_arguments(p.oid) || ')'
               FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE p.oid = o.objid)
           WHEN 'pg_namespace'::regclass THEN (
             SELECT n.nspname FROM pg_namespace n WHERE n.oid = o.objid)
           WHEN 'pg_type'::regclass THEN (
             SELECT n.nspname || '.' || t.typname
               FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
              WHERE t.oid = o.objid)
           WHEN 'pg_extension'::regclass THEN (
             SELECT e.extname FROM pg_extension e WHERE e.oid = o.objid)
           WHEN 'pg_database'::regclass THEN (
             SELECT d2.datname FROM pg_database d2 WHERE d2.oid = o.objid)
           ELSE NULL
         END::text AS name,
         (SELECT c.relkind::text FROM pg_class c WHERE c.oid = o.objid
           AND o.classid = 'pg_class'::regclass) AS relkind,
         (SELECT pn.nspname || '.' || pc.relname
            FROM pg_inherits i
            JOIN pg_class pc ON pc.oid = i.inhparent
            JOIN pg_namespace pn ON pn.oid = pc.relnamespace
           WHERE i.inhrelid = o.objid AND o.classid = 'pg_class'::regclass)::text AS parent,
         (SELECT e.extname
            FROM pg_depend dep
            JOIN pg_extension e ON e.oid = dep.refobjid
           WHERE dep.classid = o.classid
             AND dep.objid = o.objid
             AND dep.objsubid = 0
             AND dep.refclassid = 'pg_extension'::regclass
             AND dep.deptype = 'e')::text AS extension
    FROM owned o
   ORDER BY 1, 2, 3`;

/**
 * Every owned object located in a kernel schema, whoever owns it.
 *
 * The restricted-role census enumerates objects owned by a role that must own
 * nothing or own only what the manifest names, so an *external* role is outside
 * it. The expected-owner comparison enumerates schemas, relations and functions,
 * so an enum, a domain, a composite type or extended statistics is outside that.
 * An arbitrary role owning an omitted class inside `platform` passed both.
 *
 * `pg_identify_object` names any catalogue object generically, so this covers
 * classes nobody enumerated rather than the three somebody remembered.
 */
const KERNEL_OBJECT_CENSUS_QUERY = `
  SELECT r.rolname::text AS owner,
         d.classid::regclass::text AS class,
         o.type::text AS object_type,
         CASE d.classid
           WHEN 'pg_proc'::regclass THEN (
             SELECT n.nspname || '.' || p.proname || '(' ||
                    pg_get_function_identity_arguments(p.oid) || ')'
               FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE p.oid = d.objid)
           WHEN 'pg_class'::regclass THEN (
             SELECT n.nspname || '.' || c.relname
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.oid = d.objid)
           ELSE o.identity
         END::text AS name,
         (SELECT pn.nspname || '.' || pc.relname
            FROM pg_inherits i
            JOIN pg_class pc ON pc.oid = i.inhparent
            JOIN pg_namespace pn ON pn.oid = pc.relnamespace
           WHERE i.inhrelid = d.objid AND d.classid = 'pg_class'::regclass)::text AS parent
    FROM pg_shdepend d
    JOIN pg_roles r ON r.oid = d.refobjid
    CROSS JOIN LATERAL pg_identify_object(d.classid, d.objid, d.objsubid) o
   WHERE d.deptype = 'o'
     AND d.refclassid = 'pg_authid'::regclass
     AND d.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
     AND o.schema = ANY($1)
   ORDER BY 1, 2, 4`;

interface KernelObjectRow {
  readonly owner: string;
  readonly class: string;
  readonly object_type: string;
  readonly name: string | null;
  readonly parent: string | null;
}

interface CensusRow {
  readonly owner: string;
  readonly class: string;
  readonly name: string | null;
  readonly relkind: string | null;
  readonly parent: string | null;
  readonly extension: string | null;
}

export interface ManifestClient {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

/** Raised when ownership has drifted, before any new DDL is applied. */
export class MigrationOwnershipError extends Error {
  override readonly name = 'MigrationOwnershipError';
}

/** The owner every object is required to have. */
export function expectedOwnerOf(object: Pick<OwnedObject, 'kind' | 'name' | 'parent'>): string {
  // Functions are keyed by exact signature. An overload nobody declared falls
  // here, under the default owner, rather than inheriting the exception granted
  // to a function that merely shares its name.
  const table = object.kind === 'function' ? FUNCTION_OWNERSHIP_MANIFEST : OWNERSHIP_MANIFEST;
  const direct = table[object.name];
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

  // One census, over PostgreSQL's own ownership dependency, for every role that
  // must own nothing and every narrow owner. `pg_shdepend` covers every ownable
  // class, so a foreign table, an enum, a domain, a composite type or a class
  // nobody anticipated arrives here instead of being missed by a hand-written
  // scan of three catalogues.
  const censusRoles = [...rolesThatOwnNothing(), ...NARROW_OWNERS];
  const census = await client.query<CensusRow>(OWNERSHIP_CENSUS_QUERY, [censusRoles]);
  const ownsNothing = rolesThatOwnNothing();

  for (const row of census.rows) {
    // An ownable class this census cannot name is a class it cannot judge.
    // Skipping it silently is how foreign tables and types went unseen.
    if (row.name === null) {
      throw new MigrationOwnershipError(
        `${row.owner} owns an object of class ${row.class} that the ownership census cannot ` +
          'identify. Unrecognised ownable classes fail closed: extend the census rather than ' +
          'letting the object through unjudged',
      );
    }

    if (ownsNothing.has(row.owner)) {
      throw new MigrationOwnershipError(
        `${row.class} ${row.name} is owned by ${row.owner}, which must own nothing: ` +
          'no runtime, reader, scheduler, break-glass or login role may own any object',
      );
    }

    // A narrow owner holds only what the manifest names, or a partition
    // descendant of something it names. Extension membership is reported for
    // diagnosis and is deliberately not an exemption: an extension function
    // handed to a narrow owner is still an object the manifest never granted it.
    const declared =
      row.class === 'pg_proc'
        ? FUNCTION_OWNERSHIP_MANIFEST[row.name] === row.owner
        : OWNERSHIP_MANIFEST[row.name] === row.owner ||
          (row.parent !== null && OWNERSHIP_MANIFEST[row.parent] === row.owner);
    if (declared) continue;

    throw new MigrationOwnershipError(
      `${row.class} ${row.name} is owned by ${row.owner}, which owns only what the manifest ` +
        'names: a narrow owner may hold nothing else, in any schema' +
        (row.extension === null
          ? ''
          : ` (it belongs to extension ${row.extension}, which is ` + 'not an exemption)'),
    );
  }

  // Everything inside a kernel schema, whoever owns it, held to the exact
  // expected-owner rule.
  const kernelObjects = await client.query<KernelObjectRow>(KERNEL_OBJECT_CENSUS_QUERY, [
    [...KERNEL_SCHEMAS],
  ]);
  for (const row of kernelObjects.rows) {
    if (row.name === null) {
      throw new MigrationOwnershipError(
        `an object of class ${row.class} (${row.object_type}) in a kernel schema cannot be ` +
          'identified by the ownership census. Unrecognised classes fail closed: extend the ' +
          'census rather than letting the object through unjudged',
      );
    }
    const expected =
      row.class === 'pg_proc'
        ? (FUNCTION_OWNERSHIP_MANIFEST[row.name] ?? DEFAULT_KERNEL_OWNER)
        : (OWNERSHIP_MANIFEST[row.name] ??
          (row.parent === null ? undefined : OWNERSHIP_MANIFEST[row.parent]) ??
          DEFAULT_KERNEL_OWNER);
    if (row.owner === expected) continue;
    throw new MigrationOwnershipError(
      `${row.object_type} ${row.name} (class ${row.class}) in a kernel schema is owned by ` +
        `${row.owner}; the manifest requires ${expected}`,
    );
  }

  const objects = await client.query<OwnedObject>(MANIFEST_QUERY, [[...KERNEL_SCHEMAS]]);

  const databaseRow = objects.rows.find((row) => row.kind === 'database');
  if (databaseRow === undefined) {
    throw new MigrationOwnershipError('could not read the owner of the current database');
  }

  // No project role, whatever the allow-list says.
  //
  // The approved-operator list used to be the only gate here, so approving
  // `prsystem_migrate` or `prsystem_maintenance_fn` made a kernel owner the
  // database owner — while bootstrap forbade every project role at the same
  // position unconditionally. The two checks disagreed about one invariant. The
  // list is a tightening on top of this rule, never a way around it.
  const project = projectRoles();
  if (project.has(databaseRow.owner)) {
    throw new MigrationOwnershipError(
      `database ${databaseRow.name} is owned by the project role ${databaseRow.owner}, which ` +
        'must own nothing at this position: no group role or canonical login may own the ' +
        'database or schema public, whatever PRSYSTEM_APPROVED_OPERATOR_OWNERS names',
    );
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
      if (project.has(row.owner)) {
        throw new MigrationOwnershipError(
          `schema public is owned by the project role ${row.owner}, which must own nothing at ` +
            'this position: no group role or canonical login may own the database or schema ' +
            'public, whatever PRSYSTEM_APPROVED_OPERATOR_OWNERS names',
        );
      }
      // `pg_database_owner` resolves to the database owner, already checked above.
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
