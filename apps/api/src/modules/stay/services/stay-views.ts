import type { UnitOfWork } from '@prsystem/db';
import type { CorrectionRow } from '../repositories/correction.repository';
import { CorrectionRepository } from '../repositories/correction.repository';
import type { GuestRow, PriceBook, StayRow } from '../repositories/stay.repository';
import { StayRepository } from '../repositories/stay.repository';
import type { ReportRow } from '../repositories/report.repository';
import { ReportRepository } from '../repositories/report.repository';
import { overdueMinutes, timeState } from '../domain/timing';
import type { TimeState } from '../domain/timing';

/**
 * The read shapes of a stay. A guest view never carries the identifier — not
 * the number, not the ciphertext, not the token (CLAUDE.md §8); a price line is
 * the snapshot, never the current catalogue price.
 */

export interface GuestView {
  readonly revisionNo: number;
  readonly identityType: string;
  readonly familyName: string;
  readonly givenName: string;
  readonly nationality: string;
  readonly provenance: string;
  readonly assurance: string;
  readonly documentCountry: string | null;
  readonly ageAtCheckIn: number | null;
  readonly guardianRecorded: boolean;
  readonly policeMatchEligibility: string;
  readonly correctionReason: string | null;
  readonly recordedAt: string;
}

export function guestView(row: GuestRow): GuestView {
  return {
    revisionNo: row.revisionNo,
    identityType: row.identityType,
    familyName: row.familyName,
    givenName: row.givenName,
    nationality: row.nationality,
    provenance: row.provenance,
    assurance: row.assurance,
    documentCountry: row.documentCountry,
    ageAtCheckIn: row.ageAtCheckIn,
    guardianRecorded: row.guardianName !== null,
    policeMatchEligibility: row.policeMatchEligibility,
    correctionReason: row.correctionReason,
    recordedAt: row.recordedAt.toISOString(),
  };
}

export interface CorrectionView {
  readonly correctionId: string;
  readonly stayId: string;
  readonly state: CorrectionRow['state'];
  readonly previousEffectiveAt: string;
  readonly correctedActualCheckInAt: string;
  readonly earliestAllowedAt: string;
  readonly latestAllowedAt: string;
  readonly reason: string;
  readonly requestedByAccountId: string;
  readonly requestedAt: string;
  readonly decidedByAccountId: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly selfApproved: boolean;
  readonly revision: number;
}

export function correctionView(row: CorrectionRow): CorrectionView {
  return {
    correctionId: row.correctionId,
    stayId: row.stayId,
    state: row.state,
    previousEffectiveAt: row.previousEffectiveAt.toISOString(),
    correctedActualCheckInAt: row.correctedActualCheckInAt.toISOString(),
    earliestAllowedAt: row.earliestAllowedAt.toISOString(),
    latestAllowedAt: row.latestAllowedAt.toISOString(),
    reason: row.reason,
    requestedByAccountId: row.requestedByAccountId,
    requestedAt: row.requestedAt.toISOString(),
    decidedByAccountId: row.decidedByAccountId,
    decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
    decisionReason: row.decisionReason,
    selfApproved: row.selfApproved,
    revision: row.revision,
  };
}

export interface PriceBookView {
  readonly templateId: string;
  readonly versionId: string;
  readonly snapshotAt: string;
  readonly lines: readonly {
    readonly productId: string;
    readonly productName: string;
    readonly productCategory: string | null;
    readonly productUnit: string | null;
    readonly sellingPriceMnt: string;
    readonly targetQuantity: number;
    readonly openingQuantity: number;
  }[];
}

export function priceBookView(book: PriceBook): PriceBookView {
  return {
    templateId: book.templateId,
    versionId: book.versionId,
    snapshotAt: book.snapshotAt.toISOString(),
    lines: book.lines.map((line) => ({
      productId: line.productId,
      productName: line.productName,
      productCategory: line.productCategory,
      productUnit: line.productUnit,
      sellingPriceMnt: line.sellingPriceMnt.toString(),
      targetQuantity: line.targetQuantity,
      openingQuantity: line.openingQuantity,
    })),
  };
}

