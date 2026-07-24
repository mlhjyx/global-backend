import {
  designSha256,
  hasOnlyKeys,
  isNonBlankString,
  isRecord,
} from "./design-integrity";

export const DESIGN_EVALUATION_SCHEMA_VERSION =
  "site-builder-design-evaluation/v1" as const;
export const DESIGN_EVALUATION_V2_SCHEMA_VERSION =
  "site-builder-design-evaluation/v2" as const;
export const QUALITY_ARTIFACT_SET_SCHEMA_VERSION =
  "site-builder-quality-artifact-set/v1" as const;
export const REPAIR_OPTION_CATALOG_SCHEMA_VERSION =
  "site-builder-repair-option-catalog/v1" as const;

export interface DesignEvaluation {
  schemaVersion: typeof DESIGN_EVALUATION_SCHEMA_VERSION;
  overallScore: number;
  dimensions: Record<
    | "hierarchy"
    | "consistency"
    | "spacing"
    | "contrast"
    | "imagery"
    | "mobileComposition"
    | "ctaClarity"
    | "credibility"
    | "originality",
    number
  >;
  hardFailures: Array<{
    code: string;
    page: string;
    breakpoint: 375 | 768 | 1440;
    selector?: string;
    evidencePath: string;
  }>;
  findings: Array<{
    id: string;
    severity: "blocker" | "major" | "minor";
    target: string;
    rule: string;
    suggestedPatch: object;
  }>;
}

const DIMENSIONS = [
  "hierarchy",
  "consistency",
  "spacing",
  "contrast",
  "imagery",
  "mobileComposition",
  "ctaClarity",
  "credibility",
  "originality",
] as const;

export type DesignEvaluationDimension = (typeof DIMENSIONS)[number];

export const DESIGN_EVALUATION_V2_RULE_CODES = [
  "CONTRACT_INVALID",
  "COMPONENT_UNKNOWN",
  "VARIANT_UNAPPROVED",
  "REFERENCE_INVALID",
  "CLAIM_UNAPPROVED",
  "ASSET_UNAPPROVED",
  "COPY_INVALID",
  "PLACEHOLDER_UNRESOLVED",
  "EXTERNAL_FONT_FORBIDDEN",
  "OUTBOUND_REQUEST_FORBIDDEN",
  "INTERNAL_LINK_BROKEN",
  "STATIC_ASSET_MISSING",
  "H1_COUNT_INVALID",
  "CANONICAL_INVALID",
  "HREFLANG_INVALID",
  "PREVIEW_NOINDEX_INVALID",
  "ROBOTS_INVALID",
  "SITEMAP_INVALID",
  "JSON_LD_INVALID",
  "JSON_LD_FACT_UNSUPPORTED",
  "WCAG_AA_CONTRAST_FAILED",
  "AXE_CRITICAL",
  "AXE_SERIOUS",
  "HORIZONTAL_OVERFLOW",
  "TEXT_CLIPPED",
  "ELEMENT_OVERLAP",
  "CTA_UNREACHABLE",
  "GENERICNESS_STRUCTURE_REPEAT",
  "GENERICNESS_CARD_DENSITY",
  "GENERICNESS_HERO_REPEAT",
  "LIGHTHOUSE_PERFORMANCE_BELOW_THRESHOLD",
  "LIGHTHOUSE_ACCESSIBILITY_BELOW_THRESHOLD",
  "LIGHTHOUSE_SEO_BELOW_THRESHOLD",
  "AESTHETIC_HIERARCHY",
  "AESTHETIC_CONSISTENCY",
  "AESTHETIC_SPACING",
  "AESTHETIC_CONTRAST",
  "AESTHETIC_IMAGERY",
  "AESTHETIC_MOBILE_COMPOSITION",
  "AESTHETIC_CTA_CLARITY",
  "AESTHETIC_CREDIBILITY",
  "AESTHETIC_ORIGINALITY",
] as const;

export type DesignEvaluationV2RuleCode =
  (typeof DESIGN_EVALUATION_V2_RULE_CODES)[number];
export type DesignEvaluationSource = "deterministic" | "aesthetic";
export type DesignEvaluationSeverity = "blocker" | "major" | "minor";
export type QualityBreakpoint = 375 | 768 | 1440;

export interface DesignEvaluationTargetV2 {
  pageId: string;
  sectionId?: string;
  breakpoint?: QualityBreakpoint;
}

