import type { Pool } from 'pg';

/**
 * Audit partition maintenance (ADR-0018 §4).
 *
 * Partitions are pre-created and the horizon is checked, so a missing partition
 * is an operational incident detected *before* a write fails rather than after.
 */

export const AUDIT_STREAMS = [
  { schema: 'audit', table: 'platform_event' },
  { schema: 'police_audit', table: 'security_event' },
] as const;

/** Months of coverage kept ahead. Below `HORIZON_THRESHOLD_MONTHS` raises an alert. */
export const HORIZON_TARGET_MONTHS = 4;
export const HORIZON_THRESHOLD_MONTHS = 3;

export interface PartitionHorizon {
  readonly schema: string;
  readonly table: string;
  readonly months: number;
}

export async function ensureAuditPartitions(
  pool: Pool,
  months = HORIZON_TARGET_MONTHS,
): Promise<number> {
  let created = 0;
  for (const stream of AUDIT_STREAMS) {
    const result = await pool.query<{ created: number }>(
      'SELECT platform.ensure_month_partitions($1, $2, now(), $3) AS created',
      [stream.schema, stream.table, months],
    );
    created += result.rows[0]?.created ?? 0;
  }
  return created;
}

export async function readPartitionHorizons(pool: Pool): Promise<PartitionHorizon[]> {
  const horizons: PartitionHorizon[] = [];
  for (const stream of AUDIT_STREAMS) {
    const result = await pool.query<{ months: number }>(
      'SELECT platform.partition_horizon($1, $2) AS months',
      [stream.schema, stream.table],
    );
    horizons.push({
      schema: stream.schema,
      table: stream.table,
      months: result.rows[0]?.months ?? 0,
    });
  }
  return horizons;
}

/**
 * Raises an alert row per stream that has fallen below the threshold. Returns how
 * many were raised, so the caller can log a single summary rather than a line per
 * check.
 */
export async function checkPartitionHorizon(
  pool: Pool,
  thresholdMonths = HORIZON_THRESHOLD_MONTHS,
): Promise<number> {
  const result = await pool.query<{ raised: number }>(
    'SELECT platform.check_partition_horizon($1) AS raised',
    [thresholdMonths],
  );
  return result.rows[0]?.raised ?? 0;
}

/**
 * The maintenance job: extend coverage first, then verify. Verifying after
 * extending means an alert only fires when extension itself could not fix it.
 */
export async function runPartitionMaintenance(
  pool: Pool,
): Promise<{ created: number; alertsRaised: number }> {
  const created = await ensureAuditPartitions(pool);
  const alertsRaised = await checkPartitionHorizon(pool);
  return { created, alertsRaised };
}
