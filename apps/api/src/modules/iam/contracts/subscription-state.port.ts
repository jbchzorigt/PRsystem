import type { PackageCode, SubscriptionSnapshot, SubscriptionStatePort } from '@prsystem/authz';

/**
 * The authoritative subscription-state contract, and the two implementations
 * Phase 04 may legitimately have.
 *
 * Phase 05 owns onboarding, subscriptions and billing. Phase 04 must not create
 * those tables, and it must not guess: doc 18 §7 and `OPS-DEC-016` require the
 * state to be derived at request time from an authoritative source, never from
 * a stored flag. So the pipeline takes a port, and a port that cannot answer
 * denies (`packages/authz` stage 5).
 *
 * There is deliberately no "assume active" fallback. That is the stale flag this
 * design exists to remove, and a default would make every gate downstream of it
 * meaningless until Phase 05 arrived.
 *
 * The tenancy "package entitlement projection" of doc 03 §1 is **not** built
 * here. ADR-0019 §4 forbids authorization reading a projection, and the
 * authoritative row it would be derived from does not exist yet; building it now
 * would mean an entitlement gate reading eventually-consistent data. Recorded in
 * `assumptions-and-conflicts.md`.
 */
export type { SubscriptionSnapshot, SubscriptionStatePort };

/**
 * The production implementation until Phase 05: it answers nothing, so every
 * hotel action is denied at stage 5 with `SUBSCRIPTION_STATE_UNAVAILABLE`.
 */
export class UnavailableSubscriptionState implements SubscriptionStatePort {
  snapshot(): Promise<SubscriptionSnapshot | undefined> {
    return Promise.resolve(undefined);
  }
}

export interface SimulatedSubscription {
  readonly state: SubscriptionSnapshot['state'];
  readonly effectivePackage: PackageCode;
  readonly graceExpiresAt?: Date;
}

/**
 * A deterministic simulator for local, CI and test use (CLAUDE.md §9).
 *
 * It holds exactly what a caller put in it and answers `undefined` for anything
 * else, so a test that forgets to declare a hotel's subscription sees the
 * fail-closed path rather than a convenient default.
 */
export class SimulatedSubscriptionState implements SubscriptionStatePort {
  private readonly byHotel = new Map<string, SimulatedSubscription>();

  set(hotelId: string, subscription: SimulatedSubscription): void {
    this.byHotel.set(hotelId, subscription);
  }

  clear(hotelId: string): void {
    this.byHotel.delete(hotelId);
  }

  snapshot(hotelId: string, now: Date): Promise<SubscriptionSnapshot | undefined> {
    const entry = this.byHotel.get(hotelId);
    if (entry === undefined) return Promise.resolve(undefined);
    return Promise.resolve({
      hotelId,
      state: entry.state,
      effectivePackage: entry.effectivePackage,
      ...(entry.graceExpiresAt === undefined ? {} : { graceExpiresAt: entry.graceExpiresAt }),
      asOf: now,
    });
  }
}

const NON_PRODUCTION = new Set(['local', 'ci', 'test']);

/**
 * Chooses the adapter for an environment and refuses to degrade.
 *
 * The simulator is unreachable outside local, CI and test — the same rule the
 * key-management selector applies, for the same reason.
 */
export function selectSubscriptionState(appEnv: string): SubscriptionStatePort {
  if (NON_PRODUCTION.has(appEnv)) return new SimulatedSubscriptionState();
  return new UnavailableSubscriptionState();
}
