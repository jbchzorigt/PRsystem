import { defineConfig, devices } from '@playwright/test';
import { API_PORT, API_URL, CONSOLE_PORT, CONSOLE_URL, PORTALS } from './e2e/portals';

/**
 * Playwright harness — Phase 21.
 *
 * One real API on a scratch database (`e2e/api-server.mjs`) and the five
 * portals as production builds (`next start`), driven at three viewports:
 * a phone, a tablet and a desktop, all Chromium. `pnpm run test:e2e` builds
 * the API and the portals first. Traces and screenshots stay off: a page can
 * carry a synthetic identity, and the default is a deliberate choice.
 */
export default defineConfig({
  testDir: './e2e',
  // Files run in parallel across workers; tests inside a file run in order,
  // because a flow's later steps build on its earlier ones.
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  reporter: process.env['CI'] === undefined ? [['line']] : [['github'], ['line']],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    trace: 'off',
    screenshot: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
    { name: 'tablet', use: { ...devices['Galaxy Tab S4'] } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'node e2e/api-server.mjs',
      url: `${CONSOLE_URL}/seed`,
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        E2E_API_PORT: String(API_PORT),
        E2E_CONSOLE_PORT: String(CONSOLE_PORT),
        ...(process.env['DATABASE_URL'] === undefined
          ? {}
          : { DATABASE_URL: process.env['DATABASE_URL'] }),
      },
    },
    ...PORTALS.map((portal) => ({
      command: `pnpm --filter @prsystem/${portal.app} run start --port ${String(portal.port)}`,
      port: portal.port,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NODE_ENV: 'production',
        PRSYSTEM_API_URL: API_URL,
        PRSYSTEM_PORTAL_ORIGIN: `http://127.0.0.1:${String(portal.port)}`,
      },
    })),
  ],
});
