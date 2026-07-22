import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { validateBlock } from "@global/contracts";

const { assertQualifiedComponentContentBudget } = createRequire(
  import.meta.url,
)("@global/contracts") as {
  assertQualifiedComponentContentBudget: (
    type: string,
    content: unknown,
  ) => void;
};

describe("M1-e-A technical baseline component contract", () => {
  it.each([
    {
      type: "HeroBanner",
      props: {
        headlineKey: "hero.headline",
        variant: "technical-grid",
      },
    },
    {
      type: "StatsBand",
      props: {
        stats: [
          { value: "20+", labelKey: "stats.years" },
          { value: "40+", labelKey: "stats.markets" },
        ],
        variant: "technical-grid",
      },
    },
    {
      type: "CtaBanner",
      props: {
        headlineKey: "cta.headline",
        cta: { labelKey: "cta.label" },
        variant: "technical-grid",
      },
    },
  ])("$type accepts the technical-grid variant", ({ type, props }) => {
    expect(() => validateBlock({ type, props } as never)).not.toThrow();
  });

  it.each(["HeroBanner", "StatsBand", "CtaBanner"])(
    "%s rejects an unregistered decorative variant",
    (type) => {
      const props =
        type === "HeroBanner"
          ? { headlineKey: "hero.headline", variant: "glass-orbit" }
          : type === "StatsBand"
            ? {
                stats: [
                  { value: "20+", labelKey: "stats.years" },
                  { value: "40+", labelKey: "stats.markets" },
                ],
                variant: "glass-orbit",
              }
            : {
                headlineKey: "cta.headline",
                cta: { labelKey: "cta.label" },
                variant: "glass-orbit",
              };
      expect(() => validateBlock({ type, props } as never)).toThrow(
        `INVALID_BLOCK_PROPS: ${type}`,
      );
    },
  );

  it("accepts content exactly at each component budget", () => {
    expect(() =>
      assertQualifiedComponentContentBudget("HeroBanner", {
        headline: "H".repeat(60),
        subhead: "S".repeat(140),
        cta: "C".repeat(24),
      }),
    ).not.toThrow();
    expect(() =>
      assertQualifiedComponentContentBudget("StatsBand", {
        stats: Array.from({ length: 4 }, () => ({
          value: "V".repeat(8),
          label: "L".repeat(24),
        })),
      }),
    ).not.toThrow();
    expect(() =>
      assertQualifiedComponentContentBudget("CtaBanner", {
        headline: "H".repeat(60),
        cta: "C".repeat(24),
      }),
    ).not.toThrow();
  });

  it.each([
    ["HeroBanner", { headline: "H".repeat(61) }],
    [
      "HeroBanner",
      { headline: Array.from({ length: 9 }, () => "word").join(" ") },
    ],
    [
      "StatsBand",
      {
        stats: Array.from({ length: 5 }, () => ({
          value: "20+",
          label: "Markets",
        })),
      },
    ],
    [
      "StatsBand",
      {
        stats: [
          { value: "V".repeat(9), label: "Metric" },
          { value: "2", label: "Metric" },
        ],
      },
    ],
    ["CtaBanner", { headline: "H".repeat(61), cta: "Contact" }],
    [
      "CtaBanner",
      {
        headline: "Ready to discuss your project",
        cta: Array.from({ length: 5 }, () => "go").join(" "),
      },
    ],
  ])("%s rejects copy beyond its content budget", (type, content) => {
    expect(() => assertQualifiedComponentContentBudget(type, content)).toThrow(
      `COMPONENT_CONTENT_BUDGET_EXCEEDED: ${type}`,
    );
  });
});
