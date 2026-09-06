import type { UnitOfWork } from '@prsystem/db';
import type { CashMovementType } from '../domain/cash';

/**
 * The cash locations, the ledger, the transfers, the approvals and the expenses
 * (doc 24, doc 03 §4, doc 23 §FIN-DEC-005).
 *
 * Nothing here updates a movement: the API holds no `UPDATE` on the ledger, and
 * a mistake is a reversal plus a corrected movement.
 */

export type LocationKind = 'DRAWER' | 'SAFE';
export type TransferKind = 'DRAWER_TO_DRAWER' | 'DRAWER_SAFE';
export type TransferState = 'PENDING' | 'COMPLETED' | 'CANCELLED';
export type RequestKind = 'BANK_DEPOSIT' | 'OWNER_WITHDRAWAL';
export type RequestState = 'PENDING' | 'APPROVED' | 'REJECTED';
export type ExpenseMethod = 'CASH' | 'CARD_POS' | 'BANK_QPAY';
export type ExpenseState = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'PAID' | 'REJECTED';

export interface LocationRow {
  readonly locationId: string;
  readonly kind: LocationKind;
  readonly name: string;
  readonly code: string;
  readonly state: 'ACTIVE' | 'INACTIVE';
  readonly isDefaultDrawer: boolean;
  readonly configuredFloatMnt: bigint | null;
  readonly physicalLocation: string | null;
  readonly revision: number;
}

export interface MovementRow {
  readonly movementId: string;
  readonly locationId: string;
  readonly shiftId: string | null;
  readonly movementType: CashMovementType;
  readonly direction: 'IN' | 'OUT';
  readonly amountMnt: bigint;
  readonly effectiveAt: Date;
  readonly reason: string | null;
  readonly reference: string | null;
  readonly transferId: string | null;
  readonly expenseId: string | null;
  readonly requestId: string | null;
  readonly originalMovementId: string | null;
}

export interface TransferRow {
  readonly transferId: string;
  readonly kind: TransferKind;
  readonly sourceLocationId: string;
  readonly sourceShiftId: string | null;
  readonly destinationLocationId: string;
  readonly destinationShiftId: string | null;
  readonly amountMnt: bigint;
  readonly state: TransferState;
  readonly reason: string | null;
  readonly confirmedCountedMnt: bigint | null;
  readonly cancelRecountMnt: bigint | null;
  readonly cancelReason: string | null;
  readonly revision: number;
}

export interface RequestRow {
  readonly requestId: string;
  readonly kind: RequestKind;
  readonly locationId: string;
  readonly shiftId: string | null;
  readonly amountMnt: bigint;
  readonly state: RequestState;
  readonly reference: string | null;
  readonly recipient: string | null;
  readonly reason: string;
  readonly selfApproved: boolean;
  readonly movementId: string | null;
  readonly requestedByAccountId: string;
  readonly revision: number;
}

export interface ExpenseRow {
  readonly expenseId: string;
  readonly category: string;
  readonly description: string;
  readonly amountMnt: bigint;
  readonly method: ExpenseMethod;
  readonly state: ExpenseState;
  readonly selfApproved: boolean;
  readonly locationId: string | null;
  readonly shiftId: string | null;
  readonly movementId: string | null;
  readonly providerReference: string | null;
  readonly createdByAccountId: string;
  readonly revision: number;
}

const LOCATION_COLUMNS = `cash_location_id, kind, name, code, state, is_default_drawer,
  configured_float_mnt, physical_location, revision`;
const MOVEMENT_COLUMNS = `movement_id, location_id, shift_id, movement_type, direction, amount_mnt,
  effective_at, reason, reference, transfer_id, expense_id, request_id, original_movement_id`;
const TRANSFER_COLUMNS = `transfer_id, kind, source_location_id, source_shift_id,
  destination_location_id, destination_shift_id, amount_mnt, state, reason, confirmed_counted_mnt,
  cancel_recount_mnt, cancel_reason, revision`;
const REQUEST_COLUMNS = `request_id, kind, location_id, shift_id, amount_mnt, state, reference,
  recipient, reason, self_approved, movement_id, requested_by_account_id, revision`;
