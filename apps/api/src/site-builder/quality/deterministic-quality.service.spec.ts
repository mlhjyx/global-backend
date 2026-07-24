import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deriveCopySlotDefinitions } from "../assembly/copy-slot-derivation";
import { loadQualifiedComponentTemplates } from "../assembly/qualified-component-templates";
import { STATIC_DESIGN_CATALOG_V2 } from "../design/catalog";
import { buildM1ebGoldenFixtures } from "../design/m1eb-golden";
import type { PublishableClaimSnapshot } from "../publishable-claim-snapshot";
import { DeterministicQualityService } from "./deterministic-quality.service";
import type { StorageQualityArtifactSink } from "./quality-artifact-sink";

describe("DeterministicQualityService replay fence", () => {
  it("revalidates the current candidate before accepting a checkpoint", async () => {
    const repositoryRoot = path.resolve(
      new URL("../../../../../", import.meta.url).pathname,
    );
    const fixture = (await buildM1ebGoldenFixtures(repositoryRoot)).find(
      ({ id }) => id === "natural-origin-rich",
    );
    if (!fixture) throw new Error("golden fixture missing");
    const claimSnapshot: PublishableClaimSnapshot = {
      schemaVersion: "site-builder-publishable-claim-snapshot/v1",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      siteId: "22222222-2222-4222-8222-222222222222",
      companyProfileId: "33333333-3333-4333-8333-333333333333",
      buildRunId: "44444444-4444-4444-8444-444444444444",
      capturedAt: "2026-07-24T00:00:00.000Z",
      digest:
        fixture.spec.copyBundleSet?.bundles.en?.claimSnapshot.digest ??
        "a".repeat(64),
      items: [],
    };
    const loadCheckpoint = vi.fn();
    const service = new DeterministicQualityService({
      loadCheckpoint,
    } as unknown as StorageQualityArtifactSink);
    await expect(
      service.evaluate({
        spec: fixture.spec,
        buildRoot: "/not-reached",
        basePath: "/preview/acme/",
        candidateSpecDigest: "c".repeat(64),
        designBriefDigest: fixture.designBrief.digest,
        round: 0,
        artifactPrefix: "site/attempt/quality/round-0",
        validation: {
          designBrief: fixture.designBrief,
          catalog: STATIC_DESIGN_CATALOG_V2,
          claimSnapshot,
          copySlots: deriveCopySlotDefinitions({
            brief: fixture.designBrief,
            catalog: STATIC_DESIGN_CATALOG_V2,
            templates: loadQualifiedComponentTemplates(repositoryRoot),
          }),
        },
      }),
    ).rejects.toThrow("candidateSpecDigest mismatch");
    expect(loadCheckpoint).not.toHaveBeenCalled();
  });
});
