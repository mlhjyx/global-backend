import { createHash } from "node:crypto";
import type {
  DesignEvaluationFindingV2,
  DesignEvaluationSeverity,
  DesignEvaluationTargetV2,
  DesignEvaluationV2,
  DesignEvaluationV2RuleCode,
  ModelExecutionPolicySnapshot,
  QualityArtifactSetV1,
} from "@global/contracts";
import {
  DESIGN_EVALUATION_V2_RULE_CODES,
  designEvaluationV2Digest,
  validateDesignEvaluationV2,
} from "@global/contracts";
import type { SiteBuilderTaskDefinition } from "../agents/ai-task";

export const QUALITY_NARRATIVE_SET_V1_SCHEMA_VERSION =
  "site-builder-quality-narrative-set/v1" as const;
export const QUALITY_NARRATIVE_TASK_INPUT_V1_SCHEMA_VERSION =
  "site-builder-quality-narrative-task-input/v1" as const;

export type QualityNarrativeTaskId =
  "site_builder.qa_summarize" | "site_builder.seo_review";

export type QualityNarrativeFallbackReason =
  | "empty_findings"
  | "consumer_unavailable"
  | "paid_gate_denied"
  | "model_failed"
  | "output_invalid"
  | "settlement_unknown"
  | "prior_settlement_unknown";

export type QualityNarrativeGroupId =
  | "accessibility"
  | "contract"
  | "genericness"
  | "indexing"
  | "localization"
  | "metadata"
  | "network_assets"
  | "performance"
  | "structured_data"
  | "visual_integrity";

export interface QualityNarrativeFindingV1 {
  findingId: string;
  source: "deterministic";
  severity: DesignEvaluationSeverity;
  ruleCode: DesignEvaluationV2RuleCode;
  target: DesignEvaluationTargetV2;
  evidenceArtifactId: string;
  allowedGroupId: QualityNarrativeGroupId;
  allowedExplanationId: QualityNarrativeGroupId;
}

export interface QualityNarrativeSeoReportEvidenceV1 {
  artifactId: string;
  sha256: string;
  target: {
    locale: string;
    pageId: string;
  };
  checks: {
    h1Count: number;
    canonicalPresent: boolean;
    hreflangCount: number;
    previewNoindex: boolean;
    robotsTxtOk: boolean;
    sitemapOk: boolean;
    jsonLdValid: boolean;
    jsonLdUnsupportedFacts: boolean;
  };
}

export interface QualityNarrativeTaskInputV1 {
  schemaVersion: typeof QUALITY_NARRATIVE_TASK_INPUT_V1_SCHEMA_VERSION;
  taskId: QualityNarrativeTaskId;
  candidateSpecDigest: string;
  designBriefDigest: string;
  artifactSetDigest: string;
  designEvaluationDigest: string;
  round: 0 | 1 | 2 | 3;
  findings: QualityNarrativeFindingV1[];
  seoReports: QualityNarrativeSeoReportEvidenceV1[];
}

export interface QualityNarrativeTaskOutputV1 {
  groups: Array<{
    groupId: QualityNarrativeGroupId;
    findingIds: string[];
    explanations: Array<{
      findingId: string;
      explanationId: QualityNarrativeGroupId;
    }>;
  }>;
}

export interface QualityNarrativeModelProvenanceV1 {
  taskAttemptId: string;
  model: string;
  provider: string;
  reportedModel: string | null;
  modelResolutionSource: string | null;
  fallbackIndex: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    calls: number;
  };
  routePolicy: ModelExecutionPolicySnapshot;
}

export interface QualityNarrativeConsumerV1 {
  taskId: QualityNarrativeTaskId;
  mode: "model" | "deterministic";
  fallbackReason: QualityNarrativeFallbackReason | null;
  groups: Array<{
    groupId: QualityNarrativeGroupId;
    label: string;
    findingIds: string[];
    explanations: Array<{
      findingId: string;
      explanationId: QualityNarrativeGroupId;
      text: string;
    }>;
  }>;
  modelProvenance: QualityNarrativeModelProvenanceV1 | null;
}

