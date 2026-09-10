import { expect, test } from '@playwright/test';
import { portalUrl } from '../portals';
import {
  GUEST_PASSWORD,
  api,
  consoleCall,
  hotelToken,
  inspectNoUsage,
  lane,
  openShift,
  payThroughProvider,
  registerCanaries,
  registerGuest,
  seed,
} from '../support';

/**
 * Journey: search → book → pay → check-in → minibar → checkout → review → settlement.
 *
 * The guest holds a category in the portal; the provider pays and calls back
 * the API's own route; the Reception checks the guest in against the booking;
 * the Cleaner states no minibar usage; the Reception locks and reconciles the
 * report, posts the charges, takes cash, settles the bill and records the
 * checkout — all in the Hotel portal; the guest reviews the completed stay;
 * and the settlement module holds the hotel's payable for the paid booking.
 */
test.describe.configure({ mode: 'serial' });

const guestBase = portalUrl('web-public');
const hotelBase = portalUrl('web-hotel');

test('a paid booking is fulfilled, checked out through the portal, reviewed, and settled', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const s = await seed(request);
  const index = lane(testInfo);
  const phone = `9933${String(1000 + index * 7 + Math.floor(Math.random() * 6))}`;
  const citizen = s.citizens.ordinary[3 + index]!;
  const roomId = s.hotel.rooms[6 + index]!;
  await registerGuest(request, phone, GUEST_PASSWORD);
  await registerCanaries(request, [GUEST_PASSWORD]);

  // --- the guest holds a category
  await page.goto(`${guestBase}/sign-in?next=${encodeURIComponent(`/hotels/${s.hotel.hotelId}`)}`);
  await page.locator('[name=phone]').fill(phone);
  await page.locator('[name=password]').fill(GUEST_PASSWORD);
  await page.getByRole('button', { name: 'Нэвтрэх' }).click();
  await page.waitForURL(/\/hotels\/[0-9a-f-]+/u);
  await page
    .locator('[name=stayingGuestName]')
    .first()
    .fill(`${citizen.familyName} ${citizen.givenName}`);
  await page.getByRole('button', { name: 'Захиалах' }).first().click();
  await page.waitForURL(/\/bookings\/[0-9a-f-]+\?ok=held/u);
  const bookingId = /\/bookings\/([0-9a-f-]+)/u.exec(page.url())![1]!;

  // --- the guest asks for the provider's invoice (the pay page is the provider's, not a page
  // this harness serves), then the provider pays and calls back
  const guest = await api<{ token: string }>(request, 'POST', '/guest/sessions', {
    body: { phone, password: GUEST_PASSWORD },
  });
  expect(guest.status, JSON.stringify(guest.body)).toBeLessThan(300);
  const attempt = await api<{ attemptId: string }>(
    request,
    'POST',
    `/guest/bookings/${bookingId}/payment-attempts`,
    { token: guest.body.token, body: { provider: 'QPAY' } },
  );
  expect(attempt.status, JSON.stringify(attempt.body)).toBeLessThan(300);
  const invoice = await api(
    request,
    'POST',
    `/guest/bookings/${bookingId}/payment-attempts/${attempt.body.attemptId}/invoice`,
    { token: guest.body.token, body: {} },
  );
  expect(invoice.status, JSON.stringify(invoice.body)).toBeLessThan(300);
  await registerCanaries(request, [guest.body.token]);
  const paid = await payThroughProvider(request, 'booking', { bookingId });
  expect(paid.status, JSON.stringify(paid.body)).toBeLessThan(300);
  await page.reload();
  await expect(page.locator('dl.kv').getByText('Баталгаажсан', { exact: true })).toBeVisible();

  // --- the Reception fulfils the booking at the desk, in the Hotel portal
  const booking = await api<{ bookingRef: string }>(
    request,
    'GET',
    `/guest/bookings/${bookingId}`,
    { token: guest.body.token },
  );
  const reception = await hotelToken(request, s.hotel.reception);
  const cleaner = await hotelToken(request, s.hotel.cleaner);
  await openShift(request, reception, s.hotel.hotelId);
  const hotelPage = await page.context().newPage();
  await hotelPage.goto(`${hotelBase}/sign-in`);
  await hotelPage.locator('[name=email]').fill(s.hotel.reception.email);
  await hotelPage.locator('[name=password]').fill(s.hotel.reception.password);
  await hotelPage.getByRole('button', { name: 'Нэвтрэх' }).click();
  await hotelPage.waitForURL(`**/hotels/${s.hotel.hotelId}/**`);
  await hotelPage.goto(`${hotelBase}/hotels/${s.hotel.hotelId}/check-in?roomId=${roomId}`);
  await hotelPage.locator('[name=stayType]').selectOption('NIGHTLY');
  await hotelPage.locator('[name=nightCount]').fill('1');
  await hotelPage.getByRole('button', { name: 'Үнийн санал авах' }).click();
  await expect(hotelPage.getByRole('heading', { name: 'Үнийн санал' })).toBeVisible();
  await hotelPage.locator('[name=source]').selectOption('ONLINE');
  await hotelPage.locator('[name=bookingRef]').fill(booking.body.bookingRef);
  await hotelPage.locator('[name=identityType]').selectOption('MN_REG_NO');
  await hotelPage.locator('[name=familyName]').fill(citizen.familyName);
  await hotelPage.locator('[name=givenName]').fill(citizen.givenName);
  await hotelPage.locator('[name=dateOfBirth]').fill(citizen.dateOfBirth);
  await hotelPage.locator('[name=nationality]').fill('MN');
  await hotelPage.locator('[name=registrationNumber]').fill(citizen.registrationNumber);
  await hotelPage.getByRole('button', { name: 'Check-in хийх' }).click();
  await hotelPage.waitForURL(/\/stays\/[0-9a-f-]+\?ok=checked-in/u);
  const stayId = /\/stays\/([0-9a-f-]+)/u.exec(hotelPage.url())![1]!;

  // --- the checkout, in the Hotel portal
  const stayUrl = `${hotelBase}/hotels/${s.hotel.hotelId}/stays/${stayId}`;
  await hotelPage.goto(stayUrl);
  await hotelPage.getByRole('button', { name: 'Check-out эхлүүлэх' }).click();
  await hotelPage.waitForURL(/ok=checkout-started/u);

  // The Cleaner inspects the stocked minibar: nothing was used. Then the
  // Reception locks the report for its (empty) payment attempt and reconciles it.
  const stay = await api<{ minibarApplicable: boolean }>(
    request,
    'GET',
    `/hotels/${s.hotel.hotelId}/stays/${stayId}`,
    { token: reception },
  );
  expect(stay.body.minibarApplicable, 'the booking-journey room carries a minibar').toBe(true);
  await inspectNoUsage(request, cleaner, s.hotel.hotelId, roomId);
  await hotelPage.goto(stayUrl);
  await hotelPage.getByRole('button', { name: 'Минибарын тайланг төлбөрт түгжих' }).click();
  await hotelPage.waitForURL(/ok=report-locked/u);
  await hotelPage.getByRole('button', { name: 'Тулгах' }).click();
  await hotelPage.waitForURL(/ok=report-reconciled/u);

  // The bill: charges posted, paid in cash, settled.
  await hotelPage.getByRole('button', { name: 'Төлбөр бичих' }).click();
  await hotelPage.waitForURL(/ok=charged/u);
  const folio = await api<{ balanceMnt: string; revision: number }>(
    request,
    'GET',
    `/hotels/${s.hotel.hotelId}/stays/${stayId}/folio`,
    { token: reception },
  );
  expect(folio.status).toBe(200);
  if (Number(folio.body.balanceMnt) > 0) {
    await hotelPage.locator('[name=channel]').selectOption('CASH');
    await hotelPage.locator('[name=amountMnt]').fill(folio.body.balanceMnt);
    await hotelPage.getByRole('button', { name: 'Төлбөр бүртгэх' }).click();
    await hotelPage.waitForURL(/ok=paid/u);
  }
  await hotelPage.getByRole('button', { name: 'Тооцоо хаах' }).click();
  await hotelPage.waitForURL(/ok=settled/u);
  await hotelPage.getByRole('button', { name: 'Check-out дуусгах' }).click();
  await hotelPage.waitForURL(/ok=checked-out/u);
  await expect(hotelPage.getByText('COMPLETED', { exact: true }).first()).toBeVisible();
  await hotelPage.close();

  // --- the guest reviews the completed stay
  await page.goto(`${guestBase}/bookings/${bookingId}`);
  await expect(page.locator('dl.kv').getByText('Дууссан', { exact: true })).toBeVisible();
  await page.locator('[name=rating]').selectOption('5');
  await page
    .locator('[name=comment]')
    .fill(`E2E ${testInfo.project.name}: цэвэрхэн, тухтай байрлалаа.`);
  await page.getByRole('button', { name: 'Илгээх' }).click();
  await page.waitForURL(/ok=reviewed/u);

  // --- settlement holds the hotel's payable for the paid booking
  const payable = await consoleCall<{
    payables: readonly {
      gross_paid_mnt: string;
      hotel_payable_mnt: string;
      payout_state: string;
    }[];
  }>(request, `/db/payable?bookingId=${bookingId}`);
  expect(payable.body.payables).toHaveLength(1);
  expect(Number(payable.body.payables[0]!.gross_paid_mnt)).toBeGreaterThan(0);
  expect(Number(payable.body.payables[0]!.hotel_payable_mnt)).toBeGreaterThan(0);
  await registerCanaries(request, [reception, cleaner]);
});
