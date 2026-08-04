import { describe, expect, it } from "vitest";

import {
  buildCopyGenerationContext,
  copyGenerationContextDigest,
} from "../copy-bundle.service";
import {
  COPY_TASK,
  isCopyTaskInputV2,
  type CopyTaskInput,
  type CopyTaskOutput,
} from "./copy";

function input(): CopyTaskInput {
  const context = buildCopyGenerationContext({
    locale: "en",
    intake: {
      industry: "industrial equipment",
      products: ["pumps"],
      targetMarkets: ["engineering buyers"],
    },
    brandProfile: {
      id: "brand-profile-1",
      version: 3,
      tone: { voice: "clear and assured", style: ["concise", "technical"] },
    },
  });
  return {
    locale: "en",
    sourceLocale: "en",
    snapshotDigest: "a".repeat(64),
    claims: [],
    slots: [
      {
        key: "home.hero.headline",
        type: "plain_text",
        maxGraphemes: 48,
        factual: false,
      },
      {
        key: "home.hero.cta.label",
        type: "cta_label",
        maxGraphemes: 24,
        factual: false,
      },
    ],
    context,
    contextDigest: copyGenerationContextDigest(context),
  };
}

describe("COPY_TASK v2", () => {
  it("recognizes only digest-bound v2 frozen inputs", () => {
    expect(isCopyTaskInputV2(input())).toBe(true);
    expect(isCopyTaskInputV2(null)).toBe(false);
    expect(isCopyTaskInputV2({})).toBe(false);
    expect(
      isCopyTaskInputV2({ ...input(), contextDigest: "f".repeat(64) }),
    ).toBe(false);
  });

  it("binds audience, brand voice, prohibited assertions, and CTA policy", () => {
    const taskInput = input();

    expect(COPY_TASK.contractVersion).toBe(
      "site-builder-task-contract/site_builder.copy/v2",
    );
    expect(COPY_TASK.buildPrompt(taskInput)).toContain(
      JSON.stringify(taskInput.context),
    );
    expect(COPY_TASK.buildPrompt(taskInput)).toContain(taskInput.contextDigest);
  });

  it("accepts bounded non-factual creative copy and an allowlisted CTA", () => {
    expect(() =>
      COPY_TASK.validateOutput?.(input(), {
        slots: {
          "home.hero.headline": {
            content: "Clear engineering for confident decisions",
            claimRefs: [],
          },
          "home.hero.cta.label": {
            content: "Get in touch",
            claimRefs: [],
          },
        },
      }),
    ).not.toThrow();
  });

  it("allows audience vocabulary without treating it as company evidence", () => {
    expect(() =>
      COPY_TASK.validateOutput?.(input(), {
        slots: {
          "home.hero.headline": {
            content: "Pump selection for engineering buyers",
            claimRefs: [],
          },
          "home.hero.cta.label": {
            content: "Get in touch",
            claimRefs: [],
          },
        },
      }),
    ).not.toThrow();
  });

  it.each([
    "Market-leading pumps for 40 countries",
    "Best\u200B-in\u200B-class systems",
    "Flow for ４０ paths",
    "We build pumps for complex projects",
    "ISO 9001 certified quality",
    "CE ready for every project",
    "Guaranteed results for every buyer",
  ])(
    "rejects an unsupported assertion before canonicalization: %s",
    (content) => {
      expect(() =>
        COPY_TASK.validateOutput?.(input(), {
          slots: {
            "home.hero.headline": { content, claimRefs: [] },
            "home.hero.cta.label": {
              content: "Get in touch",
              claimRefs: [],
            },
          },
        }),
      ).toThrow("COPY_UNSUPPORTED_ASSERTION");
    },
  );

  it("rejects compatibility-width HTML markup", () => {
    expect(() =>
      COPY_TASK.validateOutput?.(input(), {
        slots: {
          "home.hero.headline": {
            content: "<ｓｃｒｉｐｔ>alert</ｓｃｒｉｐｔ>",
            claimRefs: [],
          },
          "home.hero.cta.label": {
            content: "Get in touch",
            claimRefs: [],
          },
        },
      }),
    ).toThrow("COPY_OUTPUT_CONTENT_MALFORMED");
  });

  it.each([
    "Visit https://example.com",
    "Email sales@example.com",
    "Call +1 555 123 4567",
  ])(
    "rejects contact data or links outside the CTA target contract: %s",
    (content) => {
      expect(() =>
        COPY_TASK.validateOutput?.(input(), {
          slots: {
            "home.hero.headline": { content, claimRefs: [] },
            "home.hero.cta.label": {
              content: "Get in touch",
              claimRefs: [],
            },
          },
        }),
      ).toThrow("COPY_UNSUPPORTED_CONTACT");
    },
  );

  it("rejects CTA text outside the frozen locale allowlist", () => {
    expect(() =>
      COPY_TASK.validateOutput?.(input(), {
        slots: {
          "home.hero.headline": {
            content: "Clear engineering for confident decisions",
            claimRefs: [],
          },
          "home.hero.cta.label": {
            content: "Buy now",
            claimRefs: [],
          },
        },
      }),
    ).toThrow("COPY_CTA_POLICY_VIOLATION");
  });

  it("rejects context digest drift before accepting model output", () => {
    expect(() =>
      COPY_TASK.validateOutput?.(
        { ...input(), contextDigest: "b".repeat(64) },
        {
          slots: {
            "home.hero.headline": {
              content: "Clear engineering for confident decisions",
              claimRefs: [],
            },
            "home.hero.cta.label": {
              content: "Get in touch",
              claimRefs: [],
            },
          },
        },
      ),
    ).toThrow("COPY_CONTEXT_DIGEST_MISMATCH");
  });

  it("rejects missing, extra, or malformed slots", () => {
    const taskInput = input();
    expect(() =>
      COPY_TASK.validateOutput?.(
        taskInput,
        undefined as unknown as CopyTaskOutput,
      ),
    ).toThrow("copy output has no slots");
    expect(() => COPY_TASK.validateOutput?.(taskInput, { slots: {} })).toThrow(
      "slot keys do not match",
    );
    expect(() =>
      COPY_TASK.validateOutput?.(taskInput, {
        slots: {
          "home.hero.headline": {
            content: null as unknown as string,
            claimRefs: [],
          },
          "home.hero.cta.label": {
            content: "Get in touch",
            claimRefs: [],
          },
        },
      }),
    ).toThrow("is malformed");
  });
});
