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
    sha256: "5bd63cfb9e00373ac44fa6eabf12c788c6a4a98ded1eaff75e0a08a5d1cc6be5",
    fixtureIds: ["technical-baseline"],
    fixtureFiles: [
      {
        fixtureId: "technical-baseline",
        repositoryPath:
          "apps/site-renderer/fixtures/technical-baseline-spec.json",
        sha256:
          "e3831bd6bb2d673de4e88b1aafeb928d316249c4a42685df2c065f985d9d0aab",
      },
    ],
  },
  "m1-e-a-cta-banner-visual-regression": {
    artifactId: "m1-e-a-cta-banner-visual-regression",
    componentType: "CtaBanner",
    part: "visualRegression",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/CtaBanner/visual-regression.json",
    sha256: "f7528641d1f9b8b92d69d9c6501503c3a4e2d272a431cbe31024fb058b17d61f",
    breakpoints: [375, 768, 1440],
    outputs: [
      {
        breakpoint: 375,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/mobile-375/CtaBanner.png",
        sha256:
          "80fccdfe5c23b8bc120691fed069c2cd02bdf2690754fc5cb895b1cb2c535102",
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
    sha256: "f0e721a6600376e96821803015b92e66981c1e9e1887cd1c6294c8057c667e39",
    fixtureIds: ["technical-baseline"],
    fixtureFiles: [
      {
        fixtureId: "technical-baseline",
        repositoryPath:
          "apps/site-renderer/fixtures/technical-baseline-spec.json",
        sha256:
          "e3831bd6bb2d673de4e88b1aafeb928d316249c4a42685df2c065f985d9d0aab",
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
    sha256: "9f2e37ba2209681370f1fd822e08dae17a3f1010ff39e0d5f61a9b75ce44b014",
    fixtureIds: ["technical-baseline"],
    fixtureFiles: [
      {
        fixtureId: "technical-baseline",
        repositoryPath:
          "apps/site-renderer/fixtures/technical-baseline-spec.json",
        sha256:
          "e3831bd6bb2d673de4e88b1aafeb928d316249c4a42685df2c065f985d9d0aab",
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
    sha256: "1943b0c7aa93a3aa1861dfa760e1c59a44af17b679e8389d6800ebc70d155d31",
    fixtureIds: ["technical-baseline"],
    fixtureFiles: [
      {
        fixtureId: "technical-baseline",
        repositoryPath:
          "apps/site-renderer/fixtures/technical-baseline-spec.json",
        sha256:
          "e3831bd6bb2d673de4e88b1aafeb928d316249c4a42685df2c065f985d9d0aab",
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
    sha256: "a4ef2a5e20d219dee88c5d20cc75705b5a1a13cbde04343f34b82fc60b5e06fa",
    fixtureIds: ["technical-baseline"],
    fixtureFiles: [
      {
        fixtureId: "technical-baseline",
        repositoryPath:
          "apps/site-renderer/fixtures/technical-baseline-spec.json",
        sha256:
          "e3831bd6bb2d673de4e88b1aafeb928d316249c4a42685df2c065f985d9d0aab",
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
    sha256: "62a69bc03197d929855d1db9851e8fa11d96337ecc3a19cdfd81bf83f0ba8e3e",
    fixtureIds: ["technical-baseline"],
    fixtureFiles: [
      {
        fixtureId: "technical-baseline",
        repositoryPath:
          "apps/site-renderer/fixtures/technical-baseline-spec.json",
        sha256:
          "e3831bd6bb2d673de4e88b1aafeb928d316249c4a42685df2c065f985d9d0aab",
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
