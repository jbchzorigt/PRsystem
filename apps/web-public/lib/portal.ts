import { redirect } from 'next/navigation';
import { apiFor, portalRuntime, readToken } from '@prsystem/web-kit/server';
import type { ApiClient } from '@prsystem/web-kit';

/** The Guest portal's runtime (doc 09 §6): a phone-and-password session in an httpOnly cookie. */
export const PORTAL = 'guest';

export function runtime() {
  return portalRuntime(PORTAL);
}

export function api(): ApiClient {
  return apiFor(runtime());
}

export async function sessionToken(): Promise<string | undefined> {
  return readToken(runtime());
}

/** The token, or the sign-in page carrying where to come back to. */
export async function requireGuest(next: string): Promise<string> {
  const token = await sessionToken();
  if (token === undefined) redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  return token;
}

/** The number being verified lives in a ten-minute httpOnly cookie, never in a URL (CLAUDE.md §8). */
export const REGISTER_PHONE_COOKIE = 'prsystem_guest_register_phone';
