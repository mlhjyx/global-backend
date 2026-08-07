import { createHash } from "node:crypto";
import {
  getDurableModelExecutionAttestation,
  getTrustedModelExecutionMetadata,
  type ModelExecutionEvidenceClass,
  type ModelExecutionResult,
} from "../../model-runtime";
import type { CopyTaskOutput } from "../agents/copy";
import { copySlotContentMode } from "../copy-bundle.service";
import {
  COPY_ASSEMBLY_EVAL_FIXTURES,
  evaluateCopyAssemblyOutput,
  type PreparedCopyAssemblyEvalFixture,
} from "./copy-assembly-eval";
import { COPY_EVALUATION_V2_CANDIDATES } from "./copy-evaluation-v2-candidates";
import {
  COPY_QUALITY_FINDING_PENALTIES,
  COPY_QUALITY_GATE,
  COPY_QUALITY_REVIEW_SCHEMA_VERSION,
  COPY_QUALITY_REVIEWED_DIMENSIONS,
  COPY_QUALITY_RUBRIC_VERSION,
  COPY_QUALITY_SCORED_DIMENSIONS,
  type CopyQualityReviewedDimension,
  type CopyQualityScoredDimension,
} from "./copy-quality-rubric";

interface CopyQualityFinding {
  dimension: CopyQualityReviewedDimension;
  slotKey: string;
  code: string;
}

interface CopyQualityReview {
  schemaVersion: typeof COPY_QUALITY_REVIEW_SCHEMA_VERSION;
  rubricVersion: typeof COPY_QUALITY_RUBRIC_VERSION;
  fixtureId: string;
  repeatIndex: 0 | 1;
  executionId: string;
  outputDigest: string;
  reviewer: {
    kind: "human_blind" | "independent_model";
    identityDigest: string;
    providerFamily: "openai" | "anthropic" | null;
  };
  findings: CopyQualityFinding[];
}

type CopyQualityProviderFamily = "openai" | "anthropic";

export interface CopyQualityExecutionReceipt {
  candidateAlias: string;
  providerFamily: CopyQualityProviderFamily;
  fixtureId: string;
  repeatIndex: 0 | 1;
  executionId: string;
  outputDigest: string;
  evidenceClass: ModelExecutionEvidenceClass;
  ledgerDigest: string;
}

export interface CopyQualityDimensionOutcome {
  applicable: boolean;
  score: number | null;
  findingCodes: readonly string[];
}

export interface CopyQualityReviewOutcome {
  hardGatePassed: true;
  fixtureId: string;
  repeatIndex: 0 | 1;
  executionId: string;
  candidateAlias: string;
  outputDigest: string;
  evidenceClass: ModelExecutionEvidenceClass;
  ledgerDigest: string;
  reviewDigest: string;
  dimensions: Record<CopyQualityReviewedDimension, CopyQualityDimensionOutcome>;
}

export interface CopyRepeatStabilityOutcome {
  candidateAlias: string;
  fixtureId: string;
  repeatPair: "0/1";
  executionIds: readonly [string, string];
  outputDigests: readonly [string, string];
  evidenceClass: ModelExecutionEvidenceClass;
  ledgerDigests: readonly [string, string];
  applicable: boolean;
  score: number | null;
  slotScores: Readonly<Record<string, number>>;
}

const TRUSTED_REVIEW_OUTCOMES = new WeakSet<object>();
const TRUSTED_STABILITY_OUTCOMES = new WeakSet<object>();
const TRUSTED_EXECUTION_RECEIPTS = new WeakSet<object>();
const EXECUTION_RECEIPT_DETAILS = new WeakMap<
  object,
  {
    prepared: PreparedCopyAssemblyEvalFixture;
    output: CopyTaskOutput;
  }
>();
export const COPY_QUALITY_EXPECTED_REVIEWS_PER_CANDIDATE =
  COPY_ASSEMBLY_EVAL_FIXTURES.length * 2;
export const COPY_QUALITY_EXPECTED_STABILITY_PAIRS_PER_CANDIDATE =
  COPY_ASSEMBLY_EVAL_FIXTURES.length;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.every((key) => typeof key === "string") &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  );
}

