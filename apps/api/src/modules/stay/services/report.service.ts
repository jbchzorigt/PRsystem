import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { billableQuantity, lineTotalMnt, payableMnt, versionTotalMnt } from '../domain/checkout';
import type { InsertLineInput, ReportRow } from '../repositories/report.repository';
import { ReportRepository } from '../repositories/report.repository';
import { RefillRepository } from '../repositories/refill.repository';
import { StayRepository } from '../repositories/stay.repository';
import type { CommandActor, RequestContext, StayDependencies } from './stay-context';
import { StayServiceBase, claim, serverNow } from './stay-context';
import type { ReportView } from './checkout-views';
import { adjustmentView, disputeView, lockView, versionView } from './checkout-views';

/**
 * The minibar usage report (doc 04 §5.2, doc 21 §§2–4; `CHK-DEC-001`, `-002`,
 * `-003`).
 *
 * A Cleaner claims the room's report, counts what is left and submits it, or
 * confirms there was no usage at all. The server — never the Cleaner and never
 * the client — prices it, from the price book the check-in locked
 * (`PRICE-DEC-003`, `-007`): the unit price of a product absent from that book
 * does not exist, so it cannot be charged (`PRICE-DEC-006`).
 *
 * A Reception that disagrees returns the report with a reason; the Cleaner's
 * correction is a **new version**, and the one it replaces stays in history
 * (`CHK-DEC-003`). When no Cleaner can go, a Manager submits an exception
 * version with the reason it was needed (`CHK-DEC-002`).
 */

const CLAIM = 'hotel.housekeeping.task_claim';
const SUBMIT = 'hotel.minibar.usage_report_create';
const RETURN = 'hotel.minibar.report_return_to_cleaner';
const EXCEPTION = 'hotel.minibar.exception_report_create';
const READ = 'hotel.minibar.locked_price_view';

export interface CountedLine {
  readonly productId: string;
  readonly quantity: number;
}

export interface ClaimReportInput {
  readonly hotelId: string;
  readonly reportId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
}

export interface SubmitReportInput extends ClaimReportInput {
  /** What the Cleaner counted in the room, per product of the price book. */
  readonly counted: readonly CountedLine[];
  /** doc 04 §5.2 (4): `Минибар хэрэглээгүй`, stated rather than left empty. */
  readonly noUsage: boolean;
  readonly reason?: string;
}

export interface ReturnReportInput extends ClaimReportInput {
  readonly reason: string;
}

export class MinibarReportService extends StayServiceBase {
  constructor(deps: StayDependencies) {
    super(deps);
  }

