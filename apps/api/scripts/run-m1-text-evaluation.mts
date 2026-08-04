import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { COPY_TASK } from "../src/site-builder/agents/copy";
import {
  ASSEMBLE_TASK,
  ASSEMBLY_FIX_TASK,
} from "../src/site-builder/agents/controlled-assembly";
import type { SiteBuilderTaskId } from "../src/site-builder/agents/task-route-bindings";
import { DESIGN_SPEC_TASK } from "../src/site-builder/design/design-brief-producer";
import {
  QA_SUMMARIZE_TASK,
  SEO_REVIEW_TASK,
} from "../src/site-builder/quality/quality-narrative";
import {
  assessCanonicalTaskArtifact,
  buildCanonicalModelEvaluationCase,
  buildTaskEvaluationPlan,
} from "../src/site-builder/eval/model-evaluation-harness";
import {
  createCredentialBoundModelEvaluationWireClient,
  repairPrompt,
  structuredSystemPrompt,
} from "../src/site-builder/eval/model-evaluation-executor";
import { sha256CanonicalJson } from "../src/site-builder/eval/eval-provenance";
import { writeRepositoryJsonCreateOnly } from "../src/site-builder/eval/create-only-json";
import type {
  M1TextEvaluationCandidateSummary,
  M1TextEvaluationExecution,
  M1TextEvaluationPlan,
  M1TextEvaluationResult,
  M1TextEvaluationTaskId,
  NativeProtocol,
  NativeTextResponse,
} from "./run-m1-text-evaluation.types";

const DESIGN_SPEC_MANIFEST_SHA256 =
  "1a74fab9ac803bfc50636fdb51ab7ac1b04623a8053c8d17a37a60294c99facd";
const REMAINING_TEXT_MANIFEST_SHA256 =
  "c10baa88044085f89e32075f4099605c53981dda57ff557a16cf8c3edaa7b87f";