function normalizeExactJson(
  value: unknown,
  path = "$",
  ancestors = new Set<object>(),
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) reviewError(`NON_JSON:${path}`);
    return value;
  }
  if (typeof value !== "object") reviewError(`NON_JSON:${path}`);
  if (ancestors.has(value)) reviewError(`NON_JSON:${path}:cycle`);
  const nextAncestors = new Set(ancestors).add(value);

  if (Array.isArray(value)) {
    const expectedKeys = [
      ...Array.from({ length: value.length }, (_, index) => String(index)),
      "length",
    ];
    const actualKeys = Reflect.ownKeys(value);
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])
    ) {
      reviewError(`NON_JSON:${path}`);
    }
    return expectedKeys.slice(0, -1).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        reviewError(`NON_JSON:${path}.${key}`);
      }
      return normalizeExactJson(
        descriptor.value,
        `${path}[${key}]`,
        nextAncestors,
      );
    });
  }

  const normalized: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") reviewError(`NON_JSON:${path}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      reviewError(`NON_JSON:${path}.${key}`);
    }
    normalized[key] = normalizeExactJson(
      descriptor.value,
      `${path}.${key}`,
      nextAncestors,
    );
  }
  return normalized;
}

function reviewError(code: string): never {
  throw new Error(`COPY_QUALITY_REVIEW_${code}`);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

export function copyQualityOutputDigest(output: CopyTaskOutput): string {
  return sha256(canonicalJson(output));
}

export function observeCopyQualityExecution(input: {
  prepared: PreparedCopyAssemblyEvalFixture;
  result: ModelExecutionResult<CopyTaskOutput>;
  repeatIndex: 0 | 1;
}): CopyQualityExecutionReceipt {
  const metadata = getTrustedModelExecutionMetadata(input.result);
  const durable = getDurableModelExecutionAttestation(input.result);
  if (!metadata) reviewError("RUNTIME_RESULT_UNTRUSTED");
  if (!durable) reviewError("DURABLE_EXECUTION_UNTRUSTED");
  const candidate = COPY_EVALUATION_V2_CANDIDATES.find(
    (entry) =>
      entry.alias === metadata.resolvedAlias &&
      entry.protocol === metadata.protocol,
  );
  if (!candidate) reviewError("CANDIDATE_NOT_ADMITTED");
  if (
    metadata.taskId !== "site_builder.copy" ||
    metadata.taskVersion !==
      "site-builder-task-contract/site_builder.copy/v2" ||
    metadata.requestedAlias !== metadata.resolvedAlias ||
    metadata.reasoning !== candidate.reasoning ||
    metadata.cacheMode !== "disabled" ||
    metadata.settlement !== "known" ||
    metadata.cacheHit ||
    durable.executionId !== metadata.executionId ||
    durable.outputDigest !== metadata.outputDigest ||
    durable.wireCount !== input.result.transportAttempts ||
    !input.result.states.includes("settled") ||
    input.result.states.at(-1) !== "completed" ||
    copyQualityOutputDigest(input.result.output) !== metadata.outputDigest
  ) {
    reviewError("RUNTIME_RESULT_INADMISSIBLE");
  }
  if (![0, 1].includes(input.repeatIndex)) reviewError("REPEAT_INVALID");
  const output = structuredClone(input.result.output);
  evaluateCopyAssemblyOutput(input.prepared, output);
  const receipt = Object.freeze({
    candidateAlias: candidate.alias,
    providerFamily: candidate.providerFamily,
    fixtureId: input.prepared.fixture.fixtureId,
    repeatIndex: input.repeatIndex,
    executionId: sha256(metadata.executionId),
    outputDigest: copyQualityOutputDigest(output),
    evidenceClass: durable.evidenceClass,
    ledgerDigest: durable.ledgerDigest,
  });
  TRUSTED_EXECUTION_RECEIPTS.add(receipt);
  EXECUTION_RECEIPT_DETAILS.set(receipt, {
    prepared: input.prepared,
    output: deepFreeze(output),
  });
  return receipt;
}

function applicableSlots(
  prepared: PreparedCopyAssemblyEvalFixture,
): Record<CopyQualityReviewedDimension, ReadonlySet<string>> {
  const creative = prepared.input.slots
    .filter((slot) => copySlotContentMode(slot) === "creative_non_factual")
    .map((slot) => slot.key);
  const cta = prepared.input.slots
    .filter((slot) => copySlotContentMode(slot) === "cta_allowlist")
    .map((slot) => slot.key);
  const localized =
    prepared.input.locale === prepared.input.sourceLocale
      ? []
      : [...creative, ...cta];
  return {
    language_quality: new Set(creative),
    brand_voice: new Set(creative),
    cta_quality: new Set(cta),
    cross_locale_quality: new Set(localized),
  };
}

function parseReview(value: unknown): CopyQualityReview {
  const normalized = normalizeExactJson(value);
  if (
    !normalized ||
    typeof normalized !== "object" ||
    Array.isArray(normalized)
  ) {
    return reviewError("SHAPE_INVALID");
  }
  if (
    !exactKeys(normalized, [
      "schemaVersion",
      "rubricVersion",
      "fixtureId",
      "repeatIndex",
      "executionId",
      "outputDigest",
      "reviewer",
      "findings",
    ])
  ) {
    return reviewError("SHAPE_INVALID");
  }
  const review = normalized as unknown as CopyQualityReview;
  if (
    review.schemaVersion !== COPY_QUALITY_REVIEW_SCHEMA_VERSION ||
    review.rubricVersion !== COPY_QUALITY_RUBRIC_VERSION ||
    typeof review.fixtureId !== "string" ||
    ![0, 1].includes(review.repeatIndex) ||
    !/^[0-9a-f]{64}$/u.test(review.executionId) ||
    !/^[0-9a-f]{64}$/u.test(review.outputDigest)
  ) {
    return reviewError("IDENTITY_INVALID");
  }
  if (
    !review.reviewer ||
    typeof review.reviewer !== "object" ||
    Array.isArray(review.reviewer) ||
    !exactKeys(review.reviewer, ["kind", "identityDigest", "providerFamily"]) ||
    !["human_blind", "independent_model"].includes(review.reviewer.kind) ||
    !/^[0-9a-f]{64}$/u.test(review.reviewer.identityDigest) ||
    (review.reviewer.kind === "human_blind" &&
      review.reviewer.providerFamily !== null) ||
    (review.reviewer.kind === "independent_model" &&
      !["openai", "anthropic"].includes(review.reviewer.providerFamily ?? ""))
  ) {
    return reviewError("REVIEWER_INVALID");
  }
  if (!Array.isArray(review.findings) || review.findings.length > 64) {
    return reviewError("FINDINGS_INVALID");
  }
  return review;
}

function findingOrder(finding: CopyQualityFinding): string {
  const dimension = COPY_QUALITY_REVIEWED_DIMENSIONS.indexOf(finding.dimension);
  return `${String(dimension).padStart(2, "0")}/${finding.slotKey}/${finding.code}`;
}

function validateFindings(
  review: CopyQualityReview,
  slots: Record<CopyQualityReviewedDimension, ReadonlySet<string>>,
): void {
  const seen = new Set<string>();
  let previous = "";
  for (const finding of review.findings) {
    if (
      !finding ||
      typeof finding !== "object" ||
      Array.isArray(finding) ||
      !exactKeys(finding, ["dimension", "slotKey", "code"]) ||
      !COPY_QUALITY_REVIEWED_DIMENSIONS.includes(finding.dimension) ||
      typeof finding.slotKey !== "string" ||
      typeof finding.code !== "string"
    ) {
      reviewError("FINDING_INVALID");
    }
    const catalog = COPY_QUALITY_FINDING_PENALTIES[finding.dimension] as Record<
      string,
      number
    >;
    if (!Object.hasOwn(catalog, finding.code)) {
      reviewError("FINDING_CODE_INVALID");
    }
    if (!slots[finding.dimension].has(finding.slotKey)) {
      reviewError("FINDING_SLOT_INVALID");
    }
    const order = findingOrder(finding);
    if (order <= previous || seen.has(order)) {
      reviewError("FINDINGS_ORDER_INVALID");
    }
    previous = order;
    seen.add(order);
  }
}

export function evaluateCopyQualityReview(
  receipt: CopyQualityExecutionReceipt,
  reviewValue: unknown,
): CopyQualityReviewOutcome {
  if (!TRUSTED_EXECUTION_RECEIPTS.has(receipt)) {
    reviewError("EXECUTION_UNTRUSTED");
  }
  const details = EXECUTION_RECEIPT_DETAILS.get(receipt);
  if (!details) reviewError("EXECUTION_UNTRUSTED");
  const review = parseReview(reviewValue);
  if (
    review.reviewer.kind === "independent_model" &&
    review.reviewer.providerFamily === receipt.providerFamily
  ) {
    reviewError("REVIEWER_PROVIDER_CONFLICT");
  }
  if (
    review.fixtureId !== receipt.fixtureId ||
    review.repeatIndex !== receipt.repeatIndex ||
    review.executionId !== receipt.executionId ||
    review.outputDigest !== receipt.outputDigest
  ) {
    reviewError("IDENTITY_DRIFT");
  }
  const slots = applicableSlots(details.prepared);
  validateFindings(review, slots);

  const dimensions = Object.fromEntries(
    COPY_QUALITY_REVIEWED_DIMENSIONS.map((dimension) => {
      const findings = review.findings.filter(
        (finding) => finding.dimension === dimension,
      );
      const penalties = COPY_QUALITY_FINDING_PENALTIES[dimension] as Record<
        string,
        number
      >;
      const applicable = slots[dimension].size > 0;
      return [
        dimension,
        {
          applicable,
          score: applicable
            ? Math.max(
                COPY_QUALITY_GATE.scaleMinimum,
                COPY_QUALITY_GATE.scaleMaximum -
                  findings.reduce(
                    (sum, finding) => sum + penalties[finding.code]!,
                    0,
                  ),
              )
            : null,
          findingCodes: Object.freeze(findings.map((finding) => finding.code)),
        },
      ];
    }),
  ) as unknown as CopyQualityReviewOutcome["dimensions"];

  const outcome = {
    hardGatePassed: true,
    candidateAlias: receipt.candidateAlias,
    fixtureId: receipt.fixtureId,
    repeatIndex: receipt.repeatIndex,
    executionId: receipt.executionId,
    outputDigest: receipt.outputDigest,
    evidenceClass: receipt.evidenceClass,
    ledgerDigest: receipt.ledgerDigest,
    reviewDigest: sha256(canonicalJson(review)),
    dimensions,
  } as const;
  const frozenOutcome = deepFreeze(outcome);
  TRUSTED_REVIEW_OUTCOMES.add(frozenOutcome);
  return frozenOutcome;
}

function normalizedTokens(value: string, locale: string): string[] {
  return (
    value
      .normalize("NFKC")
      .toLocaleLowerCase(locale)
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function stabilityScore(left: string, right: string, locale: string): number {
  const leftTokens = normalizedTokens(left, locale);
  const rightTokens = normalizedTokens(right, locale);
  if (leftTokens.join(" ") === rightTokens.join(" ")) return 4;
  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  const intersection = [...leftSet].filter((token) =>
    rightSet.has(token),
  ).length;
  const similarity =
    leftSet.size + rightSet.size === 0
      ? 0
      : (2 * intersection) / (leftSet.size + rightSet.size);
  if (similarity >= 0.8) return 3;
  if (similarity >= 0.6) return 2;
  if (similarity >= 0.4) return 1;
  return 0;
}

export function evaluateCopyRepeatStability(
  first: CopyQualityExecutionReceipt,
  second: CopyQualityExecutionReceipt,
): CopyRepeatStabilityOutcome {
  if (
    !TRUSTED_EXECUTION_RECEIPTS.has(first) ||
    !TRUSTED_EXECUTION_RECEIPTS.has(second)
  ) {
    reviewError("STABILITY_EXECUTION_UNTRUSTED");
  }
  const firstDetails = EXECUTION_RECEIPT_DETAILS.get(first);
  const secondDetails = EXECUTION_RECEIPT_DETAILS.get(second);
  if (!firstDetails || !secondDetails) {
    reviewError("STABILITY_EXECUTION_UNTRUSTED");
  }
  if (
    first.candidateAlias !== second.candidateAlias ||
    first.fixtureId !== second.fixtureId ||
    first.repeatIndex !== 0 ||
    second.repeatIndex !== 1 ||
    first.executionId === second.executionId ||
    first.evidenceClass !== second.evidenceClass
  ) {
    reviewError("STABILITY_IDENTITY_INVALID");
  }
  const prepared = firstDetails.prepared;
  const slotKeys = prepared.input.slots
    .filter((slot) => {
      const mode = copySlotContentMode(slot);
      return mode === "creative_non_factual" || mode === "cta_allowlist";
    })
    .map((slot) => slot.key);
  const slotScores = Object.fromEntries(
    slotKeys.map((slotKey) => [
      slotKey,
      stabilityScore(
        String(firstDetails.output.slots[slotKey]!.content),
        String(secondDetails.output.slots[slotKey]!.content),
        prepared.input.locale,
      ),
    ]),
  );
  const scores = Object.values(slotScores);
  const outcome = {
    candidateAlias: first.candidateAlias,
    fixtureId: first.fixtureId,
    repeatPair: "0/1" as const,
    executionIds: [first.executionId, second.executionId] as const,
    outputDigests: [first.outputDigest, second.outputDigest] as const,
    evidenceClass: first.evidenceClass,
    ledgerDigests: [first.ledgerDigest, second.ledgerDigest] as const,
    applicable: scores.length > 0,
    score:
      scores.length === 0
        ? null
        : Math.round(
            (scores.reduce((sum, score) => sum + score, 0) / scores.length) *
              100,
          ) / 100,
    slotScores,
  };
  const frozenOutcome = deepFreeze(outcome);
  TRUSTED_STABILITY_OUTCOMES.add(frozenOutcome);
  return frozenOutcome;
}

export function aggregateCopyCandidateQuality(input: {
  candidateAlias: string;
  reviews: readonly CopyQualityReviewOutcome[];
  stability: readonly CopyRepeatStabilityOutcome[];
  hardGateFailures: number;
}) {
  if (
    !COPY_EVALUATION_V2_CANDIDATES.some(
      (candidate) => candidate.alias === input.candidateAlias,
    )
  ) {
    throw new Error("COPY_QUALITY_AGGREGATE_CANDIDATE_NOT_ADMITTED");
  }
  if (
    input.reviews.some((review) => !TRUSTED_REVIEW_OUTCOMES.has(review)) ||
    input.stability.some(
      (stability) => !TRUSTED_STABILITY_OUTCOMES.has(stability),
    )
  ) {
    throw new Error("COPY_QUALITY_AGGREGATE_UNTRUSTED_OUTCOME");
  }
  const blockers = new Set<string>();
  if (
    input.reviews.some(
      (review) => review.candidateAlias !== input.candidateAlias,
    ) ||
    input.stability.some(
      (stability) => stability.candidateAlias !== input.candidateAlias,
    )
  ) {
    blockers.add("CANDIDATE_IDENTITY_MISMATCH");
  }
  if (!Number.isInteger(input.hardGateFailures) || input.hardGateFailures < 0) {
    throw new Error("COPY_QUALITY_AGGREGATE_HARD_GATE_COUNT_INVALID");
  }
  if (input.reviews.length !== COPY_QUALITY_EXPECTED_REVIEWS_PER_CANDIDATE) {
    blockers.add("INCOMPLETE_REVIEW_COVERAGE");
  }
  if (
    input.stability.length !==
    COPY_QUALITY_EXPECTED_STABILITY_PAIRS_PER_CANDIDATE
  ) {
    blockers.add("INCOMPLETE_STABILITY_COVERAGE");
  }
  const reviewCoverage = new Map<string, number>();
  const executionIds = new Set<string>();
  for (const review of input.reviews) {
    const coverageKey = `${review.fixtureId}/${review.repeatIndex}`;
    reviewCoverage.set(coverageKey, (reviewCoverage.get(coverageKey) ?? 0) + 1);
    if (executionIds.has(review.executionId)) {
      blockers.add("DUPLICATE_EXECUTION_IDENTITY");
    }
    executionIds.add(review.executionId);
  }
  if (
    COPY_ASSEMBLY_EVAL_FIXTURES.some((fixture) =>
      ([0, 1] as const).some(
        (repeatIndex) =>
          reviewCoverage.get(`${fixture.fixtureId}/${repeatIndex}`) !== 1,
      ),
    ) ||
    [...reviewCoverage].some(
      ([coverageKey]) =>
        !COPY_ASSEMBLY_EVAL_FIXTURES.some(
          (fixture) =>
            coverageKey === `${fixture.fixtureId}/0` ||
            coverageKey === `${fixture.fixtureId}/1`,
        ),
    )
  ) {
    blockers.add("INCOMPLETE_REVIEW_COVERAGE");
  }
  const stabilityCoverage = new Map<string, number>();
  for (const stability of input.stability) {
    stabilityCoverage.set(
      stability.fixtureId,
      (stabilityCoverage.get(stability.fixtureId) ?? 0) + 1,
    );
  }
  if (
    COPY_ASSEMBLY_EVAL_FIXTURES.some(
      (fixture) => stabilityCoverage.get(fixture.fixtureId) !== 1,
    ) ||
    [...stabilityCoverage].some(
      ([fixtureId]) =>
        !COPY_ASSEMBLY_EVAL_FIXTURES.some(
          (fixture) => fixture.fixtureId === fixtureId,
        ),
    )
  ) {
    blockers.add("INCOMPLETE_STABILITY_COVERAGE");
  }
  const reviewsByCoverage = new Map(
    input.reviews.map((review) => [
      `${review.fixtureId}/${review.repeatIndex}`,
      review,
    ]),
  );
  for (const stability of input.stability) {
    const first = reviewsByCoverage.get(`${stability.fixtureId}/0`);
    const second = reviewsByCoverage.get(`${stability.fixtureId}/1`);
    if (
      !first ||
      !second ||
      stability.executionIds[0] !== first.executionId ||
      stability.executionIds[1] !== second.executionId ||
      stability.outputDigests[0] !== first.outputDigest ||
      stability.outputDigests[1] !== second.outputDigest
    ) {
      blockers.add("STABILITY_REVIEW_IDENTITY_MISMATCH");
    }
  }
  if (
    input.hardGateFailures > 0 ||
    input.reviews.some((review) => !review.hardGatePassed)
  ) {
    blockers.add("HARD_GATE_FAILURE");
  }
  const observations = Object.fromEntries(
    COPY_QUALITY_SCORED_DIMENSIONS.map((dimension) => [
      dimension,
      [] as number[],
    ]),
  ) as Record<CopyQualityScoredDimension, number[]>;
  for (const review of input.reviews) {
    for (const dimension of COPY_QUALITY_REVIEWED_DIMENSIONS) {
      const observation = review.dimensions[dimension];
      if (observation.applicable && observation.score !== null) {
        observations[dimension].push(observation.score);
      }
    }
  }
  for (const stability of input.stability) {
    if (stability.applicable && stability.score !== null) {
      observations.stability.push(stability.score);
    }
  }
  const dimensions = Object.fromEntries(
    COPY_QUALITY_SCORED_DIMENSIONS.map((dimension) => {
      const scores = observations[dimension];
      if (scores.length === 0) blockers.add("MISSING_DIMENSION_COVERAGE");
      if (
        scores.some((score) => score < COPY_QUALITY_GATE.observationMinimum)
      ) {
        blockers.add("OBSERVATION_BELOW_MINIMUM");
      }
      const mean =
        scores.length === 0
          ? null
          : Math.round(
              (scores.reduce((sum, score) => sum + score, 0) / scores.length) *
                100,
            ) / 100;
      if (mean !== null && mean < COPY_QUALITY_GATE.dimensionMeanMinimum) {
        blockers.add("MEAN_BELOW_MINIMUM");
      }
      return [dimension, { observations: scores.length, mean }];
    }),
  );
  const scoredQualityGatePassed = blockers.size === 0;
  // Current outcomes are process-local scoring artifacts. Promotion remains
  // blocked until a restart-safe adapter reopens the accepted ledger, consumes
  // the Git acceptance once, and verifies persisted output bytes by digest.
  blockers.add("DURABLE_ACCEPTED_ARTIFACT_REPLAY_REQUIRED");
  return deepFreeze({
    scoredQualityGatePassed,
    qualityGatePassed: blockers.size === 0,
    blockers: [...blockers].sort(),
    dimensions,
    promotionDecision: COPY_QUALITY_GATE.promotionDecision,
    routeAdoptionAuthorized: COPY_QUALITY_GATE.routeAdoptionAuthorized,
  });
}
