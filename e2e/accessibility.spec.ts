import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { portalUrl } from './portals';
import { lane, seed, totpCode } from './support';

/**
 * WCAG 2.1 AA over the screens a person reaches first in each portal, at the
 * three viewports the projects define (phone, tablet, desktop). A serious or
 * critical axe violation fails the run; the shared shell, fields and tables
 * are what these screens are made of, so a regression there shows here.
 */
async function audit(page: Page, name: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(
    blocking.map(
      (v) => `${name}: ${v.id} — ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join('; ')})`,
    ),
  ).toEqual([]);
  // No horizontal scrolling of the document at any viewport (doc 02 §7).
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${name} scrolls horizontally`).toBeLessThanOrEqual(1);
}

test('guest portal: home, results and sign-in', async ({ page }) => {
  const base = portalUrl('web-public');
  await page.goto(base);
  await audit(page, 'guest home');
  await page.getByRole('button', { name: 'Буудал хайх' }).click();
  await page.waitForURL(/\/hotels\?/u);
  await audit(page, 'guest results');
  await page.goto(`${base}/register`);
  await audit(page, 'guest register');
});

test('hotel portal: sign-in, board and check-in', async ({ page, request }) => {
  const s = await seed(request);
  const base = portalUrl('web-hotel');
  await page.goto(`${base}/sign-in`);
  await audit(page, 'hotel sign-in');
  await page.locator('[name=email]').fill(s.hotel.reception.email);
  await page.locator('[name=password]').fill(s.hotel.reception.password);
  await page.getByRole('button', { name: 'Нэвтрэх' }).click();
  await page.waitForURL(`**/hotels/${s.hotel.hotelId}/**`);
  await audit(page, 'hotel board');
  await page.goto(`${base}/hotels/${s.hotel.hotelId}/check-in`);
  await audit(page, 'hotel check-in');
});

test('restaurant portal: entry', async ({ page }) => {
  await page.goto(portalUrl('web-restaurant'));
  await audit(page, 'restaurant entry');
});

test('police portal: sign-in, dashboard and match search', async ({ page, request }) => {
  const s = await seed(request);
  const base = portalUrl('web-police');
  await page.goto(`${base}/sign-in`);
  await audit(page, 'police sign-in');
  await page.locator('[name=email]').fill(s.police.admin.email);
  await page.locator('[name=password]').fill(s.police.admin.password);
  await page.getByRole('button', { name: 'Нэвтрэх' }).click();
  await page.waitForURL(`${base}/`);
  await audit(page, 'police dashboard');
  await page.goto(`${base}/matches`);
  await audit(page, 'police match search');
  await page.goto(`${base}/check-ins`);
  await audit(page, 'police check-in list');
});

test('operation portal: sign-in, dashboard and list', async ({ page, request }, testInfo) => {
  const s = await seed(request);
  const admin = s.operation.auditAdmins[lane(testInfo)]!;
  const base = portalUrl('web-operation');
  await page.goto(`${base}/sign-in`);
  await audit(page, 'operation sign-in');
  await page.locator('[name=email]').fill(admin.email);
  await page.locator('[name=password]').fill(admin.password);
  await page.locator('[name=code]').fill(await totpCode(request, admin.email));
  await page.getByRole('button', { name: 'Нэвтрэх' }).click();
  await page.waitForURL(`${base}/`);
  await audit(page, 'operation dashboard');
  await page.goto(`${base}/subscriptions`);
  await audit(page, 'operation subscriptions');
  await page.goto(`${base}/sms`);
  await audit(page, 'operation sms');
});
