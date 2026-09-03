/**
 * Tariff resolution (`STAY-DEC-005`, doc 05 §13.1, doc 07 §2.1).
 *
 * Pure, and deliberately the only place the precedence is written down. Two
 * properties are what this file exists to make structural rather than
 * conventional:
 *
 *  - **Hourly and nightly resolve independently.** A category that overrides the
 *    nightly rate and leaves the hourly one unset inherits the hourly rate from
 *    the hotel; the two never travel together.
 *  - **Online quoting cannot see a room.** The walk-in chain is
 *    `room → category → hotel`; the online chain is `category → hotel`, and the
 *    room level is not merely skipped — the online branch never receives it.
 *
 * An unset level is `null`, and `null` is not zero. When no level supplies a
 * rate the answer is `unset`, which the caller turns into a refusal
 * (doc 07 §2.1). Nothing here invents a price.
 */

export const STAY_TYPES = ['HOURLY', 'NIGHTLY'] as const;
export type StayType = (typeof STAY_TYPES)[number];

export const CHANNELS = ['WALK_IN', 'ONLINE'] as const;
export type Channel = (typeof CHANNELS)[number];

export const SOURCE_LEVELS = ['ROOM', 'CATEGORY', 'HOTEL'] as const;
export type SourceLevel = (typeof SOURCE_LEVELS)[number];

/** One configurable level: its identity and its two independent rates. */
export interface TariffLevel {
  readonly entityId: string;
  readonly hourlyRateMnt: bigint | null;
  readonly nightlyRateMnt: bigint | null;
}

export interface TariffChain {
  /** Absent for an online quote: no physical room has been chosen yet. */
  readonly room?: TariffLevel;
  readonly category: TariffLevel;
  readonly hotel: TariffLevel;
}

export interface ResolvedRate {
  readonly unitPriceMnt: bigint;
  readonly sourceLevel: SourceLevel;
  readonly sourceEntityId: string;
}

export type RateResolution =
  | { readonly kind: 'resolved'; readonly rate: ResolvedRate }
  /** No level supplied a rate for this stay type. The caller must refuse. */
  | { readonly kind: 'unset'; readonly stayType: StayType };

function rateOf(level: TariffLevel, stayType: StayType): bigint | null {
  return stayType === 'HOURLY' ? level.hourlyRateMnt : level.nightlyRateMnt;
}

/**
 * The levels consulted, in precedence order, for a channel.
 *
 * The online branch returns a chain with no room in it, so a room override
 * cannot reach an online price even if a caller supplies a room.
 */
export function precedenceFor(
  chain: TariffChain,
  channel: Channel,
): readonly { readonly level: SourceLevel; readonly entity: TariffLevel }[] {
  const category = { level: 'CATEGORY' as const, entity: chain.category };
  const hotel = { level: 'HOTEL' as const, entity: chain.hotel };
  if (channel === 'ONLINE' || chain.room === undefined) return [category, hotel];
  return [{ level: 'ROOM' as const, entity: chain.room }, category, hotel];
}

export function resolveRate(
  chain: TariffChain,
  stayType: StayType,
  channel: Channel,
): RateResolution {
  for (const { level, entity } of precedenceFor(chain, channel)) {
    const rate = rateOf(entity, stayType);
    if (rate === null) continue;
    return {
      kind: 'resolved',
      rate: { unitPriceMnt: rate, sourceLevel: level, sourceEntityId: entity.entityId },
    };
  }
  return { kind: 'unset', stayType };
}

/**
 * The cleaning buffer in force, in integer minutes (`STAY-DEC-004`).
 *
 * Hotel default with an optional category override, and no room level: the
 * decision configures two levels and this resolves exactly those two. Zero is a
 * configured value — a hotel that requires no buffer — and is not the same
 * answer as unset.
 */
export function resolveCleaningBuffer(
  hotelMinutes: number | null,
  categoryMinutes: number | null,
): { readonly kind: 'resolved'; readonly minutes: number } | { readonly kind: 'unset' } {
  if (categoryMinutes !== null) return { kind: 'resolved', minutes: categoryMinutes };
  if (hotelMinutes !== null) return { kind: 'resolved', minutes: hotelMinutes };
  return { kind: 'unset' };
}
