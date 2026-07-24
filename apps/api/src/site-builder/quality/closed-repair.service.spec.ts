import {
  DESIGN_EVALUATION_V2_SCHEMA_VERSION,
  QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
  qualityArtifactSetDigest,
  validateRepairOptionCatalog,
  type DesignEvaluationV2,
  type QualityArtifactSetV1,
} from "@global/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { loadQualifiedComponentTemplates } from "../assembly/qualified-component-templates";
import { controlledAssetUrls } from "../controlled-asset-materializer";
import { STATIC_DESIGN_CATALOG_V2 } from "../design/catalog";
import {
  buildM1ebGoldenFixtures,
  type M1ebGoldenFixture,
} from "../design/m1eb-golden";
import type { PublishableClaimSnapshot } from "../publishable-claim-snapshot";
import { releaseSpecDigest } from "../release-artifact";
import {
  ClosedRepairService,
  type ClosedRepairContext,
} from "./closed-repair.service";

const repositoryRoot = new URL("../../../../../", import.meta.url).pathname;
let fixture: M1ebGoldenFixture;
let context: ClosedRepairContext;
let artifactSet: QualityArtifactSetV1;
let evaluation: DesignEvaluationV2;

beforeAll(async () => {
  fixture = (await buildM1ebGoldenFixtures(repositoryRoot)).find(
    (candidate) => candidate.mode === "sparse",
  )!;
  const claimIdentity = fixture.spec.copyBundleSet!.bundles.en!.claimSnapshot;
  const claimSnapshot: PublishableClaimSnapshot = {
    schemaVersion: "site-builder-publishable-claim-snapshot/v1",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    siteId: "22222222-2222-4222-8222-222222222222",
    companyProfileId: "33333333-3333-4333-8333-333333333333",
    buildRunId: "44444444-4444-4444-8444-444444444444",
    capturedAt: "2026-07-24T00:00:00.000Z",
    digest: claimIdentity.digest,
    items: [],
  };
  context = {
    brief: fixture.designBrief,
    catalog: STATIC_DESIGN_CATALOG_V2,
    spec: fixture.spec,
    copyBundleSet: fixture.spec.copyBundleSet!,
    templates: loadQualifiedComponentTemplates(repositoryRoot),
    assets: fixture.spec.assets,
    assetUrls: controlledAssetUrls(fixture.spec.assets),
    claimSnapshot,
    siteName: fixture.spec.site.seoGlobal.siteName,
  };
  const evidence = {
    artifactId: "deterministic-evaluation",
    objectKey: "quality/round-0/deterministic-evaluation.json",
    sha256: "a".repeat(64),
    sizeBytes: 128,
    mimeType: "application/json" as const,
    kind: "deterministic_evaluation" as const,
    target: {
      locale: "en",
      pageId: fixture.spec.pages[0]!.id,
    },
  };
  const artifactDraft = {
    schemaVersion: QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
    candidateSpecDigest: releaseSpecDigest(fixture.spec),
    designBriefDigest: fixture.designBrief.digest,
    round: 0 as const,
    expectedTargets: fixture.spec.site.locales.flatMap((locale) =>
      fixture.spec.pages.map((page) => ({ locale, pageId: page.id })),
    ),
    artifacts: [
      ...fixture.spec.site.locales.flatMap((locale) =>
        fixture.spec.pages.flatMap((page) =>
          ([375, 768, 1440] as const).map((breakpoint) => ({
            artifactId: `screenshot-${locale}-${page.id}-${breakpoint}`,
            objectKey: `quality/round-0/${locale}-${page.id}-${breakpoint}.png`,
            sha256: releaseSpecDigest({ locale, pageId: page.id, breakpoint }),
            sizeBytes: 1024,
            mimeType: "image/png" as const,
            kind: "screenshot" as const,
            target: { locale, pageId: page.id, breakpoint },
          })),
        ),
      ),
      evidence,
    ],
  };
  artifactSet = {
    ...artifactDraft,
    artifactSetDigest: qualityArtifactSetDigest(artifactDraft),
  };
  evaluation = {
    schemaVersion: DESIGN_EVALUATION_V2_SCHEMA_VERSION,
    candidateSpecDigest: artifactSet.candidateSpecDigest,
    designBriefDigest: artifactSet.designBriefDigest,
    artifactSetDigest: artifactSet.artifactSetDigest,
    round: 0,
    evaluatorVersion: "p4-deterministic@1.0.0",
    deterministic: {
      status: "failed",
      hardFailures: [
        {
          source: "deterministic",
          severity: "blocker",
          ruleCode: "GENERICNESS_CARD_DENSITY",
          target: { locale: "en", pageId: fixture.spec.pages[0]!.id },
          evidenceRef: { artifactId: evidence.artifactId },
        },
      ],
      findings: [],
    },
    aesthetic: {
      status: "unavailable",
      overallScore: null,
      dimensions: null,
      unavailableReason: "protocol_mismatch",
      findings: [],
    },
  };
});

