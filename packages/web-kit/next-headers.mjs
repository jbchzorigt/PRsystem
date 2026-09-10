/**
 * The response headers every portal sends (Phase 22; docs/architecture/14
 * §GATE-SEC "security-header and CSP verification"; threat model T-X-04).
 *
 * Imported by each portal's `next.config.mjs`, so the five deployments cannot
 * drift apart. The content security policy allows the portal's own origin and
 * nothing else: Next.js renders its hydration and server-action bootstrap as
 * inline script, so `script-src` carries `'unsafe-inline'` until a nonce is
 * threaded through a middleware — recorded as an open item (`A-P22-9`), not a
 * decision. Forms post to the portal itself; the one navigation a form causes
 * to a third party is a provider's HTTPS pay page after the API issued its
 * invoice, so `form-action` admits `https:`. `Strict-Transport-Security` is
 * the TLS edge's to set.
 */
export const PORTAL_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https:",
  "object-src 'none'",
].join('; ');

export const PORTAL_SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Content-Security-Policy', value: PORTAL_CONTENT_SECURITY_POLICY },
];

/** The `headers` entry of a portal's Next.js configuration. */
export async function portalSecurityHeaders() {
  return [{ source: '/:path*', headers: PORTAL_SECURITY_HEADERS }];
}
