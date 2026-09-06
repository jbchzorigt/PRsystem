import type { UnitOfWork } from '@prsystem/db';

/**
 * What the restaurant module needs to know about a stay, from the module that
 * owns it (CLAUDE.md §3).
 *
 * doc 08 §7 lets a guest order only while their stay is live and their checkout
 * has not begun, and doc 08 §8 refuses a new order from a stay that is checking
 * out. Both are facts about a stay, and the restaurant module reads them through
 * this contract rather than through the stay module's own tables.
 */
export interface StayFacts {
  readonly stayId: string;
  readonly hotelId: string;
  readonly roomId: string;
  /**
   * `ACTIVE`, `CHECKOUT_IN_PROGRESS` or `COMPLETED`. doc 08 §8 takes no new
   * order from any but the first.
   */
  readonly state: string;
  /** doc 08 §8: a stay whose checkout has started takes no new orders. */
  readonly checkoutStarted: boolean;
}

export interface StayFactsPort {
  /** The live stay of a room, or nothing. Used when a QR names the room. */
  activeStayInRoom(uow: UnitOfWork, roomId: string): Promise<StayFacts | undefined>;
  byId(uow: UnitOfWork, stayId: string): Promise<StayFacts | undefined>;
}

/**
 * The default where no stay relation exists. It refuses the moment one does: a
 * guest session created without checking that the stay is live would let a
 * departed guest keep ordering from the room they have left.
 */
export class UnprovisionedStayFacts implements StayFactsPort {
  async activeStayInRoom(uow: UnitOfWork): Promise<StayFacts | undefined> {
    await this.refuseOnceProvisioned(uow);
    return undefined;
  }

  async byId(uow: UnitOfWork): Promise<StayFacts | undefined> {
    await this.refuseOnceProvisioned(uow);
    return undefined;
  }

  private async refuseOnceProvisioned(uow: UnitOfWork): Promise<void> {
    const result = await uow.query<{ present: boolean }>(
      `SELECT to_regclass('platform.stay') IS NOT NULL AS present`,
    );
    if (result.rows[0]?.present === true) {
      throw new Error(
        'platform.stay exists: a restaurant order must be checked against a live stay through ' +
          'a real StayFactsPort, not this default',
      );
    }
  }
}

/**
 * The stay module's own answer, reading its table directly.
 *
 * It lives here rather than in the stay module because it is a *read* of two
 * columns with no rule of its own: the rules that use it — a guest may order,
 * a checkout must ask — belong to this module and are stated where they apply.
 */
export class RepositoryStayFacts implements StayFactsPort {
  async activeStayInRoom(uow: UnitOfWork, roomId: string): Promise<StayFacts | undefined> {
    const result = await uow.query<Record<string, unknown>>(
      `SELECT stay_id, hotel_id, room_id, state
         FROM platform.stay
        WHERE room_id = $1 AND state = ANY (ARRAY['ACTIVE', 'CHECKOUT_IN_PROGRESS'])
        ORDER BY actual_check_in_at DESC LIMIT 1`,
      [roomId],
    );
    return map(result.rows[0]);
  }

  async byId(uow: UnitOfWork, stayId: string): Promise<StayFacts | undefined> {
    const result = await uow.query<Record<string, unknown>>(
      `SELECT stay_id, hotel_id, room_id, state FROM platform.stay WHERE stay_id = $1`,
      [stayId],
    );
    return map(result.rows[0]);
  }
}

function map(row: Record<string, unknown> | undefined): StayFacts | undefined {
  if (row === undefined) return undefined;
  return {
    stayId: row['stay_id'] as string,
    hotelId: row['hotel_id'] as string,
    roomId: row['room_id'] as string,
    state: row['state'] as string,
    checkoutStarted: row['state'] !== 'ACTIVE',
  };
}
