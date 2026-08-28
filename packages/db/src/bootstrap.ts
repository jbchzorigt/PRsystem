import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { INTENDED_MEMBERSHIP_OPTIONS } from './principal-guard';

/**
 * Cluster bootstrap runner.
 *
 * Separated from the migration journal on purpose: roles, role attributes and
 * memberships are cluster-wide, so putting them in a per-database migration both
 * races across databases and hands the migration principal privileges it must
 * never hold. This runs once per cluster, under an advisory lock, as a
 * privileged operator.
 *
 * It contains no credential. Passwords for LOGIN principals arrive from
 * deployment configuration and are never logged, echoed or written to disk.
 */

export const BOOTSTRAP_SQL = resolve(__dirname, '..', 'bootstrap', 'cluster-roles.sql');

/** Group roles the migration and the runtimes depend on. */
export const GROUP_ROLES = [
  'prsystem_api',
  'prsystem_worker',
  'prsystem_police',
  'prsystem_audit_reader',
  'prsystem_police_audit_reader',
  'prsystem_migrate',
  'prsystem_audit_writer',
  'prsystem_partition_mgr',
  'prsystem_maintenance_fn',
  'prsystem_maintenance',
  // D-09: issues privileged maintenance jobs; cannot execute them.
  'prsystem_job_scheduler',
] as const;

/**
 * Roles no runtime group and no runtime login may reach, directly or
 * transitively. `prsystem_maintenance` is additionally unreachable by the
 * migration principal, because it is the one role that holds BYPASSRLS.
 */
/** Roles a deployment's runtime and reader logins map onto. */
export const RUNTIME_AND_READER_ROLES = [
  'prsystem_api',
  'prsystem_worker',
  'prsystem_police',
  'prsystem_audit_reader',
  'prsystem_police_audit_reader',
  'prsystem_job_scheduler',
] as const;

export const UNREACHABLE_ROLES = [
  'prsystem_maintenance',
  'prsystem_maintenance_fn',
  'prsystem_audit_writer',
  'prsystem_partition_mgr',
  'prsystem_migrate',
] as const;

/** The login principals a deployment creates, and the single group each joins. */
export const LOGIN_PRINCIPALS = {
  prsystem_api_login: 'prsystem_api',
  prsystem_worker_login: 'prsystem_worker',
  prsystem_police_login: 'prsystem_police',
  prsystem_audit_reader_login: 'prsystem_audit_reader',
  prsystem_police_audit_reader_login: 'prsystem_police_audit_reader',
  prsystem_migrate_login: 'prsystem_migrate',
  prsystem_job_scheduler_login: 'prsystem_job_scheduler',
} as const;

export type LoginPrincipal = keyof typeof LOGIN_PRINCIPALS;

export class BootstrapError extends Error {
  override readonly name = 'BootstrapError';
}

/** A password supplied by deployment configuration. Never defaulted, never logged. */
export interface LoginCredential {
  readonly principal: LoginPrincipal;
  readonly password: string;
}

/**
 * Session-level advisory lock key for the whole bootstrap.
 *
 * Advisory locks are scoped to the database that holds them, so every runner
 * must coordinate through the *same* database or they are not serialised at all.
 */
export const BOOTSTRAP_LOCK_KEY = 7_733_105_411;

/** Where every runner takes the coordination lock. Same for all of them. */
export const DEFAULT_COORDINATION_DATABASE = 'postgres';

export interface BootstrapOptions {
  /** Superuser or CREATEROLE-plus operator connection. A DBA/IaC step. */
  readonly adminUrl: string;
  /** Database the runtimes connect to; CONNECT is granted per role on it. */
  readonly database: string;
  /**
   * Database used only to hold the coordination lock. Defaults to `postgres`.
   * Every concurrent runner must name the same one.
   */
  readonly coordinationDatabase?: string;
  /**
   * Login principals to create or re-assert. Omit to bootstrap group roles only,
   * which is what a production run does when logins are managed by IaC.
   */
  readonly logins?: readonly LoginCredential[];
}

export interface BootstrapResult {
  readonly groupRoles: number;
  /** Principals whose password this run set. Only the ones supplied. */
  readonly loginsConfigured: number;
  /**
   * Canonical principals that already existed, were **not** supplied, and were
   * therefore left untouched — their attributes and membership validated, their
   * password never modified. This is the IaC-managed case.
   */
  readonly loginsValidated: number;
  /** Canonical principals that do not exist and were not asked for. */
  readonly loginsAbsent: number;
}