export interface DesignEvaluationEvidenceRefV2 {
  artifactId: string;
}

export interface DesignEvaluationFindingV2 {
  source: DesignEvaluationSource;
  severity: DesignEvaluationSeverity;
  ruleCode: DesignEvaluationV2RuleCode;
  target: DesignEvaluationTargetV2;
  evidenceRef: DesignEvaluationEvidenceRefV2;
}

export const AESTHETIC_UNAVAILABLE_REASONS = [
  "model_not_listed",
  "authentication",
  "payment_required",
  "rate_limited",
  "timeout",
  "cancelled",
  "protocol_mismatch",
  "empty_output",
  "schema_invalid",
  "model_identity_mismatch",
  "untrusted_provenance",
] as const;

export type AestheticUnavailableReason =
  (typeof AESTHETIC_UNAVAILABLE_REASONS)[number];

export interface DesignEvaluationV2 {
  schemaVersion: typeof DESIGN_EVALUATION_V2_SCHEMA_VERSION;
  candidateSpecDigest: string;
  designBriefDigest: string;
  artifactSetDigest: string;
  round: 0 | 1 | 2 | 3;
  evaluatorVersion: string;
  deterministic: {
    status: "passed" | "failed";
    hardFailures: DesignEvaluationFindingV2[];
    findings: DesignEvaluationFindingV2[];
  };
  aesthetic: {
    status: "passed" | "failed" | "unavailable";
    overallScore: number | null;
    dimensions: Record<DesignEvaluationDimension, number> | null;
    unavailableReason: AestheticUnavailableReason | null;
    findings: DesignEvaluationFindingV2[];
  };
}

export type DesignEvaluationEnvelope = DesignEvaluation | DesignEvaluationV2;

export type QualityArtifactKind =
  | "screenshot"
  | "axe_report"
  | "lighthouse_report"
  | "seo_report"
  | "deterministic_evaluation"
  | "aesthetic_request"
  | "aesthetic_response"
  | "design_evaluation";

export interface QualityArtifactTargetV1 {
  locale: string;
  pageId: string;
  breakpoint?: QualityBreakpoint;
}

export interface QualityArtifactRefV1 {
  artifactId: string;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  mimeType: "image/png" | "application/json";
  kind: QualityArtifactKind;
  target?: QualityArtifactTargetV1;
}

export interface QualityArtifactSetV1 {
  schemaVersion: typeof QUALITY_ARTIFACT_SET_SCHEMA_VERSION;
  candidateSpecDigest: string;
  designBriefDigest: string;
  round: 0 | 1 | 2 | 3;
  artifactSetDigest: string;
  artifacts: QualityArtifactRefV1[];
}

export type RepairOptionChangeV1 =
  | {
      kind: "approved_blueprint";
      pageId: string;
      blueprintId: string;
    }
  | {
      kind: "approved_variant";
      pageId: string;
      sectionId: string;
      componentType: string;
      variantId: string;
    }
  | {
      kind: "bounded_item_count";
      pageId: string;
      sectionId: string;
      itemCount: number;
    }
  | {
      kind: "approved_asset";
      pageId: string;
      sectionId: string;
      assetRole: string;
      assetRefId: string;
    };

export interface RepairOptionV1 {
  optionId: string;
  rank: number;
  addresses: DesignEvaluationV2RuleCode[];
  resultSpecDigest: string;
  change: RepairOptionChangeV1;
}

export interface RepairOptionCatalogV1 {
  schemaVersion: typeof REPAIR_OPTION_CATALOG_SCHEMA_VERSION;
  catalogDigest: string;
  candidateSpecDigest: string;
  designBriefDigest: string;
  designCatalogDigest: string;
  familyId: string;
  round: 0 | 1 | 2;
  options: RepairOptionV1[];
}

/** The complete model-visible repair output. No patch or free-form field exists. */
export interface RepairOptionSelectionV1 {
  optionId: string;
}

function score(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isBoundedToken(value: unknown, maxLength = 128): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maxLength &&
    value === value.trim() &&
    /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(value)
  );
}

