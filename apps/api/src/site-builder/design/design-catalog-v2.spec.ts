import { describe, expect, it } from "vitest";
import {
  DEMO_VISUAL_PACK_V2_SCHEMA_VERSION,
  DESIGN_BRIEF_V2_SCHEMA_VERSION,
  DESIGN_CATALOG_V2_SCHEMA_VERSION,
  DESIGN_DNA_SCHEMA_VERSION,
  DESIGN_RULE_SCHEMA_VERSION,
  DESIGN_SOURCE_MANIFEST_SCHEMA_VERSION,
  DESIGN_STYLE_PRESET_V2_SCHEMA_VERSION,
  DESIGN_TEMPLATE_FAMILY_V2_SCHEMA_VERSION,
  demoVisualPackV2Digest,
  designStylePresetV2Digest,
  designTemplateFamilyV2Digest,
  finalizeDesignBriefV2,
  finalizeDesignCatalogV2,
  validateDesignBriefV2AgainstCatalog,
  type DesignCatalogV2Draft,
} from "@global/contracts";
import { STATIC_DESIGN_CATALOG, STATIC_DESIGN_CATALOG_V2 } from "./catalog";

const SHA256 = "a".repeat(64);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sourceManifests() {
  return ["a", "b", "c", "d", "e"].map((group) => ({
    schemaVersion: DESIGN_SOURCE_MANIFEST_SCHEMA_VERSION,
    id: `platform-study-${group}`,
    title: `Platform study ${group}`,
    sourceClass: "platform_original",
    capturedAt: "2026-07-22T00:00:00.000Z",
    licenseSpdx: "LicenseRef-Platform-Original",
    licenseEvidencePath: `licenses/${group}.txt`,
    allowedUses: ["visual_analysis"],
    prohibitedUses: ["training"],
    retentionPolicy: "manifest_only",
    trainingPolicy: "prohibited",
    sourceContributionGroup: group,
    externalAssets: [],
    reviewer: "design-governance",
  }));
}

