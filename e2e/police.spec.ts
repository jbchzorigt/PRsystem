import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { portalUrl } from './portals';
import { checkIn, hotelToken, lane, openShift, seed } from './support';

/**
 * doc 13: the Police Admin registers a wanted person (ХУР-verified), opens
 * and activates the case — whose activation sweep matches the stay the
 * Reception recorded — then opens the match by exact number, acknowledges it
 * and confirms Found. The Officer sees no all-hotel list (POL-DEC-010).
 */
test.describe.configure({ mode: 'serial' });

const base = portalUrl('web-police');

async function signIn(page: Page, credential: { email: string; password: string }) {
  await page.goto(`${base}/sign-in`);
  await expect(page.getByText('Realm: Police')).toBeVisible();
  await page.locator('[name=email]').fill(credential.email);
  await page.locator('[name=password]').fill(credential.password);
  await page.getByRole('button', { name: 'Нэвтрэх' }).click();
  await page.waitForURL(`${base}/`);
}

test('the admin registers a wanted case, activates it, and confirms the match found', async ({
  page,
  request,
}, testInfo) => {
  const s = await seed(request);
  const index = lane(testInfo);
  const citizen = s.citizens.wanted[index]!;
  const reception = await hotelToken(request, s.hotel.reception);
  await openShift(request, reception, s.hotel.hotelId);
  await checkIn(request, reception, s.hotel.hotelId, s.hotel.rooms[3 + index]!, citizen);

  await signIn(page, s.police.admin);
  await expect(page.locator('h1')).toHaveText('Dashboard');
  await expect(page.locator('.kpi').first()).toBeVisible();

  await page.goto(`${base}/wanted/new`);
  await page.locator('[name=registrationNumber]').fill(citizen.registrationNumber);
  await page
    .locator('[name=reasonText]')
    .fill(`E2E ${testInfo.project.name}: эрэн сурвалжлах үндэслэл`);
  await page.locator('[name=crimeCategory]').fill('Хулгай');
  await page.locator('[name=owningUnitRef]').fill('UNIT-E2E');
  await page.getByRole('button', { name: 'Хадгалах' }).click();
  await page.waitForURL(/\/cases\/[0-9a-f-]+\?/u);
  await expect(page.getByText('DRAFT').first()).toBeVisible();

  await page.locator('[name=state]').selectOption('PENDING_APPROVAL');
  await page.locator('[name=reason]').fill('Батлуулахаар илгээв');
  await page.getByRole('button', { name: 'Төлөв өөрчлөх' }).click();
  await page.waitForURL(/ok=moved/u);
  await page.locator('[name=state]').selectOption('ACTIVE');
  await page.locator('[name=reason]').fill('Идэвхжүүлэв');
  await page.getByRole('button', { name: 'Төлөв өөрчлөх' }).click();
  await page.waitForURL(/state=ACTIVE/u);
  await expect(page.getByText('ACTIVE').first()).toBeVisible();

  await page.goto(`${base}/matches`);
  await page.locator('[name=registrationNumber]').fill(citizen.registrationNumber);
  await page.getByRole('button', { name: 'Match нээх' }).click();
  await page.waitForURL(/\/matches\/[0-9a-f-]+$/u);
  expect(page.url()).not.toContain(citizen.registrationNumber);
  await expect(page.getByText(s.hotel.name).first()).toBeVisible();

  await page.getByRole('button', { name: 'Хүлээн авсан' }).click();
  await page.waitForURL(/ok=acknowledged/u);
  await page.getByRole('radio', { name: 'Match гарсан буудалд' }).check();
  await page.getByRole('button', { name: 'Олдсон', exact: true }).click();
  await page.waitForURL(/ok=found/u);
  await expect(page.locator('dl.kv').getByText('Олдсон', { exact: true })).toBeVisible();
});

test('the admin reads the all-hotel check-in list; the officer cannot', async ({
  page,
  request,
}, testInfo) => {
  const s = await seed(request);
  const citizen = s.citizens.wanted[lane(testInfo)]!;
  await signIn(page, s.police.admin);
  await page.goto(`${base}/check-ins`);
  await expect(page.locator('h1')).toContainText('check-in');
  await expect(page.getByText(citizen.givenName).first()).toBeVisible();

  await page.goto(`${base}/sign-in`);
  await page
    .getByRole('button', { name: 'Гарах' })
    .click()
    .catch(() => undefined);
  await signIn(page, s.police.officer);
  await expect(page.locator('nav.shell-nav').getByText('Check-in зочдын жагсаалт')).toHaveCount(0);
  await page.goto(`${base}/check-ins`);
  await expect(page.locator('.banner-danger, p[role=alert]').first()).toBeVisible();
});
