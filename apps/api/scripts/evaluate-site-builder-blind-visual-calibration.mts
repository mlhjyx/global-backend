import "dotenv/config";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  open,
  readFile,
  rmdir,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildGatewayProvider } from "../src/model-gateway/model-providers.config";
import { ModelProviderRegistry } from "../src/model-gateway/model-provider.registry";
import { ModelRouter } from "../src/model-gateway/model-router";
import { CANDIDATE_GATEWAY_VISION_TRANSPORTS } from "../src/model-gateway/model-transports";
import {
  ProviderHttpError,
  ProviderOutputError,
} from "../src/model-gateway/providers/provider-output-error";
import { RouterModelGateway } from "../src/model-gateway/router-model-gateway";
import type { ModelResult } from "../src/model-gateway/types";
import { BudgetLedger } from "../src/tools/budget";
import {
  BLIND_VISUAL_COST_ESTIMATE_HEADROOM_CENTS,
  BLIND_VISUAL_COST_ESTIMATOR_VERSION,
  BLIND_VISUAL_MODEL_COST_BOUND_CENTS,
  BLIND_VISUAL_CANDIDATES,
  BLIND_VISUAL_SYSTEM_PROMPT,
  assertBlindVisualOutput,
  buildBlindVisualMatrixDefinition,
  buildBlindVisualPairPlans,
  buildBlindVisualProbePlan,
  estimateBlindVisualCallCostUpperBound,
  loadBlindVisualPairs,
  runBlindVisualCalibrationCandidate,
  type BlindVisualCandidateModel,
  type BlindVisualInvocationRequest,
  type BlindVisualInvoke,
  type BlindVisualModelReport,
  type BlindVisualOutput,
  type BlindVisualProviderResult,
} from "../src/site-builder/eval/blind-visual-calibration";
import { classifyBlindVisualGatewayFailure } from "../src/site-builder/eval/blind-visual-calibration-gateway";
import {
  inspectEvaluationSourceBundle,
  prepareEvaluationReportPath,
  sanitizeGatewayBaseUrl,
  sha256Bytes,
  sha256CanonicalJson,
  type EvaluationSourceFingerprint,
} from "../src/site-builder/eval/eval-provenance";

const execFileAsync = promisify(execFile);
const TASK = "site_builder.aesthetic_review.eval";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const CATALOG_TIMEOUT_MS = 10_000;
const EXECUTION_CONFIRMATION = "BLIND_VISUAL_CALIBRATION_EXECUTE";
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const STATIC_SOURCE_PATHS = [
  "apps/api/scripts/evaluate-site-builder-blind-visual-calibration.mts",
  "apps/api/src/site-builder/eval/blind-visual-calibration.ts",
  "apps/api/src/site-builder/eval/blind-visual-calibration-gateway.ts",
  "apps/api/src/site-builder/eval/aesthetic-review-eval.ts",
  "apps/api/src/site-builder/eval/eval-provenance.ts",
  "apps/api/src/model-gateway/model-providers.config.ts",
  "apps/api/src/model-gateway/model-provider.registry.ts",
  "apps/api/src/model-gateway/model-provider.ts",
  "apps/api/src/model-gateway/model-router.ts",
  "apps/api/src/model-gateway/model-transports.ts",
  "apps/api/src/model-gateway/providers/openai-compatible.provider.ts",
  "apps/api/src/model-gateway/providers/provider-output-error.ts",
  "apps/api/src/model-gateway/router-model-gateway.ts",
  "apps/api/src/model-gateway/schema-validate.ts",
  "apps/api/src/model-gateway/types.ts",
  "apps/api/src/model-gateway/vision-review-input.ts",
  "apps/api/src/tools/budget.ts",
  "apps/site-renderer/visual-tests/__screenshots__/m1-e-b/manifest.json",
  "docs/site-builder/08-eval-testing.md",
  "pnpm-lock.yaml",
] as const;

interface CatalogSnapshot {
  baseUrl: string;
  modelCount: number;
  modelCatalogSha256: string;
  requestedModelListed: boolean;
}

interface ArtifactManifestEntry {
  path: string;
  sha256: string;
  byteLength: number;
}

interface GatewayRuntime {
  gateway: RouterModelGateway;
  budget: BudgetLedger;
  budgetRunId: string;
}

interface CostPreflight {
  estimatorVersion: typeof BLIND_VISUAL_COST_ESTIMATOR_VERSION;
  maxAllowedEstimatedCostCents: number;
  maxEstimatedCostCents: number;
  calls: Array<{
    phase: BlindVisualInvocationRequest["phase"];
    opaqueRunId: string;
    estimatedInputTokens: number;
    outputTokenCeiling: number;
    estimatedCostCents: number;
  }>;
}

