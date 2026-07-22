import { z } from "zod";

export const QUALIFIED_COMPONENT_CONTENT_BUDGETS = Object.freeze({
  HeroBanner: Object.freeze({
    headline: 60,
    headlineWords: 8,
    subhead: 140,
    cta: 24,
    ctaWords: 4,
  }),
  StatsBand: Object.freeze({ minItems: 2, maxItems: 4, value: 8, label: 24 }),
  CtaBanner: Object.freeze({
    headline: 60,
    headlineWords: 8,
    cta: 24,
    ctaWords: 4,
  }),
  ProductGrid: Object.freeze({
    title: 60,
    titleWords: 8,
    minItems: 1,
    maxItems: 8,
    productName: 48,
    productBlurb: 240,
  }),
  AboutBlock: Object.freeze({ title: 60, titleWords: 8, body: 400 }),
  InquiryForm: Object.freeze({ title: 60, titleWords: 8, subhead: 140 }),
  CertWall: Object.freeze({ title: 60, titleWords: 8, minItems: 1, maxItems: 8, label: 48 }),
  ProcessTimeline: Object.freeze({ title: 60, titleWords: 8, minItems: 2, maxItems: 6, stepTitle: 40, stepBody: 160 }),
  FaqAccordion: Object.freeze({ title: 60, titleWords: 8, minItems: 1, maxItems: 8, question: 120, answer: 400 }),
  LogoMarquee: Object.freeze({ eyebrow: 40, title: 60, titleWords: 8, minItems: 2, maxItems: 12, item: 48 }),
  Testimonials: Object.freeze({ eyebrow: 40, title: 60, titleWords: 8, minItems: 1, maxItems: 6, quote: 400, name: 80, location: 80, platform: 60 }),
  FeatureCards: Object.freeze({ eyebrow: 40, title: 60, titleWords: 8, intro: 240, minItems: 2, maxItems: 6, itemTitle: 60, itemDescription: 200, learn: 24 }),
  TechSystems: Object.freeze({ chapter: 40, title: 60, titleWords: 8, intro: 240, minItems: 2, maxItems: 6, label: 48, systemTitle: 60, description: 200, metric: 24, suffix: 12, metricLabel: 48, live: 40 }),
  MapLocation: Object.freeze({ title: 60, titleWords: 8, address: 160, addressWords: 24 }),
  ServicesGrid: Object.freeze({ eyebrow: 40, title: 60, titleWords: 8, accent: 40, intro: 240, minItems: 1, maxItems: 8, itemTitle: 60, itemDescription: 200, from: 48 }),
  TrustSplit: Object.freeze({ eyebrow: 40, title: 60, titleWords: 8, accent: 40, intro: 240, minStats: 2, maxStats: 4, value: 16, label: 48, maxBadges: 8, badge: 48, name: 80, role: 80 }),
  ProcessSteps: Object.freeze({ eyebrow: 40, title: 60, titleWords: 8, accent: 40, intro: 240, minItems: 2, maxItems: 6, number: 12, itemTitle: 60, itemBody: 200, meta: 48 }),
  ArticleGrid: Object.freeze({ eyebrow: 40, title: 60, titleWords: 8, titleLine2: 60, titleLine2Words: 8, intro: 240, minItems: 1, maxItems: 8, category: 48, itemTitle: 80, itemDescription: 240, readTime: 32 }),
  StatementBlock: Object.freeze({ label: 48, statement: 240 }),
  PricingTable: Object.freeze({ eyebrow: 40, title: 60, titleWords: 8, accent: 40, intro: 240, column: 48, cta: 24, footnote: 160, minRows: 1, maxRows: 8, service: 60, note: 160, from: 48 }),
  StatsCountup: Object.freeze({ heading: 48, minItems: 2, maxItems: 4, value: 16, label: 48 }),
  LedgerStats: Object.freeze({ chapter: 40, title: 60, titleWords: 8, body: 240, minStats: 2, maxStats: 4, value: 16, label: 48, minClients: 1, maxClients: 8, client: 80, clientsLabel: 48 }),
  PricingTiers: Object.freeze({ eyebrow: 40, title: 60, titleWords: 8, titleLine2: 60, titleLine2Words: 8, sub: 240, billingLabel: 32, save: 48, featured: 32, perMo: 24, minPlans: 1, maxPlans: 4, name: 48, tagline: 160, price: 16, minFeatures: 1, maxFeatures: 8, feature: 80 }),
  ValueStrip: Object.freeze({ heading: 48, minItems: 2, maxItems: 6, icon: 80, label: 80 }),
  AreaMarquee: Object.freeze({ heading: 48, minItems: 2, maxItems: 12, item: 48 }),
  FaqSplit: Object.freeze({ eyebrow: 40, title: 60, titleWords: 8, accent: 40, intro: 240, minItems: 1, maxItems: 8, question: 120, answer: 400 }),
  CtaCenter: Object.freeze({ eyebrow: 40, title: 60, titleWords: 8, accent: 40, subtitle: 140, cta: 24 }),
  ServicesDark: Object.freeze({ eyebrow: 40, title: 60, titleWords: 8, accent: 40, minItems: 1, maxItems: 8, serviceTitle: 60, serviceDescription: 200, cta: 24 }),
  ServiceRows: Object.freeze({ eyebrow: 40, title: 60, titleWords: 8, accent: 40, intro: 240, fromLabel: 48, minItems: 1, maxItems: 8, serviceTitle: 60, serviceDescription: 200, from: 48, unit: 24, cta: 24 }),
  AreaGallery: Object.freeze({ eyebrow: 40, title: 60, titleWords: 8, accent: 40, minItems: 1, maxItems: 8, name: 60, postcodes: 80, note: 160, cta: 24 }),
  ProjectsGrid: Object.freeze({ title: 60, titleWords: 8, minItems: 1, maxItems: 8, itemTitle: 80, itemDescription: 240, cta: 24 }),
  MaterialsLibrary: Object.freeze({ eyebrow: 40, title: 60, titleWords: 8, accent: 40, intro: 240, minItems: 1, maxItems: 8, number: 24, name: 80, weight: 48, note: 160, cta: 24 }),
  CollectionCards: Object.freeze({ eyebrow: 40, title: 60, titleWords: 8, minItems: 1, maxItems: 8, name: 80 }),
  ProductShowcaseAlt: Object.freeze({ chapter: 40, title: 60, titleWords: 8, accent: 40, intro: 240, code: 24, name: 80, tagline: 80, spec: 48, price: 24, label: 48, minFeatures: 0, maxFeatures: 3, feature: 80, cta: 24 }),
});

