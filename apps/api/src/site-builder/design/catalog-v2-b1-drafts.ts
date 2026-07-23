import {
  DEMO_VISUAL_PACK_V2_SCHEMA_VERSION,
  DESIGN_CATALOG_V2_SCHEMA_VERSION,
  DESIGN_DNA_SCHEMA_VERSION,
  DESIGN_RULE_SCHEMA_VERSION,
  DESIGN_SOURCE_MANIFEST_SCHEMA_VERSION,
  DESIGN_STYLE_PRESET_V2_SCHEMA_VERSION,
  DESIGN_TEMPLATE_FAMILY_V2_SCHEMA_VERSION,
  type BlueprintPageKind,
  type BlueprintSectionV2,
  type ContentBudgetV2,
  type DesignCatalogV2Draft,
  type DesignSourceManifest,
  type PageBlueprintV2,
  type SiteSpecComponentType,
} from "@global/contracts";

const rendererTokenDigest = (...segments: string[]): string =>
  segments.join("");

const RENDERER_PRESET_TOKEN_DIGESTS = {
  "precision-instrument": rendererTokenDigest(
    "93f959a9c7a840de",
    "3bed4824f26218f8",
    "0a899f01b12b2721",
    "14480ab05183e788",
  ),
  "industrial-power": rendererTokenDigest(
    "ae9a58570a24fb7a",
    "87cffa3077f609ad",
    "4fb11fe6641bbd90",
    "d175772d8ed27cb5",
  ),
  "precision-light": rendererTokenDigest(
    "a1c04171434fa9b6",
    "c50713f1235216af",
    "8ba51b24b17c2ff3",
    "79a91ff6f8c1f739",
  ),
  "modern-industrial": rendererTokenDigest(
    "b362b54d582bb0e4",
    "603a655095c458c0",
    "86e22c7d4027c276",
    "cf6e7c8dbccffba6",
  ),
} as const;

/** Registered provenance declares permitted transformation/training; this catalog stores no copied source asset or source code. */
const REGISTERED_EXTERNAL_SOURCES = [
  {
    id: "festo-industrial-automation-study",
    title: "Festo industrial automation visual study",
    sourceUrl: "https://www.festo.com/us/en/",
  },
  {
    id: "swagelok-fluid-systems-study",
    title: "Swagelok fluid systems visual study",
    sourceUrl: "https://www.swagelok.com/en/",
  },
  {
    id: "emerson-automation-study",
    title: "Emerson automation visual study",
    sourceUrl: "https://www.emerson.com/en-us",
  },
  {
    id: "siemens-automation-study",
    title: "Siemens industrial automation visual study",
    sourceUrl: "https://www.siemens.com/en-us/products/tia/",
  },
  {
    id: "ifm-sensors-study",
    title: "ifm industrial sensors visual study",
    sourceUrl: "https://www.ifm.com/us/en",
  },
] as const;

const PLATFORM_ORIGINAL_DEMO_SOURCE: DesignSourceManifest = {
  schemaVersion: DESIGN_SOURCE_MANIFEST_SCHEMA_VERSION,
  id: "site-builder-demo-visual-originals",
  title: "Site Builder original demo visual assets",
  sourceClass: "platform_original" as const,
  capturedAt: "2026-07-23T00:00:00.000Z",
  allowedUses: [
    "visual_analysis",
    "token_abstraction",
    "structure_abstraction",
    "code_transformation",
  ],
  prohibitedUses: [],
  retentionPolicy: "manifest_only" as const,
  trainingPolicy: "platform_corpus" as const,
  externalAssets: [],
  reviewer: "site-builder-design-governance",
};

function section(
  id: string,
  role: string,
  componentType: SiteSpecComponentType,
  variant: string,
  contentBudgetKey: string,
  options: { assetRoles?: string[]; requiresEvidence?: boolean } = {},
): BlueprintSectionV2 {
  return {
    id,
    role,
    componentType,
    variant,
    required: true,
    requiresEvidence: options.requiresEvidence ?? false,
    assetRoles: options.assetRoles ?? [],
    contentBudgetKey,
  };
}

