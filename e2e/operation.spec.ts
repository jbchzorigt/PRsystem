import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { portalUrl } from './portals';
import { lane, seed, totpCode } from './support';

/**
 * doc 14: password plus authenticator, the KPI cards, the server-filtered
 * subscription list, a suspension with its mandatory note, a password-reset
 * initiation that shows only queued-or-not, and the SMS preview → confirm →
 * history flow. Every count and every state is the API's.
 */
test.describe.configure({ mode: 'serial' });

const base = portalUrl('web-operation');

async function signIn(
  page: Page,
  request: APIRequestContext,
  credential: { email: string; password: string },
) {
  await page.goto(`${base}/sign-in`);
  await expect(page.getByText('Realm: Operation/Platform')).toBeVisible();
  await page.locator('[name=email]').fill(credential.email);
  await page.locator('[name=password]').fill(credential.password);
  await page.locator('[name=code]').fill(await totpCode(request, credential.email));
  await page.getByRole('button', { name: 'Нэвтрэх' }).click();
  await page.waitForURL(`${base}/`);
}

test('the admin sees the KPI cards and filters the subscription list on the server', async ({
  page,
  request,
}, testInfo) => {
  const s = await seed(request);
  const hotel = s.operation.hotels[lane(testInfo)]!;
  await signIn(page, request, s.operation.admins[lane(testInfo)]!);
  await expect(page.locator('h1')).toHaveText('Canonical KPI');
  await expect(page.locator('.kpi')).toHaveCount(13);

  await page.getByRole('link', { name: /Нийт буудал/u }).click();
  await page.waitForURL(/\/subscriptions/u);
  await page.locator('[name=name]').fill(hotel.name);
  await page.getByRole('button', { name: 'Хайх' }).click();
  await page.waitForURL(/name=/u);
  await expect(page.getByText(hotel.name).first()).toBeVisible();
  await expect(page.getByText('Нийт 1')).toBeVisible();

  await page.getByRole('button', { name: 'Password reset' }).first().click();
  await page.waitForURL(/ok=reset/u);
  await expect(page.locator('.banner-ok')).toBeVisible();
});

test('the super admin suspends a hotel with a reason and a note', async ({
  page,
  request,
}, testInfo) => {
  const s = await seed(request);
  const hotel = s.operation.hotels[lane(testInfo)]!;
  await signIn(page, request, s.operation.superAdmins[lane(testInfo)]!);
  await page.goto(`${base}/subscriptions/${hotel.hotelId}?name=${encodeURIComponent(hotel.name)}`);
  await expect(page.locator('h1')).toContainText(hotel.name);
  await page.getByRole('radio', { name: 'Түдгэлзүүлэх' }).check();
  await page.locator('[name=reasonCode]').fill('FRAUD_INVESTIGATION');
  await page
    .locator('[name=note]')
    .fill(`E2E ${testInfo.project.name}: шалгалтын явцад түдгэлзүүлэв`);
  await page.getByRole('button', { name: 'Баталгаажуулах' }).click();
  await page.waitForURL(/ok=suspension/u);
  await expect(page.locator('table tbody tr, .card-list li').first()).toBeVisible();
});

test('an SMS is previewed, confirmed once, and appears in the history', async ({
  page,
  request,
}, testInfo) => {
  const s = await seed(request);
  const hotel = s.operation.hotels[lane(testInfo)]!;
  await signIn(page, request, s.operation.admins[lane(testInfo)]!);
  await page.goto(`${base}/sms?hotelIds=${hotel.hotelId}`);
  await page.locator('[name=body]').fill(`Sain baina uu. E2E ${testInfo.project.name} sanuulga.`);
  await page.getByRole('button', { name: 'Preview үзэх' }).click();
  await page.waitForURL(/previewId=/u);
  await expect(page.getByRole('heading', { name: 'Preview' })).toBeVisible();
  await page.getByRole('button', { name: 'Илгээхийг баталгаажуулах' }).click();
  await page.waitForURL(/ok=confirmed/u);
  await expect(page.locator('.banner-ok')).toBeVisible();
  await expect(page.locator('table tbody tr, .card-list li').first()).toBeVisible();
});
