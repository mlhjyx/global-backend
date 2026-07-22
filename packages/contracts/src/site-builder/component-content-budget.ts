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
