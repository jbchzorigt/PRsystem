import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { isRetryable } from '@prsystem/ports';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { RestaurantRepository } from '../repositories/restaurant.repository';
import { requestResolved, requestSla } from '../domain/restaurant';
import type { CommandActor, RequestContext, RestaurantDependencies } from './restaurant-context';
import { RestaurantServiceBase, claim, newRestaurantRequest } from './restaurant-context';

/**
 * The refund the restaurant executes on its own merchant (`RC-DEC-024`, doc 08
 * §15), and the SLA that escalates while it has not.
 *
 * The platform holds none of this money and settles none of it. What it does is
 * record that a refund was started, ask the provider, and record what the
 * provider said — and until the provider says it succeeded, the refund axis is
 * not `REFUNDED` and the payment axis is still `PAID`. doc 08 §11 refuses every
 * hotel and restaurant role the power to mark either by hand, and there is no
 * code path here that does.
 */
const ORDER_PROCESS = 'restaurant.order_process';

export class RestaurantRefundService extends RestaurantServiceBase {
  constructor(deps: RestaurantDependencies) {
    super(deps);
  }

  /**
   * doc 08 §15: the Restaurant Manager starts the refund of an approved request.
   *
   * The provider call is made between two transactions, for the reason every
   * other provider call in this codebase is: a lock held across a network call
   * is a lock held for as long as the provider takes.
   */
  async execute(
    input: { hotelId: string; orderId: string; idempotencyKey: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ refundId: string; state: string }> {
    const started = await this.start(input, actor, request);
    if (started.replayed) return { refundId: started.refundId, state: started.state };

    const gateway = this.deps.payments.gateway('QPAY');
    const answer = await gateway.refund(
      {
        providerPaymentId: started.providerPaymentId,
        amountMnt: started.amountMnt,
        reason: 'RESTAURANT_ORDER',
        idempotencyKey: `restaurant-refund:${started.refundId}`,
      },
      { correlationId: request.correlationId },
    );

    if (!answer.ok) {
      // Unreachable is not refused: the attempt stays open and the next one
      // asks again.
      if (isRetryable(answer.error)) return { refundId: started.refundId, state: 'PENDING' };
      return this.settle(input.hotelId, started.refundId, request, {
        kind: 'failed',
        code: answer.error.kind,
      });
    }
    if (answer.value.state === 'PENDING') return { refundId: started.refundId, state: 'PENDING' };
    if (answer.value.state === 'FAILED') {
      return this.settle(input.hotelId, started.refundId, request, {
        kind: 'failed',
        code: 'PROVIDER_DECLINED',
      });
    }
    return this.settle(input.hotelId, started.refundId, request, {
      kind: 'refunded',
      providerRefundId: answer.value.providerRefundId,
    });
  }

  private async start(
    input: { hotelId: string; orderId: string; idempotencyKey: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{
    refundId: string;
    amountMnt: bigint;
    providerPaymentId: string;
    state: string;
    replayed: boolean;
  }> {
    const restaurantId = await this.inHotelScope(
      input.hotelId,
      request,
      async (uow) => (await new RestaurantRepository(uow).orderById(input.orderId))?.restaurantId,
    );
    if (restaurantId === undefined) throw new ApiError('NOT_FOUND', 'no such order');

    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId, restaurantId },
      ORDER_PROCESS,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'restaurant.refund', input.idempotencyKey, {
          orderId: input.orderId,
        });
        if (claimed.kind === 'replay') {
          return {
            ...(claimed.body as { refundId: string; amountMnt: string; providerPaymentId: string }),
            amountMnt: BigInt((claimed.body as { amountMnt: string }).amountMnt),
            state: 'PENDING',
            replayed: true,
          };
        }
        await authorize();
        const repository = new RestaurantRepository(uow);
        const order = await repository.lockOrder(input.orderId);
        if (order === undefined) throw new ApiError('NOT_FOUND', 'no such order');
        if (order.refundRequestState !== 'APPROVED') {
          throw new ApiError(
            'PRECONDITION_FAILED',
            'NO_APPROVED_REQUEST: only an approved request is refunded',
          );
        }
        if (order.refundState === 'PENDING') {
          throw new ApiError('CONFLICT', 'a refund is already in flight for that order');
        }
        if (order.refundState === 'REFUNDED') {
          throw new ApiError('CONFLICT', 'that order has already been refunded');
        }
        const attempt = await repository.attemptFor(order.orderId);
        if (attempt?.providerPaymentId == null) {
          throw new ApiError('PRECONDITION_FAILED', 'that order carries no captured payment');
        }
        const refund = await repository.createRefund({
          hotelId: order.hotelId,
          orderId: order.orderId,
          restaurantId: order.restaurantId,
          amountMnt: order.totalAmountMnt,
          providerPaymentId: attempt.providerPaymentId,
          initiatedByAccountId: gate.principal.accountId,
        });
        const moved = await repository.transition({
          orderId: order.orderId,
          expectedRevision: order.revision,
          refundState: 'PENDING',
        });
        if (!moved) throw new ApiError('CONFLICT', 'that order changed under this command');
        await repository.record({
          hotelId: order.hotelId,
          orderId: order.orderId,
          stayId: order.stayId,
          axis: 'refund',
          eventType: 'refund.started',
          fromState: 'NONE',
          toState: 'PENDING',
          actorRef: gate.principal.accountId,
        });
        const body = {
          refundId: refund.refundId,
          amountMnt: refund.amountMnt.toString(),
          providerPaymentId: refund.providerPaymentId,
        };
        await completeIdempotencyKey(uow, claimed.idempotencyId, 202, body);
        return {
          refundId: refund.refundId,
          amountMnt: refund.amountMnt,
          providerPaymentId: refund.providerPaymentId,
          state: 'PENDING',
          replayed: false,
        };
      },
    );
  }

  /**
   * Writes what the provider said, under the lock, having re-read the row.
   *
   * A success resolves the request and lifts whatever SLA pause it caused. A
   * failure leaves the request `APPROVED` and open — doc 08 §21.2 is explicit
   * that a failed refund resolves nothing and the pause stays.
   */
  private async settle(
    hotelId: string,
    refundId: string,
    request: RequestContext,
    outcome: { kind: 'refunded'; providerRefundId: string } | { kind: 'failed'; code: string },
  ): Promise<{ refundId: string; state: string }> {
    return this.inHotelScope(hotelId, request, async (uow) => {
      const repository = new RestaurantRepository(uow);
      const refund = await repository.lockRefund(refundId);
      if (refund === undefined || refund.state !== 'PENDING') {
        return { refundId, state: refund?.state ?? 'UNKNOWN' };
      }
      const order = await repository.lockOrder(refund.orderId);
      if (order === undefined) throw new ApiError('NOT_FOUND', 'no such order');
      const now = this.now(uow);

      if (outcome.kind === 'failed') {
        await repository.settleRefund({
          refundId: refund.refundId,
          expectedRevision: refund.revision,
          state: 'FAILED',
          failureCode: outcome.code,
          at: now,
        });
        await repository.transition({
          orderId: order.orderId,
          expectedRevision: order.revision,
          refundState: 'FAILED',
        });
        await repository.record({
          hotelId: order.hotelId,
          orderId: order.orderId,
          stayId: order.stayId,
          axis: 'refund',
          eventType: 'refund.failed',
          fromState: 'PENDING',
          toState: 'FAILED',
          actorRef: 'provider',
          reason: outcome.code,
        });
        await recordPlatformAudit(uow, {
          action: 'restaurant.refund_failed',
          outcome: 'failed',
          targetType: 'restaurant_order',
          targetRef: order.orderId,
          payload: { refundId: refund.refundId, failureCode: outcome.code },
        });
        return { refundId, state: 'FAILED' };
      }

      await repository.settleRefund({
        refundId: refund.refundId,
        expectedRevision: refund.revision,
        state: 'REFUNDED',
        providerRefundId: outcome.providerRefundId,
        at: now,
      });
      // doc 08 §10: `REFUNDED` and `RESOLVED` move together, and the payment
      // axis keeps its history — the money really was taken.
      await repository.transition({
        orderId: order.orderId,
        expectedRevision: order.revision,
        refundState: 'REFUNDED',
        refundRequestState: 'RESOLVED',
      });
      await repository.record({
        hotelId: order.hotelId,
        orderId: order.orderId,
        stayId: order.stayId,
        axis: 'refund',
        eventType: 'refund.completed',
        fromState: 'PENDING',
        toState: 'REFUNDED',
        actorRef: 'provider',
      });
      await recordPlatformAudit(uow, {
        action: 'restaurant.refund_completed',
        outcome: 'allowed',
        targetType: 'restaurant_order',
        targetRef: order.orderId,
        payload: { refundId: refund.refundId, amountMnt: refund.amountMnt.toString() },
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'restaurant_order',
        aggregateId: order.orderId,
        eventType: 'restaurant.refunded',
        payload: { orderId: order.orderId, amountMnt: refund.amountMnt.toString() },
      });
      // `RC-DEC-031`: a resolved request lifts the pause it caused — and lifts
      // nothing else, so a link Manager Plus switched off by hand stays off.
      await this.liftPauseIfClear(uow, order.restaurantId);
      return { refundId, state: 'REFUNDED' };
    });
  }

  /**
   * `RC-DEC-031`: escalate a waiting request, and pause the link at thirty
   * minutes.
   *
   * The sweep decides nothing about money. It reminds, it escalates, and it
   * stops the *link* taking new orders — everything already placed carries on,
   * and doc 08 §21.2 says so in as many words.
   */
  async sweepRequests(
    limit = 100,
    request: RequestContext = newRestaurantRequest(),
  ): Promise<number> {
    const now = this.wallClock();
    const rows = await this.deps.pool.query<{
      order_id: string;
      hotel_id: string;
      restaurant_id: string;
    }>(
      `SELECT order_id, hotel_id, restaurant_id
         FROM platform.unresolved_refund_requests($1::integer, $2::timestamptz)`,
      [limit, now],
    );
    let paused = 0;
    for (const row of rows.rows) {
      if (await this.escalate(row.hotel_id, row.order_id, request)) paused += 1;
    }
    return paused;
  }

  private async escalate(
    hotelId: string,
    orderId: string,
    request: RequestContext,
  ): Promise<boolean> {
    return this.inHotelScope(hotelId, request, async (uow) => {
      const repository = new RestaurantRepository(uow);
      const order = await repository.lockOrder(orderId);
      if (order === undefined || order.refundRequestedAt === null) return false;
      if (requestResolved(order)) return false;
      const sla = requestSla(order.refundRequestedAt, this.now(uow));
      if (!sla.pauseLink) return false;
      const link = await repository.lockLink(order.restaurantId);
      if (link === undefined || link.slaPaused) return false;
      const moved = await repository.updateLink({
        linkId: link.linkId,
        expectedRevision: link.revision,
        slaPaused: true,
        slaPausedReason: `unresolved refund request on ${order.orderNo}`,
        slaPausedAt: this.now(uow),
      });
      if (!moved) return false;
      await recordPlatformAudit(uow, {
        action: 'restaurant.link_paused',
        outcome: 'allowed',
        targetType: 'restaurant',
        targetRef: order.restaurantId,
        payload: { orderId: order.orderId, reason: 'REFUND_REQUEST_UNRESOLVED' },
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'restaurant',
        aggregateId: order.restaurantId,
        eventType: 'restaurant.link_paused',
        payload: { restaurantId: order.restaurantId, orderId: order.orderId },
      });
      return true;
    });
  }

  /**
   * Lifts the pause when nothing is waiting any more.
   *
   * `RC-DEC-031`: only a refund that actually reached the guest, or a
   * discretionary request the restaurant refused, resolves one — a refund still
   * `PENDING` or `FAILED` does not, however long it has been.
   */
  private async liftPauseIfClear(uow: UnitOfWork, restaurantId: string): Promise<void> {
    const repository = new RestaurantRepository(uow);
    const open = await uow.query<{ open: string }>(
      `SELECT count(*)::text AS open FROM platform.restaurant_order
        WHERE restaurant_id = $1 AND refund_request_state = ANY (ARRAY['OPEN', 'APPROVED'])`,
      [restaurantId],
    );
    if (Number(open.rows[0]?.open ?? '0') > 0) return;
    const link = await repository.lockLink(restaurantId);
    if (link === undefined || !link.slaPaused) return;
    await repository.updateLink({
      linkId: link.linkId,
      expectedRevision: link.revision,
      slaPaused: false,
    });
  }
}
