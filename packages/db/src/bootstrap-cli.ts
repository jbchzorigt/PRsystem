import { approvedOperatorOwnersFromEnv, bootstrapCluster, LOGIN_PRINCIPALS } from './bootstrap';
import type { LoginCredential, LoginPrincipal } from './bootstrap';

/**
 * `pnpm run db:bootstrap` — the once-per-cluster role bootstrap.
 *
 * Credentials come from the environment and are never defaulted, echoed or
 * written anywhere. A principal whose password variable is unset is simply not
 * created, so a production run can manage logins entirely through IaC.
 */
const PASSWORD_VARIABLE: Readonly<Record<LoginPrincipal, string>> = {
  prsystem_api_login: 'PRSYSTEM_LOGIN_API_PASSWORD',
  prsystem_worker_login: 'PRSYSTEM_LOGIN_WORKER_PASSWORD',
  prsystem_police_login: 'PRSYSTEM_LOGIN_POLICE_PASSWORD',
  prsystem_audit_reader_login: 'PRSYSTEM_LOGIN_AUDIT_READER_PASSWORD',
  prsystem_police_audit_reader_login: 'PRSYSTEM_LOGIN_POLICE_AUDIT_READER_PASSWORD',
  prsystem_migrate_login: 'PRSYSTEM_LOGIN_MIGRATE_PASSWORD',
  prsystem_job_scheduler_login: 'PRSYSTEM_LOGIN_JOB_SCHEDULER_PASSWORD',
};

async function main(): Promise<void> {
  const adminUrl = process.env['BOOTSTRAP_DATABASE_URL'];
  const database = process.env['BOOTSTRAP_TARGET_DATABASE'];

  if (adminUrl === undefined || database === undefined) {
    process.stderr.write(
      'BOOTSTRAP_DATABASE_URL and BOOTSTRAP_TARGET_DATABASE are required.\n' +
        'This is a privileged DBA/IaC step — see docs/implementation/database-bootstrap-runbook.md\n' +
        'Optional: PRSYSTEM_APPROVED_OPERATOR_OWNERS=<comma-separated operator roles> declares\n' +
        'which identities may own the target database and schema public.\n',
    );
    process.exitCode = 1;
    return;
  }

  const logins: LoginCredential[] = [];
  for (const principal of Object.keys(LOGIN_PRINCIPALS) as LoginPrincipal[]) {
    const password = process.env[PASSWORD_VARIABLE[principal]];
    if (password !== undefined && password.length > 0) logins.push({ principal, password });
  }

  // The approved-operator-owner contract is part of the shipped environment
  // surface, not a library constant only a test can reach.
  const approvedOperatorOwners = approvedOperatorOwnersFromEnv();

  const result = await bootstrapCluster({
    adminUrl,
    database,
    logins,
    ...(approvedOperatorOwners === undefined ? {} : { approvedOperatorOwners }),
  });
  process.stdout.write(
    `cluster bootstrap complete: ${String(result.groupRoles)} group roles, ` +
      `${String(result.loginsConfigured)} login principal(s) configured\n`,
  );
  if (result.loginsConfigured === 0) {
    process.stdout.write(
      'no login password supplied; group roles are bootstrapped and logins are managed elsewhere\n',
    );
  } else if (result.loginsConfigured < Object.keys(LOGIN_PRINCIPALS).length) {
    // Partial is a supported mode, not a warning: a deployment may manage some
    // principals through IaC and some through this CLI.
    process.stdout.write(
      `${String(result.loginsValidated)} existing principal(s) left unmodified and validated\n`,
    );
  }
}

main().catch((error: unknown) => {
  // The message may name a role; it never names a credential.
  process.stderr.write(
    `bootstrap failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});
