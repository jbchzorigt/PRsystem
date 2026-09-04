import type { UnitOfWork } from '@prsystem/db';

/**
 * The minibar usage report, its immutable versions and priced lines, the
 * guest's disputes, the payment attempt's lock and the adjustments that follow
 * a settlement (doc 21, `CHK-DEC-001`…`-006`).
 *
 * Nothing here updates a version, a line or an adjustment: the API holds no
 * `UPDATE` on those tables, and a correction is a new row.
 */

export type ReportState =
  'PENDING' | 'IN_INSPECTION' | 'SUBMITTED' | 'RETURNED' | 'LOCKED' | 'SETTLED' | 'CANCELLED';

export type ReportVersionKind = 'NORMAL' | 'EXCEPTION';
export type SubmittedRole = 'CLEANER' | 'MANAGER' | 'MANAGER_PLUS';
export type DisputeState = 'OPEN' | 'UPHELD' | 'WAIVED';
export type LockState = 'HELD' | 'RELEASED' | 'SETTLED';
export type ProviderStatus = 'PENDING' | 'UNKNOWN' | 'FAILED_NO_FUNDS' | 'SUCCEEDED';
export type AdjustmentKind = 'OVERCHARGE_REVERSAL' | 'UNDERCHARGE_RECEIVABLE' | 'DISPUTE_WAIVER';

export interface ReportRow {
  readonly reportId: string;
  readonly stayId: string;
  readonly roomId: string;
  readonly state: ReportState;
  readonly currentVersionId: string | null;
  readonly claimedByAccountId: string | null;
  readonly claimedAt: Date | null;
  readonly openedAt: Date;
  readonly settledAt: Date | null;
  readonly reason: string | null;
  readonly revision: number;
}

export interface ReportVersionRow {
  readonly versionId: string;
  readonly reportId: string;
  readonly versionNo: number;
  readonly kind: ReportVersionKind;
  readonly noUsage: boolean;
  readonly reason: string | null;
  readonly submittedByAccountId: string;
  readonly submittedRole: SubmittedRole;
  readonly cutoffAt: Date;
  readonly totalMnt: bigint;
  readonly createdAt: Date;
}

export interface ReportLineRow {
  readonly lineId: string;
  readonly versionId: string;
  readonly productId: string;
  readonly productName: string;
  readonly openingQuantity: number;
  readonly refillQuantity: number;
  readonly nonGuestOutQuantity: number;
  readonly countedQuantity: number;
  readonly billableQuantity: number;
  readonly unitPriceMnt: bigint;
  readonly lineTotalMnt: bigint;
}

export interface DisputeRow {
  readonly disputeId: string;
  readonly reportId: string;
  readonly versionId: string;
  readonly productId: string;
  readonly disputedQuantity: number;
  readonly state: DisputeState;
  readonly note: string;
  readonly notedByAccountId: string;
  readonly notedAt: Date;
  readonly resolvedByAccountId: string | null;
  readonly resolvedAt: Date | null;
  readonly resolutionReason: string | null;
  readonly waivedAmountMnt: bigint | null;
  readonly revision: number;
}

export interface PaymentLockRow {
  readonly lockId: string;
  readonly reportId: string;
  readonly versionId: string;
  readonly attemptRef: string;
  readonly state: LockState;
  readonly providerStatus: ProviderStatus | null;
  readonly amountMnt: bigint;
  readonly lockedAt: Date;
  readonly lockedByAccountId: string;
  readonly resolvedAt: Date | null;
  readonly resolvedByAccountId: string | null;
  readonly revision: number;
}

export interface AdjustmentRow {
  readonly adjustmentId: string;
  readonly reportId: string;
  readonly originalVersionId: string;
  readonly lockId: string;
  readonly kind: AdjustmentKind;
  readonly productId: string | null;
  readonly quantity: number | null;
  readonly unitPriceMnt: bigint | null;
  readonly amountMnt: bigint;
  readonly reason: string;
  readonly actorAccountId: string;
  readonly createdAt: Date;
}

