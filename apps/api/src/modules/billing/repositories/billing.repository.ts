import type { UnitOfWork } from '@prsystem/db';

/**
 * The folio, the deposit and the money ledger (doc 02 §3.3, doc 20).
 *
 * Nothing here updates a ledger row, a folio line, an allocation or a finance
 * event: the API holds no `UPDATE` on those tables, and a correction is a new
 * row referring to the one it corrects.
 */

export type Channel = 'CASH' | 'QPAY' | 'CARD_GATEWAY' | 'MANUAL_POS';
export type FolioState = 'OPEN' | 'SETTLED' | 'VOID';
export type LineKind = 'ROOM' | 'MINIBAR' | 'OTHER';
export type TransactionKind =
  | 'DEPOSIT_RECEIPT'
  | 'DEPOSIT_REFUND'
  | 'DEPOSIT_REVERSAL'
  | 'FOLIO_PAYMENT'
  | 'FOLIO_PAYMENT_REVERSAL'
  | 'CORRECTED_PAYMENT'
  | 'LATE_REFUND_COVERED';

export interface DepositConfigRow {
  readonly configId: string;
  readonly categoryId: string | null;
  readonly amountMnt: bigint;
  readonly configVersion: number;
  readonly revision: number;
}

export interface FolioRow {
  readonly folioId: string;
  readonly stayId: string;
  readonly roomId: string;
  readonly state: FolioState;
  readonly chargedMnt: bigint;
  readonly paidMnt: bigint;
  readonly depositAppliedMnt: bigint;
  readonly settledAt: Date | null;
  readonly revision: number;
}

export interface FolioLineRow {
  readonly lineId: string;
  readonly folioId: string;
  readonly kind: LineKind;
  readonly sourceType: string;
  readonly sourceRef: string;
  readonly description: string;
  readonly amountMnt: bigint;
  readonly createdAt: Date;
}

export interface DepositRow {
  readonly stayId: string;
  readonly source: 'WALK_IN' | 'ONLINE';
  readonly required: boolean;
  readonly requiredAmountMnt: bigint | null;
  readonly configScope: 'HOTEL' | 'CATEGORY' | 'NONE';
  readonly configVersion: number | null;
  readonly categoryId: string | null;
  readonly receivedMnt: bigint;
  readonly reversedMnt: bigint;
  readonly allocatedMnt: bigint;
  readonly refundReservedMnt: bigint;
  readonly refundedMnt: bigint;
  readonly frozen: boolean;
  readonly revision: number;
}

export interface TransactionRow {
  readonly transactionId: string;
  readonly stayId: string;
  readonly folioId: string | null;
  readonly kind: TransactionKind;
  readonly channel: Channel;
  readonly direction: 'IN' | 'OUT';
  readonly amountMnt: bigint;
  readonly providerReference: string | null;
  readonly approvalCode: string | null;
  readonly terminalId: string | null;
  readonly originalTransactionId: string | null;
  readonly refundRequestId: string | null;
  readonly shiftId: string | null;
  readonly reason: string | null;
  readonly occurredAt: Date;
}

const CONFIG_COLUMNS = `config_id, category_id, amount_mnt, config_version, revision`;
const FOLIO_COLUMNS = `folio_id, stay_id, room_id, state, charged_mnt, paid_mnt,
  deposit_applied_mnt, settled_at, revision`;
const LINE_COLUMNS = `line_id, folio_id, kind, source_type, source_ref, description, amount_mnt,
  created_at`;
const DEPOSIT_COLUMNS = `stay_id, source, required, required_amount_mnt, config_scope,
  config_version, category_id, received_mnt, reversed_mnt, allocated_mnt, refund_reserved_mnt,
  refunded_mnt, frozen, revision`;
const TRANSACTION_COLUMNS = `transaction_id, stay_id, folio_id, kind, channel, direction,
  amount_mnt, provider_reference, approval_code, terminal_id, original_transaction_id,
  refund_request_id, shift_id, reason, occurred_at`;

const big = (value: unknown): bigint => BigInt(value as string);
const bigOrNull = (value: unknown): bigint | null =>
  value === null || value === undefined ? null : BigInt(value as string);

