import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, Pool } from 'pg';

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
  readonly loginsConfigured: number;
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

    const pool = new Pool({ connectionString: options.adminUrl, max: 1 });
    try {
      await applyGroupRoles(pool);
      await applyDatabaseGrants(pool, options.database);
      const loginsConfigured = await applyLogins(pool, options.logins ?? []);
      await assertInvariants(pool);

      return { groupRoles: GROUP_ROLES.length, loginsConfigured };
    } finally {
      await pool.end();
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
    await executeFormatted(pool, 'GRANT %I TO %I', [group, credential.principal]);
    configured += 1;
  }

  return configured;
}

/**
 * The final state, asserted rather than assumed. Runs inside the coordination
 * lock so it describes a settled cluster, not one another runner is mid-way
 * through changing.
 */
async function assertInvariants(pool: Pool): Promise<void> {
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
}