export type QualifiedContentBudgetComponent =
  keyof typeof QUALIFIED_COMPONENT_CONTENT_BUDGETS;

const boundedCopy = (maxCharacters: number, maxWords?: number) => {
  const schema = z.string().trim().min(1).max(maxCharacters);
  if (maxWords === undefined) return schema;
  return schema.refine(
    (value) => value.split(/\s+/u).length <= maxWords,
    `Must contain at most ${maxWords} words`,
  );
};

const contentSchemas = {
  HeroBanner: z
    .object({
      headline: boundedCopy(
        QUALIFIED_COMPONENT_CONTENT_BUDGETS.HeroBanner.headline,
        QUALIFIED_COMPONENT_CONTENT_BUDGETS.HeroBanner.headlineWords,
      ),
      subhead: boundedCopy(
        QUALIFIED_COMPONENT_CONTENT_BUDGETS.HeroBanner.subhead,
      ).optional(),
      cta: boundedCopy(
        QUALIFIED_COMPONENT_CONTENT_BUDGETS.HeroBanner.cta,
        QUALIFIED_COMPONENT_CONTENT_BUDGETS.HeroBanner.ctaWords,
      ).optional(),
    })
    .strict(),
  StatsBand: z
    .object({
      stats: z
        .array(
          z
            .object({
              value: boundedCopy(
                QUALIFIED_COMPONENT_CONTENT_BUDGETS.StatsBand.value,
              ),
              label: boundedCopy(
                QUALIFIED_COMPONENT_CONTENT_BUDGETS.StatsBand.label,
              ),
            })
            .strict(),
        )
        .min(QUALIFIED_COMPONENT_CONTENT_BUDGETS.StatsBand.minItems)
        .max(QUALIFIED_COMPONENT_CONTENT_BUDGETS.StatsBand.maxItems),
    })
    .strict(),
  CtaBanner: z
    .object({
      headline: boundedCopy(
        QUALIFIED_COMPONENT_CONTENT_BUDGETS.CtaBanner.headline,
        QUALIFIED_COMPONENT_CONTENT_BUDGETS.CtaBanner.headlineWords,
      ),
      cta: boundedCopy(
        QUALIFIED_COMPONENT_CONTENT_BUDGETS.CtaBanner.cta,
        QUALIFIED_COMPONENT_CONTENT_BUDGETS.CtaBanner.ctaWords,
      ),
    })
    .strict(),
  ProductGrid: z
    .object({
      title: boundedCopy(
        QUALIFIED_COMPONENT_CONTENT_BUDGETS.ProductGrid.title,
        QUALIFIED_COMPONENT_CONTENT_BUDGETS.ProductGrid.titleWords,
      ),
      products: z
        .array(
          z
            .object({
              name: boundedCopy(
                QUALIFIED_COMPONENT_CONTENT_BUDGETS.ProductGrid.productName,
              ),
              blurb: boundedCopy(
                QUALIFIED_COMPONENT_CONTENT_BUDGETS.ProductGrid.productBlurb,
              ).optional(),
            })
            .strict(),
        )
        .min(QUALIFIED_COMPONENT_CONTENT_BUDGETS.ProductGrid.minItems)
        .max(QUALIFIED_COMPONENT_CONTENT_BUDGETS.ProductGrid.maxItems),
    })
    .strict(),
  AboutBlock: z
    .object({
      title: boundedCopy(
        QUALIFIED_COMPONENT_CONTENT_BUDGETS.AboutBlock.title,
        QUALIFIED_COMPONENT_CONTENT_BUDGETS.AboutBlock.titleWords,
      ),
      body: boundedCopy(QUALIFIED_COMPONENT_CONTENT_BUDGETS.AboutBlock.body),
    })
    .strict(),
  InquiryForm: z
    .object({
      title: boundedCopy(
        QUALIFIED_COMPONENT_CONTENT_BUDGETS.InquiryForm.title,
        QUALIFIED_COMPONENT_CONTENT_BUDGETS.InquiryForm.titleWords,
      ),
      subhead: boundedCopy(
        QUALIFIED_COMPONENT_CONTENT_BUDGETS.InquiryForm.subhead,
      ).optional(),
    })
    .strict(),
  CertWall: z.object({ title: boundedCopy(60, 8), certs: z.array(z.object({ label: boundedCopy(48) }).strict()).min(1).max(8) }).strict(),
  ProcessTimeline: z.object({ title: boundedCopy(60, 8), steps: z.array(z.object({ title: boundedCopy(40), body: boundedCopy(160) }).strict()).min(2).max(6) }).strict(),
  FaqAccordion: z.object({ title: boundedCopy(60, 8), items: z.array(z.object({ question: boundedCopy(120), answer: boundedCopy(400) }).strict()).min(1).max(8) }).strict(),
  LogoMarquee: z.object({ eyebrow: boundedCopy(40), title: boundedCopy(60, 8), items: z.array(boundedCopy(48)).min(2).max(12) }).strict(),
  Testimonials: z.object({ eyebrow: boundedCopy(40), title: boundedCopy(60, 8), items: z.array(z.object({ quote: boundedCopy(400), name: boundedCopy(80), location: boundedCopy(80), platform: boundedCopy(60), rating: z.number().min(0).max(5) }).strict()).min(1).max(6) }).strict(),
  FeatureCards: z.object({ eyebrow: boundedCopy(40), title: boundedCopy(60, 8), intro: boundedCopy(240), items: z.array(z.object({ title: boundedCopy(60), description: boundedCopy(200) }).strict()).min(2).max(6), learn: boundedCopy(24).optional() }).strict(),
  TechSystems: z.object({ chapter: boundedCopy(40), title: boundedCopy(60, 8), intro: boundedCopy(240), systems: z.array(z.object({ label: boundedCopy(48), title: boundedCopy(60), description: boundedCopy(200), metric: boundedCopy(24), suffix: boundedCopy(12), metricLabel: boundedCopy(48) }).strict()).min(2).max(6), live: boundedCopy(40).optional() }).strict(),
  MapLocation: z.object({ title: boundedCopy(60, 8), address: boundedCopy(160, 24) }).strict(),
  ServicesGrid: z.object({ eyebrow: boundedCopy(40), title: boundedCopy(60, 8), accent: boundedCopy(40), intro: boundedCopy(240), cards: z.array(z.object({ title: boundedCopy(60), description: boundedCopy(200), from: boundedCopy(48).optional(), icon: boundedCopy(80) }).strict()).min(1).max(8) }).strict(),
  TrustSplit: z.object({ eyebrow: boundedCopy(40), title: boundedCopy(60, 8), accent: boundedCopy(40), intro: boundedCopy(240), metrics: z.array(z.object({ value: boundedCopy(16), label: boundedCopy(48) }).strict()).min(2).max(4), badges: z.array(boundedCopy(48)).max(8), name: boundedCopy(80), role: boundedCopy(80) }).strict(),
  ProcessSteps: z.object({ eyebrow: boundedCopy(40), title: boundedCopy(60, 8), accent: boundedCopy(40), intro: boundedCopy(240), items: z.array(z.object({ number: boundedCopy(12), title: boundedCopy(60), body: boundedCopy(200), meta: boundedCopy(48).optional(), icon: boundedCopy(80) }).strict()).min(2).max(6) }).strict(),
  ArticleGrid: z.object({ eyebrow: boundedCopy(40), title: boundedCopy(60, 8), titleLine2: boundedCopy(60, 8), intro: boundedCopy(240), articles: z.array(z.object({ category: boundedCopy(48), title: boundedCopy(80), description: boundedCopy(240), readTime: boundedCopy(32) }).strict()).min(1).max(8) }).strict(),
  StatementBlock: z.object({ label: boundedCopy(48), statement: boundedCopy(240) }).strict(),
  PricingTable: z.object({ eyebrow: boundedCopy(40), title: boundedCopy(60,8), accent: boundedCopy(40), intro: boundedCopy(240), serviceColumn: boundedCopy(48), fromColumn: boundedCopy(48), primaryCta: boundedCopy(24,4), secondaryCta: boundedCopy(24,4).optional(), footnote: boundedCopy(160), rows: z.array(z.object({icon:boundedCopy(80),service:boundedCopy(60),note:boundedCopy(160),from:boundedCopy(48)}).strict()).min(1).max(8) }).strict(),
  StatsCountup: z.object({ heading: boundedCopy(48), stats: z.array(z.object({value:boundedCopy(16),label:boundedCopy(48)}).strict()).min(2).max(4) }).strict(),
  LedgerStats: z.object({chapter:boundedCopy(40),title:boundedCopy(60,8),body:boundedCopy(240),stats:z.array(z.object({value:boundedCopy(16),label:boundedCopy(48)}).strict()).min(2).max(4),clients:z.array(boundedCopy(80)).min(1).max(8),clientsLabel:boundedCopy(48)}).strict(),
  PricingTiers: z.object({eyebrow:boundedCopy(40),title:boundedCopy(60,8),titleLine2:boundedCopy(60,8),sub:boundedCopy(240),monthlyLabel:boundedCopy(32),yearlyLabel:boundedCopy(32),save:boundedCopy(48),featured:boundedCopy(32),perMo:boundedCopy(24),plans:z.array(z.object({name:boundedCopy(48),tagline:boundedCopy(160),monthly:boundedCopy(16),yearly:boundedCopy(16),featured:z.boolean(),features:z.array(boundedCopy(80)).min(1).max(8)}).strict()).min(1).max(4)}).strict(),
  ValueStrip: z.object({heading:boundedCopy(48),items:z.array(z.object({icon:boundedCopy(80),label:boundedCopy(80)}).strict()).min(2).max(6)}).strict(),
  AreaMarquee: z.object({heading:boundedCopy(48).optional(),items:z.array(boundedCopy(48)).min(2).max(12)}).strict(),
  FaqSplit: z.object({eyebrow:boundedCopy(40),title:boundedCopy(60,8),accent:boundedCopy(40),intro:boundedCopy(240),items:z.array(z.object({question:boundedCopy(120),answer:boundedCopy(400)}).strict()).min(1).max(8)}).strict(),
  CtaCenter: z.object({eyebrow:boundedCopy(40),title:boundedCopy(60,8),accent:boundedCopy(40).optional(),subtitle:boundedCopy(140),primaryCta:boundedCopy(24,4),secondaryCta:boundedCopy(24,4).optional()}).strict(),
  ServicesDark: z.object({eyebrow:boundedCopy(40),title:boundedCopy(60,8),accent:boundedCopy(40),services:z.array(z.object({icon:boundedCopy(80),title:boundedCopy(60),description:boundedCopy(200)}).strict()).min(1).max(8),allCta:boundedCopy(24,4).optional()}).strict(),
  ServiceRows: z.object({eyebrow:boundedCopy(40),title:boundedCopy(60,8),accent:boundedCopy(40),intro:boundedCopy(240),fromLabel:boundedCopy(48).optional(),cta:boundedCopy(24,4),services:z.array(z.object({icon:boundedCopy(80),title:boundedCopy(60),description:boundedCopy(200),from:boundedCopy(48),unit:boundedCopy(24)}).strict()).min(1).max(8)}).strict(),
  AreaGallery: z.object({eyebrow:boundedCopy(40),title:boundedCopy(60,8),accent:boundedCopy(40),areas:z.array(z.object({name:boundedCopy(60),postcodes:boundedCopy(80).optional(),note:boundedCopy(160),alt:boundedCopy(160)}).strict()).max(8),allCta:boundedCopy(24,4).optional()}).strict(),
  ProjectsGrid: z.object({title:boundedCopy(60,8),items:z.array(z.object({title:boundedCopy(80),description:boundedCopy(240),alt:boundedCopy(160)}).strict()).max(8),allCta:boundedCopy(24,4).optional()}).strict(),
  MaterialsLibrary: z.object({eyebrow:boundedCopy(40),title:boundedCopy(60,8),accent:boundedCopy(40),intro:boundedCopy(240),items:z.array(z.object({no:boundedCopy(24),name:boundedCopy(80),weight:boundedCopy(48),note:boundedCopy(160),alt:boundedCopy(160)}).strict()).max(8),primaryCta:boundedCopy(24,4),secondaryCta:boundedCopy(24,4)}).strict(),
  CollectionCards: z.object({eyebrow:boundedCopy(40),title:boundedCopy(60,8),items:z.array(z.object({name:boundedCopy(80),alt:boundedCopy(160)}).strict()).max(8)}).strict(),
  ProductShowcaseAlt: z.object({chapter:boundedCopy(40),title:boundedCopy(60,8),accent:boundedCopy(40),intro:boundedCopy(240),product:z.object({code:boundedCopy(24),name:boundedCopy(80),tagline:boundedCopy(80),capacity:boundedCopy(48),weight:boundedCopy(48),cycles:boundedCopy(48),price:boundedCopy(24),alt:boundedCopy(160)}).strict(),capacityLabel:boundedCopy(48),weightLabel:boundedCopy(48),cyclesLabel:boundedCopy(48),fromLabel:boundedCopy(48),features:z.array(boundedCopy(80)).max(3),cta:boundedCopy(24,4).optional()}).strict(),
} as const;

export function assertQualifiedComponentContentBudget(
  type: QualifiedContentBudgetComponent,
  content: unknown,
): void {
  const result = contentSchemas[type].safeParse(content);
  if (result.success) return;
  const detail = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`COMPONENT_CONTENT_BUDGET_EXCEEDED: ${type} -- ${detail}`);
}