export interface QualityNarrativeSetV1 {
  schemaVersion: typeof QUALITY_NARRATIVE_SET_V1_SCHEMA_VERSION;
  candidateSpecDigest: string;
  designBriefDigest: string;
  artifactSetDigest: string;
  designEvaluationDigest: string;
  round: 0 | 1 | 2 | 3;
  findings: QualityNarrativeFindingV1[];
  seoReports: QualityNarrativeSeoReportEvidenceV1[];
  qa: QualityNarrativeConsumerV1;
  seo: QualityNarrativeConsumerV1;
}

export interface QualityNarrativeEvidenceRefV1 {
  schemaVersion: typeof QUALITY_NARRATIVE_SET_V1_SCHEMA_VERSION;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
}

const GROUP_LABELS: Record<QualityNarrativeGroupId, string> = {
  accessibility: "Accessibility",
  contract: "Contract integrity",
  genericness: "Distinctiveness",
  indexing: "Indexing controls",
  localization: "Locale discovery",
  metadata: "Metadata",
  network_assets: "Network and asset integrity",
  performance: "Performance",
  structured_data: "Structured data",
  visual_integrity: "Visual integrity",
};

const EXPLANATIONS: Record<QualityNarrativeGroupId, string> = {
  accessibility:
    "The deterministic accessibility gate identified this exact finding.",
  contract: "The deterministic contract gate identified this exact finding.",
  genericness:
    "The deterministic genericness gate identified this exact finding.",
  indexing: "The deterministic indexing gate identified this exact finding.",
  localization:
    "The deterministic locale-discovery gate identified this exact finding.",
  metadata: "The deterministic metadata gate identified this exact finding.",
  network_assets:
    "The deterministic network or asset gate identified this exact finding.",
  performance:
    "The deterministic performance gate identified this exact finding.",
  structured_data:
    "The deterministic structured-data gate identified this exact finding.",
  visual_integrity:
    "The deterministic visual-integrity gate identified this exact finding.",
};

const GROUP_IDS = new Set<string>(Object.keys(GROUP_LABELS));

const SEO_RULES = new Set<DesignEvaluationV2RuleCode>([
  "H1_COUNT_INVALID",
  "CANONICAL_INVALID",
  "HREFLANG_INVALID",
  "PREVIEW_NOINDEX_INVALID",
  "ROBOTS_INVALID",
  "SITEMAP_INVALID",
  "JSON_LD_INVALID",
  "JSON_LD_FACT_UNSUPPORTED",
]);

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("QUALITY_NARRATIVE_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("QUALITY_NARRATIVE_INVALID");
}

