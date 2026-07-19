import { describe, expect, it, vi } from "vitest";
import { COPY_BUNDLE_SET_SCHEMA_VERSION } from "@global/contracts";
import { buildPublishableClaimSnapshot } from "./publishable-claim-snapshot";
import {
  CopyBundleGenerationError,
  CopyBundleService,
  type CopySlotGenerator,
} from "./copy-bundle.service";

const NOW = new Date("2026-07-19T12:00:00Z");
const snapshot = buildPublishableClaimSnapshot({
  workspaceId: "11111111-1111-4111-8111-111111111111",
  siteId: "22222222-2222-4222-8222-222222222222",
  companyProfileId: "33333333-3333-4333-8333-333333333333",
  buildRunId: "44444444-4444-4444-8444-444444444444",
  capturedAt: NOW,
  candidates: [],
});

const slots = [
  {
    key: "home.hero.headline",
    type: "plain_text" as const,
    maxGraphemes: 50,
    factual: false,
  },
  {
    key: "home.hero.cta",
    type: "cta_label" as const,
    maxGraphemes: 24,
    factual: false,
  },
];

function generator(failLocale?: string): CopySlotGenerator {
  return {
    generateSlot: vi.fn(async (input) => {
      if (input.locale === failLocale) throw new Error("model unavailable");
      return {
        content:
          input.locale === "de-DE"
            ? `${input.slot.key} deutsch`
            : `${input.slot.key} english`,
        claimRefs: [],
      };
    }),
  };
}

describe("CopyBundleService", () => {
  it("generates every locale and slot from the frozen Claim snapshot only", async () => {
    const model = generator();
    const result = await new CopyBundleService(model, () => NOW).generate({
      locales: ["en", "de-DE"],
      sourceLocale: "en",
      snapshotId: "55555555-5555-4555-8555-555555555555",
      snapshot,
      slots,
      approvedOutboundDomains: [],
    });

    expect(result.set.schemaVersion).toBe(COPY_BUNDLE_SET_SCHEMA_VERSION);
    expect(Object.keys(result.set.bundles)).toEqual(["en", "de-DE"]);
    expect(result.degradedLocales).toEqual([]);
    expect(model.generateSlot).toHaveBeenCalledTimes(4);
    expect(vi.mocked(model.generateSlot).mock.calls[0][0]).toMatchObject({
      snapshot: { digest: snapshot.digest, items: [] },
    });
    expect(vi.mocked(model.generateSlot).mock.calls[0][0]).not.toHaveProperty(
      "factSheet",
    );
  });

  it("omits a failed optional locale and reports deterministic degradation", async () => {
    const result = await new CopyBundleService(
      generator("de-DE"),
      () => NOW,
    ).generate({
      locales: ["en", "de-DE"],
      sourceLocale: "en",
      snapshotId: "55555555-5555-4555-8555-555555555555",
      snapshot,
      slots,
      approvedOutboundDomains: [],
    });
    expect(Object.keys(result.set.bundles)).toEqual(["en"]);
    expect(result.degradedLocales).toEqual(["de-DE"]);
  });

  it("fails the build when the source/default locale fails", async () => {
    await expect(
      new CopyBundleService(generator("en"), () => NOW).generate({
        locales: ["en", "de-DE"],
        sourceLocale: "en",
        snapshotId: "55555555-5555-4555-8555-555555555555",
        snapshot,
        slots,
        approvedOutboundDomains: [],
      }),
    ).rejects.toMatchObject<Partial<CopyBundleGenerationError>>({
      code: "COPY_DEFAULT_LOCALE_FAILED",
    });
  });
});