const RETIRED_ALIASES = new Set([
  "minimax-m3",
  "doubao-seed-2.0-pro",
  "doubao-seed-2.0-lite",
]);
const TASK_EXECUTION_COUNTS = Object.freeze({
  "site_builder.design_spec": 73,
  "site_builder.copy": 13,
  "site_builder.assemble": 48,
  "site_builder.assembly_fix": 48,
  "site_builder.qa_summarize": 12,
  "site_builder.seo_review": 12,
} as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function invalid(): never {
  throw new Error("M1 text evaluation manifest is invalid");
}

function assertManifestDigest(
  value: Record<string, unknown>,
  expected: string,
): void {
  const { manifestSha256, ...unsigned } = value;
  if (
    manifestSha256 !== expected ||
    sha256CanonicalJson(unsigned) !== expected
  ) {
    return invalid();
  }
}

function currentSourceBundleSha256(task: M1TextEvaluationTaskId): string {
  const plan = buildTaskEvaluationPlan(task);
  const fixtureId = plan.evaluationSuite?.fixtureIds[0];
  if (!fixtureId) return invalid();
  return buildCanonicalModelEvaluationCase(plan, fixtureId).contract
    .sourceBundleSha256;
}

function taskId(value: unknown): M1TextEvaluationTaskId {
  if (
    typeof value !== "string" ||
    !Object.hasOwn(TASK_EXECUTION_COUNTS, value)
  ) {
    return invalid();
  }
  return value as M1TextEvaluationTaskId;
}

function nativeProtocol(value: unknown): NativeProtocol {
  if (value !== "openai-responses" && value !== "anthropic-messages") {
    return invalid();
  }
  return value;
}

function execution(
  value: unknown,
  expectedTaskId: M1TextEvaluationTaskId,
  ordinal: number,
): M1TextEvaluationExecution {
  if (!isRecord(value)) return invalid();
  const kind = value.kind;
  const alias = value.alias;
  const fixtureId = value.fixtureId;
  const attempt = value.attempt;
  const protocol = nativeProtocol(value.protocol);
  if (
    value.ordinal !== ordinal ||
    (kind !== "capability_probe" && kind !== "target") ||
    typeof alias !== "string" ||
    RETIRED_ALIASES.has(alias) ||
    typeof fixtureId !== "string" ||
    !Number.isSafeInteger(attempt) ||
    (attempt as number) < 1 ||
    value.maximumWireCalls !== 2 ||
    value.maximumRepairCalls !== 1 ||
    value.executionKey !== [kind, alias, protocol, fixtureId, attempt].join("/")
  ) {
    return invalid();
  }
  const plan = buildTaskEvaluationPlan(expectedTaskId as SiteBuilderTaskId);
  const suite = plan.evaluationSuite;
  const candidate = plan.candidates.find(
    (entry) => entry.alias === alias && entry.expectedProtocol === protocol,
  );
  if (
    plan.dispatchAdmission !== "task_evaluation_ready" ||
    !suite ||
    !suite.fixtureIds.includes(fixtureId) ||
    !candidate ||
    (kind === "capability_probe" &&
      candidate.preflight !== "capability_probe") ||
    (kind === "target" && (attempt as number) > suite.repeats) ||
    (kind === "capability_probe" && attempt !== 1)
  ) {
    return invalid();
  }
  return Object.freeze({
    ordinal,
    taskId: expectedTaskId,
    executionKey: value.executionKey,
    kind,
    alias,
    protocol,
    fixtureId,
    attempt: attempt as number,
    maximumWireCalls: 2,
    maximumRepairCalls: 1,
  });
}

function manifestTaskExecutions(
  value: unknown,
  expectedTaskId: M1TextEvaluationTaskId,
): readonly M1TextEvaluationExecution[] {
  if (!isRecord(value) || value.taskId !== expectedTaskId) return invalid();
  const expectedCount = TASK_EXECUTION_COUNTS[expectedTaskId];
  if (
    value.executionCount !== expectedCount ||
    value.maximumWireCallCount !== expectedCount * 2 ||
    !Array.isArray(value.executions) ||
    value.executions.length !== expectedCount
  ) {
    return invalid();
  }
  return Object.freeze(
    value.executions.map((entry, index) =>
      execution(entry, expectedTaskId, index + 1),
    ),
  );
}

function assertExactTaskMatrix(
  taskId: M1TextEvaluationTaskId,
  executions: readonly M1TextEvaluationExecution[],
): void {
  const plan = buildTaskEvaluationPlan(taskId);
  const suite = plan.evaluationSuite;
  if (!suite) return invalid();
  const expected = new Set<string>();
  for (const candidate of plan.candidates) {
    if (candidate.preflight === "capability_probe") {
      expected.add(
        [
          "capability_probe",
          candidate.alias,
          candidate.expectedProtocol,
          suite.fixtureIds[0],
          1,
        ].join("/"),
      );
    }
    for (const fixtureId of suite.fixtureIds) {
      for (let attempt = 1; attempt <= suite.repeats; attempt += 1) {
        expected.add(
          [
            "target",
            candidate.alias,
            candidate.expectedProtocol,
            fixtureId,
            attempt,
          ].join("/"),
        );
      }
    }
  }
  if (
    expected.size !== executions.length ||
    executions.some(({ executionKey }) => !expected.delete(executionKey)) ||
    expected.size !== 0
  ) {
    return invalid();
  }
}

export function buildM1TextEvaluationPlan(input: {
  designSpecManifest: unknown;
  remainingTextManifest: unknown;
}): M1TextEvaluationPlan {
  const design = input?.designSpecManifest;
  const remaining = input?.remainingTextManifest;
  if (
    !isRecord(design) ||
    design.taskId !== "site_builder.design_spec" ||
    design.manifestSha256 !== DESIGN_SPEC_MANIFEST_SHA256 ||
    design.executionCount !== 73 ||
    design.maximumWireCallCount !== 146 ||
    !isRecord(remaining) ||
    remaining.manifestSha256 !== REMAINING_TEXT_MANIFEST_SHA256 ||
    remaining.executionCount !== 133 ||
    remaining.maximumWireCallCount !== 266 ||
    !Array.isArray(remaining.taskIds) ||
    !Array.isArray(remaining.tasks) ||
    remaining.tasks.length !== 5
  ) {
    return invalid();
  }
  assertManifestDigest(design, DESIGN_SPEC_MANIFEST_SHA256);
  assertManifestDigest(remaining, REMAINING_TEXT_MANIFEST_SHA256);
  if (
    typeof design.fixedCommitSha !== "string" ||
    !/^[a-f0-9]{40}$/.test(design.fixedCommitSha) ||
    !isRecord(design.suite) ||
    design.suite.sourceBundleSha256 !==
      currentSourceBundleSha256("site_builder.design_spec") ||
    typeof remaining.fixedCommitSha !== "string" ||
    !/^[a-f0-9]{40}$/.test(remaining.fixedCommitSha)
  ) {
    return invalid();
  }
  const executions = [
    ...manifestTaskExecutions(design, "site_builder.design_spec"),
  ];
  for (const rawTask of remaining.tasks) {
    if (!isRecord(rawTask)) return invalid();
    const currentTaskId = taskId(rawTask.taskId);
    if (currentTaskId === "site_builder.design_spec") return invalid();
    if (
      rawTask.sourceBundleSha256 !== currentSourceBundleSha256(currentTaskId)
    ) {
      return invalid();
    }
    executions.push(...manifestTaskExecutions(rawTask, currentTaskId));
  }
  const taskIds = Object.freeze(
    Object.keys(TASK_EXECUTION_COUNTS) as M1TextEvaluationTaskId[],
  );
  for (const currentTaskId of taskIds) {
    const taskExecutions = executions.filter(
      (entry) => entry.taskId === currentTaskId,
    );
    if (taskExecutions.length !== TASK_EXECUTION_COUNTS[currentTaskId]) {
      return invalid();
    }
    assertExactTaskMatrix(currentTaskId, taskExecutions);
  }
  if (
    executions.length !== 206 ||
    new Set(
      executions.map(({ taskId, executionKey }) => `${taskId}/${executionKey}`),
    ).size !== 206
  ) {
    return invalid();
  }
  return Object.freeze({
    schemaVersion: "site-builder-m1-minimal-text-evaluation-plan/v1" as const,
    taskIds,
    manifestSha256: Object.freeze({
      designSpec: DESIGN_SPEC_MANIFEST_SHA256,
      remainingText: REMAINING_TEXT_MANIFEST_SHA256,
    }),
    fixedCommitSha: Object.freeze({
      designSpec: design.fixedCommitSha,
      remainingText: remaining.fixedCommitSha,
    }),
    executions: Object.freeze(executions),
    executionCount: 206 as const,
    maximumWireCallCount: 412 as const,
    priceCalculation: "external_owner_observed" as const,
  });
}

const CAMPAIGN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const REQUIRED_MODELS = Object.freeze([
  "claude-sonnet-5",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
]);

function taskOutputSchema(taskId: M1TextEvaluationTaskId) {
  if (taskId === "site_builder.design_spec")
    return DESIGN_SPEC_TASK.outputSchema;
  if (taskId === "site_builder.copy") return COPY_TASK.outputSchema;
  if (taskId === "site_builder.assemble") return ASSEMBLE_TASK.outputSchema;
  if (taskId === "site_builder.assembly_fix") {
    return ASSEMBLY_FIX_TASK.outputSchema;
  }
  if (taskId === "site_builder.qa_summarize") {
    return QA_SUMMARIZE_TASK.outputSchema;
  }
  return SEO_REVIEW_TASK.outputSchema;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function stripJsonFence(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1]!.trim() : trimmed;
}

function requireUsage(value: unknown) {
  if (!isRecord(value)) throw new Error("M1 model usage is absent");
  if (
    !nonNegativeSafeInteger(value.input_tokens) ||
    !nonNegativeSafeInteger(value.output_tokens)
  ) {
    throw new Error("M1 model usage is invalid");
  }
  return {
    inputTokens: value.input_tokens,
    outputTokens: value.output_tokens,
  };
}

function parseNativeResponse(
  protocol: NativeProtocol,
  body: unknown,
): NativeTextResponse {
  if (!isRecord(body) || typeof body.model !== "string") {
    throw new Error("M1 model response is invalid");
  }
  if (protocol === "openai-responses") {
    if (body.status !== "completed") {
      throw new Error("M1 OpenAI response did not complete");
    }
    const fragments: string[] = [];
    if (Array.isArray(body.output)) {
      for (const item of body.output) {
        if (!isRecord(item) || !Array.isArray(item.content)) continue;
        for (const content of item.content) {
          if (
            isRecord(content) &&
            content.type === "output_text" &&
            typeof content.text === "string"
          ) {
            fragments.push(content.text);
          }
        }
      }
    }
    const rawText =
      fragments.join("") ||
      (typeof body.output_text === "string" ? body.output_text : "");
    if (!rawText.trim()) throw new Error("M1 model output is empty");
    return {
      rawText,
      reportedModel: body.model,
      usage: requireUsage(body.usage),
    };
  }
  if (body.stop_reason !== "end_turn" || !Array.isArray(body.content)) {
    throw new Error("M1 Anthropic response did not complete");
  }
  const rawText = body.content
    .flatMap((content) =>
      isRecord(content) &&
      content.type === "text" &&
      typeof content.text === "string"
        ? [content.text]
        : [],
    )
    .join("");
  if (!rawText.trim()) throw new Error("M1 model output is empty");
  return {
    rawText,
    reportedModel: body.model,
    usage: requireUsage(body.usage),
  };
}

async function exactTokenModels(input: {
  token: string;
  fetch: typeof fetch;
}): Promise<readonly string[]> {
  const response = await input.fetch("http://127.0.0.1:3001/v1/models", {
    headers: { authorization: `Bearer ${input.token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("M1 evaluation token model lookup failed");
  const body = (await response.json()) as unknown;
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error("M1 evaluation token model scope is invalid");
  }
  const models = body.data
    .map((entry) => (isRecord(entry) ? entry.id : null))
    .filter((entry): entry is string => typeof entry === "string")
    .sort();
  if (
    models.length !== REQUIRED_MODELS.length ||
    !models.every((model, index) => model === REQUIRED_MODELS[index])
  ) {
    throw new Error("M1 evaluation token model scope is not exact");
  }
  return Object.freeze(models);
}

function candidateSummaries(
  plan: M1TextEvaluationPlan,
  results: readonly M1TextEvaluationResult[],
): readonly M1TextEvaluationCandidateSummary[] {
  const summaries: M1TextEvaluationCandidateSummary[] = [];
  for (const taskId of plan.taskIds) {
    const taskPlan = buildTaskEvaluationPlan(taskId);
    const suite = taskPlan.evaluationSuite!;
    for (const candidate of taskPlan.candidates) {
      const candidateResults = results.filter(
        (result) =>
          result.kind === "target" &&
          result.taskId === taskId &&
          result.alias === candidate.alias,
      );
      const accepted = candidateResults.filter(
        ({ outcome }) => outcome === "accepted",
      );
      let stableFixtureCount = 0;
      for (const fixtureId of suite.fixtureIds) {
        const fixtureRuns = candidateResults.filter(
          (result) => result.fixtureId === fixtureId,
        );
        if (
          fixtureRuns.length === suite.repeats &&
          fixtureRuns.every(
            (result) =>
              result.outcome === "accepted" &&
              result.artifactSha256 === fixtureRuns[0]?.artifactSha256,
          )
        ) {
          stableFixtureCount += 1;
        }
      }
      const expectedCount = suite.fixtureIds.length * suite.repeats;
      summaries.push(
        Object.freeze({
          taskId,
          alias: candidate.alias,
          protocol: candidate.expectedProtocol as NativeProtocol,
          rankable:
            candidateResults.length === expectedCount &&
            accepted.length === expectedCount &&
            stableFixtureCount === suite.fixtureIds.length,
          executionCount: candidateResults.length,
          acceptedExecutionCount: accepted.length,
          stableFixtureCount,
          failureCount: candidateResults.length - accepted.length,
        }),
      );
    }
  }
  return Object.freeze(summaries);
}

export async function runM1TextEvaluation(input: {
  campaignId: string;
  designSpecManifest: unknown;
  remainingTextManifest: unknown;
  token: string;
  fetch: typeof fetch;
}) {
  if (
    !CAMPAIGN_ID.test(input?.campaignId ?? "") ||
    typeof input?.token !== "string" ||
    input.token.length < 8 ||
    typeof input?.fetch !== "function"
  ) {
    throw new Error("M1 text evaluation input is invalid");
  }
  const plan = buildM1TextEvaluationPlan(input);
  const tokenScopeModels = await exactTokenModels(input);
  const requestIds = new Map<string, string[]>();
  const allRequestIds = new Set<string>();
  const capturedFetch: typeof fetch = async (request, init) => {
    const outgoing = new Request(request, init);
    const response = await input.fetch(outgoing);
    const executionId = outgoing.headers.get(
      "x-site-builder-evaluation-execution-id",
    );
    if (executionId) {
      const requestId = response.headers.get("x-oneapi-request-id")?.trim();
      if (!requestId || !REQUEST_ID.test(requestId)) {
        throw new Error("M1 evaluation response has no request receipt");
      }
      if (allRequestIds.has(requestId)) {
        throw new Error("M1 evaluation request receipt is duplicated");
      }
      allRequestIds.add(requestId);
      const observed = requestIds.get(executionId) ?? [];
      requestIds.set(executionId, [...observed, requestId]);
    }
    return response;
  };
  const tokenSha256 = createHash("sha256").update(input.token).digest("hex");
  const wireClient = createCredentialBoundModelEvaluationWireClient({
    credential: {
      attestationId: `m1-minimal-eval-${input.campaignId}`,
      snapshotSha256: sha256CanonicalJson(tokenScopeModels),
      bearerTokenSha256: tokenSha256,
      bearerToken: input.token,
      gatewayOrigin: "http://127.0.0.1:3001",
    },
    baseUrl: "http://127.0.0.1:3001/v1",
    fetch: capturedFetch,
  });
  const results: M1TextEvaluationResult[] = [];
  let actualNetworkCalls = 0;
  for (const entry of plan.executions) {
    const taskPlan = buildTaskEvaluationPlan(entry.taskId);
    const evaluationCase = buildCanonicalModelEvaluationCase(
      taskPlan,
      entry.fixtureId,
    );
    const outputSchema = taskOutputSchema(entry.taskId);
    const system = structuredSystemPrompt(outputSchema, entry.taskId);
    const executionId = `m1-${input.campaignId}-${entry.taskId}-${entry.ordinal}`;
    const observedUsage: Array<{
      inputTokens: number;
      outputTokens: number;
    }> = [];
    const dispatch = async (prompt: string): Promise<NativeTextResponse> => {
      if (actualNetworkCalls >= plan.maximumWireCallCount) {
        throw new Error("M1 evaluation wire-call cap is exhausted");
      }
      actualNetworkCalls += 1;
      const signal = AbortSignal.timeout(taskPlan.envelope.hardStopMs);
      const response =
        entry.protocol === "openai-responses"
          ? await wireClient.openAIResponses({
              executionId,
              body: {
                model: entry.alias,
                input: [
                  { role: "system", content: system },
                  { role: "user", content: prompt },
                ],
                max_output_tokens: taskPlan.envelope.maxTokens,
                temperature: 0,
                text: { format: { type: "json_object" } },
                ...(taskPlan.envelope.reasoningEffort
                  ? {
                      reasoning: {
                        effort: taskPlan.envelope.reasoningEffort,
                      },
                    }
                  : {}),
              },
              signal,
            })
          : await wireClient.anthropicMessages({
              executionId,
              body: {
                model: entry.alias,
                system,
                messages: [{ role: "user", content: prompt }],
                max_tokens: taskPlan.envelope.maxTokens,
                temperature: 0,
              },
              signal,
            });
      const parsed = parseNativeResponse(entry.protocol, response.body);
      if (parsed.reportedModel !== entry.alias) {
        throw new Error("M1 evaluation reported model does not match request");
      }
      observedUsage.push(parsed.usage);
      return parsed;
    };
    let response = await dispatch(evaluationCase.payload.prompt);
    let artifact: unknown;
    let assessment: ReturnType<typeof assessCanonicalTaskArtifact> | null =
      null;
    let invalidReason: string | null = null;
    try {
      artifact = JSON.parse(stripJsonFence(response.rawText));
      assessment = assessCanonicalTaskArtifact(
        taskPlan,
        evaluationCase.payload,
        artifact,
      );
    } catch (error) {
      invalidReason =
        error instanceof Error ? error.message : "task_output_invalid";
    }
    if (invalidReason) {
      response = await dispatch(
        repairPrompt(
          evaluationCase.payload.prompt,
          "任务确定性硬门",
          invalidReason,
        ),
      );
      invalidReason = null;
      try {
        artifact = JSON.parse(stripJsonFence(response.rawText));
        assessment = assessCanonicalTaskArtifact(
          taskPlan,
          evaluationCase.payload,
          artifact,
        );
      } catch (error) {
        invalidReason =
          error instanceof Error ? error.message : "task_output_invalid";
        artifact = undefined;
        assessment = null;
      }
    }
    const accepted =
      invalidReason === null &&
      assessment !== null &&
      assessment.qualityPassed &&
      assessment.structurePassed &&
      assessment.factualityPassed;
    const usage = observedUsage.reduce(
      (total, current) => ({
        inputTokens: total.inputTokens + current.inputTokens,
        outputTokens: total.outputTokens + current.outputTokens,
        callCount: total.callCount + 1,
      }),
      { inputTokens: 0, outputTokens: 0, callCount: 0 },
    );
    const receipts = requestIds.get(executionId) ?? [];
    if (receipts.length !== usage.callCount || receipts.length > 2) {
      throw new Error(
        `M1 evaluation request receipts are incomplete: ${entry.executionKey}/${receipts.length}/${usage.callCount}`,
      );
    }
    const result = Object.freeze({
      executionId,
      taskId: entry.taskId,
      executionKey: entry.executionKey,
      kind: entry.kind,
      alias: entry.alias,
      protocol: entry.protocol,
      fixtureId: entry.fixtureId,
      attempt: entry.attempt,
      outcome: accepted ? ("accepted" as const) : ("rejected" as const),
      artifactSha256:
        artifact === undefined ? null : sha256CanonicalJson(artifact),
      assessment:
        assessment === null
          ? null
          : Object.freeze({
              qualityPassed: assessment.qualityPassed,
              structurePassed: assessment.structurePassed,
              factualityPassed: assessment.factualityPassed,
              findingCodes: Object.freeze([...assessment.findingCodes]),
            }),
      requestedModel: entry.alias,
      reportedModel: response.reportedModel,
      usage: Object.freeze(usage),
      requestIds: Object.freeze([...receipts]),
    });
    results.push(result);
    if (entry.kind === "capability_probe" && !accepted) {
      throw new Error(
        `M1 capability probe was rejected: ${entry.taskId}/${entry.alias}`,
      );
    }
  }
  if (results.length !== plan.executionCount) {
    throw new Error("M1 evaluation execution count is incomplete");
  }
  const frozenResults = Object.freeze(results);
  return Object.freeze({
    schemaVersion:
      "site-builder-m1-minimal-text-evaluation-evidence/v1" as const,
    campaignId: input.campaignId,
    gatewayOrigin: "http://127.0.0.1:3001" as const,
    tokenScopeModels,
    plan,
    actualNetworkCalls,
    priceCalculation: "external_owner_observed" as const,
    results: frozenResults,
    candidates: candidateSummaries(plan, frozenResults),
  });
}

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const DESIGN_MANIFEST_PATH =
  "docs/evidence/site-builder/m1-g-design-spec-evaluation-manifest-v6.json";
const REMAINING_MANIFEST_PATH =
  "docs/evidence/site-builder/m1-g-remaining-text-evaluation-manifest-v2.json";
const EVIDENCE_PATH =
  /^docs\/evidence\/site-builder\/[A-Za-z0-9][A-Za-z0-9._/-]*\.json$/;

function option(name: string): string | null {
  const prefix = `--${name}=`;
  const values = process.argv
    .slice(2)
    .filter((value) => value.startsWith(prefix));
  return values.length === 1 ? values[0]!.slice(prefix.length) : null;
}

async function main(): Promise<void> {
  const output = option("output")?.trim() ?? "";
  const campaignId = option("campaign-id")?.trim() || randomUUID();
  const token = process.env.SITE_BUILDER_M1_EVAL_TOKEN;
  if (
    !EVIDENCE_PATH.test(output) ||
    output.includes("\\") ||
    output.includes("//") ||
    output.split("/").includes("..")
  ) {
    throw new Error("--output must be a new Site Builder evidence JSON path");
  }
  if (!token) {
    throw new Error("SITE_BUILDER_M1_EVAL_TOKEN is required");
  }
  const [designSpecManifest, remainingTextManifest] = await Promise.all([
    readFile(resolve(REPOSITORY_ROOT, DESIGN_MANIFEST_PATH), "utf8").then(
      JSON.parse,
    ),
    readFile(resolve(REPOSITORY_ROOT, REMAINING_MANIFEST_PATH), "utf8").then(
      JSON.parse,
    ),
  ]);
  const plan = buildM1TextEvaluationPlan({
    designSpecManifest,
    remainingTextManifest,
  });
  for (const fixedCommitSha of Object.values(plan.fixedCommitSha)) {
    execFileSync(
      "git",
      ["merge-base", "--is-ancestor", fixedCommitSha, "HEAD"],
      {
        cwd: REPOSITORY_ROOT,
        stdio: "ignore",
      },
    );
  }
  const evidence = await runM1TextEvaluation({
    campaignId,
    designSpecManifest,
    remainingTextManifest,
    token,
    fetch,
  });
  await writeRepositoryJsonCreateOnly(REPOSITORY_ROOT, output, evidence);
  process.stdout.write(
    `created ${output}; executions=${evidence.results.length}; wires=${evidence.actualNetworkCalls}; price=external_owner_observed\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
