import type { Pool } from 'pg';
import { assertRuntimePrincipal } from '@prsystem/db';
import type { Logger } from '@prsystem/telemetry';

/**
 * Startup credential guard.
 *
 * The API must run as a restricted runtime principal. Holding the migration,
 * owner, maintenance or a DBA credential would silently give every request more
 * reach than the authorization pipeline assumes, so the process refuses to start
 * rather than serving traffic with the wrong identity.
 */
export async function assertApiConnectionPrincipal(pool: Pool, logger: Logger): Promise<void> {
  const facts = await assertRuntimePrincipal(pool, 'prsystem_api');
  // Only role identity is logged. A connection string is a secret (CLAUDE.md §8).
  logger.info(
    { sessionUser: facts.sessionUser, memberOf: facts.memberOf },
    'database principal verified',
  );
}
