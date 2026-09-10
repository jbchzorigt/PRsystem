import { expect, test } from '@playwright/test';
import { API_URL, PORTALS } from './portals';

/**
 * Security-header and content-security-policy verification (docs/architecture/14
 * §GATE-SEC, Phase 22): every portal page and every API answer carries the
 * baseline, and the policies forbid framing and foreign origins.
 */
for (const portal of PORTALS) {
  test(`${portal.app} sends the portal security headers`, async ({ request }) => {
    const response = await request.get(`http://127.0.0.1:${String(portal.port)}${portal.entry}`);
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['content-security-policy']).toContain("default-src 'self'");
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['content-security-policy']).toContain("object-src 'none'");
  });
}

test('the API sends the strict headers on every answer', async ({ request }) => {
  const live = await request.get(`${API_URL}/health/live`);
  expect(live.status()).toBe(200);
  expect(live.headers()['x-content-type-options']).toBe('nosniff');
  expect(live.headers()['cache-control']).toBe('no-store');
  expect(live.headers()['content-security-policy']).toContain("default-src 'none'");
  const refused = await request.get(`${API_URL}/api/v1/hotels`);
  expect([401, 404]).toContain(refused.status());
  expect(refused.headers()['x-frame-options']).toBe('DENY');
});
