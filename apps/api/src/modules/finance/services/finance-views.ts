import type {
  ExpenseRow,
  LocationRow,
  MovementRow,
  RequestRow,
  TransferRow,
} from '../repositories/finance.repository';

/** JSON-safe projections: every MNT amount crosses the wire as a decimal string. */

const money = (value: bigint | null): string | null => (value === null ? null : value.toString());

export interface LocationView {
  readonly locationId: string;
  readonly kind: 'DRAWER' | 'SAFE';
  readonly name: string;
  readonly code: string;
  readonly state: 'ACTIVE' | 'INACTIVE';
  readonly isDefaultDrawer: boolean;
  readonly configuredFloatMnt: string | null;
  readonly physicalLocation: string | null;
  readonly balanceMnt?: string;
  readonly revision: number;
}

export function locationView(row: LocationRow, balanceMnt?: bigint): LocationView {
  return {
    locationId: row.locationId,
    kind: row.kind,
    name: row.name,
    code: row.code,
    state: row.state,
    isDefaultDrawer: row.isDefaultDrawer,
    configuredFloatMnt: money(row.configuredFloatMnt),
    physicalLocation: row.physicalLocation,
    ...(balanceMnt === undefined ? {} : { balanceMnt: balanceMnt.toString() }),
    revision: row.revision,
  };
}

export interface MovementView {
  readonly movementId: string;
  readonly locationId: string;
  readonly shiftId: string | null;
  readonly movementType: string;
  readonly direction: 'IN' | 'OUT';
  readonly amountMnt: string;
  readonly effectiveAt: string;
  readonly reason: string | null;
  readonly reference: string | null;
  readonly transferId: string | null;
  readonly expenseId: string | null;
  readonly requestId: string | null;
  readonly originalMovementId: string | null;
}

export function movementView(row: MovementRow): MovementView {
  return {
    movementId: row.movementId,
    locationId: row.locationId,
    shiftId: row.shiftId,
    movementType: row.movementType,
    direction: row.direction,
    amountMnt: row.amountMnt.toString(),
    effectiveAt: row.effectiveAt.toISOString(),
    reason: row.reason,
    reference: row.reference,
    transferId: row.transferId,
    expenseId: row.expenseId,
    requestId: row.requestId,
    originalMovementId: row.originalMovementId,
  };
}

export interface TransferView {
  readonly transferId: string;
  readonly kind: 'DRAWER_TO_DRAWER' | 'DRAWER_SAFE';
  readonly sourceLocationId: string;
  readonly destinationLocationId: string;
  readonly sourceShiftId: string | null;
  readonly destinationShiftId: string | null;
  readonly amountMnt: string;
  readonly state: 'PENDING' | 'COMPLETED' | 'CANCELLED';
  readonly confirmedCountedMnt: string | null;
  readonly cancelRecountMnt: string | null;
  readonly reason: string | null;
  readonly cancelReason: string | null;
  readonly revision: number;
}

export function transferView(row: TransferRow): TransferView {
  return {
    transferId: row.transferId,
    kind: row.kind,
    sourceLocationId: row.sourceLocationId,
    destinationLocationId: row.destinationLocationId,
    sourceShiftId: row.sourceShiftId,
    destinationShiftId: row.destinationShiftId,
    amountMnt: row.amountMnt.toString(),
    state: row.state,
    confirmedCountedMnt: money(row.confirmedCountedMnt),
    cancelRecountMnt: money(row.cancelRecountMnt),
    reason: row.reason,
    cancelReason: row.cancelReason,
    revision: row.revision,
  };
}

export interface RequestView {
  readonly requestId: string;
  readonly kind: 'BANK_DEPOSIT' | 'OWNER_WITHDRAWAL';
  readonly locationId: string;
  readonly shiftId: string | null;
  readonly amountMnt: string;
  readonly state: 'PENDING' | 'APPROVED' | 'REJECTED';
  readonly reference: string | null;
  readonly recipient: string | null;
  readonly reason: string;
  readonly selfApproved: boolean;
  readonly movementId: string | null;
  readonly revision: number;
}

export function requestView(row: RequestRow): RequestView {
  return {
    requestId: row.requestId,
    kind: row.kind,
    locationId: row.locationId,
    shiftId: row.shiftId,
    amountMnt: row.amountMnt.toString(),
    state: row.state,
    reference: row.reference,
    recipient: row.recipient,
    reason: row.reason,
    selfApproved: row.selfApproved,
    movementId: row.movementId,
    revision: row.revision,
  };
}

export interface ExpenseView {
  readonly expenseId: string;
  readonly category: string;
  readonly description: string;
  readonly amountMnt: string;
  readonly method: 'CASH' | 'CARD_POS' | 'BANK_QPAY';
  readonly state: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'PAID' | 'REJECTED';
  readonly selfApproved: boolean;
  readonly locationId: string | null;
  readonly shiftId: string | null;
  readonly movementId: string | null;
  readonly providerReference: string | null;
  readonly revision: number;
}

export function expenseView(row: ExpenseRow): ExpenseView {
  return {
    expenseId: row.expenseId,
    category: row.category,
    description: row.description,
    amountMnt: row.amountMnt.toString(),
    method: row.method,
    state: row.state,
    selfApproved: row.selfApproved,
    locationId: row.locationId,
    shiftId: row.shiftId,
    movementId: row.movementId,
    providerReference: row.providerReference,
    revision: row.revision,
  };
}
