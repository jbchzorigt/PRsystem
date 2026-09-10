import { expect, test } from '@playwright/test';
import { portalUrl } from '../portals';
import {
  checkIn,
  consoleCall,
  hotelToken,
  lane,
  openShift,
  registerCanaries,
  seed,
  waitFor,
} from '../support';

/**
 * Journey: an active wanted case, then a check-in → the worker's matcher
 * sweep raises the match and its alert → the Police acknowledge and confirm
 * Found. The alert latency from `check_in_recorded_at` to the alert row is
 * measured against the 10-second provisional target (doc 13 §8.3, 15 §2.1).
 */
test.describe.configure({ mode: 'serial' });

const base = portalUrl('web-police');

test('a check-in against an active case is matched by the worker, alerted, acknowledged and found', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const s = await seed(request);
  const index = lane(testInfo);
  const citizen = s.citizens.wantedSweep[index]!;

  await page.goto(`${base}/sign-in`);
  await page.locator('[name=email]').fill(s.police.admin.email);
  await page.locator('[name=password]').fill(s.police.admin.password);
  await page.getByRole('button', { name: 'Нэвтрэх' }).click();
  await page.waitForURL(`${base}/`);

  await page.goto(`${base}/wanted/new`);
  await page.locator('[name=registrationNumber]').fill(citizen.registrationNumber);
  await page
    .locator('[name=reasonText]')
    .fill(`E2E ${testInfo.project.name}: matcher journey — эрэн сурвалжлах үндэслэл`);
  await page.locator('[name=crimeCategory]').fill('Залилан');
  await page.locator('[name=owningUnitRef]').fill('UNIT-E2E');
  await page.getByRole('button', { name: 'Хадгалах' }).click();
  await page.waitForURL(/\/cases\/[0-9a-f-]+\?/u);
  await page.locator('[name=state]').selectOption('PENDING_APPROVAL');
  await page.locator('[name=reason]').fill('Батлуулахаар илгээв');
  await page.getByRole('button', { name: 'Төлөв өөрчлөх' }).click();
  await page.waitForURL(/ok=moved/u);
  await page.locator('[name=state]').selectOption('ACTIVE');
  await page.locator('[name=reason]').fill('Идэвхжүүлэв');
  await page.getByRole('button', { name: 'Төлөв өөрчлөх' }).click();
  await page.waitForURL(/state=ACTIVE/u);

  // The check-in comes after the activation: only the sweep can match it.
  const reception = await hotelToken(request, s.hotel.reception);
  await openShift(request, reception, s.hotel.hotelId);
  const stayId = await checkIn(
    request,
    reception,
    s.hotel.hotelId,
    s.hotel.rooms[9 + index]!,
    citizen,
  );
  const match = await waitFor(
    async () => {
      const answer = await consoleCall<{
        matchId: string;
        latencyMs: number | null;
        detectLatencyMs: number;
      }>(request, `/db/match?stayId=${stayId}`);
      return answer.status === 200 && answer.body.latencyMs !== null ? answer.body : undefined;
    },
    60_000,
    1000,
  );
  testInfo.annotations.push({
    type: 'police-alert-latency-ms',
    description: String(match.latencyMs),
  });
  // The measurement, kept for the Phase 22 record (docs/architecture/15 §2.1).
  const { mkdirSync, appendFileSync } = await import('node:fs');
  mkdirSync('test-results', { recursive: true });
  appendFileSync(
    'test-results/police-alert-latency.jsonl',
    `${JSON.stringify({ project: testInfo.project.name, stayId, latencyMs: match.latencyMs, detectLatencyMs: match.detectLatencyMs, sweepMs: s.worker.sweepMs, at: new Date().toISOString() })}\n`,
  );
  // The provisional target is 10 s at p95; a two-second sweep on a local box is well inside it.
  expect(match.latencyMs).toBeLessThan(10_000);

  await page.goto(`${base}/matches`);
  await page.locator('[name=registrationNumber]').fill(citizen.registrationNumber);
  await page.getByRole('button', { name: 'Match нээх' }).click();
  await page.waitForURL(/\/matches\/[0-9a-f-]+$/u);
  await page.getByRole('button', { name: 'Хүлээн авсан' }).click();
  await page.waitForURL(/ok=acknowledged/u);
  await page.getByRole('radio', { name: 'Match гарсан буудалд' }).check();
  await page.getByRole('button', { name: 'Олдсон', exact: true }).click();
  await page.waitForURL(/ok=found/u);
  await expect(page.locator('dl.kv').getByText('Олдсон', { exact: true })).toBeVisible();
  await registerCanaries(request, [reception]);
});
