import type { UnitOfWork } from '@prsystem/db';
import type { Channel } from './billing.repository';

/**
 * The refund request and what a late success turns it into (doc 20 §§4, 5, 7,
 * §3.2), and the financial correction that never edits what it corrects
 * (doc 20 §8).
 */

export type RefundState =
  'PENDING' | 'FAILED' | 'SUCCEEDED' | 'RELEASED' | 'RECONCILING' | 'RECONCILED';
export type ApprovalState = 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED';
export type CaseState = 'OPEN' | 'RECONCILING' | 'RESOLVED';
export type CaseOutcome = 'PROVIDER_STATUS_CORRECTED_NOT_SUCCESS' | 'PROVIDER_SUCCESS_POSTED';
export type CorrectionState = 'PENDING' | 'REJECTED' | 'EXECUTED';

export interface RefundRow {
  readonly requestId: string;
  readonly stayId: string;
  readonly originalTransactionId: string;
  readonly channel: Channel;
  readonly alternateChannel: boolean;
  readonly amountMnt: bigint;
  readonly state: RefundState;
  readonly approvalState: ApprovalState;
  readonly reason: string | null;
  readonly providerReference: string | null;
  readonly failureReason: string | null;
  readonly releaseReason: string | null;
  readonly revision: number;
}

export interface CaseRow {
  readonly caseId: string;
  readonly stayId: string;
  readonly refundRequestId: string;
  readonly state: CaseState;
  readonly outcome: CaseOutcome | null;
  readonly providerReference: string | null;
  readonly providerAmountMnt: bigint | null;
  readonly coveredAmountMnt: bigint | null;
  readonly shortfallAmountMnt: bigint | null;
  readonly claimedByAccountId: string | null;
  readonly revision: number;
}

export interface CorrectionRow {
  readonly correctionId: string;
  readonly stayId: string;
  readonly originalTransactionId: string;
  readonly state: CorrectionState;
  readonly reason: string;
  readonly correctedAmountMnt: bigint | null;
  readonly correctedChannel: Channel | null;
  readonly correctedReference: string | null;
  readonly reversalTransactionId: string | null;
  readonly correctedTransactionId: string | null;
  readonly revision: number;
}

const REFUND_COLUMNS = `request_id, stay_id, original_transaction_id, channel, alternate_channel,
  amount_mnt, state, approval_state, reason, provider_reference, failure_reason, release_reason,
  revision`;
const CASE_COLUMNS = `case_id, stay_id, refund_request_id, state, outcome, provider_reference,
  provider_amount_mnt, covered_amount_mnt, shortfall_amount_mnt, claimed_by_account_id, revision`;
const CORRECTION_COLUMNS = `correction_id, stay_id, original_transaction_id, state, reason,
  corrected_amount_mnt, corrected_channel, corrected_reference, reversal_transaction_id,
  corrected_transaction_id, revision`;

const bigOrNull = (value: unknown): bigint | null =>
  value === null || value === undefined ? null : BigInt(value as string);

function mapRefund(row: Record<string, unknown> | undefined): RefundRow | undefined {
  if (row === undefined) return undefined;
  return {
    requestId: row['request_id'] as string,
    stayId: row['stay_id'] as string,
    originalTransactionId: row['original_transaction_id'] as string,
    channel: row['channel'] as Channel,
    alternateChannel: row['alternate_channel'] === true,
    amountMnt: BigInt(row['amount_mnt'] as string),
    state: row['state'] as RefundState,
    approvalState: row['approval_state'] as ApprovalState,
    reason: (row['reason'] as string | null) ?? null,
    providerReference: (row['provider_reference'] as string | null) ?? null,
    failureReason: (row['failure_reason'] as string | null) ?? null,
    releaseReason: (row['release_reason'] as string | null) ?? null,
    revision: Number(row['revision']),
  };
}