/**
 * Executes `text` after building it server-side with `format()`, so an identifier
 * or a password is quoted by PostgreSQL itself and never concatenated here.
 */
async function executeFormatted(
  pool: Pool,
  template: string,
  values: readonly unknown[],
): Promise<void> {
  const built = await pool.query<{ sql: string }>(
    // Each argument is cast explicitly: PostgreSQL cannot infer the type of a
    // parameter passed to variadic format().
    `SELECT format($1, ${values.map((_, index) => `$${String(index + 2)}::text`).join(', ')}) AS sql`,
    [template, ...values],
  );
  const sql = built.rows[0]?.sql;
  if (sql === undefined) throw new BootstrapError('failed to build a bootstrap statement');
  await pool.query(sql);
}

function assertStrongEnough(credential: LoginCredential): void {
  // Not a policy engine — a floor. A short or empty password here would become a
  // production login, so it is refused rather than accepted and warned about.
  if (credential.password.length < 16) {
    throw new BootstrapError(`password for ${credential.principal} is shorter than 16 characters`);
  }
}

/**
 * Creates the group roles, asserts their exact attributes, removes every
 * escalation membership, and — when configuration supplies them — creates the
 * LOGIN principals and grants each exactly one group.
 */
export async function bootstrapCluster(options: BootstrapOptions): Promise<BootstrapResult> {
  if (!/^[a-z_][a-z0-9_]*$/.test(options.database)) {
    throw new BootstrapError('target database name is not a plain identifier');
  }
  for (const credential of options.logins ?? []) assertStrongEnough(credential);

  const coordinationDatabase = options.coordinationDatabase ?? DEFAULT_COORDINATION_DATABASE;
  const coordinationUrl = withDatabase(options.adminUrl, coordinationDatabase);

  // One dedicated session holds the lock for the whole operation. A
  // transaction-scoped lock would end at COMMIT — before the database grants,
  // the `public` grants and the login changes that follow — leaving exactly the
  // catalog race this exists to prevent.
  const coordinator = new Client({ connectionString: coordinationUrl });
  await coordinator.connect();

  let held = false;
  try {
    await coordinator.query('SELECT pg_advisory_lock($1)', [BOOTSTRAP_LOCK_KEY]);
    held = true;

    // Cluster-scoped work (roles, attributes, memberships) can run anywhere.
    const clusterPool = new Pool({ connectionString: options.adminUrl, max: 1 });
    // Database-scoped work (schema and database ACLs) must run *in the target*.
    // Using the admin URL for these hardened whichever database that URL named,
    // which is not necessarily the one being bootstrapped.
    const targetPool = new Pool({
      connectionString: withDatabase(options.adminUrl, options.database),
      max: 1,
    });

    try {
      await assertConnectedTo(targetPool, options.database);

      await applyGroupRoles(clusterPool);

      const supplied = options.logins ?? [];
      const loginsConfigured = await applyLogins(clusterPool, supplied);
      // Everything the run was not asked to touch is inspected rather than
      // assumed safe: an IaC-managed principal that has drifted into an unsafe
      // shape must fail the bootstrap, not pass through it unnoticed.
      const census = await validateOmittedLogins(
        clusterPool,
        new Set(supplied.map((c) => c.principal)),
      );

      await applyDatabaseGrants(targetPool, options.database);
      await reconcileMemberships(clusterPool);
      await assertInvariants(clusterPool, targetPool, options.database);

      return {
        groupRoles: GROUP_ROLES.length,
        loginsConfigured,
        loginsValidated: census.validated,
        loginsAbsent: census.absent,
      };
    } finally {
      await targetPool.end();
      await clusterPool.end();
    }
  } finally {
    // Released explicitly, then again implicitly when the session closes.
    try {
      if (held) await coordinator.query('SELECT pg_advisory_unlock($1)', [BOOTSTRAP_LOCK_KEY]);
    } catch {
      // The session is ending; the lock dies with it either way.
    }
    await coordinator.end();
  }
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Refuses to apply database-scoped grants through a connection to another database. */
async function assertConnectedTo(pool: Pool, database: string): Promise<void> {
  const result = await pool.query<{ current: string }>('SELECT current_database() AS current');
  const current = result.rows[0]?.current;
  if (current !== database) {
    throw new BootstrapError(
      `target connection is attached to "${String(current)}" but the target database is "${database}"`,
    );
  }
}

/**
 * Reconciles **every** direct membership in the cluster, not only the ones this
 * module happens to list.
 *
 * A grant made by hand — or by an earlier version of this file — is invisible to
 * a reconciliation that only iterates a hard-coded array. Anything not in the
 * approved map is removed.
 */
async function reconcileMemberships(pool: Pool): Promise<void> {
  const approved = new Map<string, string>(
    Object.entries(LOGIN_PRINCIPALS).map(([login, group]) => [login, group]),
  );
  const ownerRoles = new Set([
    'prsystem_audit_writer',
    'prsystem_partition_mgr',
    'prsystem_maintenance_fn',
  ]);

  const permitted = (member: string, role: string): boolean =>
    approved.get(member) === role || (member === 'prsystem_migrate' && ownerRoles.has(role));

  // Options, not just role names. A membership carrying ADMIN OPTION grants no
  // privilege by itself, so a reconciliation that only compared name pairs would
  // leave it in place — and ADMIN is exactly what lets its holder grant the role
  // onward, or back to itself with SET.
  const edges = await pool.query<{
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
      WHERE m.rolname LIKE 'prsystem\\_%' OR g.rolname LIKE 'prsystem\\_%'`,
  );

  for (const edge of edges.rows) {
    if (!permitted(edge.member, edge.role)) {
      await executeFormatted(pool, 'REVOKE %I FROM %I', [edge.role, edge.member]);
    }
  }

  // Normalise every approved edge by stating all three options explicitly.
  //
  // A bare `GRANT r TO m` does **not** reset the options an earlier grant set:
  // PostgreSQL keeps whatever it is not told to change, so an edge once granted
  // WITH ADMIN TRUE stays ADMIN TRUE through any number of plain re-grants. The
  // options are therefore spelled out, `ADMIN FALSE` included.
  const options = MEMBERSHIP_OPTION_CLAUSE;

  // Group-to-group ownership edges are structural: they exist in every cluster,
  // whatever login policy a deployment uses, so they are always reconciled.
  for (const owner of ownerRoles) {
    await executeFormatted(pool, `GRANT %I TO %I ${options}`, [owner, 'prsystem_migrate']);
  }

  // Login-to-group edges are reconciled only for principals that actually exist.
  //
  // A deployment may manage some or all logins through IaC and never hand this
  // bootstrap a credential for them. Granting to every canonical name regardless
  // issued `GRANT prsystem_api TO prsystem_api_login` against a role that was
  // never created, which fails and takes the whole group-role bootstrap with it.
  const present = await pool.query<{ rolname: string }>(
    `SELECT rolname FROM pg_roles WHERE rolname = ANY($1)`,
    [[...approved.keys()]],
  );
  const existing = new Set(present.rows.map((r) => r.rolname));
  for (const [login, group] of approved) {
    if (!existing.has(login)) continue;
    await executeFormatted(pool, `GRANT %I TO %I ${options}`, [group, login]);
  }

  // Re-read and prove the intent, rather than assuming the statements above had
  // the effect they were meant to have.
  const after = await pool.query<{
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
      WHERE m.rolname LIKE 'prsystem\\_%' OR g.rolname LIKE 'prsystem\\_%'
      ORDER BY 1, 2`,
  );

  for (const edge of after.rows) {
    if (!permitted(edge.member, edge.role)) {
      throw new BootstrapError(`membership ${edge.member} -> ${edge.role} survived reconciliation`);
    }
    if (
      edge.admin_option !== INTENDED_MEMBERSHIP_OPTIONS.admin ||
      edge.inherit_option !== INTENDED_MEMBERSHIP_OPTIONS.inherit ||
      edge.set_option !== INTENDED_MEMBERSHIP_OPTIONS.set
    ) {
      throw new BootstrapError(
        `membership ${edge.member} -> ${edge.role} carries ADMIN ${String(edge.admin_option)}, ` +
          `INHERIT ${String(edge.inherit_option)}, SET ${String(edge.set_option)}`,
      );
    }
  }
}

async function applyGroupRoles(pool: Pool): Promise<void> {
  const statements = readFileSync(BOOTSTRAP_SQL, 'utf8')
    .split('--> statement-breakpoint')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);

  for (const statement of statements) await pool.query(statement);
}

