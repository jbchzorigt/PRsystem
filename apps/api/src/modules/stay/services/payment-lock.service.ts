import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { lockOutcome, payableMnt, paymentBlockers } from '../domain/checkout';
import { ReportRepository } from '../repositories/report.repository';
import { StayRepository } from '../repositories/stay.repository';
import type { CommandActor, RequestContext, StayDependencies } from './stay-context';
import { StayServiceBase, claim, serverNow, sqlState } from './stay-context';
import type { ReportView } from './checkout-views';
import { MinibarReportService } from './report.service';

/**
 * The payment attempt's lock on a report version, its reconciliation, and the
 * adjustments that are the only correction after a settlement (doc 21 §§5–6;
 * `CHK-DEC-004`, `CHK-DEC-005`).
 *
 * Starting a payment recomputes the amount from the latest valid version and
 * locks **that** version: not "the latest at confirmation time", the one the
 * amount was taken from. While the lock is held nobody edits or replaces it.
 *
 * The only answer that releases it is a provider status of `FAILED_NO_FUNDS`,
 * re-queried from the payment module rather than believed from a client
 * (CLAUDE.md §7): pending and unknown keep the hold, and a success settles the
 * report, posts the guest's consumption to the stock ledger and closes the
 * obligation the actual checkout waits on.
 */

const CHECKOUT = 'hotel.stay.checkout_record';
const CORRECTION = 'hotel.minibar.post_payment_correction_approve';

export interface LockPaymentInput {
  readonly hotelId: string;
  readonly reportId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  /** The attempt this hotel is about to make with a provider or in cash. */
  readonly attemptRef: string;
}

export interface ReconcileInput {
  readonly hotelId: string;
  readonly lockId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
}

export interface AdjustInput {
  readonly hotelId: string;
  readonly reportId: string;
  readonly idempotencyKey: string;
  readonly kind: 'OVERCHARGE_REVERSAL' | 'UNDERCHARGE_RECEIVABLE' | 'DISPUTE_WAIVER';
  readonly productId?: string;
  readonly quantity?: number;
  readonly amountMnt?: bigint;
  readonly reason: string;
}

export class PaymentLockService extends StayServiceBase {
  private readonly reports: MinibarReportService;

  constructor(deps: StayDependencies) {
    super(deps);
    this.reports = new MinibarReportService(deps);
  }