function isRound(value: unknown): value is 0 | 1 | 2 | 3 {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

function isRepairRound(value: unknown): value is 0 | 1 | 2 {
  return value === 0 || value === 1 || value === 2;
}

function isBreakpoint(value: unknown): value is QualityBreakpoint {
  return value === 375 || value === 768 || value === 1440;
}

function isRuleCode(value: unknown): value is DesignEvaluationV2RuleCode {
  return DESIGN_EVALUATION_V2_RULE_CODES.includes(
    value as DesignEvaluationV2RuleCode,
  );
}

function isEvaluationTarget(value: unknown): value is DesignEvaluationTargetV2 {
  const target = isRecord(value) ? value : null;
  return (
    !!target &&
    hasOnlyKeys(target, ["pageId", "sectionId", "breakpoint"]) &&
    isBoundedToken(target.pageId) &&
    (target.sectionId === undefined || isBoundedToken(target.sectionId)) &&
    (target.breakpoint === undefined || isBreakpoint(target.breakpoint))
  );
}

function isEvidenceRef(value: unknown): value is DesignEvaluationEvidenceRefV2 {
  const evidence = isRecord(value) ? value : null;
  return (
    !!evidence &&
    hasOnlyKeys(evidence, ["artifactId"]) &&
    isBoundedToken(evidence.artifactId)
  );
}

function isFinding(
  value: unknown,
  source: DesignEvaluationSource,
  severities: readonly DesignEvaluationSeverity[],
): value is DesignEvaluationFindingV2 {
  const finding = isRecord(value) ? value : null;
  const ruleCode = finding?.ruleCode;
  const sourceMatchesRule =
    isRuleCode(ruleCode) &&
    (source === "aesthetic"
      ? ruleCode.startsWith("AESTHETIC_")
      : !ruleCode.startsWith("AESTHETIC_"));
  return (
    !!finding &&
    hasOnlyKeys(finding, [
      "source",
      "severity",
      "ruleCode",
      "target",
      "evidenceRef",
    ]) &&
    finding.source === source &&
    severities.includes(finding.severity as DesignEvaluationSeverity) &&
    sourceMatchesRule &&
    isEvaluationTarget(finding.target) &&
    isEvidenceRef(finding.evidenceRef)
  );
}

function isDimensionScores(
  value: unknown,
): value is Record<DesignEvaluationDimension, number> {
  const dimensions = isRecord(value) ? value : null;
  return (
    !!dimensions &&
    hasOnlyKeys(dimensions, DIMENSIONS) &&
    DIMENSIONS.every((dimension) => score(dimensions[dimension]))
  );
}

export function validateDesignEvaluation(value: unknown): DesignEvaluation {
  const evaluation = isRecord(value) ? value : null;
  const dimensions =
    evaluation && isRecord(evaluation.dimensions)
      ? evaluation.dimensions
      : null;
  const validDimensions =
    !!dimensions &&
    hasOnlyKeys(dimensions, DIMENSIONS) &&
    DIMENSIONS.every((dimension) => score(dimensions[dimension]));
  const validFailures =
    !!evaluation &&
    Array.isArray(evaluation.hardFailures) &&
    evaluation.hardFailures.every((item) => {
      const failure = isRecord(item) ? item : null;
      return (
        !!failure &&
        hasOnlyKeys(failure, [
          "code",
          "page",
          "breakpoint",
          "selector",
          "evidencePath",
        ]) &&
        isNonBlankString(failure.code) &&
        isNonBlankString(failure.page) &&
        [375, 768, 1440].includes(failure.breakpoint as number) &&
        (failure.selector === undefined ||
          isNonBlankString(failure.selector)) &&
        isNonBlankString(failure.evidencePath)
      );
    });
  const validFindings =
    !!evaluation &&
    Array.isArray(evaluation.findings) &&
    evaluation.findings.every((item) => {
      const finding = isRecord(item) ? item : null;
      return (
        !!finding &&
        hasOnlyKeys(finding, [
          "id",
          "severity",
          "target",
          "rule",
          "suggestedPatch",
        ]) &&
        isNonBlankString(finding.id) &&
        ["blocker", "major", "minor"].includes(String(finding.severity)) &&
        isNonBlankString(finding.target) &&
        isNonBlankString(finding.rule) &&
        isRecord(finding.suggestedPatch)
      );
    });
  if (
    !evaluation ||
    !hasOnlyKeys(evaluation, [
      "schemaVersion",
      "overallScore",
      "dimensions",
      "hardFailures",
      "findings",
    ]) ||
    evaluation.schemaVersion !== DESIGN_EVALUATION_SCHEMA_VERSION ||
    !score(evaluation.overallScore) ||
    !validDimensions ||
    !validFailures ||
    !validFindings
  ) {
    throw new Error("DESIGN_EVALUATION_INVALID");
  }
  return evaluation as unknown as DesignEvaluation;
}

export function validateDesignEvaluationV2(
  value: unknown,
  artifactSet?: QualityArtifactSetV1,
): DesignEvaluationV2 {
  const evaluation = isRecord(value) ? value : null;
  const deterministic =
    evaluation && isRecord(evaluation.deterministic)
      ? evaluation.deterministic
      : null;
  const aesthetic =
    evaluation && isRecord(evaluation.aesthetic) ? evaluation.aesthetic : null;

  const hardFailures =
    deterministic && Array.isArray(deterministic.hardFailures)
      ? deterministic.hardFailures
      : null;
  const deterministicFindings =
    deterministic && Array.isArray(deterministic.findings)
      ? deterministic.findings
      : null;
  const aestheticFindings =
    aesthetic && Array.isArray(aesthetic.findings) ? aesthetic.findings : null;

  const validHardFailures =
    !!hardFailures &&
    hardFailures.length <= 128 &&
    hardFailures.every((finding) =>
      isFinding(finding, "deterministic", ["blocker"]),
    );
  const validDeterministicFindings =
    !!deterministicFindings &&
    deterministicFindings.length <= 256 &&
    deterministicFindings.every((finding) =>
      isFinding(finding, "deterministic", ["major", "minor"]),
    );
  const validDeterministicStatus =
    !!deterministic &&
    ((deterministic.status === "passed" && hardFailures?.length === 0) ||
      (deterministic.status === "failed" && (hardFailures?.length ?? 0) > 0));

  const validAestheticFindings =
    !!aestheticFindings &&
    aestheticFindings.length <= 128 &&
    aestheticFindings.every((finding) =>
      isFinding(finding, "aesthetic", ["blocker", "major", "minor"]),
    );
  const hasAestheticBlocker = aestheticFindings?.some(
    (finding) =>
      isRecord(finding) &&
      (finding.severity === "blocker" || finding.severity === "major"),
  );
  const validUnavailable =
    !!aesthetic &&
    aesthetic.status === "unavailable" &&
    aesthetic.overallScore === null &&
    aesthetic.dimensions === null &&
    AESTHETIC_UNAVAILABLE_REASONS.includes(
      aesthetic.unavailableReason as AestheticUnavailableReason,
    ) &&
    aestheticFindings?.length === 0;
  const validAestheticResult =
    !!aesthetic &&
    (aesthetic.status === "passed" || aesthetic.status === "failed") &&
    score(aesthetic.overallScore) &&
    isDimensionScores(aesthetic.dimensions) &&
    aesthetic.unavailableReason === null &&
    ((aesthetic.status === "passed" &&
      aesthetic.overallScore >= 85 &&
      !hasAestheticBlocker) ||
      (aesthetic.status === "failed" &&
        (aesthetic.overallScore < 85 || hasAestheticBlocker === true)));

  if (
    !evaluation ||
    !hasOnlyKeys(evaluation, [
      "schemaVersion",
      "candidateSpecDigest",
      "designBriefDigest",
      "artifactSetDigest",
      "round",
      "evaluatorVersion",
      "deterministic",
      "aesthetic",
    ]) ||
    evaluation.schemaVersion !== DESIGN_EVALUATION_V2_SCHEMA_VERSION ||
    !isSha256(evaluation.candidateSpecDigest) ||
    !isSha256(evaluation.designBriefDigest) ||
    !isSha256(evaluation.artifactSetDigest) ||
    !isRound(evaluation.round) ||
    !isBoundedToken(evaluation.evaluatorVersion) ||
    !deterministic ||
    !hasOnlyKeys(deterministic, ["status", "hardFailures", "findings"]) ||
    !validHardFailures ||
    !validDeterministicFindings ||
    !validDeterministicStatus ||
    !aesthetic ||
    !hasOnlyKeys(aesthetic, [
      "status",
      "overallScore",
      "dimensions",
      "unavailableReason",
      "findings",
    ]) ||
    !validAestheticFindings ||
    (!validUnavailable && !validAestheticResult)
  ) {
    throw new Error("DESIGN_EVALUATION_V2_INVALID");
  }

  if (artifactSet) {
    const validatedArtifactSet = validateQualityArtifactSet(artifactSet);
    const artifactIds = new Set(
      validatedArtifactSet.artifacts.map((artifact) => artifact.artifactId),
    );
    const allFindings = [
      ...(hardFailures ?? []),
      ...(deterministicFindings ?? []),
      ...(aestheticFindings ?? []),
    ];
    if (
      evaluation.candidateSpecDigest !==
        validatedArtifactSet.candidateSpecDigest ||
      evaluation.designBriefDigest !== validatedArtifactSet.designBriefDigest ||
      evaluation.artifactSetDigest !== validatedArtifactSet.artifactSetDigest ||
      evaluation.round !== validatedArtifactSet.round ||
      allFindings.some(
        (finding) =>
          !isRecord(finding) ||
          !isRecord(finding.evidenceRef) ||
          !artifactIds.has(String(finding.evidenceRef.artifactId)),
      )
    ) {
      throw new Error("DESIGN_EVALUATION_V2_EVIDENCE_MISMATCH");
    }
  }

  return evaluation as unknown as DesignEvaluationV2;
}

export function validateDesignEvaluationEnvelope(
  value: unknown,
): DesignEvaluationEnvelope {
  if (
    isRecord(value) &&
    value.schemaVersion === DESIGN_EVALUATION_V2_SCHEMA_VERSION
  ) {
    return validateDesignEvaluationV2(value);
  }
  return validateDesignEvaluation(value);
}

export function hasDesignEvaluationHardFailures(
  evaluation: DesignEvaluationEnvelope,
): boolean {
  return evaluation.schemaVersion === DESIGN_EVALUATION_V2_SCHEMA_VERSION
    ? evaluation.deterministic.hardFailures.length > 0
    : evaluation.hardFailures.length > 0;
}

function isArtifactTarget(value: unknown): value is QualityArtifactTargetV1 {
  const target = isRecord(value) ? value : null;
  return (
    !!target &&
    hasOnlyKeys(target, ["locale", "pageId", "breakpoint"]) &&
    isBoundedToken(target.locale, 64) &&
    isBoundedToken(target.pageId) &&
    (target.breakpoint === undefined || isBreakpoint(target.breakpoint))
  );
}

function isPrivateObjectKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 512 &&
    value === value.trim() &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes("..") &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  );
}

