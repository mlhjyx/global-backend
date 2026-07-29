import { createHash } from "node:crypto";
import {
  validateDesignEvaluationV2,
  validateQualityArtifactSet,
  type DesignEvaluationV2,
  type QualityArtifactRefV1,
  type QualityArtifactSetV1,
} from "@global/contracts";
import {
  PaidCallDeniedError,
  PaidOperationUnknownError,
} from "../site-build-cost-ledger";
import { AiTaskError } from "../agents/ai-task";
import {
  QUALITY_NARRATIVE_SET_V1_SCHEMA_VERSION,
  buildQualityNarrativeFindingIndex,
  canonicalQualityNarrativeJson,
  deterministicQualityNarrativeOutput,
  materializeQualityNarrativeConsumer,
  partitionQualityNarrativeFindings,
  qualityNarrativeTaskInput,
  validateQualityNarrativeTaskOutput,
  type QualityNarrativeConsumerV1,
  type QualityNarrativeEvidenceRefV1,
  type QualityNarrativeFallbackReason,
  type QualityNarrativeModelProvenanceV1,
  type QualityNarrativeSeoReportEvidenceV1,
  type QualityNarrativeSetV1,
  type QualityNarrativeTaskInputV1,
  type QualityNarrativeTaskOutputV1,
} from "./quality-narrative";

const MAX_NARRATIVE_SET_BYTES = 2 * 1024 * 1024;
const MAX_SEO_REPORT_BYTES = 256 * 1024;
const FALLBACK_REASONS = new Set<QualityNarrativeFallbackReason>([
  "empty_findings",
  "consumer_unavailable",
  "paid_gate_denied",
  "model_failed",
  "output_invalid",
  "settlement_unknown",
  "prior_settlement_unknown",
]);

export interface QualityNarrativeStorage {
  head(
    key: string,
    signal?: AbortSignal,
  ): Promise<{ size: number; contentType: string | null } | null>;
  getBufferBounded(
    key: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<Buffer>;
  putBufferImmutable(
    key: string,
    data: Buffer,
    contentType: string,
    sha256: string,
    signal?: AbortSignal,
  ): Promise<"created" | "exists">;
  hashObject(
    key: string,
    signal?: AbortSignal,
  ): Promise<{ sha256: string; size: number }>;
}

export interface QualityNarrativeExecutionResult {
  output: QualityNarrativeTaskOutputV1;
  provenance: QualityNarrativeModelProvenanceV1;
}

export type QualityNarrativeExecutor = (
  input: QualityNarrativeTaskInputV1,
  signal?: AbortSignal,
) => Promise<QualityNarrativeExecutionResult>;

export interface BuildQualityNarrativeInput {
  siteId: string;
  buildRunId: string;
  evaluation: DesignEvaluationV2;
  artifactSet: QualityArtifactSetV1;
  execute?: QualityNarrativeExecutor;
  signal?: AbortSignal;
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("QUALITY_NARRATIVE_CANCELLED");
  }
}

function narrativeObjectKey(input: BuildQualityNarrativeInput): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.siteId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.buildRunId)
  ) {
    throw new Error("QUALITY_NARRATIVE_INVALID: object identity");
  }
  return `sites/${input.siteId}/quality-narratives/${input.buildRunId}/round-${input.evaluation.round}/quality-narrative-set.json`;
}

function checkedBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`QUALITY_NARRATIVE_SEO_REPORT_INVALID: ${field}`);
  }
  return value;
}

function checkedInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`QUALITY_NARRATIVE_SEO_REPORT_INVALID: ${field}`);
  }
  return value as number;
}

function checkedString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new Error(`QUALITY_NARRATIVE_SEO_REPORT_INVALID: ${field}`);
  }
  return value;
}

