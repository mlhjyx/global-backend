import { expect, test } from "@playwright/test";

const goldenId = process.env.M1EB_GOLDEN_ID;

test.beforeEach(async ({ page }) => {
  test.skip(!goldenId, "M1-e-B Golden is selected by its dedicated runner");
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
});

test(`${goldenId} renders a stable full-site document`, async ({ page }) => {
  if (!goldenId) throw new Error("M1EB_GOLDEN_ID_REQUIRED");
  await expect(
    page.locator("main section[data-component]").first(),
  ).toBeVisible();
  await expect(page).toHaveScreenshot(`${goldenId}.png`, {
    animations: "disabled",
    fullPage: true,
  });
});
