import type {
  DepositConfigRow,
  DepositRow,
  FolioLineRow,
  FolioRow,
  TransactionRow,
} from '../repositories/billing.repository';
import type { CaseRow, CorrectionRow, RefundRow } from '../repositories/refund.repository';
import { availableDepositMnt, folioBalanceMnt } from '../domain/money';

/** What Phase 10 hands to a screen. Amounts are whole MNT as strings. */

export interface DepositConfigView {
  readonly configId: string;
  readonly categoryId: string | null;
  readonly amountMnt: string;
  readonly configVersion: number;
  readonly revision: number;
}

export function depositConfigView(row: DepositConfigRow): DepositConfigView {
  return {
    configId: row.configId,
    categoryId: row.categoryId,
    amountMnt: row.amountMnt.toString(),
    configVersion: row.configVersion,
    revision: row.revision,
  };
}

export interface FolioLineView {
  readonly lineId: string;
  readonly kind: FolioLineRow['kind'];
  readonly description: string;
  readonly amountMnt: string;
  readonly sourceType: string;
  readonly sourceRef: string;
}

export interface TransactionView {
  readonly transactionId: string;
  readonly kind: TransactionRow['kind'];
  readonly channel: TransactionRow['channel'];
  readonly direction: TransactionRow['direction'];
  readonly amountMnt: string;
  readonly providerReference: string | null;
  readonly approvalCode: string | null;
  readonly originalTransactionId: string | null;
  readonly occurredAt: string;
}

export interface DepositView {
  readonly stayId: string;
  readonly source: DepositRow['source'];
  readonly required: boolean;
  readonly requiredAmountMnt: string | null;
  readonly configScope: DepositRow['configScope'];
  readonly configVersion: number | null;
  readonly receivedMnt: string;
  readonly reversedMnt: string;
  readonly allocatedMnt: string;
  readonly refundReservedMnt: string;
  readonly refundedMnt: string;
  readonly availableMnt: string;
  readonly frozen: boolean;
  readonly revision: number;
}

export interface RefundView {
  readonly requestId: string;
  readonly originalTransactionId: string;
  readonly channel: RefundRow['channel'];
  readonly alternateChannel: boolean;
  readonly amountMnt: string;
  readonly state: RefundRow['state'];
  readonly approvalState: RefundRow['approvalState'];
  readonly reason: string | null;
  readonly failureReason: string | null;
  readonly revision: number;
}

export interface CorrectionView {
  readonly correctionId: string;
  readonly originalTransactionId: string;
  readonly state: CorrectionRow['state'];
  readonly reason: string;
  readonly correctedAmountMnt: string | null;
  readonly reversalTransactionId: string | null;
  readonly correctedTransactionId: string | null;
  readonly revision: number;
}

export interface CaseView {
  readonly caseId: string;
  readonly stayId: string;
  readonly refundRequestId: string;
  readonly state: CaseRow['state'];
  readonly outcome: CaseRow['outcome'];
  readonly coveredAmountMnt: string | null;
  readonly shortfallAmountMnt: string | null;
  readonly claimedByAccountId: string | null;
  readonly revision: number;
}

export interface FolioView {
  readonly folioId: string;
  readonly stayId: string;
  readonly roomId: string;
  readonly state: FolioRow['state'];
  readonly chargedMnt: string;
  readonly paidMnt: string;
  readonly depositAppliedMnt: string;
  readonly balanceMnt: string;
  readonly lines: readonly FolioLineView[];
  readonly transactions: readonly TransactionView[];
  readonly deposit: DepositView | null;
  readonly refunds: readonly RefundView[];
  readonly corrections: readonly CorrectionView[];
  readonly revision: number;
}

export function lineView(line: FolioLineRow): FolioLineView {
  return {
    lineId: line.lineId,
    kind: line.kind,
    description: line.description,
    amountMnt: line.amountMnt.toString(),
    sourceType: line.sourceType,
    sourceRef: line.sourceRef,
  };
}

export function transactionView(row: TransactionRow): TransactionView {
  return {
    transactionId: row.transactionId,
    kind: row.kind,
    channel: row.channel,
    direction: row.direction,
    amountMnt: row.amountMnt.toString(),
    providerReference: row.providerReference,
    approvalCode: row.approvalCode,
    originalTransactionId: row.originalTransactionId,
    occurredAt: row.occurredAt.toISOString(),
  };
}

export function depositView(row: DepositRow): DepositView {
  return {
    stayId: row.stayId,
    source: row.source,
    required: row.required,
    requiredAmountMnt: row.requiredAmountMnt === null ? null : row.requiredAmountMnt.toString(),
    configScope: row.configScope,
    configVersion: row.configVersion,
    receivedMnt: row.receivedMnt.toString(),
    reversedMnt: row.reversedMnt.toString(),
    allocatedMnt: row.allocatedMnt.toString(),
    refundReservedMnt: row.refundReservedMnt.toString(),
    refundedMnt: row.refundedMnt.toString(),
    availableMnt: availableDepositMnt(row).toString(),
    frozen: row.frozen,
    revision: row.revision,
  };
}

export function refundView(row: RefundRow): RefundView {
  return {
    requestId: row.requestId,
    originalTransactionId: row.originalTransactionId,
    channel: row.channel,
    alternateChannel: row.alternateChannel,
    amountMnt: row.amountMnt.toString(),
    state: row.state,
    approvalState: row.approvalState,
    reason: row.reason,
    failureReason: row.failureReason,
    revision: row.revision,
  };
}

export function correctionView(row: CorrectionRow): CorrectionView {
  return {
    correctionId: row.correctionId,
    originalTransactionId: row.originalTransactionId,
    state: row.state,
    reason: row.reason,
    correctedAmountMnt: row.correctedAmountMnt === null ? null : row.correctedAmountMnt.toString(),
    reversalTransactionId: row.reversalTransactionId,
    correctedTransactionId: row.correctedTransactionId,
    revision: row.revision,
  };
}

export function caseView(row: CaseRow): CaseView {
  return {
    caseId: row.caseId,
    stayId: row.stayId,
    refundRequestId: row.refundRequestId,
    state: row.state,
    outcome: row.outcome,
    coveredAmountMnt: row.coveredAmountMnt === null ? null : row.coveredAmountMnt.toString(),
    shortfallAmountMnt: row.shortfallAmountMnt === null ? null : row.shortfallAmountMnt.toString(),
    claimedByAccountId: row.claimedByAccountId,
    revision: row.revision,
  };
}

export function folioView(input: {
  folio: FolioRow;
  lines: readonly FolioLineRow[];
  transactions: readonly TransactionRow[];
  deposit: DepositRow | undefined;
  refunds: readonly RefundRow[];
  corrections: readonly CorrectionRow[];
}): FolioView {
  return {
    folioId: input.folio.folioId,
    stayId: input.folio.stayId,
    roomId: input.folio.roomId,
    state: input.folio.state,
    chargedMnt: input.folio.chargedMnt.toString(),
    paidMnt: input.folio.paidMnt.toString(),
    depositAppliedMnt: input.folio.depositAppliedMnt.toString(),
    balanceMnt: folioBalanceMnt(input.folio).toString(),
    lines: input.lines.map(lineView),
    transactions: input.transactions.map(transactionView),
    deposit: input.deposit === undefined ? null : depositView(input.deposit),
    refunds: input.refunds.map(refundView),
    corrections: input.corrections.map(correctionView),
    revision: input.folio.revision,
  };
}
