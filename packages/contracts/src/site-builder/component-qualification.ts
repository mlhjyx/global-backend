import { z } from "zod";
import {
  SITE_SPEC_COMPONENT_TYPES,
  SITE_SPEC_RELEASE_COMPONENT_TYPES,
  type SiteSpecComponentType,
} from "./site-spec";

export const COMPONENT_QUALIFICATION_PARTS = [
  "schema",
  "variants",
  "contentBudget",
  "accessibility",
  "reducedMotion",
  "fixtures",
  "visualRegression",
] as const;
export type ComponentQualificationPart =
  (typeof COMPONENT_QUALIFICATION_PARTS)[number];

const evidenceRefSchema = z
  .object({ artifactId: z.string().trim().min(1).max(256) })
  .strict();

const componentQualificationSchema = z
  .object({
    schema: evidenceRefSchema,
    variants: evidenceRefSchema,
    contentBudget: evidenceRefSchema,
    accessibility: evidenceRefSchema,
    reducedMotion: evidenceRefSchema,
    fixtures: evidenceRefSchema,
    visualRegression: evidenceRefSchema,
  })
  .strict();

export type ComponentQualificationEvidence = z.infer<
  typeof componentQualificationSchema
>;

const artifactBase = {
  artifactId: z.string().trim().min(1).max(256),
  componentType: z.enum(SITE_SPEC_COMPONENT_TYPES),
  repositoryPath: z.string().trim().min(1).max(512),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
};

const repositoryByteRefBase = {
  repositoryPath: z.string().trim().min(1).max(512),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
};

const fixtureFileSchema = z
  .object({
    fixtureId: z.string().trim().min(1).max(128),
    ...repositoryByteRefBase,
  })
  .strict();

const visualOutputSchemas = [
  z.object({ breakpoint: z.literal(375), ...repositoryByteRefBase }).strict(),
  z.object({ breakpoint: z.literal(768), ...repositoryByteRefBase }).strict(),
  z.object({ breakpoint: z.literal(1440), ...repositoryByteRefBase }).strict(),
] satisfies [z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny];

const componentQualificationArtifactSchema = z.discriminatedUnion("part", [
  z.object({ ...artifactBase, part: z.literal("schema") }).strict(),
  z
    .object({
      ...artifactBase,
      part: z.literal("variants"),
      variantValues: z.array(z.string().trim().min(1).max(64)).min(1),
    })
    .strict(),
  z.object({ ...artifactBase, part: z.literal("contentBudget") }).strict(),
  z.object({ ...artifactBase, part: z.literal("accessibility") }).strict(),
  z.object({ ...artifactBase, part: z.literal("reducedMotion") }).strict(),
  z
    .object({
      ...artifactBase,
      part: z.literal("fixtures"),
      fixtureIds: z.array(z.string().trim().min(1).max(128)).min(1),
      fixtureFiles: z.array(fixtureFileSchema).min(1),
    })
    .strict(),
  z
    .object({
      ...artifactBase,
      part: z.literal("visualRegression"),
      breakpoints: z.tuple([z.literal(375), z.literal(768), z.literal(1440)]),
      outputs: z.tuple(visualOutputSchemas),
    })
    .strict(),
]);

export type ComponentQualificationArtifact = z.infer<
  typeof componentQualificationArtifactSchema
>;

/**
 * The ten R1 components predate the M1-e-A seven-part contract. They remain
 * release-eligible for backward compatibility, but must never be mistaken for
 * M1-e-A-qualified components. The frozen exception is deliberately not an
 * integrity-check input, so callers cannot extend it alongside the release list.
 */
export const SITE_SPEC_TRANSITIONAL_RELEASE_COMPONENT_TYPES = Object.freeze([
  "AboutBlock",
  "CertWall",
  "CtaBanner",
  "FaqAccordion",
  "HeroBanner",
  "InquiryForm",
  "MapLocation",
  "ProcessTimeline",
  "ProductGrid",
  "StatsBand",
] as const satisfies readonly SiteSpecComponentType[]);

/**
 * Checked-in evidence artifact registry. A qualification may reference only
 * entries in this registry. CI independently hashes each repositoryPath and
 * compares it with sha256, so a non-empty id alone can never satisfy the gate.
 */
