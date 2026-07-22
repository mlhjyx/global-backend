import { describe, expect, it } from "vitest";
import {
  DESIGN_BRIEF_SCHEMA_VERSION,
  DESIGN_CATALOG_SCHEMA_VERSION,
  DESIGN_DNA_SCHEMA_VERSION,
  DESIGN_EVALUATION_SCHEMA_VERSION,
  DESIGN_OBSERVATION_SCHEMA_VERSION,
  DESIGN_RULE_SCHEMA_VERSION,
  DESIGN_SOURCE_MANIFEST_SCHEMA_VERSION,
  DESIGN_TEMPLATE_FAMILY_SCHEMA_VERSION,
  designTemplateFamilyDigest,
  finalizeDesignCatalog,
  hasDesignEvaluationHardFailures,
  validateDesignEvaluation,
  validateDesignObservation,
  validateDesignRule,
} from "@global/contracts";
import {
  STATIC_DESIGN_CATALOG,
  resolveDesignBriefFromCatalog,
} from "./catalog";

function observation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: DESIGN_OBSERVATION_SCHEMA_VERSION,
    sourceManifestId: "platform-study-1",
    observedAt: "2026-07-22T00:00:00.000Z",
    heroComposition: "split",
    hierarchyScale: { headlineBand: "display", bodyMeasureBand: "reading" },
    sectionRhythm: ["airy", "proof"],
    imageStrategy: {
      ratioBands: ["3:2"],
      focalPattern: "product-and-proof",
      treatment: "high-contrast",
    },
    ctaStrategy: { primaryCount: 1, placementPattern: "hero-and-terminal" },
    motionIntensity: "subtle",
    mobileReflow: ["stack proof below primary action"],
    reusablePrinciples: ["pair a product claim with one visible proof element"],
    prohibitedSourceSpecificTraits: [
      "do not reproduce branded illustration treatment",
    ],
    ...overrides,
  };
}

function rule(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: DESIGN_RULE_SCHEMA_VERSION,
    id: "proof-near-primary-action",
    summary: "Place one abstract proof element near the primary action.",
    sourceContributionGroups: ["a", "b", "c", "d", "e"],
    evidence: {
      independentSourceCount: 5,
      generalized: true,
      selfReimplementable: true,
      nonNeighboring: true,
    },
    ...overrides,
  };
}

function ruleValidationContext(groups = ["a", "b", "c", "d", "e"]) {
  return {
    sourceManifests: groups.map((sourceContributionGroup) => ({
      schemaVersion: DESIGN_SOURCE_MANIFEST_SCHEMA_VERSION,
      id: `platform-study-${sourceContributionGroup}`,
      title: `Platform study ${sourceContributionGroup}`,
      sourceClass: "platform_original",
      capturedAt: "2026-07-22T00:00:00.000Z",
      licenseSpdx: "LicenseRef-Platform-Original",
      licenseEvidencePath: `licenses/${sourceContributionGroup}.txt`,
      allowedUses: ["visual_analysis"],
      prohibitedUses: ["training"],
      retentionPolicy: "manifest_only",
      trainingPolicy: "prohibited",
      sourceContributionGroup,
      externalAssets: [],
      reviewer: "design-governance",
    })),
  };
}

function family(
  status: "approved" | "draft" = "approved",
): Record<string, unknown> {
  return {
    schemaVersion: DESIGN_TEMPLATE_FAMILY_SCHEMA_VERSION,
    id: "foundation-preview",
    version: "1.0.0",
    status,
    designDnaId: "foundation-dna",
    compatibleArchetypes: ["industrial-b2b"],
    compatibleIndustries: ["industrial"],
    stylePresetIds: ["foundation-light"],
    blueprints: {
      home: [
        {
          id: "home-default",
          sectionRoles: ["hero", "proof", "cta"],
          allowedComponents: ["HeroBanner", "StatsBand", "CtaBanner"],
        },
      ],
    },
    componentVariants: { HeroBanner: ["split"] },
    adjacencyRules: ["hero must be followed by proof or product"],
    contentBudgets: { "home.hero": { minimum: 20, maximum: 80 } },
    assetRequirements: [],
    demoVisualPackIds: [],
    motionPolicy: {
      intensity: "low",
      allowed: ["fade"],
      forbidden: ["parallax"],
    },
    qualityBaselineId: "foundation-quality-v1",
    sourceManifestIds: ["platform-study-a"],
  };
}

