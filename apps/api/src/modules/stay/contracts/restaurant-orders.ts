import type { UnitOfWork } from '@prsystem/db';

/**
 * What a checkout owes the restaurant module, from the module that owns it
 * (doc 08 §§12, 18–19, `RC-DEC-028`, `RC-DEC-029`), through a contract rather
 * than a table (CLAUDE.md §3).
 *
 * Two obligations, and no more.
 *
 * **Reception must have acknowledged every paid, unfinished order.** doc 08 §18
 * is explicit that an unfinished order does *not* hard-block the checkout — but
 * §19 is equally explicit that Reception records one of three handoff choices
 * per order first, and §8 asks the server to re-read the orders at the moment
 * the checkout is confirmed rather than trusting a list the screen drew earlier.
 * So what refuses the checkout is a *missing acknowledgement*, never the order.
 *
 * **The stay's guest access dies with the stay.** doc 08 §7 and §17: once the
 * checkout completes, that stay's one-time codes and room sessions are void, so
 * the next occupant of the room inherits nothing.
 *
 * The checkout never cancels an order, never starts a refund, and never adds a
 * food payment to the folio, the deposit, the drawer or the shift (doc 08 §13,
 * doc 24 §1).
 */

export interface UnacknowledgedOrder {
  readonly orderId: string;
  readonly orderNo: string;
  readonly restaurantId: string;
  readonly fulfillmentState: string;
}

export interface RestaurantOrdersPort {
  /**
   * The paid, unfinished orders of this stay for which Reception has recorded
   * no handoff choice yet. Read under the checkout's own transaction.
   */
  unacknowledgedAtCheckout(
    uow: UnitOfWork,
    stayId: string,
  ): Promise<readonly UnacknowledgedOrder[]>;

  /** Closes the stay's guest sessions and pending codes, in this transaction. */
  closeGuestAccess(uow: UnitOfWork, stayId: string, at: Date): Promise<void>;
}

export class RestaurantOrdersUnavailableError extends Error {
  override readonly name = 'RestaurantOrdersUnavailableError';
  constructor() {
    super('platform.restaurant_order exists but no restaurant implementation is registered');
  }
}

/**
 * The default until the restaurant module is registered: no relation, nothing
 * to acknowledge and no access to close.
 *
 * Once `platform.restaurant_order` exists its absence is no longer evidence,
 * so this refuses rather than letting a checkout complete while leaving a room
 * session alive for the next occupant.
 */
export class UnprovisionedRestaurantOrders implements RestaurantOrdersPort {
  async unacknowledgedAtCheckout(uow: UnitOfWork): Promise<readonly UnacknowledgedOrder[]> {
    await this.refuseIfProvisioned(uow);
    return [];
  }

  async closeGuestAccess(uow: UnitOfWork): Promise<void> {
    await this.refuseIfProvisioned(uow);
  }

  private async refuseIfProvisioned(uow: UnitOfWork): Promise<void> {
    const result = await uow.query<{ present: boolean }>(
      `SELECT to_regclass('platform.restaurant_order') IS NOT NULL AS present`,
    );
    if (result.rows[0]?.present === true) throw new RestaurantOrdersUnavailableError();
  }
}

/** A deterministic in-memory implementation for the stay module's own tests. */
export class SimulatedRestaurantOrders implements RestaurantOrdersPort {
  outstanding: UnacknowledgedOrder[] = [];
  readonly closed: { stayId: string; at: Date }[] = [];

  unacknowledgedAtCheckout(
    _uow: UnitOfWork,
    _stayId: string,
  ): Promise<readonly UnacknowledgedOrder[]> {
    return Promise.resolve(this.outstanding);
  }

  closeGuestAccess(_uow: UnitOfWork, stayId: string, at: Date): Promise<void> {
    this.closed.push({ stayId, at });
    return Promise.resolve();
  }
}
