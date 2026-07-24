import { createHash } from "node:crypto";
import type { QualityBreakpoint } from "@global/contracts";
import type { GatewayVisionTransport } from "../../model-gateway/providers/openai-compatible.provider";
import type { VisionReviewImage } from "../../model-gateway/types";
import {
  AESTHETIC_RULE_CODES,
  loadAestheticEvalCases,
  type AestheticRuleCode,
} from "./aesthetic-review-eval";

export const BLIND_VISUAL_CALIBRATION_HARNESS_VERSION =
  "site-builder-blind-visual-calibration@1.0.0";
export const BLIND_VISUAL_CALIBRATION_SCHEMA_VERSION =
  "site-builder-blind-visual-calibration-report/v1";
export const BLIND_VISUAL_CALIBRATION_PROMPT_VERSION =
  "site-builder-blind-visual-calibration-prompt/v1";

export const BLIND_VISUAL_REPEATS = 3;
export const BLIND_VISUAL_PAIR_COUNT = 6;
export const BLIND_VISUAL_EXPECTED_RUNS =
  BLIND_VISUAL_PAIR_COUNT * BLIND_VISUAL_REPEATS;
export const BLIND_VISUAL_TIMEOUT_MS = 120_000;
export const BLIND_VISUAL_MAX_TOKENS = 800;
export const BLIND_VISUAL_MAX_COST_CENTS = 5;
export const BLIND_VISUAL_MODEL_COST_BOUND_CENTS = 95;

export const BLIND_VISUAL_CHOICES = ["left", "right", "tie"] as const;
export const BLIND_VISUAL_SEVERITIES = ["blocker", "major", "minor"] as const;

export type BlindVisualChoice = (typeof BLIND_VISUAL_CHOICES)[number];
export type BlindVisualSeverity = (typeof BLIND_VISUAL_SEVERITIES)[number];
export type BlindVisualImageRole = "source" | "degraded";
export type BlindVisualUpstreamModelFamily = "gemini" | "claude" | "gpt-5.6";

export interface BlindVisualCandidateConfig {
  model: BlindVisualCandidateModel;
  transport: GatewayVisionTransport;
  upstreamModelFamily: BlindVisualUpstreamModelFamily;
  timeoutMs: typeof BLIND_VISUAL_TIMEOUT_MS;
  maxTokens: typeof BLIND_VISUAL_MAX_TOKENS;
  maxCostCents: typeof BLIND_VISUAL_MAX_COST_CENTS;
  perModelCostBoundCents: typeof BLIND_VISUAL_MODEL_COST_BOUND_CENTS;
  price: {
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
  };
}

export const BLIND_VISUAL_CANDIDATES = Object.freeze({
  "gemini-3.5-flash": {
    model: "gemini-3.5-flash",
    transport: "google-generate-content",
    upstreamModelFamily: "gemini",
    timeoutMs: BLIND_VISUAL_TIMEOUT_MS,
    maxTokens: BLIND_VISUAL_MAX_TOKENS,
    maxCostCents: BLIND_VISUAL_MAX_COST_CENTS,
    perModelCostBoundCents: BLIND_VISUAL_MODEL_COST_BOUND_CENTS,
    price: {
      inputUsdPerMillionTokens: 1.5,
      outputUsdPerMillionTokens: 9,
    },
  },
  "claude-sonnet-5": {
    model: "claude-sonnet-5",
    transport: "anthropic-messages",
    upstreamModelFamily: "claude",
    timeoutMs: BLIND_VISUAL_TIMEOUT_MS,
    maxTokens: BLIND_VISUAL_MAX_TOKENS,
    maxCostCents: BLIND_VISUAL_MAX_COST_CENTS,
    perModelCostBoundCents: BLIND_VISUAL_MODEL_COST_BOUND_CENTS,
    price: {
      inputUsdPerMillionTokens: 2,
      outputUsdPerMillionTokens: 10,
    },
  },
  "gpt-5.6-terra": {
    model: "gpt-5.6-terra",
    transport: "openai-responses",
    upstreamModelFamily: "gpt-5.6",
    timeoutMs: BLIND_VISUAL_TIMEOUT_MS,
    maxTokens: BLIND_VISUAL_MAX_TOKENS,
    maxCostCents: BLIND_VISUAL_MAX_COST_CENTS,
    perModelCostBoundCents: BLIND_VISUAL_MODEL_COST_BOUND_CENTS,
    price: {
      inputUsdPerMillionTokens: 2.5,
      outputUsdPerMillionTokens: 15,
    },
  },
  "gpt-5.6-sol": {
    model: "gpt-5.6-sol",
    transport: "openai-responses",
    upstreamModelFamily: "gpt-5.6",
    timeoutMs: BLIND_VISUAL_TIMEOUT_MS,
    maxTokens: BLIND_VISUAL_MAX_TOKENS,
    maxCostCents: BLIND_VISUAL_MAX_COST_CENTS,
    perModelCostBoundCents: BLIND_VISUAL_MODEL_COST_BOUND_CENTS,
    price: {
      inputUsdPerMillionTokens: 5,
      outputUsdPerMillionTokens: 30,
    },
  },
} as const satisfies Readonly<
  Record<string, Omit<BlindVisualCandidateConfig, "model"> & { model: string }>
>);

export type BlindVisualCandidateModel = keyof typeof BLIND_VISUAL_CANDIDATES;

for (const candidate of Object.values(BLIND_VISUAL_CANDIDATES)) {
  Object.freeze(candidate.price);
  Object.freeze(candidate);
}

const PAIR_BREAKPOINT_BY_FAMILY = Object.freeze({
  "natural-origin": 1440,
  "oem-capability": 1440,
  "precision-industrial": 1440,
  "premium-innovation": 1440,
  "scientific-trust": 768,
  "technical-catalog": 375,
} as const satisfies Readonly<Record<string, QualityBreakpoint>>);

const OUTPUT_KEYS = ["choice", "findings"] as const;
const FINDING_KEYS = ["ruleCode", "severity", "imageNumber"] as const;

export const BLIND_VISUAL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["choice", "findings"],
  properties: {
    choice: {
      type: "string",
      enum: [...BLIND_VISUAL_CHOICES],
    },
    findings: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ruleCode", "severity", "imageNumber"],
        properties: {
          ruleCode: {
            type: "string",
            enum: [...AESTHETIC_RULE_CODES],
          },
          severity: {
            type: "string",
            enum: [...BLIND_VISUAL_SEVERITIES],
          },
          imageNumber: {
            type: "integer",
            minimum: 1,
            maximum: 3,
          },
        },
      },
    },
  },
} as const;

export interface BlindVisualOutput {
  choice: BlindVisualChoice;
  findings: Array<{
    ruleCode: AestheticRuleCode;
    severity: BlindVisualSeverity;
    imageNumber: 1 | 2 | 3;
  }>;
}

export interface BlindVisualPair {
  pairId: string;
  familyId: string;
  breakpoint: QualityBreakpoint;
  qualification: "deterministic_render_baseline";
  knownIssue: AestheticRuleCode;
  sourcePath: string;
  sourceImage: VisionReviewImage;
  degradedImage: VisionReviewImage;
}

export interface BlindVisualPairDefinition {
  pairId: string;
  familyId: string;
  breakpoint: QualityBreakpoint;
  qualification: "deterministic_render_baseline";
  knownIssue: AestheticRuleCode;
  sourceImage: {
    sha256: string;
    byteLength: number;
  };
  degradedImage: {
    sha256: string;
    byteLength: number;
  };
}

export interface BlindVisualSideAssignment {
  left: BlindVisualImageRole;
  right: BlindVisualImageRole;
}

export interface BlindVisualPairInvocationPlan {
  runKey: string;
  pairId: string;
  familyId: string;
  attempt: 1 | 2 | 3;
  knownIssue: AestheticRuleCode;
  assignment: BlindVisualSideAssignment;
  request: BlindVisualInvocationRequest;
}

