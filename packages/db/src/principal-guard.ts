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

export interface PrincipalFacts {
  readonly currentUser: string;
  readonly sessionUser: string;
  readonly isSuperuser: boolean;
  readonly canCreateRole: boolean;
  readonly canCreateDb: boolean;
  readonly canReplicate: boolean;
  readonly bypassRls: boolean;
  /** Every role reachable by inheritance or SET ROLE, excluding the principal. */
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

  // One row per reachable role, never an aggregate.
  //
  // An aggregate came back from the driver as a delimited string, which turned
  // every membership test into a *substring* match — `prsystem_maintenance_fn`
  // satisfied a check for `prsystem_maintenance`. A privilege check that can
  // match a prefix is worse than no check, so the shape is rows and the
  // comparison is exact equality.
  const roles = await pool.query<{ rolname: string }>(
    `SELECT g.rolname
       FROM pg_roles g
      WHERE g.rolname <> session_user
        AND g.rolname NOT LIKE 'pg\\_%'
        AND pg_has_role(session_user, g.oid, 'USAGE')
      ORDER BY g.rolname`,
  );

  return {
    currentUser: row.current_user,
    sessionUser: row.session_user,
    isSuperuser: row.rolsuper,
    canCreateRole: row.rolcreaterole,
    canCreateDb: row.rolcreatedb,
    canReplicate: row.rolreplication,
    bypassRls: row.rolbypassrls,
    memberOf: roles.rows.map((r) => r.rolname),
  };
}

/** Exact equality, never substring or prefix matching. */
function reaches(facts: PrincipalFacts, role: string): boolean {
  return facts.memberOf.some((candidate) => candidate === role);
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

/** The complete membership closure a runtime login is permitted to have. */
const ALLOWED_RUNTIME_CLOSURE: Readonly<Record<string, readonly string[]>> = {
  prsystem_api: ['prsystem_api'],
  prsystem_worker: ['prsystem_worker'],
  prsystem_police: ['prsystem_police'],
};

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
  // The migration principal owns objects, so it must be able to assign them to
  // the narrow function-owner roles. It must never reach the one role that holds
  // BYPASSRLS — that is break-glass, and a migration is not break-glass.
  if (reaches(facts, 'prsystem_maintenance')) {
    throw new PrincipalError(
      'the migration principal must not be able to reach prsystem_maintenance',
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
