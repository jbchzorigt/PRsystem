import { ApiError } from '@prsystem/contracts';
import { completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { RefillRepository } from '../repositories/refill.repository';
import { StayRepository } from '../repositories/stay.repository';
import type { CommandActor, RequestContext, StayDependencies } from './stay-context';
import { StayServiceBase, claim, serverNow, sqlState } from './stay-context';
import type { RefillTaskView } from './checkout-views';
import { refillTaskView } from './checkout-views';

/**
 * The active-stay minibar refill (doc 04 §5.1, doc 25 §6.1).
 *
 * Reception or a Manager asks for a product to be topped up while the guest is
 * still in the room. The request moves no stock: only the Cleaner's confirmed
 * quantity becomes one atomic warehouse → room transfer, linked to the stay,
 * the room, the product and the task. The Cleaner never sees a price
 * (doc 04 §4), and a product the check-in did not price cannot be added to the
 * stay at all — the task's own foreign key to the price book says so
 * (`PRICE-DEC-005`).
 */

const REQUEST = 'hotel.minibar.refill_request';
const EXECUTE = 'hotel.minibar.refill_execute';
const CLAIM = 'hotel.housekeeping.task_claim';

export interface RequestRefillInput {
  readonly hotelId: string;
  readonly stayId: string;
  readonly idempotencyKey: string;
  readonly productId: string;
  readonly quantity: number;
}

export interface RefillTaskInput {
  readonly hotelId: string;
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
}

export interface CompleteRefillInput extends RefillTaskInput {
  readonly confirmedQuantity: number;
}

export interface AbandonRefillInput extends RefillTaskInput {
  readonly reason: string;
}

export class RefillService extends StayServiceBase {
  constructor(deps: StayDependencies) {
    super(deps);
  }

  /** doc 04 §5.1 (1)–(2): the request, checked against the stay and its book. */
  async request(
    input: RequestRefillInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<RefillTaskView> {
    if (!Number.isInteger(input.quantity) || input.quantity < 1) {
      throw new ApiError('VALIDATION_FAILED', 'the quantity is a positive integer');
    }
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      REQUEST,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.refill_request', input.idempotencyKey, {
          stayId: input.stayId,
          productId: input.productId,
          quantity: input.quantity,
        });
        if (claimed.kind === 'replay') return claimed.body as RefillTaskView;
        const stays = new StayRepository(uow);
        const peek = await stays.byId(input.stayId);
        if (peek === undefined) {
          await authorize();
          throw new ApiError('NOT_FOUND', 'not found');
        }
        const stay = await stays.lock(input.stayId);
        await authorize();
        if (stay === undefined) throw new ApiError('NOT_FOUND', 'not found');
        // doc 25 §6.1: the refill is for a stay still in progress, and the
        // checkout must not have started — the count would race the report.
        if (stay.state !== 'ACTIVE') {
          throw new ApiError(
            'CONFLICT',
            'STAY_NOT_ACTIVE: a refill is for an active stay before its checkout starts',
          );
        }
        const book = await stays.priceBook(stay.stayId);
        const line = book?.lines.find((candidate) => candidate.productId === input.productId);
        if (line === undefined) {
          throw new ApiError(
            'VALIDATION_FAILED',
            'PRODUCT_NOT_IN_PRICE_BOOK: this stay was never priced for that product',
          );
        }
        const now = serverNow(this.deps, uow);
        const refills = new RefillRepository(uow);
        let task;
        try {
          task = await refills.create({
            roomId: stay.roomId,
            stayId: stay.stayId,
            productId: input.productId,
            requestedQuantity: input.quantity,
            requestedByAccountId: gate.principal.accountId,
            requestedAt: now,
          });
        } catch (error) {
          if (sqlState(error) === '23505') {
            throw new ApiError(
              'CONFLICT',
              'REFILL_TASK_OPEN: this room already has an open refill task for that product',
            );
          }
          throw error;
        }
        await recordPlatformAudit(uow, {
          action: 'stay.refill_request',
          outcome: 'allowed',
          targetType: 'minibar_refill_task',
          targetRef: task.taskId,
          payload: {
            stayId: stay.stayId,
            roomId: stay.roomId,
            productId: input.productId,
            requestedQuantity: input.quantity,
          },
        });
        const result = refillTaskView(task);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
        return result;
      },
    );
  }

  /** The Cleaner's queue: no price, no guest, only rooms and quantities. */
  async queue(
    input: { hotelId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<readonly RefillTaskView[]> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: input.hotelId },
      [EXECUTE, REQUEST],
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        return (await new RefillRepository(uow).queue()).map(refillTaskView);
      },
    );
  }

  /** doc 04 §8: one Cleaner takes the task, atomically. */
  async claimTask(
    input: RefillTaskInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<RefillTaskView> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: input.hotelId },
      [CLAIM, EXECUTE],
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.refill_claim', input.idempotencyKey, {
          taskId: input.taskId,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as RefillTaskView;
        const refills = new RefillRepository(uow);
        const peek = await refills.byId(input.taskId);
        if (peek === undefined) {
          await authorize();
          throw new ApiError('NOT_FOUND', 'not found');
        }
        await authorize();
        const now = serverNow(this.deps, uow);
        const taken = await refills.claim({
          taskId: input.taskId,
          expectedRevision: input.expectedRevision,
          accountId: gate.principal.accountId,
          at: now,
        });
        if (taken === undefined) {
          throw new ApiError('CONFLICT', 'the task was already taken; reload and retry');
        }
        await recordPlatformAudit(uow, {
          action: 'stay.refill_claim',
          outcome: 'allowed',
          targetType: 'minibar_refill_task',
          targetRef: taken.taskId,
          payload: { roomId: taken.roomId, productId: taken.productId },
        });
        const result = refillTaskView(taken);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /**
   * doc 04 §5.1 (3)–(6): the confirmation is the movement. A partial refill is
   * completed at what was actually put in the room; the shortage stays visible
   * on the request rather than being silently promised.
   */
  async complete(
    input: CompleteRefillInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<RefillTaskView> {
    if (!Number.isInteger(input.confirmedQuantity) || input.confirmedQuantity < 1) {
      throw new ApiError('VALIDATION_FAILED', 'the confirmed quantity is a positive integer');
    }
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      EXECUTE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'stay.refill_complete', input.idempotencyKey, {
          taskId: input.taskId,
          confirmedQuantity: input.confirmedQuantity,
        });
        if (claimed.kind === 'replay') return claimed.body as RefillTaskView;
        const refills = new RefillRepository(uow);
        const peek = await refills.byId(input.taskId);
        if (peek === undefined) {
          await authorize();
          throw new ApiError('NOT_FOUND', 'not found');
        }
        const task = await refills.lock(input.taskId);
        await authorize();
        if (task === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (task.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the task changed; reload and retry');
        }
        if (task.state !== 'IN_PROGRESS') {
          throw new ApiError('CONFLICT', 'TASK_NOT_CLAIMED: claim the task before completing it');
        }
        if (task.cleanerAccountId !== gate.principal.accountId) {
          throw new ApiError('FORBIDDEN', 'TASK_NOT_YOURS: a Cleaner completes only its own task');
        }
        if (input.confirmedQuantity > task.requestedQuantity) {
          throw new ApiError(
            'VALIDATION_FAILED',
            'a refill never confirms more than was requested',
            [{ field: 'confirmedQuantity', issue: `at most ${String(task.requestedQuantity)}` }],
          );
        }
        const now = serverNow(this.deps, uow);
        const movementId = await this.deps.minibar.transferToRoom(uow, {
          roomId: task.roomId,
          productId: task.productId,
          quantity: input.confirmedQuantity,
          stayId: task.stayId,
          taskId: task.taskId,
          actorAccountId: gate.principal.accountId,
        });
        const completed = await refills.complete({
          taskId: task.taskId,
          expectedRevision: task.revision,
          confirmedQuantity: input.confirmedQuantity,
          movementId,
          completedAt: now,
        });
        if (completed === undefined) {
          throw new ApiError('CONFLICT', 'the task changed; reload and retry');
        }
        // doc 26 §22: a retiring product waits for the tasks raised against it.
        await this.deps.lifecycle.finalizeIfClear(uow, 'MINIBAR_PRODUCT', task.productId, {
          source: 'stay.refill_complete',
          actorAccountId: gate.principal.accountId,
        });
        await recordPlatformAudit(uow, {
          action: 'stay.refill_complete',
          outcome: 'allowed',
          targetType: 'minibar_refill_task',
          targetRef: task.taskId,
          payload: {
            roomId: task.roomId,
            productId: task.productId,
            confirmedQuantity: input.confirmedQuantity,
            movementId,
          },
        });
        const result = refillTaskView(completed);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  /** The Cleaner cannot do it (`Гүйцэтгэх боломжгүй`), with a reason and no movement. */
  async markImpossible(
    input: AbandonRefillInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<RefillTaskView> {
    return this.abandon(input, 'IMPOSSIBLE', EXECUTE, actor, request);
  }

  /** Reception or a Manager calls the request off before any movement. */
  async cancel(
    input: AbandonRefillInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<RefillTaskView> {
    return this.abandon(input, 'CANCELLED', REQUEST, actor, request);
  }

  private async abandon(
    input: AbandonRefillInput,
    toState: 'CANCELLED' | 'IMPOSSIBLE',
    permission: string,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<RefillTaskView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      permission,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(
          uow,
          `stay.refill_${toState.toLowerCase()}`,
          input.idempotencyKey,
          { taskId: input.taskId, expectedRevision: input.expectedRevision },
        );
        if (claimed.kind === 'replay') return claimed.body as RefillTaskView;
        const refills = new RefillRepository(uow);
        const peek = await refills.byId(input.taskId);
        if (peek === undefined) {
          await authorize();
          throw new ApiError('NOT_FOUND', 'not found');
        }
        const task = await refills.lock(input.taskId);
        await authorize();
        if (task === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (task.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the task changed; reload and retry');
        }
        if (toState === 'IMPOSSIBLE' && task.state !== 'IN_PROGRESS') {
          throw new ApiError('CONFLICT', 'TASK_NOT_CLAIMED: claim the task before closing it');
        }
        if (toState === 'CANCELLED' && task.state !== 'PENDING') {
          throw new ApiError(
            'CONFLICT',
            'TASK_IN_PROGRESS: a claimed task is closed by its Cleaner, not cancelled',
          );
        }
        const closed = await refills.abandon({
          taskId: task.taskId,
          expectedRevision: task.revision,
          toState,
          reason: input.reason,
        });
        if (closed === undefined) {
          throw new ApiError('CONFLICT', 'the task changed; reload and retry');
        }
        await this.deps.lifecycle.finalizeIfClear(uow, 'MINIBAR_PRODUCT', task.productId, {
          source: `stay.refill_${toState.toLowerCase()}`,
          actorAccountId: gate.principal.accountId,
        });
        await recordPlatformAudit(uow, {
          action: `stay.refill_${toState.toLowerCase()}`,
          outcome: 'allowed',
          targetType: 'minibar_refill_task',
          targetRef: task.taskId,
          reason: input.reason,
          payload: { roomId: task.roomId, productId: task.productId },
        });
        const result = refillTaskView(closed);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }
}