export interface BlindVisualProbePlan {
  pairId: string;
  knownIssue: AestheticRuleCode;
  request: BlindVisualInvocationRequest;
}

export interface BlindVisualInvocationRequest {
  phase: "probe" | "pair";
  opaqueRunId: string;
  prompt: string;
  images: readonly VisionReviewImage[];
  schema: typeof BLIND_VISUAL_OUTPUT_SCHEMA;
  model: BlindVisualCandidateModel;
  transport: GatewayVisionTransport;
  timeoutMs: typeof BLIND_VISUAL_TIMEOUT_MS;
  maxTokens: typeof BLIND_VISUAL_MAX_TOKENS;
  maxCostCents: typeof BLIND_VISUAL_MAX_COST_CENTS;
  signal: AbortSignal;
}

export interface BlindVisualProviderResult {
  data: unknown;
  requestedModel: string;
  reportedModel: string;
  resolvedModel: string;
  provider: string;
  transport: GatewayVisionTransport;
  elapsedMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd?: number | null;
  };
  finishReason?: string | null;
  truncated?: boolean;
}

export type BlindVisualInvoke = (
  request: BlindVisualInvocationRequest,
) => Promise<BlindVisualProviderResult>;

export interface BlindVisualExecutionProvenance {
  commitSha: string;
  sourceBundleSha256: string;
}

export type BlindVisualUnavailableReason =
  | "probe_failed"
  | "timeout"
  | "truncated"
  | "schema_invalid"
  | "model_identity_mismatch"
  | "protocol_mismatch"
  | "provider_provenance_mismatch"
  | "usage_invalid"
  | "cost_bound_exceeded"
  | "invocation_failed";

export interface BlindVisualCanonicalFinding {
  ruleCode: AestheticRuleCode;
  severity: BlindVisualSeverity;
  imageRole: BlindVisualImageRole;
}

export interface BlindVisualCallRecord {
  runKey: string;
  pairId: string;
  familyId: string;
  attempt: 1 | 2 | 3;
  knownIssue: AestheticRuleCode;
  assignment: BlindVisualSideAssignment;
  requestedModel: BlindVisualCandidateModel;
  reportedModel: string;
  resolvedModel: string;
  provider: "gateway";
  transport: GatewayVisionTransport;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  reportedCostUsd: number | null;
  calculatedCostUsd: number;
  accountedCostUsd: number;
  finishReason: string | null;
  inputImages: Array<{
    imageNumber: 1 | 2;
    sha256: string;
    byteLength: number;
    breakpoint: QualityBreakpoint;
  }>;
  output: BlindVisualOutput;
  semanticChoice: BlindVisualImageRole | "tie";
  canonicalFindings: BlindVisualCanonicalFinding[];
  formatValid: true;
  provenanceExact: true;
  knownIssueDetected: boolean;
}

export interface BlindVisualProbeRecord {
  accepted: true;
  requestedModel: BlindVisualCandidateModel;
  reportedModel: string;
  resolvedModel: string;
  provider: "gateway";
  transport: GatewayVisionTransport;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  reportedCostUsd: number | null;
  calculatedCostUsd: number;
  accountedCostUsd: number;
  finishReason: string | null;
  inputImages: Array<{
    imageNumber: 1 | 2 | 3;
    sha256: string;
    byteLength: number;
    breakpoint: QualityBreakpoint;
  }>;
  output: BlindVisualOutput;
}

export interface BlindVisualFailureRecord {
  phase: "probe" | "pair";
  runKey: string | null;
  reason: BlindVisualUnavailableReason;
  expectedModel: BlindVisualCandidateModel;
  requestedModel: string | null;
  reportedModel: string | null;
  resolvedModel: string | null;
  provider: string | null;
  expectedTransport: GatewayVisionTransport;
  actualTransport: GatewayVisionTransport | null;
  elapsedMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reportedCostUsd: number | null;
  calculatedCostUsd: number | null;
  finishReason: string | null;
  outputSha256: string | null;
  inputImages: Array<{
    imageNumber: 1 | 2 | 3;
    sha256: string;
    byteLength: number;
    breakpoint: QualityBreakpoint;
  }>;
}

export interface BlindVisualSingleModelMetrics {
  expectedRuns: typeof BLIND_VISUAL_EXPECTED_RUNS;
  actualRuns: number;
  formatAndProvenanceCorrect: number;
  knownIssueHits: number;
  consistentFamilies: number;
  pairP95ElapsedMs: number | null;
  p95ElapsedMs: number | null;
  pairCostUsd: number;
  probeCostUsd: number;
  totalCostUsd: number;
  passed: boolean;
}

export interface BlindVisualModelReport {
  schemaVersion: typeof BLIND_VISUAL_CALIBRATION_SCHEMA_VERSION;
  harnessVersion: typeof BLIND_VISUAL_CALIBRATION_HARNESS_VERSION;
  promptVersion: typeof BLIND_VISUAL_CALIBRATION_PROMPT_VERSION;
  benchmarkQualification: "deterministic_render_baseline_not_aesthetic_gold";
  model: BlindVisualCandidateModel;
  upstreamModelFamily: BlindVisualUpstreamModelFamily;
  transport: GatewayVisionTransport;
  limits: {
    probeCalls: 1;
    pairCalls: typeof BLIND_VISUAL_EXPECTED_RUNS;
    timeoutMs: typeof BLIND_VISUAL_TIMEOUT_MS;
    maxTokens: typeof BLIND_VISUAL_MAX_TOKENS;
    maxCostCentsPerCall: typeof BLIND_VISUAL_MAX_COST_CENTS;
    maxCostCentsPerModel: typeof BLIND_VISUAL_MODEL_COST_BOUND_CENTS;
  };
  provenance: BlindVisualExecutionProvenance;
  matrixDefinition: BlindVisualPairDefinition[];
  matrixDefinitionSha256: string;
  status:
    "single_model_gate_passed" | "single_model_gate_failed" | "unavailable";
  probe: BlindVisualProbeRecord | null;
  runs: BlindVisualCallRecord[];
  metrics: BlindVisualSingleModelMetrics | null;
  unavailableReason: BlindVisualUnavailableReason | null;
  failure: BlindVisualFailureRecord | null;
  conclusion:
    | "single_model_gate_passed"
    | "single_model_gate_failed_no_model_selection_claim"
    | "unavailable_no_model_selection_claim";
}

export interface BlindVisualCombination {
  models: readonly [BlindVisualCandidateModel, BlindVisualCandidateModel];
  upstreamModelFamilies: readonly [
    BlindVisualUpstreamModelFamily,
    BlindVisualUpstreamModelFamily,
  ];
  commonKnownIssueHits: number;
  expectedRuns: typeof BLIND_VISUAL_EXPECTED_RUNS;
  passed: boolean;
  conclusion:
    | "eligible_for_aesthetic_gold_calibration"
    | "dual_model_common_hit_gate_failed";
}

export interface BlindVisualEnsembleSummary {
  rankedPassingModels: BlindVisualCandidateModel[];
  combination: BlindVisualCombination | null;
}

