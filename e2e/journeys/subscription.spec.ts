import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { portalUrl } from '../portals';
import { lane, payThroughProvider, registerCanaries, seed } from '../support';

/**
 * Journey: subscription expiry → grace → hard lock → renewal (doc 14 §4, doc 17).
 *
 * A live subscription's `expires_at` never moves backwards — the database
 * refuses it — so each state is a hotel seeded into it, and every state the
 * Hotel Admin sees is the API's own answer: the expiring-soon banner, the
 * grace banner, the lock screen with renewal still reachable, and the portal
 * restored once the provider's callback lands.
 */
test.describe.configure({ mode: 'serial' });

const base = portalUrl('web-hotel');

async function signIn(page: Page, admin: { email: string; password: string }, hotelId: string) {
  await page.goto(`${base}/sign-in`);
  await page.locator('[name=email]').fill(admin.email);
  await page.locator('[name=password]').fill(admin.password);
  await page.getByRole('button', { name: 'Нэвтрэх' }).click();
  await page.waitForURL(`**/hotels/${hotelId}/**`);
}

async function signOut(page: Page) {
  await page
    .getByRole('button', { name: 'Гарах' })
    .first()
    .click()
    .catch(() => undefined);
}

test('the portal warns while expiring, warns harder in grace, locks when expired, and the paid renewal restores it', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const s = await seed(request);
  const lanes = s.subscriptionHotels[lane(testInfo)]!;
  await registerCanaries(request, [lanes.expiring.admin.password]);

  // Expiring soon: the warning banner, everything still reachable.
  await signIn(page, lanes.expiring.admin, lanes.expiring.hotelId);
  await page.goto(`${base}/hotels/${lanes.expiring.hotelId}/subscription`);
  await expect(page.locator('.banner-warn').first()).toContainText('Удахгүй дуусна');
  await expect(page.locator('.lock-screen')).toHaveCount(0);
  await signOut(page);

  // Grace: the grace banner, still reachable.
  await signIn(page, lanes.grace.admin, lanes.grace.hotelId);
  await page.goto(`${base}/hotels/${lanes.grace.hotelId}/subscription`);
  await expect(page.locator('.banner-warn').first()).toContainText('Grace');
  await expect(page.locator('.lock-screen')).toHaveCount(0);
  await signOut(page);

  // Expired: the lock screen everywhere but the subscription page, where renewal survives.
  const hotel = lanes.expired;
  await signIn(page, hotel.admin, hotel.hotelId);
  await page.goto(`${base}/hotels/${hotel.hotelId}/rooms`);
  await expect(page.locator('.lock-screen')).toBeVisible();
  await expect(page.locator('nav.shell-nav').getByText('Өрөөнүүд')).toHaveCount(0);
  const home = `${base}/hotels/${hotel.hotelId}/subscription`;
  await page.goto(home);
  await page.locator('[name=targetPackage]').selectOption('P25');
  await page.locator('[name=termMonths]').selectOption('1');
  await page.locator('[name=provider]').selectOption('QPAY');
  await page.getByRole('button', { name: 'Сунгах' }).click();
  await page.waitForURL(/ok=renewal/u);
  const paid = await payThroughProvider(request, 'subscription', { hotelId: hotel.hotelId });
  expect(paid.status, JSON.stringify(paid.body)).toBeLessThan(300);

  await page.goto(`${base}/hotels/${hotel.hotelId}/rooms`);
  await expect(page.locator('.lock-screen')).toHaveCount(0);
  await expect(page.locator('.banner-warn')).toHaveCount(0);
  await expect(page.locator('h1')).toBeVisible();
});
