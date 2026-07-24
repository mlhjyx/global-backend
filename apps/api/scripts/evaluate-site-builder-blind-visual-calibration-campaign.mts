import "dotenv/config";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  open,
  readFile,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CANDIDATE_GATEWAY_VISION_TRANSPORTS } from "../src/model-gateway/model-transports";
import {
  BLIND_VISUAL_CAMPAIGN_MODELS,
  BLIND_VISUAL_CANDIDATES,
  buildBlindVisualCampaignPreflight,
  buildBlindVisualMatrixDefinition,
  loadBlindVisualPairs,
  summarizeBlindVisualEnsemble,
  type BlindVisualCandidateModel,
  type BlindVisualModelReport,
} from "../src/site-builder/eval/blind-visual-calibration";
import {
  inspectEvaluationSourceBundle,
  prepareEvaluationReportPath,
  sanitizeGatewayBaseUrl,
  sha256Bytes,
  sha256CanonicalJson,
  type EvaluationSourceFingerprint,
} from "../src/site-builder/eval/eval-provenance";

const execFileAsync = promisify(execFile);
const EXECUTION_CONFIRMATION = "BLIND_VISUAL_CALIBRATION_EXECUTE";
const CAMPAIGN_REPORT_PATH = "BLIND_VISUAL_EVAL_CAMPAIGN_REPORT_PATH";
const CATALOG_TIMEOUT_MS = 10_000;
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const STATIC_SOURCE_PATHS = [
  "apps/api/scripts/evaluate-site-builder-blind-visual-calibration.mts",
  "apps/api/scripts/evaluate-site-builder-blind-visual-calibration-campaign.mts",
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

function help(): string {
  return [
    "Blind visual calibration quality-first campaign launcher.",
    "",
    "This command performs all four paid model matrices only when explicitly armed.",
    "",
    "Required environment:",
    `  ${EXECUTION_CONFIRMATION}=1`,
    `  ${CAMPAIGN_REPORT_PATH}=<new repository-relative .json path>`,
    "  BLIND_VISUAL_EVAL_GATEWAY_IMAGE_DIGEST=sha256:<64 lowercase hex>",
    "  MODEL_GATEWAY_URL=<gateway /v1 base URL>",
    "  MODEL_GATEWAY_KEY=<gateway token>",
    "",
    "Before any model call it verifies all four model/transport bindings,",
    "the fixed source bundle, and the immutable screenshot hashes.",
    "Cost is recorded per response and forecast only after this first quality",
    "calibration; it is not a pre-dispatch budget gate.",
    "The fixed candidate order is Gemini, Sonnet, Terra, then Sol; outputs are",
    "never supplied to a later model. This code PR must not arm the command.",
  ].join("\n");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function campaignReportPath(): string {
  const relative = required(CAMPAIGN_REPORT_PATH);
  const absolute = path.resolve(repositoryRoot, relative);
  if (
    path.extname(absolute) !== ".json" ||
    !absolute.startsWith(`${repositoryRoot}${path.sep}`)
  ) {
    throw new Error("BLIND_VISUAL_CAMPAIGN_REPORT_PATH_INVALID");
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
    throw new Error("BLIND_VISUAL_CAMPAIGN_COMMIT_INVALID");
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
    throw new Error("BLIND_VISUAL_CAMPAIGN_SOURCE_PATHS_DIRTY");
  }
}

async function fingerprints(
  sourcePaths: readonly string[],
): Promise<EvaluationSourceFingerprint[]> {
  return Promise.all(
    [...new Set(sourcePaths)].sort().map(async (sourcePath) => ({
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
  return Promise.all(
    [...new Set(sourcePaths)].sort().map(async (sourcePath) => {
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
        return {
          path: sourcePath,
          sha256: sha256Bytes(
            Buffer.from(`BLIND_VISUAL_CAMPAIGN_SOURCE_END_UNAVAILABLE:${code}`),
          ),
        };
      }
    }),
  );
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
    throw new Error(`BLIND_VISUAL_CAMPAIGN_CATALOG_HTTP_${response.status}`);
  }
  const payload = (await response.json()) as {
    data?: Array<{ id?: unknown }>;
  };
  if (!Array.isArray(payload.data)) {
    throw new Error("BLIND_VISUAL_CAMPAIGN_CATALOG_PROTOCOL_INVALID");
  }
  const models = payload.data
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort();
  if (new Set(models).size !== models.length) {
    throw new Error("BLIND_VISUAL_CAMPAIGN_CATALOG_PROTOCOL_INVALID");
  }
  return {
    baseUrl,
    modelCount: models.length,
    modelCatalogSha256: sha256CanonicalJson(models),
    requestedModelListed: models.includes(model),
  };
}

async function runCandidate(input: {
  model: BlindVisualCandidateModel;
  reportPath: string;
  gatewayImageDigest: string;
}): Promise<void> {
  const reportPath = path.relative(repositoryRoot, input.reportPath);
  await execFileAsync(
    "pnpm",
    [
      "--filter",
      "@global/api",
      "exec",
      "tsx",
      "scripts/evaluate-site-builder-blind-visual-calibration.mts",
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        [EXECUTION_CONFIRMATION]: "1",
        BLIND_VISUAL_EVAL_MODEL: input.model,
        BLIND_VISUAL_EVAL_REPORT_PATH: reportPath,
        BLIND_VISUAL_EVAL_GATEWAY_IMAGE_DIGEST: input.gatewayImageDigest,
      },
      maxBuffer: 1_000_000,
    },
  ).catch(() => {
    // Do not surface child stdout/stderr: they can contain provider diagnostics.
    throw new Error(
      `BLIND_VISUAL_CAMPAIGN_CANDIDATE_PROCESS_FAILED: ${input.model}`,
    );
  });
}

async function readCandidateReport(
  reportPath: string,
): Promise<BlindVisualModelReport> {
  const envelope = JSON.parse(await readFile(reportPath, "utf8")) as {
    report?: BlindVisualModelReport;
  };
  if (!envelope.report) {
    throw new Error("BLIND_VISUAL_CAMPAIGN_CANDIDATE_REPORT_INVALID");
  }
  return envelope.report;
}

function knownReportCostCents(report: BlindVisualModelReport): number {
  const completed = [report.probe, ...report.runs]
    .filter((record): record is NonNullable<typeof record> => record !== null)
    .reduce((sum, record) => sum + record.accountedCostUsd * 100, 0);
  if (!report.failure) return Number(completed.toFixed(6));
  const failure = report.failure;
  const failureCostCents = Math.max(
    (failure.reportedCostUsd ?? 0) * 100,
    (failure.calculatedCostUsd ?? 0) * 100,
    failure.preflightCostCeilingCents ?? 0,
  );
  return Number((completed + failureCostCents).toFixed(6));
}

function unknownCostCall(report: BlindVisualModelReport): {
  model: BlindVisualCandidateModel;
  phase: "probe" | "pair";
  runKey: string | null;
} | null {
  if (report.failure?.timeoutSettlement !== "unknown_after_grace") {
    return null;
  }
  return {
    model: report.model,
    phase: report.failure.phase,
    runKey: report.failure.runKey,
  };
}

async function closeClaim(input: {
  claimDirectory: string;
  reportPath: string;
  reportHandle: FileHandle | undefined;
  paidCallsStarted: boolean;
  reportFinalized: boolean;
}): Promise<void> {
  await input.reportHandle?.close();
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
  const outputPath = campaignReportPath();
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
    throw new Error("BLIND_VISUAL_CAMPAIGN_ARTIFACT_PATH_EXISTS");
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
    const catalogs = await Promise.all(
      BLIND_VISUAL_CAMPAIGN_MODELS.map(async (model) => {
        const catalog = await catalogSnapshot(model);
        if (!catalog.requestedModelListed) {
          throw new Error(`BLIND_VISUAL_CAMPAIGN_MODEL_NOT_LISTED: ${model}`);
        }
        if (
          CANDIDATE_GATEWAY_VISION_TRANSPORTS[model] !==
          BLIND_VISUAL_CANDIDATES[model].transport
        ) {
          throw new Error(`BLIND_VISUAL_CAMPAIGN_TRANSPORT_MISMATCH: ${model}`);
        }
        return [model, catalog] as const;
      }),
    );

    reportHandle = await open(outputPath, "wx");
    await mkdir(artifactDirectory, { recursive: false });
    await mkdir(path.join(artifactDirectory, "models"), { recursive: false });
    const reports: Array<{
      model: BlindVisualCandidateModel;
      path: string;
      sha256: string;
      report: BlindVisualModelReport;
    }> = [];
    const candidateLaunchFailures: Array<{
      model: BlindVisualCandidateModel;
      reason: "candidate_process_failed" | "candidate_report_invalid";
    }> = [];
    for (const model of BLIND_VISUAL_CAMPAIGN_MODELS) {
      const candidatePath = path.join(
        artifactDirectory,
        "models",
        `${model}.json`,
      );
      try {
        paidCallsStarted = true;
        await runCandidate({
          model,
          reportPath: candidatePath,
          gatewayImageDigest,
        });
        const bytes = await readFile(candidatePath);
        reports.push({
          model,
          path: path.relative(repositoryRoot, candidatePath),
          sha256: sha256Bytes(bytes),
          report: await readCandidateReport(candidatePath),
        });
      } catch (error) {
        candidateLaunchFailures.push({
          model,
          reason:
            error instanceof Error &&
            error.message === "BLIND_VISUAL_CAMPAIGN_CANDIDATE_REPORT_INVALID"
              ? "candidate_report_invalid"
              : "candidate_process_failed",
        });
      }
    }
    const sourceEnd = await endFingerprints(sourcePaths);
    const sourceIntegrity = inspectEvaluationSourceBundle(
      sourceStart,
      sourceEnd,
    );
    const candidateEvidenceComplete = candidateLaunchFailures.length === 0;
    const evidenceStatus = !sourceIntegrity.stable
      ? "unavailable_source_integrity_changed"
      : candidateEvidenceComplete
        ? "complete"
        : "incomplete_candidate_evidence";
    const ensemble = evidenceStatus === "complete"
      ? summarizeBlindVisualEnsemble(
          reports.map((entry) => entry.report),
          matrixDefinition,
        )
      : null;
    const actualKnownCostCents = Number(
      reports
        .reduce((sum, entry) => sum + knownReportCostCents(entry.report), 0)
      .toFixed(6),
    );
    const unknownCostCalls = reports
      .map((entry) => unknownCostCall(entry.report))
      .filter(
        (call): call is NonNullable<typeof call> => call !== null,
      );
    const postExecutionCostForecast = buildBlindVisualCampaignPreflight(pairs);
    const envelope = {
      schemaVersion:
        "site-builder-blind-visual-calibration-campaign-evidence/v1",
      evidenceStatus,
      execution: {
        commitSha,
        sourceBundleSha256,
        gatewayImageDigest,
        sourceFiles: sourceStart,
        sourceIntegrity,
        matrixDefinition,
        postExecutionCostForecast,
        catalogs: Object.fromEntries(catalogs),
        fixedModelOrder: BLIND_VISUAL_CAMPAIGN_MODELS,
        campaignCostEvidence: {
          accounting: "observed_known_cost_without_predispatch_budget_gate",
          actualKnownCents: actualKnownCostCents,
          actualCostComplete:
            candidateEvidenceComplete && unknownCostCalls.length === 0,
          unknownCostCalls,
          candidateLaunchFailuresMayHaveUnknownCost:
            candidateLaunchFailures.map((failure) => failure.model),
        },
        modelReports: reports.map(({ model, path: reportPath, sha256 }) => ({
          model,
          path: reportPath,
          sha256,
        })),
        candidateLaunchFailures,
      },
      ensemble,
      failure: !sourceIntegrity.stable
        ? {
            reason: "source_integrity_changed",
            changedPaths: sourceIntegrity.changedPaths,
          }
        : candidateEvidenceComplete
          ? null
          : {
              reason: "candidate_evidence_incomplete",
              models: candidateLaunchFailures.map((failure) => failure.model),
            },
      conclusion:
        evidenceStatus === "complete" && ensemble?.combination?.passed
          ? "eligible_for_aesthetic_gold_calibration_only_no_promotion_or_runtime_route_change"
          : "no_promotion_or_runtime_route_change",
    };
    await reportHandle.writeFile(`${JSON.stringify(envelope, null, 2)}\n`);
    await reportHandle.sync();
    reportFinalized = true;
    process.stdout.write(
      `${JSON.stringify({
        event: "blind_visual_calibration_campaign_complete",
        status: envelope.evidenceStatus,
        reportPath: path.relative(repositoryRoot, outputPath),
        modelCount: reports.length,
      })}\n`,
    );
  } finally {
    await closeClaim({
      claimDirectory,
      reportPath: outputPath,
      reportHandle,
      paidCallsStarted,
      reportFinalized,
    });
  }
}

await main();