function isQualityArtifact(value: unknown): value is QualityArtifactRefV1 {
  const artifact = isRecord(value) ? value : null;
  if (
    !artifact ||
    !hasOnlyKeys(artifact, [
      "artifactId",
      "objectKey",
      "sha256",
      "sizeBytes",
      "mimeType",
      "kind",
      "target",
    ]) ||
    !isBoundedToken(artifact.artifactId) ||
    !isPrivateObjectKey(artifact.objectKey) ||
    !isSha256(artifact.sha256) ||
    !Number.isInteger(artifact.sizeBytes) ||
    (artifact.sizeBytes as number) < 1 ||
    (artifact.sizeBytes as number) > 64 * 1024 * 1024 ||
    ![
      "screenshot",
      "axe_report",
      "lighthouse_report",
      "seo_report",
      "deterministic_evaluation",
      "aesthetic_request",
      "aesthetic_response",
      "design_evaluation",
    ].includes(String(artifact.kind)) ||
    (artifact.target !== undefined && !isArtifactTarget(artifact.target))
  ) {
    return false;
  }
  if (artifact.kind === "screenshot") {
    return (
      artifact.mimeType === "image/png" &&
      (artifact.sizeBytes as number) <= 2 * 1024 * 1024 &&
      isRecord(artifact.target) &&
      isBreakpoint(artifact.target.breakpoint)
    );
  }
  return artifact.mimeType === "application/json";
}

