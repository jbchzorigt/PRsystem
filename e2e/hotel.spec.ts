import { expect, test } from '@playwright/test';
import { portalUrl } from './portals';
import { hotelToken, lane, openShift, seed } from './support';

/**
 * doc 02: the Reception signs in, sees the room board, checks a walk-in guest
 * in from the quote, and the board shows the room occupied. Every rule the
 * flow exercises — the quote, the identity, the state — is the API's; the
 * portal only carries the form and renders the answer (CLAUDE.md §3).
 */
test.describe.configure({ mode: 'serial' });

const base = portalUrl('web-hotel');

test('reception signs in and lands on the room board', async ({ page, request }) => {
  const s = await seed(request);
  await page.goto(`${base}/sign-in`);
  await expect(page.getByText('Realm: Hotel')).toBeVisible();
  await page.locator('[name=email]').fill(s.hotel.reception.email);
  await page.locator('[name=password]').fill(s.hotel.reception.password);
  await page.getByRole('button', { name: 'Нэвтрэх' }).click();
  await page.waitForURL(`**/hotels/${s.hotel.hotelId}/**`);
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('nav.shell-nav')).toBeVisible();
});

test('a walk-in guest is quoted and checked in, and the board shows the room occupied', async ({
  page,
  request,
}, testInfo) => {
  const s = await seed(request);
  const roomId = s.hotel.rooms[lane(testInfo)]!;
  const citizen = s.citizens.ordinary[lane(testInfo)]!;
  await openShift(request, await hotelToken(request, s.hotel.reception), s.hotel.hotelId);
  await page.goto(`${base}/sign-in`);
  await page.locator('[name=email]').fill(s.hotel.reception.email);
  await page.locator('[name=password]').fill(s.hotel.reception.password);
  await page.getByRole('button', { name: 'Нэвтрэх' }).click();
  await page.waitForURL(`**/hotels/${s.hotel.hotelId}/**`);

  await page.goto(`${base}/hotels/${s.hotel.hotelId}/check-in?roomId=${roomId}`);
  await page.locator('[name=stayType]').selectOption('NIGHTLY');
  await page.locator('[name=nightCount]').fill('1');
  await page.getByRole('button', { name: 'Үнийн санал авах' }).click();
  await expect(page.getByRole('heading', { name: 'Үнийн санал' })).toBeVisible();

  await page.locator('[name=source]').selectOption('WALK_IN');
  await page.locator('[name=identityType]').selectOption('MN_REG_NO');
  await page.locator('[name=familyName]').fill(citizen.familyName);
  await page.locator('[name=givenName]').fill(citizen.givenName);
  await page.locator('[name=dateOfBirth]').fill(citizen.dateOfBirth);
  await page.locator('[name=nationality]').fill('MN');
  await page.locator('[name=registrationNumber]').fill(citizen.registrationNumber);
  await page.getByRole('button', { name: 'Check-in хийх' }).click();
  await page.waitForURL(/\/stays\/[0-9a-f-]+\?ok=checked-in/u);
  await expect(page.locator('.banner-ok')).toBeVisible();
  await expect(page.getByText(citizen.givenName).first()).toBeVisible();

  // doc 06 §3: the board shows the room's occupancy and times, never the guest's identity.
  const stayUrl = page.url();
  await page.goto(`${base}/hotels/${s.hotel.hotelId}/rooms`);
  await expect(page.locator('h1')).toBeVisible();
  const card = page
    .locator('li.card')
    .filter({ has: page.locator(`a[href*="${stayUrl.split('?')[0]!.split('/hotels/')[1]!}"]`) });
  await expect(card).toHaveCount(1);
  await expect(card.getByText('Check-in хийсэн', { exact: true })).toBeVisible();
  await expect(page.getByText(citizen.registrationNumber)).toHaveCount(0);
});

test('the cleaner sees the cleaner dashboard and nothing of billing', async ({ page, request }) => {
  const s = await seed(request);
  await page.goto(`${base}/sign-in`);
  await page.locator('[name=email]').fill(s.hotel.cleaner.email);
  await page.locator('[name=password]').fill(s.hotel.cleaner.password);
  await page.getByRole('button', { name: 'Нэвтрэх' }).click();
  await page.waitForURL(`**/hotels/${s.hotel.hotelId}/cleaner`);
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('nav.shell-nav').getByText('Төлбөр тооцоо')).toHaveCount(0);
  // Reached by URL, the finance dashboard is what the API answers for a Cleaner:
  // not found. Hiding the tab was never the authorization (CLAUDE.md §4).
  const response = await page.goto(`${base}/hotels/${s.hotel.hotelId}/finance`);
  expect(response?.status()).toBe(404);
});
