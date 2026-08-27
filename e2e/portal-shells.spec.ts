import { expect, test } from '@playwright/test';
import { PORTAL_SHELLS } from './portals';

/**
 * Portal-shell smoke tests — non-business by design.
 *
 * These prove the harness and the five deployments are real: each portal starts,
 * responds, and renders its own identity rather than another portal's. Business
 * workflows are deliberately absent until Phases 21-22.
 */
for (const portal of PORTAL_SHELLS) {
  test.describe(portal.app, () => {
    const baseUrl = `http://127.0.0.1:${String(portal.port)}`;

    test('starts and renders its own identity', async ({ page }) => {
      const response = await page.goto(baseUrl);

      expect(response?.status()).toBe(200);
      await expect(page.locator('h1')).toHaveText(portal.heading);
      await expect(page.getByText(`Realm: ${portal.realm}`)).toBeVisible();
    });

    test('is not serving another portal shell', async ({ page }) => {
      await page.goto(baseUrl);
      const heading = await page.locator('h1').innerText();

      const others = PORTAL_SHELLS.filter((other) => other.app !== portal.app);
      expect(others.map((other) => other.heading)).not.toContain(heading);
    });

    test('declares the Mongolian document language', async ({ page }) => {
      await page.goto(baseUrl);

      await expect(page.locator('html')).toHaveAttribute('lang', 'mn');
    });
  });
}