function catalog(status: "approved" | "draft" = "approved") {
  return finalizeDesignCatalog(
    {
      schemaVersion: DESIGN_CATALOG_SCHEMA_VERSION,
      catalogVersion: "2026.07.0",
      designRules: [rule()],
      designDnas: [
        {
          schemaVersion: DESIGN_DNA_SCHEMA_VERSION,
          id: "foundation-dna",
          name: "Foundation",
          ruleIds: ["proof-near-primary-action"],
          hierarchy: {
            displayScale: "balanced",
            headingContrast: "medium",
            maxReadingWidthRem: 44,
          },
          spatialRhythm: {
            sectionGapPx: [48, 96],
            contentGapPx: [16, 32],
            density: "balanced",
          },
          composition: {
            heroModes: ["split"],
            imageTextRatios: ["3:2"],
            alignmentBias: "left",
          },
          surfaces: {
            cardStyle: "bordered",
            borderWeight: "hairline",
            radius: "subtle",
          },
          imagery: {
            preferredSubjects: ["product"],
            cropModes: ["cover"],
            backgroundPolicy: "light",
            maxGeneratedMediaRatio: 0,
          },
          motion: {
            intensity: "low",
            allowed: ["fade"],
            forbidden: ["parallax"],
          },
          antiPatterns: ["decorative dashboard chrome"],
        },
      ],
      families: [family(status)],
    },
    ruleValidationContext(),
  );
}

function brief(
  value: ReturnType<typeof catalog>,
  overrides: Record<string, unknown> = {},
) {
  const selected = value.families[0];
  return {
    schemaVersion: DESIGN_BRIEF_SCHEMA_VERSION,
    catalogVersion: value.catalogVersion,
    catalogDigest: value.digest,
    familyId: selected.id,
    familyVersion: selected.version,
    familyDigest: designTemplateFamilyDigest(selected),
    stylePresetId: "foundation-light",
    blueprintIds: { home: "home-default" },
    componentVariantOverrides: { HeroBanner: "split" },
    assetStrategy: {
      availableRoles: ["hero"],
      allowGeneratedImages: false,
      allowVideo: false,
    },
    contentBudgets: { "home.hero": { minimum: 20, maximum: 80 } },
    localePolicy: ["en"],
    motionIntensity: "low",
    variationSeed: "build-immutable-seed",
    reasons: ["compatible with industrial-b2b"],
    warnings: [],
    ...overrides,
  };
}

