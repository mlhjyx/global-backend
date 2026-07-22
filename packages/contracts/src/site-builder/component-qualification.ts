import { z } from "zod";
import {
  SITE_SPEC_COMPONENT_TYPES,
  SITE_SPEC_RELEASE_COMPONENT_TYPES,
  type SiteSpecComponentType,
} from "./site-spec";

const evidenceRefSchema = z
  .object({ evidenceId: z.string().trim().min(1).max(256) })
  .strict();

const componentQualificationSchema = z
  .object({
    schema: evidenceRefSchema,
    variants: evidenceRefSchema.extend({
      values: z.array(z.string().trim().min(1).max(64)).min(1),
    }),
    contentBudget: evidenceRefSchema,
    accessibility: evidenceRefSchema,
    reducedMotion: evidenceRefSchema,
    fixtures: evidenceRefSchema.extend({
      fixtureIds: z.array(z.string().trim().min(1).max(128)).min(1),
    }),
    visualRegression: evidenceRefSchema.extend({
      breakpoints: z.tuple([z.literal(375), z.literal(768), z.literal(1440)]),
    }),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.variants.values).size !== value.variants.values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["variants", "values"],
        message: "variant values must be unique",
      });
    }
    if (new Set(value.fixtures.fixtureIds).size !== value.fixtures.fixtureIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fixtures", "fixtureIds"],
        message: "fixture ids must be unique",
      });
    }
  });

export type ComponentQualificationEvidence = z.infer<
  typeof componentQualificationSchema
>;

/**
 * The ten R1 components predate the M1-e-A seven-part contract. They remain
 * release-eligible for backward compatibility, but must never be mistaken for
 * M1-e-A-qualified components. This list is intentionally independent from the
 * mutable release registry so adding a new release type cannot inherit the
 * transitional exception.
 */
export const SITE_SPEC_TRANSITIONAL_RELEASE_COMPONENT_TYPES = [
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
] as const satisfies readonly SiteSpecComponentType[];

/**
 * Only components with real evidence for all seven M1-e-A parts belong here.
 * The registry starts empty: gallery extraction and legacy release eligibility
 * are not qualification evidence.
 */
export const M1_E_A_COMPONENT_QUALIFICATIONS = Object.freeze(
  {},
) as Readonly<
  Partial<Record<SiteSpecComponentType, ComponentQualificationEvidence>>
>;

export interface ReleaseQualificationRegistryInput {
  releaseTypes: readonly string[];
  transitionalTypes: readonly string[];
  qualifications: Readonly<
    Partial<Record<SiteSpecComponentType, ComponentQualificationEvidence>>
  >;
}

export type ComponentReleaseReadiness =
  | { status: "gallery_only" }
  | { status: "transitional_release" }
  | {
      status: "m1_e_a_qualified";
      evidence: ComponentQualificationEvidence;
    };

export function validateComponentQualification(
  type: SiteSpecComponentType,
  evidence: ComponentQualificationEvidence,
): ComponentQualificationEvidence {
  const parsed = componentQualificationSchema.safeParse(evidence);
  if (!parsed.success) {
    throw new Error(
      `COMPONENT_QUALIFICATION_INVALID: ${type} -- ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

export function assertReleaseQualificationRegistryIntegrity(
  input: ReleaseQualificationRegistryInput = {
    releaseTypes: SITE_SPEC_RELEASE_COMPONENT_TYPES,
    transitionalTypes: SITE_SPEC_TRANSITIONAL_RELEASE_COMPONENT_TYPES,
    qualifications: M1_E_A_COMPONENT_QUALIFICATIONS,
  },
): void {
  const componentTypes = new Set<string>(SITE_SPEC_COMPONENT_TYPES);
  const releaseTypes = new Set(input.releaseTypes);
  const transitionalTypes = new Set(input.transitionalTypes);

  for (const type of input.transitionalTypes) {
    if (!componentTypes.has(type) || !releaseTypes.has(type)) {
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
    validateComponentQualification(type as SiteSpecComponentType, evidence);
  }

  for (const [type, evidence] of Object.entries(input.qualifications)) {
    if (!componentTypes.has(type) || !releaseTypes.has(type) || !evidence) {
      throw new Error(`COMPONENT_RELEASE_REGISTRY_INVALID: ${type}`);
    }
    validateComponentQualification(
      type as SiteSpecComponentType,
      evidence as ComponentQualificationEvidence,
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
      evidence: validateComponentQualification(type, evidence),
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

export function assertReleaseComponentEligible(type: SiteSpecComponentType): void {
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