export interface StayView {
  readonly stayId: string;
  readonly roomId: string;
  readonly categoryId: string;
  readonly source: StayRow['source'];
  readonly bookingRef: string | null;
  readonly stayType: StayRow['stayType'];
  readonly state: StayRow['state'];
  readonly actualCheckInAt: string;
  readonly checkInRecordedAt: string;
  /** `STAY-DEC-010`: the latest approved correction, or the original. */
  readonly effectiveActualCheckInAt: string;
  readonly plannedCheckoutAt: string;
  readonly halfHourUnits: number | null;
  readonly durationMinutes: number | null;
  readonly nightCount: number | null;
  readonly fixedCheckoutMinute: number | null;
  readonly cleaningBufferMinutes: number;
  readonly unitRateMnt: string;
  readonly roomChargeMnt: string;
  readonly pricingConfigVersion: number;
  readonly depositRequired: boolean;
  readonly shiftId: string;
  readonly backdateMinutes: number;
  readonly backdateReasonCode: string | null;
  readonly minibarApplicable: boolean;
  readonly actualCheckoutAt: string | null;
  readonly timeState: TimeState | null;
  readonly overdueMinutes: number;
  readonly revision: number;
  /** The stay's live minibar usage report, once a checkout opened one (Phase 22). */
  readonly minibarReport: {
    readonly reportId: string;
    readonly state: string;
    readonly revision: number;
  } | null;
  readonly guest: GuestView | null;
  readonly priceBook: PriceBookView | null;
  readonly pendingCorrection: CorrectionView | null;
}

export function effectiveActualCheckIn(
  stay: StayRow,
  latestApproved: CorrectionRow | undefined,
): Date {
  return latestApproved?.correctedActualCheckInAt ?? stay.actualCheckInAt;
}

export function stayView(
  stay: StayRow,
  now: Date,
  parts: {
    readonly guest: GuestRow | undefined;
    readonly priceBook: PriceBook | undefined;
    readonly latestApproved: CorrectionRow | undefined;
    readonly pending: CorrectionRow | undefined;
    readonly report?: ReportRow | undefined;
  },
): StayView {
  const effective = effectiveActualCheckIn(stay, parts.latestApproved);
  return {
    stayId: stay.stayId,
    roomId: stay.roomId,
    categoryId: stay.categoryId,
    source: stay.source,
    bookingRef: stay.bookingRef,
    stayType: stay.stayType,
    state: stay.state,
    actualCheckInAt: stay.actualCheckInAt.toISOString(),
    checkInRecordedAt: stay.checkInRecordedAt.toISOString(),
    effectiveActualCheckInAt: effective.toISOString(),
    plannedCheckoutAt: stay.plannedCheckoutAt.toISOString(),
    halfHourUnits: stay.halfHourUnits,
    durationMinutes: stay.durationMinutes,
    nightCount: stay.nightCount,
    fixedCheckoutMinute: stay.fixedCheckoutMinute,
    cleaningBufferMinutes: stay.cleaningBufferMinutes,
    unitRateMnt: stay.unitRateMnt.toString(),
    roomChargeMnt: stay.roomChargeMnt.toString(),
    pricingConfigVersion: stay.pricingConfigVersion,
    depositRequired: stay.depositRequired,
    shiftId: stay.shiftId,
    backdateMinutes: stay.backdateMinutes,
    backdateReasonCode: stay.backdateReasonCode,
    minibarApplicable: stay.minibarApplicable,
    actualCheckoutAt: stay.actualCheckoutAt === null ? null : stay.actualCheckoutAt.toISOString(),
    timeState:
      stay.state === 'COMPLETED' ? null : timeState(now, effective, stay.plannedCheckoutAt),
    overdueMinutes: stay.state === 'COMPLETED' ? 0 : overdueMinutes(now, stay.plannedCheckoutAt),
    revision: stay.revision,
    minibarReport:
      parts.report === undefined
        ? null
        : {
            reportId: parts.report.reportId,
            state: parts.report.state,
            revision: parts.report.revision,
          },
    guest: parts.guest === undefined ? null : guestView(parts.guest),
    priceBook: parts.priceBook === undefined ? null : priceBookView(parts.priceBook),
    pendingCorrection: parts.pending === undefined ? null : correctionView(parts.pending),
  };
}

/** Assembles the full view of one stay inside a transaction. */
export async function loadStayView(uow: UnitOfWork, stay: StayRow, now: Date): Promise<StayView> {
  const stays = new StayRepository(uow);
  const corrections = new CorrectionRepository(uow);
  return stayView(stay, now, {
    guest: await stays.currentGuest(stay.stayId),
    priceBook: await stays.priceBook(stay.stayId),
    latestApproved: await corrections.latestApproved(stay.stayId),
    pending: await corrections.pendingOf(stay.stayId),
    report: await new ReportRepository(uow).liveOfStay(stay.stayId),
  });
}
