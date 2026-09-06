import { appendOutboxEvent, recordPlatformAudit } from '@prsystem/db';
import { RestaurantRepository } from '../repositories/restaurant.repository';
import type { RequestContext, RestaurantDependencies } from './restaurant-context';
import { RestaurantServiceBase, newRestaurantRequest } from './restaurant-context';

/**
 * The invoice-expiry sweep (`RC-DEC-023`, doc 08 §14).
 *
 * The shape is Phase 13's hold sweep: candidates are read without a lock and
 * through a resolver, because the job has no tenant and has to see across every
 * hotel; each one is then settled in its own transaction, on its own row lock,
 * so a failure anywhere does not roll back the ones already settled.
 *
 * An expiry cancels the order and expires the payment. It does **not** decide
 * anything about a payment that has not arrived yet: if one lands afterwards,
 * the callback path sees a closed window and raises the mandatory refund
 * `REST-DEC-005` requires — this sweep's only job is to stop the order waiting.
 */
export class RestaurantExpiryService extends RestaurantServiceBase {
  constructor(deps: RestaurantDependencies) {
    super(deps);
  }

  /** Settles up to `limit` lapsed invoices. Returns how many actually expired. */
  async sweep(limit = 100, request: RequestContext = newRestaurantRequest()): Promise<number> {
    const now = this.wallClock();
    const rows = await this.deps.pool.query<{ order_id: string; hotel_id: string }>(
      `SELECT order_id, hotel_id
         FROM platform.lapsed_restaurant_invoices($1::integer, $2::timestamptz)`,
      [limit, now],
    );
    let expired = 0;
    for (const row of rows.rows) {
      if (await this.expireOne(row.hotel_id, row.order_id, request)) expired += 1;
    }
    return expired;
  }

  /**
   * Expires one order's invoice, or leaves it alone.
   *
   * `false` is not a failure: the order may have been paid between the read and
   * the lock, which is exactly the race this design expects to lose sometimes.
   */
  async expireOne(
    hotelId: string,
    orderId: string,
    request: RequestContext = newRestaurantRequest(),
  ): Promise<boolean> {
    return this.inHotelScope(hotelId, request, async (uow) => {
      const repository = new RestaurantRepository(uow);
      const order = await repository.lockOrder(orderId);
      if (order === undefined) return false;
      const attempt = await repository.attemptFor(orderId);
      if (attempt === undefined || attempt.state !== 'ACTIVE') return false;
      const now = this.now(uow);
      // Judged under the lock, not before it.
      if (attempt.expiresAt.getTime() > now.getTime()) return false;
      if (order.paymentState !== 'PENDING') return false;

      await repository.settleAttempt({
        attemptId: attempt.attemptId,
        expectedRevision: attempt.revision,
        state: 'EXPIRED',
        reason: 'the invoice window closed',
        at: now,
      });
      const moved = await repository.transition({
        orderId: order.orderId,
        expectedRevision: order.revision,
        orderState: 'CANCELLED',
        fulfillmentState: 'CANCELLED',
        paymentState: 'EXPIRED',
      });
      if (!moved) return false;
      await repository.record({
        hotelId: order.hotelId,
        orderId: order.orderId,
        stayId: order.stayId,
        axis: 'payment',
        eventType: 'payment.expired',
        fromState: 'PENDING',
        toState: 'EXPIRED',
        actorRef: 'system:invoice-expiry',
      });
      await recordPlatformAudit(uow, {
        action: 'restaurant.invoice_expired',
        outcome: 'allowed',
        targetType: 'restaurant_order',
        targetRef: order.orderId,
        payload: { orderNo: order.orderNo },
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'restaurant_order',
        aggregateId: order.orderId,
        eventType: 'restaurant.order_expired',
        payload: { orderId: order.orderId, restaurantId: order.restaurantId },
      });
      return true;
    });
  }
}