function parseSeoReport(
  artifact: QualityArtifactRefV1,
  raw: Buffer,
): QualityNarrativeSeoReportEvidenceV1 {
  if (
    artifact.kind !== "seo_report" ||
    artifact.mimeType !== "application/json" ||
    !artifact.target ||
    artifact.target.breakpoint !== undefined ||
    raw.length !== artifact.sizeBytes ||
    sha256Bytes(raw) !== artifact.sha256
  ) {
    throw new Error("QUALITY_NARRATIVE_SEO_REPORT_INVALID: artifact binding");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("QUALITY_NARRATIVE_SEO_REPORT_INVALID: json");
  }
  if (!isRecord(parsed) || !isRecord(parsed.target)) {
    throw new Error("QUALITY_NARRATIVE_SEO_REPORT_INVALID: shape");
  }
  const target = {
    locale: checkedString(parsed.target.locale, "target.locale"),
    pageId: checkedString(parsed.target.pageId, "target.pageId"),
  };
  if (
    target.locale !== artifact.target.locale ||
    target.pageId !== artifact.target.pageId
  ) {
    throw new Error("QUALITY_NARRATIVE_SEO_REPORT_INVALID: target");
  }
  const hreflangs = parsed.hreflangs;
  if (!Array.isArray(hreflangs) || hreflangs.length > 64) {
    throw new Error("QUALITY_NARRATIVE_SEO_REPORT_INVALID: hreflangs");
  }
  const canonical = parsed.canonical;
  const robots = parsed.robots;
  if (
    (canonical !== null && typeof canonical !== "string") ||
    (robots !== null && typeof robots !== "string")
  ) {
    throw new Error("QUALITY_NARRATIVE_SEO_REPORT_INVALID: metadata");
  }
  return {
    artifactId: artifact.artifactId,
    sha256: artifact.sha256,
    target,
    checks: {
      h1Count: checkedInteger(parsed.h1Count, "h1Count"),
      canonicalPresent: typeof canonical === "string" && canonical.length > 0,
      hreflangCount: hreflangs.length,
      previewNoindex:
        typeof robots === "string" &&
        robots
          .split(",")
          .map((token) => token.trim().toLowerCase())
          .includes("noindex"),
      robotsTxtOk: checkedBoolean(parsed.robotsTxtOk, "robotsTxtOk"),
      sitemapOk: checkedBoolean(parsed.sitemapOk, "sitemapOk"),
      jsonLdValid: checkedBoolean(parsed.jsonLdValid, "jsonLdValid"),
      jsonLdUnsupportedFacts: checkedBoolean(
        parsed.jsonLdUnsupportedFacts,
        "jsonLdUnsupportedFacts",
      ),
    },
  };
}

function fallbackConsumer(
  taskInput: QualityNarrativeTaskInputV1,
  fallbackReason: QualityNarrativeFallbackReason,
): QualityNarrativeConsumerV1 {
  return materializeQualityNarrativeConsumer({
    taskInput,
    output: deterministicQualityNarrativeOutput(taskInput),
    mode: "deterministic",
    fallbackReason,
    modelProvenance: null,
  });
}

function validateStoredSet(
  value: unknown,
  input: BuildQualityNarrativeInput,
): QualityNarrativeSetV1 {
  if (
    !isRecord(value) ||
    value.schemaVersion !== QUALITY_NARRATIVE_SET_V1_SCHEMA_VERSION ||
    value.candidateSpecDigest !== input.evaluation.candidateSpecDigest ||
    value.designBriefDigest !== input.evaluation.designBriefDigest ||
    value.artifactSetDigest !== input.artifactSet.artifactSetDigest ||
    value.round !== input.evaluation.round
  ) {
    throw new Error("QUALITY_NARRATIVE_INVALID: checkpoint identity");
  }
  const currentFindings = buildQualityNarrativeFindingIndex(
    input.evaluation,
    input.artifactSet,
  );
  if (
    canonicalQualityNarrativeJson(value.findings) !==
      canonicalQualityNarrativeJson(currentFindings) ||
    !Array.isArray(value.seoReports) ||
    !isRecord(value.qa) ||
    !isRecord(value.seo)
  ) {
    throw new Error("QUALITY_NARRATIVE_INVALID: checkpoint content");
  }
  const partitioned = partitionQualityNarrativeFindings(currentFindings);
  const qaInput = qualityNarrativeTaskInput(
    "site_builder.qa_summarize",
    input.evaluation,
    input.artifactSet,
    partitioned.qa,
    [],
  );
  const seoInput = qualityNarrativeTaskInput(
    "site_builder.seo_review",
    input.evaluation,
    input.artifactSet,
    partitioned.seo,
    value.seoReports as QualityNarrativeSeoReportEvidenceV1[],
  );
  if (value.designEvaluationDigest !== qaInput.designEvaluationDigest) {
    throw new Error("QUALITY_NARRATIVE_INVALID: checkpoint evaluation");
  }
  for (const [consumer, taskInput] of [
    [value.qa, qaInput],
    [value.seo, seoInput],
  ] as const) {
    if (
      consumer.taskId !== taskInput.taskId ||
      (consumer.mode !== "model" && consumer.mode !== "deterministic") ||
      !Array.isArray(consumer.groups)
    ) {
      throw new Error("QUALITY_NARRATIVE_INVALID: checkpoint consumer");
    }
    const output = validateQualityNarrativeTaskOutput(taskInput, {
      groups: consumer.groups.map((group) => {
        if (
          !isRecord(group) ||
          typeof group.groupId !== "string" ||
          !Array.isArray(group.findingIds) ||
          !Array.isArray(group.explanations)
        ) {
          throw new Error("QUALITY_NARRATIVE_INVALID: checkpoint groups");
        }
        return {
          groupId: group.groupId,
          findingIds: group.findingIds,
          explanations: group.explanations.map((explanation) => {
            if (
              !isRecord(explanation) ||
              typeof explanation.findingId !== "string" ||
              typeof explanation.explanationId !== "string"
            ) {
              throw new Error(
                "QUALITY_NARRATIVE_INVALID: checkpoint explanations",
              );
            }
            return {
              findingId: explanation.findingId,
              explanationId: explanation.explanationId,
            };
          }),
        } as QualityNarrativeTaskOutputV1["groups"][number];
      }),
    });
    const deterministic = consumer.mode === "deterministic";
    if (
      (deterministic &&
        (typeof consumer.fallbackReason !== "string" ||
          !FALLBACK_REASONS.has(
            consumer.fallbackReason as QualityNarrativeFallbackReason,
          ) ||
          consumer.modelProvenance !== null)) ||
      (!deterministic &&
        (consumer.fallbackReason !== null ||
          !isRecord(consumer.modelProvenance)))
    ) {
      throw new Error("QUALITY_NARRATIVE_INVALID: checkpoint provenance");
    }
    const materialized = materializeQualityNarrativeConsumer({
      taskInput,
      output,
      mode: consumer.mode,
      fallbackReason:
        consumer.fallbackReason as QualityNarrativeFallbackReason | null,
      modelProvenance:
        consumer.modelProvenance as unknown as QualityNarrativeModelProvenanceV1 | null,
    });
    if (
      canonicalQualityNarrativeJson(materialized) !==
      canonicalQualityNarrativeJson(consumer)
    ) {
      throw new Error("QUALITY_NARRATIVE_INVALID: checkpoint materialization");
    }
  }
  return value as unknown as QualityNarrativeSetV1;
}