/**
 * Exact final grants, not additive ones. Stale privileges are revoked first, so
 * a role that once held CREATE does not keep it because nobody remembered.
 */
async function applyDatabaseGrants(pool: Pool, database: string): Promise<void> {
  await executeFormatted(pool, 'REVOKE ALL ON DATABASE %I FROM PUBLIC', [database]);
  await pool.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');

  for (const role of RUNTIME_AND_READER_ROLES) {
    // Revoke before granting: CONNECT is all a runtime may hold on the database,
    // and USAGE is all it may hold on `public`.
    await executeFormatted(pool, 'REVOKE ALL ON DATABASE %I FROM %I', [database, role]);
    await executeFormatted(pool, 'REVOKE ALL ON SCHEMA public FROM %I', [role]);
    await executeFormatted(pool, 'GRANT CONNECT ON DATABASE %I TO %I', [database, role]);
    await executeFormatted(pool, 'GRANT USAGE ON SCHEMA public TO %I', [role]);
  }

  await executeFormatted(pool, 'REVOKE ALL ON DATABASE %I FROM %I', [database, 'prsystem_migrate']);
  await executeFormatted(pool, 'GRANT CONNECT, CREATE ON DATABASE %I TO %I', [
    database,
    'prsystem_migrate',
  ]);
  await executeFormatted(pool, 'GRANT CREATE, USAGE ON SCHEMA public TO %I', ['prsystem_migrate']);

  // "Exact final grants" has to mean every grantee, not only the ones this file
  // happens to name. A grant handed to some unrelated role by an operator, or
  // left behind by an earlier tool, is exactly the grant nobody is looking at.
  for (const grantee of await strayGrantees(pool, database)) {
    await executeFormatted(pool, 'REVOKE ALL ON DATABASE %I FROM %I', [database, grantee]);
    await executeFormatted(pool, 'REVOKE ALL ON SCHEMA public FROM %I', [grantee]);
  }
}

