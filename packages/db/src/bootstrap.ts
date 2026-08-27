import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';

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

export interface BootstrapOptions {
  /** Superuser or CREATEROLE-plus operator connection. A DBA/IaC step. */
  readonly adminUrl: string;
  /** Database the runtimes connect to; CONNECT is granted per role on it. */
  readonly database: string;
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

  const pool = new Pool({ connectionString: options.adminUrl, max: 1 });
  try {
    const statements = readFileSync(BOOTSTRAP_SQL, 'utf8')
      .split('--> statement-breakpoint')
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.length > 0);

    // One transaction: the advisory lock is transaction-scoped, so the whole
    // bootstrap is serialised against every other runner in the cluster.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of statements) await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    await executeFormatted(pool, 'REVOKE ALL ON DATABASE %I FROM PUBLIC', [options.database]);
    for (const role of [
      'prsystem_api',
      'prsystem_worker',
      'prsystem_police',
      'prsystem_audit_reader',
      'prsystem_police_audit_reader',
      'prsystem_migrate',
    ]) {
      await executeFormatted(pool, 'GRANT CONNECT ON DATABASE %I TO %I', [options.database, role]);
    }
    // Only the DDL group may create schemas. A runtime role that could CREATE
    // could also place an object ahead of a fully qualified one on search_path.
    await executeFormatted(pool, 'GRANT CREATE ON DATABASE %I TO %I', [
      options.database,
      'prsystem_migrate',
    ]);

    // PUBLIC holds nothing on `public`; named roles get exactly what they need.
    // Extensions live there, so the DDL group needs CREATE and every runtime
    // needs USAGE to resolve an extension-provided function.
    await pool.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await executeFormatted(pool, 'GRANT CREATE, USAGE ON SCHEMA public TO %I', [
      'prsystem_migrate',
    ]);
    for (const role of [
      'prsystem_api',
      'prsystem_worker',
      'prsystem_police',
      'prsystem_audit_reader',
      'prsystem_police_audit_reader',
    ]) {
      await executeFormatted(pool, 'GRANT USAGE ON SCHEMA public TO %I', [role]);
    }

    let loginsConfigured = 0;
    for (const credential of options.logins ?? []) {
      const group = LOGIN_PRINCIPALS[credential.principal];
      const exists = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
        credential.principal,
      ]);

      if (exists.rowCount === 0) {
        await executeFormatted(
          pool,
          'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT',
          [credential.principal, credential.password],
        );
      } else {
        await executeFormatted(
          pool,
          'ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT',
          [credential.principal, credential.password],
        );
      }

      // Exactly one group, and never a function-owner or maintenance role.
      for (const other of GROUP_ROLES) {
        if (other !== group) {
          await executeFormatted(pool, 'REVOKE %I FROM %I', [other, credential.principal]);
        }
      }
      await executeFormatted(pool, 'GRANT %I TO %I', [group, credential.principal]);
      loginsConfigured += 1;
    }

    return { groupRoles: GROUP_ROLES.length, loginsConfigured };
  } finally {
    await pool.end();
  }
}
