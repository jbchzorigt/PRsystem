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
  // Every capability comes from the server rather than from a hand-rolled
  // recursion, so the answer is the one the server will actually enforce —
  // including ADMIN, which `pg_has_role` does support, as
  // `MEMBER WITH ADMIN OPTION` (PostgreSQL 17, functions-info §9.26).
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
            pg_has_role(session_user, g.oid, 'MEMBER WITH ADMIN OPTION') AS has_admin,
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
  // Readers and the scheduler get the same containment guarantee as the
  // request-handling runtimes. A reader that could reach the migration role is
  // exactly as dangerous as an API that could, and was previously unchecked.
  prsystem_audit_reader: ['prsystem_audit_reader'],
  prsystem_police_audit_reader: ['prsystem_police_audit_reader'],
  prsystem_job_scheduler: ['prsystem_job_scheduler'],
};

/** Every group a non-migration principal may be verified against. */
export type ContainedGroup = keyof typeof ALLOWED_RUNTIME_CLOSURE & string;

/**
 * The complete migration membership graph, as edges.
 *
 * Checking only for *unexpected* reach is half a check: a cluster missing
 * `prsystem_migrate -> prsystem_audit_writer` has no extra roles anywhere, and
 * would have passed, while the migration cannot own what it is about to create.
 */
export const EXPECTED_MIGRATION_EDGES: readonly (readonly [string, string])[] = [
  ['prsystem_migrate_login', 'prsystem_migrate'],
  ['prsystem_migrate', 'prsystem_audit_writer'],
  ['prsystem_migrate', 'prsystem_partition_mgr'],
  ['prsystem_migrate', 'prsystem_maintenance_fn'],
];

/** The migration principal owns objects, so it reaches the three narrow owners. */
export const ALLOWED_MIGRATION_CLOSURE: readonly string[] = [
  'prsystem_migrate',
  'prsystem_audit_writer',
  'prsystem_partition_mgr',
  'prsystem_maintenance_fn',
];

/**
 * Every principal a session can arrive on, login and group alike.
 *
 * Readers and the scheduler are here for the same reason the runtimes are: they
 * hold credentials somebody can connect with. Leaving them out meant an audit
 * reader could reach the migration role and no gate would have said so.
 */
const RUNTIME_PRINCIPALS = [
  'prsystem_api',
  'prsystem_worker',
  'prsystem_police',
  'prsystem_audit_reader',
  'prsystem_police_audit_reader',
  'prsystem_job_scheduler',
  'prsystem_api_login',
  'prsystem_worker_login',
  'prsystem_police_login',
  'prsystem_audit_reader_login',
  'prsystem_police_audit_reader_login',
  'prsystem_job_scheduler_login',
] as const;

/**
 * The one group each contained principal may join. A group role itself joins
 * nothing, so it maps to `null` and any membership at all is unexpected.
 */
const EXPECTED_PRINCIPAL_GROUP: Readonly<Record<string, string | null>> = {
  prsystem_api: null,
  prsystem_worker: null,
  prsystem_police: null,
  prsystem_audit_reader: null,
  prsystem_police_audit_reader: null,
  prsystem_job_scheduler: null,
  prsystem_api_login: 'prsystem_api',
  prsystem_worker_login: 'prsystem_worker',
  prsystem_police_login: 'prsystem_police',
  prsystem_audit_reader_login: 'prsystem_audit_reader',
  prsystem_police_audit_reader_login: 'prsystem_police_audit_reader',
  prsystem_job_scheduler_login: 'prsystem_job_scheduler',
};

/**
 * The migration graph must be exactly right, not merely free of extras.
 *
 * Every expected edge must exist with exactly `ADMIN FALSE, INHERIT TRUE,
 * SET TRUE`, and `prsystem_migrate` must reach the three approved owner roles
 * and nothing else.
 */
