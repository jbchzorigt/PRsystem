import { ApiError } from '@prsystem/contracts';
import { completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import type { Channel } from '../domain/money';
import { referenceRequirements } from '../domain/money';
import { BillingRepository } from '../repositories/billing.repository';
import type { BillingDependencies, CommandActor, RequestContext } from './billing-context';
import { BillingServiceBase, claim, serverNow, sqlState } from './billing-context';
import type { DepositConfigView, FolioView } from './billing-views';
import { depositConfigView } from './billing-views';
import { FolioService } from './folio.service';

/**
 * The configured deposit and the deposit a walk-in actually leaves (doc 02
 * §3.4, doc 20 §§1–2; `RC-DEC-002`, `-003`, `-004`, `DEP-DEC-001`, `-008`).
 *
 * A Manager configures the hotel default and, where a category differs, its
 * override; Reception never touches either. Taking a deposit is an ordinary
 * money movement with the same channel rules as any other, and it is a
 * liability rather than revenue — nothing here posts to the folio.
 */

const CONFIG = 'hotel.deposit.config_manage';
const DEPOSIT = 'hotel.deposit.collect_deduct_refund';

export interface ConfigureDepositInput {
  readonly hotelId: string;
  readonly idempotencyKey: string;
  readonly categoryId?: string;
  readonly amountMnt: bigint;
}

export interface ReceiveDepositInput {
  readonly hotelId: string;
  readonly stayId: string;
  readonly idempotencyKey: string;
  readonly channel: Channel;
  readonly amountMnt: bigint;
  readonly providerReference?: string;
  readonly approvalCode?: string;
  readonly terminalId?: string;
  readonly shiftId?: string;
}

export class DepositService extends BillingServiceBase {
  private readonly folios: FolioService;

  constructor(deps: BillingDependencies) {
    super(deps);
    this.folios = new FolioService(deps);
  }

  /** `RC-DEC-002`: 50,000₮ to 100,000₮, a hotel default and category overrides. */
  async configure(
    input: ConfigureDepositInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<readonly DepositConfigView[]> {
    if (input.amountMnt < 50_000n || input.amountMnt > 100_000n) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'a configured deposit is between 50,000₮ and 100,000₮',
        [{ field: 'amountMnt', issue: 'between 50000 and 100000' }],
      );
    }
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      CONFIG,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'billing.deposit_configure', input.idempotencyKey, {
          categoryId: input.categoryId ?? null,
          amountMnt: input.amountMnt.toString(),
        });
        if (claimed.kind === 'replay') return claimed.body as readonly DepositConfigView[];
        await authorize();
        const billing = new BillingRepository(uow);
        const now = serverNow(this.deps, uow);
        let row;
        try {
          row = await billing.upsertConfig({
            categoryId: input.categoryId ?? null,
            amountMnt: input.amountMnt,
            accountId: gate.principal.accountId,
            at: now,
          });
        } catch (error) {
          if (sqlState(error) === '23503') {
            throw new ApiError('NOT_FOUND', 'not found');
          }
          throw error;
        }
        await recordPlatformAudit(uow, {
          action: 'billing.deposit_configure',
          outcome: 'allowed',
          targetType: 'deposit_config',
          targetRef: row.configId,
          payload: {
            categoryId: input.categoryId ?? null,
            amountMnt: input.amountMnt.toString(),
            configVersion: row.configVersion,
          },
        });
        const result = (await billing.configs()).map(depositConfigView);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  async configuration(
    input: { hotelId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<readonly DepositConfigView[]> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: input.hotelId },
      [CONFIG, DEPOSIT],
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        return (await new BillingRepository(uow).configs()).map(depositConfigView);
      },
    );
  }

  /**
   * doc 20 §2: the deposit is taken on one of the four channels, with what that
   * channel must carry, and it is never counted as revenue — it raises the
   * aggregate's received total and nothing else.
   */
  async receive(
    input: ReceiveDepositInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<FolioView> {
    if (input.amountMnt <= 0n) {
      throw new ApiError('VALIDATION_FAILED', 'a deposit is a positive amount');
    }
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      DEPOSIT,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'billing.deposit_receive', input.idempotencyKey, {
          stayId: input.stayId,
          channel: input.channel,
          amountMnt: input.amountMnt.toString(),
        });
        if (claimed.kind === 'replay') return claimed.body as FolioView;
        await authorize();
        const folio = await this.folios.ensureFolio(uow, input.stayId, gate.principal.accountId);
        const billing = new BillingRepository(uow);
        const deposit = await billing.lockDeposit(input.stayId);
        if (deposit === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (!deposit.required) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            'DEPOSIT_NOT_REQUIRED: a confirmed online booking leaves no deposit',
          );
        }
        if (deposit.frozen) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            'DEPOSIT_FROZEN: a reconciliation case is open on this deposit',
          );
        }
        const needs = referenceRequirements(input.channel);
        if (needs.providerReference && input.providerReference === undefined) {
          throw new ApiError(
            'VALIDATION_FAILED',
            'REFERENCE_REQUIRED: this channel carries a reference',
          );
        }
        if (needs.approvalCode && input.approvalCode === undefined) {
          throw new ApiError(
            'VALIDATION_FAILED',
            'APPROVAL_CODE_REQUIRED: a manual POS movement carries its approval code',
          );
        }
        if (needs.shift && input.shiftId === undefined) {
          throw new ApiError('VALIDATION_FAILED', 'SHIFT_REQUIRED: cash belongs to a shift');
        }
        const now = serverNow(this.deps, uow);
        let transaction;
        try {
          transaction = await billing.post({
            stayId: input.stayId,
            kind: 'DEPOSIT_RECEIPT',
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
        } catch (error) {
          if (sqlState(error) === '23505') {
            throw new ApiError(
              'CONFLICT',
              'REFERENCE_ALREADY_POSTED: that provider reference is already a movement',
            );
          }
          throw error;
        }
        await this.mirrorCash(uow, transaction, gate.principal.accountId);
        const updated = await billing.updateDeposit({
          stayId: input.stayId,
          expectedRevision: deposit.revision,
          receivedMnt: deposit.receivedMnt + input.amountMnt,
        });
        if (updated === undefined) {
          throw new ApiError('CONFLICT', 'the deposit changed; reload and retry');
        }
        await recordPlatformAudit(uow, {
          action: 'billing.deposit_receive',
          outcome: 'allowed',
          targetType: 'payment_transaction',
          targetRef: transaction.transactionId,
          payload: {
            stayId: input.stayId,
            channel: input.channel,
            amountMnt: input.amountMnt.toString(),
          },
        });
        const result = await this.folios.load(uow, folio);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
        return result;
      },
    );
  }
}