/**
 * Every role holding a grant on the target database or on `public` that the
 * design does not account for.
 *
 * The allow-list is the database owner (an operator identity a deployment
 * legitimately owns), the DDL owner, and the runtime, reader and scheduler
 * roles. Anything else is stale or unexpected and is revoked.
 */
async function strayGrantees(pool: Pool, database: string): Promise<string[]> {
  const allowed = new Set<string>(['prsystem_migrate', ...RUNTIME_AND_READER_ROLES]);

  const owner = await pool.query<{ owner: string }>(
    `SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1`,
    [database],
  );
  // The database owner keeps its implicit rights; revoking from it would leave
  // a database nobody can administer.
  if (owner.rows[0] !== undefined) allowed.add(owner.rows[0].owner);

  const schemaOwner = await pool.query<{ owner: string }>(
    `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'public'`,
  );
  if (schemaOwner.rows[0] !== undefined) allowed.add(schemaOwner.rows[0].owner);

  const grantees = await pool.query<{ grantee: string }>(
    `SELECT DISTINCT grantee FROM (
       SELECT (aclexplode(d.datacl)).grantee AS oid
         FROM pg_database d WHERE d.datname = $1
       UNION ALL
       SELECT (aclexplode(n.nspacl)).grantee AS oid
         FROM pg_namespace n WHERE n.nspname = 'public'
     ) AS acl
     JOIN pg_roles r ON r.oid = acl.oid
     CROSS JOIN LATERAL (SELECT r.rolname AS grantee) AS named
     WHERE acl.oid <> 0`,
    [database],
  );

  return grantees.rows.map((r) => r.grantee).filter((name) => !allowed.has(name));
}

async function applyLogins(pool: Pool, logins: readonly LoginCredential[]): Promise<number> {
  let configured = 0;

  for (const credential of logins) {
    const group = LOGIN_PRINCIPALS[credential.principal];
    const exists = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
      credential.principal,
    ]);

    const verb = exists.rowCount === 0 ? 'CREATE' : 'ALTER';
    await executeFormatted(
      pool,
      `${verb} ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT`,
      [credential.principal, credential.password],
    );

    // Exactly one group. Every other membership is removed, so a login cannot
    // accumulate reach across deploys.
    for (const other of GROUP_ROLES) {
      if (other !== group) {
        await executeFormatted(pool, 'REVOKE %I FROM %I', [other, credential.principal]);
      }
    }
    await executeFormatted(pool, `GRANT %I TO %I ${MEMBERSHIP_OPTION_CLAUSE}`, [
      group,
      credential.principal,
    ]);
    configured += 1;
  }

  return configured;
}

