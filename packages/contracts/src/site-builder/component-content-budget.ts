import { z } from "zod";

export const QUALIFIED_COMPONENT_CONTENT_BUDGETS = Object.freeze({
  HeroBanner: Object.freeze({ headline: 72, subhead: 180, cta: 32 }),
  StatsBand: Object.freeze({ minItems: 2, maxItems: 4, value: 16, label: 48 }),
  CtaBanner: Object.freeze({ headline: 100, cta: 32 }),
});

export type QualifiedContentBudgetComponent =
  keyof typeof QUALIFIED_COMPONENT_CONTENT_BUDGETS;

const nonempty = (max: number) => z.string().trim().min(1).max(max);

const contentSchemas = {
  HeroBanner: z
    .object({
      headline: nonempty(
        QUALIFIED_COMPONENT_CONTENT_BUDGETS.HeroBanner.headline,
      ),
      subhead: nonempty(
        QUALIFIED_COMPONENT_CONTENT_BUDGETS.HeroBanner.subhead,
      ).optional(),
      cta: nonempty(
        QUALIFIED_COMPONENT_CONTENT_BUDGETS.HeroBanner.cta,
      ).optional(),
    })
    .strict(),
  StatsBand: z
    .object({
      stats: z
        .array(
          z
            .object({
              value: nonempty(
                QUALIFIED_COMPONENT_CONTENT_BUDGETS.StatsBand.value,
              ),
              label: nonempty(
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
      headline: nonempty(
        QUALIFIED_COMPONENT_CONTENT_BUDGETS.CtaBanner.headline,
      ),
      cta: nonempty(QUALIFIED_COMPONENT_CONTENT_BUDGETS.CtaBanner.cta),
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