class BlindVisualCallRejected extends Error {
  constructor(readonly reason: BlindVisualUnavailableReason) {
    super(`BLIND_VISUAL_CALL_REJECTED: ${reason}`);
    this.name = "BlindVisualCallRejected";
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const frozen = [...expected].sort();
  return (
    actual.length === frozen.length &&
    actual.every((key, index) => key === frozen[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function round(value: number, places = 8): number {
  return Number(value.toFixed(places));
}

function assertExecutionProvenance(
  provenance: BlindVisualExecutionProvenance,
): void {
  if (
    !/^[a-f0-9]{40}$/.test(provenance.commitSha) ||
    !/^[a-f0-9]{64}$/.test(provenance.sourceBundleSha256)
  ) {
    throw new Error("BLIND_VISUAL_PROVENANCE_INVALID");
  }
}

function assertCandidateConfig(candidate: BlindVisualCandidateConfig): void {
  if (
    candidate !== BLIND_VISUAL_CANDIDATES[candidate.model] ||
    candidate.timeoutMs !== BLIND_VISUAL_TIMEOUT_MS ||
    candidate.maxTokens !== BLIND_VISUAL_MAX_TOKENS ||
    candidate.maxCostCents !== BLIND_VISUAL_MAX_COST_CENTS ||
    candidate.perModelCostBoundCents !== BLIND_VISUAL_MODEL_COST_BOUND_CENTS
  ) {
    throw new Error("BLIND_VISUAL_CANDIDATE_CONFIG_INVALID");
  }
}

export function assertBlindVisualOutput(
  value: unknown,
  imageCount: 2 | 3,
): BlindVisualOutput {
  if (!isRecord(value) || !hasExactKeys(value, OUTPUT_KEYS)) {
    throw new Error("BLIND_VISUAL_OUTPUT_INVALID");
  }
  if (
    !BLIND_VISUAL_CHOICES.includes(value.choice as BlindVisualChoice) ||
    !Array.isArray(value.findings) ||
    value.findings.length > 4
  ) {
    throw new Error("BLIND_VISUAL_OUTPUT_INVALID");
  }
  for (const finding of value.findings) {
    if (
      !isRecord(finding) ||
      !hasExactKeys(finding, FINDING_KEYS) ||
      !AESTHETIC_RULE_CODES.includes(finding.ruleCode as AestheticRuleCode) ||
      !BLIND_VISUAL_SEVERITIES.includes(
        finding.severity as BlindVisualSeverity,
      ) ||
      !Number.isInteger(finding.imageNumber) ||
      Number(finding.imageNumber) < 1 ||
      Number(finding.imageNumber) > imageCount
    ) {
      throw new Error("BLIND_VISUAL_OUTPUT_INVALID");
    }
  }
  return structuredClone(value) as unknown as BlindVisualOutput;
}

function anonymizeImage(
  image: VisionReviewImage,
  opaqueRunId: string,
  imageNumber: 1 | 2 | 3,
): VisionReviewImage {
  const artifactId = `blind-image-${sha256(
    `${opaqueRunId}:${imageNumber}:${image.sha256}`,
  ).slice(0, 20)}`;
  return {
    ...image,
    artifactId,
    target: {
      ...image.target,
      pageId: `blind-page-${sha256(opaqueRunId).slice(0, 16)}`,
    },
  };
}

function pairPrompt(opaqueRunId: string): string {
  return [
    `Blind visual comparison ${opaqueRunId}.`,
    "Image 1 is left and image 2 is right. They show the same page at the same viewport.",
    "Choose which image has more visible design problems: left, right, or tie.",
    "Return exact JSON only with choice and at most four findings.",
    "Each finding may contain only ruleCode, severity, and imageNumber.",
    `Allowed ruleCode values: ${AESTHETIC_RULE_CODES.join(", ")}.`,
    `Allowed severity values: ${BLIND_VISUAL_SEVERITIES.join(", ")}.`,
    "Do not output scores, dimensions, pass/fail decisions, repairs, code, or free text.",
  ].join("\n");
}

function probePrompt(opaqueRunId: string): string {
  return [
    `Three-image vision capability probe ${opaqueRunId}.`,
    "Images 1 and 2 are byte-identical and act as left and right, so choice must be tie.",
    "Inspect all three images and report visible design problems using at most four findings.",
    "Return exact JSON only with choice and findings.",
    "Each finding may contain only ruleCode, severity, and imageNumber.",
    `Allowed ruleCode values: ${AESTHETIC_RULE_CODES.join(", ")}.`,
    `Allowed severity values: ${BLIND_VISUAL_SEVERITIES.join(", ")}.`,
    "Do not output scores, dimensions, pass/fail decisions, repairs, code, or free text.",
  ].join("\n");
}

function assignmentFor(
  pairId: string,
  attempt: 1 | 2 | 3,
): BlindVisualSideAssignment {
  const sourceFirst = Number.parseInt(sha256(pairId).slice(0, 2), 16) % 2 === 0;
  const sourceOnLeft = attempt === 2 ? !sourceFirst : sourceFirst;
  return sourceOnLeft
    ? { left: "source", right: "degraded" }
    : { left: "degraded", right: "source" };
}

export async function loadBlindVisualPairs(
  repositoryRoot: string,
): Promise<BlindVisualPair[]> {
  const cases = await loadAestheticEvalCases(repositoryRoot);
  const pairs: BlindVisualPair[] = [];
  for (const [familyId, breakpoint] of Object.entries(
    PAIR_BREAKPOINT_BY_FAMILY,
  ) as Array<[keyof typeof PAIR_BREAKPOINT_BY_FAMILY, QualityBreakpoint]>) {
    const sourceCase = cases.find(
      (item) => item.familyId === familyId && item.kind === "baseline",
    );
    const degradedCase = cases.find(
      (item) => item.familyId === familyId && item.kind === "degraded",
    );
    const sourceImage = sourceCase?.images.find(
      (image) => image.target.breakpoint === breakpoint,
    );
    const degradedImage = degradedCase?.images.find(
      (image) => image.target.breakpoint === breakpoint,
    );
    if (
      !sourceCase ||
      !degradedCase ||
      !degradedCase.expectedIssue ||
      !sourceImage ||
      !degradedImage ||
      sourceImage.target.breakpoint !== degradedImage.target.breakpoint
    ) {
      throw new Error(`BLIND_VISUAL_PAIR_INVALID: ${familyId}`);
    }
    const pairId = `blind-pair-${sha256(
      `${sourceImage.sha256}:${degradedImage.sha256}:${breakpoint}`,
    ).slice(0, 20)}`;
    pairs.push({
      pairId,
      familyId,
      breakpoint,
      qualification: "deterministic_render_baseline",
      knownIssue: degradedCase.expectedIssue,
      sourcePath:
        `apps/site-renderer/visual-tests/__screenshots__/m1-e-b/` +
        `${breakpoint === 375 ? "mobile-375" : breakpoint === 768 ? "tablet-768" : "desktop-1440"}/${familyId}-rich.png`,
      sourceImage,
      degradedImage,
    });
  }
  return pairs.sort((left, right) =>
    left.familyId < right.familyId
      ? -1
      : left.familyId > right.familyId
        ? 1
        : 0,
  );
}

export function buildBlindVisualMatrixDefinition(
  pairs: readonly BlindVisualPair[],
): BlindVisualPairDefinition[] {
  if (
    pairs.length !== BLIND_VISUAL_PAIR_COUNT ||
    new Set(pairs.map((pair) => pair.familyId)).size !==
      BLIND_VISUAL_PAIR_COUNT ||
    new Set(pairs.map((pair) => pair.pairId)).size !== BLIND_VISUAL_PAIR_COUNT
  ) {
    throw new Error("BLIND_VISUAL_PAIR_SET_INVALID");
  }
  return [...pairs]
    .sort((left, right) =>
      left.familyId < right.familyId
        ? -1
        : left.familyId > right.familyId
          ? 1
          : 0,
    )
    .map((pair) => ({
      pairId: pair.pairId,
      familyId: pair.familyId,
      breakpoint: pair.breakpoint,
      qualification: pair.qualification,
      knownIssue: pair.knownIssue,
      sourceImage: {
        sha256: pair.sourceImage.sha256,
        byteLength: pair.sourceImage.bytes.byteLength,
      },
      degradedImage: {
        sha256: pair.degradedImage.sha256,
        byteLength: pair.degradedImage.bytes.byteLength,
      },
    }));
}

function matrixDefinitionSha256(
  definition: readonly BlindVisualPairDefinition[],
): string {
  return sha256(JSON.stringify(definition));
}

export function buildBlindVisualPairPlans(
  candidate: BlindVisualCandidateConfig,
  pairs: readonly BlindVisualPair[],
): BlindVisualPairInvocationPlan[] {
  assertCandidateConfig(candidate);
  if (
    pairs.length !== BLIND_VISUAL_PAIR_COUNT ||
    new Set(pairs.map((pair) => pair.familyId)).size !==
      BLIND_VISUAL_PAIR_COUNT ||
    new Set(pairs.map((pair) => pair.pairId)).size !== BLIND_VISUAL_PAIR_COUNT
  ) {
    throw new Error("BLIND_VISUAL_PAIR_SET_INVALID");
  }
  const plans: BlindVisualPairInvocationPlan[] = [];
  for (const pair of pairs) {
    for (
      let attempt = 1 as 1 | 2 | 3;
      attempt <= BLIND_VISUAL_REPEATS;
      attempt = (attempt + 1) as 1 | 2 | 3
    ) {
      const assignment = assignmentFor(pair.pairId, attempt);
      const opaqueRunId = `blind-run-${sha256(
        `${pair.pairId}:${attempt}:${BLIND_VISUAL_CALIBRATION_PROMPT_VERSION}`,
      ).slice(0, 20)}`;
      const left =
        assignment.left === "source" ? pair.sourceImage : pair.degradedImage;
      const right =
        assignment.right === "source" ? pair.sourceImage : pair.degradedImage;
      const controller = new AbortController();
      plans.push({
        runKey: `${pair.pairId}:${attempt}`,
        pairId: pair.pairId,
        familyId: pair.familyId,
        attempt,
        knownIssue: pair.knownIssue,
        assignment,
        request: {
          phase: "pair",
          opaqueRunId,
          prompt: pairPrompt(opaqueRunId),
          images: [
            anonymizeImage(left, opaqueRunId, 1),
            anonymizeImage(right, opaqueRunId, 2),
          ],
          schema: BLIND_VISUAL_OUTPUT_SCHEMA,
          model: candidate.model,
          transport: candidate.transport,
          timeoutMs: candidate.timeoutMs,
          maxTokens: candidate.maxTokens,
          maxCostCents: candidate.maxCostCents,
          signal: controller.signal,
        },
      });
    }
  }
  return plans;
}

export function buildBlindVisualProbePlan(
  candidate: BlindVisualCandidateConfig,
  pairs: readonly BlindVisualPair[],
): BlindVisualProbePlan {
  assertCandidateConfig(candidate);
  const pair = pairs[0];
  if (!pair) throw new Error("BLIND_VISUAL_PROBE_PAIR_MISSING");
  const opaqueRunId = `blind-probe-${sha256(
    `${pair.pairId}:${BLIND_VISUAL_CALIBRATION_PROMPT_VERSION}`,
  ).slice(0, 20)}`;
  const controller = new AbortController();
  return {
    pairId: pair.pairId,
    knownIssue: pair.knownIssue,
    request: {
      phase: "probe",
      opaqueRunId,
      prompt: probePrompt(opaqueRunId),
      images: [
        anonymizeImage(pair.sourceImage, opaqueRunId, 1),
        anonymizeImage(pair.sourceImage, opaqueRunId, 2),
        anonymizeImage(pair.degradedImage, opaqueRunId, 3),
      ],
      schema: BLIND_VISUAL_OUTPUT_SCHEMA,
      model: candidate.model,
      transport: candidate.transport,
      timeoutMs: candidate.timeoutMs,
      maxTokens: candidate.maxTokens,
      maxCostCents: candidate.maxCostCents,
      signal: controller.signal,
    },
  };
}

function calculatedCostUsd(
  candidate: BlindVisualCandidateConfig,
  result: BlindVisualProviderResult,
): number {
  return round(
    (result.usage.inputTokens * candidate.price.inputUsdPerMillionTokens +
      result.usage.outputTokens * candidate.price.outputUsdPerMillionTokens) /
      1_000_000,
  );
}

function assertProviderResult(
  candidate: BlindVisualCandidateConfig,
  result: BlindVisualProviderResult,
  imageCount: 2 | 3,
): {
  output: BlindVisualOutput;
  reportedCostUsd: number | null;
  calculatedCostUsd: number;
  accountedCostUsd: number;
  finishReason: string | null;
} {
  if (
    result.requestedModel !== candidate.model ||
    result.reportedModel !== candidate.model ||
    result.resolvedModel !== candidate.model
  ) {
    throw new BlindVisualCallRejected("model_identity_mismatch");
  }
  if (result.transport !== candidate.transport) {
    throw new BlindVisualCallRejected("protocol_mismatch");
  }
  if (result.provider !== "gateway") {
    throw new BlindVisualCallRejected("provider_provenance_mismatch");
  }
  if (
    !Number.isFinite(result.elapsedMs) ||
    result.elapsedMs < 0 ||
    result.elapsedMs > candidate.timeoutMs
  ) {
    throw new BlindVisualCallRejected("timeout");
  }
  const finishReason = result.finishReason ?? null;
  if (
    result.truncated === true ||
    finishReason === "length" ||
    finishReason === "max_tokens"
  ) {
    throw new BlindVisualCallRejected("truncated");
  }
  if (
    !Number.isInteger(result.usage.inputTokens) ||
    result.usage.inputTokens < 0 ||
    !Number.isInteger(result.usage.outputTokens) ||
    result.usage.outputTokens < 0 ||
    (result.usage.costUsd !== undefined &&
      result.usage.costUsd !== null &&
      (!Number.isFinite(result.usage.costUsd) || result.usage.costUsd < 0))
  ) {
    throw new BlindVisualCallRejected("usage_invalid");
  }
  const calculated = calculatedCostUsd(candidate, result);
  const reported = result.usage.costUsd ?? null;
  const accounted = round(Math.max(calculated, reported ?? 0));
  if (accounted * 100 > candidate.maxCostCents) {
    throw new BlindVisualCallRejected("cost_bound_exceeded");
  }
  let output: BlindVisualOutput;
  try {
    output = assertBlindVisualOutput(result.data, imageCount);
  } catch {
    throw new BlindVisualCallRejected("schema_invalid");
  }
  return {
    output,
    reportedCostUsd: reported,
    calculatedCostUsd: calculated,
    accountedCostUsd: accounted,
    finishReason,
  };
}

function assertPairOutput(output: BlindVisualOutput): BlindVisualOutput {
  try {
    return assertBlindVisualOutput(output, 2);
  } catch {
    throw new BlindVisualCallRejected("schema_invalid");
  }
}

function choiceToRole(
  choice: BlindVisualChoice,
  assignment: BlindVisualSideAssignment,
): BlindVisualImageRole | "tie" {
  if (choice === "tie") return "tie";
  return choice === "left" ? assignment.left : assignment.right;
}

function canonicalizeFindings(
  output: BlindVisualOutput,
  assignment: BlindVisualSideAssignment,
): BlindVisualCanonicalFinding[] {
  return output.findings.map((finding) => ({
    ruleCode: finding.ruleCode,
    severity: finding.severity,
    imageRole: finding.imageNumber === 1 ? assignment.left : assignment.right,
  }));
}

function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? null;
}

function assertMatrixDefinition(
  definition: readonly BlindVisualPairDefinition[],
): void {
  if (
    definition.length !== BLIND_VISUAL_PAIR_COUNT ||
    new Set(definition.map((pair) => pair.pairId)).size !==
      BLIND_VISUAL_PAIR_COUNT ||
    new Set(definition.map((pair) => pair.familyId)).size !==
      BLIND_VISUAL_PAIR_COUNT
  ) {
    throw new Error("BLIND_VISUAL_STATS_MATRIX_INVALID");
  }
  const sorted = [...definition].sort((left, right) =>
    left.familyId < right.familyId
      ? -1
      : left.familyId > right.familyId
        ? 1
        : 0,
  );
  if (JSON.stringify(sorted) !== JSON.stringify(definition)) {
    throw new Error("BLIND_VISUAL_STATS_MATRIX_INVALID");
  }
  for (const pair of definition) {
    const expectedBreakpoint =
      PAIR_BREAKPOINT_BY_FAMILY[
        pair.familyId as keyof typeof PAIR_BREAKPOINT_BY_FAMILY
      ];
    const expectedPairId = `blind-pair-${sha256(
      `${pair.sourceImage.sha256}:${pair.degradedImage.sha256}:${pair.breakpoint}`,
    ).slice(0, 20)}`;
    if (
      expectedBreakpoint === undefined ||
      pair.breakpoint !== expectedBreakpoint ||
      pair.qualification !== "deterministic_render_baseline" ||
      !AESTHETIC_RULE_CODES.includes(pair.knownIssue) ||
      !/^[a-f0-9]{64}$/.test(pair.sourceImage.sha256) ||
      !/^[a-f0-9]{64}$/.test(pair.degradedImage.sha256) ||
      pair.sourceImage.sha256 === pair.degradedImage.sha256 ||
      !Number.isInteger(pair.sourceImage.byteLength) ||
      pair.sourceImage.byteLength <= 0 ||
      !Number.isInteger(pair.degradedImage.byteLength) ||
      pair.degradedImage.byteLength <= 0 ||
      pair.pairId !== expectedPairId
    ) {
      throw new Error("BLIND_VISUAL_STATS_MATRIX_INVALID");
    }
  }
}

function assertCostEvidence(
  candidate: BlindVisualCandidateConfig,
  record: Pick<
    BlindVisualCallRecord,
    | "inputTokens"
    | "outputTokens"
    | "reportedCostUsd"
    | "calculatedCostUsd"
    | "accountedCostUsd"
  >,
): void {
  if (
    !Number.isInteger(record.inputTokens) ||
    record.inputTokens < 0 ||
    !Number.isInteger(record.outputTokens) ||
    record.outputTokens < 0 ||
    (record.reportedCostUsd !== null &&
      (!Number.isFinite(record.reportedCostUsd) || record.reportedCostUsd < 0))
  ) {
    throw new Error("BLIND_VISUAL_STATS_COST_EVIDENCE_INVALID");
  }
  const calculated = round(
    (record.inputTokens * candidate.price.inputUsdPerMillionTokens +
      record.outputTokens * candidate.price.outputUsdPerMillionTokens) /
      1_000_000,
  );
  const accounted = round(Math.max(calculated, record.reportedCostUsd ?? 0));
  if (
    record.calculatedCostUsd !== calculated ||
    record.accountedCostUsd !== accounted
  ) {
    throw new Error("BLIND_VISUAL_STATS_COST_EVIDENCE_INVALID");
  }
}

function assertProbeRecord(
  candidate: BlindVisualCandidateConfig,
  probe: BlindVisualProbeRecord,
  definition: readonly BlindVisualPairDefinition[],
): void {
  const pair = definition[0];
  if (!pair) throw new Error("BLIND_VISUAL_STATS_PROBE_INVALID");
  const output = assertBlindVisualOutput(probe.output, 3);
  assertCostEvidence(candidate, probe);
  if (
    probe.accepted !== true ||
    probe.requestedModel !== candidate.model ||
    probe.reportedModel !== candidate.model ||
    probe.resolvedModel !== candidate.model ||
    probe.provider !== "gateway" ||
    probe.transport !== candidate.transport ||
    probe.accountedCostUsd * 100 > candidate.maxCostCents ||
    !Number.isFinite(probe.elapsedMs) ||
    probe.elapsedMs < 0 ||
    probe.elapsedMs > candidate.timeoutMs ||
    probe.inputImages.length !== 3 ||
    probe.inputImages[0]?.imageNumber !== 1 ||
    probe.inputImages[1]?.imageNumber !== 2 ||
    probe.inputImages[2]?.imageNumber !== 3 ||
    probe.inputImages[0]?.sha256 !== pair.sourceImage.sha256 ||
    probe.inputImages[1]?.sha256 !== pair.sourceImage.sha256 ||
    probe.inputImages[2]?.sha256 !== pair.degradedImage.sha256 ||
    probe.inputImages[0]?.byteLength !== pair.sourceImage.byteLength ||
    probe.inputImages[1]?.byteLength !== pair.sourceImage.byteLength ||
    probe.inputImages[2]?.byteLength !== pair.degradedImage.byteLength ||
    probe.inputImages.some((image) => image.breakpoint !== pair.breakpoint) ||
    output.choice !== "tie" ||
    !output.findings.some(
      (finding) =>
        finding.imageNumber === 3 && finding.ruleCode === pair.knownIssue,
    )
  ) {
    throw new Error("BLIND_VISUAL_STATS_PROBE_INVALID");
  }
}

export function summarizeBlindVisualCandidate(
  candidate: BlindVisualCandidateConfig,
  runs: readonly BlindVisualCallRecord[],
  probe: BlindVisualProbeRecord,
  matrixDefinition: readonly BlindVisualPairDefinition[],
  canonicalMatrixDefinition: readonly BlindVisualPairDefinition[],
): BlindVisualSingleModelMetrics {
  assertCandidateConfig(candidate);
  assertMatrixDefinition(matrixDefinition);
  assertMatrixDefinition(canonicalMatrixDefinition);
  if (
    JSON.stringify(matrixDefinition) !==
    JSON.stringify(canonicalMatrixDefinition)
  ) {
    throw new Error("BLIND_VISUAL_STATS_MATRIX_PROVENANCE_MISMATCH");
  }
  assertProbeRecord(candidate, probe, matrixDefinition);
  const seen = new Set<string>();
  const definitionByPairId = new Map(
    matrixDefinition.map((pair) => [pair.pairId, pair]),
  );
  for (const run of runs) {
    if (seen.has(run.runKey)) {
      throw new Error(`BLIND_VISUAL_STATS_DUPLICATE_RUN: ${run.runKey}`);
    }
    seen.add(run.runKey);
    const definition = definitionByPairId.get(run.pairId);
    const expectedAssignment = assignmentFor(run.pairId, run.attempt);
    const output = assertBlindVisualOutput(run.output, 2);
    const semanticChoice = choiceToRole(output.choice, expectedAssignment);
    const canonicalFindings = canonicalizeFindings(output, expectedAssignment);
    const knownIssueDetected = canonicalFindings.some(
      (finding) =>
        finding.imageRole === "degraded" &&
        finding.ruleCode === definition?.knownIssue,
    );
    const expectedImages = definition
      ? ([expectedAssignment.left, expectedAssignment.right] as const).map(
          (role, index) => {
            const image =
              role === "source"
                ? definition.sourceImage
                : definition.degradedImage;
            return {
              imageNumber: (index + 1) as 1 | 2,
              sha256: image.sha256,
              byteLength: image.byteLength,
              breakpoint: definition.breakpoint,
            };
          },
        )
      : [];
    assertCostEvidence(candidate, run);
    if (
      !definition ||
      run.runKey !== `${run.pairId}:${run.attempt}` ||
      run.familyId !== definition.familyId ||
      run.knownIssue !== definition.knownIssue ||
      ![1, 2, 3].includes(run.attempt) ||
      JSON.stringify(run.assignment) !== JSON.stringify(expectedAssignment) ||
      JSON.stringify(run.inputImages) !== JSON.stringify(expectedImages) ||
      run.requestedModel !== candidate.model ||
      run.reportedModel !== candidate.model ||
      run.resolvedModel !== candidate.model ||
      run.provider !== "gateway" ||
      run.transport !== candidate.transport ||
      !Number.isFinite(run.elapsedMs) ||
      run.elapsedMs < 0 ||
      run.elapsedMs > candidate.timeoutMs ||
      run.formatValid !== true ||
      run.provenanceExact !== true
    ) {
      throw new Error(`BLIND_VISUAL_STATS_RUN_INVALID: ${run.runKey}`);
    }
    if (
      run.semanticChoice !== semanticChoice ||
      JSON.stringify(run.canonicalFindings) !==
        JSON.stringify(canonicalFindings) ||
      run.knownIssueDetected !== knownIssueDetected
    ) {
      throw new Error(`BLIND_VISUAL_STATS_DERIVED_MISMATCH: ${run.runKey}`);
    }
  }
  if (runs.length !== BLIND_VISUAL_EXPECTED_RUNS) {
    throw new Error("BLIND_VISUAL_STATS_MATRIX_INCOMPLETE");
  }
  for (const definition of matrixDefinition) {
    const attempts = runs
      .filter((run) => run.pairId === definition.pairId)
      .map((run) => run.attempt)
      .sort((left, right) => left - right);
    if (JSON.stringify(attempts) !== JSON.stringify([1, 2, 3])) {
      throw new Error("BLIND_VISUAL_STATS_MATRIX_INCOMPLETE");
    }
  }
  const familyGroups = new Map<string, BlindVisualCallRecord[]>();
  for (const run of runs) {
    const group = familyGroups.get(run.familyId) ?? [];
    group.push(run);
    familyGroups.set(run.familyId, group);
  }
  const consistentFamilies = [...familyGroups.values()].filter((group) => {
    if (
      group.length !== BLIND_VISUAL_REPEATS ||
      new Set(group.map((run) => run.attempt)).size !== BLIND_VISUAL_REPEATS
    ) {
      return false;
    }
    const signatures = new Set(
      group.map((run) => `${run.semanticChoice}:${run.knownIssueDetected}`),
    );
    return signatures.size === 1;
  }).length;
  const formatAndProvenanceCorrect = runs.filter(
    (run) => run.formatValid && run.provenanceExact,
  ).length;
  const knownIssueHits = runs.filter(
    (run) => run.semanticChoice === "degraded" && run.knownIssueDetected,
  ).length;
  const pairCostUsd = round(
    runs.reduce((total, run) => total + run.accountedCostUsd, 0),
  );
  const probeCostUsd = probe?.accountedCostUsd ?? 0;
  const totalCostUsd = round(pairCostUsd + probeCostUsd);
  const pairP95ElapsedMs = percentile95(runs.map((run) => run.elapsedMs));
  const metrics: BlindVisualSingleModelMetrics = {
    expectedRuns: BLIND_VISUAL_EXPECTED_RUNS,
    actualRuns: runs.length,
    formatAndProvenanceCorrect,
    knownIssueHits,
    consistentFamilies,
    pairP95ElapsedMs,
    p95ElapsedMs: percentile95([
      probe.elapsedMs,
      ...runs.map((run) => run.elapsedMs),
    ]),
    pairCostUsd,
    probeCostUsd,
    totalCostUsd,
    passed:
      formatAndProvenanceCorrect === BLIND_VISUAL_EXPECTED_RUNS &&
      knownIssueHits >= 17 &&
      consistentFamilies >= 5 &&
      runs.every(
        (run) =>
          run.elapsedMs <= candidate.timeoutMs &&
          run.accountedCostUsd * 100 <= candidate.maxCostCents,
      ) &&
      probe.accountedCostUsd * 100 <= candidate.maxCostCents &&
      totalCostUsd * 100 <= candidate.perModelCostBoundCents,
  };
  return metrics;
}

function comparisonKey(finding: BlindVisualCanonicalFinding): string {
  return `${finding.ruleCode}:${finding.imageRole}`;
}

function commonKnownIssueHit(
  left: BlindVisualCallRecord,
  right: BlindVisualCallRecord,
): boolean {
  if (
    left.semanticChoice !== "degraded" ||
    right.semanticChoice !== "degraded" ||
    !left.knownIssueDetected ||
    !right.knownIssueDetected
  ) {
    return false;
  }
  const leftFindings = new Set(
    left.canonicalFindings
      .filter((finding) => finding.imageRole === "degraded")
      .map(comparisonKey),
  );
  return right.canonicalFindings
    .filter((finding) => finding.imageRole === "degraded")
    .some((finding) => leftFindings.has(comparisonKey(finding)));
}

function comparePassingReports(
  left: BlindVisualModelReport,
  right: BlindVisualModelReport,
): number {
  const leftMetrics = left.metrics!;
  const rightMetrics = right.metrics!;
  return (
    rightMetrics.knownIssueHits - leftMetrics.knownIssueHits ||
    rightMetrics.consistentFamilies - leftMetrics.consistentFamilies ||
    (leftMetrics.p95ElapsedMs ?? Number.POSITIVE_INFINITY) -
      (rightMetrics.p95ElapsedMs ?? Number.POSITIVE_INFINITY) ||
    leftMetrics.totalCostUsd - rightMetrics.totalCostUsd ||
    (left.model < right.model ? -1 : left.model > right.model ? 1 : 0)
  );
}

function assertReportCandidateIdentity(report: BlindVisualModelReport): void {
  const candidate = BLIND_VISUAL_CANDIDATES[report.model];
  const probeExact =
    report.probe === null ||
    (report.probe.requestedModel === report.model &&
      report.probe.reportedModel === report.model &&
      report.probe.resolvedModel === report.model &&
      report.probe.provider === "gateway" &&
      report.probe.transport === candidate.transport);
  const runsExact = report.runs.every(
    (run) =>
      run.requestedModel === report.model &&
      run.reportedModel === report.model &&
      run.resolvedModel === report.model &&
      run.provider === "gateway" &&
      run.transport === candidate.transport &&
      run.provenanceExact,
  );
  if (
    report.upstreamModelFamily !== candidate.upstreamModelFamily ||
    report.transport !== candidate.transport ||
    !probeExact ||
    !runsExact
  ) {
    throw new Error(
      `BLIND_VISUAL_STATS_MODEL_PROTOCOL_MISMATCH: ${report.model}`,
    );
  }
}

function assertReportEnvelope(
  report: BlindVisualModelReport,
  canonicalMatrixDefinition: readonly BlindVisualPairDefinition[],
): void {
  assertExecutionProvenance(report.provenance);
  assertMatrixDefinition(report.matrixDefinition);
  assertMatrixDefinition(canonicalMatrixDefinition);
  if (
    report.schemaVersion !== BLIND_VISUAL_CALIBRATION_SCHEMA_VERSION ||
    report.harnessVersion !== BLIND_VISUAL_CALIBRATION_HARNESS_VERSION ||
    report.promptVersion !== BLIND_VISUAL_CALIBRATION_PROMPT_VERSION ||
    report.benchmarkQualification !==
      "deterministic_render_baseline_not_aesthetic_gold" ||
    report.matrixDefinitionSha256 !==
      matrixDefinitionSha256(report.matrixDefinition) ||
    JSON.stringify(report.matrixDefinition) !==
      JSON.stringify(canonicalMatrixDefinition)
  ) {
    throw new Error(
      `BLIND_VISUAL_STATS_REPORT_ENVELOPE_INVALID: ${report.model}`,
    );
  }
}

function comparisonMatrixFingerprint(report: BlindVisualModelReport): string {
  return sha256(
    JSON.stringify({
      schemaVersion: report.schemaVersion,
      harnessVersion: report.harnessVersion,
      promptVersion: report.promptVersion,
      benchmarkQualification: report.benchmarkQualification,
      provenance: report.provenance,
      matrixDefinitionSha256: report.matrixDefinitionSha256,
      runs: [...report.runs]
        .sort((left, right) => left.runKey.localeCompare(right.runKey))
        .map((run) => ({
          runKey: run.runKey,
          pairId: run.pairId,
          familyId: run.familyId,
          attempt: run.attempt,
          knownIssue: run.knownIssue,
          assignment: run.assignment,
          inputImages: run.inputImages,
        })),
    }),
  );
}

function assertComparableReports(
  left: BlindVisualModelReport,
  right: BlindVisualModelReport,
): void {
  if (
    left.provenance.commitSha !== right.provenance.commitSha ||
    left.provenance.sourceBundleSha256 !==
      right.provenance.sourceBundleSha256 ||
    left.matrixDefinitionSha256 !== right.matrixDefinitionSha256 ||
    comparisonMatrixFingerprint(left) !== comparisonMatrixFingerprint(right)
  ) {
    throw new Error(
      `BLIND_VISUAL_STATS_INCOMPATIBLE_REPORTS: ${left.model},${right.model}`,
    );
  }
}

export function summarizeBlindVisualEnsemble(
  reports: readonly BlindVisualModelReport[],
  canonicalMatrixDefinition: readonly BlindVisualPairDefinition[],
): BlindVisualEnsembleSummary {
  for (const report of reports) {
    if (report.status === "unavailable") continue;
    assertReportEnvelope(report, canonicalMatrixDefinition);
    assertReportCandidateIdentity(report);
    if (!report.probe) {
      throw new Error(`BLIND_VISUAL_STATS_PROBE_MISSING: ${report.model}`);
    }
    const recomputed = summarizeBlindVisualCandidate(
      BLIND_VISUAL_CANDIDATES[report.model],
      report.runs,
      report.probe,
      report.matrixDefinition,
      canonicalMatrixDefinition,
    );
    if (
      !report.metrics ||
      JSON.stringify(recomputed) !== JSON.stringify(report.metrics)
    ) {
      throw new Error(`BLIND_VISUAL_STATS_REPORT_MISMATCH: ${report.model}`);
    }
  }
  const passing = reports
    .filter(
      (report) =>
        report.status === "single_model_gate_passed" &&
        report.metrics?.passed === true,
    )
    .sort(comparePassingReports);
  let selected:
    readonly [BlindVisualModelReport, BlindVisualModelReport] | undefined;
  for (let leftIndex = 0; leftIndex < passing.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < passing.length;
      rightIndex += 1
    ) {
      if (
        passing[leftIndex].upstreamModelFamily !==
        passing[rightIndex].upstreamModelFamily
      ) {
        selected = [passing[leftIndex], passing[rightIndex]];
        break;
      }
    }
    if (selected) break;
  }
  if (!selected) {
    return {
      rankedPassingModels: passing.map((report) => report.model),
      combination: null,
    };
  }
  const [left, right] = selected;
  assertComparableReports(left, right);
  const rightByRunKey = new Map(right.runs.map((run) => [run.runKey, run]));
  const commonKnownIssueHits = left.runs.filter((leftRun) => {
    const rightRun = rightByRunKey.get(leftRun.runKey);
    return rightRun ? commonKnownIssueHit(leftRun, rightRun) : false;
  }).length;
  const passed = commonKnownIssueHits >= 17;
  return {
    rankedPassingModels: passing.map((report) => report.model),
    combination: {
      models: [left.model, right.model],
      upstreamModelFamilies: [
        left.upstreamModelFamily,
        right.upstreamModelFamily,
      ],
      commonKnownIssueHits,
      expectedRuns: BLIND_VISUAL_EXPECTED_RUNS,
      passed,
      conclusion: passed
        ? "eligible_for_aesthetic_gold_calibration"
        : "dual_model_common_hit_gate_failed",
    },
  };
}

async function invokeWithDeadline(
  candidate: BlindVisualCandidateConfig,
  request: BlindVisualInvocationRequest,
  invoke: BlindVisualInvoke,
): Promise<BlindVisualProviderResult> {
  const controller = new AbortController();
  const forwarded: BlindVisualInvocationRequest = {
    ...request,
    signal: controller.signal,
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      invoke(forwarded),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new BlindVisualCallRejected("timeout"));
        }, candidate.timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function unavailableReport(
  candidate: BlindVisualCandidateConfig,
  provenance: BlindVisualExecutionProvenance,
  matrixDefinition: BlindVisualPairDefinition[],
  definitionSha256: string,
  reason: BlindVisualUnavailableReason,
  probe: BlindVisualProbeRecord | null,
  runs: BlindVisualCallRecord[],
  failure: BlindVisualFailureRecord,
): BlindVisualModelReport {
  return {
    schemaVersion: BLIND_VISUAL_CALIBRATION_SCHEMA_VERSION,
    harnessVersion: BLIND_VISUAL_CALIBRATION_HARNESS_VERSION,
    promptVersion: BLIND_VISUAL_CALIBRATION_PROMPT_VERSION,
    benchmarkQualification: "deterministic_render_baseline_not_aesthetic_gold",
    model: candidate.model,
    upstreamModelFamily: candidate.upstreamModelFamily,
    transport: candidate.transport,
    limits: {
      probeCalls: 1,
      pairCalls: BLIND_VISUAL_EXPECTED_RUNS,
      timeoutMs: candidate.timeoutMs,
      maxTokens: candidate.maxTokens,
      maxCostCentsPerCall: candidate.maxCostCents,
      maxCostCentsPerModel: candidate.perModelCostBoundCents,
    },
    provenance,
    matrixDefinition,
    matrixDefinitionSha256: definitionSha256,
    status: "unavailable",
    probe,
    runs,
    metrics: null,
    unavailableReason: reason,
    failure,
    conclusion: "unavailable_no_model_selection_claim",
  };
}

function classifyThrown(error: unknown): BlindVisualUnavailableReason {
  return error instanceof BlindVisualCallRejected
    ? error.reason
    : "invocation_failed";
}

function hashUnknownOutput(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? sha256(serialized) : null;
  } catch {
    return null;
  }
}

function failureRecord(input: {
  candidate: BlindVisualCandidateConfig;
  request: BlindVisualInvocationRequest;
  runKey: string | null;
  error: unknown;
  result?: BlindVisualProviderResult;
}): BlindVisualFailureRecord {
  const { candidate, request, result } = input;
  let calculatedCost: number | null = null;
  if (
    result &&
    Number.isInteger(result.usage.inputTokens) &&
    result.usage.inputTokens >= 0 &&
    Number.isInteger(result.usage.outputTokens) &&
    result.usage.outputTokens >= 0
  ) {
    calculatedCost = calculatedCostUsd(candidate, result);
  }
  return {
    phase: request.phase,
    runKey: input.runKey,
    reason: classifyThrown(input.error),
    expectedModel: candidate.model,
    requestedModel: result?.requestedModel ?? null,
    reportedModel: result?.reportedModel ?? null,
    resolvedModel: result?.resolvedModel ?? null,
    provider: result?.provider ?? null,
    expectedTransport: candidate.transport,
    actualTransport: result?.transport ?? null,
    elapsedMs:
      result && Number.isFinite(result.elapsedMs) ? result.elapsedMs : null,
    inputTokens:
      result && Number.isInteger(result.usage.inputTokens)
        ? result.usage.inputTokens
        : null,
    outputTokens:
      result && Number.isInteger(result.usage.outputTokens)
        ? result.usage.outputTokens
        : null,
    reportedCostUsd:
      result?.usage.costUsd !== undefined &&
      result.usage.costUsd !== null &&
      Number.isFinite(result.usage.costUsd)
        ? result.usage.costUsd
        : null,
    calculatedCostUsd: calculatedCost,
    finishReason: result?.finishReason ?? null,
    outputSha256: result ? hashUnknownOutput(result.data) : null,
    inputImages: request.images.map((image, index) => ({
      imageNumber: (index + 1) as 1 | 2 | 3,
      sha256: image.sha256,
      byteLength: image.bytes.byteLength,
      breakpoint: image.target.breakpoint,
    })),
  };
}

export async function runBlindVisualCalibrationCandidate(input: {
  repositoryRoot: string;
  candidate: BlindVisualCandidateConfig;
  provenance: BlindVisualExecutionProvenance;
  invoke: BlindVisualInvoke;
}): Promise<BlindVisualModelReport> {
  const { candidate, provenance, invoke } = input;
  assertCandidateConfig(candidate);
  assertExecutionProvenance(provenance);
  const pairs = await loadBlindVisualPairs(input.repositoryRoot);
  const matrixDefinition = buildBlindVisualMatrixDefinition(pairs);
  const definitionSha256 = matrixDefinitionSha256(matrixDefinition);
  const probePlan = buildBlindVisualProbePlan(candidate, pairs);
  let probe: BlindVisualProbeRecord;
  const runs: BlindVisualCallRecord[] = [];
  let probeResult: BlindVisualProviderResult | undefined;
  try {
    const result = await invokeWithDeadline(
      candidate,
      probePlan.request,
      invoke,
    );
    probeResult = result;
    const validated = assertProviderResult(candidate, result, 3);
    const probeOutput = assertBlindVisualOutput(validated.output, 3);
    if (
      probeOutput.choice !== "tie" ||
      !probeOutput.findings.some(
        (finding) =>
          finding.imageNumber === 3 &&
          finding.ruleCode === probePlan.knownIssue,
      )
    ) {
      throw new BlindVisualCallRejected("probe_failed");
    }
    probe = {
      accepted: true,
      requestedModel: candidate.model,
      reportedModel: result.reportedModel,
      resolvedModel: result.resolvedModel,
      provider: "gateway",
      transport: result.transport,
      elapsedMs: result.elapsedMs,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      reportedCostUsd: validated.reportedCostUsd,
      calculatedCostUsd: validated.calculatedCostUsd,
      accountedCostUsd: validated.accountedCostUsd,
      finishReason: validated.finishReason,
      inputImages: probePlan.request.images.map((image, index) => ({
        imageNumber: (index + 1) as 1 | 2 | 3,
        sha256: image.sha256,
        byteLength: image.bytes.byteLength,
        breakpoint: image.target.breakpoint,
      })),
      output: probeOutput,
    };
  } catch (error) {
    return unavailableReport(
      candidate,
      provenance,
      matrixDefinition,
      definitionSha256,
      classifyThrown(error),
      null,
      runs,
      failureRecord({
        candidate,
        request: probePlan.request,
        runKey: null,
        error,
        result: probeResult,
      }),
    );
  }

  const plans = buildBlindVisualPairPlans(candidate, pairs);
  let activePlan: BlindVisualPairInvocationPlan | undefined;
  let activeResult: BlindVisualProviderResult | undefined;
  try {
    for (const plan of plans) {
      activePlan = plan;
      activeResult = undefined;
      const result = await invokeWithDeadline(candidate, plan.request, invoke);
      activeResult = result;
      const validated = assertProviderResult(candidate, result, 2);
      const output = assertPairOutput(validated.output);
      const semanticChoice = choiceToRole(output.choice, plan.assignment);
      const canonicalFindings = canonicalizeFindings(output, plan.assignment);
      const knownIssueDetected = canonicalFindings.some(
        (finding) =>
          finding.imageRole === "degraded" &&
          finding.ruleCode === plan.knownIssue,
      );
      runs.push({
        runKey: plan.runKey,
        pairId: plan.pairId,
        familyId: plan.familyId,
        attempt: plan.attempt,
        knownIssue: plan.knownIssue,
        assignment: plan.assignment,
        requestedModel: candidate.model,
        reportedModel: result.reportedModel,
        resolvedModel: result.resolvedModel,
        provider: "gateway",
        transport: result.transport,
        elapsedMs: result.elapsedMs,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        reportedCostUsd: validated.reportedCostUsd,
        calculatedCostUsd: validated.calculatedCostUsd,
        accountedCostUsd: validated.accountedCostUsd,
        finishReason: validated.finishReason,
        inputImages: plan.request.images.map((image, index) => ({
          imageNumber: (index + 1) as 1 | 2,
          sha256: image.sha256,
          byteLength: image.bytes.byteLength,
          breakpoint: image.target.breakpoint,
        })),
        output,
        semanticChoice,
        canonicalFindings,
        formatValid: true,
        provenanceExact: true,
        knownIssueDetected,
      });
      activePlan = undefined;
      activeResult = undefined;
    }
  } catch (error) {
    if (!activePlan) throw error;
    return unavailableReport(
      candidate,
      provenance,
      matrixDefinition,
      definitionSha256,
      classifyThrown(error),
      probe,
      runs,
      failureRecord({
        candidate,
        request: activePlan.request,
        runKey: activePlan.runKey,
        error,
        result: activeResult,
      }),
    );
  }
  const metrics = summarizeBlindVisualCandidate(
    candidate,
    runs,
    probe,
    matrixDefinition,
    matrixDefinition,
  );
  if (metrics.totalCostUsd * 100 > candidate.perModelCostBoundCents) {
    return unavailableReport(
      candidate,
      provenance,
      matrixDefinition,
      definitionSha256,
      "cost_bound_exceeded",
      probe,
      runs,
      {
        phase: "pair",
        runKey: null,
        reason: "cost_bound_exceeded",
        expectedModel: candidate.model,
        requestedModel: null,
        reportedModel: null,
        resolvedModel: null,
        provider: null,
        expectedTransport: candidate.transport,
        actualTransport: null,
        elapsedMs: null,
        inputTokens: null,
        outputTokens: null,
        reportedCostUsd: null,
        calculatedCostUsd: null,
        finishReason: null,
        outputSha256: null,
        inputImages: [],
      },
    );
  }
  if (!metrics.passed) {
    return {
      schemaVersion: BLIND_VISUAL_CALIBRATION_SCHEMA_VERSION,
      harnessVersion: BLIND_VISUAL_CALIBRATION_HARNESS_VERSION,
      promptVersion: BLIND_VISUAL_CALIBRATION_PROMPT_VERSION,
      benchmarkQualification:
        "deterministic_render_baseline_not_aesthetic_gold",
      model: candidate.model,
      upstreamModelFamily: candidate.upstreamModelFamily,
      transport: candidate.transport,
      limits: {
        probeCalls: 1,
        pairCalls: BLIND_VISUAL_EXPECTED_RUNS,
        timeoutMs: candidate.timeoutMs,
        maxTokens: candidate.maxTokens,
        maxCostCentsPerCall: candidate.maxCostCents,
        maxCostCentsPerModel: candidate.perModelCostBoundCents,
      },
      provenance,
      matrixDefinition,
      matrixDefinitionSha256: definitionSha256,
      status: "single_model_gate_failed",
      probe,
      runs,
      metrics,
      unavailableReason: null,
      failure: null,
      conclusion: "single_model_gate_failed_no_model_selection_claim",
    };
  }
  return {
    schemaVersion: BLIND_VISUAL_CALIBRATION_SCHEMA_VERSION,
    harnessVersion: BLIND_VISUAL_CALIBRATION_HARNESS_VERSION,
    promptVersion: BLIND_VISUAL_CALIBRATION_PROMPT_VERSION,
    benchmarkQualification: "deterministic_render_baseline_not_aesthetic_gold",
    model: candidate.model,
    upstreamModelFamily: candidate.upstreamModelFamily,
    transport: candidate.transport,
    limits: {
      probeCalls: 1,
      pairCalls: BLIND_VISUAL_EXPECTED_RUNS,
      timeoutMs: candidate.timeoutMs,
      maxTokens: candidate.maxTokens,
      maxCostCentsPerCall: candidate.maxCostCents,
      maxCostCentsPerModel: candidate.perModelCostBoundCents,
    },
    provenance,
    matrixDefinition,
    matrixDefinitionSha256: definitionSha256,
    status: "single_model_gate_passed",
    probe,
    runs,
    metrics,
    unavailableReason: null,
    failure: null,
    conclusion: "single_model_gate_passed",
  };
}
