import "dotenv/config";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AESTHETIC_REVIEW_EVALUATOR_VERSION,
  AESTHETIC_REVIEW_EVAL_SCHEMA_VERSION,
  AESTHETIC_REVIEW_OUTPUT_SCHEMA,
  AESTHETIC_REVIEW_PROMPT_VERSION,
  assertAestheticReviewOutput,
  evaluateAestheticCaseOutput,
  loadAestheticEvalCases,
  type AestheticEvalCase,
  type AestheticReviewOutput,
} from "../src/site-builder/eval/aesthetic-review-eval";
import {
  inspectEvaluationSourceBundle,
  prepareEvaluationReportPath,
  sanitizeGatewayBaseUrl,
  sha256Bytes,
  sha256CanonicalJson,
  type EvaluationSourceFingerprint,
} from "../src/site-builder/eval/eval-provenance";
import { buildGatewayProvider } from "../src/model-gateway/model-providers.config";
import { ModelProviderRegistry } from "../src/model-gateway/model-provider.registry";
import { ModelRouter } from "../src/model-gateway/model-router";
import {
  ProviderHttpError,
  ProviderIdentityError,
  ProviderOutputError,
  TaskOutputValidationError,
} from "../src/model-gateway/providers/provider-output-error";
import { RouterModelGateway } from "../src/model-gateway/router-model-gateway";
import type {
  ModelResult,
  VisionReviewImage,
} from "../src/model-gateway/types";

const MODEL = "gemini-3.5-flash";
const TASK = "site_builder.aesthetic_review.eval";
const TRANSPORT = "openai-chat-completions";
const EVIDENCE_ID = "model1-aesthetic-review-20260724-v2";
const HISTORICAL_INCIDENT_EVIDENCE_ID = "model1-aesthetic-review-20260724-v1";
const HISTORICAL_INCIDENT_EVALUATOR_VERSION =
  "site-builder-aesthetic-review-eval@1.0.0";
const HISTORICAL_INCIDENT_PROMPT_VERSION =
  "site-builder-aesthetic-review-prompt/v1";
const REPEATS = 2;
const EXPECTED_CASES = 12;
const EXPECTED_RUNS = EXPECTED_CASES * REPEATS;
const TIMEOUT_MS = 120_000;
const CATALOG_TIMEOUT_MS = 10_000;
const MAX_TOKENS = 2_000;
const MAX_COST_CENTS = 10;
const PRICE_SNAPSHOT = {
  source: "docs/site-builder/10-model-selection-study.md",
  inputUsdPerMillionTokens: 1.5,
  outputUsdPerMillionTokens: 9,
} as const;
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const reportPath = process.env.MODEL_EVAL_REPORT_PATH?.trim();
if (!reportPath) {
  throw new Error(
    "MODEL_EVAL_REPORT_PATH is required so evidence cannot overwrite an earlier run",
  );
}
const absoluteReportPath = path.resolve(repositoryRoot, reportPath);
const artifactDirectory = path.join(
  path.dirname(absoluteReportPath),
  "artifacts",
);

const SOURCE_PATHS = [
  "apps/api/scripts/evaluate-site-builder-aesthetic-review.mts",
  "apps/api/src/site-builder/eval/aesthetic-review-eval.ts",
  "apps/api/src/site-builder/eval/eval-provenance.ts",
  "apps/api/src/model-gateway/model-providers.config.ts",
  "apps/api/src/model-gateway/model-transports.ts",
  "apps/api/src/model-gateway/providers/openai-compatible.provider.ts",
  "apps/api/src/model-gateway/providers/provider-output-error.ts",
  "apps/api/src/model-gateway/router-model-gateway.ts",
  "apps/api/src/model-gateway/schema-validate.ts",
  "apps/api/src/model-gateway/types.ts",
  "apps/api/src/model-gateway/vision-review-input.ts",
  "apps/site-renderer/visual-tests/__screenshots__/m1-e-b/manifest.json",
  "docs/site-builder/10-model-selection-study.md",
  "pnpm-lock.yaml",
] as const;

interface ModelCatalogSnapshot {
  baseUrl: string;
  modelCount: number;
  modelCatalogSha256: string;
  requestedModelListed: boolean;
}

type UnavailableReason =
  | "model_not_listed"
  | "authentication"
  | "payment_required"
  | "rate_limited"
  | "timeout"
  | "cancelled"
  | "protocol_mismatch"
  | "empty_or_invalid_output"
  | "schema_invalid"
  | "model_identity_mismatch"
  | "untrusted_provider_provenance"
  | "catalog_unavailable";

