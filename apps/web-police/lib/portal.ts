import { redirect } from 'next/navigation';
import { apiFor, clearToken, portalRuntime, readToken } from '@prsystem/web-kit/server';
import type { ApiClient } from '@prsystem/web-kit';

/**
 * The Police portal's runtime. Realm separation is absolute (CLAUDE.md §4):
 * a session the API says belongs to another realm is not a Police session,
 * whatever cookie carried it.
 */
export const PORTAL = 'police';

export function runtime() {
  return portalRuntime(PORTAL);
}

export function api(): ApiClient {
  return apiFor(runtime());
}

export interface PoliceSession {
  readonly accountId: string;
  readonly realm: string;
  readonly realmRole?: string;
  readonly effectivePermissions?: readonly string[];
  readonly stepUpRequired?: readonly string[];
}

const signInPath = (next?: string) =>
  next === undefined ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`;

/** The signed-in Police session, or the sign-in page. */
export async function requireSession(
  next?: string,
): Promise<{ token: string; session: PoliceSession }> {
  const token = await readToken(runtime());
  if (token === undefined) redirect(signInPath(next));
  const answer = await api().call<PoliceSession>('/auth/session', { token });
  if (!answer.ok || answer.body.realm !== 'police') {
    await clearToken(runtime());
    redirect(signInPath(next));
  }
  return { token, session: answer.body };
}

/** What the API projected this account may reach; every command re-decides on the server. */
export function can(session: PoliceSession, actionId: string): boolean {
  return session.effectivePermissions?.includes(actionId) ?? false;
}