describe("ClosedRepairService", () => {
  it("exposes only closed repair choices and applies the selected server candidate", () => {
    const service = new ClosedRepairService();
    const generated = service.generateCatalog({
      context,
      evaluation,
      artifactSet,
    });

    expect(validateRepairOptionCatalog(generated.catalog)).toEqual(
      generated.catalog,
    );
    expect(generated.catalog.options.length).toBeGreaterThan(0);
    expect(
      generated.catalog.options.every(
        (option) =>
          ["approved_blueprint", "bounded_item_count"].includes(
            option.change.kind,
          ) &&
          Object.keys(option).sort().join(",") ===
            "addresses,change,optionId,rank,resultSpecDigest",
      ),
    ).toBe(true);

    const selected = service.applySelection({
      generated,
      selection: { optionId: generated.catalog.options[0]!.optionId },
      expectedArtifactSetDigest: artifactSet.artifactSetDigest,
    });
    expect(releaseSpecDigest(selected.spec)).toBe(
      generated.catalog.options[0]!.resultSpecDigest,
    );
    expect(selected.spec.site.familyId).toBe(fixture.spec.site.familyId);
    expect(selected.designBrief.familyId).toBe(fixture.designBrief.familyId);
  });

  it("rejects extra model fields, stale evidence, and catalog tampering", () => {
    const service = new ClosedRepairService();
    const generated = service.generateCatalog({
      context,
      evaluation,
      artifactSet,
    });
    const optionId = generated.catalog.options[0]!.optionId;

    expect(() =>
      service.applySelection({
        generated,
        selection: {
          optionId,
          suggestedPatch: { css: "body{display:none}" },
        } as never,
        expectedArtifactSetDigest: artifactSet.artifactSetDigest,
      }),
    ).toThrow("REPAIR_OPTION_SELECTION_INVALID");
    expect(() =>
      service.applySelection({
        generated,
        selection: { optionId },
        expectedArtifactSetDigest: "b".repeat(64),
      }),
    ).toThrow("REPAIR_OPTION_SELECTION_INVALID");
    expect(() =>
      validateRepairOptionCatalog({
        ...generated.catalog,
        familyId: "another-family",
      }),
    ).toThrow("REPAIR_OPTION_CATALOG_INVALID");
  });

  it("fences a stale SiteSpec digest before generating options", () => {
    const service = new ClosedRepairService();
    expect(() =>
      service.generateCatalog({
        context: {
          ...context,
          spec: {
            ...context.spec,
            site: {
              ...context.spec.site,
              seoGlobal: { siteName: "tampered" },
            },
          },
        },
        evaluation,
        artifactSet,
      }),
    ).toThrow("QUALITY_REPAIR_CANDIDATE_FENCED");
  });

  it("does not claim a visual choice can repair a contract failure", () => {
    const service = new ClosedRepairService();
    const contractFailure = structuredClone(evaluation);
    contractFailure.deterministic.hardFailures[0]!.ruleCode =
      "CONTRACT_INVALID";
    expect(() =>
      service.generateCatalog({
        context,
        evaluation: contractFailure,
        artifactSet,
      }),
    ).toThrow("QUALITY_REPAIR_OPTION_UNAVAILABLE");
  });
});
