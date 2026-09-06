import type { UnitOfWork } from '@prsystem/db';
import { RestaurantRepository } from '../repositories/restaurant.repository';
import type {
  RestaurantOrdersPort,
  UnacknowledgedOrder,
} from '../../stay/contracts/restaurant-orders';

/**
 * The restaurant module's answer to a checkout (doc 08 §§12, 17–19).
 *
 * Reads and writes only this module's own tables, inside the checkout's own
 * transaction and its own hotel scope, so the two obligations of the contract
 * either both hold or neither does. It is a query service rather than a shared
 * repository: the stay module never learns a restaurant table's name.
 *
 * Nothing here cancels an order, decides a refund or touches money. doc 08 §13
 * keeps the food payment on the restaurant's own merchant, and a checkout that
 * moved it would be the one bug this module exists to make impossible.
 */
export class RepositoryRestaurantOrders implements RestaurantOrdersPort {
  /**
   * `RC-DEC-028`/`RC-DEC-029`: paid, unfinished, and not yet acknowledged.
   *
   * Re-read at the moment the checkout is confirmed, never taken from the list
   * the screen drew earlier: an order that reached a terminal fulfilment in
   * between needs no choice recorded for it (doc 08 §8).
   */
  async unacknowledgedAtCheckout(
    uow: UnitOfWork,
    stayId: string,
  ): Promise<readonly UnacknowledgedOrder[]> {
    const result = await uow.query<{
      order_id: string;
      order_no: string;
      restaurant_id: string;
      fulfillment_state: string;
    }>(
      `SELECT order_id, order_no, restaurant_id, fulfillment_state
         FROM platform.restaurant_order
        WHERE stay_id = $1
          AND payment_state = 'PAID'
          AND fulfillment_state <> ALL (ARRAY['DELIVERED_TO_ROOM', 'HANDED_TO_RECEPTION',
                                              'PICKED_UP_BY_GUEST', 'CANCELLED'])
          AND checkout_notified_at IS NULL
        ORDER BY created_at`,
      [stayId],
    );
    return result.rows.map((row) => ({
      orderId: row.order_id,
      orderNo: row.order_no,
      restaurantId: row.restaurant_id,
      fulfillmentState: row.fulfillment_state,
    }));
  }

  /**
   * doc 08 §7 and §17: the stay's access dies with the stay.
   *
   * Both halves of the allowance are released together with the rows they
   * count, under the counter's own lock, so the next occupant of the room
   * inherits neither a live session nor a code that still works.
   */
  async closeGuestAccess(uow: UnitOfWork, stayId: string, at: Date): Promise<void> {
    const repository = new RestaurantRepository(uow);
    const counter = await repository.accessCounterOf(stayId);
    // A stay that never opened a session has no counter and nothing to close.
    if (counter === undefined) return;
    const locked = await repository.lockAccessCounter({
      hotelId: counter.hotelId,
      stayId: counter.stayId,
      roomId: counter.roomId,
    });
    const sessions = await repository.revokeSessions({
      stayId,
      at,
      reason: 'the stay checked out',
    });
    const codes = await repository.revokePendingCodes(stayId, at);
    // The counter is a stored total, so it moves with the rows it counts rather
    // than being recomputed later from a count somebody might forget to take.
    const settled = await repository.setAccessCounts({
      stayId,
      expectedRevision: locked.revision,
      activeSessions: Math.max(0, locked.activeSessions - sessions),
      pendingCodes: Math.max(0, locked.pendingCodes - codes),
      closedAt: at,
    });
    if (!settled) {
      // Only reachable if the counter moved under its own lock, which cannot
      // happen inside one transaction — a silent skip would leave a live
      // session behind, so this is loud.
      throw new Error('the guest-access counter changed under the checkout');
    }
  }
}