export class QualityNarrativeService {
  constructor(private readonly storage: QualityNarrativeStorage) {}

  private async loadCheckpoint(
    key: string,
    input: BuildQualityNarrativeInput,
  ): Promise<QualityNarrativeEvidenceRefV1 | null> {
    const head = await this.storage.head(key, input.signal);
    if (!head) return null;
    if (
      head.contentType !== "application/json" ||
      head.size < 1 ||
      head.size > MAX_NARRATIVE_SET_BYTES
    ) {
      throw new Error("QUALITY_NARRATIVE_INVALID: checkpoint metadata");
    }
    const bytes = await this.storage.getBufferBounded(
      key,
      MAX_NARRATIVE_SET_BYTES,
      input.signal,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("QUALITY_NARRATIVE_INVALID: checkpoint json");
    }
    validateStoredSet(parsed, input);
    const sha256 = sha256Bytes(bytes);
    const actual = await this.storage.hashObject(key, input.signal);
    if (actual.sha256 !== sha256 || actual.size !== bytes.length) {
      throw new Error("QUALITY_NARRATIVE_INVALID: checkpoint hash");
    }
    return {
      schemaVersion: QUALITY_NARRATIVE_SET_V1_SCHEMA_VERSION,
      objectKey: key,
      sha256,
      sizeBytes: bytes.length,
    };
  }

