import { expect, test } from "@playwright/test";

const COMPONENTS = [
  { name: "HeroBanner", selector: "section.hero" },
  { name: "StatsBand", selector: "section.stats" },
  { name: "CtaBanner", selector: "section.cta" },
] as const;

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
});

test("the technical baseline exposes semantic component landmarks", async ({
  page,
}) => {
  for (const component of COMPONENTS) {
    const section = page.locator(component.selector).first();
    await expect(section).toHaveAttribute("data-component", component.name);
    await expect(section).toHaveAttribute("data-variant", "technical-grid");

    const headingId = await section.getAttribute("aria-labelledby");
    expect(headingId).toBeTruthy();
    await expect(section.locator(`#${headingId}`)).toBeVisible();
  }
});

test("HeroBanner content clears the fixed header", async ({ page }) => {
  const header = page.locator(".site-header");
  const heading = page.locator("section.hero h1").first();
  const [headerBox, headingBox] = await Promise.all([
    header.boundingBox(),
    heading.boundingBox(),
  ]);
  expect(headerBox).not.toBeNull();
  expect(headingBox).not.toBeNull();
  expect(headingBox!.y).toBeGreaterThanOrEqual(
    headerBox!.y + headerBox!.height + 24,
  );
});

test("StatsBand exposes list semantics for each metric", async ({ page }) => {
  const list = page.locator('section.stats [role="list"]').first();
  await expect(list).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(3);
});

test("qualified CTA links have touch, focus, and reduced-motion contracts", async ({
  page,
}) => {
  for (const selector of ["section.hero .btn", "section.cta .btn"]) {
    const link = page.locator(selector).first();
    await link.focus();
    const contract = await link.evaluate((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        height: box.height,
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
        prefersReduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        transitionDuration: style.transitionDuration,
      };
    });
    expect(contract.height).toBeGreaterThanOrEqual(44);
    expect(contract.outlineStyle).not.toBe("none");
    expect(contract.outlineWidth).toBeGreaterThanOrEqual(2);
    expect(contract.prefersReduced).toBe(true);
    expect(contract.transitionDuration).toBe("0s");
  }
});

for (const component of COMPONENTS) {
  test(`${component.name} has a stable reduced-motion rendering`, async ({
    page,
  }) => {
    const section = page.locator(component.selector).first();
    await expect(section).toBeVisible();
    await expect(section).toHaveScreenshot(`${component.name}.png`, {
      animations: "disabled",
      maxDiffPixelRatio: 0.005,
    });
  });
}

test("the qualified baseline does not overflow horizontally", async ({
  page,
}) => {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
