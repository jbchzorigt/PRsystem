import type { Pool } from 'pg';
import { runPartitionMaintenance } from '@prsystem/db';
import type { Logger } from '@prsystem/telemetry';

/**
 * Audit partition maintenance (ADR-0018 §4).
 *
 * Extends coverage and then verifies it. A remaining shortfall means extension
 * itself failed, which is an incident worth waking someone for — and it is
 * detected before any audit write can fail.
 */
export const PARTITION_MAINTENANCE_JOB = 'kernel.audit.partition_maintenance';

export async function runPartitionMaintenanceJob(pool: Pool, logger: Logger): Promise<void> {
  const { created, alertsRaised } = await runPartitionMaintenance(pool);

  if (alertsRaised > 0) {
    logger.error(
      { job: PARTITION_MAINTENANCE_JOB, created, alertsRaised },
      'audit partition horizon is below its threshold',
    );
    return;
  }

  logger.info({ job: PARTITION_MAINTENANCE_JOB, created }, 'audit partitions verified');
}