export function canonicalQualityNarrativeJson(value: unknown): string {
  return canonicalJson(value);
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function severityRank(value: DesignEvaluationSeverity): number {
  return value === "blocker" ? 0 : value === "major" ? 1 : 2;
}

function groupForRule(
  ruleCode: DesignEvaluationV2RuleCode,
): QualityNarrativeGroupId {
  if (
    ruleCode === "AXE_CRITICAL" ||
    ruleCode === "AXE_SERIOUS" ||
    ruleCode === "WCAG_AA_CONTRAST_FAILED" ||
    ruleCode === "LIGHTHOUSE_ACCESSIBILITY_BELOW_THRESHOLD"
  ) {
    return "accessibility";
  }
  if (ruleCode === "LIGHTHOUSE_PERFORMANCE_BELOW_THRESHOLD") {
    return "performance";
  }
  if (ruleCode === "H1_COUNT_INVALID" || ruleCode === "CANONICAL_INVALID") {
    return "metadata";
  }
  if (
    ruleCode === "PREVIEW_NOINDEX_INVALID" ||
    ruleCode === "ROBOTS_INVALID" ||
    ruleCode === "SITEMAP_INVALID"
  ) {
    return "indexing";
  }
  if (ruleCode === "HREFLANG_INVALID") return "localization";
  if (
    ruleCode === "JSON_LD_INVALID" ||
    ruleCode === "JSON_LD_FACT_UNSUPPORTED"
  ) {
    return "structured_data";
  }
  if (ruleCode.startsWith("GENERICNESS_")) return "genericness";
  if (
    ruleCode === "HORIZONTAL_OVERFLOW" ||
    ruleCode === "TEXT_CLIPPED" ||
    ruleCode === "ELEMENT_OVERLAP" ||
    ruleCode === "CTA_UNREACHABLE"
  ) {
    return "visual_integrity";
  }
  if (
    ruleCode === "OUTBOUND_REQUEST_FORBIDDEN" ||
    ruleCode === "INTERNAL_LINK_BROKEN" ||
    ruleCode === "STATIC_ASSET_MISSING" ||
    ruleCode === "EXTERNAL_FONT_FORBIDDEN"
  ) {
    return "network_assets";
  }
  return "contract";
}

function findingSortKey(finding: DesignEvaluationFindingV2): string {
  return [
    severityRank(finding.severity),
    finding.ruleCode,
    finding.target.locale,
    finding.target.pageId,
    finding.target.sectionId ?? "",
    finding.target.breakpoint ?? "",
    finding.evidenceRef.artifactId,
  ].join(":");
}

export function buildQualityNarrativeFindingIndex(
  evaluation: DesignEvaluationV2,
  artifactSet: QualityArtifactSetV1,
): QualityNarrativeFindingV1[] {
  const validated = validateDesignEvaluationV2(evaluation, artifactSet);
  const occurrences = new Map<string, number>();
  return [
    ...validated.deterministic.hardFailures,
    ...validated.deterministic.findings,
  ]
    .sort((left, right) =>
      findingSortKey(left).localeCompare(findingSortKey(right)),
    )
    .map((finding) => {
      const identity = {
        source: finding.source,
        severity: finding.severity,
        ruleCode: finding.ruleCode,
        target: finding.target,
        evidenceArtifactId: finding.evidenceRef.artifactId,
      };
      const digest = sha256(identity);
      const occurrence = occurrences.get(digest) ?? 0;
      occurrences.set(digest, occurrence + 1);
      const groupId = groupForRule(finding.ruleCode);
      return {
        findingId: `finding-${digest.slice(0, 24)}-${occurrence}`,
        source: "deterministic",
        severity: finding.severity,
        ruleCode: finding.ruleCode,
        target: { ...finding.target },
        evidenceArtifactId: finding.evidenceRef.artifactId,
        allowedGroupId: groupId,
        allowedExplanationId: groupId,
      };
    });
}

export function qualityNarrativeTaskInput(
  taskId: QualityNarrativeTaskId,
  evaluation: DesignEvaluationV2,
  artifactSet: QualityArtifactSetV1,
  findings: QualityNarrativeFindingV1[],
  seoReports: QualityNarrativeSeoReportEvidenceV1[],
): QualityNarrativeTaskInputV1 {
  return {
    schemaVersion: QUALITY_NARRATIVE_TASK_INPUT_V1_SCHEMA_VERSION,
    taskId,
    candidateSpecDigest: evaluation.candidateSpecDigest,
    designBriefDigest: evaluation.designBriefDigest,
    artifactSetDigest: artifactSet.artifactSetDigest,
    designEvaluationDigest: designEvaluationV2Digest(evaluation, artifactSet),
    round: evaluation.round,
    findings,
    seoReports: taskId === "site_builder.seo_review" ? seoReports : [],
  };
}

export function partitionQualityNarrativeFindings(
  findings: readonly QualityNarrativeFindingV1[],
): {
  qa: QualityNarrativeFindingV1[];
  seo: QualityNarrativeFindingV1[];
} {
  return {
    qa: findings.filter((finding) => !SEO_RULES.has(finding.ruleCode)),
    seo: findings.filter((finding) => SEO_RULES.has(finding.ruleCode)),
  };
}

export function validateQualityNarrativeTaskOutput(
  input: QualityNarrativeTaskInputV1,
  output: QualityNarrativeTaskOutputV1,
): QualityNarrativeTaskOutputV1 {
  if (
    !output ||
    typeof output !== "object" ||
    !Array.isArray(output.groups) ||
    Object.keys(output).sort().join(",") !== "groups"
  ) {
    throw new Error("QUALITY_NARRATIVE_OUTPUT_INVALID");
  }
  const expected = new Map(
    input.findings.map((finding) => [finding.findingId, finding]),
  );
  const seen = new Set<string>();
  for (const group of output.groups) {
    if (
      !group ||
      typeof group !== "object" ||
      Object.keys(group).sort().join(",") !==
        "explanations,findingIds,groupId" ||
      !GROUP_IDS.has(group.groupId) ||
      !Array.isArray(group.findingIds) ||
      group.findingIds.length < 1 ||
      !Array.isArray(group.explanations) ||
      group.explanations.length !== group.findingIds.length
    ) {
      throw new Error("QUALITY_NARRATIVE_OUTPUT_INVALID");
    }
    const explanationIds = new Set<string>();
    for (const findingId of group.findingIds) {
      const finding = expected.get(findingId);
      if (
        !finding ||
        seen.has(findingId) ||
        finding.allowedGroupId !== group.groupId
      ) {
        throw new Error("QUALITY_NARRATIVE_OUTPUT_INVALID");
      }
      seen.add(findingId);
    }
    for (const explanation of group.explanations) {
      if (
        !explanation ||
        typeof explanation !== "object" ||
        Object.keys(explanation).sort().join(",") !==
          "explanationId,findingId" ||
        explanationIds.has(explanation.findingId)
      ) {
        throw new Error("QUALITY_NARRATIVE_OUTPUT_INVALID");
      }
      const finding = expected.get(explanation.findingId);
      if (
        !finding ||
        !group.findingIds.includes(explanation.findingId) ||
        explanation.explanationId !== finding.allowedExplanationId
      ) {
        throw new Error("QUALITY_NARRATIVE_OUTPUT_INVALID");
      }
      explanationIds.add(explanation.findingId);
    }
  }
  if (seen.size !== expected.size || expected.size !== input.findings.length) {
    throw new Error("QUALITY_NARRATIVE_OUTPUT_INVALID");
  }
  return output;
}

export function deterministicQualityNarrativeOutput(
  input: QualityNarrativeTaskInputV1,
): QualityNarrativeTaskOutputV1 {
  const groups = new Map<QualityNarrativeGroupId, string[]>();
  for (const finding of input.findings) {
    const entries = groups.get(finding.allowedGroupId) ?? [];
    entries.push(finding.findingId);
    groups.set(finding.allowedGroupId, entries);
  }
  return {
    groups: [...groups.entries()].map(([groupId, findingIds]) => ({
      groupId,
      findingIds,
      explanations: findingIds.map((findingId) => ({
        findingId,
        explanationId: groupId,
      })),
    })),
  };
}

export function materializeQualityNarrativeConsumer(input: {
  taskInput: QualityNarrativeTaskInputV1;
  output: QualityNarrativeTaskOutputV1;
  mode: "model" | "deterministic";
  fallbackReason: QualityNarrativeFallbackReason | null;
  modelProvenance: QualityNarrativeModelProvenanceV1 | null;
}): QualityNarrativeConsumerV1 {
  const output = validateQualityNarrativeTaskOutput(
    input.taskInput,
    input.output,
  );
  return {
    taskId: input.taskInput.taskId,
    mode: input.mode,
    fallbackReason: input.fallbackReason,
    groups: output.groups.map((group) => ({
      groupId: group.groupId,
      label: GROUP_LABELS[group.groupId],
      findingIds: [...group.findingIds],
      explanations: group.explanations.map((explanation) => ({
        ...explanation,
        text: EXPLANATIONS[explanation.explanationId],
      })),
    })),
    modelProvenance: input.modelProvenance,
  };
}

const TASK_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "taskId",
    "candidateSpecDigest",
    "designBriefDigest",
    "artifactSetDigest",
    "designEvaluationDigest",
    "round",
    "findings",
    "seoReports",
  ],
  properties: {
    schemaVersion: { const: QUALITY_NARRATIVE_TASK_INPUT_V1_SCHEMA_VERSION },
    taskId: { type: "string" },
    candidateSpecDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    designBriefDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    artifactSetDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    designEvaluationDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    round: { type: "integer", minimum: 0, maximum: 3 },
    findings: {
      type: "array",
      maxItems: 384,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "findingId",
          "source",
          "severity",
          "ruleCode",
          "target",
          "evidenceArtifactId",
          "allowedGroupId",
          "allowedExplanationId",
        ],
        properties: {
          findingId: {
            type: "string",
            pattern: "^finding-[0-9a-f]{24}-[0-9]+$",
          },
          source: { const: "deterministic" },
          severity: { enum: ["blocker", "major", "minor"] },
          ruleCode: { enum: [...DESIGN_EVALUATION_V2_RULE_CODES] },
          target: {
            type: "object",
            additionalProperties: false,
            required: ["locale", "pageId"],
            properties: {
              locale: { type: "string", minLength: 1, maxLength: 64 },
              pageId: { type: "string", minLength: 1, maxLength: 128 },
              sectionId: { type: "string", minLength: 1, maxLength: 128 },
              breakpoint: { enum: [375, 768, 1440] },
            },
          },
          evidenceArtifactId: {
            type: "string",
            minLength: 1,
            maxLength: 128,
          },
          allowedGroupId: { enum: [...GROUP_IDS] },
          allowedExplanationId: { enum: [...GROUP_IDS] },
        },
      },
    },
    seoReports: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["artifactId", "sha256", "target", "checks"],
        properties: {
          artifactId: { type: "string", minLength: 1, maxLength: 128 },
          sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
          target: {
            type: "object",
            additionalProperties: false,
            required: ["locale", "pageId"],
            properties: {
              locale: { type: "string", minLength: 1, maxLength: 64 },
              pageId: { type: "string", minLength: 1, maxLength: 128 },
            },
          },
          checks: {
            type: "object",
            additionalProperties: false,
            required: [
              "h1Count",
              "canonicalPresent",
              "hreflangCount",
              "previewNoindex",
              "robotsTxtOk",
              "sitemapOk",
              "jsonLdValid",
              "jsonLdUnsupportedFacts",
            ],
            properties: {
              h1Count: { type: "integer", minimum: 0 },
              canonicalPresent: { type: "boolean" },
              hreflangCount: { type: "integer", minimum: 0 },
              previewNoindex: { type: "boolean" },
              robotsTxtOk: { type: "boolean" },
              sitemapOk: { type: "boolean" },
              jsonLdValid: { type: "boolean" },
              jsonLdUnsupportedFacts: { type: "boolean" },
            },
          },
        },
      },
    },
  },
} as const;

