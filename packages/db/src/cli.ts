import { runMigrations } from './migrate';

/**
 * `pnpm run migrate` — applies the journal as the restricted migration principal.
 *
 * Reads MIGRATION_DATABASE_URL and **never** falls back to DATABASE_URL: the
 * runtime connection string belongs to the API or worker principal, and a
 * migration must not run as either. A missing or malformed value fails before a
 * connection is attempted, and the value itself is never printed (CLAUDE.md §8).
 */
function requireMigrationUrl(): string {
  const raw = process.env['MIGRATION_DATABASE_URL'];

  if (raw === undefined || raw.trim().length === 0) {
    throw new Error(
      'MIGRATION_DATABASE_URL is required. It must name the restricted migration ' +
        'principal; DATABASE_URL is deliberately not used as a fallback. ' +
        'See docs/implementation/database-bootstrap-runbook.md',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // The message names the variable, never its content.
    throw new Error('MIGRATION_DATABASE_URL is not a valid URL');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('MIGRATION_DATABASE_URL must be a postgres:// or postgresql:// URL');
  }
  if (parsed.username.length === 0) {
    throw new Error('MIGRATION_DATABASE_URL must name a migration login principal');
  }

  return raw;
}

async function main(): Promise<void> {
  const url = requireMigrationUrl();
  const outcome = await runMigrations(url);
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
