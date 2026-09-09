import { redirect } from 'next/navigation';
import { apiFor, clearToken, portalRuntime, readToken } from '@prsystem/web-kit/server';
import type { ApiClient, ApiResult } from '@prsystem/web-kit';

/**
 * The Operation portal's runtime. Realm separation is absolute (CLAUDE.md §4):
 * a session the API says belongs to another realm is not an Operation session.
 */
export const PORTAL = 'operation';

export function runtime() {
  return portalRuntime(PORTAL);
}

export function api(): ApiClient {
  return apiFor(runtime());
}

export interface OperationSession {
  readonly accountId: string;
  readonly realm: string;
  readonly realmRole?: string;
  readonly effectivePermissions?: readonly string[];
  readonly stepUpRequired?: readonly string[];
}

const signInPath = (next?: string) =>
  next === undefined ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`;

export async function requireSession(
  next?: string,
): Promise<{ token: string; session: OperationSession }> {
  const token = await readToken(runtime());
  if (token === undefined) redirect(signInPath(next));
  const answer = await api().call<OperationSession>('/auth/session', { token });
  if (!answer.ok || answer.body.realm !== 'operation') {
    await clearToken(runtime());
    redirect(signInPath(next));
  }
  return { token, session: answer.body };
}

/** What the API projected this account may reach; every command re-decides on the server. */
export function can(session: OperationSession, actionId: string): boolean {
  return session.effectivePermissions?.includes(actionId) ?? false;
}

/**
 * Every Operation action wants a step-up no older than ten minutes
 * (doc 14 §2.4). The API says so with `PRECONDITION_FAILED`; the portal's
 * answer is the step-up screen, and then the same page again.
 */
export function stepUpIfRequired<T>(answer: ApiResult<T>, next: string): void {
  if (!answer.ok && answer.status === 412) redirect(`/step-up?next=${encodeURIComponent(next)}`);
}