interface EvaluationRun {
  caseId: string;
  familyId: string;
  kind: "approved" | "degraded";
  expectedIssue: string | null;
  attempt: number;
  requestedModel: string;
  reportedModel: string;
  resolvedModel: string;
  modelResolutionSource: "upstream_response";
  provider: string;
  transport: typeof TRANSPORT;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  reportedCostUsd: number | null;
  calculatedCostUsd: number;
  artifactSha256: string;
  artifactFileSha256: string;
  schemaValid: true;
  provenanceExact: true;
  forbiddenFieldsAbsent: true;
  falseBlocker: boolean;
  seededIssueDetected: boolean | null;
  caseAccepted: boolean;
  overallScore: number;
  verdict: "passed" | "failed";
  artifactPath: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function progress(event: string, detail: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ event, at: new Date().toISOString(), ...detail })}\n`,
  );
}

function round(value: number, places = 6): number {
  return Number(value.toFixed(places));
}

function calculatedCost(result: ModelResult<unknown>): number {
  return round(
    ((result.usage?.inputTokens ?? 0) *
      PRICE_SNAPSHOT.inputUsdPerMillionTokens +
      (result.usage?.outputTokens ?? 0) *
        PRICE_SNAPSHOT.outputUsdPerMillionTokens) /
      1_000_000,
    8,
  );
}

async function fingerprints(): Promise<EvaluationSourceFingerprint[]> {
  return Promise.all(
    SOURCE_PATHS.map(async (sourcePath) => ({
      path: sourcePath,
      sha256: sha256Bytes(
        await readFile(path.join(repositoryRoot, sourcePath)),
      ),
    })),
  );
}

async function assertArtifactPathsAvailable(): Promise<void> {
  for (const caseId of [
    "capability-probe",
    ...Array.from({ length: EXPECTED_RUNS }, (_, index) => `run-${index + 1}`),
  ]) {
    const target = path.join(artifactDirectory, `${caseId}.json`);
    try {
      await access(target);
      throw new Error(`evaluation artifact path already exists: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function modelCatalog(): Promise<ModelCatalogSnapshot> {
  const baseUrl = sanitizeGatewayBaseUrl(required("MODEL_GATEWAY_URL"));
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${required("MODEL_GATEWAY_KEY")}` },
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new ProviderHttpError({
      status: response.status,
      provider: "gateway",
      model: MODEL,
      responseExcerpt: "catalog request rejected",
    });
  }
  const payload = (await response.json()) as {
    data?: Array<{ id?: unknown }>;
  };
  if (!Array.isArray(payload.data)) {
    throw new Error("MODEL_CATALOG_PROTOCOL_INVALID");
  }
  const ids = payload.data
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort();
  if (new Set(ids).size !== ids.length) {
    throw new Error("MODEL_CATALOG_PROTOCOL_INVALID");
  }
  return {
    baseUrl,
    modelCount: ids.length,
    modelCatalogSha256: sha256CanonicalJson(ids),
    requestedModelListed: ids.includes(MODEL),
  };
}

function fixtureCatalog(
  cases: readonly AestheticEvalCase[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    cases.flatMap((evalCase) =>
      evalCase.images.map((image) => [image.artifactId, image.sha256]),
    ),
  );
}

function createGateway(
  cases: readonly AestheticEvalCase[],
): RouterModelGateway {
  const provider = buildGatewayProvider(process.env, {
    visionEvalFixtureDigests: fixtureCatalog(cases),
  });
  if (!provider) throw new Error("MODEL_GATEWAY_NOT_CONFIGURED");
  if (provider.id === "stub") {
    throw new Error("MODEL_GATEWAY_UNTRUSTED_PROVIDER");
  }
  const registry = new ModelProviderRegistry();
  registry.register(provider);
  return new RouterModelGateway(new ModelRouter(registry));
}

async function invoke(
  gateway: RouterModelGateway,
  evalCase: AestheticEvalCase,
): Promise<{ result: ModelResult<AestheticReviewOutput>; elapsedMs: number }> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort("evaluation_timeout"),
    TIMEOUT_MS,
  );
  try {
    const result = await gateway.reviewVision<AestheticReviewOutput>(
      {
        task: TASK,
        prompt: evalCase.prompt,
        system:
          "You are a calibrated website design evaluator. Judge only the supplied screenshots. Never suggest or emit repairs.",
        model: MODEL,
        schema: AESTHETIC_REVIEW_OUTPUT_SCHEMA,
        images: evalCase.images,
        validateOutput: (value) =>
          assertAestheticReviewOutput(value, evalCase.images),
        maxTokens: MAX_TOKENS,
        maxCostCents: MAX_COST_CENTS,
        signal: controller.signal,
      },
      { workspaceId: WORKSPACE_ID, correlationId: EVIDENCE_ID },
    );
    return { result, elapsedMs: round(performance.now() - startedAt, 3) };
  } finally {
    clearTimeout(timer);
  }
}

function classifyUnavailable(error: unknown): UnavailableReason {
  if (error instanceof ProviderHttpError) {
    if (error.status === 401) return "authentication";
    if (error.status === 402) return "payment_required";
    if (error.status === 429) return "rate_limited";
    return "protocol_mismatch";
  }
  if (error instanceof ProviderIdentityError) {
    return "model_identity_mismatch";
  }
  if (error instanceof TaskOutputValidationError) return "schema_invalid";
  if (error instanceof ProviderOutputError) {
    if (/EMPTY|NOT_JSON|TRUNCATED|FINISH_REASON/.test(error.message)) {
      return "empty_or_invalid_output";
    }
    return "schema_invalid";
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return "timeout";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/MODEL_NOT_LISTED/.test(message)) return "model_not_listed";
  if (/abort|timeout|deadline/i.test(message)) return "timeout";
  if (/cancel/i.test(message)) return "cancelled";
  if (/IDENTITY/.test(message)) return "model_identity_mismatch";
  if (/UNTRUSTED|stub|fallback provenance/i.test(message)) {
    return "untrusted_provider_provenance";
  }
  if (/CATALOG/.test(message)) return "catalog_unavailable";
  return "protocol_mismatch";
}

function safeError(error: unknown): {
  name: string;
  reason: UnavailableReason;
  httpStatus?: number;
} {
  return {
    name:
      error instanceof Error
        ? error.name
        : typeof error === "string"
          ? "AbortReason"
          : "UnknownError",
    reason: classifyUnavailable(error),
    ...(error instanceof ProviderHttpError ? { httpStatus: error.status } : {}),
  };
}

function assertExactProvenance(
  result: ModelResult<unknown>,
): asserts result is ModelResult<unknown> & {
  model: typeof MODEL;
  reportedModel: typeof MODEL;
  modelResolutionSource: "upstream_response";
} {
  if (
    result.provider !== "gateway" ||
    result.model !== MODEL ||
    result.reportedModel !== MODEL ||
    result.modelResolutionSource !== "upstream_response"
  ) {
    throw new ProviderIdentityError("MODEL_EVAL_PROVENANCE_NOT_EXACT");
  }
}

async function writeArtifact(
  filename: string,
  value: unknown,
): Promise<{ path: string; sha256: string }> {
  await mkdir(artifactDirectory, { recursive: true });
  const target = path.join(artifactDirectory, filename);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeFile(target, bytes, {
    encoding: "utf8",
    flag: "wx",
  });
  return {
    path: path.relative(repositoryRoot, target),
    sha256: sha256Bytes(bytes),
  };
}

function artifactImageEvidence(images: readonly VisionReviewImage[]) {
  return images.map((image) => ({
    artifactId: image.artifactId,
    sha256: image.sha256,
    mimeType: image.mimeType,
    byteLength: image.bytes.byteLength,
    target: image.target,
  }));
}

async function writeFinalReport(report: unknown): Promise<void> {
  await writeFile(absoluteReportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

async function reconcileInterruptedEvidence(
  sourceReportPath: string,
): Promise<void> {
  await prepareEvaluationReportPath(absoluteReportPath);
  const sourceStart = await fingerprints();
  const sourceAbsolute = path.resolve(repositoryRoot, sourceReportPath);
  const sourceReport = JSON.parse(
    await readFile(sourceAbsolute, "utf8"),
  ) as Record<string, unknown>;
  const sourceMatrix = sourceReport.matrix as
    Record<string, unknown> | undefined;
  const sourceProbe = sourceReport.probe as Record<string, unknown> | undefined;
  if (
    sourceReport.candidateState !== "unavailable" ||
    sourceReport.evidenceId !== HISTORICAL_INCIDENT_EVIDENCE_ID ||
    sourceMatrix?.reason !== "timeout" ||
    sourceProbe?.accepted !== true
  ) {
    throw new Error("INTERRUPTED_EVIDENCE_SOURCE_INVALID");
  }
  const sourceArtifactDirectory = path.join(
    path.dirname(sourceAbsolute),
    "artifacts",
  );
  const names = (await readdir(sourceArtifactDirectory))
    .filter((name) => /^run-\d+\.json$/.test(name))
    .sort(
      (left, right) =>
        Number(left.match(/\d+/)?.[0]) - Number(right.match(/\d+/)?.[0]),
    );
  const cases = await loadAestheticEvalCases(repositoryRoot);
  const caseById = new Map(
    cases.map((evalCase) => [evalCase.caseId, evalCase]),
  );
  const recoveredRuns = [];
  for (const [index, name] of names.entries()) {
    if (name !== `run-${index + 1}.json`) {
      throw new Error(`INTERRUPTED_EVIDENCE_SEQUENCE_GAP: ${name}`);
    }
    const absolute = path.join(sourceArtifactDirectory, name);
    const bytes = await readFile(absolute);
    const artifact = JSON.parse(bytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    const expectedCase = cases[Math.floor(index / REPEATS)];
    const expectedAttempt = (index % REPEATS) + 1;
    const evalCase = caseById.get(String(artifact.caseId));
    const output = artifact.output;
    const usage = artifact.usage as Record<string, unknown> | undefined;
    if (
      !evalCase ||
      evalCase !== expectedCase ||
      artifact.attempt !== expectedAttempt ||
      artifact.schemaVersion !== AESTHETIC_REVIEW_EVAL_SCHEMA_VERSION ||
      artifact.evidenceId !== HISTORICAL_INCIDENT_EVIDENCE_ID ||
      artifact.evaluatorVersion !== HISTORICAL_INCIDENT_EVALUATOR_VERSION ||
      artifact.promptVersion !== HISTORICAL_INCIDENT_PROMPT_VERSION ||
      artifact.familyId !== evalCase.familyId ||
      artifact.kind !== evalCase.kind ||
      artifact.expectedIssue !== evalCase.expectedIssue ||
      artifact.requestedModel !== MODEL ||
      artifact.reportedModel !== MODEL ||
      artifact.resolvedModel !== MODEL ||
      artifact.modelResolutionSource !== "upstream_response" ||
      artifact.provider !== "gateway" ||
      artifact.transport !== TRANSPORT ||
      typeof artifact.elapsedMs !== "number" ||
      !Number.isFinite(artifact.elapsedMs) ||
      artifact.elapsedMs < 0 ||
      !usage ||
      !Number.isInteger(usage.inputTokens) ||
      Number(usage.inputTokens) < 0 ||
      !Number.isInteger(usage.outputTokens) ||
      Number(usage.outputTokens) < 0 ||
      sha256CanonicalJson(artifact.imageEvidence) !==
        sha256CanonicalJson(artifactImageEvidence(evalCase.images))
    ) {
      throw new Error(`INTERRUPTED_EVIDENCE_ARTIFACT_INVALID: ${name}`);
    }
    let closedOutputValidUnderReconciliationCode = false;
    let selfReportedScoringInternallyConsistent = false;
    try {
      const validated = assertAestheticReviewOutput(output, evalCase.images);
      const scoring = evaluateAestheticCaseOutput(evalCase, validated);
      closedOutputValidUnderReconciliationCode = true;
      selfReportedScoringInternallyConsistent =
        sha256CanonicalJson(scoring) === sha256CanonicalJson(artifact.scoring);
    } catch {
      // Diagnostic inventory only. A historical file that fails the current
      // closed evaluator stays inventoried but can never become positive
      // MODEL-1 evidence retroactively.
    }
    recoveredRuns.push({
      artifactPath: path.relative(repositoryRoot, absolute),
      fileSha256: sha256Bytes(bytes),
      caseId: evalCase.caseId,
      familyId: evalCase.familyId,
      kind: evalCase.kind,
      expectedIssue: evalCase.expectedIssue,
      attempt: artifact.attempt,
      elapsedMs: artifact.elapsedMs,
      usage: artifact.usage,
      requestedModel: MODEL,
      reportedModel: MODEL,
      resolvedModel: MODEL,
      modelResolutionSource: "upstream_response",
      provider: "gateway",
      transport: TRANSPORT,
      artifactSha256: sha256CanonicalJson(output),
      closedOutputValidUnderReconciliationCode,
      forbiddenFieldsAbsentUnderReconciliationCode:
        closedOutputValidUnderReconciliationCode,
      selfReportedIdentityFieldsConsistent: true,
      originalExecutionProvenanceExact: false,
      selfReportedScoringInternallyConsistent,
    });
  }
  const sourceEnd = await fingerprints();
  const sourceIntegrity = inspectEvaluationSourceBundle(sourceStart, sourceEnd);
  const report = {
    schemaVersion: AESTHETIC_REVIEW_EVAL_SCHEMA_VERSION,
    evidenceId: `${HISTORICAL_INCIDENT_EVIDENCE_ID}-unanchored-inventory-v1`,
    candidateState: "unavailable",
    routePromoted: false,
    reconciliation: {
      kind: "read_only_unanchored_incident_inventory",
      sourceReportPath: path.relative(repositoryRoot, sourceAbsolute),
      sourceReportSha256: sha256Bytes(await readFile(sourceAbsolute)),
      modelCallsMade: 0,
      originalArtifactManifestPresent: false,
      originalRunnerSourceAvailable: false,
      historicalContract: {
        evidenceId: HISTORICAL_INCIDENT_EVIDENCE_ID,
        evaluatorVersion: HISTORICAL_INCIDENT_EVALUATOR_VERSION,
        promptVersion: HISTORICAL_INCIDENT_PROMPT_VERSION,
      },
      currentContract: {
        evidenceId: EVIDENCE_ID,
        evaluatorVersion: AESTHETIC_REVIEW_EVALUATOR_VERSION,
        promptVersion: AESTHETIC_REVIEW_PROMPT_VERSION,
      },
      limitation:
        "The source report did not anchor a partial artifact manifest or preserve the exact runner source. File hashes below prove only the bytes inventoried during reconciliation, not exact original-execution provenance.",
      originalExecutionSourceFiles: sourceReport.sourceFiles,
      originalExecutionSourceIntegrity: sourceReport.sourceIntegrity,
    },
    model: sourceReport.model,
    catalog: sourceReport.catalog,
    probe: sourceProbe,
    matrix: {
      status: "interrupted",
      reason: "timeout",
      completedRunsProven: null,
      expectedRuns: EXPECTED_RUNS,
      diagnosticFileCount: recoveredRuns.length,
      inventoryCompleteForFilesPresent: true,
      originalArtifactSetAnchored: false,
      originalExecutionProvenanceExact: false,
      allInventoriedArtifactsClosedOutputValidUnderReconciliationCode:
        recoveredRuns.every(
          (run) => run.closedOutputValidUnderReconciliationCode,
        ),
      allInventoriedArtifactsSelfReportedIdentityFieldsConsistent:
        recoveredRuns.every((run) => run.selfReportedIdentityFieldsConsistent),
      allInventoriedArtifactsForbiddenFieldsAbsentUnderReconciliationCode:
        recoveredRuns.every(
          (run) => run.forbiddenFieldsAbsentUnderReconciliationCode,
        ),
    },
    diagnosticInventory: recoveredRuns,
    sourceFiles: sourceStart,
    sourceIntegrity,
    conclusion:
      "The raw report recorded a successful capability probe before a matrix timeout, but its partial artifact set and exact runner source were not anchored. This reconciliation is diagnostic inventory only, not exact model provenance. The candidate remains runtime-unavailable, is not evaluatedCandidate, and deterministic P4 remains explicit.",
  };
  await writeFinalReport(report);
  progress("interrupted_evidence_reconciled", {
    model: MODEL,
    modelCallsMade: 0,
    diagnosticFileCount: recoveredRuns.length,
    expectedRuns: EXPECTED_RUNS,
    reportPath: path.relative(repositoryRoot, absoluteReportPath),
  });
}

const interruptedSourcePath =
  process.env.MODEL_EVAL_RECONCILE_INTERRUPTED_REPORT?.trim();
if (interruptedSourcePath) {
  await reconcileInterruptedEvidence(interruptedSourcePath);
  process.exit(3);
}

await prepareEvaluationReportPath(absoluteReportPath);
await assertArtifactPathsAvailable();
const sourceStart = await fingerprints();
const cases = await loadAestheticEvalCases(repositoryRoot);
if (cases.length !== EXPECTED_CASES) {
  throw new Error(`expected ${EXPECTED_CASES} aesthetic cases`);
}

let catalog: ModelCatalogSnapshot | undefined;
let probeArtifact:
  | {
      path: string;
      sha256: string;
    }
  | undefined;
let probe: Record<string, unknown> | undefined;
let probeCalculatedCostUsd = 0;
let probeReportedCostUsd: number | null = null;
const completedRuns: EvaluationRun[] = [];
try {
  catalog = await modelCatalog();
  progress("model_catalog_checked", {
    model: MODEL,
    listed: catalog.requestedModelListed,
    modelCount: catalog.modelCount,
  });
  if (!catalog.requestedModelListed) {
    throw new Error("MODEL_NOT_LISTED");
  }

  const gateway = createGateway(cases);
  const probeCase = cases.find(
    (evalCase) =>
      evalCase.familyId === "natural-origin" && evalCase.kind === "approved",
  );
  if (!probeCase) throw new Error("CAPABILITY_PROBE_FIXTURE_MISSING");
  progress("capability_probe_started", {
    model: MODEL,
    transport: TRANSPORT,
    imageCount: probeCase.images.length,
    timeoutMs: TIMEOUT_MS,
  });
  const probeCall = await invoke(gateway, probeCase);
  assertExactProvenance(probeCall.result);
  const probeOutput = assertAestheticReviewOutput(
    probeCall.result.data,
    probeCase.images,
  );
  probeCalculatedCostUsd = calculatedCost(probeCall.result);
  probeReportedCostUsd = probeCall.result.usage?.costUsd ?? null;
  probe = {
    accepted: true,
    requestedModel: MODEL,
    reportedModel: probeCall.result.reportedModel,
    resolvedModel: probeCall.result.model,
    modelResolutionSource: probeCall.result.modelResolutionSource,
    provider: probeCall.result.provider,
    transport: TRANSPORT,
    elapsedMs: probeCall.elapsedMs,
    usage: probeCall.result.usage ?? {},
    reportedCostUsd: probeReportedCostUsd,
    calculatedCostUsd: probeCalculatedCostUsd,
    artifactSha256: sha256CanonicalJson(probeOutput),
    imageEvidence: artifactImageEvidence(probeCase.images),
  };
  probeArtifact = await writeArtifact("capability-probe.json", {
    schemaVersion: AESTHETIC_REVIEW_EVAL_SCHEMA_VERSION,
    evidenceId: EVIDENCE_ID,
    probe,
    output: probeOutput,
  });
  progress("capability_probe_accepted", {
    model: MODEL,
    elapsedMs: probeCall.elapsedMs,
    requested: MODEL,
    reported: probeCall.result.reportedModel,
    resolved: probeCall.result.model,
  });

  const runs = completedRuns;
  let sequence = 0;
  for (const evalCase of cases) {
    for (let attempt = 1; attempt <= REPEATS; attempt += 1) {
      sequence += 1;
      progress("matrix_run_started", {
        sequence,
        expectedRuns: EXPECTED_RUNS,
        caseId: evalCase.caseId,
        attempt,
      });
      const call = await invoke(gateway, evalCase);
      assertExactProvenance(call.result);
      const output = assertAestheticReviewOutput(
        call.result.data,
        evalCase.images,
      );
      const scored = evaluateAestheticCaseOutput(evalCase, output);
      const artifactName = `run-${sequence}.json`;
      const artifactFile = await writeArtifact(artifactName, {
        schemaVersion: AESTHETIC_REVIEW_EVAL_SCHEMA_VERSION,
        evidenceId: EVIDENCE_ID,
        evaluatorVersion: AESTHETIC_REVIEW_EVALUATOR_VERSION,
        promptVersion: AESTHETIC_REVIEW_PROMPT_VERSION,
        caseId: evalCase.caseId,
        familyId: evalCase.familyId,
        kind: evalCase.kind,
        expectedIssue: evalCase.expectedIssue,
        attempt,
        requestedModel: MODEL,
        reportedModel: call.result.reportedModel,
        resolvedModel: call.result.model,
        modelResolutionSource: call.result.modelResolutionSource,
        provider: call.result.provider,
        transport: TRANSPORT,
        elapsedMs: call.elapsedMs,
        usage: call.result.usage ?? {},
        imageEvidence: artifactImageEvidence(evalCase.images),
        output,
        scoring: scored,
      });
      runs.push({
        caseId: evalCase.caseId,
        familyId: evalCase.familyId,
        kind: evalCase.kind,
        expectedIssue: evalCase.expectedIssue,
        attempt,
        requestedModel: MODEL,
        reportedModel: call.result.reportedModel!,
        resolvedModel: call.result.model,
        modelResolutionSource: "upstream_response",
        provider: call.result.provider,
        transport: TRANSPORT,
        elapsedMs: call.elapsedMs,
        inputTokens: call.result.usage?.inputTokens ?? 0,
        outputTokens: call.result.usage?.outputTokens ?? 0,
        reportedCostUsd: call.result.usage?.costUsd ?? null,
        calculatedCostUsd: calculatedCost(call.result),
        artifactSha256: sha256CanonicalJson(output),
        artifactFileSha256: artifactFile.sha256,
        schemaValid: true,
        provenanceExact: true,
        forbiddenFieldsAbsent: true,
        falseBlocker: scored.falseBlocker,
        seededIssueDetected: scored.seededIssueDetected,
        caseAccepted: scored.accepted,
        overallScore: output.overallScore,
        verdict: output.verdict,
        artifactPath: artifactFile.path,
      });
      progress("matrix_run_completed", {
        sequence,
        caseId: evalCase.caseId,
        attempt,
        elapsedMs: call.elapsedMs,
        caseAccepted: scored.accepted,
      });
    }
  }

  const degradedRuns = runs.filter((run) => run.kind === "degraded");
  const approvedRuns = runs.filter((run) => run.kind === "approved");
  const seededIssueHits = degradedRuns.filter(
    (run) => run.seededIssueDetected,
  ).length;
  const seededIssueRecall =
    degradedRuns.length === 0 ? 0 : seededIssueHits / degradedRuns.length;
  const falseBlockers = approvedRuns.filter((run) => run.falseBlocker).length;
  const pairedPreferences = Object.keys(
    Object.fromEntries(cases.map((evalCase) => [evalCase.familyId, true])),
  ).map((familyId) => {
    const approvedScores = approvedRuns
      .filter((run) => run.familyId === familyId)
      .map((run) => run.overallScore);
    const degradedScores = degradedRuns
      .filter((run) => run.familyId === familyId)
      .map((run) => run.overallScore);
    const approvedAverage =
      approvedScores.reduce((sum, score) => sum + score, 0) /
      approvedScores.length;
    const degradedAverage =
      degradedScores.reduce((sum, score) => sum + score, 0) /
      degradedScores.length;
    return {
      familyId,
      approvedAverage: round(approvedAverage, 3),
      degradedAverage: round(degradedAverage, 3),
      preferredApproved: approvedAverage > degradedAverage,
    };
  });
  const preferredPairs = pairedPreferences.filter(
    (pair) => pair.preferredApproved,
  ).length;
  const matrixCalculatedCostUsd = round(
    runs.reduce((sum, run) => sum + run.calculatedCostUsd, 0),
    8,
  );
  const totalCalculatedCostUsd = round(
    probeCalculatedCostUsd + matrixCalculatedCostUsd,
    8,
  );
  const acceptedRunCount = runs.filter((run) => run.caseAccepted).length;
  const sourceEnd = await fingerprints();
  const sourceIntegrity = inspectEvaluationSourceBundle(sourceStart, sourceEnd);
  const gates = {
    matrixComplete: runs.length === EXPECTED_RUNS,
    schemaAndProvenance:
      runs.filter(
        (run) =>
          run.schemaValid && run.provenanceExact && run.forbiddenFieldsAbsent,
      ).length === EXPECTED_RUNS,
    seededIssueRecallAtLeast90: seededIssueRecall >= 0.9,
    goodFixtureFalseBlockersZero: falseBlockers === 0,
    pairedPreferenceAtLeastFiveOfSix: preferredPairs >= 5,
    sourceBundleStable: sourceIntegrity.stable,
  };
  const passed = Object.values(gates).every(Boolean);
  const report = {
    schemaVersion: AESTHETIC_REVIEW_EVAL_SCHEMA_VERSION,
    evidenceId: EVIDENCE_ID,
    candidateState: passed ? "evaluatedCandidate" : "rejectedCandidate",
    routePromoted: false,
    model: {
      requested: MODEL,
      transport: TRANSPORT,
      provider: "gateway",
    },
    catalog,
    probe: { ...probe, artifact: probeArtifact },
    contract: {
      taskId: TASK,
      evaluatorVersion: AESTHETIC_REVIEW_EVALUATOR_VERSION,
      promptVersion: AESTHETIC_REVIEW_PROMPT_VERSION,
      outputSchemaSha256: sha256CanonicalJson(AESTHETIC_REVIEW_OUTPUT_SCHEMA),
      caseCount: cases.length,
      repeats: REPEATS,
      expectedRunCount: EXPECTED_RUNS,
      timeoutMs: TIMEOUT_MS,
      maxTokens: MAX_TOKENS,
      maxCostCents: MAX_COST_CENTS,
    },
    gates,
    metrics: {
      schemaProvenanceForbiddenAccepted: `${runs.filter((run) => run.schemaValid && run.provenanceExact && run.forbiddenFieldsAbsent).length}/${EXPECTED_RUNS}`,
      seededIssueHits,
      degradedRunCount: degradedRuns.length,
      seededIssueRecall: round(seededIssueRecall, 4),
      goodFixtureFalseBlockers: falseBlockers,
      preferredPairs,
      familyCount: pairedPreferences.length,
      pairedPreferences,
      acceptedRunCount,
      probeCalculatedCostUsd,
      matrixCalculatedCostUsd,
      totalCalculatedCostUsd,
      acceptedArtifactUnitCostUsd:
        acceptedRunCount === 0
          ? null
          : round(totalCalculatedCostUsd / acceptedRunCount, 8),
      totalReportedCostUsd:
        probeReportedCostUsd !== null &&
        runs.every((run) => run.reportedCostUsd !== null)
          ? round(
              probeReportedCostUsd +
                runs.reduce((sum, run) => sum + (run.reportedCostUsd ?? 0), 0),
              8,
            )
          : null,
      latencyMs: {
        minimum: Math.min(...runs.map((run) => run.elapsedMs)),
        maximum: Math.max(...runs.map((run) => run.elapsedMs)),
        average: round(
          runs.reduce((sum, run) => sum + run.elapsedMs, 0) / runs.length,
          3,
        ),
      },
      tokens: {
        probe: {
          input: Number(
            (probe?.usage as Record<string, unknown> | undefined)
              ?.inputTokens ?? 0,
          ),
          output: Number(
            (probe?.usage as Record<string, unknown> | undefined)
              ?.outputTokens ?? 0,
          ),
        },
        matrix: {
          input: runs.reduce((sum, run) => sum + run.inputTokens, 0),
          output: runs.reduce((sum, run) => sum + run.outputTokens, 0),
        },
      },
    },
    priceSnapshot: PRICE_SNAPSHOT,
    sourceFiles: sourceStart,
    sourceIntegrity,
    runs,
    conclusion: passed
      ? "Task-shaped MODEL-1 gates passed. Candidate is evaluated only; promotion requires a separate owner-approved PR."
      : "Task-shaped MODEL-1 gates failed. Candidate is not eligible for promotion.",
  };
  await writeFinalReport(report);
  progress("evaluation_completed", {
    candidateState: report.candidateState,
    routePromoted: false,
    gates,
    reportPath: path.relative(repositoryRoot, absoluteReportPath),
  });
  if (!passed) process.exitCode = 2;
} catch (error) {
  const unavailable = safeError(error);
  const sourceEnd = await fingerprints();
  const sourceIntegrity = inspectEvaluationSourceBundle(sourceStart, sourceEnd);
  const unavailableReport = {
    schemaVersion: AESTHETIC_REVIEW_EVAL_SCHEMA_VERSION,
    evidenceId: EVIDENCE_ID,
    candidateState: "unavailable",
    routePromoted: false,
    model: {
      requested: MODEL,
      transport: TRANSPORT,
      provider: "gateway",
    },
    catalog: catalog ?? null,
    probe: probe ?? {
      accepted: false,
      ...unavailable,
    },
    matrix: {
      status: probe?.accepted === true ? "interrupted" : "skipped",
      reason: unavailable.reason,
      completedRuns: completedRuns.length,
      expectedRuns: EXPECTED_RUNS,
      remainingRunsNotExecuted: EXPECTED_RUNS - completedRuns.length,
      artifactManifest: completedRuns.map((run) => ({
        path: run.artifactPath,
        sha256: run.artifactFileSha256,
      })),
    },
    sourceFiles: sourceStart,
    sourceIntegrity,
    conclusion:
      "Aesthetic model capability is unavailable. No model-success claim was created; deterministic P4 remains the explicit fallback.",
  };
  await writeFinalReport(unavailableReport);
  progress("capability_unavailable", {
    model: MODEL,
    ...unavailable,
    matrix: "skipped",
    reportPath: path.relative(repositoryRoot, absoluteReportPath),
  });
  process.exitCode = 3;
}
