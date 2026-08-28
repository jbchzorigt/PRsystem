/** Anything that can run a query — a Client or a Pool. Migrations use a single
 *  Client so the guard, the advisory lock and the journal share one backend. */
export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * Connection principal guards.
 *
 * A migration must run as a restricted, non-superuser login that is a member of
 * the DDL group and nothing else. An API or worker must never hold that login,
 * nor an owner, maintenance or DBA credential. Both directions are checked at
 * startup, because a misconfigured connection string is otherwise invisible
 * until it does damage.
 */

export class PrincipalError extends Error {
  override readonly name = 'PrincipalError';

  constructor(
    message: string,
    readonly reason:
      | 'superuser'
      | 'privileged_attribute'
      | 'unexpected_membership'
      | 'missing_membership'
      | 'forbidden_principal',
  ) {
    super(message);
  }
}

/** One role the principal can reach, and the attributes it would bring. */
export interface ReachableRole {
  readonly name: string;
  /** Privileges apply automatically: every edge on some path carries INHERIT. */
  readonly inherited: boolean;
  /** The principal can `SET ROLE` into it, whether or not it inherits. */
  readonly settable: boolean;
  readonly isSuperuser: boolean;
  readonly canCreateRole: boolean;
  readonly canCreateDb: boolean;
  readonly canReplicate: boolean;
  readonly bypassRls: boolean;
}

export interface PrincipalFacts {
  readonly currentUser: string;
  readonly sessionUser: string;
  readonly isSuperuser: boolean;
  readonly canCreateRole: boolean;
  readonly canCreateDb: boolean;
  readonly canReplicate: boolean;
  readonly bypassRls: boolean;
  /**
   * The complete transitive closure, direct and indirect, including PostgreSQL
   * predefined roles and memberships that grant no inherited privilege but can
   * still be assumed with `SET ROLE`.
   */
  readonly reachable: readonly ReachableRole[];
  /** Names only, for convenience. Always `reachable.map(r => r.name)`. */
  readonly memberOf: readonly string[];
}

export async function readPrincipalFacts(pool: Queryable): Promise<PrincipalFacts> {
  const attributes = await pool.query<{
    current_user: string;
    session_user: string;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
  }>(
    `SELECT current_user, session_user,
            r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls
       FROM pg_roles r
      WHERE r.rolname = session_user`,
  );

  const row = attributes.rows[0];
  if (row === undefined) throw new PrincipalError('session role not found', 'forbidden_principal');

  // The complete transitive closure, computed in the database.
  //
  // Three earlier mistakes are closed here at once. It no longer excludes
  // `pg_*`, because `pg_read_all_data` is precisely the kind of role that must
  // never be reachable. It no longer tests `pg_has_role(..., 'USAGE')` alone,
  // because a `GRANT ... WITH INHERIT FALSE, SET TRUE` grants no inherited
  // privilege — so USAGE reports nothing — while still letting the login become
  // that role at will. And it carries each reachable role's own attributes, so a
  // privileged attribute placed on an expected group is visible rather than
  // hidden behind a check that only ever looked at `session_user`.
  const roles = await pool.query<{
    rolname: string;
    inherited: boolean;
    settable: boolean;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
  }>(
    `WITH RECURSIVE reachable(roleid, inherited, settable) AS (
       SELECT am.roleid, am.inherit_option, am.set_option
         FROM pg_auth_members am
         JOIN pg_roles me ON me.oid = am.member
        WHERE me.rolname = session_user
          AND (am.inherit_option OR am.set_option)
       UNION
       SELECT am.roleid,
              r.inherited AND am.inherit_option,
              r.settable OR am.set_option
         FROM pg_auth_members am
         JOIN reachable r ON r.roleid = am.member
        WHERE am.inherit_option OR am.set_option
     )
     SELECT g.rolname,
            bool_or(r.inherited) AS inherited,
            bool_or(r.settable)  AS settable,
            g.rolsuper, g.rolcreaterole, g.rolcreatedb, g.rolreplication, g.rolbypassrls
       FROM reachable r
       JOIN pg_roles g ON g.oid = r.roleid
      WHERE g.rolname <> session_user
      GROUP BY g.rolname, g.rolsuper, g.rolcreaterole, g.rolcreatedb,
               g.rolreplication, g.rolbypassrls
      ORDER BY g.rolname`,
  );

  const reachable: ReachableRole[] = roles.rows.map((r) => ({
    name: r.rolname,
    inherited: r.inherited,
    settable: r.settable,
    isSuperuser: r.rolsuper,
    canCreateRole: r.rolcreaterole,
    canCreateDb: r.rolcreatedb,
    canReplicate: r.rolreplication,
    bypassRls: r.rolbypassrls,
  }));

  return {
    currentUser: row.current_user,
    sessionUser: row.session_user,
    isSuperuser: row.rolsuper,
    canCreateRole: row.rolcreaterole,
    canCreateDb: row.rolcreatedb,
    canReplicate: row.rolreplication,
    bypassRls: row.rolbypassrls,
    reachable,
    memberOf: reachable.map((r) => r.name),
  };
}

/** Exact equality, never substring or prefix matching. */
function reaches(facts: PrincipalFacts, role: string): boolean {
  return facts.memberOf.some((candidate) => candidate === role);
}

