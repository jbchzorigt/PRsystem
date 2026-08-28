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
      | 'forbidden_principal'
      | 'admin_option'
      | 'membership_options',
  ) {
    super(message);
  }
}

/**
 * One role the principal can reach, with each PostgreSQL 17 membership
 * capability modelled separately.
 *
 * The five are genuinely independent. `GRANT r TO m WITH ADMIN TRUE, INHERIT
 * FALSE, SET FALSE` produces a membership that grants no privilege and permits
 * no `SET ROLE`, yet lets the member grant `r` to anybody — including granting
 * it back to itself with `SET TRUE`. Modelling only INHERIT and SET, as this
 * guard previously did, makes exactly that edge invisible.
 */
export interface ReachableRole {
  readonly name: string;
  /** `pg_has_role(..., 'MEMBER')`: membership exists by any capability at all. */
  readonly member: boolean;
  /** `pg_has_role(..., 'USAGE')`: privileges apply without `SET ROLE`. */
  readonly usage: boolean;
  /** Alias of `usage`, kept because inheritance is what the ADRs call it. */
  readonly inherited: boolean;
  /** `pg_has_role(..., 'SET')`: the principal may `SET ROLE` into it. */
  readonly settable: boolean;
  /** Some reachable member holds `ADMIN OPTION` on it — an escalation path. */
  readonly admin: boolean;
  readonly isSuperuser: boolean;
  readonly canCreateRole: boolean;
  readonly canCreateDb: boolean;
  readonly canReplicate: boolean;
  readonly bypassRls: boolean;
}

/** One row of `pg_auth_members`, with its options exactly as stored. */
export interface DirectMembership {
  readonly member: string;
  readonly role: string;
  readonly grantor: string;
  readonly admin: boolean;
  readonly inherit: boolean;
  readonly set: boolean;
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
  /** Every `pg_auth_members` row whose member is this principal, with options. */
  readonly directMemberships: readonly DirectMembership[];
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

  // The complete transitive closure, computed by PostgreSQL itself.
  //
  // `pg_has_role(..., 'MEMBER')` is the reachability primitive because it is the
  // only one that is true for every membership, whatever its options. An
  // `ADMIN TRUE, INHERIT FALSE, SET FALSE` edge reports USAGE false and SET
  // false, so a closure filtered on those two options — as this guard once was —
  // cannot see it at all, even though ADMIN OPTION is the strongest of the three.
  //
  // USAGE and SET come from the server rather than from a hand-rolled recursion,
  // so the answer is the one the server will actually enforce. ADMIN has no
  // `pg_has_role` privilege type, so it is derived: some role this principal can
  // already reach holds ADMIN OPTION on the target.
  const roles = await pool.query<{
    rolname: string;
    is_member: boolean;
    has_usage: boolean;
    has_set: boolean;
    has_admin: boolean;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
  }>(
    `SELECT g.rolname,
            pg_has_role(session_user, g.oid, 'MEMBER') AS is_member,
            pg_has_role(session_user, g.oid, 'USAGE')  AS has_usage,
            pg_has_role(session_user, g.oid, 'SET')    AS has_set,
            EXISTS (
              SELECT 1
                FROM pg_auth_members am
               WHERE am.roleid = g.oid
                 AND am.admin_option
                 AND (am.member = (SELECT s.oid FROM pg_roles s WHERE s.rolname = session_user)
                      OR pg_has_role(session_user, am.member, 'MEMBER'))
            ) AS has_admin,
            g.rolsuper, g.rolcreaterole, g.rolcreatedb, g.rolreplication, g.rolbypassrls
       FROM pg_roles g
      WHERE g.rolname <> session_user
        AND pg_has_role(session_user, g.oid, 'MEMBER')
      ORDER BY g.rolname`,
  );

  // Direct edges with their stored options. Reachability alone cannot show that
  // an approved membership carries an option it was never meant to have, and
  // bootstrap needs the exact options to normalise them.
  const direct = await pool.query<{
    member: string;
    role: string;
    grantor: string;
    admin_option: boolean;
    inherit_option: boolean;
    set_option: boolean;
  }>(
    `SELECT m.rolname AS member, g.rolname AS role, gr.rolname AS grantor,
            am.admin_option, am.inherit_option, am.set_option
       FROM pg_auth_members am
       JOIN pg_roles m  ON m.oid  = am.member
       JOIN pg_roles g  ON g.oid  = am.roleid
       JOIN pg_roles gr ON gr.oid = am.grantor
      WHERE m.rolname = session_user
      ORDER BY g.rolname, gr.rolname`,
  );

  const reachable: ReachableRole[] = roles.rows.map((r) => ({
    name: r.rolname,
    member: r.is_member,
    usage: r.has_usage,
    inherited: r.has_usage,
    settable: r.has_set,
    admin: r.has_admin,
    isSuperuser: r.rolsuper,
    canCreateRole: r.rolcreaterole,
    canCreateDb: r.rolcreatedb,
    canReplicate: r.rolreplication,
    bypassRls: r.rolbypassrls,
  }));

