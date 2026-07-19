import { describe, expect, it } from "vitest";
import {
  COPY_BUNDLE_SCHEMA_VERSION,
  COPY_SLOT_CATALOG_VERSION,
  CopyBundleContractError,
  copyBundleInputHash,
  copyBundleToLegacyStrings,
  finalizeCopyBundle,
  resolveSiteCopyBundle,
  validateCopyBundle,
  type CopyBundleDraftV1,
} from "@global/contracts";

const SNAPSHOT_ID = "11111111-1111-4111-8111-111111111111";
const CLAIM_ID = "22222222-2222-4222-8222-222222222222";

function draft(overrides: Partial<CopyBundleDraftV1> = {}): CopyBundleDraftV1 {
  return {
    schemaVersion: COPY_BUNDLE_SCHEMA_VERSION,
    slotCatalogVersion: COPY_SLOT_CATALOG_VERSION,
    locale: "de-DE",
    sourceLocale: "en",
    status: "complete",
    claimSnapshot: {
      id: SNAPSHOT_ID,
      digest: "a".repeat(64),
    },
    inputHash: copyBundleInputHash({
      claimSnapshotDigest: "a".repeat(64),
      locale: "de-DE",
      sourceLocale: "en",
      slots: [
        {
          key: "home.hero.headline",
          type: "plain_text",
          maxGraphemes: 50,
          factual: true,
        },
      ],
    }),
    slots: {
      "home.hero.headline": {
        type: "plain_text",
        maxGraphemes: 50,
        factual: true,
        content: "ACME Pumpen mit 15 bar",
        claimRefs: [CLAIM_ID],
      },
    },
    ...overrides,
  };
}

const context = {
  supportedLocales: ["en", "de-DE", "ar"],
  claims: new Map([[CLAIM_ID, { protectedTokens: ["ACME", "15 bar"] }]]),
  approvedOutboundDomains: ["example.com"],
};

describe("CopyBundle v1 contract", () => {
  it("produces a deterministic digest and legacy projection", () => {
    const left = finalizeCopyBundle(draft(), context);
    const right = finalizeCopyBundle(
      draft({ slots: { ...draft().slots } }),
      context,
    );

    expect(left.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(right.digest).toBe(left.digest);
    expect(copyBundleToLegacyStrings(left)).toEqual({
      "home.hero.headline": "ACME Pumpen mit 15 bar",
    });
  });

  it("accepts restricted rich text with internal or approved links", () => {
    const value = draft({
      slots: {
        "about.body": {
          type: "rich_text",
          maxGraphemes: 80,
          factual: false,
          claimRefs: [],
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Mehr " },
                  {
                    type: "link",
                    href: "https://example.com/details",
                    content: [{ type: "text", text: "Details" }],
                  },
                ],
              },
            ],
          },
        },
      },
    });
    expect(() => validateCopyBundle(value, context)).not.toThrow();
  });

  it("rejects unsupported locales instead of silently falling back", () => {
    expect(() =>
      validateCopyBundle(draft({ locale: "fr-FR" }), context),
    ).toThrowError(/COPY_LOCALE_UNSUPPORTED/);
  });

  it("rejects over-budget output instead of truncating it", () => {
    const value = draft();
    value.slots["home.hero.headline"].content = "A".repeat(51);
    expect(() => validateCopyBundle(value, context)).toThrowError(
      /COPY_SLOT_BUDGET_EXCEEDED/,
    );
  });

  it("requires factual slots to cite only snapshot claims", () => {
    const missing = draft();
    missing.slots["home.hero.headline"].claimRefs = [];
    expect(() => validateCopyBundle(missing, context)).toThrowError(
      /COPY_CLAIM_REF_REQUIRED/,
    );

    const unknown = draft();
    unknown.slots["home.hero.headline"].claimRefs = ["unknown"];
    expect(() => validateCopyBundle(unknown, context)).toThrowError(
      /COPY_CLAIM_REF_UNKNOWN/,
    );
  });

  it("preserves canonical fact tokens before tone or translation", () => {
    const value = draft();
    value.slots["home.hero.headline"].content = "ACME Pumpen";
    expect(() => validateCopyBundle(value, context)).toThrowError(
      /COPY_PROTECTED_FACT_CHANGED/,
    );
  });

  it("rejects raw HTML and links to unapproved outbound domains", () => {
    const html = draft();
    html.slots["home.hero.headline"].content = "<b>ACME 15 bar</b>";
    expect(() => validateCopyBundle(html, context)).toThrowError(
      /COPY_RAW_HTML_FORBIDDEN/,
    );

    const outbound = draft({
      slots: {
        x: {
          type: "rich_text",
          maxGraphemes: 80,
          factual: false,
          claimRefs: [],
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "link",
                    href: "https://tracker.invalid/x",
                    content: [{ type: "text", text: "x" }],
                  },
                ],
              },
            ],
          },
        },
      },
    });
    expect(() => validateCopyBundle(outbound, context)).toThrowError(
      /COPY_OUTBOUND_DOMAIN_FORBIDDEN/,
    );
  });

  it("exposes stable machine-readable error codes", () => {
    try {
      validateCopyBundle(draft({ locale: "fr" }), context);
    } catch (error) {
      expect(error).toBeInstanceOf(CopyBundleContractError);
      expect((error as CopyBundleContractError).code).toBe(
        "COPY_LOCALE_UNSUPPORTED",
      );
    }
  });

  it("dual-reads authoritative v1 bundles before the legacy string projection", () => {
    const bundle = finalizeCopyBundle(draft(), context);
    const spec = {
      copyBundles: { "de-DE": { "home.hero.headline": "legacy" } },
      copyBundleSet: {
        schemaVersion: "site-builder-copy-bundle-set/v1" as const,
        sourceLocale: "en",
        bundles: { "de-DE": bundle },
      },
    };
    expect(resolveSiteCopyBundle(spec, "de-DE")).toEqual({
      "home.hero.headline": "ACME Pumpen mit 15 bar",
    });
    expect(
      resolveSiteCopyBundle(
        { copyBundles: { en: { headline: "legacy only" } } },
        "en",
      ),
    ).toEqual({ headline: "legacy only" });
    expect(() => resolveSiteCopyBundle(spec, "en")).toThrowError(
      /COPY_LOCALE_MISSING/,
    );
  });
});
