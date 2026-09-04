import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import type { Channel } from '../domain/money';
import {
  allocatableMnt,
  availableDepositMnt,
  depositRequirement,
  folioBalanceMnt,
  referenceRequirements,
} from '../domain/money';
import { BillingRepository } from '../repositories/billing.repository';
import type { FolioRow } from '../repositories/billing.repository';
import { RefundRepository } from '../repositories/refund.repository';
import type { BillingDependencies, CommandActor, RequestContext } from './billing-context';
import { BillingServiceBase, claim, serverNow } from './billing-context';
import type { FolioView } from './billing-views';
import { folioView } from './billing-views';

/**
 * The one consolidated bill of a stay, the deposit that sits beside it, and the
 * money that moves against both (doc 02 §3.3, doc 20 §3; `RC-DEC-001`,
 * `RC-DEC-004`, `DEP-DEC-002`, `-007`).
 *
 * Charges are posted from the modules that own them — the room charge from the
 * stay's own confirmation snapshot, the minibar charge from the report that
 * settled — and each line is idempotent on what produced it, so posting twice
 * bills once. A payment is recorded only when it actually happened: a gateway
 * channel is confirmed against the provider, a manual POS movement carries its
 * approval code, and cash belongs to a shift.
 *
 * Every command that touches money locks the deposit aggregate first, so
 * allocation, refund reservation and correction serialize on one row and the
 * balance invariant is re-checked before the commit (`DEP-DEC-007`).
 */

const CHECKOUT = 'hotel.stay.checkout_record';
const DEPOSIT = 'hotel.deposit.collect_deduct_refund';

export interface FolioInput {
  readonly hotelId: string;
  readonly stayId: string;
}

export interface PostChargesInput extends FolioInput {
  readonly idempotencyKey: string;
}

export interface PaymentInput extends FolioInput {
  readonly idempotencyKey: string;
  readonly channel: Channel;
  readonly amountMnt: bigint;
  readonly providerReference?: string;
  readonly approvalCode?: string;
  readonly terminalId?: string;
  readonly shiftId?: string;
}

export interface AllocateInput extends FolioInput {
  readonly idempotencyKey: string;
  readonly folioLineId: string;
  readonly amountMnt: bigint;
}

export interface SettleInput extends FolioInput {
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
}

export class FolioService extends BillingServiceBase {
  constructor(deps: BillingDependencies) {
    super(deps);
  }

