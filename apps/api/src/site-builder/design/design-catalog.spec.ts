import { describe, expect, it } from "vitest";
import {
  DESIGN_BRIEF_SCHEMA_VERSION,
  DESIGN_CATALOG_SCHEMA_VERSION,
  DESIGN_DNA_SCHEMA_VERSION,
  DESIGN_EVALUATION_SCHEMA_VERSION,
  DESIGN_OBSERVATION_SCHEMA_VERSION,
  DESIGN_RULE_SCHEMA_VERSION,
  DESIGN_TEMPLATE_FAMILY_SCHEMA_VERSION,
  designTemplateFamilyDigest,
  finalizeDesignCatalog,
  hasDesignEvaluationHardFailures,
  validateDesignEvaluation,
  validateDesignObservation,
  validateDesignRule,
} from "@global/contracts";
import { resolveDesignBriefFromCatalog } from "./catalog";

function observation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    prohibitedSourceSpecificTraits: ["do not reproduce branded illustration treatment"],
    ...overrides,
  };
}

function rule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function family(status: "approved" | "draft" = "approved"): Record<string, unknown> {
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
    motionPolicy: { intensity: "low", allowed: ["fade"], forbidden: ["parallax"] },
    qualityBaselineId: "foundation-quality-v1",
    sourceManifestIds: ["platform-study-1"],
  };
}

function catalog(status: "approved" | "draft" = "approved") {
  return finalizeDesignCatalog({
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
        surfaces: { cardStyle: "bordered", borderWeight: "hairline", radius: "subtle" },
        imagery: {
          preferredSubjects: ["product"],
          cropModes: ["cover"],
          backgroundPolicy: "light",
          maxGeneratedMediaRatio: 0,
        },
        motion: { intensity: "low", allowed: ["fade"], forbidden: ["parallax"] },
        antiPatterns: ["decorative dashboard chrome"],
      },
    ],
    families: [family(status)],
  });
}

function brief(value: ReturnType<typeof catalog>, overrides: Record<string, unknown> = {}) {
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
  it("accepts abstract observations but rejects source-reconstructable fields", () => {
    expect(validateDesignObservation(observation())).toMatchObject({
      heroComposition: "split",
    });
    expect(() =>
      validateDesignObservation(observation({ rawDom: "<main>source page</main>" })),
    ).toThrowError(/DESIGN_OBSERVATION_FORBIDDEN_CONTENT/);
  });

  it("requires a DesignRule to be supported by five independent contribution groups", () => {
    expect(validateDesignRule(rule())).toMatchObject({
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
      ),
    ).toThrowError(/DESIGN_RULE_INSUFFICIENT_EVIDENCE/);
  });

  it("resolves only an approved family when the frozen brief pins catalog and family digests", () => {
    const value = catalog();
    expect(resolveDesignBriefFromCatalog(value, brief(value))).toMatchObject({
      id: "foundation-preview",
      status: "approved",
    });

    expect(() =>
      resolveDesignBriefFromCatalog(value, brief(value, { catalogDigest: "0".repeat(64) })),
    ).toThrowError(/DESIGN_BRIEF_CATALOG_MISMATCH/);

    expect(() =>
      resolveDesignBriefFromCatalog(value, brief(value, {
        componentVariantOverrides: { HeroBanner: "cinematic" },
      })),
    ).toThrowError(/DESIGN_BRIEF_UNSUPPORTED_VARIANT/);
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
