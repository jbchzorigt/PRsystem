import { expect, test } from '@playwright/test';
import { portalUrl } from './portals';
import { api, checkIn, hotelToken, lane, openShift, seed } from './support';

/**
 * doc 08: the restaurant and its menu were set up over the API by Manager
 * Plus and the Restaurant Manager (see e2e/api-server.mjs); the Reception
 * checks a guest in and issues the room's QR and the stay's access code, and
 * the guest orders from the portal. The session is the
 * `x-restaurant-session` the API issued, kept server-side in the portal.
 */
test.describe.configure({ mode: 'serial' });

const base = portalUrl('web-restaurant');

test('a checked-in guest enters with the QR and the code, and places an order', async ({
  page,
  request,
}, testInfo) => {
  const s = await seed(request);
  const hotelId = s.restaurantHotel.hotelId;
  const roomId = s.restaurantHotel.rooms[lane(testInfo)]!;
  const reception = await hotelToken(request, s.restaurantHotel.reception);
  const manager = await hotelToken(request, s.restaurantHotel.manager);
  await openShift(request, reception, hotelId);

  const stayId = await checkIn(
    request,
    reception,
    hotelId,
    roomId,
    s.citizens.ordinary[lane(testInfo)]!,
  );
  // The room's QR is a room-management command (doc 08 §7): the Manager issues it.
  const qr = await api<{ token: string }>(
    request,
    'POST',
    `/hotels/${hotelId}/rooms/${roomId}/qr-token`,
    { token: manager, body: {} },
  );
  expect(qr.status, JSON.stringify(qr.body)).toBe(201);
  const access = await api<{ code: string }>(
    request,
    'POST',
    `/hotels/${hotelId}/stays/${stayId}/guest-access-codes`,
    { token: reception, body: {} },
  );
  expect(access.status, JSON.stringify(access.body)).toBe(201);

  await page.goto(`${base}/?token=${encodeURIComponent(qr.body.token)}`);
  await expect(page.locator('header .brand small')).toHaveText('Restaurant');
  await page.locator('[name=code]').fill(access.body.code);
  await page.getByRole('button', { name: 'Нэвтрэх' }).click();
  await page.waitForURL(/\/menu/u);
  await expect(page.getByText('Цуйван').first()).toBeVisible();
  await page.locator('input[name^="qty:"]').first().fill('1');
  await page.getByRole('button', { name: 'Захиалах' }).first().click();
  await page.waitForURL(/\/orders\/[0-9a-f-]+\?ok=placed/u);
  await expect(page.locator('.banner-ok')).toBeVisible();
  await expect(page.locator('dl.kv')).toBeVisible();
  await page.goto(`${base}/orders`);
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('table tbody tr').first()).toBeVisible();
});

test('a wrong access code is refused', async ({ page }) => {
  await page.goto(base);
  await page.locator('[name=roomToken]').fill('not-a-room-token');
  await page.locator('[name=code]').fill('000000');
  await page.getByRole('button', { name: 'Нэвтрэх' }).click();
  await expect(page.locator('.banner-danger, p[role=alert]').first()).toBeVisible();
});
