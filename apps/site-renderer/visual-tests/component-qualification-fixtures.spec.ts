import { expect, test } from "@playwright/test";

const QUALIFIED_COMPONENTS = {
  AboutBlock: "section.about-block",
  ArticleGrid: "section.article-grid",
  AreaMarquee: "section.area-marquee",
  AreaGallery: "section.area-gallery",
  CertWall: "section.cert-wall",
  CtaBanner: "section.cta",
  CtaCenter: "section.cta-center",
  DishesShowcase: "section.dishes-showcase",
  EditorialHero: "section.editorial-hero",
  FaqSplit: "section.faq-split",
  FaqAccordion: "section.faq-accordion",
  FeatureCards: "section.feature-cards",
  HeroBanner: "section.hero",
  InquiryForm: "section.inquiry-block",
  LogoMarquee: "section.logo-marquee",
  MapLocation: "section.map-location",
  ProcessTimeline: "section.process-timeline",
  ProcessSteps: "section.process-steps",
  PricingTable: "section.pricing-table",
  PricingTiers: "section.pricing-tiers",
  ProductGrid: "section.product-grid",
  ProductShowcaseAlt: "section.product-showcase-alt",
  PhotoGallery: "section.photo-gallery",
  ProjectsGrid: "section.projects-grid",
  MaterialsLibrary: "section.materials-library",
  CollectionCards: "section.collection-cards",
  StatsCountup: "section.stats-countup",
  StatsBand: "section.stats",
  StatementBlock: "section.statement-block",
  ServicesGrid: "section.services-grid",
  ServicesDark: "section.services-dark",
  ServiceRows: "section.service-rows",
  SplitAbout: "section.split-about",
  TechSystems: "section.tech-systems",
  Testimonials: "section.testimonials",
  TrustSplit: "section.trust-split",
  LedgerStats: "section.ledger-stats",
  ValueStrip: "section.value-strip",
  WarmHero: "section.warm-hero",
  MediaCta: "section.media-cta",
  FarmhouseHero: "section.farmhouse-hero",
  FeaturedSpotlight: "section.featured-spotlight",
  StoryChapters: "section.story-chapters",
  ChapterShowcase: "section.chapter-showcase",
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
  if (componentType === "ServicesGrid") {
    await expect(section.locator("ul > li > article")).toHaveCount(2);
    await expect(section.locator('a[href="#"]')).toHaveCount(0);
  }
  if (componentType === "TrustSplit") {
    await expect(section.locator("ul > li")).toHaveCount(4);
    await expect(section.locator("aside")).toHaveCount(1);
  }
  if (componentType === "ProcessSteps") {
    await expect(section.locator("ol > li > article")).toHaveCount(2);
  }
  if (componentType === "ArticleGrid") {
    await expect(section.locator("article")).toHaveCount(1);
    await expect(section.locator('a[href="#"]')).toHaveCount(0);
  }
  if (componentType === "StatementBlock") {
    await expect(section.locator("p")).toHaveCount(1);
  }
  if (componentType === "PricingTable") {
    await expect(section.locator("table tbody tr")).toHaveCount(2);
    await expect(section.locator('a[href="#"]')).toHaveCount(0);
  }
  if (componentType === "PricingTiers") {
    await expect(section.locator("article")).toHaveCount(2);
    await expect(section.locator("button")).toHaveCount(0);
  }
  if (componentType === "StatsCountup") {
    await expect(section.locator("ul > li")).toHaveCount(3);
    await expect(section.locator("script")).toHaveCount(0);
  }
  if (componentType === "LedgerStats") {
    await expect(section.locator(".stats > li")).toHaveCount(2);
  }
  if (componentType === "ValueStrip") {
    await expect(section.locator("ul > li")).toHaveCount(2);
  }
  if (componentType === "AreaMarquee") {
    await expect(section.locator("ul > li")).toHaveCount(3);
    await expect(section.locator("[aria-hidden='true']")).toHaveCount(3);
  }
  if (componentType === "FaqSplit") {
    await expect(section.locator("details")).toHaveCount(2);
    await expect(section.locator("summary")).toHaveCount(2);
  }
  if (componentType === "CtaCenter") {
    await expect(section.locator("a")).toHaveCount(2);
    await expect(section.locator('a[href="#"]')).toHaveCount(0);
    await expect(section.locator("a").first()).toHaveAttribute("href", "/contact");
  }
  if (componentType === "ServicesDark") {
    await expect(section.locator("ul > li > article")).toHaveCount(2);
    await expect(section.locator('a[href="#"]')).toHaveCount(0);
    await expect(section.locator("a")).toHaveAttribute("href", "/contact");
  }
  if (componentType === "ServiceRows") {
    await expect(section.locator("ul > li > article")).toHaveCount(2);
    await expect(section.locator("a")).toHaveCount(2);
    await expect(section.locator('a[href="#"]')).toHaveCount(0);
    await expect(section.locator("a").first()).toHaveAttribute("href", "/contact");
  }
  if (componentType === "AreaGallery") {
    await expect(section.locator("ul > li > article")).toHaveCount(2);
    await expect(section.locator("a")).toHaveAttribute("href", "/coverage");
  }
  if (componentType === "ProjectsGrid") {
    await expect(section.locator("ul > li > article")).toHaveCount(2);
    await expect(section.locator("a")).toHaveAttribute("href", "/case-studies");
  }
  if (componentType === "MaterialsLibrary") {
    await expect(section.locator("ul > li > article")).toHaveCount(2);
    await expect(section.locator("a").first()).toHaveAttribute("href", "/contact");
  }
  if (componentType === "CollectionCards") {
    await expect(section.locator("ul > li > article")).toHaveCount(3);
    await expect(section.locator("a")).toHaveCount(3);
    await expect(section.locator("a").first()).toHaveAttribute("href", "/");
  }
  if (componentType === "ProductShowcaseAlt") {
    await expect(section.locator("article.showcase")).toHaveCount(1);
    await expect(section.locator("button")).toHaveCount(0);
    await expect(section.locator("a")).toHaveAttribute("href", "/contact");
  }
  if (componentType === "EditorialHero") {
    await expect(section.locator("h1")).toHaveCount(1);
    await expect(section.locator("a")).toHaveAttribute("href", "/services");
  }
  if (componentType === "SplitAbout") {
    await expect(section.locator("h2")).toHaveCount(1);
    await expect(section.locator("a")).toHaveAttribute("href", "/contact");
  }
  if (componentType === "WarmHero") {
    await expect(section.locator("ul > li")).toHaveCount(2);
    await expect(section.locator("a")).toHaveCount(2);
    await expect(section.locator("a").first()).toHaveAttribute("href", "/booking");
  }
  if (componentType === "DishesShowcase") {
    await expect(section.locator("ul > li > article")).toHaveCount(2);
    await expect(section.locator("a").first()).toHaveAttribute("href", "/menu");
  }
  if (componentType === "PhotoGallery") {
    await expect(section.locator("ul > li figure")).toHaveCount(3);
    await expect(section.locator("a")).toHaveAttribute("href", "/archive");
  }
  if (componentType === "MediaCta") {
    await expect(section.locator("h2")).toHaveCount(1);
    await expect(section.locator("a").first()).toHaveAttribute("href", "/contact");
    await expect(section.locator('a[href="#"]')).toHaveCount(0);
  }
  if (componentType === "FarmhouseHero") {
    await expect(section.locator("h1")).toHaveCount(1);
    await expect(section.locator("a").first()).toHaveAttribute("href", "/collections");
    await expect(section.locator('a[href="#"]')).toHaveCount(0);
  }
  if (componentType === "FeaturedSpotlight") {
    await expect(section.locator("ul > li > article")).toHaveCount(2);
    await expect(section.locator("a")).toHaveAttribute("href", "/catalog");
  }
  if (componentType === "StoryChapters") {
    await expect(section.locator("ol > li > article")).toHaveCount(2);
  }
  if (componentType === "ChapterShowcase") {
    await expect(section.locator("ul > li > article")).toHaveCount(2);
  }
  await expect(section).toHaveScreenshot(`${componentType}.png`, {
    animations: "disabled",
    maxDiffPixelRatio: 0.015,
  });
});
