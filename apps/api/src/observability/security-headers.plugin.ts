import type { FastifyInstance } from 'fastify';

/**
 * The response headers every API answer carries (Phase 22; docs/architecture/14
 * §GATE-SEC "security-header and CSP verification", threat model T-X-04).
 *
 * The API serves JSON to portals and callbacks to providers, never a page: a
 * content-security-policy of `default-src 'none'` says so to any browser that
 * renders an answer directly, `nosniff` keeps a JSON body a JSON body, and
 * `no-store` keeps a person's answer out of any shared cache. Transport
 * security (`Strict-Transport-Security`) belongs to the TLS edge in front of
 * the API and is set there, not by a process that listens on plain HTTP.
 */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cross-origin-resource-policy': 'same-site',
};

/** The API's own paths get the strict policy; the OpenAPI UI, when served, needs its own. */
export const API_CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', (request, reply, payload, done) => {
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) reply.header(name, value);
    if (request.url.startsWith('/api/') || request.url.startsWith('/health')) {
      reply.header('content-security-policy', API_CONTENT_SECURITY_POLICY);
    }
    done(null, payload);
  });
}