function draft(): DesignCatalogV2Draft {
  return {
    schemaVersion: DESIGN_CATALOG_V2_SCHEMA_VERSION,
    catalogVersion: "m1-e-b-test/2",
    sourceManifests: sourceManifests(),
    designRules: [
      {
        schemaVersion: DESIGN_RULE_SCHEMA_VERSION,
        id: "proof-near-primary-action",
        summary: "primary-action-adjacent-proof",
        sourceContributionGroups: ["a", "b", "c", "d", "e"],
        evidence: {
          independentSourceCount: 5,
          generalized: true,
          selfReimplementable: true,
          nonNeighboring: true,
        },
      },
    ],
    designDnas: [
      {
        schemaVersion: DESIGN_DNA_SCHEMA_VERSION,
        id: "technical-proof-dna",
        name: "technical-proof",
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
          heroModes: ["technical"],
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
        antiPatterns: ["decorative-dashboard-chrome"],
      },
    ],
    stylePresets: [
      {
        schemaVersion: DESIGN_STYLE_PRESET_V2_SCHEMA_VERSION,
        id: "technical-light",
        version: "1.0.0",
        status: "approved",
        rendererPresetId: "precision-light",
        rendererTokenDigest: SHA256,
        defaultComponentVariants: { HeroBanner: "technical-grid" },
      },
      {
        schemaVersion: DESIGN_STYLE_PRESET_V2_SCHEMA_VERSION,
        id: "technical-dark",
        version: "1.0.0",
        status: "approved",
        rendererPresetId: "industrial-power",
        rendererTokenDigest: SHA256,
        defaultComponentVariants: { HeroBanner: "quiet" },
      },
    ],
    demoVisualPacks: [
      {
        schemaVersion: DEMO_VISUAL_PACK_V2_SCHEMA_VERSION,
        id: "technical-demo-pack",
        version: "1.0.0",
        status: "approved",
        compatibleFamilyIds: ["technical-proof-family"],
        assets: [
          {
            id: "technical-hero-placeholder",
            role: "hero",
            repositoryPath:
              "docs/evidence/site-builder/demo-visuals/technical-hero.webp",
            sha256: SHA256,
            mimeType: "image/webp",
            altTemplate: "technical-product-context",
            sourceManifestId: "platform-study-a",
          },
        ],
        paletteTags: ["industrial", "light"],
        minimumContrastRatio: 4.5,
      },
    ],
    families: [
      {
        schemaVersion: DESIGN_TEMPLATE_FAMILY_V2_SCHEMA_VERSION,
        id: "technical-proof-family",
        version: "1.0.0",
        status: "approved",
        designDnaId: "technical-proof-dna",
        compatibleArchetypes: ["industrial-b2b"],
        compatibleIndustries: ["industrial"],
        stylePresetIds: ["technical-light", "technical-dark"],
        blueprints: {
          home: [
            {
              id: "home-technical",
              pageKind: "home",
              sections: [
                {
                  id: "home-hero",
                  role: "hero",
                  componentType: "HeroBanner",
                  variant: "technical-grid",
                  required: true,
                  requiresEvidence: true,
                  assetRoles: ["hero"],
                  contentBudgetKey: "home-hero",
                },
              ],
              mobileReflow: ["stack-proof-below-primary-action"],
            },
            {
              id: "home-quiet",
              pageKind: "home",
              sections: [
                {
                  id: "home-hero-quiet",
                  role: "hero",
                  componentType: "HeroBanner",
                  variant: "quiet",
                  required: true,
                  requiresEvidence: true,
                  assetRoles: ["hero"],
                  contentBudgetKey: "home-hero",
                },
              ],
              mobileReflow: ["stack-proof-below-primary-action"],
            },
          ],
          detail: [
            {
              id: "detail-technical",
              pageKind: "inner",
              sections: [
                {
                  id: "detail-hero",
                  role: "hero",
                  componentType: "HeroBanner",
                  variant: "technical-grid",
                  required: true,
                  requiresEvidence: true,
                  assetRoles: ["hero"],
                  contentBudgetKey: "detail-hero",
                },
              ],
              mobileReflow: ["stack-proof-below-primary-action"],
            },
            {
              id: "detail-quiet",
              pageKind: "inner",
              sections: [
                {
                  id: "detail-hero-quiet",
                  role: "hero",
                  componentType: "HeroBanner",
                  variant: "quiet",
                  required: true,
                  requiresEvidence: true,
                  assetRoles: ["hero"],
                  contentBudgetKey: "detail-hero",
                },
              ],
              mobileReflow: ["stack-proof-below-primary-action"],
            },
          ],
        },
        safeFallbackBlueprintIds: {
          home: "home-technical",
          detail: "detail-technical",
        },
        componentVariants: {
          HeroBanner: ["technical-grid", "quiet"],
        },
        heroOptions: [
          { componentType: "HeroBanner", variant: "technical-grid" },
          { componentType: "HeroBanner", variant: "quiet" },
        ],
        compatibilityRules: [
          { code: "requires_evidence" },
          { code: "max_consecutive_card_grid", maximum: 2 },
        ],
        contentBudgets: {
          "home-hero": { minimum: 20, maximum: 80 },
          "detail-hero": { minimum: 20, maximum: 80 },
        },
        assetRequirements: ["hero"],
        demoVisualPackIds: ["technical-demo-pack"],
        motionPolicy: {
          intensity: "low",
          allowed: ["fade"],
          forbidden: ["parallax"],
        },
        qualityBaselineId: "technical-proof-quality-v1",
        sourceManifestIds: ["platform-study-a"],
        goldenFixtureIds: ["industrial-rich", "industrial-sparse"],
      },
    ],
  };
}