type QualityArtifactSetDigestInput = Omit<
  QualityArtifactSetV1,
  "artifactSetDigest"
>;

export function qualityArtifactSetDigest(
  value: QualityArtifactSetDigestInput,
): string {
  return designSha256(value);
}

export function validateQualityArtifactSet(
  value: unknown,
): QualityArtifactSetV1 {
  const artifactSet = isRecord(value) ? value : null;
  const artifacts =
    artifactSet && Array.isArray(artifactSet.artifacts)
      ? artifactSet.artifacts
      : null;
  if (
    !artifactSet ||
    !hasOnlyKeys(artifactSet, [
      "schemaVersion",
      "candidateSpecDigest",
      "designBriefDigest",
      "round",
      "artifactSetDigest",
      "artifacts",
    ]) ||
    artifactSet.schemaVersion !== QUALITY_ARTIFACT_SET_SCHEMA_VERSION ||
    !isSha256(artifactSet.candidateSpecDigest) ||
    !isSha256(artifactSet.designBriefDigest) ||
    !isRound(artifactSet.round) ||
    !isSha256(artifactSet.artifactSetDigest) ||
    !artifacts ||
    artifacts.length < 3 ||
    artifacts.length > 128 ||
    !artifacts.every(isQualityArtifact)
  ) {
    throw new Error("QUALITY_ARTIFACT_SET_INVALID");
  }

  const typedArtifacts = artifacts as QualityArtifactRefV1[];
  const ids = new Set(typedArtifacts.map((artifact) => artifact.artifactId));
  const keys = new Set(typedArtifacts.map((artifact) => artifact.objectKey));
  const totalBytes = typedArtifacts.reduce(
    (total, artifact) => total + artifact.sizeBytes,
    0,
  );
  const screenshots = typedArtifacts.filter(
    (artifact) => artifact.kind === "screenshot",
  );
  const screenshotGroups = new Map<string, Set<QualityBreakpoint>>();
  for (const screenshot of screenshots) {
    const target = screenshot.target!;
    const groupKey = `${target.locale}\u0000${target.pageId}`;
    const breakpoints = screenshotGroups.get(groupKey) ?? new Set();
    if (breakpoints.has(target.breakpoint!)) {
      throw new Error("QUALITY_ARTIFACT_SET_SCREENSHOT_COVERAGE_INVALID");
    }
    breakpoints.add(target.breakpoint!);
    screenshotGroups.set(groupKey, breakpoints);
  }
  const validCoverage =
    screenshots.length >= 3 &&
    screenshots.length <= 72 &&
    screenshotGroups.size >= 1 &&
    screenshotGroups.size <= 24 &&
    [...screenshotGroups.values()].every(
      (breakpoints) =>
        breakpoints.size === 3 &&
        [375, 768, 1440].every((breakpoint) =>
          breakpoints.has(breakpoint as QualityBreakpoint),
        ),
    );
  const digestInput: QualityArtifactSetDigestInput = {
    schemaVersion: QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
    candidateSpecDigest: String(artifactSet.candidateSpecDigest),
    designBriefDigest: String(artifactSet.designBriefDigest),
    round: artifactSet.round as 0 | 1 | 2 | 3,
    artifacts: typedArtifacts,
  };
  if (
    ids.size !== typedArtifacts.length ||
    keys.size !== typedArtifacts.length ||
    totalBytes > 64 * 1024 * 1024 ||
    !validCoverage ||
    artifactSet.artifactSetDigest !== qualityArtifactSetDigest(digestInput)
  ) {
    throw new Error("QUALITY_ARTIFACT_SET_INVALID");
  }
  return artifactSet as unknown as QualityArtifactSetV1;
}