  /** The bill: its lines, its movements, the deposit and what is still owed. */
  async view(input: FolioInput, actor: CommandActor, request: RequestContext): Promise<FolioView> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: input.hotelId },
      [DEPOSIT, CHECKOUT],
      request,
      async (uow, gate, authorize) => {
        await authorize();
        const folio = await this.ensureFolio(uow, input.stayId, gate.principal.accountId);
        return this.load(uow, folio);
      },
    );
  }

  /**
   * doc 02 §3.3: the room charge may be taken first and the minibar added when
   * its report settles. Both are posted from the modules that own them, and
   * both are idempotent on their source.
   */
  async postCharges(
    input: PostChargesInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<FolioView> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: input.hotelId },
      [CHECKOUT, DEPOSIT],
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'billing.post_charges', input.idempotencyKey, {
          stayId: input.stayId,
        });
        if (claimed.kind === 'replay') return claimed.body as FolioView;
        await authorize();
        const billing = new BillingRepository(uow);
        const facts = await this.deps.stays.billingFacts(uow, input.stayId);
        if (facts === undefined) throw new ApiError('NOT_FOUND', 'not found');
        const opened = await this.ensureFolio(uow, input.stayId, gate.principal.accountId);
        const folio = await billing.lockFolio(input.stayId);
        if (folio === undefined || folio.state !== 'OPEN') {
          throw new ApiError('CONFLICT', 'FOLIO_TERMINAL: this bill is closed');
        }
        void opened;
        let charged = folio.chargedMnt;
        const room = await billing.postLine({
          folioId: folio.folioId,
          kind: 'ROOM',
          sourceType: 'STAY',
          sourceRef: facts.stayId,
          description: 'Өрөөний төлбөр',
          amountMnt: facts.roomChargeMnt,
          accountId: gate.principal.accountId,
        });
        if (room.posted) charged += room.line.amountMnt;
        const minibar = await this.deps.reports.settledMinibarCharge(uow, input.stayId);
        if (minibar !== undefined && minibar.amountMnt > 0n) {
          const line = await billing.postLine({
            folioId: folio.folioId,
            kind: 'MINIBAR',
            sourceType: 'MINIBAR_REPORT_VERSION',
            sourceRef: minibar.versionId,
            description: 'Минибарын төлбөр',
            amountMnt: minibar.amountMnt,
            accountId: gate.principal.accountId,
          });
          if (line.posted) charged += line.line.amountMnt;
        }
        let current = folio;
        if (charged !== folio.chargedMnt) {
          const updated = await billing.updateFolio({
            folioId: folio.folioId,
            expectedRevision: folio.revision,
            chargedMnt: charged,
          });
          if (updated === undefined) {
            throw new ApiError('CONFLICT', 'the folio changed; reload and retry');
          }
          current = updated;
          await recordPlatformAudit(uow, {
            action: 'billing.post_charges',
            outcome: 'allowed',
            targetType: 'stay_folio',
            targetRef: folio.folioId,
            payload: { stayId: input.stayId, chargedMnt: charged.toString() },
          });
        }
        const result = await this.load(uow, current);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /**
   * doc 20 §2: a payment is recorded when it actually happened. QPay and the
   * card gateway are confirmed against the provider by their own reference; a
   * manual POS movement carries its approval code (`DEP-DEC-005`,
   * `RC-DEC-006`); cash belongs to the shift it was taken in.
   */
  async pay(input: PaymentInput, actor: CommandActor, request: RequestContext): Promise<FolioView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      DEPOSIT,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'billing.folio_payment', input.idempotencyKey, {
          stayId: input.stayId,
          channel: input.channel,
          amountMnt: input.amountMnt.toString(),
        });
        if (claimed.kind === 'replay') return claimed.body as FolioView;
        await authorize();
        const billing = new BillingRepository(uow);
        const folio = await billing.lockFolio(input.stayId);
        if (folio === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (folio.state !== 'OPEN') {
          throw new ApiError('CONFLICT', 'FOLIO_TERMINAL: this bill is closed');
        }
        this.requireReferences(input.channel, input);
        await this.requireProviderSuccess(uow, input);
        const balance = folioBalanceMnt(folio);
        if (input.amountMnt > balance) {
          throw new ApiError(
            'VALIDATION_FAILED',
            'PAYMENT_ABOVE_BALANCE: a folio is never paid beyond what it charges',
            [{ field: 'amountMnt', issue: `at most ${balance.toString()}` }],
          );
        }
        const now = serverNow(this.deps, uow);
        const transaction = await billing.post({
          stayId: input.stayId,
          folioId: folio.folioId,
          kind: 'FOLIO_PAYMENT',
          channel: input.channel,
          direction: 'IN',
          amountMnt: input.amountMnt,
          ...(input.providerReference === undefined
            ? {}
            : { providerReference: input.providerReference }),
          ...(input.approvalCode === undefined ? {} : { approvalCode: input.approvalCode }),
          ...(input.terminalId === undefined ? {} : { terminalId: input.terminalId }),
          ...(input.shiftId === undefined ? {} : { shiftId: input.shiftId }),
          accountId: gate.principal.accountId,
          at: now,
        });
        await this.mirrorCash(uow, transaction, gate.principal.accountId);
        const updated = await billing.updateFolio({
          folioId: folio.folioId,
          expectedRevision: folio.revision,
          paidMnt: folio.paidMnt + input.amountMnt,
        });
        if (updated === undefined) {
          throw new ApiError('CONFLICT', 'the folio changed; reload and retry');
        }
        await recordPlatformAudit(uow, {
          action: 'billing.folio_payment',
          outcome: 'allowed',
          targetType: 'payment_transaction',
          targetRef: transaction.transactionId,
          payload: {
            stayId: input.stayId,
            channel: input.channel,
            amountMnt: input.amountMnt.toString(),
          },
        });
        const result = await this.load(uow, updated);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
        return result;
      },
    );
  }

  /**
   * `DEP-DEC-002`: the deposit covers a line of the bill, with no reason, no
   * evidence and no second approval — and it is not a new payment, so it adds
   * no cash to the drawer (doc 20 §9).
   */
  async allocate(
    input: AllocateInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<FolioView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      DEPOSIT,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'billing.deposit_allocate', input.idempotencyKey, {
          stayId: input.stayId,
          folioLineId: input.folioLineId,
          amountMnt: input.amountMnt.toString(),
        });
        if (claimed.kind === 'replay') return claimed.body as FolioView;
        await authorize();
        const billing = new BillingRepository(uow);
        // doc 20 §3.1: the aggregate is locked first, and every later read of
        // the balance in this transaction is behind that lock.
        const deposit = await billing.lockDeposit(input.stayId);
        if (deposit === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (deposit.frozen) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            'DEPOSIT_FROZEN: a reconciliation case is open on this deposit',
          );
        }
        const folio = await billing.lockFolio(input.stayId);
        if (folio === undefined || folio.state !== 'OPEN') {
          throw new ApiError('CONFLICT', 'FOLIO_TERMINAL: this bill is closed');
        }
        const lines = await billing.lines(folio.folioId);
        const line = lines.find((candidate) => candidate.lineId === input.folioLineId);
        if (line === undefined) throw new ApiError('NOT_FOUND', 'not found');
        const allocated = await billing.allocations(input.stayId);
        if (allocated.some((entry) => entry.folioLineId === line.lineId)) {
          throw new ApiError(
            'CONFLICT',
            'LINE_ALREADY_COVERED: this line already has a deposit allocation',
          );
        }
        const bound = allocatableMnt({
          availableMnt: availableDepositMnt(deposit),
          balanceMnt: folioBalanceMnt(folio),
          lineMnt: line.amountMnt,
        });
        if (input.amountMnt > bound) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            'ALLOCATION_ABOVE_AVAILABLE: the deposit cannot cover that much',
            [{ field: 'amountMnt', issue: `at most ${bound.toString()}` }],
          );
        }
        const allocationId = await billing.allocate({
          stayId: input.stayId,
          folioLineId: line.lineId,
          amountMnt: input.amountMnt,
          accountId: gate.principal.accountId,
        });
        const movedDeposit = await billing.updateDeposit({
          stayId: input.stayId,
          expectedRevision: deposit.revision,
          allocatedMnt: deposit.allocatedMnt + input.amountMnt,
        });
        if (movedDeposit === undefined) {
          throw new ApiError('CONFLICT', 'the deposit changed; reload and retry');
        }
        const updated = await billing.updateFolio({
          folioId: folio.folioId,
          expectedRevision: folio.revision,
          depositAppliedMnt: folio.depositAppliedMnt + input.amountMnt,
        });
        if (updated === undefined) {
          throw new ApiError('CONFLICT', 'the folio changed; reload and retry');
        }
        await recordPlatformAudit(uow, {
          action: 'billing.deposit_allocate',
          outcome: 'allowed',
          targetType: 'deposit_allocation',
          targetRef: allocationId,
          payload: {
            stayId: input.stayId,
            folioLineId: line.lineId,
            amountMnt: input.amountMnt.toString(),
          },
        });
        const result = await this.load(uow, updated);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
        return result;
      },
    );
  }

  /** doc 02 §3.3: the bill closes when nothing is left to pay. */
  async settle(
    input: SettleInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<FolioView> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: input.hotelId },
      [CHECKOUT, DEPOSIT],
      request,
      async (uow, _gate, authorize) => {
        const claimed = await claim(uow, 'billing.folio_settle', input.idempotencyKey, {
          stayId: input.stayId,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as FolioView;
        await authorize();
        const billing = new BillingRepository(uow);
        const folio = await billing.lockFolio(input.stayId);
        if (folio === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (folio.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the folio changed; reload and retry');
        }
        if (folio.state !== 'OPEN') {
          throw new ApiError('CONFLICT', 'FOLIO_TERMINAL: this bill is closed');
        }
        const balance = folioBalanceMnt(folio);
        if (balance > 0n) {
          throw new ApiError('PRECONDITION_FAILED', 'FOLIO_UNPAID: the bill still has a balance', [
            { field: 'balanceMnt', issue: balance.toString() },
          ]);
        }
        const now = serverNow(this.deps, uow);
        const settled = await billing.updateFolio({
          folioId: folio.folioId,
          expectedRevision: folio.revision,
          state: 'SETTLED',
          settledAt: now,
        });
        if (settled === undefined) {
          throw new ApiError('CONFLICT', 'the folio changed; reload and retry');
        }
        await recordPlatformAudit(uow, {
          action: 'billing.folio_settle',
          outcome: 'allowed',
          targetType: 'stay_folio',
          targetRef: folio.folioId,
          payload: { stayId: input.stayId, chargedMnt: folio.chargedMnt.toString() },
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'stay_folio',
          aggregateId: folio.folioId,
          eventType: 'billing.folio_settled',
          payload: {
            folioId: folio.folioId,
            stayId: input.stayId,
            chargedMnt: folio.chargedMnt.toString(),
            settledAt: now.toISOString(),
          },
        });
        const result = await this.load(uow, settled);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  // ------------------------------------------------------------ internals

  /**
   * The folio and the deposit aggregate of a stay, created on first touch with
   * the requirement and the configuration the stay was confirmed under
   * (`DEP-DEC-008`).
   */
  async ensureFolio(uow: UnitOfWork, stayId: string, accountId: string): Promise<FolioRow> {
    const billing = new BillingRepository(uow);
    const existing = await billing.folioOfStay(stayId);
    if (existing !== undefined) {
      await this.ensureDeposit(uow, stayId);
      return existing;
    }
    const facts = await this.deps.stays.billingFacts(uow, stayId);
    if (facts === undefined) throw new ApiError('NOT_FOUND', 'not found');
    const now = serverNow(this.deps, uow);
    const { folio } = await billing.openFolio({ stayId, roomId: facts.roomId, at: now });
    await this.ensureDeposit(uow, stayId);
    void accountId;
    return folio;
  }

  private async ensureDeposit(uow: UnitOfWork, stayId: string): Promise<void> {
    const billing = new BillingRepository(uow);
    if ((await billing.deposit(stayId)) !== undefined) return;
    const facts = await this.deps.stays.billingFacts(uow, stayId);
    if (facts === undefined) throw new ApiError('NOT_FOUND', 'not found');
    const category = await billing.config(facts.categoryId);
    const hotel = await billing.config(null);
    let requirement;
    try {
      requirement = depositRequirement({
        source: facts.source === 'ONLINE' ? 'ONLINE' : 'WALK_IN',
        categoryAmountMnt: category?.amountMnt ?? null,
        hotelAmountMnt: hotel?.amountMnt ?? null,
      });
    } catch {
      throw new ApiError(
        'PRECONDITION_FAILED',
        'DEPOSIT_NOT_CONFIGURED: this hotel has no configured deposit for a walk-in',
      );
    }
    await billing.openDeposit({
      stayId,
      source: facts.source === 'ONLINE' ? 'ONLINE' : 'WALK_IN',
      required: requirement.required,
      requiredAmountMnt: requirement.required ? requirement.amountMnt : null,
      configScope: requirement.required ? requirement.scope : 'NONE',
      configVersion: requirement.required
        ? ((requirement.scope === 'CATEGORY' ? category?.configVersion : hotel?.configVersion) ??
          null)
        : null,
      categoryId:
        requirement.required && requirement.scope === 'CATEGORY' ? facts.categoryId : null,
    });
  }

  private requireReferences(
    channel: Channel,
    input: {
      providerReference?: string;
      approvalCode?: string;
      shiftId?: string;
    },
  ): void {
    const needs = referenceRequirements(channel);
    if (needs.providerReference && input.providerReference === undefined) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'REFERENCE_REQUIRED: this channel carries a reference',
        [{ field: 'providerReference', issue: 'required' }],
      );
    }
    if (needs.approvalCode && input.approvalCode === undefined) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'APPROVAL_CODE_REQUIRED: a manual POS movement carries its approval code',
        [{ field: 'approvalCode', issue: 'required' }],
      );
    }
    if (needs.shift && input.shiftId === undefined) {
      throw new ApiError('VALIDATION_FAILED', 'SHIFT_REQUIRED: cash belongs to a shift', [
        { field: 'shiftId', issue: 'required' },
      ]);
    }
  }

  /**
   * doc 20 §2: a QPay or card movement the provider has not confirmed is not a
   * payment. The provider's own status is queried; a client's claim is never
   * enough (CLAUDE.md §7).
   */
  private async requireProviderSuccess(
    uow: UnitOfWork,
    input: { channel: Channel; providerReference?: string; amountMnt: bigint },
  ): Promise<void> {
    if (input.channel !== 'QPAY' && input.channel !== 'CARD_GATEWAY') return;
    const reference = input.providerReference as string;
    const status = await this.gatewayFor(input.channel).queryStatus(
      { providerInvoiceId: reference },
      { correlationId: uow.context.correlationId },
    );
    if (!status.ok) {
      throw new ApiError(
        'PRECONDITION_FAILED',
        'PROVIDER_UNAVAILABLE: the payment could not be confirmed with the provider',
      );
    }
    if (status.value.state !== 'PAID') {
      throw new ApiError(
        'PRECONDITION_FAILED',
        `PROVIDER_NOT_PAID: the provider reports ${status.value.state}`,
      );
    }
    const paid = status.value.paidAmountMnt;
    if (paid !== undefined && paid < input.amountMnt) {
      throw new ApiError(
        'PRECONDITION_FAILED',
        'PROVIDER_AMOUNT_MISMATCH: the provider collected less than this payment records',
      );
    }
  }

  async load(uow: UnitOfWork, folio: FolioRow): Promise<FolioView> {
    const billing = new BillingRepository(uow);
    const refunds = new RefundRepository(uow);
    return folioView({
      folio,
      lines: await billing.lines(folio.folioId),
      transactions: await billing.transactionsOfStay(folio.stayId),
      deposit: await billing.deposit(folio.stayId),
      refunds: await refunds.refundsOfStay(folio.stayId),
      corrections: await refunds.correctionsOfStay(folio.stayId),
    });
  }
}
