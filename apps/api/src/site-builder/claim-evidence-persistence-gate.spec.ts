import { describe, expect, it, vi } from "vitest";
import { gateCertificationFactsForPersistence } from "./claim-evidence-persistence-gate";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SITE_ID = "22222222-2222-4222-8222-222222222222";
const ASSET_ID = "33333333-3333-4333-8333-333333333333";

function fact(
  input: {
    key?: string;
    value?: string;
    assetId?: string;
  } = {},
) {
  return {
    key: input.key ?? "certifications",
    value: input.value ?? "ISO 9001 certified",
    evidence: {
      version: 2,
      evidenceRefId: "ref-1",
      sourceId: "snapshot-1",
      sourceType: "upload",
      sourceRole: "fact_candidate",
      hashAlgorithm: "sha256",
      contentHash: "a".repeat(64),
      quote: input.value ?? "ISO 9001 certified",
      selector: { start: 0, end: 18 },
      ...(input.assetId === undefined ? {} : { assetId: input.assetId }),
    },
  };
}

describe("gateCertificationFactsForPersistence", () => {
  it.each([
    ["missing asset", null, undefined],
    ["wrong kind", { kind: "doc" }, ASSET_ID],
    ["not ready", { processingStatus: "processing" }, ASSET_ID],
    ["deleted", { deletedAt: new Date() }, ASSET_ID],
    ["cross site", { siteId: "44444444-4444-4444-8444-444444444444" }, ASSET_ID],
    ["cross tenant", { workspaceId: "55555555-5555-4555-8555-555555555555" }, ASSET_ID],
  ])("downgrades certification with %s", async (_label, override, assetId) => {
    const getAsset = vi.fn(async () =>
      override === null
        ? null
        : {
            id: ASSET_ID,
            workspaceId: WORKSPACE_ID,
            siteId: SITE_ID,
            kind: "cert",
            processingStatus: "ready",
            deletedAt: null,
            ...override,
          },
    );

    const result = await gateCertificationFactsForPersistence(
      { getAsset },
      {
        workspaceId: WORKSPACE_ID,
        siteId: SITE_ID,
        facts: [fact({ assetId })] as never,
      },
    );

    expect(result.factSheet).toEqual([]);
    expect(result.gaps).toEqual([
      expect.objectContaining({
        field: "certifications",
        reason: "unverified_certification",
      }),
    ]);
  });

  it("keeps a certification only while the exact ready cert Asset row is locked", async () => {
    const getAsset = vi.fn(async () => ({
      id: ASSET_ID,
      workspaceId: WORKSPACE_ID,
      siteId: SITE_ID,
      kind: "cert",
      processingStatus: "ready",
      deletedAt: null,
    }));
    const certification = fact({ assetId: ASSET_ID });

    const result = await gateCertificationFactsForPersistence(
      { getAsset },
      {
        workspaceId: WORKSPACE_ID,
        siteId: SITE_ID,
        facts: [certification] as never,
      },
    );

    expect(result).toEqual({ factSheet: [certification], gaps: [] });
    expect(getAsset).toHaveBeenCalledWith(ASSET_ID);
  });

  it("does not require an Asset for non-certification facts", async () => {
    const getAsset = vi.fn();
    const capability = fact({
      key: "main_products",
      value: "Industrial pumps",
    });

    const result = await gateCertificationFactsForPersistence(
      { getAsset },
      {
        workspaceId: WORKSPACE_ID,
        siteId: SITE_ID,
        facts: [capability] as never,
      },
    );

    expect(result).toEqual({ factSheet: [capability], gaps: [] });
    expect(getAsset).not.toHaveBeenCalled();
  });
});
