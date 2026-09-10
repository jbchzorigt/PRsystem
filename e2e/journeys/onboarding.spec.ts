import { expect, test } from '@playwright/test';
import { portalUrl } from '../portals';
import {
  api,
  hotelToken,
  inviteAndAccept,
  lane,
  notification,
  payThroughProvider,
  registerCanaries,
  seed,
  waitFor,
} from '../support';

/**
 * Journey: onboarding → activation → configuration → check-in → checkout → shift close.
 *
 * The application, its phone code, its invoice and the provider's callback
 * go through the API's own routes (the portals carry no onboarding screen —
 * `A-P22-4`); the worker's sweeps provision the hotel and deliver the first
 * Hotel Admin's activation; the admin activates, invites a Manager, a
 * Reception and a Cleaner; the Manager configures the stay rules, a category,
 * a room and the deposit; the Cleaner marks the room clean; the Reception
 * opens a shift, checks a walk-in guest in and out through the portal, and
 * closes the shift.
 */
test.describe.configure({ mode: 'serial' });

const hotelBase = portalUrl('web-hotel');
const PASSWORD = ['synthetic', 'onboarding', 'passphrase'].join('-');

test('a hotel is onboarded, activated, configured and runs its first stay and shift', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(300_000);
  const s = await seed(request);
  const index = lane(testInfo);
  const stamp = `${testInfo.project.name}-${String(Date.now()).slice(-6)}`;
  const adminEmail = `admin-${stamp}@onboarding.e2e.test`;
  const contactPhone = `+9769912${String(1000 + index * 3 + Math.floor(Math.random() * 3))}`;

  // --- the application, over the API
  const created = await api<{ applicationId: string; applicantToken: string }>(
    request,
    'POST',
    '/onboarding/applications',
    {
      body: {
        ownerType: 'CITIZEN',
        ownerDisplayName: `Онбоардинг эзэмшигч ${stamp}`,
        registrationNumber: `ЛМ9001010${String(index + 1)}`,
        contactPhone,
        subscriptionContactPhone: contactPhone,
        adminEmail,
        hotelDisplayName: `E2E Onboarding буудал ${stamp}`,
        hotelPublicPhone: '+97611223366',
        district: 'Хан-Уул',
        khoroo: '1-р хороо',
        addressLine: 'Чингисийн өргөн чөлөө 10',
        latitudeMicro: 47900000 + index,
        longitudeMicro: 106900000 + index,
        packageCode: 'P25',
        termMonths: 1,
      },
    },
  );
  expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
  const applicant = { headers: { 'x-onboarding-token': created.body.applicantToken } };
  await registerCanaries(request, [created.body.applicantToken]);

  const sent = await api(request, 'POST', '/onboarding/applications/phone-verification', {
    ...applicant,
    body: {},
  });
  expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
  const code = await waitFor(async () => {
    const answer = await request.get(
      `${(await import('../portals')).CONSOLE_URL}/otp?phone=${encodeURIComponent(contactPhone)}`,
    );
    return answer.ok() ? ((await answer.json()) as { code: string }).code : undefined;
  }, 10_000);
  const confirmed = await api(
    request,
    'POST',
    '/onboarding/applications/phone-verification/confirm',
    { ...applicant, body: { code } },
  );
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBeLessThan(300);
  const owner = await api(request, 'POST', '/onboarding/applications/owner-resolution', {
    ...applicant,
    body: {},
  });
  expect([200, 201, 409]).toContain(owner.status);
  const invoice = await api<{ providerInvoiceId: string }>(
    request,
    'POST',
    '/onboarding/applications/invoice',
    { ...applicant, body: { provider: 'QPAY' } },
  );
  expect(invoice.status, JSON.stringify(invoice.body)).toBeLessThan(300);
  const paid = await payThroughProvider(request, 'onboarding', {
    applicationId: created.body.applicationId,
    providerInvoiceId: invoice.body.providerInvoiceId,
  });
  expect(paid.status, JSON.stringify(paid.body)).toBeLessThan(300);

  // --- the worker provisions and delivers the activation
  await waitFor(
    async () => {
      const state = await api<{ state: string }>(
        request,
        'GET',
        '/onboarding/applications/state',
        applicant,
      );
      return state.body.state === 'PROVISIONED' ? state.body : undefined;
    },
    60_000,
    1000,
  );
  const activation = await notification(
    request,
    { kind: 'staff_invitation', email: adminEmail },
    60_000,
  );
  const hotelId = activation.hotelId;
  const activated = await api(request, 'POST', `/onboarding/hotels/${hotelId}/activation`, {
    body: { token: activation.token, password: PASSWORD },
  });
  expect(activated.status, JSON.stringify(activated.body)).toBeLessThan(300);
  await registerCanaries(request, [PASSWORD, activation.token]);

  // --- the first Hotel Admin signs in to the portal
  await page.goto(`${hotelBase}/sign-in`);
  await page.locator('[name=email]').fill(adminEmail);
  await page.locator('[name=password]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Нэвтрэх' }).click();
  await page.waitForURL(`**/hotels/${hotelId}/**`);
  await expect(page.locator('nav.shell-nav').getByText('Subscription')).toBeVisible();

  // --- staff, configuration, readiness
  const admin = await hotelToken(request, { email: adminEmail, password: PASSWORD });
  const manager = await inviteAndAccept(
    request,
    admin,
    hotelId,
    `manager-${stamp}@onboarding.e2e.test`,
    ['MANAGER'],
    PASSWORD,
  );
  const receptionEmail = `reception-${stamp}@onboarding.e2e.test`;
  const reception = await inviteAndAccept(
    request,
    admin,
    hotelId,
    receptionEmail,
    ['RECEPTION'],
    PASSWORD,
  );
  const cleaner = await inviteAndAccept(
    request,
    admin,
    hotelId,
    `cleaner-${stamp}@onboarding.e2e.test`,
    ['CLEANER'],
    PASSWORD,
  );

  const configured = await api(request, 'PUT', `/hotels/${hotelId}/catalog/stay-configuration`, {
    token: manager,
    body: {
      fixedCheckoutMinute: 720,
      cleaningBufferMinutes: 30,
      nightlyRateMnt: '100000',
      hourlyRateMnt: '20000',
    },
  });
  expect(configured.status, JSON.stringify(configured.body)).toBeLessThan(300);
  const category = await api<{ categoryId: string }>(
    request,
    'POST',
    `/hotels/${hotelId}/catalog/categories`,
    {
      token: manager,
      body: { name: 'Стандарт', state: 'ACTIVE', nightlyRateMnt: '100000', hourlyRateMnt: '20000' },
    },
  );
  expect(category.status, JSON.stringify(category.body)).toBeLessThan(300);
  const room = await api<{ roomId: string }>(request, 'POST', `/hotels/${hotelId}/catalog/rooms`, {
    token: manager,
    body: { roomNumber: '101', categoryId: category.body.categoryId, state: 'ACTIVE' },
  });
  expect(room.status, JSON.stringify(room.body)).toBeLessThan(300);
  const deposit = await api(request, 'PUT', `/hotels/${hotelId}/deposit-configuration`, {
    token: manager,
    body: { amountMnt: '50000' },
  });
  expect(deposit.status, JSON.stringify(deposit.body)).toBeLessThan(300);
  const clean = await api(
    request,
    'POST',
    `/hotels/${hotelId}/rooms/${room.body.roomId}/cleaning`,
    { token: cleaner, body: { toState: 'CLEAN', expectedRevision: 0 } },
  );
  expect(clean.status, JSON.stringify(clean.body)).toBeLessThan(300);
  const shift = await api<{ shiftId: string; revision: number }>(
    request,
    'POST',
    `/hotels/${hotelId}/shifts`,
    { token: reception, body: { openingCountedMnt: '0' } },
  );
  expect(shift.status, JSON.stringify(shift.body)).toBe(201);

  // --- the first walk-in, in the portal
  const citizen = s.citizens.ordinary[index]!;
  await page.goto(`${hotelBase}/sign-in`);
  await page
    .getByRole('button', { name: 'Гарах' })
    .click()
    .catch(() => undefined);
  await page.goto(`${hotelBase}/sign-in`);
  await page.locator('[name=email]').fill(receptionEmail);
  await page.locator('[name=password]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Нэвтрэх' }).click();
  await page.waitForURL(`**/hotels/${hotelId}/**`);
  await page.goto(`${hotelBase}/hotels/${hotelId}/check-in?roomId=${room.body.roomId}`);
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
  const stayId = /\/stays\/([0-9a-f-]+)/u.exec(page.url())![1]!;

  // --- and its checkout: no minibar on a fresh room, so the bill alone holds it
  await page.getByRole('button', { name: 'Check-out эхлүүлэх' }).click();
  await page.waitForURL(/ok=checkout-started/u);
  await page.getByRole('button', { name: 'Төлбөр бичих' }).click();
  await page.waitForURL(/ok=charged/u);
  const folio = await api<{ balanceMnt: string }>(
    request,
    'GET',
    `/hotels/${hotelId}/stays/${stayId}/folio`,
    { token: reception },
  );
  expect(Number(folio.body.balanceMnt)).toBeGreaterThan(0);
  await page.locator('[name=channel]').selectOption('CASH');
  await page.locator('[name=amountMnt]').fill(folio.body.balanceMnt);
  await page.getByRole('button', { name: 'Төлбөр бүртгэх' }).click();
  await page.waitForURL(/ok=paid/u);
  await page.getByRole('button', { name: 'Тооцоо хаах' }).click();
  await page.waitForURL(/ok=settled/u);
  await page.getByRole('button', { name: 'Check-out дуусгах' }).click();
  await page.waitForURL(/ok=checked-out/u);

  // --- the shift closes on the cash the desk took
  const current = await api<{
    shift: { shiftId: string; revision: number; expectedCashMnt: string | null } | null;
  }>(request, 'GET', `/hotels/${hotelId}/shifts/current`, { token: reception });
  expect(current.body.shift).not.toBeNull();
  const counted = await api<{ revision: number }>(
    request,
    'POST',
    `/hotels/${hotelId}/shifts/${current.body.shift!.shiftId}/count`,
    {
      token: reception,
      body: {
        expectedRevision: current.body.shift!.revision,
        countedCashMnt: folio.body.balanceMnt,
      },
    },
  );
  expect(counted.status, JSON.stringify(counted.body)).toBeLessThan(300);
  const closed = await api<{ state: string }>(
    request,
    'POST',
    `/hotels/${hotelId}/shifts/${current.body.shift!.shiftId}/self-close`,
    {
      token: reception,
      body: { expectedRevision: counted.body.revision, countedCashMnt: folio.body.balanceMnt },
    },
  );
  expect(closed.status, JSON.stringify(closed.body)).toBeLessThan(300);
  await registerCanaries(request, [admin, manager, reception, cleaner]);
});
