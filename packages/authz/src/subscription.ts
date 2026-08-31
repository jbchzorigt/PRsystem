import type { PackageCode } from './packages';

/**
 * The subscription and account state gate — pipeline stage 6 (doc 18 §7,
 * doc 05 §4, `OPS-DEC-016`).
 *
 * State is **derived at request time from an authoritative contract**, never
 * read from a stale stored flag and never taken from the client. Phase 05 owns
 * subscriptions and billing; Phase 04 owns only this port and the rule that an
 * unanswerable port denies.
 */

export const SUBSCRIPTION_STATES = [
  'ACTIVE',
  'EXPIRING_SOON',
  'GRACE',
  'EXPIRED',
  'SUSPENDED',
] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

/** doc 18 §7 / `LIFE-DEC-003`: grace is a full-rights window, not a degraded one. */
export const GRACE_HOURS = 48;

export interface SubscriptionSnapshot {
  readonly hotelId: string;
  readonly state: SubscriptionState;
  /** The package actually in force now — not a paid pending upgrade. */
  readonly effectivePackage: PackageCode;
  /** Present while the hotel is inside grace. */
  readonly graceExpiresAt?: Date;
  /** Server time the snapshot was derived at. */
  readonly asOf: Date;
}

/**
 * The authoritative contract.
 *
 * Returning `undefined` means "this cannot be answered right now", and the
 * pipeline denies on it. There is deliberately no third outcome: a port that
 * could report "assume active" would be the stale flag this design removes.
 */
export interface SubscriptionStatePort {
  snapshot(hotelId: string, now: Date): Promise<SubscriptionSnapshot | undefined>;
}

/**
 * The three actions that survive a hard lock, named as permissions.
 *
 * doc 18 §7: once grace has elapsed the operational matrix denies in full;
 * a Hotel Admin keeps renew, help and logout, and every other staff member
 * keeps the expired notice, help and logout. They are catalog entries rather
 * than special cases inside the gate, so a backend check names one of them the
 * same way it names any other permission.
 */
export const SESSION_ACTIONS = [
  {
    id: 'platform.help',
    source: '18 §7',
    label: 'Тусламж',
  },
  {
    id: 'platform.logout',
    source: '18 §7',
    label: 'Гарах',
  },
  {
    id: 'platform.expired_notice',
    source: '18 §7',
    label: 'Subscription дууссан мэдэгдэл харах',
  },
] as const;

/** Permissions every authenticated hotel principal holds, whatever the state. */
export const ALWAYS_AVAILABLE_PERMISSIONS: readonly string[] = SESSION_ACTIONS.map(
  (action) => action.id,
);

/** The renewal action, kept by the Hotel Admin alone under hard lock. */
export const RENEWAL_PERMISSION = 'hotel.subscription.pay';

/** True while the hotel's operational matrix is available in full. */
export function isOperational(state: SubscriptionState): boolean {
  return state === 'ACTIVE' || state === 'EXPIRING_SOON' || state === 'GRACE';
}