const EXPENSE_COLUMNS = `expense_id, category, description, amount_mnt, method, state,
  self_approved, location_id, shift_id, movement_id, provider_reference, created_by_account_id,
  revision`;

const big = (value: unknown): bigint => BigInt(value as string);
const bigOrNull = (value: unknown): bigint | null =>
  value === null || value === undefined ? null : BigInt(value as string);

function mapLocation(row: Record<string, unknown> | undefined): LocationRow | undefined {
  if (row === undefined) return undefined;
  return {
    locationId: row['cash_location_id'] as string,
    kind: row['kind'] as LocationKind,
    name: row['name'] as string,
    code: row['code'] as string,
    state: row['state'] as 'ACTIVE' | 'INACTIVE',
    isDefaultDrawer: row['is_default_drawer'] === true,
    configuredFloatMnt: bigOrNull(row['configured_float_mnt']),
    physicalLocation: (row['physical_location'] as string | null) ?? null,
    revision: Number(row['revision']),
  };
}

function mapMovement(row: Record<string, unknown>): MovementRow {
  return {
    movementId: row['movement_id'] as string,
    locationId: row['location_id'] as string,
    shiftId: (row['shift_id'] as string | null) ?? null,
    movementType: row['movement_type'] as CashMovementType,
    direction: row['direction'] as 'IN' | 'OUT',
    amountMnt: big(row['amount_mnt']),
    effectiveAt: row['effective_at'] as Date,
    reason: (row['reason'] as string | null) ?? null,
    reference: (row['reference'] as string | null) ?? null,
    transferId: (row['transfer_id'] as string | null) ?? null,
    expenseId: (row['expense_id'] as string | null) ?? null,
    requestId: (row['request_id'] as string | null) ?? null,
    originalMovementId: (row['original_movement_id'] as string | null) ?? null,
  };
}

function mapTransfer(row: Record<string, unknown> | undefined): TransferRow | undefined {
  if (row === undefined) return undefined;
  return {
    transferId: row['transfer_id'] as string,
    kind: row['kind'] as TransferKind,
    sourceLocationId: row['source_location_id'] as string,
    sourceShiftId: (row['source_shift_id'] as string | null) ?? null,
    destinationLocationId: row['destination_location_id'] as string,
    destinationShiftId: (row['destination_shift_id'] as string | null) ?? null,
    amountMnt: big(row['amount_mnt']),
    state: row['state'] as TransferState,
    reason: (row['reason'] as string | null) ?? null,
    confirmedCountedMnt: bigOrNull(row['confirmed_counted_mnt']),
    cancelRecountMnt: bigOrNull(row['cancel_recount_mnt']),
    cancelReason: (row['cancel_reason'] as string | null) ?? null,
    revision: Number(row['revision']),
  };
}

function mapRequest(row: Record<string, unknown> | undefined): RequestRow | undefined {
  if (row === undefined) return undefined;
  return {
    requestId: row['request_id'] as string,
    kind: row['kind'] as RequestKind,
    locationId: row['location_id'] as string,
    shiftId: (row['shift_id'] as string | null) ?? null,
    amountMnt: big(row['amount_mnt']),
    state: row['state'] as RequestState,
    reference: (row['reference'] as string | null) ?? null,
    recipient: (row['recipient'] as string | null) ?? null,
    reason: row['reason'] as string,
    selfApproved: row['self_approved'] === true,
    movementId: (row['movement_id'] as string | null) ?? null,
    requestedByAccountId: row['requested_by_account_id'] as string,
    revision: Number(row['revision']),
  };
}

function mapExpense(row: Record<string, unknown> | undefined): ExpenseRow | undefined {
  if (row === undefined) return undefined;
  return {
    expenseId: row['expense_id'] as string,
    category: row['category'] as string,
    description: row['description'] as string,
    amountMnt: big(row['amount_mnt']),
    method: row['method'] as ExpenseMethod,
    state: row['state'] as ExpenseState,
    selfApproved: row['self_approved'] === true,
    locationId: (row['location_id'] as string | null) ?? null,
    shiftId: (row['shift_id'] as string | null) ?? null,
    movementId: (row['movement_id'] as string | null) ?? null,
    providerReference: (row['provider_reference'] as string | null) ?? null,
    createdByAccountId: row['created_by_account_id'] as string,
    revision: Number(row['revision']),
  };
}