function isRepairChange(value: unknown): value is RepairOptionChangeV1 {
  const change = isRecord(value) ? value : null;
  if (!change || typeof change.kind !== "string") return false;
  if (change.kind === "approved_blueprint") {
    return (
      hasOnlyKeys(change, ["kind", "pageId", "blueprintId"]) &&
      isBoundedToken(change.pageId) &&
      isBoundedToken(change.blueprintId)
    );
  }
  if (change.kind === "approved_variant") {
    return (
      hasOnlyKeys(change, [
        "kind",
        "pageId",
        "sectionId",
        "componentType",
        "variantId",
      ]) &&
      isBoundedToken(change.pageId) &&
      isBoundedToken(change.sectionId) &&
      isBoundedToken(change.componentType) &&
      isBoundedToken(change.variantId)
    );
  }
  if (change.kind === "bounded_item_count") {
    return (
      hasOnlyKeys(change, ["kind", "pageId", "sectionId", "itemCount"]) &&
      isBoundedToken(change.pageId) &&
      isBoundedToken(change.sectionId) &&
      Number.isInteger(change.itemCount) &&
      (change.itemCount as number) >= 1 &&
      (change.itemCount as number) <= 12
    );
  }
  if (change.kind === "approved_asset") {
    return (
      hasOnlyKeys(change, [
        "kind",
        "pageId",
        "sectionId",
        "assetRole",
        "assetRefId",
      ]) &&
      isBoundedToken(change.pageId) &&
      isBoundedToken(change.sectionId) &&
      isBoundedToken(change.assetRole) &&
      isBoundedToken(change.assetRefId)
    );
  }
  return false;
}