const TASK_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["groups"],
  properties: {
    groups: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["groupId", "findingIds", "explanations"],
        properties: {
          groupId: { enum: [...GROUP_IDS] },
          findingIds: {
            type: "array",
            minItems: 1,
            maxItems: 384,
            items: { type: "string" },
          },
          explanations: {
            type: "array",
            maxItems: 384,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["findingId", "explanationId"],
              properties: {
                findingId: { type: "string" },
                explanationId: { enum: [...GROUP_IDS] },
              },
            },
          },
        },
      },
    },
  },
} as const;

function taskDefinition(
  taskId: QualityNarrativeTaskId,
): SiteBuilderTaskDefinition<
  QualityNarrativeTaskInputV1,
  QualityNarrativeTaskOutputV1
> {
  return {
    id: taskId,
    inputSchema: {
      ...TASK_INPUT_SCHEMA,
      properties: {
        ...TASK_INPUT_SCHEMA.properties,
        taskId: { const: taskId },
      },
    },
    outputSchema: TASK_OUTPUT_SCHEMA,
    system:
      "You are a non-authoritative quality narrator. Return only the supplied finding IDs, group IDs, and explanation IDs. Never add a fact, severity, pass/fail decision, repair, recommendation, score, URL, or free-form prose.",
    buildPrompt: (input) =>
      [
        `Task: ${input.taskId}`,
        "Group and order every finding exactly once.",
        "For each finding, use only allowedGroupId and allowedExplanationId.",
        "Do not emit any field other than groups/groupId/findingIds/explanations/findingId/explanationId.",
        `Frozen input: ${canonicalJson(input)}`,
      ].join("\n"),
    validateOutput: validateQualityNarrativeTaskOutput,
    repairTaskOutput: true,
  };
}

export const QA_SUMMARIZE_TASK = taskDefinition("site_builder.qa_summarize");
export const SEO_REVIEW_TASK = taskDefinition("site_builder.seo_review");
