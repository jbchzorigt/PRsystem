import { expect, test } from '@playwright/test';
import { consoleCall } from './support';

/**
 * The secret-leakage scan over this run's own artefacts (build-plan §Phase 22,
 * CLAUDE.md §8): after every flow and journey at every viewport, the API's
 * log, every row of every durable table (platform, police, both audit streams)
 * including what hides inside bytea, and the run's Redis keys are searched
 * for every secret the run knew — seeded and chosen passwords, one-time codes,
 * authenticator codes, activation and invitation tokens, session tokens,
 * registration numbers, access codes, QR tokens. Zero findings is the gate.
 */
test('no secret the run knew reached the log, a durable record or the queue', async ({
  request,
}, testInfo) => {
  const scan = await consoleCall<{
    findings: readonly { source: string; location: string; canary: string }[];
    scanned: { tables: number; rows: number; logBytes: number; redisKeys: number };
    canaries: number;
  }>(request, '/leakage');
  expect(scan.status).toBe(200);
  testInfo.annotations.push({
    type: 'leakage-scan',
    description: JSON.stringify({ ...scan.body.scanned, canaries: scan.body.canaries }),
  });
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync('test-results', { recursive: true });
  writeFileSync(
    'test-results/leakage-scan.json',
    `${JSON.stringify({ ...scan.body, at: new Date().toISOString() }, null, 2)}\n`,
  );
  expect(scan.body.canaries).toBeGreaterThan(20);
  expect(scan.body.scanned.tables).toBeGreaterThan(150);
  expect(scan.body.scanned.rows).toBeGreaterThan(1000);
  expect(scan.body.scanned.logBytes).toBeGreaterThan(10_000);
  expect(scan.body.findings).toEqual([]);
});
