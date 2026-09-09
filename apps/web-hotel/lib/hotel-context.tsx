import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { LockScreen } from '@prsystem/web-kit';
import type { ApiClient } from '@prsystem/web-kit';
import { HOTEL } from './copy';
import { api, membershipFor, requireSession } from './portal';
import type { Membership, SessionView } from './portal';

/**
 * What every hotel page starts from: the session, the membership in *this*
 * hotel, and the hotel's authoritative subscription state.
 *
 * A hotel the session has no active membership in is `notFound()`: the same
 * answer the API gives, so a URL guessed from another tenant learns nothing.
 */
export interface SubscriptionView {
  readonly subscriptionId: string;
  readonly effectivePackage: string;
  readonly packageFloor: string;
  readonly pendingUpgradePackage: string | null;
  readonly pendingUpgradeEffectiveAt: string | null;
  readonly startsAt: string;
  readonly expiresAt: string;
  readonly graceExpiresAt: string;
  readonly state: string;
  readonly listingEligible: boolean;
  readonly billingRevision: number;
}

export interface HotelContext {
  readonly token: string;
  readonly client: ApiClient;
  readonly session: SessionView;
  readonly membership: Membership;
  readonly hotelId: string;
  readonly subscription: SubscriptionView | undefined;
  readonly base: string;
  has(permission: string): boolean;
}

export async function hotelContext(hotelId: string, currentPath: string): Promise<HotelContext> {
  const { token, session } = await requireSession(currentPath);
  const membership = membershipFor(session, hotelId);
  if (membership === undefined) notFound();
  const client = api();
  const subscription = await client.call<SubscriptionView>(`/hotels/${hotelId}/subscription`, {
    token,
  });
  return {
    token,
    client,
    session,
    membership,
    hotelId,
    subscription: subscription.ok ? subscription.body : undefined,
    base: `/hotels/${hotelId}`,
    has: (permission) => membership.effectivePermissions.includes(permission),
  };
}

/** Whether the subscription has hard-locked the hotel (doc 14 §4, §8). */
export function isLocked(subscription: SubscriptionView | undefined): boolean {
  return (
    subscription !== undefined &&
    (subscription.state === 'EXPIRED' || subscription.state === 'SUSPENDED')
  );
}

/** The lock screen an operational page renders instead of its content, or nothing. */
export function lockedScreen(ctx: HotelContext): ReactNode | undefined {
  if (!isLocked(ctx.subscription)) return undefined;
  const suspended = ctx.subscription?.state === 'SUSPENDED';
  return (
    <LockScreen title={suspended ? HOTEL.grace.suspendedTitle : HOTEL.grace.lockedTitle}>
      <p>{suspended ? HOTEL.grace.suspended : HOTEL.grace.locked}</p>
      <p>
        <a className="button" href={`${ctx.base}/subscription`}>
          {HOTEL.tabs.subscription}
        </a>
      </p>
    </LockScreen>
  );
}

/**
 * A primary read the API refused as `NOT_FOUND` renders as the same not-found
 * page: the API's opaque denial (doc 05 §2) is the page's answer too, so a
 * tab reached by URL without the permission looks exactly like no tab.
 */
export function refused(answer: { readonly ok: boolean; readonly status: number }): void {
  if (!answer.ok && answer.status === 404) notFound();
}