function brief(catalog = finalizeDesignCatalogV2(draft())) {
  const family = catalog.families[0];
  const preset = catalog.stylePresets[0];
  const pack = catalog.demoVisualPacks[0];
  return finalizeDesignBriefV2({
    schemaVersion: DESIGN_BRIEF_V2_SCHEMA_VERSION,
    catalogVersion: catalog.catalogVersion,
    catalogDigest: catalog.digest,
    familyId: family.id,
    familyVersion: family.version,
    familyDigest: designTemplateFamilyV2Digest(family),
    stylePresetId: preset.id,
    stylePresetVersion: preset.version,
    stylePresetDigest: designStylePresetV2Digest(preset),
    blueprintIds: { home: "home-technical", detail: "detail-technical" },
    componentVariantSelections: { HeroBanner: "technical-grid" },
    assetStrategy: {
      availableRoles: ["hero"],
      demoVisualPackId: pack.id,
      demoVisualPackVersion: pack.version,
      demoVisualPackDigest: demoVisualPackV2Digest(pack),
      allowGeneratedImages: false,
      allowVideo: false,
    },
    contentBudgets: clone(family.contentBudgets),
    localePolicy: ["en"],
    motionIntensity: "low",
    variationSeed: "immutable-seed",
    archetype: "industrial-b2b",
    componentLibraryVersion: "m1-e-a/55-qualified",
    rendererVersion: "renderer-v1",
    reasons: ["compatible-industrial-b2b"],
    warnings: [],
  });
}

describe("M1-e-B v2 catalog and DesignBrief contracts", () => {
  it("keeps DI-0 v1 intact while exposing an immutable empty v2 foundation", () => {
    expect(STATIC_DESIGN_CATALOG.catalogVersion).toBe("di-0-foundation/1");
    expect(STATIC_DESIGN_CATALOG.families).toEqual([]);
    expect(STATIC_DESIGN_CATALOG_V2.catalogVersion).toBe("m1-e-b-foundation/2");
    expect(STATIC_DESIGN_CATALOG_V2.families).toEqual([]);
    expect(Object.isFrozen(STATIC_DESIGN_CATALOG_V2)).toBe(true);
  });

  it("accepts an approved family only with qualified variants and the B0 minimums", () => {
    const catalog = finalizeDesignCatalogV2(draft());
    expect(catalog.families).toHaveLength(1);
    expect(catalog.families[0].goldenFixtureIds).toEqual([
      "industrial-rich",
      "industrial-sparse",
    ]);
  });

  it("rejects an unqualified component variant and incomplete blueprint coverage", () => {
    const unknownVariant = clone(draft());
    unknownVariant.families[0].componentVariants.HeroBanner = ["invented"];
    expect(() => finalizeDesignCatalogV2(unknownVariant)).toThrowError(
      /DESIGN_FAMILY_V2_VARIANT_UNQUALIFIED/,
    );

    const insufficientBlueprints = clone(draft());
    insufficientBlueprints.families[0].blueprints.detail.splice(1, 1);
    expect(() => finalizeDesignCatalogV2(insufficientBlueprints)).toThrowError(
      /DESIGN_FAMILY_V2_MINIMUMS_UNMET/,
    );

    const unapprovedDependency = clone(draft());
    unapprovedDependency.stylePresets[0].status = "draft";
    expect(() => finalizeDesignCatalogV2(unapprovedDependency)).toThrowError(
      /DESIGN_CATALOG_V2_APPROVAL_INVALID/,
    );

    const detachedHeroOption = clone(draft());
    detachedHeroOption.families[0].componentVariants.StatsBand = [
      "technical-grid",
    ];
    detachedHeroOption.families[0].heroOptions[1] = {
      componentType: "StatsBand",
      variant: "technical-grid",
    };
    expect(() => finalizeDesignCatalogV2(detachedHeroOption)).toThrowError(
      /hero option must match a home hero section/,
    );
  });

  it("resolves only a fully pinned approved family and exact selected components", () => {
    const catalog = finalizeDesignCatalogV2(draft());
    const resolved = validateDesignBriefV2AgainstCatalog(
      catalog,
      brief(catalog),
    );
    expect(resolved.id).toBe("technical-proof-family");

    const { digest: _digest, ...mismatched } = clone(brief(catalog));
    mismatched.componentVariantSelections.HeroBanner = "quiet";
    const invalid = finalizeDesignBriefV2(mismatched);
    expect(() =>
      validateDesignBriefV2AgainstCatalog(catalog, invalid),
    ).toThrowError(/DESIGN_BRIEF_V2_VARIANT_MISMATCH/);

    const { digest: _generatedDigest, ...generatedMedia } = clone(
      brief(catalog),
    );
    generatedMedia.assetStrategy.allowGeneratedImages = true;
    expect(() => finalizeDesignBriefV2(generatedMedia)).toThrowError(
      /DESIGN_BRIEF_V2_INVALID/,
    );
  });
});