function blueprint(
  id: string,
  pageKind: BlueprintPageKind,
  sections: BlueprintSectionV2[],
): PageBlueprintV2 {
  return {
    id,
    pageKind,
    sections,
    mobileReflow: [
      "stack-primary-content-before-secondary-proof",
      "preserve-visible-primary-action",
    ],
  };
}

function budget(minimum: number, maximum: number): ContentBudgetV2 {
  return { minimum, maximum };
}

const sourceManifests: DesignCatalogV2Draft["sourceManifests"] = [
  PLATFORM_ORIGINAL_DEMO_SOURCE,
  ...REGISTERED_EXTERNAL_SOURCES.map(
    ({ id, title, sourceUrl }, index): DesignSourceManifest => ({
      schemaVersion: DESIGN_SOURCE_MANIFEST_SCHEMA_VERSION,
      id,
      title,
      sourceUrl,
      sourceClass: "external_registered" as const,
      capturedAt: "2026-07-23T00:00:00.000Z",
      allowedUses: [
        "visual_analysis",
        "token_abstraction",
        "structure_abstraction",
        "code_transformation",
      ],
      prohibitedUses: [],
      retentionPolicy: "manifest_only" as const,
      trainingPolicy: "permitted" as const,
      sourceContributionGroup: `group-${index + 1}`,
      externalAssets: [],
      reviewer: "site-builder-design-governance",
    }),
  ),
];

const designRules: DesignCatalogV2Draft["designRules"] = [
  {
    schemaVersion: DESIGN_RULE_SCHEMA_VERSION,
    id: "evidence-adjacent-technical-choice",
    summary: "technical-claim-adjacent-evidence",
    sourceContributionGroups: [
      "group-1",
      "group-2",
      "group-3",
      "group-4",
      "group-5",
    ],
    evidence: {
      independentSourceCount: 5,
      generalized: true,
      selfReimplementable: true,
      nonNeighboring: true,
    },
  },
];

const designDnas: DesignCatalogV2Draft["designDnas"] = [
  {
    schemaVersion: DESIGN_DNA_SCHEMA_VERSION,
    id: "precision-industrial-dna",
    name: "precision-industrial",
    ruleIds: ["evidence-adjacent-technical-choice"],
    hierarchy: {
      displayScale: "balanced",
      headingContrast: "high",
      maxReadingWidthRem: 42,
    },
    spatialRhythm: {
      sectionGapPx: [48, 88],
      contentGapPx: [16, 28],
      density: "balanced",
    },
    composition: {
      heroModes: ["technical", "product_stage"],
      imageTextRatios: ["3:2", "4:3"],
      alignmentBias: "left",
    },
    surfaces: {
      cardStyle: "bordered",
      borderWeight: "hairline",
      radius: "subtle",
    },
    imagery: {
      preferredSubjects: ["product", "process", "measurement"],
      cropModes: ["cover", "contain"],
      backgroundPolicy: "dark",
      maxGeneratedMediaRatio: 0,
    },
    motion: {
      intensity: "low",
      allowed: ["fade"],
      forbidden: ["parallax", "continuous-motion"],
    },
    antiPatterns: ["decorative-dashboard-chrome", "unsupported-global-claim"],
  },
  {
    schemaVersion: DESIGN_DNA_SCHEMA_VERSION,
    id: "technical-catalog-dna",
    name: "technical-catalog",
    ruleIds: ["evidence-adjacent-technical-choice"],
    hierarchy: {
      displayScale: "compact",
      headingContrast: "medium",
      maxReadingWidthRem: 46,
    },
    spatialRhythm: {
      sectionGapPx: [40, 72],
      contentGapPx: [12, 24],
      density: "dense",
    },
    composition: {
      heroModes: ["technical", "product_stage"],
      imageTextRatios: ["4:3", "1:1"],
      alignmentBias: "mixed",
    },
    surfaces: {
      cardStyle: "flat",
      borderWeight: "hairline",
      radius: "none",
    },
    imagery: {
      preferredSubjects: ["product", "specification", "material"],
      cropModes: ["contain", "cover"],
      backgroundPolicy: "light",
      maxGeneratedMediaRatio: 0,
    },
    motion: {
      intensity: "none",
      allowed: [],
      forbidden: ["parallax", "continuous-motion", "auto-advance"],
    },
    antiPatterns: ["emotion-only-hero", "hidden-technical-information"],
  },
];