function mapCase(row: Record<string, unknown> | undefined): CaseRow | undefined {
  if (row === undefined) return undefined;
  return {
    caseId: row['case_id'] as string,
    stayId: row['stay_id'] as string,
    refundRequestId: row['refund_request_id'] as string,
    state: row['state'] as CaseState,
    outcome: (row['outcome'] as CaseOutcome | null) ?? null,
    providerReference: (row['provider_reference'] as string | null) ?? null,
    providerAmountMnt: bigOrNull(row['provider_amount_mnt']),
    coveredAmountMnt: bigOrNull(row['covered_amount_mnt']),
    shortfallAmountMnt: bigOrNull(row['shortfall_amount_mnt']),
    claimedByAccountId: (row['claimed_by_account_id'] as string | null) ?? null,
    revision: Number(row['revision']),
  };
}

function mapCorrection(row: Record<string, unknown> | undefined): CorrectionRow | undefined {
  if (row === undefined) return undefined;
  return {
    correctionId: row['correction_id'] as string,
    stayId: row['stay_id'] as string,
    originalTransactionId: row['original_transaction_id'] as string,
    state: row['state'] as CorrectionState,
    reason: row['reason'] as string,
    correctedAmountMnt: bigOrNull(row['corrected_amount_mnt']),
    correctedChannel: (row['corrected_channel'] as Channel | null) ?? null,
    correctedReference: (row['corrected_reference'] as string | null) ?? null,
    reversalTransactionId: (row['reversal_transaction_id'] as string | null) ?? null,
    correctedTransactionId: (row['corrected_transaction_id'] as string | null) ?? null,
    revision: Number(row['revision']),
  };
}