  /** doc 21 §5: the amount is recomputed here, and this exact version is locked. */
  async lockForPayment(
    input: LockPaymentInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ReportView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      CHECKOUT,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.payment_lock', input.idempotencyKey, {
          reportId: input.reportId,
          attemptRef: input.attemptRef,
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
        const openDisputes = await reports.openDisputeCount(report.reportId);
        const blockers = paymentBlockers({
          reportState: report.state as
            'PENDING' | 'IN_INSPECTION' | 'SUBMITTED' | 'RETURNED' | 'LOCKED',
          openDisputes,
        });
        if (blockers.length > 0) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            `PAYMENT_REFUSED: ${blockers.join(', ')}`,
            blockers.map((blocker) => ({ field: 'reportId', issue: blocker })),
          );
        }
        const versionId = report.currentVersionId as string;
        const version = await reports.version(versionId);
        if (version === undefined) throw new ApiError('NOT_FOUND', 'not found');
        const disputes = await reports.disputes(report.reportId);
        const waived = disputes
          .filter(
            (dispute) =>
              dispute.state === 'WAIVED' &&
              dispute.versionId === versionId &&
              dispute.waivedAmountMnt !== null,
          )
          .map((dispute) => dispute.waivedAmountMnt as bigint);
        const amount = payableMnt(version.totalMnt, waived);
        const now = serverNow(this.deps, uow);
        let lock;
        try {
          lock = await reports.createLock({
            reportId: report.reportId,
            versionId,
            attemptRef: input.attemptRef,
            amountMnt: amount,
            lockedByAccountId: gate.principal.accountId,
            lockedAt: now,
          });
        } catch (error) {
          if (sqlState(error) === '23505') {
            throw new ApiError(
              'CONFLICT',
              'PAYMENT_ATTEMPT_EXISTS: this attempt or another hold is already on the report',
            );
          }
          throw error;
        }
        const locked = await reports.transition({
          reportId: report.reportId,
          expectedRevision: report.revision,
          toState: 'LOCKED',
        });
        if (locked === undefined) {
          throw new ApiError('CONFLICT', 'the report changed; reload and retry');
        }
        await recordPlatformAudit(uow, {
          action: 'stay.payment_lock',
          outcome: 'allowed',
          targetType: 'minibar_payment_lock',
          targetRef: lock.lockId,
          payload: {
            reportId: report.reportId,
            versionId,
            attemptRef: input.attemptRef,
            amountMnt: amount.toString(),
          },
        });
        const result = await this.reports.load(uow, locked);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
        return result;
      },
    );
  }

  /**
   * doc 21 §5: the provider is asked, and its answer decides. A settlement
   * posts the guest's consumption to the stock ledger — the report's own lines,
   * at the stay's own prices — and closes the checkout obligation.
   */
  async reconcile(
    input: ReconcileInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ReportView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      CHECKOUT,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.payment_reconcile', input.idempotencyKey, {
          lockId: input.lockId,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as ReportView;
        const reports = new ReportRepository(uow);
        const peek = await reports.lockById(input.lockId);
        if (peek === undefined) {
          await authorize();
          throw new ApiError('NOT_FOUND', 'not found');
        }
        const report = await reports.lock(peek.reportId);
        await authorize();
        if (report === undefined) throw new ApiError('NOT_FOUND', 'not found');
        const held = await reports.heldLock(peek.reportId);
        if (held === undefined || held.lockId !== input.lockId) {
          throw new ApiError('CONFLICT', 'PAYMENT_RESOLVED: this attempt is already resolved');
        }
        if (held.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the attempt changed; reload and retry');
        }
        const facts = await this.deps.payments.statusOf(uow, held.attemptRef);
        const outcome = lockOutcome(facts.status);
        const now = serverNow(this.deps, uow);
        if (outcome === 'HOLD') {
          // doc 21 §5: pending or unknown never unlocks. The status is recorded
          // so the next reconciliation starts from what the provider last said.
          const noted = await reports.noteProviderStatus({
            lockId: held.lockId,
            expectedRevision: held.revision,
            providerStatus: facts.status,
          });
          if (noted === undefined) {
            throw new ApiError('CONFLICT', 'the attempt changed; reload and retry');
          }
          await recordPlatformAudit(uow, {
            action: 'stay.payment_reconcile',
            outcome: 'allowed',
            targetType: 'minibar_payment_lock',
            targetRef: held.lockId,
            payload: {
              reportId: report.reportId,
              providerStatus: facts.status,
              decision: 'HELD',
            },
          });
          const stillLocked = await this.reports.load(uow, report);
          await completeIdempotencyKey(uow, claimed.idempotencyId, 200, stillLocked);
          return stillLocked;
        }
        const resolved = await reports.resolveLock({
          lockId: held.lockId,
          expectedRevision: held.revision,
          state: outcome === 'SETTLE' ? 'SETTLED' : 'RELEASED',
          providerStatus: facts.status,
          resolvedByAccountId: gate.principal.accountId,
          resolvedAt: now,
        });
        if (resolved === undefined) {
          throw new ApiError('CONFLICT', 'the attempt changed; reload and retry');
        }
        let next;
        if (outcome === 'SETTLE') {
          await this.postConsumption(
            uow,
            report.reportId,
            report.stayId,
            report.roomId,
            gate.principal.accountId,
          );
          next = await reports.transition({
            reportId: report.reportId,
            expectedRevision: report.revision,
            toState: 'SETTLED',
            settledAt: now,
          });
        } else {
          // The attempt took no money: the version is open to correction again.
          next = await reports.transition({
            reportId: report.reportId,
            expectedRevision: report.revision,
            toState: 'SUBMITTED',
          });
        }
        if (next === undefined) {
          throw new ApiError('CONFLICT', 'the report changed; reload and retry');
        }
        await recordPlatformAudit(uow, {
          action: 'stay.payment_reconcile',
          outcome: 'allowed',
          targetType: 'minibar_payment_lock',
          targetRef: held.lockId,
          payload: {
            reportId: report.reportId,
            providerStatus: facts.status,
            decision: outcome,
            amountMnt: held.amountMnt.toString(),
          },
        });
        if (outcome === 'SETTLE') {
          // doc 26 §33: the report was a safe-point item; with it settled a
          // scheduled configuration change may become a Cleaner's task.
          await this.deps.minibar.advanceScheduled(uow, report.roomId, 'stay.report_settled');
          await appendOutboxEvent(uow, {
            aggregateType: 'minibar_usage_report',
            aggregateId: report.reportId,
            eventType: 'stay.minibar_report_settled',
            payload: {
              reportId: report.reportId,
              stayId: report.stayId,
              versionId: held.versionId,
              amountMnt: held.amountMnt.toString(),
              settledAt: now.toISOString(),
            },
          });
        }
        const result = await this.reports.load(uow, next);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /**
   * `CHK-DEC-005`: after a settlement the report, its lines and the payment are
   * history. An overcharge is reversed, an undercharge becomes a receivable and
   * a late waiver is its own row — all priced from the original snapshot, never
   * from the current catalogue (`PRICE-DEC-004`).
   */
  async adjust(
    input: AdjustInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ReportView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      CORRECTION,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.report_adjust', input.idempotencyKey, {
          reportId: input.reportId,
          kind: input.kind,
          productId: input.productId ?? null,
          quantity: input.quantity ?? null,
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
        if (report.state !== 'SETTLED') {
          throw new ApiError(
            'CONFLICT',
            'REPORT_NOT_SETTLED: before a settlement a report is corrected by a new version',
          );
        }
        const settled = await reports.settledLock(report.reportId);
        if (settled === undefined) throw new ApiError('NOT_FOUND', 'not found');
        const lines = await reports.lines(settled.versionId);
        let amount = input.amountMnt;
        let unitPrice: bigint | undefined;
        if (input.productId !== undefined) {
          const line = lines.find((candidate) => candidate.productId === input.productId);
          if (line === undefined) {
            throw new ApiError(
              'VALIDATION_FAILED',
              'PRODUCT_NOT_IN_REPORT: the settled version carries no line for this product',
            );
          }
          if (
            input.quantity === undefined ||
            !Number.isInteger(input.quantity) ||
            input.quantity < 1
          ) {
            throw new ApiError('VALIDATION_FAILED', 'a product adjustment states a whole quantity');
          }
          unitPrice = line.unitPriceMnt;
          amount = line.unitPriceMnt * BigInt(input.quantity);
        }
        if (amount === undefined || amount <= 0n) {
          throw new ApiError('VALIDATION_FAILED', 'an adjustment states a positive amount');
        }
        const adjustment = await reports.insertAdjustment({
          reportId: report.reportId,
          originalVersionId: settled.versionId,
          lockId: settled.lockId,
          kind: input.kind,
          ...(input.productId === undefined ? {} : { productId: input.productId }),
          ...(input.quantity === undefined ? {} : { quantity: input.quantity }),
          ...(unitPrice === undefined ? {} : { unitPriceMnt: unitPrice }),
          amountMnt: amount,
          reason: input.reason,
          actorAccountId: gate.principal.accountId,
        });
        await recordPlatformAudit(uow, {
          action: 'stay.report_adjust',
          outcome: 'allowed',
          targetType: 'minibar_report_adjustment',
          targetRef: adjustment.adjustmentId,
          reason: input.reason,
          payload: {
            reportId: report.reportId,
            kind: input.kind,
            amountMnt: amount.toString(),
            originalVersionId: settled.versionId,
          },
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'minibar_usage_report',
          aggregateId: report.reportId,
          eventType: 'stay.minibar_report_adjusted',
          payload: {
            reportId: report.reportId,
            stayId: report.stayId,
            adjustmentId: adjustment.adjustmentId,
            kind: input.kind,
            amountMnt: amount.toString(),
          },
        });
        const result = await this.reports.load(uow, report);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
        return result;
      },
    );
  }

  /**
   * doc 04 §8: what the guest consumed leaves the room's stock when the charge
   * settles, as `GUEST_CONSUMPTION` movements linked to the stay.
   */
  private async postConsumption(
    uow: UnitOfWork,
    reportId: string,
    stayId: string,
    roomId: string,
    actorAccountId: string,
  ): Promise<void> {
    const reports = new ReportRepository(uow);
    const report = await reports.byId(reportId);
    if (report?.currentVersionId == null) return;
    const stays = new StayRepository(uow);
    void stays;
    for (const line of await reports.lines(report.currentVersionId)) {
      if (line.billableQuantity === 0) continue;
      await this.deps.minibar.postGuestConsumption(uow, {
        roomId,
        productId: line.productId,
        quantity: line.billableQuantity,
        stayId,
        versionId: report.currentVersionId,
        actorAccountId,
      });
    }
  }
}
