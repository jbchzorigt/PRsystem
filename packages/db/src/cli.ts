import { env } from '@prsystem/config';
import { runMigrations } from './migrate';

/**
 * `pnpm --filter @prsystem/db run migrate` — applies the journal to DATABASE_URL.
 *
 * Only the counts are printed. A connection string carries a password and must
 * never reach stdout, a log or a trace (CLAUDE.md §8).
 */
async function main(): Promise<void> {
  const outcome = await runMigrations(env().DATABASE_URL);
  const pending = outcome.appliedAfter - outcome.appliedBefore;
  process.stdout.write(
    `migrations applied: ${String(pending)} (ledger ${String(outcome.appliedBefore)} -> ${String(outcome.appliedAfter)})\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`migration failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
  process.exitCode = 1;
});