/** The membership options every approved edge must carry, as a SQL clause. */
const MEMBERSHIP_OPTION_CLAUSE = `WITH ADMIN ${
  INTENDED_MEMBERSHIP_OPTIONS.admin ? 'TRUE' : 'FALSE'
}, INHERIT ${INTENDED_MEMBERSHIP_OPTIONS.inherit ? 'TRUE' : 'FALSE'}, SET ${
  INTENDED_MEMBERSHIP_OPTIONS.set ? 'TRUE' : 'FALSE'
}`;

/**
 * Inspects the canonical principals this run was **not** asked to configure.
 *
 * A deployment may manage some or all logins through IaC and hand this bootstrap
 * only the group roles. That is a supported mode, so an absent principal is not
 * an error and is never created. An *existing* one is a different matter: it can
 * connect, so its attributes and its membership are part of the cluster's
 * security posture whether this run created it or not. It is validated and left
 * alone — never re-passworded — and unsafe drift fails the bootstrap closed.
 */
async function validateOmittedLogins(
  pool: Pool,
  supplied: ReadonlySet<string>,
): Promise<{ validated: number; absent: number }> {
  let validated = 0;
  let absent = 0;

  for (const [login, group] of Object.entries(LOGIN_PRINCIPALS)) {
    if (supplied.has(login)) continue;

    const row = await pool.query<{
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
    }>(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
         FROM pg_roles WHERE rolname = $1`,
      [login],
    );

    const attributes = row.rows[0];
    if (attributes === undefined) {
      absent += 1;
      continue;
    }

    const unsafe = (
      [
        ['SUPERUSER', attributes.rolsuper],
        ['CREATEDB', attributes.rolcreatedb],
        ['CREATEROLE', attributes.rolcreaterole],
        ['REPLICATION', attributes.rolreplication],
        ['BYPASSRLS', attributes.rolbypassrls],
      ] as const
    )
      .filter(([, held]) => held)
      .map(([name]) => name);

    if (unsafe.length > 0) {
      throw new BootstrapError(
        `existing login ${login} is not managed by this run but holds ${unsafe.join(', ')}; ` +
          `refusing to bootstrap a cluster in which an omitted principal is privileged`,
      );
    }

    // Exact membership, with exact options. An IaC-managed principal that has
    // acquired a second group, or the same group with ADMIN OPTION, is drift.
    const edges = await pool.query<{
      role: string;
      admin_option: boolean;
      inherit_option: boolean;
      set_option: boolean;
    }>(
      `SELECT g.rolname AS role, am.admin_option, am.inherit_option, am.set_option
         FROM pg_auth_members am
         JOIN pg_roles m ON m.oid = am.member
         JOIN pg_roles g ON g.oid = am.roleid
        WHERE m.rolname = $1
        ORDER BY 1`,
      [login],
    );

    const names = edges.rows.map((e) => e.role);
    if (names.length !== 1 || names[0] !== group) {
      throw new BootstrapError(
        `existing login ${login} is not managed by this run and its membership has drifted: ` +
          `expected exactly [${group}], found [${names.join(', ') || 'none'}]`,
      );
    }
    const edge = edges.rows[0]!;
    if (
      edge.admin_option !== INTENDED_MEMBERSHIP_OPTIONS.admin ||
      edge.inherit_option !== INTENDED_MEMBERSHIP_OPTIONS.inherit ||
      edge.set_option !== INTENDED_MEMBERSHIP_OPTIONS.set
    ) {
      throw new BootstrapError(
        `existing login ${login} is not managed by this run and its membership in ${group} carries ` +
          `ADMIN ${String(edge.admin_option)}, INHERIT ${String(edge.inherit_option)}, ` +
          `SET ${String(edge.set_option)}`,
      );
    }

    validated += 1;
  }

  return { validated, absent };
}

/**
 * The final state, asserted rather than assumed. Runs inside the coordination
 * lock so it describes a settled cluster, not one another runner is mid-way
 * through changing.
 */
async function assertInvariants(pool: Pool, target: Pool, database: string): Promise<void> {
  const privileged = await pool.query<{ rolname: string; attribute: string }>(
    `SELECT rolname,
            CASE WHEN rolsuper THEN 'SUPERUSER'
                 WHEN rolcreaterole THEN 'CREATEROLE'
                 WHEN rolcreatedb THEN 'CREATEDB'
                 WHEN rolreplication THEN 'REPLICATION'
                 ELSE 'BYPASSRLS' END AS attribute
       FROM pg_roles
      WHERE rolname LIKE 'prsystem\\_%'
        AND rolname <> 'prsystem_maintenance'
        AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)`,
  );
  if (privileged.rowCount !== 0) {
    throw new BootstrapError(
      `privileged attribute on ${privileged.rows
        .map((r) => `${r.rolname}:${r.attribute}`)
        .join(', ')}`,
    );
  }

  const reachable = await pool.query<{ member: string; role: string }>(
    `SELECT m.rolname AS member, g.rolname AS role
       FROM pg_roles m, pg_roles g
      WHERE m.rolname LIKE 'prsystem\\_%'
        AND m.rolname <> g.rolname
        AND g.rolname = ANY($1)
        AND (m.rolname = ANY($2) OR m.rolname LIKE '%\\_login')
        AND m.rolname <> 'prsystem_migrate_login'
        AND pg_has_role(m.rolname, g.oid, 'USAGE')`,
    [UNREACHABLE_ROLES, RUNTIME_AND_READER_ROLES],
  );
  if (reachable.rowCount !== 0) {
    throw new BootstrapError(
      `runtime role reaches a privileged role: ${reachable.rows
        .map((r) => `${r.member}->${r.role}`)
        .join(', ')}`,
    );
  }

  const breakGlassMembers = await pool.query<{ member: string }>(
    `SELECT m.rolname AS member
       FROM pg_auth_members am
       JOIN pg_roles m ON m.oid = am.member
       JOIN pg_roles g ON g.oid = am.roleid
      WHERE g.rolname = 'prsystem_maintenance'`,
  );
  if (breakGlassMembers.rowCount !== 0) {
    throw new BootstrapError(
      `prsystem_maintenance must have no members, found ${breakGlassMembers.rows
        .map((r) => r.member)
        .join(', ')}`,
    );
  }

  // Database and schema ACLs, in the target database. Roles alone are not the
  // posture: a correct role set on a database that still grants PUBLIC is not
  // hardened.
  await assertConnectedTo(target, database);

  const publicSchema = await target.query<{ acl: string }>(
    `SELECT coalesce(array_to_string(nspacl, ' '), '') AS acl
       FROM pg_namespace WHERE nspname = 'public'`,
  );
  const schemaAcl = publicSchema.rows[0]?.acl ?? '';
  if (/(^|\s)=[UC]+\//.test(schemaAcl)) {
    throw new BootstrapError('PUBLIC still holds a grant on schema public in the target database');
  }
  if (!schemaAcl.includes('prsystem_migrate=UC/')) {
    throw new BootstrapError('prsystem_migrate lacks CREATE and USAGE on schema public');
  }

  const databaseAcl = await target.query<{ acl: string }>(
    `SELECT coalesce(array_to_string(datacl, ' '), '') AS acl
       FROM pg_database WHERE datname = current_database()`,
  );
  const dbAcl = databaseAcl.rows[0]?.acl ?? '';
  if (/(^|\s)=[A-Za-z]+\//.test(dbAcl)) {
    throw new BootstrapError('PUBLIC still holds a grant on the target database');
  }
  for (const role of RUNTIME_AND_READER_ROLES) {
    if (!dbAcl.includes(`${role}=c/`)) {
      throw new BootstrapError(`${role} lacks CONNECT on the target database`);
    }
  }

  // And the grantee set is exactly what the design accounts for. Checking only
  // PUBLIC and the roles this file names would leave any other grantee — the
  // one nobody is looking at — unexamined, while the runbook claimed exactness.
  const stray = await strayGrantees(target, database);
  if (stray.length > 0) {
    throw new BootstrapError(
      `unexpected grantee(s) on the target database or schema public: ${stray.join(', ')}`,
    );
  }
}