// The current version is the last one submitted: the chain is the truth, and
// the report keeps no pointer that could disagree with it (`CHK-DEC-003`).
const REPORT_COLUMNS = `report_id, stay_id, room_id, state,
  (SELECT v.version_id FROM platform.minibar_usage_report_version v
    WHERE v.report_id = platform.minibar_usage_report.report_id
    ORDER BY v.version_no DESC LIMIT 1) AS current_version_id,
  claimed_by_account_id, claimed_at, opened_at, settled_at, reason, revision`;
const VERSION_COLUMNS = `version_id, report_id, version_no, kind, no_usage, reason,
  submitted_by_account_id, submitted_role, cutoff_at, total_mnt, created_at`;
const LINE_COLUMNS = `line_id, version_id, product_id, product_name, opening_quantity,
  refill_quantity, non_guest_out_quantity, counted_quantity, billable_quantity,
  unit_price_mnt, line_total_mnt`;
const DISPUTE_COLUMNS = `dispute_id, report_id, version_id, product_id, disputed_quantity, state,
  note, noted_by_account_id, noted_at, resolved_by_account_id, resolved_at, resolution_reason,
  waived_amount_mnt, revision`;
const LOCK_COLUMNS = `lock_id, report_id, version_id, attempt_ref, state, provider_status,
  amount_mnt, locked_at, locked_by_account_id, resolved_at, resolved_by_account_id, revision`;
const ADJUSTMENT_COLUMNS = `adjustment_id, report_id, original_version_id, lock_id, kind,
  product_id, quantity, unit_price_mnt, amount_mnt, reason, actor_account_id, created_at`;

function bigintOrNull(value: unknown): bigint | null {
  return value === null || value === undefined ? null : BigInt(value as string);
}

function mapReport(row: Record<string, unknown> | undefined): ReportRow | undefined {
  if (row === undefined) return undefined;
  return {
    reportId: row['report_id'] as string,
    stayId: row['stay_id'] as string,
    roomId: row['room_id'] as string,
    state: row['state'] as ReportState,
    currentVersionId: (row['current_version_id'] as string | null) ?? null,
    claimedByAccountId: (row['claimed_by_account_id'] as string | null) ?? null,
    claimedAt: (row['claimed_at'] as Date | null) ?? null,
    openedAt: row['opened_at'] as Date,
    settledAt: (row['settled_at'] as Date | null) ?? null,
    reason: (row['reason'] as string | null) ?? null,
    revision: Number(row['revision']),
  };
}

function mapVersion(row: Record<string, unknown>): ReportVersionRow {
  return {
    versionId: row['version_id'] as string,
    reportId: row['report_id'] as string,
    versionNo: Number(row['version_no']),
    kind: row['kind'] as ReportVersionKind,
    noUsage: row['no_usage'] === true,
    reason: (row['reason'] as string | null) ?? null,
    submittedByAccountId: row['submitted_by_account_id'] as string,
    submittedRole: row['submitted_role'] as SubmittedRole,
    cutoffAt: row['cutoff_at'] as Date,
    totalMnt: BigInt(row['total_mnt'] as string),
    createdAt: row['created_at'] as Date,
  };
}

function mapLine(row: Record<string, unknown>): ReportLineRow {
  return {
    lineId: row['line_id'] as string,
    versionId: row['version_id'] as string,
    productId: row['product_id'] as string,
    productName: row['product_name'] as string,
    openingQuantity: Number(row['opening_quantity']),
    refillQuantity: Number(row['refill_quantity']),
    nonGuestOutQuantity: Number(row['non_guest_out_quantity']),
    countedQuantity: Number(row['counted_quantity']),
    billableQuantity: Number(row['billable_quantity']),
    unitPriceMnt: BigInt(row['unit_price_mnt'] as string),
    lineTotalMnt: BigInt(row['line_total_mnt'] as string),
  };
}

function mapDispute(row: Record<string, unknown> | undefined): DisputeRow | undefined {
  if (row === undefined) return undefined;
  return {
    disputeId: row['dispute_id'] as string,
    reportId: row['report_id'] as string,
    versionId: row['version_id'] as string,
    productId: row['product_id'] as string,
    disputedQuantity: Number(row['disputed_quantity']),
    state: row['state'] as DisputeState,
    note: row['note'] as string,
    notedByAccountId: row['noted_by_account_id'] as string,
    notedAt: row['noted_at'] as Date,
    resolvedByAccountId: (row['resolved_by_account_id'] as string | null) ?? null,
    resolvedAt: (row['resolved_at'] as Date | null) ?? null,
    resolutionReason: (row['resolution_reason'] as string | null) ?? null,
    waivedAmountMnt: bigintOrNull(row['waived_amount_mnt']),
    revision: Number(row['revision']),
  };
}