/**
 * No role anywhere in the closure may carry a privileged attribute.
 *
 * Checking only `session_user` missed the case that matters most: a login that
 * looks harmless but can reach a group somebody granted `BYPASSRLS` to.
 */
function assertClosureUnprivileged(facts: PrincipalFacts): void {
  for (const role of facts.reachable) {
    for (const [attribute, held] of [
      ['SUPERUSER', role.isSuperuser],
      ['CREATEROLE', role.canCreateRole],
      ['CREATEDB', role.canCreateDb],
      ['REPLICATION', role.canReplicate],
      ['BYPASSRLS', role.bypassRls],
    ] as const) {
      if (held) {
        throw new PrincipalError(
          `${facts.sessionUser} can reach ${role.name}, which holds ${attribute}`,
          'privileged_attribute',
        );
      }
    }
  }
}

function assertNoPrivilegedAttribute(facts: PrincipalFacts): void {
  if (facts.isSuperuser) {
    throw new PrincipalError(`${facts.sessionUser} is a superuser`, 'superuser');
  }
  for (const [attribute, held] of [
    ['CREATEROLE', facts.canCreateRole],
    ['CREATEDB', facts.canCreateDb],
    ['REPLICATION', facts.canReplicate],
    ['BYPASSRLS', facts.bypassRls],
  ] as const) {
    if (held) {
      throw new PrincipalError(
        `${facts.sessionUser} holds ${attribute}, which no application principal may hold`,
        'privileged_attribute',
      );
    }
  }
}

/**
 * Roles an application connection must be unable to reach, directly or
 * transitively. Every function owner is here, not only the break-glass role: a
 * runtime that could assume `prsystem_audit_writer` could write audit rows the
 * wrapper would never have produced.
 */
export const FORBIDDEN_FOR_RUNTIME = [
  'prsystem_migrate',
  'prsystem_maintenance',
  'prsystem_maintenance_fn',
  'prsystem_audit_writer',
  'prsystem_partition_mgr',
] as const;

/**
 * The complete membership closure each principal is permitted to have.
 *
 * Exact sets, not minimums: anything reachable and not listed is a finding,
 * whether it is a project role or a PostgreSQL predefined one.
 */
const ALLOWED_RUNTIME_CLOSURE: Readonly<Record<string, readonly string[]>> = {
  prsystem_api: ['prsystem_api'],
  prsystem_worker: ['prsystem_worker'],
  prsystem_police: ['prsystem_police'],
};

/** The migration principal owns objects, so it reaches the three narrow owners. */
export const ALLOWED_MIGRATION_CLOSURE: readonly string[] = [
  'prsystem_migrate',
  'prsystem_audit_writer',
  'prsystem_partition_mgr',
  'prsystem_maintenance_fn',
];

/**
 * Verifies a migration connection: restricted, non-superuser, a member of
 * `prsystem_migrate`, and of no function-owner or maintenance role.
 */
export async function assertMigrationPrincipal(pool: Queryable): Promise<PrincipalFacts> {
  const facts = await readPrincipalFacts(pool);
  assertNoPrivilegedAttribute(facts);

  if (!reaches(facts, 'prsystem_migrate')) {
    throw new PrincipalError(
      `${facts.sessionUser} is not a member of prsystem_migrate`,
      'missing_membership',
    );
  }
  // The migration principal owns objects, so it reaches the three narrow
  // function-owner roles — and nothing else. `prsystem_maintenance` holds
  // BYPASSRLS and is break-glass; a migration is not break-glass.
  assertClosureUnprivileged(facts);

  const allowed = new Set(ALLOWED_MIGRATION_CLOSURE);
  const unexpected = facts.memberOf.filter((role) => !allowed.has(role));
  if (unexpected.length > 0) {
    throw new PrincipalError(
      `the migration principal additionally reaches ${unexpected.join(', ')}`,
      'unexpected_membership',
    );
  }
  return facts;
}

/**
 * Verifies an API or worker connection: restricted, and unable to reach the
 * migration, owner or maintenance roles.
 */
export async function assertRuntimePrincipal(
  pool: Queryable,
  expectedGroup: 'prsystem_api' | 'prsystem_worker' | 'prsystem_police',
): Promise<PrincipalFacts> {
  const facts = await readPrincipalFacts(pool);
  assertNoPrivilegedAttribute(facts);

  if (!reaches(facts, expectedGroup)) {
    throw new PrincipalError(
      `${facts.sessionUser} is not a member of ${expectedGroup}`,
      'missing_membership',
    );
  }
  for (const forbidden of FORBIDDEN_FOR_RUNTIME) {
    if (reaches(facts, forbidden)) {
      throw new PrincipalError(
        `a runtime connection must not be able to reach ${forbidden}`,
        'forbidden_principal',
      );
    }
  }

  // An exact closure, not merely "contains the expected role". A login that also
  // reached some other group would pass a containment check while holding reach
  // the design never granted it.
  assertClosureUnprivileged(facts);

  const allowed = new Set(ALLOWED_RUNTIME_CLOSURE[expectedGroup] ?? [expectedGroup]);
  const unexpected = facts.memberOf.filter((role) => !allowed.has(role));
  if (unexpected.length > 0) {
    throw new PrincipalError(
      `${facts.sessionUser} additionally reaches ${unexpected.join(', ')}`,
      'unexpected_membership',
    );
  }

  return facts;
}