function mapConfig(row: Record<string, unknown> | undefined): DepositConfigRow | undefined {
  if (row === undefined) return undefined;
  return {
    configId: row['config_id'] as string,
    categoryId: (row['category_id'] as string | null) ?? null,
    amountMnt: big(row['amount_mnt']),
    configVersion: Number(row['config_version']),
    revision: Number(row['revision']),
  };
}

function mapFolio(row: Record<string, unknown> | undefined): FolioRow | undefined {
  if (row === undefined) return undefined;
  return {
    folioId: row['folio_id'] as string,
    stayId: row['stay_id'] as string,
    roomId: row['room_id'] as string,
    state: row['state'] as FolioState,
    chargedMnt: big(row['charged_mnt']),
    paidMnt: big(row['paid_mnt']),
    depositAppliedMnt: big(row['deposit_applied_mnt']),
    settledAt: (row['settled_at'] as Date | null) ?? null,
    revision: Number(row['revision']),
  };
}

function mapLine(row: Record<string, unknown>): FolioLineRow {
  return {
    lineId: row['line_id'] as string,
    folioId: row['folio_id'] as string,
    kind: row['kind'] as LineKind,
    sourceType: row['source_type'] as string,
    sourceRef: row['source_ref'] as string,
    description: row['description'] as string,
    amountMnt: big(row['amount_mnt']),
    createdAt: row['created_at'] as Date,
  };
}

function mapDeposit(row: Record<string, unknown> | undefined): DepositRow | undefined {
  if (row === undefined) return undefined;
  return {
    stayId: row['stay_id'] as string,
    source: row['source'] as 'WALK_IN' | 'ONLINE',
    required: row['required'] === true,
    requiredAmountMnt: bigOrNull(row['required_amount_mnt']),
    configScope: row['config_scope'] as 'HOTEL' | 'CATEGORY' | 'NONE',
    configVersion: row['config_version'] === null ? null : Number(row['config_version']),
    categoryId: (row['category_id'] as string | null) ?? null,
    receivedMnt: big(row['received_mnt']),
    reversedMnt: big(row['reversed_mnt']),
    allocatedMnt: big(row['allocated_mnt']),
    refundReservedMnt: big(row['refund_reserved_mnt']),
    refundedMnt: big(row['refunded_mnt']),
    frozen: row['frozen'] === true,
    revision: Number(row['revision']),
  };
}

function mapTransaction(row: Record<string, unknown>): TransactionRow {
  return {
    transactionId: row['transaction_id'] as string,
    stayId: row['stay_id'] as string,
    folioId: (row['folio_id'] as string | null) ?? null,
    kind: row['kind'] as TransactionKind,
    channel: row['channel'] as Channel,
    direction: row['direction'] as 'IN' | 'OUT',
    amountMnt: big(row['amount_mnt']),
    providerReference: (row['provider_reference'] as string | null) ?? null,
    approvalCode: (row['approval_code'] as string | null) ?? null,
    terminalId: (row['terminal_id'] as string | null) ?? null,
    originalTransactionId: (row['original_transaction_id'] as string | null) ?? null,
    refundRequestId: (row['refund_request_id'] as string | null) ?? null,
    shiftId: (row['shift_id'] as string | null) ?? null,
    reason: (row['reason'] as string | null) ?? null,
    occurredAt: row['occurred_at'] as Date,
  };
}