  private async loadSeoReports(
    artifactSet: QualityArtifactSetV1,
    findingArtifactIds: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<QualityNarrativeSeoReportEvidenceV1[]> {
    const artifacts = artifactSet.artifacts
      .filter(
        (artifact) =>
          artifact.kind === "seo_report" &&
          findingArtifactIds.has(artifact.artifactId),
      )
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
    return Promise.all(
      artifacts.map(async (artifact) =>
        parseSeoReport(
          artifact,
          await this.storage.getBufferBounded(
            artifact.objectKey,
            Math.min(MAX_SEO_REPORT_BYTES, artifact.sizeBytes + 1),
            signal,
          ),
        ),
      ),
    );
  }

  private async consume(
    taskInput: QualityNarrativeTaskInputV1,
    execute: QualityNarrativeExecutor | undefined,
    signal?: AbortSignal,
  ): Promise<{
    consumer: QualityNarrativeConsumerV1;
    settlementUnknown: boolean;
  }> {
    assertNotCancelled(signal);
    if (taskInput.findings.length === 0) {
      return {
        consumer: fallbackConsumer(taskInput, "empty_findings"),
        settlementUnknown: false,
      };
    }
    if (!execute) {
      return {
        consumer: fallbackConsumer(taskInput, "consumer_unavailable"),
        settlementUnknown: false,
      };
    }
    try {
      const result = await execute(taskInput, signal);
      assertNotCancelled(signal);
      const output = validateQualityNarrativeTaskOutput(
        taskInput,
        result.output,
      );
      return {
        consumer: materializeQualityNarrativeConsumer({
          taskInput,
          output,
          mode: "model",
          fallbackReason: null,
          modelProvenance: result.provenance,
        }),
        settlementUnknown: false,
      };
    } catch (error) {
      assertNotCancelled(signal);
      if (error instanceof PaidOperationUnknownError) {
        return {
          consumer: fallbackConsumer(taskInput, "settlement_unknown"),
          settlementUnknown: true,
        };
      }
      const reason: QualityNarrativeFallbackReason =
        error instanceof PaidCallDeniedError
          ? "paid_gate_denied"
          : (error instanceof Error &&
                error.message === "QUALITY_NARRATIVE_OUTPUT_INVALID") ||
              (error instanceof AiTaskError &&
                error.attempts.some((attempt) =>
                  attempt.error.includes("QUALITY_NARRATIVE_OUTPUT_INVALID"),
                ))
            ? "output_invalid"
            : "model_failed";
      return {
        consumer: fallbackConsumer(taskInput, reason),
        settlementUnknown: false,
      };
    }
  }

  async build(
    rawInput: BuildQualityNarrativeInput,
  ): Promise<QualityNarrativeEvidenceRefV1> {
    assertNotCancelled(rawInput.signal);
    const artifactSet = validateQualityArtifactSet(rawInput.artifactSet);
    const evaluation = validateDesignEvaluationV2(
      rawInput.evaluation,
      artifactSet,
    );
    const input = { ...rawInput, evaluation, artifactSet };
    const objectKey = narrativeObjectKey(input);
    const checkpoint = await this.loadCheckpoint(objectKey, input);
    if (checkpoint) return checkpoint;

    const findings = buildQualityNarrativeFindingIndex(evaluation, artifactSet);
    const partitioned = partitionQualityNarrativeFindings(findings);
    const seoReports = await this.loadSeoReports(
      artifactSet,
      new Set(partitioned.seo.map((finding) => finding.evidenceArtifactId)),
      input.signal,
    );
    const qaInput = qualityNarrativeTaskInput(
      "site_builder.qa_summarize",
      evaluation,
      artifactSet,
      partitioned.qa,
      [],
    );
    const seoInput = qualityNarrativeTaskInput(
      "site_builder.seo_review",
      evaluation,
      artifactSet,
      partitioned.seo,
      seoReports,
    );
    const qa = await this.consume(qaInput, input.execute, input.signal);
    const seo = qa.settlementUnknown
      ? fallbackConsumer(seoInput, "prior_settlement_unknown")
      : (await this.consume(seoInput, input.execute, input.signal)).consumer;
    assertNotCancelled(input.signal);
    const value: QualityNarrativeSetV1 = {
      schemaVersion: QUALITY_NARRATIVE_SET_V1_SCHEMA_VERSION,
      candidateSpecDigest: evaluation.candidateSpecDigest,
      designBriefDigest: evaluation.designBriefDigest,
      artifactSetDigest: artifactSet.artifactSetDigest,
      designEvaluationDigest: qaInput.designEvaluationDigest,
      round: evaluation.round,
      findings,
      seoReports,
      qa: qa.consumer,
      seo,
    };
    const bytes = Buffer.from(canonicalQualityNarrativeJson(value), "utf8");
    if (bytes.length > MAX_NARRATIVE_SET_BYTES) {
      throw new Error("QUALITY_NARRATIVE_INVALID: checkpoint size");
    }
    const digest = sha256Bytes(bytes);
    const written = await this.storage.putBufferImmutable(
      objectKey,
      bytes,
      "application/json",
      digest,
      input.signal,
    );
    if (written === "exists") {
      const winner = await this.loadCheckpoint(objectKey, input);
      if (!winner) {
        throw new Error("QUALITY_NARRATIVE_INVALID: checkpoint ACK loss");
      }
      return winner;
    }
    return {
      schemaVersion: QUALITY_NARRATIVE_SET_V1_SCHEMA_VERSION,
      objectKey,
      sha256: digest,
      sizeBytes: bytes.length,
    };
  }
}