function mapLock(row: Record<string, unknown> | undefined): PaymentLockRow | undefined {
  if (row === undefined) return undefined;
  return {
    lockId: row['lock_id'] as string,
    reportId: row['report_id'] as string,
    versionId: row['version_id'] as string,
    attemptRef: row['attempt_ref'] as string,
    state: row['state'] as LockState,
    providerStatus: (row['provider_status'] as ProviderStatus | null) ?? null,
    amountMnt: BigInt(row['amount_mnt'] as string),
    lockedAt: row['locked_at'] as Date,
    lockedByAccountId: row['locked_by_account_id'] as string,
    resolvedAt: (row['resolved_at'] as Date | null) ?? null,
    resolvedByAccountId: (row['resolved_by_account_id'] as string | null) ?? null,
    revision: Number(row['revision']),
  };
}

function mapAdjustment(row: Record<string, unknown>): AdjustmentRow {
  return {
    adjustmentId: row['adjustment_id'] as string,
    reportId: row['report_id'] as string,
    originalVersionId: row['original_version_id'] as string,
    lockId: row['lock_id'] as string,
    kind: row['kind'] as AdjustmentKind,
    productId: (row['product_id'] as string | null) ?? null,
    quantity: row['quantity'] === null ? null : Number(row['quantity']),
    unitPriceMnt: bigintOrNull(row['unit_price_mnt']),
    amountMnt: BigInt(row['amount_mnt'] as string),
    reason: row['reason'] as string,
    actorAccountId: row['actor_account_id'] as string,
    createdAt: row['created_at'] as Date,
  };
}

export interface InsertLineInput {
  readonly productId: string;
  readonly productName: string;
  readonly openingQuantity: number;
  readonly refillQuantity: number;
  readonly nonGuestOutQuantity: number;
  readonly countedQuantity: number;
  readonly billableQuantity: number;
  readonly unitPriceMnt: bigint;
  readonly lineTotalMnt: bigint;
}

