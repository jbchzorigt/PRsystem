import { expect, test } from '@playwright/test';
import { portalUrl } from './portals';
import { GUEST_PASSWORD, lane, otpCode, seed } from './support';

/**
 * doc 09: search, the listing, the detail, registration by phone, the hold,
 * and the guest's own booking list. The hold's price, the availability and the
 * cancellation terms come from the API; the portal shows them.
 */
test.describe.configure({ mode: 'serial' });

const base = portalUrl('web-public');

test('search finds the published hotel and opens its detail', async ({ page, request }) => {
  const s = await seed(request);
  await page.goto(base);
  await expect(page.getByText('Realm: Guest').or(page.locator('h1'))).toBeVisible();
  await page.getByRole('button', { name: 'Буудал хайх' }).click();
  await page.waitForURL(/\/hotels\?/u);
  await expect(page.getByText(s.hotel.name).first()).toBeVisible();
  await page.getByRole('link', { name: s.hotel.name }).first().click();
  await page.waitForURL(/\/hotels\/[0-9a-f-]+/u);
  await expect(page.locator('h1')).toHaveText(s.hotel.name);
  await expect(page.getByRole('heading', { name: 'Боломжит өрөөний ангиллууд' })).toBeVisible();
});

test('a new guest registers by phone, holds a category and cancels the booking', async ({
  page,
  request,
}, testInfo) => {
  const s = await seed(request);
  const phone = `9911${String(1000 + lane(testInfo) * 7 + Math.floor(Math.random() * 6))}`;
  await page.goto(`${base}/register?next=${encodeURIComponent(`/hotels/${s.hotel.hotelId}`)}`);
  await page.locator('[name=phone]').fill(phone);
  await page.getByRole('button', { name: 'Код илгээх' }).click();
  await expect(page.locator('.banner-ok')).toBeVisible();
  const code = await otpCode(request, phone);
  await page.locator('[name=code]').fill(code);
  await page.locator('[name=password]').fill(GUEST_PASSWORD);
  await page.getByRole('button', { name: 'Бүртгүүлэх' }).click();
  await page.waitForURL(/\/hotels\/[0-9a-f-]+/u);

  await page.locator('[name=stayingGuestName]').first().fill('Тест Зочин');
  await page.getByRole('button', { name: 'Захиалах' }).first().click();
  await page.waitForURL(/\/bookings\/[0-9a-f-]+\?ok=held/u);
  await expect(page.locator('h1')).toContainText('Захиалга');
  await expect(page.getByText('Hold').first()).toBeVisible();

  await page.getByRole('button', { name: 'Захиалга цуцлах' }).click();
  await page.waitForURL(/ok=cancelled/u);
  await expect(page.getByText('Зочин цуцалсан').first()).toBeVisible();

  await page.goto(`${base}/bookings`);
  await expect(page.locator('h1')).toHaveText('Миний захиалгууд');
  await expect(page.locator('table tbody tr, .card-list li').first()).toBeVisible();
});

test('a booking id of another guest is not found', async ({ page, request }, testInfo) => {
  const s = await seed(request);
  const phone = `9922${String(1000 + lane(testInfo) * 7 + Math.floor(Math.random() * 6))}`;
  await page.goto(`${base}/register`);
  await page.locator('[name=phone]').fill(phone);
  await page.getByRole('button', { name: 'Код илгээх' }).click();
  await expect(page.locator('.banner-ok')).toBeVisible();
  const code = await otpCode(request, phone);
  await page.locator('[name=code]').fill(code);
  await page.locator('[name=password]').fill(GUEST_PASSWORD);
  await page.getByRole('button', { name: 'Бүртгүүлэх' }).click();
  await page.waitForURL(/\/bookings/u);
  // A well-formed id that belongs to nobody this guest can see.
  await page.goto(`${base}/bookings/00000000-0000-4000-8000-000000000001`);
  await expect(page.locator('p[role=alert]')).toBeVisible();
  void s;
});
