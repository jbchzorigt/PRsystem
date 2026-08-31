/**
 * Which restaurants a hotel has registered (doc 06 §4.1, doc 19 §3).
 *
 * A Restaurant membership is scoped by `restaurant_id`, and doc 19 §3 requires
 * the restaurant to be one the inviting hotel registered. Phase 15 owns the
 * `restaurant` aggregate; Phase 04 holds no foreign key into it and must not
 * create it to satisfy one. So the linkage check is a typed contract, and a
 * contract that cannot answer refuses the invitation rather than assuming the
 * restaurant belongs to the hotel (CLAUDE.md §9).
 */

export interface RestaurantDirectoryPort {
  /** True only when the restaurant is registered to that hotel. */
  belongsToHotel(hotelId: string, restaurantId: string): Promise<boolean>;
}

export class RestaurantDirectoryUnavailableError extends Error {
  override readonly name = 'RestaurantDirectoryUnavailableError';

  constructor() {
    super('the restaurant directory is not available until Phase 15');
  }
}

/**
 * The production path until Phase 15: answer nothing, and so refuse.
 *
 * A restaurant-scoped invitation cannot be authorised without knowing the
 * restaurant is the hotel's own, and "probably" is not an answer this check is
 * allowed to give.
 */
export class UnavailableRestaurantDirectory implements RestaurantDirectoryPort {
  belongsToHotel(): Promise<boolean> {
    return Promise.reject(new RestaurantDirectoryUnavailableError());
  }
}

/** A deterministic simulator for local, CI and test use. */
export class SimulatedRestaurantDirectory implements RestaurantDirectoryPort {
  private readonly byHotel = new Map<string, Set<string>>();

  register(hotelId: string, restaurantId: string): void {
    const existing = this.byHotel.get(hotelId) ?? new Set<string>();
    existing.add(restaurantId);
    this.byHotel.set(hotelId, existing);
  }

  clear(): void {
    this.byHotel.clear();
  }

  belongsToHotel(hotelId: string, restaurantId: string): Promise<boolean> {
    return Promise.resolve(this.byHotel.get(hotelId)?.has(restaurantId) === true);
  }
}

const NON_PRODUCTION = new Set(['local', 'ci', 'test']);

export function selectRestaurantDirectory(appEnv: string): RestaurantDirectoryPort {
  if (NON_PRODUCTION.has(appEnv)) return new SimulatedRestaurantDirectory();
  return new UnavailableRestaurantDirectory();
}