function isRepairOption(value: unknown): value is RepairOptionV1 {
  const option = isRecord(value) ? value : null;
  return (
    !!option &&
    hasOnlyKeys(option, [
      "optionId",
      "rank",
      "addresses",
      "resultSpecDigest",
      "change",
    ]) &&
    isBoundedToken(option.optionId) &&
    Number.isInteger(option.rank) &&
    (option.rank as number) >= 1 &&
    (option.rank as number) <= 32 &&
    Array.isArray(option.addresses) &&
    option.addresses.length >= 1 &&
    option.addresses.length <= 16 &&
    option.addresses.every(isRuleCode) &&
    new Set(option.addresses).size === option.addresses.length &&
    isSha256(option.resultSpecDigest) &&
    isRepairChange(option.change)
  );
}

type RepairOptionCatalogDigestInput = Omit<
  RepairOptionCatalogV1,
  "catalogDigest"
>;

export function repairOptionCatalogDigest(
  value: RepairOptionCatalogDigestInput,
): string {
  return designSha256(value);
}

export function validateRepairOptionCatalog(
  value: unknown,
): RepairOptionCatalogV1 {
  const catalog = isRecord(value) ? value : null;
  const options =
    catalog && Array.isArray(catalog.options) ? catalog.options : null;
  if (
    !catalog ||
    !hasOnlyKeys(catalog, [
      "schemaVersion",
      "catalogDigest",
      "candidateSpecDigest",
      "designBriefDigest",
      "designCatalogDigest",
      "familyId",
      "round",
      "options",
    ]) ||
    catalog.schemaVersion !== REPAIR_OPTION_CATALOG_SCHEMA_VERSION ||
    !isSha256(catalog.catalogDigest) ||
    !isSha256(catalog.candidateSpecDigest) ||
    !isSha256(catalog.designBriefDigest) ||
    !isSha256(catalog.designCatalogDigest) ||
    !isBoundedToken(catalog.familyId) ||
    !isRepairRound(catalog.round) ||
    !options ||
    options.length < 1 ||
    options.length > 32 ||
    !options.every(isRepairOption)
  ) {
    throw new Error("REPAIR_OPTION_CATALOG_INVALID");
  }
  const typedOptions = options as RepairOptionV1[];
  const optionIds = new Set(typedOptions.map((option) => option.optionId));
  const ranks = new Set(typedOptions.map((option) => option.rank));
  const sortedRanks = [...ranks].sort((left, right) => left - right);
  const digestInput: RepairOptionCatalogDigestInput = {
    schemaVersion: REPAIR_OPTION_CATALOG_SCHEMA_VERSION,
    candidateSpecDigest: String(catalog.candidateSpecDigest),
    designBriefDigest: String(catalog.designBriefDigest),
    designCatalogDigest: String(catalog.designCatalogDigest),
    familyId: String(catalog.familyId),
    round: catalog.round as 0 | 1 | 2,
    options: typedOptions,
  };
  if (
    optionIds.size !== typedOptions.length ||
    ranks.size !== typedOptions.length ||
    !sortedRanks.every((rank, index) => rank === index + 1) ||
    catalog.catalogDigest !== repairOptionCatalogDigest(digestInput)
  ) {
    throw new Error("REPAIR_OPTION_CATALOG_INVALID");
  }
  return catalog as unknown as RepairOptionCatalogV1;
}

export function validateRepairOptionSelection(
  value: unknown,
  catalog: RepairOptionCatalogV1,
): RepairOptionSelectionV1 {
  const validatedCatalog = validateRepairOptionCatalog(catalog);
  const selection = isRecord(value) ? value : null;
  if (
    !selection ||
    !hasOnlyKeys(selection, ["optionId"]) ||
    !isBoundedToken(selection.optionId) ||
    !validatedCatalog.options.some(
      (option) => option.optionId === selection.optionId,
    )
  ) {
    throw new Error("REPAIR_OPTION_SELECTION_INVALID");
  }
  return selection as unknown as RepairOptionSelectionV1;
}