export class ReportRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get hotelId(): string {
    return this.uow.context.hotelId;
  }

  // ---------------------------------------------------------------- report

  async open(input: {
    stayId: string;
    roomId: string;
    openedAt: Date;
  }): Promise<{ readonly report: ReportRow; readonly opened: boolean }> {
    const inserted = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.minibar_usage_report (hotel_id, stay_id, room_id, opened_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (hotel_id, stay_id) WHERE state <> ALL (ARRAY['SETTLED'::text, 'CANCELLED'::text])
       DO NOTHING
       RETURNING ${REPORT_COLUMNS}`,
      [this.hotelId, input.stayId, input.roomId, input.openedAt],
    );
    const row = mapReport(inserted.rows[0]);
    if (row !== undefined) return { report: row, opened: true };
    const existing = await this.liveOfStay(input.stayId);
    if (existing === undefined) throw new Error('the usage report neither inserted nor exists');
    return { report: existing, opened: false };
  }

  async byId(reportId: string): Promise<ReportRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${REPORT_COLUMNS} FROM platform.minibar_usage_report
        WHERE hotel_id = $1 AND report_id = $2`,
      [this.hotelId, reportId],
    );
    return mapReport(result.rows[0]);
  }

  async lock(reportId: string): Promise<ReportRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${REPORT_COLUMNS} FROM platform.minibar_usage_report
        WHERE hotel_id = $1 AND report_id = $2 FOR UPDATE`,
      [this.hotelId, reportId],
    );
    return mapReport(result.rows[0]);
  }

  async liveOfStay(stayId: string): Promise<ReportRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${REPORT_COLUMNS} FROM platform.minibar_usage_report
        WHERE hotel_id = $1 AND stay_id = $2
          AND state <> ALL (ARRAY['SETTLED'::text, 'CANCELLED'::text])`,
      [this.hotelId, stayId],
    );
    return mapReport(result.rows[0]);
  }

  async openQueue(): Promise<readonly ReportRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${REPORT_COLUMNS} FROM platform.minibar_usage_report
        WHERE hotel_id = $1 AND state IN ('PENDING', 'IN_INSPECTION', 'RETURNED')
        ORDER BY opened_at`,
      [this.hotelId],
    );
    return result.rows.map((row) => mapReport(row) as ReportRow);
  }

  async transition(input: {
    reportId: string;
    expectedRevision: number;
    toState: ReportState;
    claimedByAccountId?: string;
    claimedAt?: Date;
    settledAt?: Date;
    reason?: string;
  }): Promise<ReportRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.minibar_usage_report
          SET state = $4,
              claimed_by_account_id = COALESCE($5, claimed_by_account_id),
              claimed_at = COALESCE($6, claimed_at),
              settled_at = COALESCE($7, settled_at),
              reason = COALESCE($8, reason),
              revision = revision + 1
        WHERE hotel_id = $1 AND report_id = $2 AND revision = $3
        RETURNING ${REPORT_COLUMNS}`,
      [
        this.hotelId,
        input.reportId,
        input.expectedRevision,
        input.toState,
        input.claimedByAccountId ?? null,
        input.claimedAt ?? null,
        input.settledAt ?? null,
        input.reason ?? null,
      ],
    );
    return mapReport(result.rows[0]);
  }

  // --------------------------------------------------------------- version

  async insertVersion(input: {
    reportId: string;
    versionNo: number;
    kind: ReportVersionKind;
    noUsage: boolean;
    reason?: string;
    submittedByAccountId: string;
    submittedRole: SubmittedRole;
    cutoffAt: Date;
    totalMnt: bigint;
    lines: readonly InsertLineInput[];
    countedMovementIds: readonly { readonly movementId: string; readonly role: string }[];
  }): Promise<ReportVersionRow> {
    const inserted = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.minibar_usage_report_version
         (hotel_id, report_id, version_no, kind, no_usage, reason, submitted_by_account_id,
          submitted_role, cutoff_at, total_mnt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${VERSION_COLUMNS}`,
      [
        this.hotelId,
        input.reportId,
        input.versionNo,
        input.kind,
        input.noUsage,
        input.reason ?? null,
        input.submittedByAccountId,
        input.submittedRole,
        input.cutoffAt,
        input.totalMnt.toString(),
      ],
    );
    const version = mapVersion(inserted.rows[0] as Record<string, unknown>);
    const stayId = (
      await this.uow.query<{ stay_id: string }>(
        `SELECT stay_id FROM platform.minibar_usage_report WHERE hotel_id = $1 AND report_id = $2`,
        [this.hotelId, input.reportId],
      )
    ).rows[0]?.stay_id as string;
    for (const line of input.lines) {
      await this.uow.query(
        `INSERT INTO platform.minibar_usage_report_line
           (hotel_id, version_id, stay_id, product_id, product_name, opening_quantity,
            refill_quantity, non_guest_out_quantity, counted_quantity, billable_quantity,
            unit_price_mnt, line_total_mnt)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          this.hotelId,
          version.versionId,
          stayId,
          line.productId,
          line.productName,
          line.openingQuantity,
          line.refillQuantity,
          line.nonGuestOutQuantity,
          line.countedQuantity,
          line.billableQuantity,
          line.unitPriceMnt.toString(),
          line.lineTotalMnt.toString(),
        ],
      );
    }
    for (const counted of input.countedMovementIds) {
      await this.uow.query(
        `INSERT INTO platform.minibar_usage_report_movement (version_id, movement_id, hotel_id, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (version_id, movement_id) DO NOTHING`,
        [version.versionId, counted.movementId, this.hotelId, counted.role],
      );
    }
    return version;
  }

  async versions(reportId: string): Promise<readonly ReportVersionRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${VERSION_COLUMNS} FROM platform.minibar_usage_report_version
        WHERE hotel_id = $1 AND report_id = $2 ORDER BY version_no`,
      [this.hotelId, reportId],
    );
    return result.rows.map(mapVersion);
  }

  async version(versionId: string): Promise<ReportVersionRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${VERSION_COLUMNS} FROM platform.minibar_usage_report_version
        WHERE hotel_id = $1 AND version_id = $2`,
      [this.hotelId, versionId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapVersion(row);
  }

  async lines(versionId: string): Promise<readonly ReportLineRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${LINE_COLUMNS} FROM platform.minibar_usage_report_line
        WHERE hotel_id = $1 AND version_id = $2 ORDER BY product_name`,
      [this.hotelId, versionId],
    );
    return result.rows.map(mapLine);
  }

  async countedMovements(versionId: string): Promise<readonly string[]> {
    const result = await this.uow.query<{ movement_id: string }>(
      `SELECT movement_id FROM platform.minibar_usage_report_movement
        WHERE hotel_id = $1 AND version_id = $2 ORDER BY movement_id`,
      [this.hotelId, versionId],
    );
    return result.rows.map((row) => row.movement_id);
  }

  // --------------------------------------------------------------- dispute

  async openDispute(input: {
    reportId: string;
    versionId: string;
    productId: string;
    disputedQuantity: number;
    note: string;
    notedByAccountId: string;
    notedAt: Date;
  }): Promise<DisputeRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.minibar_report_dispute
         (hotel_id, report_id, version_id, product_id, disputed_quantity, note,
          noted_by_account_id, noted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${DISPUTE_COLUMNS}`,
      [
        this.hotelId,
        input.reportId,
        input.versionId,
        input.productId,
        input.disputedQuantity,
        input.note,
        input.notedByAccountId,
        input.notedAt,
      ],
    );
    return mapDispute(result.rows[0]) as DisputeRow;
  }

  async disputes(reportId: string): Promise<readonly DisputeRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${DISPUTE_COLUMNS} FROM platform.minibar_report_dispute
        WHERE hotel_id = $1 AND report_id = $2 ORDER BY noted_at`,
      [this.hotelId, reportId],
    );
    return result.rows.map((row) => mapDispute(row) as DisputeRow);
  }

  async openDisputeCount(reportId: string): Promise<number> {
    const result = await this.uow.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.minibar_report_dispute
        WHERE hotel_id = $1 AND report_id = $2 AND state = 'OPEN'`,
      [this.hotelId, reportId],
    );
    return Number(result.rows[0]?.n ?? '0');
  }

  async lockDispute(disputeId: string): Promise<DisputeRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${DISPUTE_COLUMNS} FROM platform.minibar_report_dispute
        WHERE hotel_id = $1 AND dispute_id = $2 FOR UPDATE`,
      [this.hotelId, disputeId],
    );
    return mapDispute(result.rows[0]);
  }

  async resolveDispute(input: {
    disputeId: string;
    expectedRevision: number;
    state: 'UPHELD' | 'WAIVED';
    resolvedByAccountId: string;
    resolvedAt: Date;
    resolutionReason: string;
    waivedAmountMnt?: bigint;
  }): Promise<DisputeRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.minibar_report_dispute
          SET state = $4, resolved_by_account_id = $5, resolved_at = $6, resolution_reason = $7,
              waived_amount_mnt = $8, revision = revision + 1
        WHERE hotel_id = $1 AND dispute_id = $2 AND revision = $3
        RETURNING ${DISPUTE_COLUMNS}`,
      [
        this.hotelId,
        input.disputeId,
        input.expectedRevision,
        input.state,
        input.resolvedByAccountId,
        input.resolvedAt,
        input.resolutionReason,
        input.waivedAmountMnt === undefined ? null : input.waivedAmountMnt.toString(),
      ],
    );
    return mapDispute(result.rows[0]);
  }

  // ------------------------------------------------------------------ lock

  async createLock(input: {
    reportId: string;
    versionId: string;
    attemptRef: string;
    amountMnt: bigint;
    lockedByAccountId: string;
    lockedAt: Date;
  }): Promise<PaymentLockRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.minibar_payment_lock
         (hotel_id, report_id, version_id, attempt_ref, amount_mnt, locked_by_account_id, locked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${LOCK_COLUMNS}`,
      [
        this.hotelId,
        input.reportId,
        input.versionId,
        input.attemptRef,
        input.amountMnt.toString(),
        input.lockedByAccountId,
        input.lockedAt,
      ],
    );
    return mapLock(result.rows[0]) as PaymentLockRow;
  }

  async heldLock(reportId: string): Promise<PaymentLockRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${LOCK_COLUMNS} FROM platform.minibar_payment_lock
        WHERE hotel_id = $1 AND report_id = $2 AND state = 'HELD' FOR UPDATE`,
      [this.hotelId, reportId],
    );
    return mapLock(result.rows[0]);
  }

  async lockById(lockId: string): Promise<PaymentLockRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${LOCK_COLUMNS} FROM platform.minibar_payment_lock
        WHERE hotel_id = $1 AND lock_id = $2`,
      [this.hotelId, lockId],
    );
    return mapLock(result.rows[0]);
  }

  async locks(reportId: string): Promise<readonly PaymentLockRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${LOCK_COLUMNS} FROM platform.minibar_payment_lock
        WHERE hotel_id = $1 AND report_id = $2 ORDER BY locked_at`,
      [this.hotelId, reportId],
    );
    return result.rows.map((row) => mapLock(row) as PaymentLockRow);
  }

  async settledLock(reportId: string): Promise<PaymentLockRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${LOCK_COLUMNS} FROM platform.minibar_payment_lock
        WHERE hotel_id = $1 AND report_id = $2 AND state = 'SETTLED'`,
      [this.hotelId, reportId],
    );
    return mapLock(result.rows[0]);
  }

  async resolveLock(input: {
    lockId: string;
    expectedRevision: number;
    state: 'RELEASED' | 'SETTLED';
    providerStatus: ProviderStatus;
    resolvedByAccountId: string;
    resolvedAt: Date;
  }): Promise<PaymentLockRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.minibar_payment_lock
          SET state = $4, provider_status = $5, resolved_by_account_id = $6, resolved_at = $7,
              revision = revision + 1
        WHERE hotel_id = $1 AND lock_id = $2 AND revision = $3
        RETURNING ${LOCK_COLUMNS}`,
      [
        this.hotelId,
        input.lockId,
        input.expectedRevision,
        input.state,
        input.providerStatus,
        input.resolvedByAccountId,
        input.resolvedAt,
      ],
    );
    return mapLock(result.rows[0]);
  }

  async noteProviderStatus(input: {
    lockId: string;
    expectedRevision: number;
    providerStatus: ProviderStatus;
  }): Promise<PaymentLockRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.minibar_payment_lock
          SET provider_status = $4, revision = revision + 1
        WHERE hotel_id = $1 AND lock_id = $2 AND revision = $3 AND state = 'HELD'
        RETURNING ${LOCK_COLUMNS}`,
      [this.hotelId, input.lockId, input.expectedRevision, input.providerStatus],
    );
    return mapLock(result.rows[0]);
  }

  // ------------------------------------------------------------ adjustment

  async insertAdjustment(input: {
    reportId: string;
    originalVersionId: string;
    lockId: string;
    kind: AdjustmentKind;
    productId?: string;
    quantity?: number;
    unitPriceMnt?: bigint;
    amountMnt: bigint;
    reason: string;
    actorAccountId: string;
  }): Promise<AdjustmentRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.minibar_report_adjustment
         (hotel_id, report_id, original_version_id, lock_id, kind, product_id, quantity,
          unit_price_mnt, amount_mnt, reason, actor_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${ADJUSTMENT_COLUMNS}`,
      [
        this.hotelId,
        input.reportId,
        input.originalVersionId,
        input.lockId,
        input.kind,
        input.productId ?? null,
        input.quantity ?? null,
        input.unitPriceMnt === undefined ? null : input.unitPriceMnt.toString(),
        input.amountMnt.toString(),
        input.reason,
        input.actorAccountId,
      ],
    );
    return mapAdjustment(result.rows[0] as Record<string, unknown>);
  }

  async adjustments(reportId: string): Promise<readonly AdjustmentRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${ADJUSTMENT_COLUMNS} FROM platform.minibar_report_adjustment
        WHERE hotel_id = $1 AND report_id = $2 ORDER BY created_at`,
      [this.hotelId, reportId],
    );
    return result.rows.map(mapAdjustment);
  }
}