  /** The reports waiting for a Cleaner, and the ones a Reception sent back. */
  async queue(
    input: { hotelId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<
    readonly { readonly reportId: string; readonly roomId: string; readonly state: string }[]
  > {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: input.hotelId },
      [SUBMIT, READ],
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const reports = await new ReportRepository(uow).openQueue();
        return reports.map((report) => ({
          reportId: report.reportId,
          roomId: report.roomId,
          state: report.state,
        }));
      },
    );
  }

  /** The priced report: the Reception's screen and the Manager's (doc 18 §3). */
  async view(
    input: { hotelId: string; reportId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ReportView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      READ,
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const report = await new ReportRepository(uow).byId(input.reportId);
        if (report === undefined) throw new ApiError('NOT_FOUND', 'not found');
        return this.load(uow, report);
      },
    );
  }

  /** doc 04 §8: one Cleaner takes the inspection, in one statement. */
  async claimInspection(
    input: ClaimReportInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ReportView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      CLAIM,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.report_claim', input.idempotencyKey, {
          reportId: input.reportId,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as ReportView;
        const reports = new ReportRepository(uow);
        const peek = await reports.byId(input.reportId);
        if (peek === undefined) {
          await authorize();
          throw new ApiError('NOT_FOUND', 'not found');
        }
        await authorize();
        const now = serverNow(this.deps, uow);
        const taken = await reports.transition({
          reportId: input.reportId,
          expectedRevision: input.expectedRevision,
          toState: 'IN_INSPECTION',
          claimedByAccountId: gate.principal.accountId,
          claimedAt: now,
        });
        if (taken === undefined) {
          throw new ApiError('CONFLICT', 'the report was already taken; reload and retry');
        }
        await recordPlatformAudit(uow, {
          action: 'stay.report_claim',
          outcome: 'allowed',
          targetType: 'minibar_usage_report',
          targetRef: taken.reportId,
          payload: { roomId: taken.roomId },
        });
        const result = await this.load(uow, taken);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /** `CHK-DEC-001`: the Cleaner's own version, priced by the server. */
  async submit(
    input: SubmitReportInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ReportView> {
    return this.write(input, 'NORMAL', 'CLEANER', SUBMIT, actor, request);
  }

  /**
   * `CHK-DEC-002`: no Cleaner can go, so a Manager inspects the room and
   * submits the version with the reason. It is not a bypass — the report still
   * exists, still carries lines, and is still priced from the same book.
   */
  async submitException(
    input: SubmitReportInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ReportView> {
    if (input.reason === undefined || input.reason.trim() === '') {
      throw new ApiError('VALIDATION_FAILED', 'an exception report states why it was needed');
    }
    return this.write(input, 'EXCEPTION', undefined, EXCEPTION, actor, request);
  }

  /** `CHK-DEC-003`: Reception never edits; it sends the report back with a reason. */
  async returnToCleaner(
    input: ReturnReportInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ReportView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      RETURN,
      request,
      async (uow, _gate, authorize) => {
        const claimed = await claim(uow, 'stay.report_return', input.idempotencyKey, {
          reportId: input.reportId,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as ReportView;
        const reports = new ReportRepository(uow);
        const peek = await reports.byId(input.reportId);
        if (peek === undefined) {
          await authorize();
          throw new ApiError('NOT_FOUND', 'not found');
        }
        const report = await reports.lock(input.reportId);
        await authorize();
        if (report === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (report.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the report changed; reload and retry');
        }
        if (report.state !== 'SUBMITTED') {
          throw new ApiError(
            'CONFLICT',
            'REPORT_NOT_SUBMITTED: only a submitted report is returned for correction',
          );
        }
        const returned = await reports.transition({
          reportId: report.reportId,
          expectedRevision: report.revision,
          toState: 'RETURNED',
          reason: input.reason,
        });
        if (returned === undefined) {
          throw new ApiError('CONFLICT', 'the report changed; reload and retry');
        }
        await recordPlatformAudit(uow, {
          action: 'stay.report_return',
          outcome: 'allowed',
          targetType: 'minibar_usage_report',
          targetRef: report.reportId,
          reason: input.reason,
          payload: { roomId: report.roomId, versionId: report.currentVersionId },
        });
        const result = await this.load(uow, returned);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  // ------------------------------------------------------------ internals

  private async write(
    input: SubmitReportInput,
    kind: 'NORMAL' | 'EXCEPTION',
    /** Fixed for a Cleaner's version; taken from the actor for an exception one. */
    role: 'CLEANER' | undefined,
    permission: string,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ReportView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      permission,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(
          uow,
          `stay.report_submit_${kind.toLowerCase()}`,
          input.idempotencyKey,
          {
            reportId: input.reportId,
            expectedRevision: input.expectedRevision,
          },
        );
        if (claimed.kind === 'replay') return claimed.body as ReportView;
        const reports = new ReportRepository(uow);
        const peek = await reports.byId(input.reportId);
        if (peek === undefined) {
          await authorize();
          throw new ApiError('NOT_FOUND', 'not found');
        }
        const report = await reports.lock(input.reportId);
        await authorize();
        if (report === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (report.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the report changed; reload and retry');
        }
        if (!['PENDING', 'IN_INSPECTION', 'RETURNED'].includes(report.state)) {
          throw new ApiError(
            'CONFLICT',
            `REPORT_NOT_OPEN: a report in ${report.state} takes no new version`,
          );
        }
        const now = serverNow(this.deps, uow);
        const lines = await this.price(uow, report, input, now);
        const versions = await reports.versions(report.reportId);
        const version = await reports.insertVersion({
          reportId: report.reportId,
          versionNo: versions.length + 1,
          kind,
          noUsage: input.noUsage,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          submittedByAccountId: gate.principal.accountId,
          // doc 21 §9: the exception report is a Manager's or a Manager Plus's,
          // and the version records which it was.
          submittedRole:
            role ?? (gate.membership.roles.includes('MANAGER_PLUS') ? 'MANAGER_PLUS' : 'MANAGER'),
          cutoffAt: now,
          totalMnt: versionTotalMnt(lines.lines),
          lines: lines.lines,
          countedMovementIds: lines.movements,
        });
        const submitted = await reports.transition({
          reportId: report.reportId,
          expectedRevision: report.revision,
          toState: 'SUBMITTED',
        });
        if (submitted === undefined) {
          throw new ApiError('CONFLICT', 'the report changed; reload and retry');
        }
        await recordPlatformAudit(uow, {
          action: `stay.report_submit.${kind.toLowerCase()}`,
          outcome: 'allowed',
          targetType: 'minibar_usage_report_version',
          targetRef: version.versionId,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          payload: {
            reportId: report.reportId,
            roomId: report.roomId,
            versionNo: version.versionNo,
            totalMnt: version.totalMnt.toString(),
            noUsage: input.noUsage,
          },
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'minibar_usage_report',
          aggregateId: report.reportId,
          eventType: 'stay.minibar_report_submitted',
          payload: {
            reportId: report.reportId,
            stayId: report.stayId,
            versionId: version.versionId,
            versionNo: version.versionNo,
            kind,
            totalMnt: version.totalMnt.toString(),
          },
        });
        const result = await this.load(uow, submitted);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /**
   * doc 22 §8: every line of the check-in price book, priced by the server.
   *
   * The opening quantity is the book's, the refill is what confirmed refill
   * tasks of this stay added, the non-guest stock-out is what a Manager took
   * out of the room against this stay, and the counted quantity is the
   * Cleaner's. `Хэрэглээгүй` is not an empty report: it states that what is
   * available is still there.
   */
  private async price(
    uow: UnitOfWork,
    report: ReportRow,
    input: SubmitReportInput,
    now: Date,
  ): Promise<{
    readonly lines: readonly InsertLineInput[];
    readonly movements: readonly { readonly movementId: string; readonly role: string }[];
  }> {
    const stays = new StayRepository(uow);
    const priceBook = await stays.priceBook(report.stayId);
    if (priceBook === undefined || priceBook.lines.length === 0) {
      throw new ApiError(
        'PRECONDITION_FAILED',
        'PRICE_BOOK_MISSING: this stay has no minibar price book to charge from',
      );
    }
    const counted = new Map(input.counted.map((line) => [line.productId, line.quantity]));
    for (const productId of counted.keys()) {
      if (!priceBook.lines.some((line) => line.productId === productId)) {
        throw new ApiError(
          'VALIDATION_FAILED',
          'PRODUCT_NOT_IN_PRICE_BOOK: a product the check-in did not price cannot be charged',
          [{ field: 'counted', issue: productId }],
        );
      }
    }
    const refills = await new RefillRepository(uow).confirmedOfStay(report.stayId);
    const nonGuest = await this.deps.minibar.nonGuestStockOut(uow, report.stayId);
    const movements: { movementId: string; role: string }[] = [];
    for (const refill of refills) {
      if (refill.movementId !== null) {
        movements.push({ movementId: refill.movementId, role: 'REFILL' });
      }
    }
    for (const out of nonGuest) {
      movements.push({ movementId: out.movementId, role: 'NON_GUEST_OUT' });
    }
    const lines = priceBook.lines.map((line) => {
      const refillQuantity = refills
        .filter((task) => task.productId === line.productId)
        .reduce((sum, task) => sum + (task.confirmedQuantity ?? 0), 0);
      const nonGuestOutQuantity = nonGuest
        .filter((out) => out.productId === line.productId)
        .reduce((sum, out) => sum + out.quantity, 0);
      const available = Math.max(0, line.openingQuantity + refillQuantity - nonGuestOutQuantity);
      const countedQuantity = input.noUsage
        ? available
        : (counted.get(line.productId) ?? available);
      const quantity = billableQuantity({
        openingQuantity: line.openingQuantity,
        refillQuantity,
        nonGuestOutQuantity,
        countedQuantity,
      });
      return {
        productId: line.productId,
        productName: line.productName,
        openingQuantity: line.openingQuantity,
        refillQuantity,
        nonGuestOutQuantity,
        countedQuantity,
        billableQuantity: quantity,
        unitPriceMnt: line.sellingPriceMnt,
        lineTotalMnt: lineTotalMnt(line.sellingPriceMnt, quantity),
      };
    });
    if (input.noUsage && lines.some((line) => line.billableQuantity > 0)) {
      throw new ApiError('VALIDATION_FAILED', 'a no-usage report cannot carry a billable line');
    }
    void now;
    return { lines, movements };
  }

  /** The whole report, with what is payable after the decided waivers. */
  async load(uow: UnitOfWork, report: ReportRow): Promise<ReportView> {
    const reports = new ReportRepository(uow);
    const versions = await reports.versions(report.reportId);
    const views = [];
    for (const version of versions) {
      views.push(versionView(version, await reports.lines(version.versionId)));
    }
    const disputes = await reports.disputes(report.reportId);
    const current = versions.find((version) => version.versionId === report.currentVersionId);
    const waived = disputes
      .filter(
        (dispute) =>
          dispute.state === 'WAIVED' &&
          dispute.waivedAmountMnt !== null &&
          dispute.versionId === report.currentVersionId,
      )
      .map((dispute) => dispute.waivedAmountMnt as bigint);
    return {
      reportId: report.reportId,
      stayId: report.stayId,
      roomId: report.roomId,
      state: report.state,
      currentVersionId: report.currentVersionId,
      versions: views,
      disputes: disputes.map(disputeView),
      locks: (await reports.locks(report.reportId)).map(lockView),
      adjustments: (await reports.adjustments(report.reportId)).map(adjustmentView),
      payableMnt: payableMnt(current?.totalMnt ?? 0n, waived).toString(),
      revision: report.revision,
    };
  }
}
