import type { UnitOfWork } from '@prsystem/db';

/**
 * The active-stay actual-time correction (doc 05 §20, `STAY-DEC-010`): a
 * request with a fixed bound, one pending per stay, decided once.
 */

export type CorrectionState = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface CorrectionRow {
  readonly correctionId: string;
  readonly stayId: string;
  readonly state: CorrectionState;
  readonly previousEffectiveAt: Date;
  readonly correctedActualCheckInAt: Date;
  readonly earliestAllowedAt: Date;
  readonly latestAllowedAt: Date;
  readonly reason: string;
  readonly requestedByAccountId: string;
  readonly requestedAt: Date;
  readonly decidedByAccountId: string | null;
  readonly decidedAt: Date | null;
  readonly decisionReason: string | null;
  readonly selfApproved: boolean;
  readonly revision: number;
}

const COLUMNS = `correction_id, stay_id, state, previous_effective_at, corrected_actual_check_in_at,
  earliest_allowed_at, latest_allowed_at, reason, requested_by_account_id, requested_at,
  decided_by_account_id, decided_at, decision_reason, self_approved, revision`;

function mapCorrection(row: Record<string, unknown> | undefined): CorrectionRow | undefined {
  if (row === undefined) return undefined;
  return {
    correctionId: row['correction_id'] as string,
    stayId: row['stay_id'] as string,
    state: row['state'] as CorrectionState,
    previousEffectiveAt: row['previous_effective_at'] as Date,
    correctedActualCheckInAt: row['corrected_actual_check_in_at'] as Date,
    earliestAllowedAt: row['earliest_allowed_at'] as Date,
    latestAllowedAt: row['latest_allowed_at'] as Date,
    reason: row['reason'] as string,
    requestedByAccountId: row['requested_by_account_id'] as string,
    requestedAt: row['requested_at'] as Date,
    decidedByAccountId: (row['decided_by_account_id'] as string | null) ?? null,
    decidedAt: (row['decided_at'] as Date | null) ?? null,
    decisionReason: (row['decision_reason'] as string | null) ?? null,
    selfApproved: row['self_approved'] as boolean,
    revision: Number(row['revision']),
  };
}

export class CorrectionRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get hotelId(): string {
    return this.uow.context.hotelId;
  }

  async create(input: {
    stayId: string;
    previousEffectiveAt: Date;
    correctedActualCheckInAt: Date;
    earliestAllowedAt: Date;
    latestAllowedAt: Date;
    reason: string;
    requestedByAccountId: string;
    requestedAt: Date;
  }): Promise<CorrectionRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.stay_time_correction
         (hotel_id, stay_id, previous_effective_at, corrected_actual_check_in_at, earliest_allowed_at,
          latest_allowed_at, reason, requested_by_account_id, requested_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
      [
        this.hotelId,
        input.stayId,
        input.previousEffectiveAt,
        input.correctedActualCheckInAt,
        input.earliestAllowedAt,
        input.latestAllowedAt,
        input.reason,
        input.requestedByAccountId,
        input.requestedAt,
      ],
    );
    const row = mapCorrection(result.rows[0]);
    if (row === undefined) throw new Error('the correction insert returned no row');
    return row;
  }

  async byId(correctionId: string): Promise<CorrectionRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.stay_time_correction WHERE hotel_id = $1 AND correction_id = $2`,
      [this.hotelId, correctionId],
    );
    return mapCorrection(result.rows[0]);
  }

  async lock(correctionId: string): Promise<CorrectionRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.stay_time_correction
        WHERE hotel_id = $1 AND correction_id = $2 FOR UPDATE`,
      [this.hotelId, correctionId],
    );
    return mapCorrection(result.rows[0]);
  }

  async pendingOf(stayId: string): Promise<CorrectionRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.stay_time_correction
        WHERE hotel_id = $1 AND stay_id = $2 AND state = 'PENDING'`,
      [this.hotelId, stayId],
    );
    return mapCorrection(result.rows[0]);
  }

  /** The latest approved correction, whose corrected time is the effective actual start. */
  async latestApproved(stayId: string): Promise<CorrectionRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.stay_time_correction
        WHERE hotel_id = $1 AND stay_id = $2 AND state = 'APPROVED'
        ORDER BY decided_at DESC, correction_id DESC LIMIT 1`,
      [this.hotelId, stayId],
    );
    return mapCorrection(result.rows[0]);
  }

  async latestApprovedOf(stayIds: readonly string[]): Promise<Map<string, CorrectionRow>> {
    if (stayIds.length === 0) return new Map();
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT DISTINCT ON (stay_id) ${COLUMNS} FROM platform.stay_time_correction
        WHERE hotel_id = $1 AND stay_id = ANY($2::uuid[]) AND state = 'APPROVED'
        ORDER BY stay_id, decided_at DESC, correction_id DESC`,
      [this.hotelId, stayIds],
    );
    return new Map(
      result.rows.map((row) => [row['stay_id'] as string, mapCorrection(row) as CorrectionRow]),
    );
  }

  async history(stayId: string): Promise<readonly CorrectionRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM platform.stay_time_correction
        WHERE hotel_id = $1 AND stay_id = $2 ORDER BY requested_at, correction_id`,
      [this.hotelId, stayId],
    );
    return result.rows.map((row) => mapCorrection(row) as CorrectionRow);
  }

  async decide(input: {
    correctionId: string;
    expectedRevision: number;
    state: 'APPROVED' | 'REJECTED';
    decidedByAccountId: string;
    decidedAt: Date;
    decisionReason: string | null;
    selfApproved: boolean;
  }): Promise<CorrectionRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.stay_time_correction
          SET state = $4, decided_by_account_id = $5, decided_at = $6, decision_reason = $7,
              self_approved = $8, revision = revision + 1
        WHERE hotel_id = $1 AND correction_id = $2 AND revision = $3 AND state = 'PENDING'
        RETURNING ${COLUMNS}`,
      [
        this.hotelId,
        input.correctionId,
        input.expectedRevision,
        input.state,
        input.decidedByAccountId,
        input.decidedAt,
        input.decisionReason,
        input.selfApproved,
      ],
    );
    return mapCorrection(result.rows[0]);
  }
}
