import {
  hasOnlyKeys,
  isFiniteNumber,
  isNonBlankString,
  isRecord,
  isStringArray,
  isValidTimestamp,
} from "./design-integrity";
import {
  validateDesignSourceManifest,
  type DesignSourceManifest,
} from "./design-source";

export const DESIGN_OBSERVATION_SCHEMA_VERSION =
  "site-builder-design-observation/v1" as const;
export const DESIGN_RULE_SCHEMA_VERSION =
  "site-builder-design-rule/v1" as const;

export type DesignHeroComposition =
  "centered" | "split" | "editorial" | "product_stage" | "cinematic";
export type DesignSectionRhythm =
  "dense" | "airy" | "proof" | "product" | "narrative" | "cta";

export interface DesignObservation {
  schemaVersion: typeof DESIGN_OBSERVATION_SCHEMA_VERSION;
  sourceManifestId: string;
  observedAt: string;
  heroComposition: DesignHeroComposition;
  hierarchyScale: { headlineBand: string; bodyMeasureBand: string };
  sectionRhythm: DesignSectionRhythm[];
  imageStrategy: {
    ratioBands: string[];
    focalPattern: string;
    treatment: string;
  };
  ctaStrategy: { primaryCount: number; placementPattern: string };
  motionIntensity: "none" | "subtle" | "normal";
  mobileReflow: string[];
  reusablePrinciples: string[];
  prohibitedSourceSpecificTraits: string[];
}

export interface DesignRule {
  schemaVersion: typeof DESIGN_RULE_SCHEMA_VERSION;
  id: string;
  summary: string;
  sourceContributionGroups: string[];
  evidence: {
    independentSourceCount: number;
    generalized: boolean;
    selfReimplementable: boolean;
    nonNeighboring: boolean;
  };
}

/**
 * Publication-time evidence that binds rule contribution groups to validated
 * source manifests. Runtime catalog resolution only consumes already-frozen
 * catalogs, so it does not need to carry source manifests again.
 */
export interface DesignRuleValidationContext {
  sourceManifests: readonly unknown[];
}

export type DesignObservationContractErrorCode =
  | "DESIGN_OBSERVATION_INVALID"
  | "DESIGN_OBSERVATION_FORBIDDEN_CONTENT"
  | "DESIGN_RULE_INVALID"
  | "DESIGN_RULE_INSUFFICIENT_EVIDENCE"
  | "DESIGN_RULE_FORBIDDEN_CONTENT"
  | "DESIGN_RULE_PROVENANCE_UNVERIFIED"
  | "DESIGN_RULE_UNSAFE";

export class DesignObservationContractError extends Error {
  constructor(
    readonly code: DesignObservationContractErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "DesignObservationContractError";
  }
}

function fail(
  code: DesignObservationContractErrorCode,
  message: string,
): never {
  throw new DesignObservationContractError(code, message);
}

const FORBIDDEN_SOURCE_FIELDS = new Set([
  "rawtext",
  "rawcopy",
  "rawhtml",
  "rawdom",
  "sourcecode",
  "screenshot",
  "imagedata",
  "icondata",
  "exactcoordinates",
  "coordinates",
  "html",
  "dom",
  "css",
]);

function containsForbiddenSourceField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenSourceField);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, item]) =>
      FORBIDDEN_SOURCE_FIELDS.has(key.toLowerCase()) ||
      containsForbiddenSourceField(item),
  );
}

function abstractText(value: unknown): value is string {
  return (
    isNonBlankString(value) &&
    value.length <= 280 &&
    !/[<>]/.test(value) &&
    !/https?:\/\//i.test(value)
  );
}

function abstractTextArray(value: unknown): value is string[] {
  return isStringArray(value) && value.every(abstractText);
}

