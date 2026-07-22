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