  const directMemberships: DirectMembership[] = direct.rows.map((r) => ({
    member: r.member,
    role: r.role,
    grantor: r.grantor,
    admin: r.admin_option,
    inherit: r.inherit_option,
    set: r.set_option,
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
    directMemberships,
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

/**
 * The options every approved membership must carry, exactly.
 *
 * PostgreSQL keeps options a later `GRANT` omits, so "the edge exists" is never
 * enough: an edge granted once with `ADMIN TRUE` keeps ADMIN through every
 * subsequent plain `GRANT`. Bootstrap therefore states all three explicitly, and
 * this is the value it states.
 */
export const INTENDED_MEMBERSHIP_OPTIONS = {
  admin: false,
  inherit: true,
  set: true,
} as const;

/**
 * No role in the closure may be reachable with ADMIN OPTION.
 *
 * ADMIN is an escalation, not a privilege: a principal holding it on some role
 * can grant that role to itself with `SET TRUE`, or to anybody else, at any
 * time. A guard that accepted it would be checking a state the principal can
 * change unilaterally.
 */
function assertNoAdminCapability(facts: PrincipalFacts): void {
  for (const role of facts.reachable) {
    if (role.admin) {
      throw new PrincipalError(
        `${facts.sessionUser} holds ADMIN OPTION on ${role.name}, which would let it grant that role at will`,
        'admin_option',
      );
    }
  }
}

/** Every direct membership must carry exactly the intended options. */
function assertMembershipOptions(facts: PrincipalFacts): void {
  for (const edge of facts.directMemberships) {
    const wrong: string[] = [];
    if (edge.admin !== INTENDED_MEMBERSHIP_OPTIONS.admin) wrong.push('ADMIN');
    if (edge.inherit !== INTENDED_MEMBERSHIP_OPTIONS.inherit) wrong.push('INHERIT');
    if (edge.set !== INTENDED_MEMBERSHIP_OPTIONS.set) wrong.push('SET');
    if (wrong.length > 0) {
      throw new PrincipalError(
        `membership ${edge.member} -> ${edge.role} (granted by ${edge.grantor}) carries ` +
          `ADMIN ${String(edge.admin)}, INHERIT ${String(edge.inherit)}, SET ${String(edge.set)}; ` +
          `${wrong.join(', ')} differ from the intended options`,
        'membership_options',
      );
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

/** Every principal a request can arrive on, login and group alike. */
const RUNTIME_PRINCIPALS = [
  'prsystem_api',
  'prsystem_worker',
  'prsystem_police',
  'prsystem_api_login',
  'prsystem_worker_login',
  'prsystem_police_login',
] as const;

/**
 * A cluster-wide precondition, not a statement about this connection.
 *
 * Applying DDL while some runtime login can reach an owner role means shipping
 * objects whose privileges are already escapable. The migration is the last
 * point at which that is cheap to refuse, so it refuses there — checking every
 * runtime principal against every owner and privileged role, by MEMBER (which
 * covers ADMIN-only edges), USAGE, SET and ADMIN alike.
 */
export async function assertRuntimeContainment(pool: Queryable): Promise<void> {
  const reach = await pool.query<{ member: string; role: string; capabilities: string }>(
    `SELECT m.rolname AS member, g.rolname AS role,
            concat_ws(', ',
              CASE WHEN pg_has_role(m.oid, g.oid, 'USAGE')  THEN 'INHERIT' END,
              CASE WHEN pg_has_role(m.oid, g.oid, 'SET')    THEN 'SET' END,
              CASE WHEN pg_has_role(m.oid, g.oid, 'MEMBER') THEN 'MEMBER' END
            ) AS capabilities
       FROM pg_roles m
       CROSS JOIN pg_roles g
      WHERE m.rolname = ANY($1) AND g.rolname = ANY($2)
        AND pg_has_role(m.oid, g.oid, 'MEMBER')
      ORDER BY 1, 2`,
    [[...RUNTIME_PRINCIPALS], [...FORBIDDEN_FOR_RUNTIME]],
  );
  const first = reach.rows[0];
  if (first !== undefined) {
    throw new PrincipalError(
      `${first.member} can reach ${first.role} (${first.capabilities}); a migration must not run while a runtime principal reaches an owner role`,
      'forbidden_principal',
    );
  }

  const admin = await pool.query<{ member: string; role: string }>(
    `SELECT m.rolname AS member, g.rolname AS role
       FROM pg_auth_members am
       JOIN pg_roles m ON m.oid = am.member
       JOIN pg_roles g ON g.oid = am.roleid
      WHERE am.admin_option AND m.rolname = ANY($1)
      ORDER BY 1, 2`,
    [[...RUNTIME_PRINCIPALS]],
  );
  const adminEdge = admin.rows[0];
  if (adminEdge !== undefined) {
    throw new PrincipalError(
      `${adminEdge.member} holds ADMIN OPTION on ${adminEdge.role}, so it can grant itself further reach`,
      'admin_option',
    );
  }
}

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
  assertNoAdminCapability(facts);
  assertMembershipOptions(facts);
  await assertRuntimeContainment(pool);

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
  assertNoAdminCapability(facts);
  assertMembershipOptions(facts);

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
