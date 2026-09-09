import { redirect } from 'next/navigation';
import { apiFor, portalRuntime, readToken } from '@prsystem/web-kit/server';
import type { ApiClient } from '@prsystem/web-kit';

/**
 * The Restaurant guest portal (doc 08; RC-DEC-026, -027): a room QR and a
 * one-time code open a stay-bound session. The session travels to the API in
 * its own header, never as a bearer, and lives in an httpOnly cookie here.
 */
export const PORTAL = 'restaurant';
export const SESSION_HEADER = 'x-restaurant-session';

export function runtime() {
  return portalRuntime(PORTAL);
}

export function api(): ApiClient {
  return apiFor(runtime());
}

export async function sessionToken(): Promise<string | undefined> {
  return readToken(runtime());
}

export async function requireGuestSession(): Promise<string> {
  const token = await sessionToken();
  if (token === undefined) redirect('/');
  return token;
}

export function headersFor(token: string): Readonly<Record<string, string>> {
  return { [SESSION_HEADER]: token };
}