export async function assertMigrationGraph(pool: Queryable): Promise<void> {
  const edges = await pool.query<{
    member: string;
    role: string;
    admin_option: boolean;
    inherit_option: boolean;
    set_option: boolean;
  }>(
    `SELECT m.rolname AS member, g.rolname AS role,
            am.admin_option, am.inherit_option, am.set_option
       FROM pg_auth_members am
       JOIN pg_roles m ON m.oid = am.member
       JOIN pg_roles g ON g.oid = am.roleid
      WHERE m.rolname = ANY($1)
      ORDER BY 1, 2`,
    [['prsystem_migrate_login', 'prsystem_migrate']],
  );

  for (const [member, role] of EXPECTED_MIGRATION_EDGES) {
    const found = edges.rows.find((e) => e.member === member && e.role === role);
    if (found === undefined) {
      throw new PrincipalError(
        `the migration graph is missing the edge ${member} -> ${role}`,
        'missing_membership',
      );
    }
    if (
      found.admin_option !== INTENDED_MEMBERSHIP_OPTIONS.admin ||
      found.inherit_option !== INTENDED_MEMBERSHIP_OPTIONS.inherit ||
      found.set_option !== INTENDED_MEMBERSHIP_OPTIONS.set
    ) {
      throw new PrincipalError(
        `the migration edge ${member} -> ${role} carries ADMIN ${String(found.admin_option)}, ` +
          `INHERIT ${String(found.inherit_option)}, SET ${String(found.set_option)}`,
        'membership_options',
      );
    }
  }

  const expected = new Set(EXPECTED_MIGRATION_EDGES.map(([m, r]) => `${m}->${r}`));
  const extra = edges.rows.map((e) => `${e.member}->${e.role}`).filter((key) => !expected.has(key));
  if (extra.length > 0) {
    throw new PrincipalError(
      `the migration graph has unexpected edge(s): ${extra.join(', ')}`,
      'unexpected_membership',
    );
  }
}

/**
 * A cluster-wide precondition, not a statement about this connection.
 *
 * Applying DDL while some runtime login can reach an owner role means shipping
 * objects whose privileges are already escapable. The migration is the last
 * point at which that is cheap to refuse, so it refuses there — checking every
 * runtime principal against every owner and privileged role, by MEMBER (which
 * covers ADMIN-only edges), USAGE, SET and ADMIN alike.
 */
/**
 * Every canonical login that exists must hold exactly its designated edge.
 *
 * Checking only for *unexpected* memberships passes a cluster in which a login
 * exists with no membership at all, or with somebody else's group. An absent
 * login is fine — a deployment may manage it elsewhere — but one that exists and
 * is wired wrongly is a principal that will authenticate and then behave as
 * something the design never sanctioned.
 */
