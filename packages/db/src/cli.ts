import { loadMigrationEnv } from '@prsystem/config';
import { runMigrations } from './migrate';

/**
 * `pnpm run migrate` — applies the journal as the restricted migration principal.
 *
 * Configuration comes from the **migration-only** contract, not the runtime one.
 * `MIGRATION_DATABASE_URL` names a principal that can apply DDL, so it is not
 * part of the environment the API or worker parses; both of those refuse to
 * start if they are handed it.
 *
 * There is no fallback to the runtime connection string: that variable holds a
 * runtime principal, and a migration applied as one would create objects owned
 * by the wrong role. `PRSYSTEM_APPROVED_OPERATOR_OWNERS` is equally mandatory
 * and has no default — the migration principal never owns the database, so any
 * inferred value would either refuse every real deployment or approve every
 * owner. Both are validated before a connection is opened, and neither value is
 * ever printed (CLAUDE.md §8).
 *
 *   MIGRATION_DATABASE_URL=postgresql://prsystem_migrate_login:…@host/prsystem \
 *   PRSYSTEM_APPROVED_OPERATOR_OWNERS=prsystem_operator \
 *   pnpm run migrate
 *
 * See `.env.migration.example` and docs/implementation/database-bootstrap-runbook.md.
 */
async function main(): Promise<void> {
  const config = loadMigrationEnv();
  const outcome = await runMigrations(config.migrationDatabaseUrl, {
    approvedOperatorOwners: config.approvedOperatorOwners,
  });
  const pending = outcome.appliedAfter - outcome.appliedBefore;

  process.stdout.write(
    `migrations applied: ${String(pending)} ` +
      `(ledger ${String(outcome.appliedBefore)} -> ${String(outcome.appliedAfter)})\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`migration failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
  process.exitCode = 1;
});