export class BillingRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get hotelId(): string {
    return this.uow.context.hotelId;
  }

  // ------------------------------------------------------ deposit config

  async config(categoryId: string | null): Promise<DepositConfigRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      categoryId === null
        ? `SELECT ${CONFIG_COLUMNS} FROM platform.deposit_config
            WHERE hotel_id = $1 AND category_id IS NULL`
        : `SELECT ${CONFIG_COLUMNS} FROM platform.deposit_config
            WHERE hotel_id = $1 AND category_id = $2`,
      categoryId === null ? [this.hotelId] : [this.hotelId, categoryId],
    );
    return mapConfig(result.rows[0]);
  }

  async configs(): Promise<readonly DepositConfigRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${CONFIG_COLUMNS} FROM platform.deposit_config
        WHERE hotel_id = $1 ORDER BY category_id NULLS FIRST`,
      [this.hotelId],
    );
    return result.rows.map((row) => mapConfig(row) as DepositConfigRow);
  }

  async upsertConfig(input: {
    categoryId: string | null;
    amountMnt: bigint;
    accountId: string;
    at: Date;
  }): Promise<DepositConfigRow> {
    const existing = await this.config(input.categoryId);
    if (existing === undefined) {
      const inserted = await this.uow.query<Record<string, unknown>>(
        `INSERT INTO platform.deposit_config
           (hotel_id, category_id, amount_mnt, updated_by_account_id, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${CONFIG_COLUMNS}`,
        [this.hotelId, input.categoryId, input.amountMnt.toString(), input.accountId, input.at],
      );
      return mapConfig(inserted.rows[0]) as DepositConfigRow;
    }
    const updated = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.deposit_config
          SET amount_mnt = $3, config_version = config_version + 1, updated_by_account_id = $4,
              updated_at = $5, revision = revision + 1
        WHERE hotel_id = $1 AND config_id = $2
        RETURNING ${CONFIG_COLUMNS}`,
      [this.hotelId, existing.configId, input.amountMnt.toString(), input.accountId, input.at],
    );
    return mapConfig(updated.rows[0]) as DepositConfigRow;
  }

  // -------------------------------------------------------------- folio

  async openFolio(input: {
    stayId: string;
    roomId: string;
    at: Date;
  }): Promise<{ readonly folio: FolioRow; readonly opened: boolean }> {
    const inserted = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.stay_folio (hotel_id, stay_id, room_id, opened_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (stay_id) DO NOTHING
       RETURNING ${FOLIO_COLUMNS}`,
      [this.hotelId, input.stayId, input.roomId, input.at],
    );
    const row = mapFolio(inserted.rows[0]);
    if (row !== undefined) return { folio: row, opened: true };
    const existing = await this.folioOfStay(input.stayId);
    if (existing === undefined) throw new Error('the folio neither inserted nor exists');
    return { folio: existing, opened: false };
  }

  async folioOfStay(stayId: string): Promise<FolioRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${FOLIO_COLUMNS} FROM platform.stay_folio WHERE hotel_id = $1 AND stay_id = $2`,
      [this.hotelId, stayId],
    );
    return mapFolio(result.rows[0]);
  }

  async lockFolio(stayId: string): Promise<FolioRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${FOLIO_COLUMNS} FROM platform.stay_folio
        WHERE hotel_id = $1 AND stay_id = $2 FOR UPDATE`,
      [this.hotelId, stayId],
    );
    return mapFolio(result.rows[0]);
  }

  async lines(folioId: string): Promise<readonly FolioLineRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${LINE_COLUMNS} FROM platform.folio_line
        WHERE hotel_id = $1 AND folio_id = $2 ORDER BY created_at, line_id`,
      [this.hotelId, folioId],
    );
    return result.rows.map(mapLine);
  }

  /** Idempotent on what produced the charge: the same source posts one line. */
  async postLine(input: {
    folioId: string;
    kind: LineKind;
    sourceType: string;
    sourceRef: string;
    description: string;
    amountMnt: bigint;
    accountId: string;
  }): Promise<{ readonly line: FolioLineRow; readonly posted: boolean }> {
    const inserted = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.folio_line
         (hotel_id, folio_id, kind, source_type, source_ref, description, amount_mnt,
          actor_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (folio_id, source_type, source_ref) DO NOTHING
       RETURNING ${LINE_COLUMNS}`,
      [
        this.hotelId,
        input.folioId,
        input.kind,
        input.sourceType,
        input.sourceRef,
        input.description,
        input.amountMnt.toString(),
        input.accountId,
      ],
    );
    const row = inserted.rows[0];
    if (row !== undefined) return { line: mapLine(row), posted: true };
    const existing = await this.uow.query<Record<string, unknown>>(
      `SELECT ${LINE_COLUMNS} FROM platform.folio_line
        WHERE hotel_id = $1 AND folio_id = $2 AND source_type = $3 AND source_ref = $4`,
      [this.hotelId, input.folioId, input.sourceType, input.sourceRef],
    );
    const found = existing.rows[0];
    if (found === undefined) throw new Error('the folio line neither inserted nor exists');
    return { line: mapLine(found), posted: false };
  }

  async updateFolio(input: {
    folioId: string;
    expectedRevision: number;
    chargedMnt?: bigint;
    paidMnt?: bigint;
    depositAppliedMnt?: bigint;
    state?: FolioState;
    settledAt?: Date;
    reason?: string;
  }): Promise<FolioRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.stay_folio
          SET charged_mnt = COALESCE($4, charged_mnt),
              paid_mnt = COALESCE($5, paid_mnt),
              deposit_applied_mnt = COALESCE($6, deposit_applied_mnt),
              state = COALESCE($7, state),
              settled_at = COALESCE($8, settled_at),
              reason = COALESCE($9, reason),
              revision = revision + 1
        WHERE hotel_id = $1 AND folio_id = $2 AND revision = $3
        RETURNING ${FOLIO_COLUMNS}`,
      [
        this.hotelId,
        input.folioId,
        input.expectedRevision,
        input.chargedMnt?.toString() ?? null,
        input.paidMnt?.toString() ?? null,
        input.depositAppliedMnt?.toString() ?? null,
        input.state ?? null,
        input.settledAt ?? null,
        input.reason ?? null,
      ],
    );
    return mapFolio(result.rows[0]);
  }

  // ------------------------------------------------------------ deposit

  async openDeposit(input: {
    stayId: string;
    source: 'WALK_IN' | 'ONLINE';
    required: boolean;
    requiredAmountMnt: bigint | null;
    configScope: 'HOTEL' | 'CATEGORY' | 'NONE';
    configVersion: number | null;
    categoryId: string | null;
  }): Promise<DepositRow> {
    const inserted = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.deposit_aggregate
         (stay_id, hotel_id, source, required, required_amount_mnt, config_scope, config_version,
          category_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (stay_id) DO NOTHING
       RETURNING ${DEPOSIT_COLUMNS}`,
      [
        input.stayId,
        this.hotelId,
        input.source,
        input.required,
        input.requiredAmountMnt?.toString() ?? null,
        input.configScope,
        input.configVersion,
        input.categoryId,
      ],
    );
    const row = mapDeposit(inserted.rows[0]);
    if (row !== undefined) return row;
    const existing = await this.deposit(input.stayId);
    if (existing === undefined) throw new Error('the deposit neither inserted nor exists');
    return existing;
  }

  async deposit(stayId: string): Promise<DepositRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${DEPOSIT_COLUMNS} FROM platform.deposit_aggregate
        WHERE hotel_id = $1 AND stay_id = $2`,
      [this.hotelId, stayId],
    );
    return mapDeposit(result.rows[0]);
  }

  /** doc 20 §3.1: every money command serializes on this row. */
  async lockDeposit(stayId: string): Promise<DepositRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${DEPOSIT_COLUMNS} FROM platform.deposit_aggregate
        WHERE hotel_id = $1 AND stay_id = $2 FOR UPDATE`,
      [this.hotelId, stayId],
    );
    return mapDeposit(result.rows[0]);
  }

  async updateDeposit(input: {
    stayId: string;
    expectedRevision: number;
    receivedMnt?: bigint;
    reversedMnt?: bigint;
    allocatedMnt?: bigint;
    refundReservedMnt?: bigint;
    refundedMnt?: bigint;
    frozen?: boolean;
  }): Promise<DepositRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.deposit_aggregate
          SET received_mnt = COALESCE($4, received_mnt),
              reversed_mnt = COALESCE($5, reversed_mnt),
              allocated_mnt = COALESCE($6, allocated_mnt),
              refund_reserved_mnt = COALESCE($7, refund_reserved_mnt),
              refunded_mnt = COALESCE($8, refunded_mnt),
              frozen = COALESCE($9, frozen),
              revision = revision + 1
        WHERE hotel_id = $1 AND stay_id = $2 AND revision = $3
        RETURNING ${DEPOSIT_COLUMNS}`,
      [
        this.hotelId,
        input.stayId,
        input.expectedRevision,
        input.receivedMnt?.toString() ?? null,
        input.reversedMnt?.toString() ?? null,
        input.allocatedMnt?.toString() ?? null,
        input.refundReservedMnt?.toString() ?? null,
        input.refundedMnt?.toString() ?? null,
        input.frozen ?? null,
      ],
    );
    return mapDeposit(result.rows[0]);
  }

  async allocate(input: {
    stayId: string;
    folioLineId: string;
    amountMnt: bigint;
    accountId: string;
  }): Promise<string> {
    const result = await this.uow.query<{ allocation_id: string }>(
      `INSERT INTO platform.deposit_allocation
         (hotel_id, stay_id, folio_line_id, amount_mnt, actor_account_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING allocation_id`,
      [this.hotelId, input.stayId, input.folioLineId, input.amountMnt.toString(), input.accountId],
    );
    return result.rows[0]?.allocation_id as string;
  }

  async allocations(
    stayId: string,
  ): Promise<readonly { readonly folioLineId: string; readonly amountMnt: bigint }[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT folio_line_id, amount_mnt FROM platform.deposit_allocation
        WHERE hotel_id = $1 AND stay_id = $2 ORDER BY created_at`,
      [this.hotelId, stayId],
    );
    return result.rows.map((row) => ({
      folioLineId: row['folio_line_id'] as string,
      amountMnt: big(row['amount_mnt']),
    }));
  }

  // ------------------------------------------------------------- ledger

  async post(input: {
    stayId: string;
    folioId?: string;
    kind: TransactionKind;
    channel: Channel;
    direction: 'IN' | 'OUT';
    amountMnt: bigint;
    providerReference?: string;
    approvalCode?: string;
    terminalId?: string;
    originalTransactionId?: string;
    refundRequestId?: string;
    shiftId?: string;
    reason?: string;
    accountId: string;
    at: Date;
  }): Promise<TransactionRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.payment_transaction
         (hotel_id, stay_id, folio_id, kind, channel, direction, amount_mnt, provider_reference,
          approval_code, terminal_id, original_transaction_id, refund_request_id, shift_id, reason,
          actor_account_id, occurred_at, effective_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)
       RETURNING ${TRANSACTION_COLUMNS}`,
      [
        this.hotelId,
        input.stayId,
        input.folioId ?? null,
        input.kind,
        input.channel,
        input.direction,
        input.amountMnt.toString(),
        input.providerReference ?? null,
        input.approvalCode ?? null,
        input.terminalId ?? null,
        input.originalTransactionId ?? null,
        input.refundRequestId ?? null,
        input.shiftId ?? null,
        input.reason ?? null,
        input.accountId,
        input.at,
      ],
    );
    return mapTransaction(result.rows[0] as Record<string, unknown>);
  }

  async transaction(transactionId: string): Promise<TransactionRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${TRANSACTION_COLUMNS} FROM platform.payment_transaction
        WHERE hotel_id = $1 AND transaction_id = $2`,
      [this.hotelId, transactionId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapTransaction(row);
  }

  async transactionsOfStay(stayId: string): Promise<readonly TransactionRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${TRANSACTION_COLUMNS} FROM platform.payment_transaction
        WHERE hotel_id = $1 AND stay_id = $2 ORDER BY occurred_at, transaction_id`,
      [this.hotelId, stayId],
    );
    return result.rows.map(mapTransaction);
  }

  /** doc 20 §3.1: a provider reference is a movement's identity, not a note. */
  async transactionByReference(
    channel: Channel,
    providerReference: string,
  ): Promise<TransactionRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${TRANSACTION_COLUMNS} FROM platform.payment_transaction
        WHERE hotel_id = $1 AND channel = $2 AND provider_reference = $3`,
      [this.hotelId, channel, providerReference],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapTransaction(row);
  }
}
