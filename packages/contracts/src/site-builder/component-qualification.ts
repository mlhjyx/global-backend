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
    sha256: "ed65d90ff6629d7c66415b1e1fc0ccf310f54e4544625fc84b13251cecf680b8",
    fixtureIds: ["m1-e-a-cta-banner"],
    fixtureFiles: [
      {
        fixtureId: "m1-e-a-cta-banner",
        repositoryPath:
          "apps/site-renderer/fixtures/component-qualification/cta-banner-spec.json",
        sha256:
          "78c9fadfcf97efe15229beaeb45e0c6c00f25f3d40549b632f49edb8b336e0c4",
      },
    ],
  },
  "m1-e-a-cta-banner-visual-regression": {
    artifactId: "m1-e-a-cta-banner-visual-regression",
    componentType: "CtaBanner",
    part: "visualRegression",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/CtaBanner/visual-regression.json",
    sha256: "44eb39ca56643f8bd1c069e34b2d7976730a9a3257eacbab119e01700be18f36",
    breakpoints: [375, 768, 1440],
    outputs: [
      {
        breakpoint: 375,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/CtaBanner.png",
        sha256:
          "27eda4ee0449e93bd3da0c6bf2884125d789ca1d4d2e74bc2b3c82b28fd3fd7f",
      },
      {
        breakpoint: 768,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/CtaBanner.png",
        sha256:
          "98cc2e2d15d0bc54069a78d8c37c0aaf372802096bf44b338e9b5f22f055ca8f",
      },
      {
        breakpoint: 1440,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/CtaBanner.png",
        sha256:
          "a633ca169ceff22c9d2edcac170a046ad2ae848083c8dd127608fad36cb8a81a",
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
    sha256: "f51838d738de03a158c98b07746151879e9d6de6d2288de9555f3628ab745fc6",
    fixtureIds: ["m1-e-a-hero-banner"],
    fixtureFiles: [
      {
        fixtureId: "m1-e-a-hero-banner",
        repositoryPath:
          "apps/site-renderer/fixtures/component-qualification/hero-banner-spec.json",
        sha256:
          "5e2c912bfb236056b6b06e86f219c8a23946b8a67d56fbcd6f75d91bb04ed03e",
      },
    ],
  },
  "m1-e-a-hero-banner-visual-regression": {
    artifactId: "m1-e-a-hero-banner-visual-regression",
    componentType: "HeroBanner",
    part: "visualRegression",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/HeroBanner/visual-regression.json",
    sha256: "4c51bdf9c6c3c6de096d57ae41746e1ea64ad4aa2beb3f133445fe3d001ac874",
    breakpoints: [375, 768, 1440],
    outputs: [
      {
        breakpoint: 375,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/HeroBanner.png",
        sha256:
          "554410a10a6273fef44079624c4adf6662e1a041056ed1df019baf21fe812cb7",
      },
      {
        breakpoint: 768,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/HeroBanner.png",
        sha256:
          "cd25ca0a0dffb19d3e9be41d4b77275e6d1dccfbdfeb8968dbd17be735e97bf9",
      },
      {
        breakpoint: 1440,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/HeroBanner.png",
        sha256:
          "00873388b3679b449270c614ac7db1ac3d2d4770c98b2a99df56b720121a8aff",
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
    sha256: "ea716469eabb1602e56eb78e1679520d98d6bc0330ce68063e451679d9aa87c0",
    fixtureIds: ["m1-e-a-stats-band"],
    fixtureFiles: [
      {
        fixtureId: "m1-e-a-stats-band",
        repositoryPath:
          "apps/site-renderer/fixtures/component-qualification/stats-band-spec.json",
        sha256:
          "0385f26082bdf4c97df3a3fcd95a4f485a8127df5d2e7de60f675d36afadd295",
      },
    ],
  },
  "m1-e-a-stats-band-visual-regression": {
    artifactId: "m1-e-a-stats-band-visual-regression",
    componentType: "StatsBand",
    part: "visualRegression",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/StatsBand/visual-regression.json",
    sha256: "c5592ada910fb0bd9a99b4e5073abef368a1c0a1bd6f96f588be76845c1492c6",
    breakpoints: [375, 768, 1440],
    outputs: [
      {
        breakpoint: 375,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/StatsBand.png",
        sha256:
          "2614338b6f9c1d554f107efca66f4112e67f1d0f1740168fc54b5f287c4e0bf1",
      },
      {
        breakpoint: 768,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/StatsBand.png",
        sha256:
          "5085a4e59d0f55e724a43b2ada84657c169faaafa9ffb2ed47e9659a234a5be1",
      },
      {
        breakpoint: 1440,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/StatsBand.png",
        sha256:
          "349241213ded4923389a46c08caaf74f44a1bf28e76e63bbd373e614c1c5b061",
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
    sha256: "f22d325ea3dd976719d5fe836b75b971f7cd2a50ceef63fa4a428aa3741dfa99",
    fixtureIds: ["m1-e-a-product-grid"],
    fixtureFiles: [
      {
        fixtureId: "m1-e-a-product-grid",
        repositoryPath:
          "apps/site-renderer/fixtures/component-qualification/product-grid-spec.json",
        sha256:
          "27f14e26db403da4a077f568863b0b91ef7e7989b95387147a377fd8ed89686b",
      },
    ],
  },
  "m1-e-a-product-grid-visual-regression": {
    artifactId: "m1-e-a-product-grid-visual-regression",
    componentType: "ProductGrid",
    part: "visualRegression",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/ProductGrid/visual-regression.json",
    sha256: "f6cf37dd0599fbf279be090e1f916959ce4af118f0c3a84a51f3c48a0864908c",
    breakpoints: [375, 768, 1440],
    outputs: [
      {
        breakpoint: 375,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/ProductGrid.png",
        sha256:
          "bf20829740473f9c66b00c4c33915e73c19ac19b680f76913f193574a082cdd5",
      },
      {
        breakpoint: 768,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/ProductGrid.png",
        sha256:
          "bda5ae6d9c556434d9ea575ade292b469355b225e259a65f62a2e6c1ac4c5e52",
      },
      {
        breakpoint: 1440,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/ProductGrid.png",
        sha256:
          "5a9efdce16a5be8719de119eb63f823110084013aba12259748603eb07b46932",
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
    sha256: "d93b039873e62940a24710320924733c0d181dd37a996665fc1d55493cd9e12f",
    fixtureIds: ["m1-e-a-about-block"],
    fixtureFiles: [
      {
        fixtureId: "m1-e-a-about-block",
        repositoryPath:
          "apps/site-renderer/fixtures/component-qualification/about-block-spec.json",
        sha256:
          "fd5d2460ecf6e3382385430a1b9a1e698edc7f0f6fc40eafd826f19ed1625bcc",
      },
    ],
  },
  "m1-e-a-about-block-visual-regression": {
    artifactId: "m1-e-a-about-block-visual-regression",
    componentType: "AboutBlock",
    part: "visualRegression",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/AboutBlock/visual-regression.json",
    sha256: "64e1eb7418f8de415443659cdb1e5892bf62867013ae9f8b9b9c801bd17e315a",
    breakpoints: [375, 768, 1440],
    outputs: [
      {
        breakpoint: 375,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/AboutBlock.png",
        sha256:
          "9b4a0a510b9b06728bb6d499d8d78c947e9f416700cc4fdadcb1bdf76a7a8248",
      },
      {
        breakpoint: 768,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/AboutBlock.png",
        sha256:
          "111cd33901f2735bbf6a232d45e7dca99c3766e05b7a50db01bdd7ead757feac",
      },
      {
        breakpoint: 1440,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/AboutBlock.png",
        sha256:
          "f9d32d73602c1c3a80716a04615730befc1ccb695fa688033981b1ecc8d7ea8b",
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
    sha256: "4659678f0439d9a9222675345507c3e489b7845e41bf68f8204ae91128715417",
    fixtureIds: ["m1-e-a-inquiry-form"],
    fixtureFiles: [
      {
        fixtureId: "m1-e-a-inquiry-form",
        repositoryPath:
          "apps/site-renderer/fixtures/component-qualification/inquiry-form-spec.json",
        sha256:
          "4b07a8e02732d237ee78ed942daff8dc2c88091752d0221cfeb5d5a1044a398f",
      },
    ],
  },
  "m1-e-a-inquiry-form-visual-regression": {
    artifactId: "m1-e-a-inquiry-form-visual-regression",
    componentType: "InquiryForm",
    part: "visualRegression",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/InquiryForm/visual-regression.json",
    sha256: "51ac4cc8504fc8f9e3e0fc035eea0e675c5768795db37b8fff31e68c08a474ee",
    breakpoints: [375, 768, 1440],
    outputs: [
      {
        breakpoint: 375,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/InquiryForm.png",
        sha256:
          "8eed61ea8d4697c0a4d647fa48b7aadbaee2419a3bf6407c851b2d604810dd63",
      },
      {
        breakpoint: 768,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/InquiryForm.png",
        sha256:
          "c8630d1a9efab27e23291166baa6bd7704bd18aa47c17ba9a37e2dd4bc9bc822",
      },
      {
        breakpoint: 1440,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/InquiryForm.png",
        sha256:
          "1f6f2a09f3037495cb9585b5040a24471392c0f949733839540a222e3d1b402e",
      },
    ],
  },
  "m1-e-a-cert-wall-schema": { artifactId: "m1-e-a-cert-wall-schema", componentType: "CertWall", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/CertWall/schema.json", sha256: "2d222ece313dd34170691738009801de3534003b76b64d6be3bba95723e52a4e" },
  "m1-e-a-cert-wall-variants": { artifactId: "m1-e-a-cert-wall-variants", componentType: "CertWall", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/CertWall/variants.json", sha256: "74ee31c22a399bd37e04160976abdcc494c60e9bb40368768db22cb1a1b78883", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-cert-wall-content-budget": { artifactId: "m1-e-a-cert-wall-content-budget", componentType: "CertWall", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/CertWall/content-budget.json", sha256: "14deaed85ff805fa479e600435e8f979300e0c29279f6aec5ce5617de001fad0" },
  "m1-e-a-cert-wall-accessibility": { artifactId: "m1-e-a-cert-wall-accessibility", componentType: "CertWall", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/CertWall/accessibility.json", sha256: "0924c8433483d6b7bb16d0f8750e12d58447f973e55fd3f558e2f78f0071845a" },
  "m1-e-a-cert-wall-reduced-motion": { artifactId: "m1-e-a-cert-wall-reduced-motion", componentType: "CertWall", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/CertWall/reduced-motion.json", sha256: "c774550b663c7424e49210caee6987c4ee714127f71164eea847f031fc1eb5a7" },
  "m1-e-a-cert-wall-fixtures": { artifactId: "m1-e-a-cert-wall-fixtures", componentType: "CertWall", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/CertWall/fixtures.json", sha256: "fab1bdcc2f1510b7d23ee941eb38f9418bc2d36ba0f7a0b08cb2dcdb852de019", fixtureIds: ["m1-e-a-cert-wall"], fixtureFiles: [{ fixtureId: "m1-e-a-cert-wall", repositoryPath: "apps/site-renderer/fixtures/component-qualification/cert-wall-spec.json", sha256: "c15d7f6caff45a6f13bff2fdf6af073456163ad952046ba94c4bd60e4ae22d10" }] },
  "m1-e-a-cert-wall-visual-regression": { artifactId: "m1-e-a-cert-wall-visual-regression", componentType: "CertWall", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/CertWall/visual-regression.json", sha256: "8c02d27554e0cd45b61d1bd211e45555ae6b97abd5db22b797d1e248cdcbbdec", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/CertWall.png", sha256: "27b07542f37296c89761a5745043cf9572045db5c4c3d17266b3777638d9ca4e" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/CertWall.png", sha256: "086e8fc7deaab2f9313b2fc4e95100d3e986332670d2749938f9f62c71dd0e8f" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/CertWall.png", sha256: "5d95704d52e4c139fb172c041f934cf73cbffc63286d8ef7745bd34c42c69ee1" }] },
  "m1-e-a-process-timeline-schema": { artifactId: "m1-e-a-process-timeline-schema", componentType: "ProcessTimeline", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessTimeline/schema.json", sha256: "9e4ac3e3cccd56e7667108dfd45b338a7e62cbd7f6ffc51ecedd88e169420bf4" },
  "m1-e-a-process-timeline-variants": { artifactId: "m1-e-a-process-timeline-variants", componentType: "ProcessTimeline", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessTimeline/variants.json", sha256: "d31f04ac02ca9e012a0ad116126e92cb8fb7252b137d5f4b4f4b9a2ae1beda61", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-process-timeline-content-budget": { artifactId: "m1-e-a-process-timeline-content-budget", componentType: "ProcessTimeline", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessTimeline/content-budget.json", sha256: "c0f2df8fc46de0c690729dd947fa1e03849e95d111ee60320f215230c75d2e11" },
  "m1-e-a-process-timeline-accessibility": { artifactId: "m1-e-a-process-timeline-accessibility", componentType: "ProcessTimeline", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessTimeline/accessibility.json", sha256: "d41dc582b5910b2e062d908587a392b9a4ee20dc692c91858b5c259b3975e1ae" },
  "m1-e-a-process-timeline-reduced-motion": { artifactId: "m1-e-a-process-timeline-reduced-motion", componentType: "ProcessTimeline", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessTimeline/reduced-motion.json", sha256: "c7e20675b75fe371021a27d7da670ddca7d037c7c94f064b3a79f12a0d099c80" },
  "m1-e-a-process-timeline-fixtures": { artifactId: "m1-e-a-process-timeline-fixtures", componentType: "ProcessTimeline", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessTimeline/fixtures.json", sha256: "606cbda89b9a85c439994f7a3d6bd6abfdab21e8f1483b0352fc9c0d8d581b8e", fixtureIds: ["m1-e-a-process-timeline"], fixtureFiles: [{ fixtureId: "m1-e-a-process-timeline", repositoryPath: "apps/site-renderer/fixtures/component-qualification/process-timeline-spec.json", sha256: "cdb8b14f17c4d302317123c681e76ef9556ba7880b329b1286132ddffd3ddd83" }] },
  "m1-e-a-process-timeline-visual-regression": { artifactId: "m1-e-a-process-timeline-visual-regression", componentType: "ProcessTimeline", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/ProcessTimeline/visual-regression.json", sha256: "2137c7272bb2a5f7038085c204cb88a2f00bd464cd4f7d132c2e70cad9eb4917", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/ProcessTimeline.png", sha256: "8cbff12eb5bfedc635919dc09b0530aa156309b2ddfdc72e8cfd87422d755781" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/ProcessTimeline.png", sha256: "0a32a36a0581378d6316e54138b4dca3e35f25588ff051ab5de694381e1ed90d" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/ProcessTimeline.png", sha256: "aaddb34e6335f6c31ba51254fc017a9c530988c9849e481fd63fdbd9f0e8a1e5" }] },
  "m1-e-a-faq-accordion-schema": { artifactId: "m1-e-a-faq-accordion-schema", componentType: "FaqAccordion", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqAccordion/schema.json", sha256: "700f4f0f6859d8a61470a780114500fc1a4ee2a0e4cf05472922b326836b2d65" },
  "m1-e-a-faq-accordion-variants": { artifactId: "m1-e-a-faq-accordion-variants", componentType: "FaqAccordion", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqAccordion/variants.json", sha256: "8768f280f66e86564aab4976d1073120601873c2ede924123a75f95b66e4caeb", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-faq-accordion-content-budget": { artifactId: "m1-e-a-faq-accordion-content-budget", componentType: "FaqAccordion", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqAccordion/content-budget.json", sha256: "69b568f65c01388cff491949c3b5be24a7350018ff834b32f993d0dd5cb1e50e" },
  "m1-e-a-faq-accordion-accessibility": { artifactId: "m1-e-a-faq-accordion-accessibility", componentType: "FaqAccordion", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqAccordion/accessibility.json", sha256: "e26ef6bc3495320ea979e99120cbb2c67a193801a76b8fc6f6b6ce8a52464999" },
  "m1-e-a-faq-accordion-reduced-motion": { artifactId: "m1-e-a-faq-accordion-reduced-motion", componentType: "FaqAccordion", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqAccordion/reduced-motion.json", sha256: "3c03341f4530613e41ad224cdfa1cda9e8cfed9a2dff8e3647d7368ce59472f1" },
  "m1-e-a-faq-accordion-fixtures": { artifactId: "m1-e-a-faq-accordion-fixtures", componentType: "FaqAccordion", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqAccordion/fixtures.json", sha256: "7419a92419f6b98ebdad6a636d905c935d3c6244ab94ae1b5150b650ffaa44a4", fixtureIds: ["m1-e-a-faq-accordion"], fixtureFiles: [{ fixtureId: "m1-e-a-faq-accordion", repositoryPath: "apps/site-renderer/fixtures/component-qualification/faq-accordion-spec.json", sha256: "e2e11d8577738f8aa75f3e817cfbf735c9b56419dd3d25b9529468d5bfe37779" }] },
  "m1-e-a-faq-accordion-visual-regression": { artifactId: "m1-e-a-faq-accordion-visual-regression", componentType: "FaqAccordion", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/FaqAccordion/visual-regression.json", sha256: "93fcb96d9381e303920b6371ce0debe064863a1f9bc65763f5710d375a1702f5", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/FaqAccordion.png", sha256: "2254256a914947d8787ec1dfa73642a7ca422044aca99bfe4c4251af0588f6b7" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/FaqAccordion.png", sha256: "eabc7414ca42a5cf8e0fb6429fa66dd24c8c1204d60b9221c5b634544ba1aafd" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/FaqAccordion.png", sha256: "680f29ed89603809f4d2d2502b63dd1dccab42bec7057e701d3e5bc2f97f8fd5" }] },
  "m1-e-a-logo-marquee-schema": { artifactId: "m1-e-a-logo-marquee-schema", componentType: "LogoMarquee", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/LogoMarquee/schema.json", sha256: "906ff3fd388d7f2292da0cef131ed3f911d748f4038378dcec15dd0e66f4ea16" },
  "m1-e-a-logo-marquee-variants": { artifactId: "m1-e-a-logo-marquee-variants", componentType: "LogoMarquee", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/LogoMarquee/variants.json", sha256: "8ae2e75241a58d8085123313d7269a0d987c62eb02af99b6aef2e97098a10b1e", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-logo-marquee-content-budget": { artifactId: "m1-e-a-logo-marquee-content-budget", componentType: "LogoMarquee", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/LogoMarquee/content-budget.json", sha256: "9f1c474cff58d06b0f31982a8caec3f2dc521d11a227415d95cd7032a04c8cc2" },
  "m1-e-a-logo-marquee-accessibility": { artifactId: "m1-e-a-logo-marquee-accessibility", componentType: "LogoMarquee", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/LogoMarquee/accessibility.json", sha256: "169f999f722905f34a421f1d6aa47a17cd7bd9c00ac15e2574348667e9c6b160" },
  "m1-e-a-logo-marquee-reduced-motion": { artifactId: "m1-e-a-logo-marquee-reduced-motion", componentType: "LogoMarquee", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/LogoMarquee/reduced-motion.json", sha256: "75349066e00ebba8778e66171d3fb8eaf427d9bd71a519637fddb719f3f54f58" },
  "m1-e-a-logo-marquee-fixtures": { artifactId: "m1-e-a-logo-marquee-fixtures", componentType: "LogoMarquee", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/LogoMarquee/fixtures.json", sha256: "ed111c4e755f663772d4906729a70051e28921add469c5e34917bac5547b420f", fixtureIds: ["m1-e-a-logo-marquee"], fixtureFiles: [{ fixtureId: "m1-e-a-logo-marquee", repositoryPath: "apps/site-renderer/fixtures/component-qualification/logo-marquee-spec.json", sha256: "4f71a52397917533f325e217fc18c8228fd9bf7c260f7b5ec0dcabb6d5d7235f" }] },
  "m1-e-a-logo-marquee-visual-regression": { artifactId: "m1-e-a-logo-marquee-visual-regression", componentType: "LogoMarquee", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/LogoMarquee/visual-regression.json", sha256: "17458fe89e3ab5c8f6d651019b93e980a2d4dae74e780597b0f15353388f02b3", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/LogoMarquee.png", sha256: "3751d4dc86edfbe9ccd61c793cabdf918d627ab6d34af1c5b5d5215e5d2654ff" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/LogoMarquee.png", sha256: "7d95fde1b6aaedef05a5af34dfcaa7ca7872f3006a4e5adb3e87bc8b23ce1ddd" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/LogoMarquee.png", sha256: "efd0a37ab6d6473fd9e3b9f757c3d16c16a1ba4ba892a33137fd451094eb6cce" }] },
  "m1-e-a-testimonials-schema": { artifactId: "m1-e-a-testimonials-schema", componentType: "Testimonials", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/Testimonials/schema.json", sha256: "7c5965dca5b1ef6c046cd738beef747f7ed2779e078dfadf159476195bfabc7a" },
  "m1-e-a-testimonials-variants": { artifactId: "m1-e-a-testimonials-variants", componentType: "Testimonials", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/Testimonials/variants.json", sha256: "efe38e12d363723a3768bedc26fcf836460ca83f51995a65f9138de24ec02334", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-testimonials-content-budget": { artifactId: "m1-e-a-testimonials-content-budget", componentType: "Testimonials", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/Testimonials/content-budget.json", sha256: "fa958f190444c05d7f0419f838f07f929a0132ba7dbe1af370bca30da8122946" },
  "m1-e-a-testimonials-accessibility": { artifactId: "m1-e-a-testimonials-accessibility", componentType: "Testimonials", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/Testimonials/accessibility.json", sha256: "88269869af60e7c4e20cba9ff14f299a47b273ebbcee4e1f1b2e06e3866805e7" },
  "m1-e-a-testimonials-reduced-motion": { artifactId: "m1-e-a-testimonials-reduced-motion", componentType: "Testimonials", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/Testimonials/reduced-motion.json", sha256: "86655c0e5e6f1f4ec856af87f758a34ff668674d71614f2da641ad5af49a72ba" },
  "m1-e-a-testimonials-fixtures": { artifactId: "m1-e-a-testimonials-fixtures", componentType: "Testimonials", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/Testimonials/fixtures.json", sha256: "09892b3759987a733e0c2776cb298394ce0aa948c62c24a59b5daff2e7a52110", fixtureIds: ["m1-e-a-testimonials"], fixtureFiles: [{ fixtureId: "m1-e-a-testimonials", repositoryPath: "apps/site-renderer/fixtures/component-qualification/testimonials-spec.json", sha256: "7d14e2556beee78f1fddb823c67ebdc85cfa2de890066458a1052503755321a7" }] },
  "m1-e-a-testimonials-visual-regression": { artifactId: "m1-e-a-testimonials-visual-regression", componentType: "Testimonials", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/Testimonials/visual-regression.json", sha256: "10450f0faa1a91d34349991d02dd7b641a2b85e2b3865694d75787eee5205700", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/Testimonials.png", sha256: "81d10333c3872ddb0e03a0aa26a882efa85c0684ff7470936ae6eb7b9fe01880" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/Testimonials.png", sha256: "6c3ff2ac5c5b8abc93564e03b64efa6f93fafb1135975891e5435f2cd84e72a7" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/Testimonials.png", sha256: "37903f0e14acf6736785bd76df869bbeee358ae7d2babcd31effe21a6e3d1480" }] },
  "m1-e-a-feature-cards-schema": { artifactId: "m1-e-a-feature-cards-schema", componentType: "FeatureCards", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/FeatureCards/schema.json", sha256: "f0005c0b9534e223428ee9e15206e0df84bb257fa70679b4f826a71c98b7212d" },
  "m1-e-a-feature-cards-variants": { artifactId: "m1-e-a-feature-cards-variants", componentType: "FeatureCards", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/FeatureCards/variants.json", sha256: "70356b849b81169e0a7233472631c8436e66730138e823a27175658858071970", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-feature-cards-content-budget": { artifactId: "m1-e-a-feature-cards-content-budget", componentType: "FeatureCards", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/FeatureCards/content-budget.json", sha256: "c0f6ddc81f4564c449b8606baf8b048a659ee5b78f882b909736b8366226c0bb" },
  "m1-e-a-feature-cards-accessibility": { artifactId: "m1-e-a-feature-cards-accessibility", componentType: "FeatureCards", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/FeatureCards/accessibility.json", sha256: "7e7ee6a5b0adb87e2a42b99a9d09858000349c55ee38a530a8b97cc24666fca3" },
  "m1-e-a-feature-cards-reduced-motion": { artifactId: "m1-e-a-feature-cards-reduced-motion", componentType: "FeatureCards", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/FeatureCards/reduced-motion.json", sha256: "b81560a4e5e7d54f09aa74c849af6e3a450fbc5dec7840d2a801e48646e19d8b" },
  "m1-e-a-feature-cards-fixtures": { artifactId: "m1-e-a-feature-cards-fixtures", componentType: "FeatureCards", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/FeatureCards/fixtures.json", sha256: "477ca661f7b02f5fa215e5dd0053637102e3682417aeb5986ca6cc75389fef17", fixtureIds: ["m1-e-a-feature-cards"], fixtureFiles: [{ fixtureId: "m1-e-a-feature-cards", repositoryPath: "apps/site-renderer/fixtures/component-qualification/feature-cards-spec.json", sha256: "0b9616347ab440b2d1a2f00139984851a4c68927c08a953d3c5edec89c62b453" }] },
  "m1-e-a-feature-cards-visual-regression": { artifactId: "m1-e-a-feature-cards-visual-regression", componentType: "FeatureCards", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/FeatureCards/visual-regression.json", sha256: "0d7e0e9cef36a63042195f6510d231045e0c4026bee7d13557f106a6948b92b1", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/FeatureCards.png", sha256: "3eecce7e91494c3345ae79f470308e9aa60d9e47721fdf0e1107cb66e6e96615" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/FeatureCards.png", sha256: "9d4f8d1fcce0d18bc32f28e829217db2d075fdf9d10578594491df6b800fe757" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/FeatureCards.png", sha256: "bb5ae079944ab9ac3013e5d9a9dc077e1a45d1ca9753922b7cc7e751636a904d" }] },
  "m1-e-a-tech-systems-schema": { artifactId: "m1-e-a-tech-systems-schema", componentType: "TechSystems", part: "schema", repositoryPath: "docs/evidence/site-builder/component-qualification/TechSystems/schema.json", sha256: "af56e3720c232311573403243ee26a56702d060f9e19b4a609084f177e2f6a95" },
  "m1-e-a-tech-systems-variants": { artifactId: "m1-e-a-tech-systems-variants", componentType: "TechSystems", part: "variants", repositoryPath: "docs/evidence/site-builder/component-qualification/TechSystems/variants.json", sha256: "05cbacec98163757ce85ae3ed0bae13d14d6342a044ad079fa6f2a54cbffbc55", variantValues: ["technical-grid", "quiet"] },
  "m1-e-a-tech-systems-content-budget": { artifactId: "m1-e-a-tech-systems-content-budget", componentType: "TechSystems", part: "contentBudget", repositoryPath: "docs/evidence/site-builder/component-qualification/TechSystems/content-budget.json", sha256: "a2b35abb090df3442e447101cd6f09b9483a1d4561ffe250e5ade4c00e8baa0e" },
  "m1-e-a-tech-systems-accessibility": { artifactId: "m1-e-a-tech-systems-accessibility", componentType: "TechSystems", part: "accessibility", repositoryPath: "docs/evidence/site-builder/component-qualification/TechSystems/accessibility.json", sha256: "9e3ec6dbbd8413841045682976334dad1236e1f7185aabb109d80ca82e5373ee" },
  "m1-e-a-tech-systems-reduced-motion": { artifactId: "m1-e-a-tech-systems-reduced-motion", componentType: "TechSystems", part: "reducedMotion", repositoryPath: "docs/evidence/site-builder/component-qualification/TechSystems/reduced-motion.json", sha256: "a98e84fca450c50ddc8bb486705818473032ee62b4ac6a081fecb76b514a3ad3" },
  "m1-e-a-tech-systems-fixtures": { artifactId: "m1-e-a-tech-systems-fixtures", componentType: "TechSystems", part: "fixtures", repositoryPath: "docs/evidence/site-builder/component-qualification/TechSystems/fixtures.json", sha256: "80e66638911300b71f06723cb9dc5e5388ac04da5b3d06c06b6d26a3ed133051", fixtureIds: ["m1-e-a-tech-systems"], fixtureFiles: [{ fixtureId: "m1-e-a-tech-systems", repositoryPath: "apps/site-renderer/fixtures/component-qualification/tech-systems-spec.json", sha256: "807b3ab10ca3b263ff0b4385845c31180512b60c7ec96d857f7151ef4900565b" }] },
  "m1-e-a-tech-systems-visual-regression": { artifactId: "m1-e-a-tech-systems-visual-regression", componentType: "TechSystems", part: "visualRegression", repositoryPath: "docs/evidence/site-builder/component-qualification/TechSystems/visual-regression.json", sha256: "c350799b3fd0243cb6f12c6063f59c417329c797321c301cd959caa34b83b76d", breakpoints: [375, 768, 1440], outputs: [{ breakpoint: 375, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/mobile-375/TechSystems.png", sha256: "e2b90b1289d4f94da8e5bc6936c32339fcc92dd0d1ddc714acba9c6b08de154a" }, { breakpoint: 768, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/tablet-768/TechSystems.png", sha256: "ed7897684d13e88ad20f59e07df27ec4e27f29e59f3a21f3efec356099b5d4ef" }, { breakpoint: 1440, repositoryPath: "apps/site-renderer/visual-tests/__screenshots__/qualification/desktop-1440/TechSystems.png", sha256: "a3a2437bc667469dd5f6d0bcc3cc83d4085e8d4d28957652c016f40e8c58b0c7" }] },
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
          "apps/site-renderer/visual-tests/__screenshots__/qualification/" +
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
