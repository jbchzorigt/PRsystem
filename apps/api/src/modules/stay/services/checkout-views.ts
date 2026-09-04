import type { CleaningTaskRow } from '../repositories/cleaning-task.repository';
import type { RefillTaskRow } from '../repositories/refill.repository';
import type {
  AdjustmentRow,
  DisputeRow,
  PaymentLockRow,
  ReportLineRow,
  ReportRow,
  ReportVersionRow,
} from '../repositories/report.repository';
import type { StayRow } from '../repositories/stay.repository';

/**
 * What Phase 09 hands to a screen. Amounts are whole MNT as strings; the
 * Cleaner's own views carry no price at all (doc 04 §4, §7).
 */

export interface CheckoutView {
  readonly stayId: string;
  readonly roomId: string;
  readonly state: StayRow['state'];
  readonly reportId: string | null;
  readonly revision: number;
}

export function checkoutView(
  stay: StayRow,
  report: { reportId: string } | undefined,
): CheckoutView {
  return {
    stayId: stay.stayId,
    roomId: stay.roomId,
    state: stay.state,
    reportId: report?.reportId ?? null,
    revision: stay.revision,
  };
}

export interface ReportLineView {
  readonly productId: string;
  readonly productName: string;
  readonly openingQuantity: number;
  readonly refillQuantity: number;
  readonly nonGuestOutQuantity: number;
  readonly countedQuantity: number;
  readonly billableQuantity: number;
  readonly unitPriceMnt: string;
  readonly lineTotalMnt: string;
}

export interface ReportVersionView {
  readonly versionId: string;
  readonly versionNo: number;
  readonly kind: ReportVersionRow['kind'];
  readonly noUsage: boolean;
  readonly reason: string | null;
  readonly submittedRole: ReportVersionRow['submittedRole'];
  readonly cutoffAt: string;
  readonly totalMnt: string;
  readonly lines: readonly ReportLineView[];
}

export interface DisputeView {
  readonly disputeId: string;
  readonly versionId: string;
  readonly productId: string;
  readonly disputedQuantity: number;
  readonly state: DisputeRow['state'];
  readonly note: string;
  readonly resolutionReason: string | null;
  readonly waivedAmountMnt: string | null;
  readonly revision: number;
}

export interface PaymentLockView {
  readonly lockId: string;
  readonly versionId: string;
  readonly attemptRef: string;
  readonly state: PaymentLockRow['state'];
  readonly providerStatus: PaymentLockRow['providerStatus'];
  readonly amountMnt: string;
  readonly revision: number;
}

export interface AdjustmentView {
  readonly adjustmentId: string;
  readonly originalVersionId: string;
  readonly lockId: string;
  readonly kind: AdjustmentRow['kind'];
  readonly productId: string | null;
  readonly quantity: number | null;
  readonly amountMnt: string;
  readonly reason: string;
}

export interface ReportView {
  readonly reportId: string;
  readonly stayId: string;
  readonly roomId: string;
  readonly state: ReportRow['state'];
  readonly currentVersionId: string | null;
  readonly versions: readonly ReportVersionView[];
  readonly disputes: readonly DisputeView[];
  readonly locks: readonly PaymentLockView[];
  readonly adjustments: readonly AdjustmentView[];
  /** The current version's total less every waiver decided on it (`CHK-DEC-006`). */
  readonly payableMnt: string;
  readonly revision: number;
}

export function lineView(line: ReportLineRow): ReportLineView {
  return {
    productId: line.productId,
    productName: line.productName,
    openingQuantity: line.openingQuantity,
    refillQuantity: line.refillQuantity,
    nonGuestOutQuantity: line.nonGuestOutQuantity,
    countedQuantity: line.countedQuantity,
    billableQuantity: line.billableQuantity,
    unitPriceMnt: line.unitPriceMnt.toString(),
    lineTotalMnt: line.lineTotalMnt.toString(),
  };
}

export function versionView(
  version: ReportVersionRow,
  lines: readonly ReportLineRow[],
): ReportVersionView {
  return {
    versionId: version.versionId,
    versionNo: version.versionNo,
    kind: version.kind,
    noUsage: version.noUsage,
    reason: version.reason,
    submittedRole: version.submittedRole,
    cutoffAt: version.cutoffAt.toISOString(),
    totalMnt: version.totalMnt.toString(),
    lines: lines.map(lineView),
  };
}

export function disputeView(dispute: DisputeRow): DisputeView {
  return {
    disputeId: dispute.disputeId,
    versionId: dispute.versionId,
    productId: dispute.productId,
    disputedQuantity: dispute.disputedQuantity,
    state: dispute.state,
    note: dispute.note,
    resolutionReason: dispute.resolutionReason,
    waivedAmountMnt: dispute.waivedAmountMnt === null ? null : dispute.waivedAmountMnt.toString(),
    revision: dispute.revision,
  };
}

export function lockView(lock: PaymentLockRow): PaymentLockView {
  return {
    lockId: lock.lockId,
    versionId: lock.versionId,
    attemptRef: lock.attemptRef,
    state: lock.state,
    providerStatus: lock.providerStatus,
    amountMnt: lock.amountMnt.toString(),
    revision: lock.revision,
  };
}

export function adjustmentView(adjustment: AdjustmentRow): AdjustmentView {
  return {
    adjustmentId: adjustment.adjustmentId,
    originalVersionId: adjustment.originalVersionId,
    lockId: adjustment.lockId,
    kind: adjustment.kind,
    productId: adjustment.productId,
    quantity: adjustment.quantity,
    amountMnt: adjustment.amountMnt.toString(),
    reason: adjustment.reason,
  };
}

export interface CleaningTaskView {
  readonly taskId: string;
  readonly roomId: string;
  readonly stayId: string | null;
  readonly state: CleaningTaskRow['state'];
  readonly claimedByAccountId: string | null;
  readonly openedAt: string;
  readonly revision: number;
}

export function cleaningTaskView(task: CleaningTaskRow): CleaningTaskView {
  return {
    taskId: task.taskId,
    roomId: task.roomId,
    stayId: task.stayId,
    state: task.state,
    claimedByAccountId: task.claimedByAccountId,
    openedAt: task.openedAt.toISOString(),
    revision: task.revision,
  };
}

/** doc 04 §4: a Cleaner's task carries no selling price. */
export interface RefillTaskView {
  readonly taskId: string;
  readonly roomId: string;
  readonly stayId: string;
  readonly productId: string;
  readonly requestedQuantity: number;
  readonly confirmedQuantity: number | null;
  readonly state: RefillTaskRow['state'];
  readonly reason: string | null;
  readonly revision: number;
}

export function refillTaskView(task: RefillTaskRow): RefillTaskView {
  return {
    taskId: task.taskId,
    roomId: task.roomId,
    stayId: task.stayId,
    productId: task.productId,
    requestedQuantity: task.requestedQuantity,
    confirmedQuantity: task.confirmedQuantity,
    state: task.state,
    reason: task.reason,
    revision: task.revision,
  };
}