export class RefundRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get hotelId(): string {
    return this.uow.context.hotelId;
  }

  async createRefund(input: {
    stayId: string;
    originalTransactionId: string;
    channel: Channel;
    alternateChannel: boolean;
    amountMnt: bigint;
    reason?: string;
    accountId: string;
    at: Date;
  }): Promise<RefundRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.refund_request
         (hotel_id, stay_id, original_transaction_id, channel, alternate_channel, amount_mnt,
          approval_state, reason, requested_by_account_id, requested_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${REFUND_COLUMNS}`,
      [
        this.hotelId,
        input.stayId,
        input.originalTransactionId,
        input.channel,
        input.alternateChannel,
        input.amountMnt.toString(),
        input.alternateChannel ? 'PENDING' : 'NOT_REQUIRED',
        input.reason ?? null,
        input.accountId,
        input.at,
      ],
    );
    return mapRefund(result.rows[0]) as RefundRow;
  }

  async refund(requestId: string): Promise<RefundRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${REFUND_COLUMNS} FROM platform.refund_request
        WHERE hotel_id = $1 AND request_id = $2`,
      [this.hotelId, requestId],
    );
    return mapRefund(result.rows[0]);
  }

  async lockRefund(requestId: string): Promise<RefundRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${REFUND_COLUMNS} FROM platform.refund_request
        WHERE hotel_id = $1 AND request_id = $2 FOR UPDATE`,
      [this.hotelId, requestId],
    );
    return mapRefund(result.rows[0]);
  }

  async refundsOfStay(stayId: string): Promise<readonly RefundRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${REFUND_COLUMNS} FROM platform.refund_request
        WHERE hotel_id = $1 AND stay_id = $2 ORDER BY requested_at`,
      [this.hotelId, stayId],
    );
    return result.rows.map((row) => mapRefund(row) as RefundRow);
  }

  async updateRefund(input: {
    requestId: string;
    expectedRevision: number;
    state?: RefundState;
    approvalState?: ApprovalState;
    providerReference?: string;
    failureReason?: string;
    decidedByAccountId?: string;
    decidedAt?: Date;
    releasedByAccountId?: string;
    releasedAt?: Date;
    releaseReason?: string;
    settledAt?: Date;
  }): Promise<RefundRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.refund_request
          SET state = COALESCE($4, state),
              approval_state = COALESCE($5, approval_state),
              provider_reference = COALESCE($6, provider_reference),
              failure_reason = COALESCE($7, failure_reason),
              decided_by_account_id = COALESCE($8, decided_by_account_id),
              decided_at = COALESCE($9, decided_at),
              released_by_account_id = COALESCE($10, released_by_account_id),
              released_at = COALESCE($11, released_at),
              release_reason = COALESCE($12, release_reason),
              settled_at = COALESCE($13, settled_at),
              revision = revision + 1
        WHERE hotel_id = $1 AND request_id = $2 AND revision = $3
        RETURNING ${REFUND_COLUMNS}`,
      [
        this.hotelId,
        input.requestId,
        input.expectedRevision,
        input.state ?? null,
        input.approvalState ?? null,
        input.providerReference ?? null,
        input.failureReason ?? null,
        input.decidedByAccountId ?? null,
        input.decidedAt ?? null,
        input.releasedByAccountId ?? null,
        input.releasedAt ?? null,
        input.releaseReason ?? null,
        input.settledAt ?? null,
      ],
    );
    return mapRefund(result.rows[0]);
  }

  // ------------------------------------------------- reconciliation case

  async openCase(input: {
    stayId: string;
    refundRequestId: string;
    providerReference: string | null;
    providerAmountMnt: bigint | null;
  }): Promise<CaseRow> {
    const inserted = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.deposit_reconciliation_case
         (hotel_id, stay_id, refund_request_id, provider_reference, provider_amount_mnt)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (refund_request_id) DO NOTHING
       RETURNING ${CASE_COLUMNS}`,
      [
        this.hotelId,
        input.stayId,
        input.refundRequestId,
        input.providerReference,
        input.providerAmountMnt?.toString() ?? null,
      ],
    );
    const row = mapCase(inserted.rows[0]);
    if (row !== undefined) return row;
    const existing = await this.caseOfRefund(input.refundRequestId);
    if (existing === undefined) throw new Error('the case neither inserted nor exists');
    return existing;
  }

  async caseOfRefund(refundRequestId: string): Promise<CaseRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CASE_COLUMNS} FROM platform.deposit_reconciliation_case
        WHERE hotel_id = $1 AND refund_request_id = $2`,
      [this.hotelId, refundRequestId],
    );
    return mapCase(result.rows[0]);
  }

  async lockCase(caseId: string): Promise<CaseRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CASE_COLUMNS} FROM platform.deposit_reconciliation_case
        WHERE hotel_id = $1 AND case_id = $2 FOR UPDATE`,
      [this.hotelId, caseId],
    );
    return mapCase(result.rows[0]);
  }

  async openCases(): Promise<readonly CaseRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CASE_COLUMNS} FROM platform.deposit_reconciliation_case
        WHERE hotel_id = $1 AND state <> 'RESOLVED' ORDER BY opened_at`,
      [this.hotelId],
    );
    return result.rows.map((row) => mapCase(row) as CaseRow);
  }

  async updateCase(input: {
    caseId: string;
    expectedRevision: number;
    state?: CaseState;
    outcome?: CaseOutcome;
    coveredAmountMnt?: bigint;
    shortfallAmountMnt?: bigint;
    claimedByAccountId?: string;
    claimedAt?: Date;
    resolvedByAccountId?: string;
    resolvedAt?: Date;
    resolutionNote?: string;
  }): Promise<CaseRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.deposit_reconciliation_case
          SET state = COALESCE($4, state),
              outcome = COALESCE($5, outcome),
              covered_amount_mnt = COALESCE($6, covered_amount_mnt),
              shortfall_amount_mnt = COALESCE($7, shortfall_amount_mnt),
              claimed_by_account_id = COALESCE($8, claimed_by_account_id),
              claimed_at = COALESCE($9, claimed_at),
              resolved_by_account_id = COALESCE($10, resolved_by_account_id),
              resolved_at = COALESCE($11, resolved_at),
              resolution_note = COALESCE($12, resolution_note),
              revision = revision + 1
        WHERE hotel_id = $1 AND case_id = $2 AND revision = $3
        RETURNING ${CASE_COLUMNS}`,
      [
        this.hotelId,
        input.caseId,
        input.expectedRevision,
        input.state ?? null,
        input.outcome ?? null,
        input.coveredAmountMnt?.toString() ?? null,
        input.shortfallAmountMnt?.toString() ?? null,
        input.claimedByAccountId ?? null,
        input.claimedAt ?? null,
        input.resolvedByAccountId ?? null,
        input.resolvedAt ?? null,
        input.resolutionNote ?? null,
      ],
    );
    return mapCase(result.rows[0]);
  }

  async postFinanceEvent(input: {
    stayId: string;
    caseId: string;
    amountMnt: bigint;
    reference: string | null;
    note: string;
  }): Promise<string> {
    const result = await this.uow.query<{ event_id: string }>(
      `INSERT INTO platform.hotel_finance_event
         (hotel_id, stay_id, kind, amount_mnt, reference, case_id, note)
       VALUES ($1, $2, 'LATE_REFUND_SHORTFALL', $3, $4, $5, $6)
       RETURNING event_id`,
      [
        this.hotelId,
        input.stayId,
        input.amountMnt.toString(),
        input.reference,
        input.caseId,
        input.note,
      ],
    );
    return result.rows[0]?.event_id as string;
  }

  async financeEvents(
    stayId: string,
  ): Promise<readonly { readonly kind: string; readonly amountMnt: bigint }[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT kind, amount_mnt FROM platform.hotel_finance_event
        WHERE hotel_id = $1 AND stay_id = $2 ORDER BY occurred_at`,
      [this.hotelId, stayId],
    );
    return result.rows.map((row) => ({
      kind: row['kind'] as string,
      amountMnt: BigInt(row['amount_mnt'] as string),
    }));
  }

  // --------------------------------------------------------- correction

  async createCorrection(input: {
    stayId: string;
    originalTransactionId: string;
    reason: string;
    correctedAmountMnt: bigint | null;
    correctedChannel: Channel | null;
    correctedReference: string | null;
    accountId: string;
    at: Date;
  }): Promise<CorrectionRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.financial_correction
         (hotel_id, stay_id, original_transaction_id, reason, corrected_amount_mnt,
          corrected_channel, corrected_reference, requested_by_account_id, requested_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${CORRECTION_COLUMNS}`,
      [
        this.hotelId,
        input.stayId,
        input.originalTransactionId,
        input.reason,
        input.correctedAmountMnt?.toString() ?? null,
        input.correctedChannel,
        input.correctedReference,
        input.accountId,
        input.at,
      ],
    );
    return mapCorrection(result.rows[0]) as CorrectionRow;
  }

  async correction(correctionId: string): Promise<CorrectionRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CORRECTION_COLUMNS} FROM platform.financial_correction
        WHERE hotel_id = $1 AND correction_id = $2`,
      [this.hotelId, correctionId],
    );
    return mapCorrection(result.rows[0]);
  }

  async lockCorrection(correctionId: string): Promise<CorrectionRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CORRECTION_COLUMNS} FROM platform.financial_correction
        WHERE hotel_id = $1 AND correction_id = $2 FOR UPDATE`,
      [this.hotelId, correctionId],
    );
    return mapCorrection(result.rows[0]);
  }

  async correctionsOfStay(stayId: string): Promise<readonly CorrectionRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CORRECTION_COLUMNS} FROM platform.financial_correction
        WHERE hotel_id = $1 AND stay_id = $2 ORDER BY requested_at`,
      [this.hotelId, stayId],
    );
    return result.rows.map((row) => mapCorrection(row) as CorrectionRow);
  }

  async decideCorrection(input: {
    correctionId: string;
    expectedRevision: number;
    state: 'REJECTED' | 'EXECUTED';
    accountId: string;
    at: Date;
    decisionReason?: string;
    reversalTransactionId?: string;
    correctedTransactionId?: string;
  }): Promise<CorrectionRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.financial_correction
          SET state = $4, decided_by_account_id = $5, decided_at = $6,
              decision_reason = COALESCE($7, decision_reason),
              reversal_transaction_id = COALESCE($8, reversal_transaction_id),
              corrected_transaction_id = COALESCE($9, corrected_transaction_id),
              revision = revision + 1
        WHERE hotel_id = $1 AND correction_id = $2 AND revision = $3
        RETURNING ${CORRECTION_COLUMNS}`,
      [
        this.hotelId,
        input.correctionId,
        input.expectedRevision,
        input.state,
        input.accountId,
        input.at,
        input.decisionReason ?? null,
        input.reversalTransactionId ?? null,
        input.correctedTransactionId ?? null,
      ],
    );
    return mapCorrection(result.rows[0]);
  }
}