function help(): string {
  return [
    "Blind visual calibration local evidence runner.",
    "",
    "This command performs paid model calls only when explicitly armed.",
    "",
    "Required environment:",
    `  ${EXECUTION_CONFIRMATION}=1`,
    "  BLIND_VISUAL_EVAL_MODEL=<gemini-3.5-flash|claude-sonnet-5|gpt-5.6-terra|gpt-5.6-sol>",
    "  BLIND_VISUAL_EVAL_REPORT_PATH=<new repository-relative .json path>",
    "  BLIND_VISUAL_EVAL_GATEWAY_IMAGE_DIGEST=sha256:<64 lowercase hex>",
    "  MODEL_GATEWAY_URL=<gateway /v1 base URL>",
    "  MODEL_GATEWAY_KEY=<gateway token>",
    "",
    "The report and sibling .artifacts directory are create-only. This PR must",
    "not run the command; real four-model execution belongs to the evidence PR.",
  ].join("\n");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function candidateModel(): BlindVisualCandidateModel {
  const requested = required("BLIND_VISUAL_EVAL_MODEL");
  if (!(requested in BLIND_VISUAL_CANDIDATES)) {
    throw new Error(`BLIND_VISUAL_EVAL_MODEL_UNSUPPORTED: ${requested}`);
  }
  return requested as BlindVisualCandidateModel;
}

function reportPath(): string {
  const relative = required("BLIND_VISUAL_EVAL_REPORT_PATH");
  const absolute = path.resolve(repositoryRoot, relative);
  if (
    path.extname(absolute) !== ".json" ||
    !absolute.startsWith(`${repositoryRoot}${path.sep}`)
  ) {
    throw new Error("BLIND_VISUAL_EVAL_REPORT_PATH_INVALID");
  }
  return absolute;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function fixedCommitSha(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
  });
  const commitSha = stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(commitSha)) {
    throw new Error("BLIND_VISUAL_EVAL_COMMIT_INVALID");
  }
  return commitSha;
}

async function assertSourcePathsClean(
  sourcePaths: readonly string[],
): Promise<void> {
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain", "--", ...sourcePaths],
    { cwd: repositoryRoot },
  );
  if (stdout.trim().length > 0) {
    throw new Error("BLIND_VISUAL_EVAL_SOURCE_PATHS_DIRTY");
  }
}

async function fingerprints(
  sourcePaths: readonly string[],
): Promise<EvaluationSourceFingerprint[]> {
  const unique = [...new Set(sourcePaths)].sort();
  return Promise.all(
    unique.map(async (sourcePath) => ({
      path: sourcePath,
      sha256: sha256Bytes(
        await readFile(path.join(repositoryRoot, sourcePath)),
      ),
    })),
  );
}

async function endFingerprints(
  sourcePaths: readonly string[],
): Promise<EvaluationSourceFingerprint[]> {
  const unique = [...new Set(sourcePaths)].sort();
  return Promise.all(
    unique.map(async (sourcePath) => {
      try {
        return {
          path: sourcePath,
          sha256: sha256Bytes(
            await readFile(path.join(repositoryRoot, sourcePath)),
          ),
        };
      } catch (error) {
        const code =
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "UNKNOWN";
        // A missing/unreadable end source is itself deterministic drift. Hash
        // only a bounded code; never persist host paths or raw error text.
        return {
          path: sourcePath,
          sha256: sha256Bytes(
            Buffer.from(`BLIND_VISUAL_SOURCE_END_UNAVAILABLE:${code}`),
          ),
        };
      }
    }),
  );
}

function plannedRequests(
  candidate: (typeof BLIND_VISUAL_CANDIDATES)[BlindVisualCandidateModel],
  pairs: Awaited<ReturnType<typeof loadBlindVisualPairs>>,
): BlindVisualInvocationRequest[] {
  return [
    buildBlindVisualProbePlan(candidate, pairs).request,
    ...buildBlindVisualPairPlans(candidate, pairs).map((plan) => plan.request),
  ];
}

function fixtureDigestCatalog(
  requests: readonly BlindVisualInvocationRequest[],
): Readonly<Record<string, string>> {
  const entries = requests.flatMap((request) =>
    request.images.map((image) => [image.artifactId, image.sha256] as const),
  );
  if (
    new Set(entries.map(([artifactId]) => artifactId)).size !== entries.length
  ) {
    throw new Error("BLIND_VISUAL_EVAL_FIXTURE_ID_DUPLICATE");
  }
  return Object.freeze(Object.fromEntries(entries));
}

