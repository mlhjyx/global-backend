import { expect, test } from "@playwright/test";

const QUALIFIED_COMPONENTS = {
  AboutBlock: "section.about-block",
  CertWall: "section.cert-wall",
  CtaBanner: "section.cta",
  FaqAccordion: "section.faq-accordion",
  FeatureCards: "section.feature-cards",
  HeroBanner: "section.hero",
  InquiryForm: "section.inquiry-block",
  LogoMarquee: "section.logo-marquee",
  MapLocation: "section.map-location",
  ProcessTimeline: "section.process-timeline",
  ProductGrid: "section.product-grid",
  StatsBand: "section.stats",
  TechSystems: "section.tech-systems",
  Testimonials: "section.testimonials",
} as const;

const componentType = process.env.COMPONENT_QUALIFICATION_COMPONENT;
if (componentType && !(componentType in QUALIFIED_COMPONENTS)) {
  throw new Error("COMPONENT_QUALIFICATION_COMPONENT_INVALID");
}
const selector =
  componentType
    ? QUALIFIED_COMPONENTS[
        componentType as keyof typeof QUALIFIED_COMPONENTS
      ]
    : undefined;

test.beforeEach(async ({ page }) => {
  test.skip(!selector, "qualification fixture is selected by its dedicated runner");
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
});

test(`${componentType} isolated fixture matches its byte-pinned visual evidence`, async ({
  page,
}) => {
  if (!selector || !componentType) throw new Error("COMPONENT_QUALIFICATION_COMPONENT_INVALID");
  const section = page.locator(selector);
  await expect(page.locator("section[data-component]")).toHaveCount(1);
  await expect(section).toHaveAttribute("data-component", componentType);
  await expect(section).toHaveAttribute("data-variant", "technical-grid");
  await expect(section).toHaveScreenshot(`${componentType}.png`, {
    animations: "disabled",
    maxDiffPixelRatio: 0.015,
  });
});
