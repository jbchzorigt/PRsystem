import { defineConfig, devices } from '@playwright/test';
import { PORTAL_SHELLS } from './e2e/portals';

/**
 * Playwright harness.
 *
 * Phase 02 scope is the harness plus portal-shell smoke tests: each portal must
 * start and render its own identity. There is no business workflow to exercise
 * yet — full workflow E2E belongs to Phases 21-22.
 *
 * Every portal is served by `next start`, so the run exercises production
 * builds. `pnpm run test:e2e` builds them first.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] === undefined ? 0 : 1,
  reporter: process.env['CI'] === undefined ? [['line']] : [['github'], ['line']],
  use: {
    trace: 'off',
    // Traces and screenshots can capture page content; nothing sensitive exists
    // in a shell, but the default stays off so it is a deliberate choice later.
    screenshot: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: PORTAL_SHELLS.map((portal) => ({
    command: `pnpm --filter @prsystem/${portal.app} run start --port ${String(portal.port)}`,
    port: portal.port,
    reuseExistingServer: process.env['CI'] === undefined,
    timeout: 120_000,
  })),
});
