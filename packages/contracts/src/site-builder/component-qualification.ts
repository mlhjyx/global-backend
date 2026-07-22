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
    sha256: "7c7e5a23f555feeeba369fbb34b5afb8f61816dcfc4b08c6ccc9153f9158b826",
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
    sha256: "58077784a67b9ad289a77fe854a0d671a7491a710ee53c5bcf0a2219e2160f7a",
    fixtureIds: ["technical-baseline"],
    fixtureFiles: [
      {
        fixtureId: "technical-baseline",
        repositoryPath:
          "apps/site-renderer/fixtures/technical-baseline-spec.json",
        sha256:
          "1ee61f548eda921e02b1c89e9caf593729efbda84232bc3797bcf5e2c21fbb93",
      },
    ],
  },
  "m1-e-a-cta-banner-visual-regression": {
    artifactId: "m1-e-a-cta-banner-visual-regression",
    componentType: "CtaBanner",
    part: "visualRegression",
    repositoryPath:
      "docs/evidence/site-builder/component-qualification/CtaBanner/visual-regression.json",
    sha256: "7bb7f3b6ad99418cfa568d49847172df6206d47a78fc2807039e2f68400dc151",
    breakpoints: [375, 768, 1440],
    outputs: [
      {
        breakpoint: 375,
        repositoryPath:
          "apps/site-renderer/visual-tests/__screenshots__/mobile-375/CtaBanner.png",
        sha256:
          "1ca9336e59ef34480f4a4e4fd86f1760e3b8f29959f4ef826e0666e2954e56c4",
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
          "3a8d87b310d13ecc1d5df654b276d9e1f29f99c418488f0d8be57c627a2edd7c",
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
    sha256: "5cbfcfcd450ad47ed86569b16f62142c239657f259baa712fcc76619b60f7dd8",
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
    sha256: "e90940577d8a6ca967c838fd7b008fcf8b78daebbc32d2a29480a918d6ea6ac9",
    fixtureIds: ["technical-baseline"],
    fixtureFiles: [
      {
        fixtureId: "technical-baseline",
        repositoryPath:
          "apps/site-renderer/fixtures/technical-baseline-spec.json",
        sha256:
          "1ee61f548eda921e02b1c89e9caf593729efbda84232bc3797bcf5e2c21fbb93",
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
    sha256: "48291c7911dee085ac43e7e91def7808c65171caff1840bc0ceb79e9c89593b4",
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
    sha256: "24576a3512e5fc19cbcedb5bf0e9ec5a7eacece4ce2ff41e39b3bba0dbce10b0",
    fixtureIds: ["technical-baseline"],
    fixtureFiles: [
      {
        fixtureId: "technical-baseline",
        repositoryPath:
          "apps/site-renderer/fixtures/technical-baseline-spec.json",
        sha256:
          "1ee61f548eda921e02b1c89e9caf593729efbda84232bc3797bcf5e2c21fbb93",
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