function costPreflight(
  candidate: (typeof BLIND_VISUAL_CANDIDATES)[BlindVisualCandidateModel],
  requests: readonly BlindVisualInvocationRequest[],
): CostPreflight {
  const maxAllowedEstimatedCostCents =
    candidate.maxCostCents - BLIND_VISUAL_COST_ESTIMATE_HEADROOM_CENTS;
  const calls = requests.map((request) => {
    const estimate = estimateBlindVisualCallCostUpperBound({
      candidate,
      request,
      systemPrompt: BLIND_VISUAL_SYSTEM_PROMPT,
    });
    if (estimate.totalCostCents > maxAllowedEstimatedCostCents) {
      throw new Error(
        `BLIND_VISUAL_EVAL_ESTIMATED_CALL_COST_EXCEEDED: ${request.opaqueRunId}`,
      );
    }
    return {
      phase: request.phase,
      opaqueRunId: request.opaqueRunId,
      estimatedInputTokens: estimate.inputTokens,
      outputTokenCeiling: estimate.outputTokens,
      estimatedCostCents: estimate.totalCostCents,
    };
  });
  return {
    estimatorVersion: BLIND_VISUAL_COST_ESTIMATOR_VERSION,
    maxAllowedEstimatedCostCents,
    maxEstimatedCostCents: Math.max(
      ...calls.map((call) => call.estimatedCostCents),
    ),
    calls,
  };
}

function createGateway(
  fixtureDigests: Readonly<Record<string, string>>,
  model: BlindVisualCandidateModel,
  commitSha: string,
): GatewayRuntime {
  const provider = buildGatewayProvider(process.env, {
    visionEvalFixtureDigests: fixtureDigests,
  });
  if (!provider || provider.id !== "gateway") {
    throw new Error("BLIND_VISUAL_EVAL_GATEWAY_UNAVAILABLE");
  }
  const registry = new ModelProviderRegistry();
  registry.register(provider);
  const gateway = new RouterModelGateway(new ModelRouter(registry));
  const budget = new BudgetLedger();
  const budgetRunId = `blind-visual-calibration:${commitSha}:${model}`;
  budget.open(budgetRunId, BLIND_VISUAL_MODEL_COST_BOUND_CENTS);
  gateway.budget = budget;
  return { gateway, budget, budgetRunId };
}