export const M1_E_A_COMPONENT_QUALIFICATION_ARTIFACTS = Object.freeze({
  "m1-e-a-cta-banner-schema": {
    artifactId: "m1-e-a-cta-banner-schema",
    componentType: "CtaBanner",
    part: "schema",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/CtaBanner/schema.json",
    sha256: "71fdcb284094074b53f171ef3ed5ae28ae9a573668a5bd74c34fbb877bc37df6",
  },
  "m1-e-a-cta-banner-variants": {
    artifactId: "m1-e-a-cta-banner-variants",
    componentType: "CtaBanner",
    part: "variants",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/CtaBanner/variants.json",
    sha256: "1e9daa851940ed8fd857e1cafc1ad43864c6e02470196f4f6aba70b666a1591d",
    variantValues: ["technical-grid", "quiet"],
  },
  "m1-e-a-cta-banner-content-budget": {
    artifactId: "m1-e-a-cta-banner-content-budget",
    componentType: "CtaBanner",
    part: "contentBudget",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/CtaBanner/content-budget.json",
    sha256: "b622ed183738fe4746c8ca37786f88b7906c670dfccb8c11552e6332b212c885",
  },
  "m1-e-a-cta-banner-accessibility": {
    artifactId: "m1-e-a-cta-banner-accessibility",
    componentType: "CtaBanner",
    part: "accessibility",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/CtaBanner/accessibility.json",
    sha256: "40052d56da34e6e731dabc527ffa568c722d70cff892206e39da57a44e6f57a3",
  },
  "m1-e-a-cta-banner-reduced-motion": {
    artifactId: "m1-e-a-cta-banner-reduced-motion",
    componentType: "CtaBanner",
    part: "reducedMotion",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/CtaBanner/reduced-motion.json",
    sha256: "fce46d3a2d366950908a1ac5fa741d8f5c59b4bb769e80f99107738ea70439bf",
  },
  "m1-e-a-cta-banner-fixtures": {
    artifactId: "m1-e-a-cta-banner-fixtures",
    componentType: "CtaBanner",
    part: "fixtures",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/CtaBanner/fixtures.json",
    sha256: "7b252ea433845e4767c9ae5902049ea3ee78c76f8aa86ece312ea6cbec060889",
    fixtureIds: ["technical-baseline"],
    fixtureFiles: [
      {
        fixtureId: "technical-baseline",
        repositoryPath:
          "apps/site-renderer/fixtures/technical-baseline-spec.json",
        sha256:
          "2e005c3251a94c17412a6a75a65c2e8ec5a6419bf328a44869b402b93b56d59a",
      },
    ],
  },
  "m1-e-a-cta-banner-visual-regression": {
    artifactId: "m1-e-a-cta-banner-visual-regression",
    componentType: "CtaBanner",
    part: "visualRegression",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/CtaBanner/visual-regression.json",
    sha256: "91df21c30a99eac99f085983ba0424e0d2eab802a12ceff3c07a6ef01859d722",
    breakpoints: [375, 768, 1440],
    outputs: [
      {
        breakpoint: 375,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/mobile-375/CtaBanner.png",
        sha256:
          "7fff8c6776d91c301572bfbb988a9801744941556be95dc7c2551d26e2e43808",
      },
      {
        breakpoint: 768,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/tablet-768/CtaBanner.png",
        sha256:
          "c3ce68543dedce07f48eaf94723ed6325978f6dae72974884ad6af945d4cd408",
      },
      {
        breakpoint: 1440,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/desktop-1440/CtaBanner.png",
        sha256:
          "e071c58abe968dece3be1c2ccef080538f57576680b896180c9339a8c81ffd86",
      },
    ],
  },
  "m1-e-a-hero-banner-schema": {
    artifactId: "m1-e-a-hero-banner-schema",
    componentType: "HeroBanner",
    part: "schema",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/HeroBanner/schema.json",
    sha256: "2dec1c314b6d937b3c472f63c9cc989ff628cb31259edbe7c4ba3557d2503342",
  },
  "m1-e-a-hero-banner-variants": {
    artifactId: "m1-e-a-hero-banner-variants",
    componentType: "HeroBanner",
    part: "variants",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/HeroBanner/variants.json",
    sha256: "7e4e58d9cc222c85f94f8855f7eb711521c42947c06885b3d75b3cdeea841136",
    variantValues: ["technical-grid", "quiet"],
  },
  "m1-e-a-hero-banner-content-budget": {
    artifactId: "m1-e-a-hero-banner-content-budget",
    componentType: "HeroBanner",
    part: "contentBudget",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/HeroBanner/content-budget.json",
    sha256: "0ef054b7aa89109d7ffbc6361e8ec8f72cd04e7d5dc6c61ec3163ffc79a38fe8",
  },
  "m1-e-a-hero-banner-accessibility": {
    artifactId: "m1-e-a-hero-banner-accessibility",
    componentType: "HeroBanner",
    part: "accessibility",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/HeroBanner/accessibility.json",
    sha256: "13d0e3c64ac9850a13f99a3ec76a963a92b2b3f191aef5329878f9e9f184de9d",
  },
  "m1-e-a-hero-banner-reduced-motion": {
    artifactId: "m1-e-a-hero-banner-reduced-motion",
    componentType: "HeroBanner",
    part: "reducedMotion",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/HeroBanner/reduced-motion.json",
    sha256: "f017916cb3579c1d54f0dafde8c286df94e12ad0073856243eec4c682776d5c0",
  },
  "m1-e-a-hero-banner-fixtures": {
    artifactId: "m1-e-a-hero-banner-fixtures",
    componentType: "HeroBanner",
    part: "fixtures",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/HeroBanner/fixtures.json",
    sha256: "12cb5dad61ae06488da82b18daa5be78b4a362179af17389c81d1bd6d8b56c6d",
    fixtureIds: ["technical-baseline"],
    fixtureFiles: [
      {
        fixtureId: "technical-baseline",
        repositoryPath:
          "apps/site-renderer/fixtures/technical-baseline-spec.json",
        sha256:
          "2e005c3251a94c17412a6a75a65c2e8ec5a6419bf328a44869b402b93b56d59a",
      },
    ],
  },
  "m1-e-a-hero-banner-visual-regression": {
    artifactId: "m1-e-a-hero-banner-visual-regression",
    componentType: "HeroBanner",
    part: "visualRegression",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/HeroBanner/visual-regression.json",
    sha256: "7ab12f129ba597f695bde9cd06b61087b4ef5d14b3451739370bb46e6bbee9e0",
    breakpoints: [375, 768, 1440],
    outputs: [
      {
        breakpoint: 375,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/mobile-375/HeroBanner.png",
        sha256:
          "c3362f4adbf681b4912ee65b038f0aae698fcc24c08bd3128c94891886c6ba03",
      },
      {
        breakpoint: 768,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/tablet-768/HeroBanner.png",
        sha256:
          "5db4799f82ac65fc69ce9edbfc2bdd4b57369b20f382d9201faf0c21c5201544",
      },
      {
        breakpoint: 1440,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/desktop-1440/HeroBanner.png",
        sha256:
          "f443d3da02758453cc54f8a8abf3c0d883626ed37caa5522b18be97538887367",
      },
    ],
  },
  "m1-e-a-stats-band-schema": {
    artifactId: "m1-e-a-stats-band-schema",
    componentType: "StatsBand",
    part: "schema",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/StatsBand/schema.json",
    sha256: "0ae9d3db087c3b2cfee16bc85546506b0603d0d01f1893c8cc33267ed41915a2",
  },
  "m1-e-a-stats-band-variants": {
    artifactId: "m1-e-a-stats-band-variants",
    componentType: "StatsBand",
    part: "variants",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/StatsBand/variants.json",
    sha256: "1b6878faa2e4120ecb2b25e43fe4a3d8426d0cd0b5e477eb11bb7b05fe3d36f7",
    variantValues: ["technical-grid", "quiet"],
  },
  "m1-e-a-stats-band-content-budget": {
    artifactId: "m1-e-a-stats-band-content-budget",
    componentType: "StatsBand",
    part: "contentBudget",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/StatsBand/content-budget.json",
    sha256: "f5720a09d4b055daf02dca306df3600ed90adc9be36b8947f5c577bd101dfc3b",
  },
  "m1-e-a-stats-band-accessibility": {
    artifactId: "m1-e-a-stats-band-accessibility",
    componentType: "StatsBand",
    part: "accessibility",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/StatsBand/accessibility.json",
    sha256: "413fac6de33fd4715a855a704de81c8ab921d6c70cc943e2c399cffbdcce78ba",
  },
  "m1-e-a-stats-band-reduced-motion": {
    artifactId: "m1-e-a-stats-band-reduced-motion",
    componentType: "StatsBand",
    part: "reducedMotion",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/StatsBand/reduced-motion.json",
    sha256: "8856e0c6a849a2352f124f32e39af56065f9546f248a3244d0a25f121eb6f69f",
  },
  "m1-e-a-stats-band-fixtures": {
    artifactId: "m1-e-a-stats-band-fixtures",
    componentType: "StatsBand",
    part: "fixtures",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/StatsBand/fixtures.json",
    sha256: "5e2d920c7383a982509cbe5719cba2b5c500528cdbdbe6c33a6928d24b2a4a71",
    fixtureIds: ["technical-baseline"],
    fixtureFiles: [
      {
        fixtureId: "technical-baseline",
        repositoryPath:
          "apps/site-renderer/fixtures/technical-baseline-spec.json",
        sha256:
          "2e005c3251a94c17412a6a75a65c2e8ec5a6419bf328a44869b402b93b56d59a",
      },
    ],
  },
  "m1-e-a-stats-band-visual-regression": {
    artifactId: "m1-e-a-stats-band-visual-regression",
    componentType: "StatsBand",
    part: "visualRegression",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/StatsBand/visual-regression.json",
    sha256: "b3d2f780bf044b13db5433e5f70957bbeae5a6c5a97642259083b69455fb94f7",
    breakpoints: [375, 768, 1440],
    outputs: [
      {
        breakpoint: 375,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/mobile-375/StatsBand.png",
        sha256:
          "58b9461e3be020aa47abfb10945c607afacf9d1c84e58354501dae1fceefa954",
      },
      {
        breakpoint: 768,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/tablet-768/StatsBand.png",
        sha256:
          "6ceb7a169a4bdbddc3e7da07272419a9faad04321a83ba377f90e092bb2f5950",
      },
      {
        breakpoint: 1440,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/desktop-1440/StatsBand.png",
        sha256:
          "a2fc278d98f0d2897c495c9b5a50a074c4b37eba0aa814366171352213101bb5",
      },
    ],
  },
  "m1-e-a-product-grid-schema": {
    artifactId: "m1-e-a-product-grid-schema",
    componentType: "ProductGrid",
    part: "schema",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/ProductGrid/schema.json",
    sha256: "cf5adcb39edbd10b97330c41539db32c8b25e3a49211a747c61c9a71af1f702f",
  },
  "m1-e-a-product-grid-variants": {
    artifactId: "m1-e-a-product-grid-variants",
    componentType: "ProductGrid",
    part: "variants",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/ProductGrid/variants.json",
    sha256: "7ce4a9e00f16570728c0ab6f20ed2be1e0508d2872d4c2c00f5e3f5c49609005",
    variantValues: ["technical-grid", "quiet"],
  },
  "m1-e-a-product-grid-content-budget": {
    artifactId: "m1-e-a-product-grid-content-budget",
    componentType: "ProductGrid",
    part: "contentBudget",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/ProductGrid/content-budget.json",
    sha256: "5946afa4bc957dfde67735f1e9e710cf61c505fb95bc7e4e511148558dad509a",
  },
  "m1-e-a-product-grid-accessibility": {
    artifactId: "m1-e-a-product-grid-accessibility",
    componentType: "ProductGrid",
    part: "accessibility",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/ProductGrid/accessibility.json",
    sha256: "b835c8836cf222d0dc3ea4a114b8eec95ff6af15b25e8bddf02a555d0c4a386e",
  },
  "m1-e-a-product-grid-reduced-motion": {
    artifactId: "m1-e-a-product-grid-reduced-motion",
    componentType: "ProductGrid",
    part: "reducedMotion",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/ProductGrid/reduced-motion.json",
    sha256: "c72bd6ea3ae5523becb995c42f0e58d50675a9ab2679ebbdcc04b69d63b2160e",
  },
  "m1-e-a-product-grid-fixtures": {
    artifactId: "m1-e-a-product-grid-fixtures",
    componentType: "ProductGrid",
    part: "fixtures",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/ProductGrid/fixtures.json",
    sha256: "ed27cf52f016d9176272f5be51e0a517c1ef206456d51bb9fd0ac9a41dd4e565",
    fixtureIds: ["technical-baseline"],
    fixtureFiles: [
      {
        fixtureId: "technical-baseline",
        repositoryPath:
          "apps/site-renderer/fixtures/technical-baseline-spec.json",
        sha256:
          "2e005c3251a94c17412a6a75a65c2e8ec5a6419bf328a44869b402b93b56d59a",
      },
    ],
  },
  "m1-e-a-product-grid-visual-regression": {
    artifactId: "m1-e-a-product-grid-visual-regression",
    componentType: "ProductGrid",
    part: "visualRegression",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/ProductGrid/visual-regression.json",
    sha256: "2c6534a0ca1a45c961cff42238f423313c721920ac41a822c2979345de5c3b7f",
    breakpoints: [375, 768, 1440],
    outputs: [
      {
        breakpoint: 375,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/mobile-375/ProductGrid.png",
        sha256:
          "fff59ca199df1ea91ea40cc9110c3c90f0565ae800e199a9b91e60b51829b486",
      },
      {
        breakpoint: 768,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/tablet-768/ProductGrid.png",
        sha256:
          "3279d0ccb8cad0ff6c6b97d42a1a197e324b5c237b2631f58a6ced5f9b07f745",
      },
      {
        breakpoint: 1440,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/desktop-1440/ProductGrid.png",
        sha256:
          "8483c6355f2fe0921afebf42d083ea1db238016c9a3356e995a3a5ae52cc314f",
      },
    ],
  },
  "m1-e-a-about-block-schema": {
    artifactId: "m1-e-a-about-block-schema",
    componentType: "AboutBlock",
    part: "schema",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/AboutBlock/schema.json",
    sha256: "a6c949da3597abb60c81d2ba552c9da94fc031bc4da27daf88f346a42fadc95e",
  },
  "m1-e-a-about-block-variants": {
    artifactId: "m1-e-a-about-block-variants",
    componentType: "AboutBlock",
    part: "variants",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/AboutBlock/variants.json",
    sha256: "538ace7bb4adf58348dd5fc8b52fdee722f1d928128c693a7dffa9bd023e55c1",
    variantValues: ["technical-grid", "quiet"],
  },
  "m1-e-a-about-block-content-budget": {
    artifactId: "m1-e-a-about-block-content-budget",
    componentType: "AboutBlock",
    part: "contentBudget",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/AboutBlock/content-budget.json",
    sha256: "8760fabf8a469c9ea580d7512ad65d5f1841b783c08978b5277b2f59f01e3ae6",
  },
  "m1-e-a-about-block-accessibility": {
    artifactId: "m1-e-a-about-block-accessibility",
    componentType: "AboutBlock",
    part: "accessibility",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/AboutBlock/accessibility.json",
    sha256: "c6af6db34cbdc3600a740cc7c64f7afd89c8f5350d30c97ef09eb14c8cc6e1ac",
  },
  "m1-e-a-about-block-reduced-motion": {
    artifactId: "m1-e-a-about-block-reduced-motion",
    componentType: "AboutBlock",
    part: "reducedMotion",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/AboutBlock/reduced-motion.json",
    sha256: "77bc5823c1263beba8e2d900590306e403b0bb36bc2f00c24ffaae6fb7ff8cf2",
  },
  "m1-e-a-about-block-fixtures": {
    artifactId: "m1-e-a-about-block-fixtures",
    componentType: "AboutBlock",
    part: "fixtures",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/AboutBlock/fixtures.json",
    sha256: "8d4d4b04e12a55b3ad9baa2067016e442dda4bff8d3bf0af718685d465b91ef7",
    fixtureIds: ["technical-baseline"],
    fixtureFiles: [
      {
        fixtureId: "technical-baseline",
        repositoryPath:
          "apps/site-renderer/fixtures/technical-baseline-spec.json",
        sha256:
          "2e005c3251a94c17412a6a75a65c2e8ec5a6419bf328a44869b402b93b56d59a",
      },
    ],
  },
  "m1-e-a-about-block-visual-regression": {
    artifactId: "m1-e-a-about-block-visual-regression",
    componentType: "AboutBlock",
    part: "visualRegression",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/AboutBlock/visual-regression.json",
    sha256: "60c8bd510cbbe90598b07d714985bb4b6db6fe0f97312f1017db9681367d80ae",
    breakpoints: [375, 768, 1440],
    outputs: [
      {
        breakpoint: 375,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/mobile-375/AboutBlock.png",
        sha256:
          "25f7782b780c2078080e136c27e26197ada4b107b8f806ff888efabe31d255ce",
      },
      {
        breakpoint: 768,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/tablet-768/AboutBlock.png",
        sha256:
          "4d58ca7c1d950cc2b1ef9d0780373c6f57af1502ff18703e1a30922f19273ab2",
      },
      {
        breakpoint: 1440,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/desktop-1440/AboutBlock.png",
        sha256:
          "1712725276c40d882065892f15cd7d19aa1bb32a657c26818ce39d669bbbf57f",
      },
    ],
  },
  "m1-e-a-inquiry-form-schema": {
    artifactId: "m1-e-a-inquiry-form-schema",
    componentType: "InquiryForm",
    part: "schema",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/InquiryForm/schema.json",
    sha256: "257fcf15bf04ef5a0bbe4a3ffd3143d80a63a13d72050936e043164f1d37daf7",
  },
  "m1-e-a-inquiry-form-variants": {
    artifactId: "m1-e-a-inquiry-form-variants",
    componentType: "InquiryForm",
    part: "variants",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/InquiryForm/variants.json",
    sha256: "644c9f350ee7b3544da1f02b2866497a3377b65cb801ed595c19378589571eec",
    variantValues: ["technical-grid", "quiet"],
  },
  "m1-e-a-inquiry-form-content-budget": {
    artifactId: "m1-e-a-inquiry-form-content-budget",
    componentType: "InquiryForm",
    part: "contentBudget",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/InquiryForm/content-budget.json",
    sha256: "eda0a4b6efebb7d125343e3acf9ccf5ff5efa0a6f82ffa40cc1bc4634dd09722",
  },
  "m1-e-a-inquiry-form-accessibility": {
    artifactId: "m1-e-a-inquiry-form-accessibility",
    componentType: "InquiryForm",
    part: "accessibility",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/InquiryForm/accessibility.json",
    sha256: "25c06eed227bfec41fb72088d9d4b9568df8e6d97093229dcc7737480028fa92",
  },
  "m1-e-a-inquiry-form-reduced-motion": {
    artifactId: "m1-e-a-inquiry-form-reduced-motion",
    componentType: "InquiryForm",
    part: "reducedMotion",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/InquiryForm/reduced-motion.json",
    sha256: "2a95a71286296f134ed12e573ed47b72c297de2fc4ba06991b8458adbb8c2954",
  },
  "m1-e-a-inquiry-form-fixtures": {
    artifactId: "m1-e-a-inquiry-form-fixtures",
    componentType: "InquiryForm",
    part: "fixtures",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/InquiryForm/fixtures.json",
    sha256: "534e0e1bb404c50ce065fe7c92722ff4bd33a2d3fd2847faf59434166d56b7f2",
    fixtureIds: ["technical-baseline"],
    fixtureFiles: [
      {
        fixtureId: "technical-baseline",
        repositoryPath:
          "apps/site-renderer/fixtures/technical-baseline-spec.json",
        sha256:
          "2e005c3251a94c17412a6a75a65c2e8ec5a6419bf328a44869b402b93b56d59a",
      },
    ],
  },
  "m1-e-a-inquiry-form-visual-regression": {
    artifactId: "m1-e-a-inquiry-form-visual-regression",
    componentType: "InquiryForm",
    part: "visualRegression",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/InquiryForm/visual-regression.json",
    sha256: "ac2818c98a4b693f5be7d9ac26ce465efc2db62088c91e3a63ad6f38a0ec6f05",
    breakpoints: [375, 768, 1440],
    outputs: [
      {
        breakpoint: 375,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/mobile-375/InquiryForm.png",
        sha256:
          "e4c92fcc24942a8f0caa3382337fd4073549514069a67ebe8b330e08e3034220",
      },
      {
        breakpoint: 768,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/tablet-768/InquiryForm.png",
        sha256:
          "2fedd26d4ab91ebd639c0485155a7ad6b64fd3c110c2cd42f6c9ed4daa5ec69b",
      },
      {
        breakpoint: 1440,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/desktop-1440/InquiryForm.png",
        sha256:
          "d2ef6eced4d008ec83f9a864f60fb87985841d2e21076d441dd09bf21543d69e",
      },
    ],
  },
  "m1-e-a-cert-wall-schema": { artifactId: "m1-e-a-cert-wall-schema", componentType: "CertWall", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/CertWall/schema.json", sha256: "2d222ece313dd34170691738009801de3534003b76b64d6be3bba95723e52a4e" },
  "m1-e-a-cert-wall-variants": { artifactId: "m1-e-a-cert-wall-variants", componentType: "CertWall", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/CertWall/variants.json", sha256: "74ee31c22a399bd37e04160976abdcc494c60e9bb40368768db22cb1a1b78883", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-cert-wall-content-budget": { artifactId: "m1-e-a-cert-wall-content-budget", componentType: "CertWall", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/CertWall/content-budget.json", sha256: "14deaed85ff805fa479e600435e8f979300e0c29279f6aec5ce5617de001fad0" },
  "m1-e-a-cert-wall-accessibility": { artifactId: "m1-e-a-cert-wall-accessibility", componentType: "CertWall", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/CertWall/accessibility.json", sha256: "0924c8433483d6b7bb16d0f8750e12d58447f973e55fd3f558e2f78f0071845a" },
  "m1-e-a-cert-wall-reduced-motion": { artifactId: "m1-e-a-cert-wall-reduced-motion", componentType: "CertWall", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/CertWall/reduced-motion.json", sha256: "c774550b663c7424e49210caee6987c4ee714127f71164eea847f031fc1eb5a7" },
  "m1-e-a-cert-wall-fixtures": { artifactId: "m1-e-a-cert-wall-fixtures", componentType: "CertWall", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/CertWall/fixtures.json", sha256: "a2b1d47140dffb1ee410990a86ab898ab997e16982dad1055c620de66f324b68", fixtureIds: ["technical-baseline"], fixtureFiles: [{ fixtureId: "technical-baseline", repositoryPath: "apps/site-renderer/fixtures/technical-baseline-spec.json", sha256: "2e005c3251a94c17412a6a75a65c2e8ec5a6419bf328a44869b402b93b56d59a" }] },
  "m1-e-a-cert-wall-visual-regression": { artifactId: "m1-e-a-cert-wall-visual-regression", componentType: "CertWall", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/CertWall/visual-regression.json", sha256: "1e8619303422b5cc5508dae95ac332f1a0a96213e92651eeee55f2a4fa59457c", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/mobile-375/CertWall.png", sha256: "b5809a57c744f452ae581136dcba7cd810fd7c9e5421539b3a118d9ab338b865" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/tablet-768/CertWall.png", sha256: "04a8be938fe3d435c9376889515495035c09f77823ce87e6dc6414148b316d26" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/desktop-1440/CertWall.png", sha256: "9928faff68bbc6a6e6a87044789005716677e7e32fc94bc0dc2d36ae179b03b5" }] },
  "m1-e-a-process-timeline-schema": { artifactId: "m1-e-a-process-timeline-schema", componentType: "ProcessTimeline", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessTimeline/schema.json", sha256: "9e4ac3e3cccd56e7667108dfd45b338a7e62cbd7f6ffc51ecedd88e169420bf4" },
  "m1-e-a-process-timeline-variants": { artifactId: "m1-e-a-process-timeline-variants", componentType: "ProcessTimeline", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessTimeline/variants.json", sha256: "d31f04ac02ca9e012a0ad116126e92cb8fb7252b137d5f4b4f4b9a2ae1beda61", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-process-timeline-content-budget": { artifactId: "m1-e-a-process-timeline-content-budget", componentType: "ProcessTimeline", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessTimeline/content-budget.json", sha256: "c0f2df8fc46de0c690729dd947fa1e03849e95d111ee60320f215230c75d2e11" },
  "m1-e-a-process-timeline-accessibility": { artifactId: "m1-e-a-process-timeline-accessibility", componentType: "ProcessTimeline", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessTimeline/accessibility.json", sha256: "d41dc582b5910b2e062d908587a392b9a4ee20dc692c91858b5c259b3975e1ae" },
  "m1-e-a-process-timeline-reduced-motion": { artifactId: "m1-e-a-process-timeline-reduced-motion", componentType: "ProcessTimeline", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessTimeline/reduced-motion.json", sha256: "c7e20675b75fe371021a27d7da670ddca7d037c7c94f064b3a79f12a0d099c80" },
  "m1-e-a-process-timeline-fixtures": { artifactId: "m1-e-a-process-timeline-fixtures", componentType: "ProcessTimeline", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessTimeline/fixtures.json", sha256: "292415f8b532efc8a4bd31c3efe18d957dd70a56b355e0d9003e38487dd6c8be", fixtureIds: ["technical-baseline"], fixtureFiles: [{ fixtureId: "technical-baseline", repositoryPath: "apps/site-renderer/fixtures/technical-baseline-spec.json", sha256: "2e005c3251a94c17412a6a75a65c2e8ec5a6419bf328a44869b402b93b56d59a" }] },
  "m1-e-a-process-timeline-visual-regression": { artifactId: "m1-e-a-process-timeline-visual-regression", componentType: "ProcessTimeline", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessTimeline/visual-regression.json", sha256: "9b36f10265bb6a3fcbe177154b76c6f5371fe49c84cf45d27b4d9a24d8856fa5", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/mobile-375/ProcessTimeline.png", sha256: "5728cdcf52ff4b58e8d2626caa41425b663ba01c176c525327f5e446e0edf8ed" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/tablet-768/ProcessTimeline.png", sha256: "45c0c01440443cac576576ec00638561e50ea00420c3db65d97dbb3b74f34cb4" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/desktop-1440/ProcessTimeline.png", sha256: "b9a0f76bd5eb728f9e8e889a032258c075973f5869f5963990083994faf99bfb" }] },
  "m1-e-a-faq-accordion-schema": { artifactId: "m1-e-a-faq-accordion-schema", componentType: "FaqAccordion", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqAccordion/schema.json", sha256: "700f4f0f6859d8a61470a780114500fc1a4ee2a0e4cf05472922b326836b2d65" },
  "m1-e-a-faq-accordion-variants": { artifactId: "m1-e-a-faq-accordion-variants", componentType: "FaqAccordion", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqAccordion/variants.json", sha256: "8768f280f66e86564aab4976d1073120601873c2ede924123a75f95b66e4caeb", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-faq-accordion-content-budget": { artifactId: "m1-e-a-faq-accordion-content-budget", componentType: "FaqAccordion", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqAccordion/content-budget.json", sha256: "69b568f65c01388cff491949c3b5be24a7350018ff834b32f993d0dd5cb1e50e" },
  "m1-e-a-faq-accordion-accessibility": { artifactId: "m1-e-a-faq-accordion-accessibility", componentType: "FaqAccordion", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqAccordion/accessibility.json", sha256: "e26ef6bc3495320ea979e99120cbb2c67a193801a76b8fc6f6b6ce8a52464999" },
  "m1-e-a-faq-accordion-reduced-motion": { artifactId: "m1-e-a-faq-accordion-reduced-motion", componentType: "FaqAccordion", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqAccordion/reduced-motion.json", sha256: "3c03341f4530613e41ad224cdfa1cda9e8cfed9a2dff8e3647d7368ce59472f1" },
  "m1-e-a-faq-accordion-fixtures": { artifactId: "m1-e-a-faq-accordion-fixtures", componentType: "FaqAccordion", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqAccordion/fixtures.json", sha256: "eccb6944d5b115410a35ffddb3eecf85a2efb01e3bcfcd20cfe5a8ef0604f865", fixtureIds: ["technical-baseline"], fixtureFiles: [{ fixtureId: "technical-baseline", repositoryPath: "apps/site-renderer/fixtures/technical-baseline-spec.json", sha256: "2e005c3251a94c17412a6a75a65c2e8ec5a6419bf328a44869b402b93b56d59a" }] },
  "m1-e-a-faq-accordion-visual-regression": { artifactId: "m1-e-a-faq-accordion-visual-regression", componentType: "FaqAccordion", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqAccordion/visual-regression.json", sha256: "a692698664599c90cbb50ed53d924fcbf433d213878a2c8eded60ac97196977b", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/mobile-375/FaqAccordion.png", sha256: "dbd624ce16b9c64dc81c60d59e5400ff413abb3aa24dd9a9c522b017c16f3096" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/tablet-768/FaqAccordion.png", sha256: "4e29e40ab1dbc6009100293d5bc276c98c80d61c90e54f6845b985241ce1f793" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/desktop-1440/FaqAccordion.png", sha256: "f4e156791e8fd4fed55f8081fe23100b126b3e5f993bf0bf2bccea4719637dce" }] },
  "m1-e-a-logo-marquee-schema": { artifactId: "m1-e-a-logo-marquee-schema", componentType: "LogoMarquee", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/LogoMarquee/schema.json", sha256: "906ff3fd388d7f2292da0cef131ed3f911d748f4038378dcec15dd0e66f4ea16" },
  "m1-e-a-logo-marquee-variants": { artifactId: "m1-e-a-logo-marquee-variants", componentType: "LogoMarquee", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/LogoMarquee/variants.json", sha256: "8ae2e75241a58d8085123313d7269a0d987c62eb02af99b6aef2e97098a10b1e", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-logo-marquee-content-budget": { artifactId: "m1-e-a-logo-marquee-content-budget", componentType: "LogoMarquee", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/LogoMarquee/content-budget.json", sha256: "9f1c474cff58d06b0f31982a8caec3f2dc521d11a227415d95cd7032a04c8cc2" },
  "m1-e-a-logo-marquee-accessibility": { artifactId: "m1-e-a-logo-marquee-accessibility", componentType: "LogoMarquee", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/LogoMarquee/accessibility.json", sha256: "169f999f722905f34a421f1d6aa47a17cd7bd9c00ac15e2574348667e9c6b160" },
  "m1-e-a-logo-marquee-reduced-motion": { artifactId: "m1-e-a-logo-marquee-reduced-motion", componentType: "LogoMarquee", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/LogoMarquee/reduced-motion.json", sha256: "75349066e00ebba8778e66171d3fb8eaf427d9bd71a519637fddb719f3f54f58" },
  "m1-e-a-logo-marquee-fixtures": { artifactId: "m1-e-a-logo-marquee-fixtures", componentType: "LogoMarquee", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/LogoMarquee/fixtures.json", sha256: "ab611eb37c0348dfbc791f73f21af99cb16d0251729e4a5c590f2beb98c66574", fixtureIds: ["technical-baseline"], fixtureFiles: [{ fixtureId: "technical-baseline", repositoryPath: "apps/site-renderer/fixtures/technical-baseline-spec.json", sha256: "2e005c3251a94c17412a6a75a65c2e8ec5a6419bf328a44869b402b93b56d59a" }] },
  "m1-e-a-logo-marquee-visual-regression": { artifactId: "m1-e-a-logo-marquee-visual-regression", componentType: "LogoMarquee", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/LogoMarquee/visual-regression.json", sha256: "d6c4b257683f6315bc359ea81d3296cd972831636faa87433e283a3ac45423b9", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/mobile-375/LogoMarquee.png", sha256: "e0d32805860661ef5690ae0096f9e8384561d02fd8d2e62065ec5bdcf755cebe" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/tablet-768/LogoMarquee.png", sha256: "04cac69f5a96621705b7e5287d25d18e5f0a9a43168311d6ac9db37e9aa7fa6a" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/desktop-1440/LogoMarquee.png", sha256: "302d9c654e14f7078357ea1317ad286e1cb7d34be2be58d7aaa9284aac096b27" }] },
  "m1-e-a-testimonials-schema": { artifactId: "m1-e-a-testimonials-schema", componentType: "Testimonials", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/Testimonials/schema.json", sha256: "7c5965dca5b1ef6c046cd738beef747f7ed2779e078dfadf159476195bfabc7a" },
  "m1-e-a-testimonials-variants": { artifactId: "m1-e-a-testimonials-variants", componentType: "Testimonials", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/Testimonials/variants.json", sha256: "efe38e12d363723a3768bedc26fcf836460ca83f51995a65f9138de24ec02334", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-testimonials-content-budget": { artifactId: "m1-e-a-testimonials-content-budget", componentType: "Testimonials", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/Testimonials/content-budget.json", sha256: "fa958f190444c05d7f0419f838f07f929a0132ba7dbe1af370bca30da8122946" },
  "m1-e-a-testimonials-accessibility": { artifactId: "m1-e-a-testimonials-accessibility", componentType: "Testimonials", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/Testimonials/accessibility.json", sha256: "88269869af60e7c4e20cba9ff14f299a47b273ebbcee4e1f1b2e06e3866805e7" },
  "m1-e-a-testimonials-reduced-motion": { artifactId: "m1-e-a-testimonials-reduced-motion", componentType: "Testimonials", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/Testimonials/reduced-motion.json", sha256: "86655c0e5e6f1f4ec856af87f758a34ff668674d71614f2da641ad5af49a72ba" },
  "m1-e-a-testimonials-fixtures": { artifactId: "m1-e-a-testimonials-fixtures", componentType: "Testimonials", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/Testimonials/fixtures.json", sha256: "c860817832d3e66a5c55d7b0c919d6b5334f7ea56665e638d14f570bfc1ec545", fixtureIds: ["technical-baseline"], fixtureFiles: [{ fixtureId: "technical-baseline", repositoryPath: "apps/site-renderer/fixtures/technical-baseline-spec.json", sha256: "2e005c3251a94c17412a6a75a65c2e8ec5a6419bf328a44869b402b93b56d59a" }] },
  "m1-e-a-testimonials-visual-regression": { artifactId: "m1-e-a-testimonials-visual-regression", componentType: "Testimonials", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/Testimonials/visual-regression.json", sha256: "797933713cc2774d44eb6e05bcc8569baf7c0104230e94489e90d878a0b20080", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/mobile-375/Testimonials.png", sha256: "760e39c9b2c737e483c15746e0c53b4d774abbdf79d48e0c2ffc3e3467f944c3" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/tablet-768/Testimonials.png", sha256: "a7defbd2ad1285bcd82dbf94eba25f6ce4473d0c71d8bf5789f7315ec2c56bbc" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/desktop-1440/Testimonials.png", sha256: "92bdd3a5a090dc2274a3518634a7134bd8a2ab79a4e924ae1f8b0bd077e7c979" }] },
  "m1-e-a-feature-cards-schema": { artifactId: "m1-e-a-feature-cards-schema", componentType: "FeatureCards", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/FeatureCards/schema.json", sha256: "f0005c0b9534e223428ee9e15206e0df84bb257fa70679b4f826a71c98b7212d" },
  "m1-e-a-feature-cards-variants": { artifactId: "m1-e-a-feature-cards-variants", componentType: "FeatureCards", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/FeatureCards/variants.json", sha256: "70356b849b81169e0a7233472631c8436e66730138e823a27175658858071970", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-feature-cards-content-budget": { artifactId: "m1-e-a-feature-cards-content-budget", componentType: "FeatureCards", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/FeatureCards/content-budget.json", sha256: "c0f6ddc81f4564c449b8606baf8b048a659ee5b78f882b909736b8366226c0bb" },
  "m1-e-a-feature-cards-accessibility": { artifactId: "m1-e-a-feature-cards-accessibility", componentType: "FeatureCards", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/FeatureCards/accessibility.json", sha256: "7e7ee6a5b0adb87e2a42b99a9d09858000349c55ee38a530a8b97cc24666fca3" },
  "m1-e-a-feature-cards-reduced-motion": { artifactId: "m1-e-a-feature-cards-reduced-motion", componentType: "FeatureCards", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/FeatureCards/reduced-motion.json", sha256: "b81560a4e5e7d54f09aa74c849af6e3a450fbc5dec7840d2a801e48646e19d8b" },
  "m1-e-a-feature-cards-fixtures": { artifactId: "m1-e-a-feature-cards-fixtures", componentType: "FeatureCards", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/FeatureCards/fixtures.json", sha256: "049d237419ffd6d1693aef258e95a96a3ab0a95282ffdac37b5d059cb6904003", fixtureIds: ["technical-baseline"], fixtureFiles: [{ fixtureId: "technical-baseline", repositoryPath: "apps/site-renderer/fixtures/technical-baseline-spec.json", sha256: "2e005c3251a94c17412a6a75a65c2e8ec5a6419bf328a44869b402b93b56d59a" }] },
  "m1-e-a-feature-cards-visual-regression": { artifactId: "m1-e-a-feature-cards-visual-regression", componentType: "FeatureCards", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/FeatureCards/visual-regression.json", sha256: "e5ddf8f6561ed14ca6b3b21c30c65039919c66eabd5f8487904164ac2916160d", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/mobile-375/FeatureCards.png", sha256: "71fe45571c6dc1297665e90103ae4da7d16967423b1fcba9de25214d45bad910" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/tablet-768/FeatureCards.png", sha256: "fa0b747f1b4c60f919e176a365ad98000027303019329dbe1b98d48296f0cca7" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/desktop-1440/FeatureCards.png", sha256: "714e0b6cd6363d1e1ad61597ac0ba27f775fa763cbcb03efe5c0a3c910cce7b1" }] },
  "m1-e-a-tech-systems-schema": { artifactId: "m1-e-a-tech-systems-schema", componentType: "TechSystems", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/TechSystems/schema.json", sha256: "af56e3720c232311573403243ee26a56702d060f9e19b4a609084f177e2f6a95" },
  "m1-e-a-tech-systems-variants": { artifactId: "m1-e-a-tech-systems-variants", componentType: "TechSystems", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/TechSystems/variants.json", sha256: "05cbacec98163757ce85ae3ed0bae13d14d6342a044ad079fa6f2a54cbffbc55", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-tech-systems-content-budget": { artifactId: "m1-e-a-tech-systems-content-budget", componentType: "TechSystems", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/TechSystems/content-budget.json", sha256: "a2b35abb090df3442e447101cd6f09b9483a1d4561ffe250e5ade4c00e8baa0e" },
  "m1-e-a-tech-systems-accessibility": { artifactId: "m1-e-a-tech-systems-accessibility", componentType: "TechSystems", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/TechSystems/accessibility.json", sha256: "9e3ec6dbbd8413841045682976334dad1236e1f7185aabb109d80ca82e5373ee" },
  "m1-e-a-tech-systems-reduced-motion": { artifactId: "m1-e-a-tech-systems-reduced-motion", componentType: "TechSystems", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/TechSystems/reduced-motion.json", sha256: "a98e84fca450c50ddc8bb486705818473032ee62b4ac6a081fecb76b514a3ad3" },
  "m1-e-a-tech-systems-fixtures": { artifactId: "m1-e-a-tech-systems-fixtures", componentType: "TechSystems", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/TechSystems/fixtures.json", sha256: "d406053310c7d179ec587186ff143fca40bbb2f5622b4eed5e05e5b91997b17d", fixtureIds: ["technical-baseline"], fixtureFiles: [{ fixtureId: "technical-baseline", repositoryPath: "apps/site-renderer/fixtures/technical-baseline-spec.json", sha256: "2e005c3251a94c17412a6a75a65c2e8ec5a6419bf328a44869b402b93b56d59a" }] },
  "m1-e-a-tech-systems-visual-regression": { artifactId: "m1-e-a-tech-systems-visual-regression", componentType: "TechSystems", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/TechSystems/visual-regression.json", sha256: "b26694e18fcde5ee57a8c33b365982e42f6f496220b05929334a17de79f98567", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/mobile-375/TechSystems.png", sha256: "fc4131ca06bb7658d8256039eb2f903f73a6e8236cd2ebe5d576d1e4821f2cdb" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/tablet-768/TechSystems.png", sha256: "d48622c7ac6a84529a5d2e9b1740b9cd39836f78dc93ab5e95c10b80e76e33c0" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/desktop-1440/TechSystems.png", sha256: "eedc5175dbd6e84310399b2b38790582d3c9c8ff0e41f60bc4d1dbfbd579e563" }] },
} satisfies Record<string, ComponentQualificationArtifact>);

/**
 * Only components with real evidence for all seven M1-e-A parts belong here.
 * The registry starts empty: gallery extraction and legacy release eligibility
 * are not qualification evidence.
 */
export const M1_E_A_COMPONENT_QUALIFICATIONS: Readonly<
  Partial<Record<SiteSpecComponentType, ComponentQualificationEvidence>>
> = Object.freeze({
  CtaBanner: {
    schema: { artifactId: "m1-e-a-cta-banner-schema" },
    variants: { artifactId: "m1-e-a-cta-banner-variants" },
    contentBudget: { artifactId: "m1-e-a-cta-banner-content-budget" },
    accessibility: { artifactId: "m1-e-a-cta-banner-accessibility" },
    reducedMotion: { artifactId: "m1-e-a-cta-banner-reduced-motion" },
    fixtures: { artifactId: "m1-e-a-cta-banner-fixtures" },
    visualRegression: {
      artifactId: "m1-e-a-cta-banner-visual-regression",
    },
  },
  HeroBanner: {
    schema: { artifactId: "m1-e-a-hero-banner-schema" },
    variants: { artifactId: "m1-e-a-hero-banner-variants" },
    contentBudget: { artifactId: "m1-e-a-hero-banner-content-budget" },
    accessibility: { artifactId: "m1-e-a-hero-banner-accessibility" },
    reducedMotion: { artifactId: "m1-e-a-hero-banner-reduced-motion" },
    fixtures: { artifactId: "m1-e-a-hero-banner-fixtures" },
    visualRegression: {
      artifactId: "m1-e-a-hero-banner-visual-regression",
    },
  },
  StatsBand: {
    schema: { artifactId: "m1-e-a-stats-band-schema" },
    variants: { artifactId: "m1-e-a-stats-band-variants" },
    contentBudget: { artifactId: "m1-e-a-stats-band-content-budget" },
    accessibility: { artifactId: "m1-e-a-stats-band-accessibility" },
    reducedMotion: { artifactId: "m1-e-a-stats-band-reduced-motion" },
    fixtures: { artifactId: "m1-e-a-stats-band-fixtures" },
    visualRegression: {
      artifactId: "m1-e-a-stats-band-visual-regression",
    },
  },
  ProductGrid: {
    schema: { artifactId: "m1-e-a-product-grid-schema" },
    variants: { artifactId: "m1-e-a-product-grid-variants" },
    contentBudget: { artifactId: "m1-e-a-product-grid-content-budget" },
    accessibility: { artifactId: "m1-e-a-product-grid-accessibility" },
    reducedMotion: { artifactId: "m1-e-a-product-grid-reduced-motion" },
    fixtures: { artifactId: "m1-e-a-product-grid-fixtures" },
    visualRegression: { artifactId: "m1-e-a-product-grid-visual-regression" },
  },
  AboutBlock: {
    schema: { artifactId: "m1-e-a-about-block-schema" },
    variants: { artifactId: "m1-e-a-about-block-variants" },
    contentBudget: { artifactId: "m1-e-a-about-block-content-budget" },
    accessibility: { artifactId: "m1-e-a-about-block-accessibility" },
    reducedMotion: { artifactId: "m1-e-a-about-block-reduced-motion" },
    fixtures: { artifactId: "m1-e-a-about-block-fixtures" },
    visualRegression: { artifactId: "m1-e-a-about-block-visual-regression" },
  },
  InquiryForm: {
    schema: { artifactId: "m1-e-a-inquiry-form-schema" },
    variants: { artifactId: "m1-e-a-inquiry-form-variants" },
    contentBudget: { artifactId: "m1-e-a-inquiry-form-content-budget" },
    accessibility: { artifactId: "m1-e-a-inquiry-form-accessibility" },
    reducedMotion: { artifactId: "m1-e-a-inquiry-form-reduced-motion" },
    fixtures: { artifactId: "m1-e-a-inquiry-form-fixtures" },
    visualRegression: { artifactId: "m1-e-a-inquiry-form-visual-regression" },
  },
  CertWall: {
    schema: { artifactId: "m1-e-a-cert-wall-schema" },
    variants: { artifactId: "m1-e-a-cert-wall-variants" },
    contentBudget: { artifactId: "m1-e-a-cert-wall-content-budget" },
    accessibility: { artifactId: "m1-e-a-cert-wall-accessibility" },
    reducedMotion: { artifactId: "m1-e-a-cert-wall-reduced-motion" },
    fixtures: { artifactId: "m1-e-a-cert-wall-fixtures" },
    visualRegression: { artifactId: "m1-e-a-cert-wall-visual-regression" },
  },
  ProcessTimeline: {
    schema: { artifactId: "m1-e-a-process-timeline-schema" },
    variants: { artifactId: "m1-e-a-process-timeline-variants" },
    contentBudget: { artifactId: "m1-e-a-process-timeline-content-budget" },
    accessibility: { artifactId: "m1-e-a-process-timeline-accessibility" },
    reducedMotion: { artifactId: "m1-e-a-process-timeline-reduced-motion" },
    fixtures: { artifactId: "m1-e-a-process-timeline-fixtures" },
    visualRegression: { artifactId: "m1-e-a-process-timeline-visual-regression" },
  },
  FaqAccordion: {
    schema: { artifactId: "m1-e-a-faq-accordion-schema" },
    variants: { artifactId: "m1-e-a-faq-accordion-variants" },
    contentBudget: { artifactId: "m1-e-a-faq-accordion-content-budget" },
    accessibility: { artifactId: "m1-e-a-faq-accordion-accessibility" },
    reducedMotion: { artifactId: "m1-e-a-faq-accordion-reduced-motion" },
    fixtures: { artifactId: "m1-e-a-faq-accordion-fixtures" },
    visualRegression: { artifactId: "m1-e-a-faq-accordion-visual-regression" },
  },
  LogoMarquee: {
    schema: { artifactId: "m1-e-a-logo-marquee-schema" }, variants: { artifactId: "m1-e-a-logo-marquee-variants" }, contentBudget: { artifactId: "m1-e-a-logo-marquee-content-budget" }, accessibility: { artifactId: "m1-e-a-logo-marquee-accessibility" }, reducedMotion: { artifactId: "m1-e-a-logo-marquee-reduced-motion" }, fixtures: { artifactId: "m1-e-a-logo-marquee-fixtures" }, visualRegression: { artifactId: "m1-e-a-logo-marquee-visual-regression" },
  },
  Testimonials: {
    schema: { artifactId: "m1-e-a-testimonials-schema" }, variants: { artifactId: "m1-e-a-testimonials-variants" }, contentBudget: { artifactId: "m1-e-a-testimonials-content-budget" }, accessibility: { artifactId: "m1-e-a-testimonials-accessibility" }, reducedMotion: { artifactId: "m1-e-a-testimonials-reduced-motion" }, fixtures: { artifactId: "m1-e-a-testimonials-fixtures" }, visualRegression: { artifactId: "m1-e-a-testimonials-visual-regression" },
  },
  FeatureCards: {
    schema: { artifactId: "m1-e-a-feature-cards-schema" }, variants: { artifactId: "m1-e-a-feature-cards-variants" }, contentBudget: { artifactId: "m1-e-a-feature-cards-content-budget" }, accessibility: { artifactId: "m1-e-a-feature-cards-accessibility" }, reducedMotion: { artifactId: "m1-e-a-feature-cards-reduced-motion" }, fixtures: { artifactId: "m1-e-a-feature-cards-fixtures" }, visualRegression: { artifactId: "m1-e-a-feature-cards-visual-regression" },
  },
  TechSystems: {
    schema: { artifactId: "m1-e-a-tech-systems-schema" }, variants: { artifactId: "m1-e-a-tech-systems-variants" }, contentBudget: { artifactId: "m1-e-a-tech-systems-content-budget" }, accessibility: { artifactId: "m1-e-a-tech-systems-accessibility" }, reducedMotion: { artifactId: "m1-e-a-tech-systems-reduced-motion" }, fixtures: { artifactId: "m1-e-a-tech-systems-fixtures" }, visualRegression: { artifactId: "m1-e-a-tech-systems-visual-regression" },
  },
});

export interface ReleaseQualificationRegistryInput {
  releaseTypes: readonly string[];
  qualifications: Readonly<
    Partial<Record<SiteSpecComponentType, ComponentQualificationEvidence>>
  >;
  artifacts: Readonly<Record<string, ComponentQualificationArtifact>>;
}

export type ComponentReleaseReadiness =
  | { status: "gallery_only" }
  | { status: "transitional_release" }
  | {
      status: "m1_e_a_qualified";
      evidence: ComponentQualificationEvidence;
    };

function qualificationError(
  type: SiteSpecComponentType,
  detail: string,
): Error {
  return new Error(`COMPONENT_QUALIFICATION_INVALID: ${type} -- ${detail}`);
}

function validateArtifactPath(
  type: SiteSpecComponentType,
  artifact: ComponentQualificationArtifact,
): void {
  const prefix = `docs/evidence/site-builder/component-qualification/${type}/`;
  if (
    !artifact.repositoryPath.startsWith(prefix) ||
    !artifact.repositoryPath.endsWith(".json") ||
    artifact.repositoryPath.includes("..") ||
    artifact.repositoryPath.includes("\\")
  ) {
    throw qualificationError(
      type,
      `${artifact.artifactId}: invalid repositoryPath`,
    );
  }
}

function validateRepositoryBytePath(
  type: SiteSpecComponentType,
  artifactId: string,
  repositoryPath: string,
  prefix: string,
  suffix: string,
): void {
  if (
    !repositoryPath.startsWith(prefix) ||
    !repositoryPath.endsWith(suffix) ||
    repositoryPath.includes("..") ||
    repositoryPath.includes("\\")
  ) {
    throw qualificationError(
      type,
      `${artifactId}: invalid byte repositoryPath`,
    );
  }
}

export function validateComponentQualification(
  type: SiteSpecComponentType,
  evidence: ComponentQualificationEvidence,
  artifacts: Readonly<
    Record<string, ComponentQualificationArtifact>
  > = M1_E_A_COMPONENT_QUALIFICATION_ARTIFACTS,
): ComponentQualificationEvidence {
  const parsed = componentQualificationSchema.safeParse(evidence);
  if (!parsed.success) {
    throw qualificationError(
      type,
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    );
  }

  const referencedIds = new Set<string>();
  for (const part of COMPONENT_QUALIFICATION_PARTS) {
    const artifactId = parsed.data[part].artifactId;
    if (referencedIds.has(artifactId)) {
      throw qualificationError(
        type,
        `${part}: duplicate artifactId ${artifactId}`,
      );
    }
    referencedIds.add(artifactId);

    const artifact = artifacts[artifactId];
    const parsedArtifact =
      componentQualificationArtifactSchema.safeParse(artifact);
    if (!parsedArtifact.success) {
      throw qualificationError(
        type,
        `${part}: unresolved or invalid ${artifactId}`,
      );
    }
    if (
      parsedArtifact.data.artifactId !== artifactId ||
      parsedArtifact.data.componentType !== type ||
      parsedArtifact.data.part !== part
    ) {
      throw qualificationError(
        type,
        `${part}: mismatched artifact ${artifactId}`,
      );
    }
    validateArtifactPath(type, parsedArtifact.data);

    if (
      parsedArtifact.data.part === "variants" &&
      new Set(parsedArtifact.data.variantValues).size !==
        parsedArtifact.data.variantValues.length
    ) {
      throw qualificationError(type, `${part}: variant values must be unique`);
    }
    if (
      parsedArtifact.data.part === "fixtures" &&
      new Set(parsedArtifact.data.fixtureIds).size !==
        parsedArtifact.data.fixtureIds.length
    ) {
      throw qualificationError(type, `${part}: fixture ids must be unique`);
    }
    if (parsedArtifact.data.part === "fixtures") {
      const fixtureArtifact = parsedArtifact.data;
      const fileIds = fixtureArtifact.fixtureFiles.map(
        ({ fixtureId }) => fixtureId,
      );
      if (
        fileIds.length !== fixtureArtifact.fixtureIds.length ||
        fileIds.some(
          (fixtureId, index) => fixtureId !== fixtureArtifact.fixtureIds[index],
        )
      ) {
        throw qualificationError(
          type,
          `${part}: fixture files must match fixture ids`,
        );
      }
      for (const fixture of fixtureArtifact.fixtureFiles) {
        validateRepositoryBytePath(
          type,
          fixtureArtifact.artifactId,
          fixture.repositoryPath,
          "apps/site-renderer/fixtures/",
          ".json",
        );
      }
    }
    if (parsedArtifact.data.part === "visualRegression") {
      const visualArtifact = parsedArtifact.data;
      const breakpointDirectories = {
        375: "mobile-375",
        768: "tablet-768",
        1440: "desktop-1440",
      } as const;
      for (const output of visualArtifact.outputs) {
        const expectedPath =
          "apps/site-renderer/visual-tests/__screenshots__/" +
          `${breakpointDirectories[output.breakpoint]}/${type}.png`;
        validateRepositoryBytePath(
          type,
          visualArtifact.artifactId,
          output.repositoryPath,
          expectedPath,
          ".png",
        );
        if (output.repositoryPath !== expectedPath) {
          throw qualificationError(
            type,
            `${part}: output path does not match breakpoint`,
          );
        }
      }
    }
  }

  return parsed.data;
}

export function assertReleaseQualificationRegistryIntegrity(
  input: ReleaseQualificationRegistryInput = {
    releaseTypes: SITE_SPEC_RELEASE_COMPONENT_TYPES,
    qualifications: M1_E_A_COMPONENT_QUALIFICATIONS,
    artifacts: M1_E_A_COMPONENT_QUALIFICATION_ARTIFACTS,
  },
): void {
  const componentTypes = new Set<string>(SITE_SPEC_COMPONENT_TYPES);
  const releaseTypes = new Set(input.releaseTypes);
  const transitionalTypes = new Set<string>(
    SITE_SPEC_TRANSITIONAL_RELEASE_COMPONENT_TYPES,
  );

  for (const type of SITE_SPEC_TRANSITIONAL_RELEASE_COMPONENT_TYPES) {
    if (!releaseTypes.has(type)) {
      throw new Error(`COMPONENT_RELEASE_REGISTRY_INVALID: ${type}`);
    }
  }

  for (const type of input.releaseTypes) {
    if (!componentTypes.has(type)) {
      throw new Error(`COMPONENT_RELEASE_REGISTRY_INVALID: ${type}`);
    }
    if (transitionalTypes.has(type)) continue;
    const evidence = input.qualifications[type as SiteSpecComponentType];
    if (!evidence) {
      throw new Error(`COMPONENT_RELEASE_REGISTRY_INVALID: ${type}`);
    }
    validateComponentQualification(
      type as SiteSpecComponentType,
      evidence,
      input.artifacts,
    );
  }

  for (const [type, evidence] of Object.entries(input.qualifications)) {
    if (!componentTypes.has(type) || !releaseTypes.has(type) || !evidence) {
      throw new Error(`COMPONENT_RELEASE_REGISTRY_INVALID: ${type}`);
    }
    validateComponentQualification(
      type as SiteSpecComponentType,
      evidence as ComponentQualificationEvidence,
      input.artifacts,
    );
  }
}

export function getComponentReleaseReadiness(
  type: SiteSpecComponentType,
): ComponentReleaseReadiness {
  const evidence = M1_E_A_COMPONENT_QUALIFICATIONS[type];
  if (evidence) {
    return {
      status: "m1_e_a_qualified",
      evidence: validateComponentQualification(
        type,
        evidence,
        M1_E_A_COMPONENT_QUALIFICATION_ARTIFACTS,
      ),
    };
  }
  if (
    SITE_SPEC_TRANSITIONAL_RELEASE_COMPONENT_TYPES.includes(
      type as (typeof SITE_SPEC_TRANSITIONAL_RELEASE_COMPONENT_TYPES)[number],
    )
  ) {
    return { status: "transitional_release" };
  }
  return { status: "gallery_only" };
}

export function assertReleaseComponentEligible(
  type: SiteSpecComponentType,
): void {
  if (!SITE_SPEC_RELEASE_COMPONENT_TYPES.includes(type as never)) {
    throw new Error(`SITE_RELEASE_COMPONENT_NOT_ELIGIBLE: ${type}`);
  }
  const readiness = getComponentReleaseReadiness(type);
  if (
    readiness.status !== "transitional_release" &&
    readiness.status !== "m1_e_a_qualified"
  ) {
    throw new Error(`SITE_RELEASE_COMPONENT_NOT_ELIGIBLE: ${type}`);
  }
}

assertReleaseQualificationRegistryIntegrity();