export async function assertCanonicalLoginEdges(pool: Queryable): Promise<void> {
  const expected = Object.entries(EXPECTED_PRINCIPAL_GROUP).filter(
    ([, group]) => group !== null,
  ) as [string, string][];

  const present = await pool.query<{ rolname: string; rolcanlogin: boolean }>(
    `SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = ANY($1)`,
    [expected.map(([login]) => login)],
  );
  const existing = new Map(present.rows.map((r) => [r.rolname, r]));

  const edges = await pool.query<{
    member: string;
    role: string;
    admin_option: boolean;
    inherit_option: boolean;
    set_option: boolean;
  }>(
    `SELECT m.rolname AS member, g.rolname AS role,
            am.admin_option, am.inherit_option, am.set_option
       FROM pg_auth_members am
       JOIN pg_roles m ON m.oid = am.member
       JOIN pg_roles g ON g.oid = am.roleid
      WHERE m.rolname = ANY($1)`,
    [expected.map(([login]) => login)],
  );

  for (const [login, group] of expected) {
    const role = existing.get(login);
    if (role === undefined) continue; // absent is permitted, and never created

    if (!role.rolcanlogin) {
      throw new PrincipalError(
        `canonical principal ${login} exists but lacks LOGIN`,
        'missing_membership',
      );
    }

    const held = edges.rows.filter((e) => e.member === login);
    if (held.length !== 1 || held[0]?.role !== group) {
      throw new PrincipalError(
        `canonical login ${login} must be a member of exactly ${group}; found ` +
          `[${held.map((e) => e.role).join(', ') || 'none'}]`,
        held.length === 0 ? 'missing_membership' : 'unexpected_membership',
      );
    }
    const edge = held[0];
    if (
      edge.admin_option !== INTENDED_MEMBERSHIP_OPTIONS.admin ||
      edge.inherit_option !== INTENDED_MEMBERSHIP_OPTIONS.inherit ||
      edge.set_option !== INTENDED_MEMBERSHIP_OPTIONS.set
    ) {
      throw new PrincipalError(
        `canonical login ${login} membership in ${group} carries ADMIN ` +
          `${String(edge.admin_option)}, INHERIT ${String(edge.inherit_option)}, ` +
          `SET ${String(edge.set_option)}`,
        'membership_options',
      );
    }
  }
}

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

  // Privileged attributes on any contained principal. LOGIN is expected on a
  // login role, so only the five escalating attributes are checked.
  const privileged = await pool.query<{ rolname: string; attribute: string }>(
    `SELECT rolname,
            CASE WHEN rolsuper THEN 'SUPERUSER'
                 WHEN rolcreaterole THEN 'CREATEROLE'
                 WHEN rolcreatedb THEN 'CREATEDB'
                 WHEN rolreplication THEN 'REPLICATION'
                 ELSE 'BYPASSRLS' END AS attribute
       FROM pg_roles
      WHERE rolname = ANY($1)
        AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
      ORDER BY 1`,
    [[...RUNTIME_PRINCIPALS]],
  );
  const attributeHolder = privileged.rows[0];
  if (attributeHolder !== undefined) {
    throw new PrincipalError(
      `${attributeHolder.rolname} holds ${attributeHolder.attribute}, which no runtime, reader or scheduler may hold`,
      'privileged_attribute',
    );
  }

  // And the closure of every contained principal is exactly its own group.
  // Reaching a *predefined* role such as `pg_read_all_data` grants cluster-wide
  // data access without ever touching a project role, so a check that only
  // looked at project owners would not see it.
  const unexpected = await pool.query<{ member: string; role: string }>(
    `SELECT m.rolname AS member, g.rolname AS role
       FROM pg_auth_members am
       JOIN pg_roles m ON m.oid = am.member
       JOIN pg_roles g ON g.oid = am.roleid
      WHERE m.rolname = ANY($1)
        AND g.rolname IS DISTINCT FROM $2::jsonb ->> m.rolname
      ORDER BY 1, 2`,
    [[...RUNTIME_PRINCIPALS], JSON.stringify(EXPECTED_PRINCIPAL_GROUP)],
  );
  const stray = unexpected.rows[0];
  if (stray !== undefined) {
    throw new PrincipalError(
      `${stray.member} has an unexpected membership in ${stray.role}; a contained principal joins exactly one group`,
      'unexpected_membership',
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
  await assertMigrationGraph(pool);
  // Containment first: "this runtime can reach an owner role" is both more
  // urgent and more actionable than "this login has two memberships", and the
  // two findings usually describe the same drift from different angles.
  await assertRuntimeContainment(pool);
  await assertCanonicalLoginEdges(pool);

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
  expectedGroup: ContainedGroup,
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
  // The closure must be exactly the allowed set, not a subset of it.
  const missing = [...allowed].filter((role) => !facts.memberOf.includes(role));
  if (missing.length > 0) {
    throw new PrincipalError(
      `${facts.sessionUser} is missing expected membership in ${missing.join(', ')}`,
      'missing_membership',
    );
  }

  return facts;
}
