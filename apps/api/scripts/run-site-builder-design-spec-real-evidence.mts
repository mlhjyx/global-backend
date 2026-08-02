import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCanonicalModelEvaluationCase,
  buildTaskEvaluationPlan,
  ModelEvaluationBudgetGuard,
  ModelEvaluationCapabilityCampaign,
  rankModelEvaluationCandidates,
  runTaskEvaluationAttempt,
  type ModelEvaluationRun,
} from "../src/site-builder/eval/model-evaluation-harness";
import {
  createCredentialBoundModelEvaluationWireClient,
  createFileBackedModelEvaluationAuthorizationLedger,
  createModelEvaluationProtocolExecutor,
  modelEvaluationLedgerAuthorizationClaimCount,
  modelEvaluationLedgerDirectorySha256,
} from "../src/site-builder/eval/model-evaluation-executor";
import {
  createModelEvaluationCostSafetyAttestation,
  SITE_BUILDER_MODEL_EVALUATION_COST_SAFETY_ID,
} from "../src/site-builder/eval/model-evaluation-cost-safety";
import {
  buildDesignSpecEvidencePreflight,
  MAX_OPENOX_CATALOG_BYTES,
  OPENOX_PRICING_CATALOG_URL,
  sha256CanonicalJson,
  type DesignSpecEvidencePreflightReport,
} from "../src/site-builder/eval/design-spec-evidence-preflight";
import {
  createNewApiEvaluationSettlementResolver,
  createRequestIdCapturingFetch,
  designSpecCostAffectingPriceTerms,
  redactModelEvaluationRun,
} from "../src/site-builder/eval/design-spec-real-evidence";
import {
  assertDesignSpecFullRestartCreateOnlyTargetsAvailable,
  buildDesignSpecFullRestartRunBinding,
  DESIGN_SPEC_FULL_RESTART_PREFLIGHT_SOURCE_BUNDLE_ID,
  DESIGN_SPEC_FULL_RESTART_PREFLIGHT_SOURCE_FILES,
} from "../src/site-builder/eval/design-spec-full-restart-prep";
import { writeRepositoryJsonCreateOnly } from "../src/site-builder/eval/create-only-json";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const MANIFEST_PATH =
  "docs/evidence/site-builder/m1-g-design-spec-evaluation-manifest-v1.json";
const MAX_CAMPAIGN_CENTS = 2_920;
const QUOTA_POINTS_PER_CENT = 5_000;
function option(name: string): string | null {
  const values = process.argv
    .slice(2)
    .filter((value) => value.startsWith(`--${name}=`));
  return values.length === 1 ? values[0]!.slice(name.length + 3) : null;
}

function requiredOption(name: string): string {
  const value = option(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function safeLedgerDirectory(value: string): string {
  const resolved = resolve(value);
  const commonGitDirectory = resolve(
    REPOSITORY_ROOT,
    execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    }).trim(),
  );
  const root = resolve(dirname(commonGitDirectory), ".codex/evidence-ledgers");
  const rel = relative(root, resolved);
  if (
    value !== resolved ||
    rel === "" ||
    rel.startsWith("..") ||
    rel.split("/").includes("..")
  )
    throw new Error(
      "ledger directory must be an absolute path under .codex/evidence-ledgers/<run>",
    );
  return resolved;
}

function currentHeadAndClean(): string {
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    },
  ).trim();
  if (dirty)
    throw new Error("real evidence runner requires a clean committed worktree");
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(head))
    throw new Error("fixed runner commit is invalid");
  return head;
}