async function catalogSnapshot(
  model: BlindVisualCandidateModel,
): Promise<CatalogSnapshot> {
  const baseUrl = sanitizeGatewayBaseUrl(required("MODEL_GATEWAY_URL"));
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${required("MODEL_GATEWAY_KEY")}` },
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`BLIND_VISUAL_EVAL_CATALOG_HTTP_${response.status}`);
  }
  const payload = (await response.json()) as {
    data?: Array<{ id?: unknown }>;
  };
  if (!Array.isArray(payload.data)) {
    throw new Error("BLIND_VISUAL_EVAL_CATALOG_PROTOCOL_INVALID");
  }
  const models = payload.data
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort();
  if (new Set(models).size !== models.length) {
    throw new Error("BLIND_VISUAL_EVAL_CATALOG_PROTOCOL_INVALID");
  }
  return {
    baseUrl,
    modelCount: models.length,
    modelCatalogSha256: sha256CanonicalJson(models),
    requestedModelListed: models.includes(model),
  };
}

function gatewayInvoke(
  gateway: RouterModelGateway,
  model: BlindVisualCandidateModel,
  correlationId: string,
  budgetRunId: string,
): BlindVisualInvoke {
  return async (request: BlindVisualInvocationRequest) => {
    if (request.model !== model) {
      throw new Error("BLIND_VISUAL_EVAL_REQUEST_MODEL_MISMATCH");
    }
    const actualTransport = CANDIDATE_GATEWAY_VISION_TRANSPORTS[model];
    if (!actualTransport || actualTransport !== request.transport) {
      throw new Error("BLIND_VISUAL_EVAL_TRANSPORT_MISMATCH");
    }
    const startedAt = performance.now();
    try {
      const result: ModelResult<BlindVisualOutput> =
        await gateway.reviewVision<BlindVisualOutput>(
          {
            task: TASK,
            prompt: request.prompt,
            system: BLIND_VISUAL_SYSTEM_PROMPT,
            model: request.model,
            schema: request.schema,
            images: request.images,
            validateOutput: (value) =>
              assertBlindVisualOutput(
                value,
                request.images.length === 3 ? 3 : 2,
              ),
            maxTokens: request.maxTokens,
            maxCostCents: request.maxCostCents,
            signal: request.signal,
          },
          {
            workspaceId: WORKSPACE_ID,
            correlationId,
            runId: budgetRunId,
          },
        );
      return {
        data: result.data,
        requestedModel: request.model,
        reportedModel: result.reportedModel ?? "",
        resolvedModel: result.model,
        provider: result.provider,
        transport: actualTransport,
        elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
        usage: {
          inputTokens: result.usage?.inputTokens ?? Number.NaN,
          outputTokens: result.usage?.outputTokens ?? Number.NaN,
          costUsd: result.usage?.costUsd ?? null,
        },
        finishReason: null,
      };
    } catch (error) {
      return providerFailureResult(
        error,
        request,
        actualTransport,
        Number((performance.now() - startedAt).toFixed(3)),
      );
    }
  };
}

function providerFailureResult(
  error: unknown,
  request: BlindVisualInvocationRequest,
  transport: BlindVisualProviderResult["transport"],
  elapsedMs: number,
): BlindVisualProviderResult {
  const providerError =
    error instanceof ProviderOutputError ? error : undefined;
  const httpError = error instanceof ProviderHttpError ? error : undefined;
  const reason = classifyBlindVisualGatewayFailure(error);
  return {
    data: null,
    failureReason: reason,
    requestedModel: request.model,
    reportedModel: providerError?.reportedModel ?? "",
    resolvedModel: providerError?.model ?? httpError?.model ?? "",
    provider: providerError?.provider ?? httpError?.provider ?? "",
    transport,
    elapsedMs,
    usage: {
      inputTokens: providerError?.usage?.inputTokens ?? Number.NaN,
      outputTokens: providerError?.usage?.outputTokens ?? Number.NaN,
      costUsd: null,
    },
    finishReason: reason === "truncated" ? "max_tokens" : null,
    truncated: reason === "truncated",
  };
}

async function writeArtifact(
  artifactDirectory: string,
  filename: string,
  value: unknown,
): Promise<ArtifactManifestEntry> {
  const target = path.join(artifactDirectory, filename);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeFile(target, bytes, { flag: "wx" });
  return {
    path: path.relative(repositoryRoot, target),
    sha256: sha256Bytes(bytes),
    byteLength: bytes.byteLength,
  };
}

async function persistArtifacts(
  artifactDirectory: string,
  report: BlindVisualModelReport,
): Promise<ArtifactManifestEntry[]> {
  await mkdir(artifactDirectory, { recursive: false });
  const manifest: ArtifactManifestEntry[] = [];
  if (report.probe) {
    manifest.push(
      await writeArtifact(artifactDirectory, "probe.json", report.probe),
    );
  }
  for (const [index, run] of report.runs.entries()) {
    manifest.push(
      await writeArtifact(
        artifactDirectory,
        `run-${String(index + 1).padStart(2, "0")}.json`,
        run,
      ),
    );
  }
  if (report.failure) {
    manifest.push(
      await writeArtifact(artifactDirectory, "failure.json", report.failure),
    );
  }
  return manifest;
}

async function closeReportClaim(input: {
  claimDirectory: string;
  reportPath: string;
  reportHandle: FileHandle | undefined;
  paidCallsStarted: boolean;
  reportFinalized: boolean;
}): Promise<void> {
  await input.reportHandle?.close();
  // A preflight failure is safe to retry, and a finalized report no longer
  // needs the claim. If paid calls started but finalization failed, retain the
  // directory as an explicit collision guard for manual recovery.
  if (!input.paidCallsStarted || input.reportFinalized) {
    if (
      input.reportHandle &&
      !input.paidCallsStarted &&
      !input.reportFinalized
    ) {
      await unlink(input.reportPath);
    }
    await rmdir(input.claimDirectory);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  if (process.env[EXECUTION_CONFIRMATION] !== "1") {
    throw new Error(
      `${EXECUTION_CONFIRMATION}=1 is required; refusing paid model calls`,
    );
  }
  const model = candidateModel();
  const candidate = BLIND_VISUAL_CANDIDATES[model];
  const outputPath = reportPath();
  const artifactDirectory = path.join(
    path.dirname(outputPath),
    `${path.basename(outputPath, ".json")}.artifacts`,
  );
  const claimDirectory = `${outputPath}.claim`;
  const gatewayImageDigest = required("BLIND_VISUAL_EVAL_GATEWAY_IMAGE_DIGEST");
  if (!/^sha256:[a-f0-9]{64}$/.test(gatewayImageDigest)) {
    throw new Error("BLIND_VISUAL_EVAL_GATEWAY_IMAGE_DIGEST_INVALID");
  }
  await prepareEvaluationReportPath(outputPath);
  if (await pathExists(artifactDirectory)) {
    throw new Error("BLIND_VISUAL_EVAL_ARTIFACT_PATH_EXISTS");
  }
  await mkdir(claimDirectory, { recursive: false });
  let reportHandle: FileHandle | undefined;
  let paidCallsStarted = false;
  let reportFinalized = false;
  try {
    const pairs = await loadBlindVisualPairs(repositoryRoot);
    const matrixDefinition = buildBlindVisualMatrixDefinition(pairs);
    const sourcePaths = [
      ...STATIC_SOURCE_PATHS,
      ...pairs.map((pair) => pair.sourcePath),
    ];
    await assertSourcePathsClean(sourcePaths);
    const sourceStart = await fingerprints(sourcePaths);
    const commitSha = await fixedCommitSha();
    const sourceBundleSha256 = sha256CanonicalJson({
      sourceFiles: sourceStart,
      matrixDefinition,
    });
    const catalog = await catalogSnapshot(model);
    if (!catalog.requestedModelListed) {
      throw new Error(`BLIND_VISUAL_EVAL_MODEL_NOT_LISTED: ${model}`);
    }
    const requests = plannedRequests(candidate, pairs);
    const fixtureDigests = fixtureDigestCatalog(requests);
    const callCostPreflight = costPreflight(candidate, requests);
    const runtime = createGateway(fixtureDigests, model, commitSha);
    reportHandle = await open(outputPath, "wx");
    let report: BlindVisualModelReport;
    let budgetRemainingCents: number;
    const invoke = gatewayInvoke(
      runtime.gateway,
      model,
      runtime.budgetRunId,
      runtime.budgetRunId,
    );
    try {
      report = await runBlindVisualCalibrationCandidate({
        repositoryRoot,
        candidate,
        provenance: { commitSha, sourceBundleSha256 },
        invoke: (request) => {
          paidCallsStarted = true;
          return invoke(request);
        },
      });
      budgetRemainingCents = runtime.budget.remainingCents(runtime.budgetRunId);
    } finally {
      runtime.budget.close(runtime.budgetRunId, { force: true });
    }
    const sourceEnd = await endFingerprints(sourcePaths);
    const sourceIntegrity = inspectEvaluationSourceBundle(
      sourceStart,
      sourceEnd,
    );
    const artifactManifest = await persistArtifacts(artifactDirectory, report);
    const evidenceStatus = sourceIntegrity.stable
      ? "complete"
      : "unavailable_source_integrity_changed";
    const envelope = {
      schemaVersion: "site-builder-blind-visual-calibration-evidence/v1",
      evidenceStatus,
      execution: {
        commitSha,
        sourceBundleSha256,
        gatewayImageDigest,
        model,
        transport: candidate.transport,
        catalog,
        sourceFiles: sourceStart,
        sourceIntegrity,
        fixtureCatalogSha256: sha256CanonicalJson(fixtureDigests),
        budget: {
          capCents: BLIND_VISUAL_MODEL_COST_BOUND_CENTS,
          remainingCents: budgetRemainingCents,
        },
        callCostPreflight,
        artifactManifest,
      },
      failure: sourceIntegrity.stable
        ? null
        : {
            reason: "source_integrity_changed",
            changedPaths: sourceIntegrity.changedPaths,
          },
      report,
      conclusion: !sourceIntegrity.stable
        ? "unavailable_source_integrity_changed_no_model_selection_claim"
        : report.status === "single_model_gate_passed"
          ? "single_model_gate_passed_only_no_promotion_or_runtime_route_change"
          : "no_promotion_or_runtime_route_change",
    };
    await reportHandle.writeFile(`${JSON.stringify(envelope, null, 2)}\n`);
    await reportHandle.sync();
    reportFinalized = true;
    process.stdout.write(
      `${JSON.stringify({
        event: "blind_visual_calibration_complete",
        model,
        status: evidenceStatus,
        modelStatus: report.status,
        reportPath: path.relative(repositoryRoot, outputPath),
        artifactCount: artifactManifest.length,
      })}\n`,
    );
  } finally {
    await closeReportClaim({
      claimDirectory,
      reportPath: outputPath,
      reportHandle,
      paidCallsStarted,
      reportFinalized,
    });
  }
}

await main();
