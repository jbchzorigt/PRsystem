import { expect, test } from '@playwright/test';
import { PORTALS } from './portals';

/**
 * Every portal starts, answers, and renders its own identity — not another
 * portal's — with the document language and the skip link the shared shell
 * carries (doc 02 §7 accessibility, Phase 21).
 */
for (const portal of PORTALS) {
  test.describe(portal.app, () => {
    const baseUrl = `http://127.0.0.1:${String(portal.port)}`;

    test('starts and renders its own identity', async ({ page }) => {
      const response = await page.goto(`${baseUrl}${portal.entry}`);

      expect(response?.status()).toBe(200);
      await expect(page.locator('header .brand small')).toHaveText(portal.identity);
      await expect(page.locator('h1')).toBeVisible();
    });

    test('is not serving another portal', async ({ page }) => {
      await page.goto(`${baseUrl}${portal.entry}`);
      const identity = await page.locator('header .brand small').innerText();

      const others = PORTALS.filter((other) => other.app !== portal.app);
      expect(others.map((other) => other.identity)).not.toContain(identity);
    });

    test('declares the Mongolian document language and a skip link', async ({ page }) => {
      await page.goto(`${baseUrl}${portal.entry}`);

      await expect(page.locator('html')).toHaveAttribute('lang', 'mn');
      await expect(page.locator('a.skip-link')).toHaveAttribute('href', '#main');
      await expect(page.locator('main#main')).toHaveCount(1);
    });
  });
}
