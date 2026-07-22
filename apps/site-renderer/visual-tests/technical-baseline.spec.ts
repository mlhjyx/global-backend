import { expect, test } from "@playwright/test";

const COMPONENTS = [
  { name: "HeroBanner", selector: "section.hero" },
  { name: "StatsBand", selector: "section.stats" },
  { name: "ProductGrid", selector: "section.product-grid" },
  { name: "AboutBlock", selector: "section.about-block" },
  { name: "InquiryForm", selector: "section.inquiry-block" },
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

test("ProductGrid gives each offering a named article", async ({ page }) => {
  const section = page.locator("section.product-grid").first();
  const cards = section.locator("article");
  await expect(cards).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    const card = cards.nth(index);
    const labelId = await card.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    await expect(card.locator(`#${labelId}`)).toBeVisible();
  }
});

test("InquiryForm labels every disabled preview field and explains its state", async ({
  page,
}) => {
  const form = page.locator("section.inquiry-block form").first();
  await expect(form.locator("label")).toHaveCount(3);
  for (const name of ["name", "email", "message"]) {
    const field = form.locator(`[name=\"${name}\"]`);
    await expect(field).toBeDisabled();
    const id = await field.getAttribute("id");
    await expect(form.locator(`label[for=\"${id}\"]`)).toBeVisible();
  }
  await expect(form.locator("[role=status]")).toBeVisible();
});

test("component landmarks keep local label ids unique", async ({ page }) => {
  const sections = page.locator("section[data-component][aria-labelledby]");
  const labelIds = await sections.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("aria-labelledby")),
  );
  expect(labelIds.every(Boolean)).toBe(true);
  expect(new Set(labelIds).size).toBe(labelIds.length);
  for (let index = 0; index < labelIds.length; index += 1) {
    await expect(
      sections.nth(index).locator(`#${labelIds[index]}`),
    ).toHaveCount(1);
  }
});

test("four-item StatsBand uses the supported responsive layout", async ({
  page,
}) => {
  const items = page
    .locator('section.stats[data-variant="quiet"]')
    .getByRole("listitem");
  await expect(items).toHaveCount(4);
  const rows = await items.evaluateAll((elements) =>
    elements.map((element) => Math.round(element.getBoundingClientRect().y)),
  );
  if (page.viewportSize()!.width < 640) {
    expect(new Set(rows).size).toBe(4);
  } else {
    expect(new Set(rows).size).toBe(1);
  }
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
      maxDiffPixelRatio: 0.015,
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
