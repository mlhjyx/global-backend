import { expect, test } from '@playwright/test';

const COMPONENTS = [
  { name: 'HeroBanner', selector: 'section.hero' },
  { name: 'StatsBand', selector: 'section.stats' },
  { name: 'CtaBanner', selector: 'section.cta' },
] as const;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
});

for (const component of COMPONENTS) {
  test(`${component.name} has a stable reduced-motion rendering`, async ({
    page,
  }) => {
    const section = page.locator(component.selector).first();
    await expect(section).toBeVisible();
    await expect(section).toHaveScreenshot(`${component.name}.png`, {
      animations: 'disabled',
      maxDiffPixelRatio: 0.005,
    });
  });
}

test('the qualified baseline does not overflow horizontally', async ({ page }) => {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
