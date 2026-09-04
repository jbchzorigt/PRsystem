import { ApiError } from '@prsystem/contracts';
import { completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { ReportRepository } from '../repositories/report.repository';
import type { CommandActor, RequestContext, StayDependencies } from './stay-context';
import { StayServiceBase, claim, serverNow } from './stay-context';
import type { ReportView } from './checkout-views';
import { MinibarReportService } from './report.service';

/**
 * The guest's minibar dispute (doc 21 §7, `CHK-DEC-006`).
 *
 * Reception marks the line and changes nothing about it — not the quantity,
 * not the price, not the amount. A Manager or Manager Plus decides: the charge
 * stands, or it is waived by an amount that reduces what is payable without
 * touching the version that priced it. Until every dispute is decided, the
 * payment attempt is refused.
 */

const FLAG = 'hotel.minibar.dispute_flag';
const RESOLVE = 'hotel.minibar.dispute_resolve';

export interface FlagDisputeInput {
  readonly hotelId: string;
  readonly reportId: string;
  readonly idempotencyKey: string;
  readonly productId: string;
  readonly disputedQuantity: number;
  readonly note: string;
}

export interface ResolveDisputeInput {
  readonly hotelId: string;
  readonly disputeId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly decision: 'UPHELD' | 'WAIVED';
  readonly reason: string;
}

export class DisputeService extends StayServiceBase {
  private readonly reports: MinibarReportService;

  constructor(deps: StayDependencies) {
    super(deps);
    this.reports = new MinibarReportService(deps);
  }

  /** Reception notes the disputed line; the final payment waits (doc 21 §7 (1)–(2)). */
  async flag(
    input: FlagDisputeInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ReportView> {
    if (!Number.isInteger(input.disputedQuantity) || input.disputedQuantity < 1) {
      throw new ApiError('VALIDATION_FAILED', 'the disputed quantity is a positive integer');
    }
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      FLAG,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.dispute_flag', input.idempotencyKey, {
          reportId: input.reportId,
          productId: input.productId,
          disputedQuantity: input.disputedQuantity,
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
        if (report.currentVersionId === null) {
          throw new ApiError('CONFLICT', 'REPORT_NOT_SUBMITTED: there is no version to dispute');
        }
        if (report.state === 'SETTLED' || report.state === 'CANCELLED') {
          throw new ApiError(
            'CONFLICT',
            'REPORT_TERMINAL: a settled report is corrected by adjustment, not by dispute',
          );
        }
        const lines = await reports.lines(report.currentVersionId);
        const line = lines.find((candidate) => candidate.productId === input.productId);
        if (line === undefined) {
          throw new ApiError(
            'VALIDATION_FAILED',
            'PRODUCT_NOT_IN_REPORT: the version carries no line for this product',
          );
        }
        if (input.disputedQuantity > line.billableQuantity) {
          throw new ApiError(
            'VALIDATION_FAILED',
            'a guest cannot dispute more than the line charges',
            [{ field: 'disputedQuantity', issue: `at most ${String(line.billableQuantity)}` }],
          );
        }
        const now = serverNow(this.deps, uow);
        const dispute = await reports.openDispute({
          reportId: report.reportId,
          versionId: report.currentVersionId,
          productId: input.productId,
          disputedQuantity: input.disputedQuantity,
          note: input.note,
          notedByAccountId: gate.principal.accountId,
          notedAt: now,
        });
        await recordPlatformAudit(uow, {
          action: 'stay.dispute_flag',
          outcome: 'allowed',
          targetType: 'minibar_report_dispute',
          targetRef: dispute.disputeId,
          reason: input.note,
          payload: {
            reportId: report.reportId,
            versionId: report.currentVersionId,
            productId: input.productId,
            disputedQuantity: input.disputedQuantity,
          },
        });
        const result = await this.reports.load(uow, report);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
        return result;
      },
    );
  }

  /**
   * The Manager's decision (doc 21 §7 (3)–(6)). A waiver never edits the
   * report: it records the amount taken off, computed from the version's own
   * snapshot price (`PRICE-DEC-004`).
   */
  async resolve(
    input: ResolveDisputeInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ReportView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      RESOLVE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.dispute_resolve', input.idempotencyKey, {
          disputeId: input.disputeId,
          decision: input.decision,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as ReportView;
        const reports = new ReportRepository(uow);
        const peek = await reports.lockDispute(input.disputeId);
        await authorize();
        if (peek === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (peek.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the dispute changed; reload and retry');
        }
        if (peek.state !== 'OPEN') {
          throw new ApiError('CONFLICT', 'DISPUTE_DECIDED: the dispute already has a decision');
        }
        const lines = await reports.lines(peek.versionId);
        const line = lines.find((candidate) => candidate.productId === peek.productId);
        if (line === undefined) throw new ApiError('NOT_FOUND', 'not found');
        const now = serverNow(this.deps, uow);
        const waived =
          input.decision === 'WAIVED'
            ? line.unitPriceMnt * BigInt(peek.disputedQuantity)
            : undefined;
        const decided = await reports.resolveDispute({
          disputeId: peek.disputeId,
          expectedRevision: peek.revision,
          state: input.decision,
          resolvedByAccountId: gate.principal.accountId,
          resolvedAt: now,
          resolutionReason: input.reason,
          ...(waived === undefined ? {} : { waivedAmountMnt: waived }),
        });
        if (decided === undefined) {
          throw new ApiError('CONFLICT', 'the dispute changed; reload and retry');
        }
        await recordPlatformAudit(uow, {
          action: 'stay.dispute_resolve',
          outcome: 'allowed',
          targetType: 'minibar_report_dispute',
          targetRef: decided.disputeId,
          reason: input.reason,
          payload: {
            reportId: decided.reportId,
            decision: input.decision,
            waivedAmountMnt: waived === undefined ? null : waived.toString(),
          },
        });
        const report = await reports.byId(decided.reportId);
        if (report === undefined) throw new ApiError('NOT_FOUND', 'not found');
        const result = await this.reports.load(uow, report);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }
}
