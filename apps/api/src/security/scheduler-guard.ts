import type { Pool } from 'pg';
import { assertRuntimePrincipal } from '@prsystem/db';
import type { Logger } from '@prsystem/telemetry';

/**
 * Startup guard for the job-scheduler connection (D-09).
 *
 * The scheduler credential is the API control plane's authority to *issue* a
 * privileged maintenance job. It must be exactly that and nothing more: a
 * connection that turned out to be the worker, the migration principal or a
 * superuser would collapse the separation the whole decision rests on, so the
 * process refuses to start rather than holding it.
 */
export async function assertSchedulerConnectionPrincipal(
  pool: Pool,
  logger: Logger,
): Promise<void> {
  const facts = await assertRuntimePrincipal(pool, 'prsystem_job_scheduler');
  // Role identity only. A connection string is a secret (CLAUDE.md §8).
  logger.info(
    { sessionUser: facts.sessionUser, memberOf: facts.memberOf },
    'scheduler principal verified',
  );
}
