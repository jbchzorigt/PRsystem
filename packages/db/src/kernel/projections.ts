import type { Pool } from 'pg';

/**
 * Projection checkpoints and freshness (ADR-0019 §3, §5).
 *
 * A projection is global operational metadata, not tenant data, so these run
 * outside the tenant transaction. A stale projection must be visibly stale; a
 * silently stale one is treated as a defect.
 *
 * Nothing here may be read by a critical command. Authorization, payment and
 * refund eligibility, availability allocation, deposit balance and check-in
 * admission always read the authoritative row under lock (ADR-0019 §4).
 */

export type ProjectionStatus = 'idle' | 'running' | 'rebuilding' | 'failed';

export interface ProjectionFreshness {
  readonly projection: string;
  readonly lastEventId: string;
  readonly asOf: Date | null;
  readonly status: ProjectionStatus;
  /** Null until the projection has processed anything. */
  readonly lagSeconds: number | null;
}

export async function registerProjection(pool: Pool, projection: string): Promise<void> {
  await pool.query(
    `INSERT INTO platform.projection_checkpoint (projection)
     VALUES ($1) ON CONFLICT (projection) DO NOTHING`,
    [projection],
  );
}

/**
 * Advances the checkpoint with a compare-and-swap on `revision`, so two
 * concurrent projectors cannot interleave and move it backwards.
 */
export async function advanceCheckpoint(
  pool: Pool,
  projection: string,
  lastEventId: string,
  expectedRevision: number,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE platform.projection_checkpoint
        SET last_event_id = $2, as_of = now(), status = 'idle',
            updated_at = now(), revision = revision + 1
      WHERE projection = $1 AND revision = $3 AND last_event_id <= $2::bigint`,
    [projection, lastEventId, expectedRevision],
  );
  return result.rowCount === 1;
}

export async function setProjectionStatus(
  pool: Pool,
  projection: string,
  status: ProjectionStatus,
): Promise<void> {
  await pool.query(
    `UPDATE platform.projection_checkpoint
        SET status = $2, updated_at = now(), revision = revision + 1
      WHERE projection = $1`,
    [projection, status],
  );
}

export async function readFreshness(
  pool: Pool,
  projection: string,
): Promise<ProjectionFreshness | null> {
  const result = await pool.query<{
    projection: string;
    last_event_id: string;
    as_of: Date | null;
    status: ProjectionStatus;
    lag_seconds: string | null;
  }>(
    `SELECT projection, last_event_id::text AS last_event_id, as_of, status, lag_seconds::text
       FROM platform.projection_freshness WHERE projection = $1`,
    [projection],
  );

  const row = result.rows[0];
  if (row === undefined) return null;

  return {
    projection: row.projection,
    lastEventId: row.last_event_id,
    asOf: row.as_of,
    status: row.status,
    lagSeconds: row.lag_seconds === null ? null : Number(row.lag_seconds),
  };
}

/**
 * Marks a rebuild in progress. Losing a projection is an availability incident,
 * never a correctness one, because every projection is rebuildable from
 * authoritative records (ADR-0019 §5).
 */
export async function beginRebuild(pool: Pool, projection: string): Promise<void> {
  await pool.query(
    `UPDATE platform.projection_checkpoint
        SET status = 'rebuilding', last_event_id = 0, as_of = NULL,
            updated_at = now(), revision = revision + 1
      WHERE projection = $1`,
    [projection],
  );
}
