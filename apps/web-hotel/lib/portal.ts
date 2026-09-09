import { redirect } from 'next/navigation';
import { apiFor, portalRuntime, readToken } from '@prsystem/web-kit/server';
import type { ApiClient } from '@prsystem/web-kit';

/**
 * The hotel portal's runtime: the API client and the session it holds.
 *
 * Everything a page shows is fetched here with the session's token, so what a
 * person sees is what the API answered for *them* — never a cached or shared
 * view (CLAUDE.md §3, §4).
 */
export const PORTAL = 'hotel';

export function runtime() {
  return portalRuntime(PORTAL);
}

export function api(): ApiClient {
  return apiFor(runtime());
}

export interface Membership {
  readonly membershipId: string;
  readonly hotelId: string;
  readonly restaurantId?: string;
  readonly state: string;
  readonly roles: readonly string[];
  readonly effectivePermissions: readonly string[];
  readonly subscriptionState: string | null;
}

export interface SessionView {
  readonly accountId: string;
  readonly realm: string;
  readonly memberships: readonly Membership[];
}

/** The signed-in session, or the sign-in page. */
export async function requireSession(
  next?: string,
): Promise<{ token: string; session: SessionView }> {
  const token = await readToken(runtime());
  if (token === undefined) {
    redirect(next === undefined ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`);
  }
  const answer = await api().call<SessionView>('/auth/session', { token });
  if (!answer.ok) {
    // A stale or revoked token is the same as none: back to sign-in.
    redirect(next === undefined ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`);
  }
  return { token, session: answer.body };
}

export function membershipFor(session: SessionView, hotelId: string): Membership | undefined {
  return session.memberships.find((m) => m.hotelId === hotelId && m.state === 'ACTIVE');
}

export function can(membership: Membership | undefined, permission: string): boolean {
  return membership !== undefined && membership.effectivePermissions.includes(permission);
}