export class FinanceRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get hotelId(): string {
    return this.uow.context.hotelId;
  }

  // ----------------------------------------------------------- locations

  async locations(): Promise<readonly LocationRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${LOCATION_COLUMNS} FROM platform.cash_location
        WHERE hotel_id = $1 ORDER BY is_default_drawer DESC, code`,
      [this.hotelId],
    );
    return result.rows.map((row) => mapLocation(row) as LocationRow);
  }

  async location(locationId: string): Promise<LocationRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${LOCATION_COLUMNS} FROM platform.cash_location
        WHERE hotel_id = $1 AND cash_location_id = $2`,
      [this.hotelId, locationId],
    );
    return mapLocation(result.rows[0]);
  }

  async lockLocation(locationId: string): Promise<LocationRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${LOCATION_COLUMNS} FROM platform.cash_location
        WHERE hotel_id = $1 AND cash_location_id = $2 FOR UPDATE`,
      [this.hotelId, locationId],
    );
    return mapLocation(result.rows[0]);
  }

  async defaultDrawer(): Promise<LocationRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${LOCATION_COLUMNS} FROM platform.cash_location
        WHERE hotel_id = $1 AND is_default_drawer IS TRUE`,
      [this.hotelId],
    );
    return mapLocation(result.rows[0]);
  }

  async createLocation(input: {
    kind: LocationKind;
    name: string;
    code: string;
    physicalLocation?: string;
    configuredFloatMnt?: bigint;
    accountId: string;
  }): Promise<LocationRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.cash_location
         (hotel_id, kind, name, code, physical_location, configured_float_mnt,
          created_by_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${LOCATION_COLUMNS}`,
      [
        this.hotelId,
        input.kind,
        input.name,
        input.code,
        input.physicalLocation ?? null,
        input.configuredFloatMnt?.toString() ?? null,
        input.accountId,
      ],
    );
    return mapLocation(result.rows[0]) as LocationRow;
  }

  async updateLocation(input: {
    locationId: string;
    expectedRevision: number;
    state?: 'ACTIVE' | 'INACTIVE';
    configuredFloatMnt?: bigint;
    physicalLocation?: string;
  }): Promise<LocationRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.cash_location
          SET state = COALESCE($4::text, state),
              configured_float_mnt = COALESCE($5::bigint, configured_float_mnt),
              physical_location = COALESCE($6::text, physical_location),
              revision = revision + 1
        WHERE hotel_id = $1 AND cash_location_id = $2 AND revision = $3
        RETURNING ${LOCATION_COLUMNS}`,
      [
        this.hotelId,
        input.locationId,
        input.expectedRevision,
        input.state ?? null,
        input.configuredFloatMnt?.toString() ?? null,
        input.physicalLocation ?? null,
      ],
    );
    return mapLocation(result.rows[0]);
  }

  // -------------------------------------------------------------- ledger

  async post(input: {
    locationId: string;
    shiftId?: string;
    movementType: CashMovementType;
    direction: 'IN' | 'OUT';
    amountMnt: bigint;
    effectiveAt: Date;
    reason?: string;
    reference?: string;
    transferId?: string;
    expenseId?: string;
    requestId?: string;
    paymentTransactionId?: string;
    originalMovementId?: string;
    accountId: string;
  }): Promise<MovementRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.cash_movement
         (hotel_id, location_id, shift_id, movement_type, direction, amount_mnt, effective_at,
          reason, reference, transfer_id, expense_id, request_id, payment_transaction_id,
          original_movement_id, actor_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING ${MOVEMENT_COLUMNS}`,
      [
        this.hotelId,
        input.locationId,
        input.shiftId ?? null,
        input.movementType,
        input.direction,
        input.amountMnt.toString(),
        input.effectiveAt,
        input.reason ?? null,
        input.reference ?? null,
        input.transferId ?? null,
        input.expenseId ?? null,
        input.requestId ?? null,
        input.paymentTransactionId ?? null,
        input.originalMovementId ?? null,
        input.accountId,
      ],
    );
    return mapMovement(result.rows[0] as Record<string, unknown>);
  }

  /** doc 24 §3: whether the drawer's one-off opening float has been posted. */
  async hasInitialFloat(locationId: string): Promise<boolean> {
    const result = await this.uow.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM platform.cash_movement
         WHERE hotel_id = $1 AND location_id = $2 AND movement_type = 'INITIAL_FLOAT') AS present`,
      [this.hotelId, locationId],
    );
    return result.rows[0]?.present === true;
  }

  async movementsOfShift(shiftId: string): Promise<readonly MovementRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${MOVEMENT_COLUMNS} FROM platform.cash_movement
        WHERE hotel_id = $1 AND shift_id = $2 ORDER BY effective_at, movement_id`,
      [this.hotelId, shiftId],
    );
    return result.rows.map(mapMovement);
  }

  async movementsOfLocation(locationId: string): Promise<readonly MovementRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${MOVEMENT_COLUMNS} FROM platform.cash_movement
        WHERE hotel_id = $1 AND location_id = $2 ORDER BY effective_at, movement_id`,
      [this.hotelId, locationId],
    );
    return result.rows.map(mapMovement);
  }

  async movement(movementId: string): Promise<MovementRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${MOVEMENT_COLUMNS} FROM platform.cash_movement
        WHERE hotel_id = $1 AND movement_id = $2`,
      [this.hotelId, movementId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapMovement(row);
  }

  // ------------------------------------------------------------ transfers

  async createTransfer(input: {
    kind: TransferKind;
    sourceLocationId: string;
    sourceShiftId?: string;
    destinationLocationId: string;
    destinationShiftId?: string;
    amountMnt: bigint;
    reason?: string;
    accountId: string;
    at: Date;
  }): Promise<TransferRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.cash_transfer
         (hotel_id, kind, source_location_id, source_shift_id, destination_location_id,
          destination_shift_id, amount_mnt, reason, initiated_by_account_id, initiated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${TRANSFER_COLUMNS}`,
      [
        this.hotelId,
        input.kind,
        input.sourceLocationId,
        input.sourceShiftId ?? null,
        input.destinationLocationId,
        input.destinationShiftId ?? null,
        input.amountMnt.toString(),
        input.reason ?? null,
        input.accountId,
        input.at,
      ],
    );
    return mapTransfer(result.rows[0]) as TransferRow;
  }

  async transfer(transferId: string): Promise<TransferRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${TRANSFER_COLUMNS} FROM platform.cash_transfer
        WHERE hotel_id = $1 AND transfer_id = $2`,
      [this.hotelId, transferId],
    );
    return mapTransfer(result.rows[0]);
  }

  async lockTransfer(transferId: string): Promise<TransferRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${TRANSFER_COLUMNS} FROM platform.cash_transfer
        WHERE hotel_id = $1 AND transfer_id = $2 FOR UPDATE`,
      [this.hotelId, transferId],
    );
    return mapTransfer(result.rows[0]);
  }

  /** `CASH-DEC-006`: a shift with a transfer still pending cannot close. */
  async pendingTransfersOfShift(shiftId: string): Promise<readonly TransferRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${TRANSFER_COLUMNS} FROM platform.cash_transfer
        WHERE hotel_id = $1 AND state = 'PENDING'
          AND (source_shift_id = $2 OR destination_shift_id = $2)
        ORDER BY initiated_at`,
      [this.hotelId, shiftId],
    );
    return result.rows.map((row) => mapTransfer(row) as TransferRow);
  }

  async pendingTransfers(): Promise<readonly TransferRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${TRANSFER_COLUMNS} FROM platform.cash_transfer
        WHERE hotel_id = $1 AND state = 'PENDING' ORDER BY initiated_at`,
      [this.hotelId],
    );
    return result.rows.map((row) => mapTransfer(row) as TransferRow);
  }

  async resolveTransfer(input: {
    transferId: string;
    expectedRevision: number;
    state: 'COMPLETED' | 'CANCELLED';
    accountId: string;
    at: Date;
    countedMnt?: bigint;
    cancelReason?: string;
  }): Promise<TransferRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.cash_transfer
          SET state = $4::text,
              confirmed_by_account_id = CASE WHEN $4 = 'COMPLETED' THEN $5::uuid END,
              confirmed_at = CASE WHEN $4 = 'COMPLETED' THEN $6::timestamptz END,
              confirmed_counted_mnt =
                CASE WHEN $4 = 'COMPLETED' THEN $7::bigint ELSE confirmed_counted_mnt END,
              cancelled_by_account_id = CASE WHEN $4 = 'CANCELLED' THEN $5::uuid END,
              cancelled_at = CASE WHEN $4 = 'CANCELLED' THEN $6::timestamptz END,
              cancel_recount_mnt =
                CASE WHEN $4 = 'CANCELLED' THEN $7::bigint ELSE cancel_recount_mnt END,
              cancel_reason = COALESCE($8::text, cancel_reason),
              revision = revision + 1
        WHERE hotel_id = $1 AND transfer_id = $2 AND revision = $3
        RETURNING ${TRANSFER_COLUMNS}`,
      [
        this.hotelId,
        input.transferId,
        input.expectedRevision,
        input.state,
        input.accountId,
        input.at,
        input.countedMnt?.toString() ?? null,
        input.cancelReason ?? null,
      ],
    );
    return mapTransfer(result.rows[0]);
  }

  // ------------------------------------------------------------- requests

  async createRequest(input: {
    kind: RequestKind;
    locationId: string;
    shiftId?: string;
    amountMnt: bigint;
    reference?: string;
    recipient?: string;
    reason: string;
    accountId: string;
    at: Date;
  }): Promise<RequestRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.cash_request
         (hotel_id, kind, location_id, shift_id, amount_mnt, reference, recipient, reason,
          requested_by_account_id, requested_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${REQUEST_COLUMNS}`,
      [
        this.hotelId,
        input.kind,
        input.locationId,
        input.shiftId ?? null,
        input.amountMnt.toString(),
        input.reference ?? null,
        input.recipient ?? null,
        input.reason,
        input.accountId,
        input.at,
      ],
    );
    return mapRequest(result.rows[0]) as RequestRow;
  }

  async request(requestId: string): Promise<RequestRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${REQUEST_COLUMNS} FROM platform.cash_request
        WHERE hotel_id = $1 AND request_id = $2`,
      [this.hotelId, requestId],
    );
    return mapRequest(result.rows[0]);
  }

  async lockRequest(requestId: string): Promise<RequestRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${REQUEST_COLUMNS} FROM platform.cash_request
        WHERE hotel_id = $1 AND request_id = $2 FOR UPDATE`,
      [this.hotelId, requestId],
    );
    return mapRequest(result.rows[0]);
  }

  async requests(): Promise<readonly RequestRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${REQUEST_COLUMNS} FROM platform.cash_request
        WHERE hotel_id = $1 ORDER BY requested_at DESC LIMIT 200`,
      [this.hotelId],
    );
    return result.rows.map((row) => mapRequest(row) as RequestRow);
  }

  async decideRequest(input: {
    requestId: string;
    expectedRevision: number;
    state: RequestState;
    accountId: string;
    at: Date;
    decisionReason?: string;
    selfApproved?: boolean;
    movementId?: string;
  }): Promise<RequestRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.cash_request
          SET state = $4::text, decided_by_account_id = $5::uuid, decided_at = $6::timestamptz,
              decision_reason = COALESCE($7::text, decision_reason),
              self_approved = COALESCE($8::boolean, self_approved),
              movement_id = COALESCE($9::uuid, movement_id),
              revision = revision + 1
        WHERE hotel_id = $1 AND request_id = $2 AND revision = $3
        RETURNING ${REQUEST_COLUMNS}`,
      [
        this.hotelId,
        input.requestId,
        input.expectedRevision,
        input.state,
        input.accountId,
        input.at,
        input.decisionReason ?? null,
        input.selfApproved ?? null,
        input.movementId ?? null,
      ],
    );
    return mapRequest(result.rows[0]);
  }

  // ------------------------------------------------------------- expenses

  async createExpense(input: {
    category: string;
    description: string;
    amountMnt: bigint;
    method: ExpenseMethod;
    accountId: string;
    at: Date;
    submit: boolean;
    /** doc 23 §4.4: an inventory purchase is not an operating cost. */
    expenseType: 'INVENTORY_PURCHASE' | 'OPERATING';
    categoryId?: string;
  }): Promise<ExpenseRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.expense
         (hotel_id, category, description, amount_mnt, method, state, submitted_at,
          created_by_account_id, created_at, expense_type, category_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid)
       RETURNING ${EXPENSE_COLUMNS}`,
      [
        this.hotelId,
        input.category,
        input.description,
        input.amountMnt.toString(),
        input.method,
        input.submit ? 'SUBMITTED' : 'DRAFT',
        input.submit ? input.at : null,
        input.accountId,
        input.at,
        input.expenseType,
        input.categoryId ?? null,
      ],
    );
    return mapExpense(result.rows[0]) as ExpenseRow;
  }

  async expense(expenseId: string): Promise<ExpenseRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${EXPENSE_COLUMNS} FROM platform.expense
        WHERE hotel_id = $1 AND expense_id = $2`,
      [this.hotelId, expenseId],
    );
    return mapExpense(result.rows[0]);
  }

  async lockExpense(expenseId: string): Promise<ExpenseRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${EXPENSE_COLUMNS} FROM platform.expense
        WHERE hotel_id = $1 AND expense_id = $2 FOR UPDATE`,
      [this.hotelId, expenseId],
    );
    return mapExpense(result.rows[0]);
  }

  async expenses(): Promise<readonly ExpenseRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${EXPENSE_COLUMNS} FROM platform.expense
        WHERE hotel_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [this.hotelId],
    );
    return result.rows.map((row) => mapExpense(row) as ExpenseRow);
  }

  async updateExpense(input: {
    expenseId: string;
    expectedRevision: number;
    state: ExpenseState;
    accountId: string;
    at: Date;
    decisionReason?: string;
    selfApproved?: boolean;
    locationId?: string;
    shiftId?: string;
    movementId?: string;
    providerReference?: string;
  }): Promise<ExpenseRow | undefined> {
    const decided = ['APPROVED', 'PAID', 'REJECTED'].includes(input.state);
    const paid = input.state === 'PAID';
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.expense
          SET state = $4::text,
              submitted_at =
                COALESCE(submitted_at, CASE WHEN $4 <> 'DRAFT' THEN $6::timestamptz END),
              decided_by_account_id = CASE WHEN $10 THEN COALESCE(decided_by_account_id, $5::uuid)
                                           ELSE decided_by_account_id END,
              decided_at =
                CASE WHEN $10 THEN COALESCE(decided_at, $6::timestamptz) ELSE decided_at END,
              decision_reason = COALESCE($7::text, decision_reason),
              self_approved = COALESCE($8::boolean, self_approved),
              paid_by_account_id = CASE WHEN $11 THEN $5::uuid ELSE paid_by_account_id END,
              paid_at = CASE WHEN $11 THEN $6::timestamptz ELSE paid_at END,
              location_id = COALESCE($12::uuid, location_id),
              shift_id = COALESCE($13::uuid, shift_id),
              movement_id = COALESCE($14::uuid, movement_id),
              provider_reference = COALESCE($9::text, provider_reference),
              revision = revision + 1
        WHERE hotel_id = $1 AND expense_id = $2 AND revision = $3
        RETURNING ${EXPENSE_COLUMNS}`,
      [
        this.hotelId,
        input.expenseId,
        input.expectedRevision,
        input.state,
        input.accountId,
        input.at,
        input.decisionReason ?? null,
        input.selfApproved ?? null,
        input.providerReference ?? null,
        decided,
        paid,
        input.locationId ?? null,
        input.shiftId ?? null,
        input.movementId ?? null,
      ],
    );
    return mapExpense(result.rows[0]);
  }
}