export const M1_E_B_B1_CATALOG_V2_DRAFT: DesignCatalogV2Draft = {
  schemaVersion: DESIGN_CATALOG_V2_SCHEMA_VERSION,
  catalogVersion: "m1-e-b-b1-drafts/2",
  sourceManifests,
  designRules,
  designDnas,
  stylePresets: [
    {
      schemaVersion: DESIGN_STYLE_PRESET_V2_SCHEMA_VERSION,
      id: "precision-instrument-dark",
      version: "0.1.0",
      status: "draft",
      rendererPresetId: "precision-instrument",
      rendererTokenDigest:
        RENDERER_PRESET_TOKEN_DIGESTS["precision-instrument"],
      defaultComponentVariants: { IndustrialHero: "technical-grid" },
    },
    {
      schemaVersion: DESIGN_STYLE_PRESET_V2_SCHEMA_VERSION,
      id: "industrial-power-dark",
      version: "0.1.0",
      status: "draft",
      rendererPresetId: "industrial-power",
      rendererTokenDigest: RENDERER_PRESET_TOKEN_DIGESTS["industrial-power"],
      defaultComponentVariants: { IndustrialHero: "quiet" },
    },
    {
      schemaVersion: DESIGN_STYLE_PRESET_V2_SCHEMA_VERSION,
      id: "catalog-precision-light",
      version: "0.1.0",
      status: "draft",
      rendererPresetId: "precision-light",
      rendererTokenDigest: RENDERER_PRESET_TOKEN_DIGESTS["precision-light"],
      defaultComponentVariants: { HeroBanner: "technical-grid" },
    },
    {
      schemaVersion: DESIGN_STYLE_PRESET_V2_SCHEMA_VERSION,
      id: "catalog-modern-industrial",
      version: "0.1.0",
      status: "draft",
      rendererPresetId: "modern-industrial",
      rendererTokenDigest: RENDERER_PRESET_TOKEN_DIGESTS["modern-industrial"],
      defaultComponentVariants: { ProductShowcaseAlt: "technical-grid" },
    },
  ],
  demoVisualPacks: [
    {
      schemaVersion: DEMO_VISUAL_PACK_V2_SCHEMA_VERSION,
      id: "precision-industrial-demo-pack",
      version: "0.1.0",
      status: "draft",
      compatibleFamilyIds: ["precision-industrial"],
      assets: [
        {
          id: "precision-industrial-hero-field",
          role: "hero",
          repositoryPath:
            "apps/site-renderer/fixtures/design-demo-visuals/precision-industrial-hero.svg",
          sha256:
            "e211f711fc4f545e9c1f4c8e41151f3b561f5d30044d7d4438093806bb90e1ac",
          mimeType: "image/svg+xml",
          altTemplate: "precision-industrial-technical-field",
          sourceManifestId: "site-builder-demo-visual-originals",
        },
        {
          id: "precision-industrial-product-module",
          role: "generic-product",
          repositoryPath:
            "apps/site-renderer/fixtures/design-demo-visuals/precision-product-module.svg",
          sha256:
            "b235da342eb1dd5748ec8fcb6b66a52106600f3421a74869d49c64e05526b853",
          mimeType: "image/svg+xml",
          altTemplate: "precision-industrial-product-module",
          sourceManifestId: "site-builder-demo-visual-originals",
        },
        {
          id: "precision-industrial-process-grid",
          role: "generic-process",
          repositoryPath:
            "apps/site-renderer/fixtures/design-demo-visuals/precision-process-grid.svg",
          sha256:
            "ded1503373af761c99dfd88917f292193c7536f3a22be69ac857343afafef537",
          mimeType: "image/svg+xml",
          altTemplate: "precision-industrial-process-grid",
          sourceManifestId: "site-builder-demo-visual-originals",
        },
        {
          id: "precision-industrial-process-inspection",
          role: "generic-process",
          repositoryPath:
            "apps/site-renderer/fixtures/design-demo-visuals/precision-process-inspection.svg",
          sha256:
            "3dd7012b059610c4582fa02566fcef0cd8ae42840d6243e62f3264e8034546b7",
          mimeType: "image/svg+xml",
          altTemplate: "precision-industrial-process-inspection",
          sourceManifestId: "site-builder-demo-visual-originals",
        },
      ],
      paletteTags: ["technical", "dark", "precision"],
      minimumContrastRatio: 4.5,
    },
    {
      schemaVersion: DEMO_VISUAL_PACK_V2_SCHEMA_VERSION,
      id: "technical-catalog-demo-pack",
      version: "0.1.0",
      status: "draft",
      compatibleFamilyIds: ["technical-catalog"],
      assets: [
        {
          id: "technical-catalog-hero-field",
          role: "hero",
          repositoryPath:
            "apps/site-renderer/fixtures/design-demo-visuals/technical-catalog-hero.svg",
          sha256:
            "20e7d3d704767fc633a57422f7918880141e75c0b406bf5f209d1f017a1eb411",
          mimeType: "image/svg+xml",
          altTemplate: "technical-catalog-product-field",
          sourceManifestId: "site-builder-demo-visual-originals",
        },
        {
          id: "technical-catalog-product-module",
          role: "generic-product",
          repositoryPath:
            "apps/site-renderer/fixtures/design-demo-visuals/technical-product-module.svg",
          sha256:
            "2b232e7ba02b4141df9a4fea836efd114a4487c8ddf5d2d9b1f4dea6ee55131e",
          mimeType: "image/svg+xml",
          altTemplate: "technical-catalog-product-module",
          sourceManifestId: "site-builder-demo-visual-originals",
        },
        {
          id: "technical-catalog-process-flow",
          role: "generic-process",
          repositoryPath:
            "apps/site-renderer/fixtures/design-demo-visuals/technical-process-catalog.svg",
          sha256:
            "42be3f10168cf17aaba127c37195675b5f2991817e3f7b6d157b7c5c6bc6d44f",
          mimeType: "image/svg+xml",
          altTemplate: "technical-catalog-process-flow",
          sourceManifestId: "site-builder-demo-visual-originals",
        },
        {
          id: "technical-catalog-process-validation",
          role: "generic-process",
          repositoryPath:
            "apps/site-renderer/fixtures/design-demo-visuals/technical-process-validation.svg",
          sha256:
            "795f9fe8dc1333507d78ec762901774b3f6cc5e945915f2f935868eac0166d07",
          mimeType: "image/svg+xml",
          altTemplate: "technical-catalog-process-validation",
          sourceManifestId: "site-builder-demo-visual-originals",
        },
      ],
      paletteTags: ["technical", "light", "catalog"],
      minimumContrastRatio: 4.5,
    },
  ],
  families: [
    {
      schemaVersion: DESIGN_TEMPLATE_FAMILY_V2_SCHEMA_VERSION,
      id: "precision-industrial",
      version: "0.1.0",
      status: "draft",
      designDnaId: "precision-industrial-dna",
      compatibleArchetypes: [
        "industrial-manufacturer",
        "custom-oem",
        "equipment-supplier",
      ],
      compatibleIndustries: ["machinery", "pumps-valves", "components", "oem"],
      stylePresetIds: ["precision-instrument-dark", "industrial-power-dark"],
      blueprints: {
        home: [
          blueprint("precision-home-technical", "home", [
            section(
              "precision-home-hero",
              "hero",
              "IndustrialHero",
              "technical-grid",
              "precision-hero",
              { assetRoles: ["hero"], requiresEvidence: true },
            ),
            section(
              "precision-home-systems",
              "capability",
              "TechSystems",
              "technical-grid",
              "precision-body",
              { requiresEvidence: true },
            ),
            section(
              "precision-home-stats",
              "proof",
              "StatsBand",
              "technical-grid",
              "precision-proof",
              { requiresEvidence: true },
            ),
            section(
              "precision-home-cta",
              "cta",
              "CtaBanner",
              "technical-grid",
              "precision-cta",
            ),
          ]),
          blueprint("precision-home-process", "home", [
            section(
              "precision-home-process-hero",
              "hero",
              "IndustrialHero",
              "quiet",
              "precision-hero",
              { assetRoles: ["hero"], requiresEvidence: true },
            ),
            section(
              "precision-home-process-flow",
              "process",
              "ProcessTimeline",
              "technical-grid",
              "precision-body",
              { requiresEvidence: true },
            ),
            section(
              "precision-home-certificates",
              "proof",
              "CertWall",
              "technical-grid",
              "precision-proof",
              { requiresEvidence: true },
            ),
            section(
              "precision-home-process-cta",
              "cta",
              "CtaBanner",
              "quiet",
              "precision-cta",
            ),
          ]),
        ],
        detail: [
          blueprint("precision-detail-capability", "inner", [
            section(
              "precision-detail-hero",
              "hero",
              "HeroBanner",
              "technical-grid",
              "precision-hero",
              { assetRoles: ["hero"], requiresEvidence: true },
            ),
            section(
              "precision-detail-process",
              "process",
              "ProcessSteps",
              "technical-grid",
              "precision-body",
              { requiresEvidence: true },
            ),
            section(
              "precision-detail-inquiry",
              "cta",
              "InquiryForm",
              "technical-grid",
              "precision-cta",
            ),
          ]),
          blueprint("precision-detail-application", "inner", [
            section(
              "precision-application-hero",
              "hero",
              "HeroBanner",
              "quiet",
              "precision-hero",
              { assetRoles: ["hero"], requiresEvidence: true },
            ),
            section(
              "precision-application-services",
              "capability",
              "ServicesGrid",
              "technical-grid",
              "precision-body",
            ),
            section(
              "precision-application-cta",
              "cta",
              "CtaBanner",
              "technical-grid",
              "precision-cta",
            ),
          ]),
        ],
      },
      safeFallbackBlueprintIds: {
        home: "precision-home-technical",
        detail: "precision-detail-capability",
      },
      componentVariants: {
        IndustrialHero: ["technical-grid", "quiet"],
        HeroBanner: ["technical-grid", "quiet"],
        TechSystems: ["technical-grid"],
        StatsBand: ["technical-grid"],
        ProcessTimeline: ["technical-grid"],
        ProcessSteps: ["technical-grid"],
        CertWall: ["technical-grid"],
        ServicesGrid: ["technical-grid"],
        CtaBanner: ["technical-grid", "quiet"],
        InquiryForm: ["technical-grid"],
      },
      heroOptions: [
        { componentType: "IndustrialHero", variant: "technical-grid" },
        { componentType: "IndustrialHero", variant: "quiet" },
      ],
      compatibilityRules: [
        { code: "requires_evidence" },
        { code: "max_consecutive_card_grid", maximum: 2 },
        { code: "max_consecutive_dark_surface", maximum: 1 },
      ],
      contentBudgets: {
        "precision-hero": budget(24, 72),
        "precision-body": budget(32, 180),
        "precision-proof": budget(12, 72),
        "precision-cta": budget(12, 48),
      },
      assetRequirements: ["hero"],
      demoVisualPackIds: ["precision-industrial-demo-pack"],
      motionPolicy: {
        intensity: "low",
        allowed: ["fade"],
        forbidden: ["parallax", "continuous-motion"],
      },
      qualityBaselineId: "precision-industrial-draft-baseline",
      sourceManifestIds: [
        "festo-industrial-automation-study",
        "swagelok-fluid-systems-study",
        "emerson-automation-study",
      ],
      goldenFixtureIds: [
        "precision-industrial-rich",
        "precision-industrial-sparse",
      ],
    },
    {
      schemaVersion: DESIGN_TEMPLATE_FAMILY_V2_SCHEMA_VERSION,
      id: "technical-catalog",
      version: "0.1.0",
      status: "draft",
      designDnaId: "technical-catalog-dna",
      compatibleArchetypes: ["equipment-supplier", "industrial-manufacturer"],
      compatibleIndustries: [
        "components",
        "instruments",
        "materials",
        "catalog",
      ],
      stylePresetIds: ["catalog-precision-light", "catalog-modern-industrial"],
      blueprints: {
        home: [
          blueprint("catalog-home-specification", "home", [
            section(
              "catalog-home-hero",
              "hero",
              "HeroBanner",
              "technical-grid",
              "catalog-hero",
              { assetRoles: ["hero"], requiresEvidence: true },
            ),
            section(
              "catalog-home-products",
              "products",
              "ProductGrid",
              "technical-grid",
              "catalog-body",
              { requiresEvidence: true },
            ),
            section(
              "catalog-home-features",
              "capability",
              "FeatureCards",
              "technical-grid",
              "catalog-body",
              { requiresEvidence: true },
            ),
            section(
              "catalog-home-cta",
              "cta",
              "CtaBanner",
              "technical-grid",
              "catalog-cta",
            ),
          ]),
          blueprint("catalog-home-materials", "home", [
            section(
              "catalog-materials-hero",
              "hero",
              "ProductShowcaseAlt",
              "technical-grid",
              "catalog-hero",
              { assetRoles: ["hero"], requiresEvidence: true },
            ),
            section(
              "catalog-materials-library",
              "products",
              "MaterialsLibrary",
              "technical-grid",
              "catalog-body",
              { requiresEvidence: true },
            ),
            section(
              "catalog-materials-products",
              "products",
              "ProductGrid",
              "quiet",
              "catalog-body",
            ),
            section(
              "catalog-materials-cta",
              "cta",
              "CtaBanner",
              "quiet",
              "catalog-cta",
            ),
          ]),
        ],
        detail: [
          blueprint("catalog-detail-sku", "inner", [
            section(
              "catalog-detail-hero",
              "hero",
              "HeroBanner",
              "quiet",
              "catalog-hero",
              { assetRoles: ["hero"], requiresEvidence: true },
            ),
            section(
              "catalog-detail-products",
              "products",
              "ProductGrid",
              "technical-grid",
              "catalog-body",
              { requiresEvidence: true },
            ),
            section(
              "catalog-detail-faq",
              "proof",
              "FaqAccordion",
              "technical-grid",
              "catalog-proof",
            ),
          ]),
          blueprint("catalog-detail-application", "inner", [
            section(
              "catalog-application-hero",
              "hero",
              "ProductShowcaseAlt",
              "quiet",
              "catalog-hero",
              { assetRoles: ["hero"], requiresEvidence: true },
            ),
            section(
              "catalog-application-features",
              "capability",
              "FeatureCards",
              "quiet",
              "catalog-body",
            ),
            section(
              "catalog-application-inquiry",
              "cta",
              "InquiryForm",
              "technical-grid",
              "catalog-cta",
            ),
          ]),
        ],
      },
      safeFallbackBlueprintIds: {
        home: "catalog-home-specification",
        detail: "catalog-detail-sku",
      },
      componentVariants: {
        HeroBanner: ["technical-grid", "quiet"],
        ProductShowcaseAlt: ["technical-grid", "quiet"],
        ProductGrid: ["technical-grid", "quiet"],
        MaterialsLibrary: ["technical-grid"],
        FeatureCards: ["technical-grid", "quiet"],
        FaqAccordion: ["technical-grid"],
        CtaBanner: ["technical-grid", "quiet"],
        InquiryForm: ["technical-grid"],
      },
      heroOptions: [
        { componentType: "HeroBanner", variant: "technical-grid" },
        { componentType: "ProductShowcaseAlt", variant: "technical-grid" },
      ],
      compatibilityRules: [
        { code: "requires_evidence" },
        { code: "max_consecutive_card_grid", maximum: 2 },
        { code: "requires_minimum_product_count", minimum: 2 },
      ],
      contentBudgets: {
        "catalog-hero": budget(20, 64),
        "catalog-body": budget(24, 160),
        "catalog-proof": budget(12, 72),
        "catalog-cta": budget(12, 48),
      },
      assetRequirements: ["hero"],
      demoVisualPackIds: ["technical-catalog-demo-pack"],
      motionPolicy: {
        intensity: "none",
        allowed: [],
        forbidden: ["parallax", "continuous-motion", "auto-advance"],
      },
      qualityBaselineId: "technical-catalog-draft-baseline",
      sourceManifestIds: [
        "emerson-automation-study",
        "siemens-automation-study",
        "ifm-sensors-study",
      ],
      goldenFixtureIds: ["technical-catalog-rich", "technical-catalog-sparse"],
    },
  ],
};