async function boundedJson(
  url: string,
  init?: RequestInit,
): Promise<{ body: unknown; status: number; sha256: string }> {
  const response = await fetch(url, init);
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes < 0 ||
      declaredBytes > MAX_OPENOX_CATALOG_BYTES
    )
      throw new Error("preflight response exceeds byte limit");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_OPENOX_CATALOG_BYTES)
    throw new Error("preflight response exceeds byte limit");
  return {
    status: response.status,
    body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function sanitizedChannelBinding(): unknown {
  const source = process.env.MODEL_GATEWAY_CHANNEL_BINDING_JSON?.trim();
  if (
    !source ||
    /\b(?:key|token|secret|authorization|password)\b/i.test(source)
  )
    throw new Error("sanitized exact channel binding is required");
  return JSON.parse(source);
}

function exactCriticalPreflight(
  frozen: DesignSpecEvidencePreflightReport,
  live: DesignSpecEvidencePreflightReport,
): void {
  const critical = (value: DesignSpecEvidencePreflightReport) => ({
    status: value.status,
    preflightId: value.preflightId,
    manifestSha256: value.manifestSha256,
    suiteId: value.suiteId,
    fixedSourceCommitSha: value.fixedSourceCommitSha,
    credential: {
      gatewayOrigin: value.credential.gatewayOrigin,
      quotaMode: value.credential.observedQuotaMode,
      scopeExact: value.credential.scopeExact,
      quotaCapPoints: value.credential.quotaCapPoints,
      allowed: value.credential.observedAllowedAliases,
      visible: value.credential.requiredAliasesVisible,
    },
    channelBinding: {
      group: value.channelBinding.group,
      groupRatio: value.channelBinding.groupRatio,
      crossGroupRetry: value.channelBinding.crossGroupRetry,
      exact: value.channelBinding.exact,
      entries: value.channelBinding.entries,
    },
    pricing: designSpecCostAffectingPriceTerms(value.pricing),
    estimate: value.estimate,
    sourceBundle: value.sourceBundle,
  });
  if (
    live.status !== "READY_FOR_PRODUCT_DECISION" ||
    frozen.status !== "READY_FOR_PRODUCT_DECISION" ||
    JSON.stringify(critical(live)) !== JSON.stringify(critical(frozen)) ||
    live.estimate.mechanicalHardCeilingCents !== MAX_CAMPAIGN_CENTS
  )
    throw new Error(
      "live credential, channel, price, manifest, or cost envelope drifted",
    );
}

function exactPreparedSourceBundle(
  frozen: DesignSpecEvidencePreflightReport,
  head: string,
): DesignSpecEvidencePreflightReport["sourceBundle"] {
  const source = frozen.sourceBundle;
  if (
    !/^[a-f0-9]{40}$/.test(source.commitSha) ||
    source.contractId !== DESIGN_SPEC_FULL_RESTART_PREFLIGHT_SOURCE_BUNDLE_ID ||
    JSON.stringify(source.files.map(({ path }) => path)) !==
      JSON.stringify(DESIGN_SPEC_FULL_RESTART_PREFLIGHT_SOURCE_FILES)
  ) {
    throw new Error("frozen full-restart source bundle identity is invalid");
  }
  execFileSync("git", ["merge-base", "--is-ancestor", source.commitSha, head], {
    cwd: REPOSITORY_ROOT,
    stdio: "ignore",
  });
  const filesAt = (commitSha: string) =>
    DESIGN_SPEC_FULL_RESTART_PREFLIGHT_SOURCE_FILES.map((path) => ({
      path,
      sha256: createHash("sha256")
        .update(
          execFileSync("git", ["show", `${commitSha}:${path}`], {
            cwd: REPOSITORY_ROOT,
          }),
        )
        .digest("hex"),
    }));
  const preparedFiles = filesAt(source.commitSha);
  const currentFiles = filesAt(head);
  if (
    JSON.stringify(preparedFiles) !== JSON.stringify(source.files) ||
    JSON.stringify(currentFiles) !== JSON.stringify(source.files) ||
    sha256CanonicalJson(preparedFiles) !== source.sha256
  ) {
    throw new Error("current runner source differs from frozen preflight");
  }
  return source;
}

async function livePreflight(
  manifest: unknown,
  frozen: DesignSpecEvidencePreflightReport,
  gatewayUrl: string,
  token: string,
  head: string,
): Promise<DesignSpecEvidencePreflightReport> {
  const origin = new URL(gatewayUrl).origin;
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const [models, usage, catalog] = await Promise.all([
    boundedJson(`${gatewayUrl.replace(/\/$/, "")}/models`, auth),
    boundedJson(`${origin}/api/usage/token/`, auth),
    boundedJson(OPENOX_PRICING_CATALOG_URL),
  ]);
  const sourceBundle = exactPreparedSourceBundle(frozen, head);
  const report = buildDesignSpecEvidencePreflight({
    manifest,
    capturedAt: new Date().toISOString(),
    gatewayOrigin: origin,
    credentialMaterial: "not_persisted",
    gatewayModels: models.body,
    gatewayUsage: usage.body,
    gatewayChannelBinding: sanitizedChannelBinding(),
    openOxCatalog: catalog.body,
    openOxHttpStatus: catalog.status,
    openOxResponseSha256: catalog.sha256,
    readOnlyNetworkCalls: 3,
    sourceBundle,
  });
  exactCriticalPreflight(frozen, report);
  return report;
}

async function main(): Promise<void> {
  const mode = requiredOption("mode");
  if (mode !== "execute")
    throw new Error("full-restart runner mode must be execute");
  const runBinding = buildDesignSpecFullRestartRunBinding({
    campaignId: requiredOption("campaign-id"),
    preflightPath: requiredOption("preflight"),
    executionPreflightOutputPath: requiredOption("execution-preflight-output"),
    outputPath: requiredOption("output"),
    probeOutputPath: requiredOption("probe-output"),
  });
  const output = runBinding.outputPath;
  const probeOutput = runBinding.probeOutputPath;
  const ledgerDirectory = safeLedgerDirectory(
    requiredOption("ledger-directory"),
  );
  if (basename(ledgerDirectory) !== runBinding.campaignId) {
    throw new Error("ledger directory must end with the exact campaign id");
  }
  assertDesignSpecFullRestartCreateOnlyTargetsAvailable(runBinding, (path) =>
    existsSync(resolve(REPOSITORY_ROOT, path)),
  );
  if (modelEvaluationLedgerAuthorizationClaimCount(ledgerDirectory) !== 0) {
    throw new Error(
      "full-restart ledger already contains an authorization claim",
    );
  }
  const approvedAt = requiredOption("approved-at");
  if (new Date(approvedAt).toISOString() !== approvedAt)
    throw new Error("approved-at must be canonical UTC");
  const authorizationId = requiredOption("authorization-id");
  const gatewayUrl = process.env.MODEL_GATEWAY_URL?.trim();
  const token = process.env.MODEL_GATEWAY_KEY?.trim();
  if (!gatewayUrl || !token)
    throw new Error("MODEL_GATEWAY_URL and MODEL_GATEWAY_KEY are required");

  const head = currentHeadAndClean();
  const [manifest, frozen] = await Promise.all([
    readFile(resolve(REPOSITORY_ROOT, MANIFEST_PATH), "utf8").then(JSON.parse),
    readFile(resolve(REPOSITORY_ROOT, runBinding.preflightPath), "utf8").then(
      JSON.parse,
    ) as Promise<DesignSpecEvidencePreflightReport>,
  ]);
  const preflight = await livePreflight(
    manifest,
    frozen,
    gatewayUrl,
    token,
    head,
  );
  await writeRepositoryJsonCreateOnly(
    REPOSITORY_ROOT,
    runBinding.executionPreflightOutputPath,
    preflight,
  );
  const plan = buildTaskEvaluationPlan("site_builder.design_spec");
  const suite = plan.evaluationSuite;
  if (!suite) throw new Error("design_spec canonical suite is unavailable");
  const preparedCase = buildCanonicalModelEvaluationCase(
    plan,
    suite.fixtureIds[0],
  );
  const remainingPoints = preflight.credential.remainingQuotaPoints;
  const capPoints = preflight.credential.quotaCapPoints;
  if (remainingPoints === null || capPoints === null)
    throw new Error("finite quota is unavailable");
  const remainingQuotaCents = remainingPoints / QUOTA_POINTS_PER_CENT;
  const quotaCapCents = capPoints / QUOTA_POINTS_PER_CENT;
  if (
    remainingQuotaCents !== MAX_CAMPAIGN_CENTS ||
    quotaCapCents !== MAX_CAMPAIGN_CENTS
  )
    throw new Error(
      "evaluation token quota no longer equals the authorized hard ceiling",
    );

  const ledgerId = runBinding.ledgerId;
  const costSafety = createModelEvaluationCostSafetyAttestation({
    contractId: SITE_BUILDER_MODEL_EVALUATION_COST_SAFETY_ID,
    authorization: {
      authorizationId,
      ledgerId,
      ledgerDirectorySha256:
        modelEvaluationLedgerDirectorySha256(ledgerDirectory),
      approvedAt,
      approvedCampaignBudgetCents: MAX_CAMPAIGN_CENTS,
      approvedDispatchExecutions: 73,
      preparedFixedCommitSha: head,
      preparedSuiteId: suite.suiteId,
      preparedSourceBundleContractId: suite.sourceBundleContractId,
      preparedSourceBundleSha256: preparedCase.contract.sourceBundleSha256,
    },
    credential: {
      attestationId: runBinding.credentialAttestationId,
      observedAt: preflight.credential.observedAt!,
      snapshotSha256: sha256CanonicalJson(preflight.credential),
      bearerTokenSha256: createHash("sha256").update(token).digest("hex"),
      gatewayOrigin: new URL(gatewayUrl).origin,
      purpose: "site_builder_model_evaluation",
      quotaMode: "limited",
      scopeExact: true,
      quotaCapCents,
      remainingQuotaCents,
      allowedDispatches: plan.candidates.map((candidate) => ({
        mode: "target" as const,
        alias: candidate.alias,
        protocol: candidate.expectedProtocol,
      })),
    },
    pricing: {
      snapshotId: runBinding.pricingSnapshotId,
      snapshotSha256: preflight.pricing.selectedPricingSha256!,
      basis: "frozen_unit_price_snapshot",
      defaultOrUnconfiguredRatioAllowed: false,
      resolverId: "new-api-request-log-openox/v1",
      entries: preflight.pricing.entries.map((entry) => ({
        alias: entry.alias,
        protocol:
          entry.protocol as (typeof plan.candidates)[number]["expectedProtocol"],
        inputCentsPerMillionTokens: Number(entry.effectiveInputRate) * 100,
        outputCentsPerMillionTokens: Number(entry.effectiveOutputRate) * 100,
      })),
    },
    limits: {
      campaignBudgetCents: MAX_CAMPAIGN_CENTS,
      maxDispatchExecutions: 73,
      maxWireCalls: 146,
      maxPromptUtf8BytesPerCall: 1_048_576,
      maxOutputTokensPerCall: 4_000,
    },
    settlement: {
      requestIdentityField: "executionId",
      requireVerifiedRequestSettlement: true,
      unknownSettlementPolicy: "freeze_campaign",
    },
    media: { genericChannelTest: "forbidden", allowedDispatches: [] },
  });

  const capture = createRequestIdCapturingFetch(fetch);
  const routes = preflight.channelBinding.entries.map(
    ({ alias, protocol, channelId }) => ({
      alias,
      protocol:
        protocol as (typeof plan.candidates)[number]["expectedProtocol"],
      channelId,
    }),
  );
  const prices = costSafety.pricing.entries;
  const settlementResolver = createNewApiEvaluationSettlementResolver({
    gatewayOrigin: costSafety.credential.gatewayOrigin,
    bearerToken: token,
    requestIdsByExecution: capture.requestIdsByExecution,
    routes,
    prices,
    fetch,
  });
  const wireClient = createCredentialBoundModelEvaluationWireClient({
    credential: {
      attestationId: costSafety.credential.attestationId,
      snapshotSha256: costSafety.credential.snapshotSha256,
      bearerTokenSha256: costSafety.credential.bearerTokenSha256,
      gatewayOrigin: costSafety.credential.gatewayOrigin,
      bearerToken: token,
    },
    baseUrl: `${costSafety.credential.gatewayOrigin}/v1`,
    fetch: capture.fetch,
  });
  const authorizationLedger =
    createFileBackedModelEvaluationAuthorizationLedger({
      ledgerId,
      directory: ledgerDirectory,
    });
  const executor = createModelEvaluationProtocolExecutor({
    wireClient,
    settlementResolver,
    costSafety,
    authorizationLedger,
  });
  const budget = new ModelEvaluationBudgetGuard(MAX_CAMPAIGN_CENTS);
  const campaign = new ModelEvaluationCapabilityCampaign(budget);
  const probeCandidate = plan.candidates.find(
    (candidate) => candidate.preflight === "capability_probe",
  );
  if (!probeCandidate)
    throw new Error("GPT-5.5 capability probe candidate is missing");
  const manifestExecutions = (manifest as { executions?: unknown }).executions;
  const declaredProbe = Array.isArray(manifestExecutions)
    ? (manifestExecutions[0] as
        | {
            kind?: unknown;
            alias?: unknown;
            protocol?: unknown;
            fixtureId?: unknown;
            attempt?: unknown;
          }
        | undefined)
    : undefined;
  if (
    !Array.isArray(manifestExecutions) ||
    manifestExecutions.length !== 73 ||
    declaredProbe?.kind !== "capability_probe" ||
    declaredProbe.alias !== probeCandidate.alias ||
    declaredProbe.protocol !== probeCandidate.expectedProtocol ||
    declaredProbe.fixtureId !== suite.fixtureIds[0] ||
    declaredProbe.attempt !== 1
  )
    throw new Error("frozen execution manifest is invalid");
  const runsByAlias = new Map(
    plan.candidates.map((candidate) => [
      candidate.alias,
      [] as ModelEvaluationRun[],
    ]),
  );
  let probeStatus: string | null = null;
  let stopReason: string | null = null;
  try {
    const probe = await campaign.runCanonicalProbe({
      plan,
      candidate: probeCandidate,
      execute: executor.execute,
    });
    probeStatus = probe.status;
    await writeRepositoryJsonCreateOnly(REPOSITORY_ROOT, probeOutput, {
      schemaVersion: "site-builder-design-spec-capability-probe-evidence/v1",
      campaignId: runBinding.campaignId,
      fixedCommitSha: head,
      preparedRunnerCommitSha: preflight.sourceBundle.commitSha,
      suiteId: suite.suiteId,
      frozenPreflightPath: runBinding.preflightPath,
      frozenPreflightReportSha256: frozen.reportSha256,
      executionPreflightPath: runBinding.executionPreflightOutputPath,
      executionPreflightReportSha256: preflight.reportSha256,
      alias: probeCandidate.alias,
      protocol: probeCandidate.expectedProtocol,
      validation: probe,
      budget: budget.snapshot(),
      settlementAccounting: "openox_1_to_1_balance_credit_cents; no market FX",
      responseMaterial: "not_persisted",
    });
    if (probe.status !== "capability_proven") {
      stopReason = `capability_probe_${probe.status}`;
    }

    for (const item of stopReason === null ? manifestExecutions.slice(1) : []) {
      const execution = item as {
        kind?: unknown;
        alias?: unknown;
        protocol?: unknown;
        fixtureId?: unknown;
        attempt?: unknown;
      };
      const candidate = plan.candidates.find(
        (entry) => entry.alias === execution.alias,
      );
      if (
        execution.kind !== "target" ||
        !candidate ||
        candidate.expectedProtocol !== execution.protocol ||
        typeof execution.fixtureId !== "string" ||
        !Number.isSafeInteger(execution.attempt)
      ) {
        stopReason = "frozen_execution_manifest_drifted";
        break;
      }
      const run = await runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: execution.fixtureId,
        attempt: execution.attempt as number,
        campaignBudget: budget,
        capabilityCampaign: campaign,
        execute: executor.execute,
      });
      runsByAlias.get(candidate.alias)!.push(run);
      if (
        run.costSettlement.state === "unknown" ||
        run.budgetCapExceeded ||
        run.settlementInvalid ||
        !run.protocolVerified ||
        !run.identityVerified
      ) {
        stopReason =
          run.failureCode ??
          "settlement_budget_protocol_or_identity_gate_failed";
        break;
      }
    }
  } catch {
    stopReason = "runner_exception";
  }
  const candidateRuns = plan.candidates.map((candidate) => ({
    alias: candidate.alias,
    runs: runsByAlias.get(candidate.alias)!,
  }));
  const rankings =
    stopReason === null
      ? rankModelEvaluationCandidates(plan, candidateRuns, budget, campaign)
      : null;
  await writeRepositoryJsonCreateOnly(REPOSITORY_ROOT, output, {
    schemaVersion: "site-builder-design-spec-real-evidence/v1",
    campaignId: runBinding.campaignId,
    status:
      stopReason === null
        ? "EVIDENCE_CAPTURED_REVIEW_REQUIRED"
        : "EVIDENCE_STOPPED_REVIEW_REQUIRED",
    fixedCommitSha: head,
    preparedRunnerCommitSha: preflight.sourceBundle.commitSha,
    suiteId: suite.suiteId,
    frozenPreflightPath: runBinding.preflightPath,
    frozenPreflightReportSha256: frozen.reportSha256,
    executionPreflightPath: runBinding.executionPreflightOutputPath,
    preflightReportSha256: preflight.reportSha256,
    costSafetySha256: sha256CanonicalJson(costSafety),
    probeEvidencePath: probeOutput,
    probeStatus,
    stopReason,
    budget: budget.snapshot(),
    settlementAccounting:
      "openox_1_to_1_balance_credit_cents; native currencies preserved below; no market FX",
    nativePricing: preflight.pricing.entries.map((entry) => ({
      alias: entry.alias,
      protocol: entry.protocol,
      currency: entry.currency,
      effectiveInputRatePerMillionTokens: entry.effectiveInputRate,
      effectiveOutputRatePerMillionTokens: entry.effectiveOutputRate,
    })),
    rankings,
    runs: candidateRuns.map(({ alias, runs }) => ({
      alias,
      runs: runs.map(redactModelEvaluationRun),
    })),
    responseMaterial: "not_persisted",
    promotion: "NOT_AUTHORIZED",
  });
  process.stdout.write(
    `created ${output}; status=${
      stopReason === null
        ? "EVIDENCE_CAPTURED_REVIEW_REQUIRED"
        : "EVIDENCE_STOPPED_REVIEW_REQUIRED"
    }; promotion=NOT_AUTHORIZED\n`,
  );
  if (stopReason !== null) process.exitCode = 1;
}

await main();