describe("DI-0 clean-room contracts and static catalog", () => {
  it("exposes an immutable empty catalog foundation rather than an unreviewed family", () => {
    expect(STATIC_DESIGN_CATALOG.families).toEqual([]);
    expect(Object.isFrozen(STATIC_DESIGN_CATALOG)).toBe(true);
    expect(Object.isFrozen(STATIC_DESIGN_CATALOG.families)).toBe(true);
  });

  it("accepts abstract observations but rejects source-reconstructable fields", () => {
    expect(validateDesignObservation(observation())).toMatchObject({
      heroComposition: "split",
    });
    expect(() =>
      validateDesignObservation(
        observation({ rawDom: "<main>source page</main>" }),
      ),
    ).toThrowError(/DESIGN_OBSERVATION_FORBIDDEN_CONTENT/);
    expect(() =>
      validateDesignObservation(
        observation({
          imageStrategy: {
            ratioBands: ["3:2"],
            focalPattern: "<h1>Source-specific headline</h1>",
            treatment: "high-contrast",
          },
        }),
      ),
    ).toThrowError(/DESIGN_OBSERVATION_FORBIDDEN_CONTENT/);
  });

  it("requires a DesignRule to be supported by five independent contribution groups", () => {
    expect(validateDesignRule(rule(), ruleValidationContext())).toMatchObject({
      id: "proof-near-primary-action",
    });
    expect(() =>
      validateDesignRule(
        rule({
          sourceContributionGroups: ["a", "b", "c", "d"],
          evidence: {
            independentSourceCount: 4,
            generalized: true,
            selfReimplementable: true,
            nonNeighboring: true,
          },
        }),
        ruleValidationContext(),
      ),
    ).toThrowError(/DESIGN_RULE_INSUFFICIENT_EVIDENCE/);
    expect(() =>
      validateDesignRule(rule(), ruleValidationContext(["a", "b", "c", "d"])),
    ).toThrowError(/DESIGN_RULE_PROVENANCE_UNVERIFIED/);
  });

  it("freezes validated rule provenance into the catalog digest", () => {
    const value = catalog();
    const sourceManifests = ruleValidationContext().sourceManifests;
    const provenanceBoundDraft = {
      schemaVersion: DESIGN_CATALOG_SCHEMA_VERSION,
      catalogVersion: value.catalogVersion,
      designRules: value.designRules,
      designDnas: value.designDnas,
      families: value.families,
      sourceManifests,
    };
    const provenanceBoundCatalog = finalizeDesignCatalog(
      provenanceBoundDraft as never,
    );
    expect(
      (provenanceBoundCatalog as { sourceManifests?: unknown[] })
        .sourceManifests,
    ).toHaveLength(5);
    expect(() =>
      finalizeDesignCatalog({
        ...provenanceBoundDraft,
        sourceManifests: sourceManifests.slice(0, 4),
      } as never),
    ).toThrowError(/DESIGN_CATALOG_INVALID/);
  });

  it("resolves only an approved family when the frozen brief pins catalog and family digests", () => {
    const value = catalog();
    expect(resolveDesignBriefFromCatalog(value, brief(value))).toMatchObject({
      id: "foundation-preview",
      status: "approved",
    });

    expect(() =>
      resolveDesignBriefFromCatalog(
        value,
        brief(value, { catalogDigest: "0".repeat(64) }),
      ),
    ).toThrowError(/DESIGN_BRIEF_CATALOG_MISMATCH/);

    expect(() =>
      resolveDesignBriefFromCatalog(
        value,
        brief(value, {
          componentVariantOverrides: { HeroBanner: "cinematic" },
        }),
      ),
    ).toThrowError(/DESIGN_BRIEF_UNSUPPORTED_VARIANT/);

    expect(() =>
      resolveDesignBriefFromCatalog(
        value,
        brief(value, {
          contentBudgets: { "home.hero": { minimum: 20, maximum: 999 } },
        }),
      ),
    ).toThrowError(/DESIGN_BRIEF_UNSUPPORTED_BUDGET/);
  });

  it("keeps draft families unavailable even when their immutable digest matches", () => {
    const draftCatalog = catalog("draft");
    expect(() =>
      resolveDesignBriefFromCatalog(draftCatalog, brief(draftCatalog)),
    ).toThrowError(/DESIGN_BRIEF_FAMILY_UNAVAILABLE/);
  });

  it("preserves evaluation as a contract while exposing hard failures to a later release gate", () => {
    const evaluation = validateDesignEvaluation({
      schemaVersion: DESIGN_EVALUATION_SCHEMA_VERSION,
      overallScore: 91,
      dimensions: {
        hierarchy: 90,
        consistency: 92,
        spacing: 90,
        contrast: 96,
        imagery: 88,
        mobileComposition: 91,
        ctaClarity: 89,
        credibility: 92,
        originality: 90,
      },
      hardFailures: [
        {
          code: "CONTRAST_FAILURE",
          page: "home",
          breakpoint: 375,
          evidencePath: "evaluations/home-375.png",
        },
      ],
      findings: [],
    });
    expect(hasDesignEvaluationHardFailures(evaluation)).toBe(true);
  });
});