/** Rejects raw source material before it can enter a reusable design corpus. */
export function validateDesignObservation(value: unknown): DesignObservation {
  if (containsForbiddenSourceField(value)) {
    fail(
      "DESIGN_OBSERVATION_FORBIDDEN_CONTENT",
      "raw source material and reconstructable coordinates are forbidden",
    );
  }
  const observation = isRecord(value) ? value : null;
  if (
    !observation ||
    !hasOnlyKeys(observation, [
      "schemaVersion",
      "sourceManifestId",
      "observedAt",
      "heroComposition",
      "hierarchyScale",
      "sectionRhythm",
      "imageStrategy",
      "ctaStrategy",
      "motionIntensity",
      "mobileReflow",
      "reusablePrinciples",
      "prohibitedSourceSpecificTraits",
    ]) ||
    observation.schemaVersion !== DESIGN_OBSERVATION_SCHEMA_VERSION ||
    !isNonBlankString(observation.sourceManifestId) ||
    !isValidTimestamp(observation.observedAt) ||
    !["centered", "split", "editorial", "product_stage", "cinematic"].includes(
      String(observation.heroComposition),
    ) ||
    !["none", "subtle", "normal"].includes(
      String(observation.motionIntensity),
    ) ||
    !abstractTextArray(observation.mobileReflow) ||
    !abstractTextArray(observation.reusablePrinciples) ||
    !abstractTextArray(observation.prohibitedSourceSpecificTraits)
  ) {
    fail("DESIGN_OBSERVATION_INVALID", "observation metadata is invalid");
  }
  const hierarchy = isRecord(observation.hierarchyScale)
    ? observation.hierarchyScale
    : null;
  const image = isRecord(observation.imageStrategy)
    ? observation.imageStrategy
    : null;
  const cta = isRecord(observation.ctaStrategy)
    ? observation.ctaStrategy
    : null;
  if (
    !hierarchy ||
    !hasOnlyKeys(hierarchy, ["headlineBand", "bodyMeasureBand"]) ||
    !isNonBlankString(hierarchy.headlineBand) ||
    !isNonBlankString(hierarchy.bodyMeasureBand) ||
    !image ||
    !hasOnlyKeys(image, ["ratioBands", "focalPattern", "treatment"]) ||
    !abstractTextArray(image.ratioBands) ||
    !isNonBlankString(image.focalPattern) ||
    !isNonBlankString(image.treatment) ||
    !cta ||
    !hasOnlyKeys(cta, ["primaryCount", "placementPattern"]) ||
    !isFiniteNumber(cta.primaryCount) ||
    !Number.isInteger(cta.primaryCount) ||
    cta.primaryCount < 0 ||
    cta.primaryCount > 4 ||
    !isNonBlankString(cta.placementPattern) ||
    !Array.isArray(observation.sectionRhythm) ||
    observation.sectionRhythm.length === 0 ||
    observation.sectionRhythm.some(
      (item) =>
        !["dense", "airy", "proof", "product", "narrative", "cta"].includes(
          String(item),
        ),
    )
  ) {
    fail("DESIGN_OBSERVATION_INVALID", "observation structure is invalid");
  }
  if (
    !abstractText(hierarchy.headlineBand) ||
    !abstractText(hierarchy.bodyMeasureBand) ||
    !abstractText(image.focalPattern) ||
    !abstractText(image.treatment) ||
    !abstractText(cta.placementPattern)
  ) {
    fail(
      "DESIGN_OBSERVATION_FORBIDDEN_CONTENT",
      "observation text must be abstract rather than source-derived content",
    );
  }
  return observation as unknown as DesignObservation;
}

/** A rule is reusable only when independent sources and clean-room checks agree. */
export function validateDesignRule(
  value: unknown,
  context?: DesignRuleValidationContext,
): DesignRule {
  const rule = isRecord(value) ? value : null;
  if (
    !rule ||
    !hasOnlyKeys(rule, [
      "schemaVersion",
      "id",
      "summary",
      "sourceContributionGroups",
      "evidence",
    ]) ||
    rule.schemaVersion !== DESIGN_RULE_SCHEMA_VERSION ||
    !isNonBlankString(rule.id) ||
    !isNonBlankString(rule.summary) ||
    !isStringArray(rule.sourceContributionGroups)
  ) {
    fail("DESIGN_RULE_INVALID", "rule metadata is invalid");
  }
  if (!abstractText(rule.summary)) {
    fail(
      "DESIGN_RULE_FORBIDDEN_CONTENT",
      "rule summary must be abstract rather than source-derived content",
    );
  }
  const groups = new Set(rule.sourceContributionGroups);
  const evidence = isRecord(rule.evidence) ? rule.evidence : null;
  if (
    groups.size < 5 ||
    groups.size !== rule.sourceContributionGroups.length ||
    !evidence ||
    !hasOnlyKeys(evidence, [
      "independentSourceCount",
      "generalized",
      "selfReimplementable",
      "nonNeighboring",
    ]) ||
    evidence.independentSourceCount !== groups.size
  ) {
    fail(
      "DESIGN_RULE_INSUFFICIENT_EVIDENCE",
      "a reusable rule needs five independent contribution groups",
    );
  }
  if (
    evidence.generalized !== true ||
    evidence.selfReimplementable !== true ||
    evidence.nonNeighboring !== true
  ) {
    fail(
      "DESIGN_RULE_UNSAFE",
      "rule did not pass clean-room safety conditions",
    );
  }
  if (context) {
    let sourceManifests: DesignSourceManifest[];
    try {
      sourceManifests = context.sourceManifests.map((sourceManifest) =>
        validateDesignSourceManifest(sourceManifest),
      );
    } catch {
      fail(
        "DESIGN_RULE_PROVENANCE_UNVERIFIED",
        "rule provenance includes an invalid source manifest",
      );
    }
    const verifiedGroups = new Set(
      sourceManifests.map((manifest) => manifest.sourceContributionGroup),
    );
    if (
      verifiedGroups.has(undefined) ||
      [...groups].some((group) => !verifiedGroups.has(group))
    ) {
      fail(
        "DESIGN_RULE_PROVENANCE_UNVERIFIED",
        "each contribution group must map to a validated source manifest",
      );
    }
  }
  return rule as unknown as DesignRule;
}
