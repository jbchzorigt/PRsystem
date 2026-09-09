import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ApiClient } from '../api';

/**
 * The portal's server-side session (Phase 21).
 *
 * The API token lives in an httpOnly cookie the browser cannot read, is sent
 * to the API only from the portal's own server, and is cleared on sign-out.
 * The portal keeps no copy anywhere else and renders nothing it cannot fetch
 * with it: "server-enforced navigation" means the nav is decided from what the
 * API answers for this token, not from anything the client claims.
 */

export interface PortalRuntime {
  /** Which portal, for the cookie name — a hotel token is never a police one. */
  readonly portal: string;
  readonly apiUrl: string;
  /** The portal's own origin; `https` makes the cookie `Secure`. */
  readonly origin: string;
}

const RUNTIME_CACHE = new Map<string, PortalRuntime>();

/** Reads the portal's runtime configuration once, failing closed when it is absent. */
export function portalRuntime(portal: string): PortalRuntime {
  const cached = RUNTIME_CACHE.get(portal);
  if (cached !== undefined) return cached;
  const apiUrl = process.env['PRSYSTEM_API_URL'];
  const origin = process.env['PRSYSTEM_PORTAL_ORIGIN'];
  if (apiUrl === undefined || apiUrl === '') {
    throw new Error('PRSYSTEM_API_URL is required: the portal has no API to talk to');
  }
  if (origin === undefined || origin === '') {
    throw new Error('PRSYSTEM_PORTAL_ORIGIN is required: it decides whether the cookie is Secure');
  }
  const runtime = { portal, apiUrl, origin };
  RUNTIME_CACHE.set(portal, runtime);
  return runtime;
}

export function cookieName(portal: string): string {
  return `prsystem_${portal}_session`;
}

export function apiFor(runtime: PortalRuntime): ApiClient {
  return new ApiClient({ baseUrl: runtime.apiUrl });
}

export async function readToken(runtime: PortalRuntime): Promise<string | undefined> {
  const jar = await cookies();
  const value = jar.get(cookieName(runtime.portal))?.value;
  return value === undefined || value === '' ? undefined : value;
}

export async function writeToken(
  runtime: PortalRuntime,
  token: string,
  maxAgeSeconds: number,
): Promise<void> {
  const jar = await cookies();
  jar.set({
    name: cookieName(runtime.portal),
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    secure: runtime.origin.startsWith('https://'),
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

export async function clearToken(runtime: PortalRuntime): Promise<void> {
  const jar = await cookies();
  jar.set({
    name: cookieName(runtime.portal),
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: runtime.origin.startsWith('https://'),
    path: '/',
    maxAge: 0,
  });
}

/** The token, or a redirect to the sign-in page carrying where to come back to. */
export async function requireToken(
  runtime: PortalRuntime,
  signInPath = '/sign-in',
  next?: string,
): Promise<string> {
  const token = await readToken(runtime);
  if (token === undefined) {
    redirect(next === undefined ? signInPath : `${signInPath}?next=${encodeURIComponent(next)}`);
  }
  return token;
}
