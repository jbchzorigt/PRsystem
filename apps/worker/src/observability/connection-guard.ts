import type { Pool } from 'pg';
import { assertRuntimePrincipal } from '@prsystem/db';
import type { Logger } from '@prsystem/telemetry';

/**
 * Startup credential guard for the worker — same rule as the API.
 *
 * A worker holding the migration or maintenance credential would let a job do
 * cross-tenant work that the job contract never granted it.
 */
export async function assertWorkerConnectionPrincipal(pool: Pool, logger: Logger): Promise<void> {
  const facts = await assertRuntimePrincipal(pool, 'prsystem_worker');
  // Only role identity is logged. A connection string is a secret (CLAUDE.md §8).
  logger.info(
    { sessionUser: facts.sessionUser, memberOf: facts.memberOf },
    'database principal verified',
  );
}
