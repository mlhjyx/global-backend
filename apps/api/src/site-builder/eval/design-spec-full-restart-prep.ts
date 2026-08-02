import { createHash } from "node:crypto";

type JsonRecord = Record<string, unknown>;

const COMMIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CAMPAIGN_ID = /^design-spec-full-restart-[a-z0-9][a-z0-9-]{0,63}$/;
const EVIDENCE_PATH =
  /^docs\/evidence\/site-builder\/[A-Za-z0-9][A-Za-z0-9._/-]*\.json$/;
const PER_WIRE_CALL_CAP_CENTS = 20;
const QUOTA_POINTS_PER_CENT = 5_000;
const REQUIRED_ALIASES = Object.freeze([
  "claude-sonnet-5",
  "gpt-5.5",
  "gpt-5.6-terra",
] as const);
const REQUIRED_PRICE_IDENTITIES = Object.freeze([
  "claude-sonnet-5:anthropic-messages:USD",
  "gpt-5.5:openai-responses:CNY",
  "gpt-5.6-terra:openai-responses:CNY",
] as const);

export const DESIGN_SPEC_FULL_RESTART_CAMPAIGN_ID =
  "design-spec-full-restart-20260802-v1" as const;
export const DESIGN_SPEC_FULL_RESTART_PREFLIGHT_PATH =
  "docs/evidence/site-builder/m1-g-design-spec-full-restart-preflight-v1.json" as const;
export const DESIGN_SPEC_FULL_RESTART_EXECUTION_PREFLIGHT_PATH =
  "docs/evidence/site-builder/m1-g-design-spec-full-restart-execution-preflight-v1.json" as const;
export const DESIGN_SPEC_FULL_RESTART_EVIDENCE_PATH =
  "docs/evidence/site-builder/m1-g-design-spec-full-restart-real-evidence-v1.json" as const;
export const DESIGN_SPEC_FULL_RESTART_PROBE_PATH =
  "docs/evidence/site-builder/m1-g-design-spec-full-restart-capability-probe-v1.json" as const;
export const DESIGN_SPEC_FULL_RESTART_PREFLIGHT_SOURCE_BUNDLE_ID =
  "design-spec-full-restart-preflight-source-bundle/v1" as const;
export const DESIGN_SPEC_FULL_RESTART_PREFLIGHT_SOURCE_FILES = Object.freeze([
  "docs/evidence/site-builder/m1-g-design-spec-evaluation-manifest-v1.json",
  "apps/api/scripts/prepare-site-builder-design-spec-evidence-preflight.mts",
  "apps/api/scripts/run-site-builder-design-spec-real-evidence.mts",
  "apps/api/src/site-builder/agents/task-route-bindings.ts",
  "apps/api/src/site-builder/eval/create-only-json.ts",
  "apps/api/src/site-builder/eval/design-spec-evaluation-manifest-prep.ts",
  "apps/api/src/site-builder/eval/design-spec-evidence-preflight.ts",
  "apps/api/src/site-builder/eval/design-spec-full-restart-prep.ts",
  "apps/api/src/site-builder/eval/design-spec-real-evidence.ts",
  "apps/api/src/site-builder/eval/model-evaluation-cost-safety.ts",
  "apps/api/src/site-builder/eval/model-evaluation-executor.ts",
  "apps/api/src/site-builder/eval/model-evaluation-harness.ts",
  "apps/api/src/site-builder/site-builder-model-settlement.ts",
] as const);

interface EvidenceInput {
  readonly value: unknown;
  readonly sha256: string;
}

export interface DesignSpecFullRestartRunBindingInput {
  readonly campaignId: string;
  readonly preflightPath: string;
  readonly executionPreflightOutputPath: string;
  readonly outputPath: string;
  readonly probeOutputPath: string;
}

export interface DesignSpecFullRestartRunBinding {
  readonly campaignId: string;
  readonly preflightPath: string;
  readonly executionPreflightOutputPath: string;
  readonly outputPath: string;
  readonly probeOutputPath: string;
  readonly ledgerId: string;
  readonly credentialAttestationId: string;
  readonly pricingSnapshotId: string;
}

export interface DesignSpecFullRestartPrepInput {
  readonly preparedFixedCommitSha: string;
  readonly manifest: EvidenceInput;
  readonly resume: EvidenceInput;
  readonly stopped: EvidenceInput;
  readonly reconciliation: EvidenceInput;
  readonly runnerSourceBundle: {
    readonly commitSha: string;
    readonly contractId: typeof DESIGN_SPEC_FULL_RESTART_PREFLIGHT_SOURCE_BUNDLE_ID;
    readonly sha256: string;
    readonly files: readonly {
      readonly path: string;
      readonly sha256: string;
    }[];
  };
}

export interface DesignSpecFullRestartPrepReport {
  readonly schemaVersion: "site-builder-design-spec-full-restart-prep/v1";
  readonly status: "READY_FOR_CREDENTIAL_PREFLIGHT";
  readonly productDecision: "FULL_CANONICAL_CAMPAIGN_RESTART";
  readonly preparedFixedCommitSha: string;
  readonly sourceEvidence: {
    readonly manifestSha256: string;
    readonly resumeDecisionSha256: string;
    readonly stoppedEvidenceSha256: string;
    readonly reconciliationSha256: string;
    readonly runnerSourceBundle: DesignSpecFullRestartPrepInput["runnerSourceBundle"];
  };
  readonly priorCampaign: {
    readonly executionsStarted: 17;
    readonly settledCostCurrency: "CNY";
    readonly settledCostCents: number;
    readonly settledCostUnits: number;
    readonly evidenceReusableForRanking: false;
    readonly probeReusable: false;
    readonly matrixRunsReusable: false;
    readonly ledgerReusable: false;
  };
  readonly restart: {
    readonly campaignId: typeof DESIGN_SPEC_FULL_RESTART_CAMPAIGN_ID;
    readonly dispatchExecutions: 73;
    readonly probeExecutions: 1;
    readonly matrixExecutions: 72;
    readonly maximumWireCalls: 146;
    readonly mechanicalHardCeilingCents: 2920;
    readonly requiredQuotaPoints: 14_600_000;
    readonly currentCanonicalRunnerCanExecute: true;
    readonly scopedResumeRunnerRequired: false;
    readonly targetExecutionsByAlias: Readonly<Record<string, number>>;
    readonly executionKeys: readonly string[];
    readonly executionListSha256: string;
    readonly runBinding: DesignSpecFullRestartRunBinding;
  };
  readonly pricingReference: {
    readonly authority: "openox_model_marketplace";
    readonly capturedAt: string;
    readonly entries: readonly {
      readonly alias: string;
      readonly protocol: string;
      readonly currency: string;
      readonly effectiveInputRatePerMillionTokens: string;
      readonly effectiveOutputRatePerMillionTokens: string;
    }[];
    readonly revalidation: "REQUIRED_BEFORE_COST_AUTHORIZATION";
    readonly expectedCost: "PENDING_FRESH_OPENOX_SNAPSHOT_AND_TOKEN_ENVELOPE";
  };
  readonly credentialGate: {
    readonly status: "FRESH_FINITE_EXACT_CREDENTIAL_REQUIRED";
    readonly purpose: "site_builder_model_evaluation";
    readonly quotaMode: "limited";
    readonly exactAliases: typeof REQUIRED_ALIASES;
    readonly quotaCapPoints: 14_600_000;
    readonly remainingQuotaPoints: 14_600_000;
    readonly credentialMaterial: "not_persisted";
  };
  readonly stopConditions: readonly string[];
  readonly dispatchAuthorization: "NOT_AUTHORIZED";
  readonly actualNetworkCalls: 0;
  readonly actualModelWireCalls: 0;
  readonly actualModelCostCents: 0;
  readonly responseMaterial: "not_persisted";
  readonly promotion: "NOT_AUTHORIZED";
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

function evidenceSha256(input: EvidenceInput, label: string): string {
  if (!SHA256.test(input.sha256))
    throw new Error(`${label} SHA-256 is invalid`);
  return input.sha256;
}

function assertEvidencePath(value: string, label: string): string {
  if (
    !EVIDENCE_PATH.test(value) ||
    value.includes("\\") ||
    value.includes("//") ||
    value.split("/").includes("..")
  ) {
    throw new Error(`${label} must be a safe Site Builder evidence path`);
  }
  return value;
}

export function buildDesignSpecFullRestartRunBinding(
  input: DesignSpecFullRestartRunBindingInput,
): DesignSpecFullRestartRunBinding {
  if (!CAMPAIGN_ID.test(input.campaignId)) {
    throw new Error("campaign id is invalid");
  }
  const preflightPath = assertEvidencePath(
    input.preflightPath,
    "preflight path",
  );
  const outputPath = assertEvidencePath(input.outputPath, "output path");
  const executionPreflightOutputPath = assertEvidencePath(
    input.executionPreflightOutputPath,
    "execution preflight output path",
  );
  const probeOutputPath = assertEvidencePath(
    input.probeOutputPath,
    "probe output path",
  );
  if (
    new Set([
      preflightPath,
      executionPreflightOutputPath,
      outputPath,
      probeOutputPath,
    ]).size !== 4
  ) {
    throw new Error("evidence paths must be distinct");
  }
  if (
    input.campaignId !== DESIGN_SPEC_FULL_RESTART_CAMPAIGN_ID ||
    preflightPath !== DESIGN_SPEC_FULL_RESTART_PREFLIGHT_PATH ||
    executionPreflightOutputPath !==
      DESIGN_SPEC_FULL_RESTART_EXECUTION_PREFLIGHT_PATH ||
    outputPath !== DESIGN_SPEC_FULL_RESTART_EVIDENCE_PATH ||
    probeOutputPath !== DESIGN_SPEC_FULL_RESTART_PROBE_PATH
  ) {
    throw new Error("full-restart evidence binding drifted");
  }
  return Object.freeze({
    campaignId: input.campaignId,
    preflightPath,
    executionPreflightOutputPath,
    outputPath,
    probeOutputPath,
    ledgerId: `design-spec-real-evidence-ledger/${input.campaignId}`,
    credentialAttestationId: `design-spec-evaluation-credential/${input.campaignId}`,
    pricingSnapshotId: `openox-design-spec-prices/${input.campaignId}`,
  });
}

export function assertDesignSpecFullRestartCreateOnlyTargetsAvailable(
  binding: DesignSpecFullRestartRunBinding,
  exists: (path: string) => boolean,
): void {
  for (const path of [
    binding.executionPreflightOutputPath,
    binding.outputPath,
    binding.probeOutputPath,
  ]) {
    if (exists(path)) {
      throw new Error(
        "full-restart create-only evidence target already exists",
      );
    }
  }
}

function runnerSourceBundle(
  input: DesignSpecFullRestartPrepInput,
): DesignSpecFullRestartPrepInput["runnerSourceBundle"] {
  const bundle = input.runnerSourceBundle;
  if (
    bundle.commitSha !== input.preparedFixedCommitSha ||
    bundle.contractId !== DESIGN_SPEC_FULL_RESTART_PREFLIGHT_SOURCE_BUNDLE_ID ||
    !SHA256.test(bundle.sha256) ||
    bundle.files.length === 0 ||
    bundle.files.some(
      ({ path, sha256 }) =>
        path.length === 0 ||
        path.startsWith("/") ||
        path.split("/").includes("..") ||
        !SHA256.test(sha256),
    )
  ) {
    throw new Error("full-restart runner source bundle is invalid");
  }
  return Object.freeze({
    ...bundle,
    files: Object.freeze(
      bundle.files.map((file) => Object.freeze({ ...file })),
    ),
  });
}

function executionKeySha256(keys: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(keys)).digest("hex");
}

export function buildDesignSpecFullRestartPrep(
  input: DesignSpecFullRestartPrepInput,
): DesignSpecFullRestartPrepReport {
  if (!COMMIT_SHA.test(input.preparedFixedCommitSha)) {
    throw new Error("prepared fixed commit SHA is invalid");
  }
  const manifestSha256 = evidenceSha256(input.manifest, "manifest");
  const resumeDecisionSha256 = evidenceSha256(input.resume, "resume decision");
  const stoppedEvidenceSha256 = evidenceSha256(
    input.stopped,
    "stopped evidence",
  );
  const reconciliationSha256 = evidenceSha256(
    input.reconciliation,
    "reconciliation",
  );
  const bundle = runnerSourceBundle(input);
  const manifest = record(input.manifest.value, "manifest");
  const resume = record(input.resume.value, "resume decision");
  const stopped = record(input.stopped.value, "stopped evidence");
  const reconciliation = record(input.reconciliation.value, "reconciliation");
  const executions = array(manifest.executions, "manifest executions").map(
    (value, index) => {
      const execution = record(value, "manifest execution");
      return Object.freeze({
        ordinal: execution.ordinal,
        executionKey: string(execution.executionKey, "execution key"),
        kind: execution.kind,
        alias: execution.alias,
        protocol: execution.protocol,
        maximumWireCalls: execution.maximumWireCalls,
        maximumRepairCalls: execution.maximumRepairCalls,
        expectedOrdinal: index + 1,
      });
    },
  );
  const executionKeys = Object.freeze(
    executions.map(({ executionKey }) => executionKey),
  );
  const targetExecutions = executions.slice(1);
  const targetExecutionsByAlias = Object.freeze(
    Object.fromEntries(
      REQUIRED_ALIASES.map((alias) => [
        alias,
        targetExecutions.filter((execution) => execution.alias === alias)
          .length,
      ]),
    ),
  );
  const expectedProtocol = (alias: unknown): string | null =>
    alias === "claude-sonnet-5"
      ? "anthropic-messages"
      : alias === "gpt-5.5" || alias === "gpt-5.6-terra"
        ? "openai-responses"
        : null;
  if (
    manifest.schemaVersion !==
      "site-builder-design-spec-evaluation-manifest-prep/v1" ||
    manifest.executionCount !== 73 ||
    manifest.maximumWireCallCount !== 146 ||
    record(manifest.planningHardUpperBound, "planning hard upper bound")
      .amountCents !== 2920 ||
    executions.length !== 73 ||
    new Set(executionKeys).size !== 73 ||
    executions.some(
      (execution) =>
        execution.ordinal !== execution.expectedOrdinal ||
        execution.maximumWireCalls !== 2 ||
        execution.maximumRepairCalls !== 1 ||
        expectedProtocol(execution.alias) !== execution.protocol,
    ) ||
    executions[0]?.kind !== "capability_probe" ||
    executions[0]?.alias !== "gpt-5.5" ||
    executions.slice(1).some(({ kind }) => kind !== "target") ||
    Object.values(targetExecutionsByAlias).some((count) => count !== 24)
  ) {
    throw new Error("canonical full-restart manifest is invalid");
  }

  const priorCampaign = record(resume.priorCampaign, "prior campaign");
  const resumePlan = record(resume.resume, "resume plan");
  const stoppedBudget = record(stopped.budget, "stopped budget");
  const ledger = record(reconciliation.ledger, "reconciliation ledger");
  const accounting = record(
    reconciliation.dispatchAccounting,
    "dispatch accounting",
  );
  if (
    resume.schemaVersion !== "site-builder-design-spec-resume-prep/v1" ||
    resume.status !== "READY_FOR_PRODUCT_DECISION" ||
    resume.dispatchAuthorization !== "NOT_AUTHORIZED" ||
    priorCampaign.executionsStarted !== 17 ||
    priorCampaign.authorizationReusable !== false ||
    resumePlan.priorProbeReusable !== false ||
    stopped.status !== "EVIDENCE_STOPPED_REVIEW_REQUIRED" ||
    stopped.promotion !== "NOT_AUTHORIZED" ||
    stoppedBudget.blockReason !== "unknown_settlement" ||
    reconciliation.status !== "RECONCILED_AFTER_CAMPAIGN_FREEZE" ||
    ledger.reusable !== false ||
    accounting.executionsStarted !== 17
  ) {
    throw new Error("prior campaign must remain non-reusable");
  }

  const pricingSnapshot = record(resume.pricingSnapshot, "pricing snapshot");
  const pricingEntries = array(pricingSnapshot.entries, "pricing entries").map(
    (value) => {
      const entry = record(value, "pricing entry");
      return Object.freeze({
        alias: string(entry.alias, "pricing alias"),
        protocol: string(entry.protocol, "pricing protocol"),
        currency: string(entry.currency, "pricing currency"),
        effectiveInputRatePerMillionTokens: string(
          entry.effectiveInputRatePerMillionTokens,
          "effective input rate",
        ),
        effectiveOutputRatePerMillionTokens: string(
          entry.effectiveOutputRatePerMillionTokens,
          "effective output rate",
        ),
      });
    },
  );
  const priceIdentities = pricingEntries
    .map(({ alias, protocol, currency }) => `${alias}:${protocol}:${currency}`)
    .sort();
  if (
    pricingSnapshot.authority !== "openox_model_marketplace" ||
    pricingSnapshot.revalidation !== "REQUIRED_BEFORE_COST_AUTHORIZATION" ||
    JSON.stringify(priceIdentities) !==
      JSON.stringify(REQUIRED_PRICE_IDENTITIES)
  ) {
    throw new Error("frozen OpenOx reference is invalid");
  }
  const priorSettledCost = record(resume.priorSettledCost, "prior cost");
  if (priorSettledCost.currency !== "CNY") {
    throw new Error("prior settled cost is invalid");
  }
  const settledCostCents = number(priorSettledCost.totalCents, "prior cents");
  const settledCostUnits = number(priorSettledCost.totalUnits, "prior units");
  const runBinding = buildDesignSpecFullRestartRunBinding({
    campaignId: DESIGN_SPEC_FULL_RESTART_CAMPAIGN_ID,
    preflightPath: DESIGN_SPEC_FULL_RESTART_PREFLIGHT_PATH,
    executionPreflightOutputPath:
      DESIGN_SPEC_FULL_RESTART_EXECUTION_PREFLIGHT_PATH,
    outputPath: DESIGN_SPEC_FULL_RESTART_EVIDENCE_PATH,
    probeOutputPath: DESIGN_SPEC_FULL_RESTART_PROBE_PATH,
  });
  const maximumWireCalls = 146;
  const mechanicalHardCeilingCents = maximumWireCalls * PER_WIRE_CALL_CAP_CENTS;
  const requiredQuotaPoints =
    mechanicalHardCeilingCents * QUOTA_POINTS_PER_CENT;
  if (
    mechanicalHardCeilingCents !== 2920 ||
    requiredQuotaPoints !== 14_600_000
  ) {
    throw new Error("full-restart cost envelope drifted");
  }

  return Object.freeze({
    schemaVersion: "site-builder-design-spec-full-restart-prep/v1",
    status: "READY_FOR_CREDENTIAL_PREFLIGHT",
    productDecision: "FULL_CANONICAL_CAMPAIGN_RESTART",
    preparedFixedCommitSha: input.preparedFixedCommitSha,
    sourceEvidence: Object.freeze({
      manifestSha256,
      resumeDecisionSha256,
      stoppedEvidenceSha256,
      reconciliationSha256,
      runnerSourceBundle: bundle,
    }),
    priorCampaign: Object.freeze({
      executionsStarted: 17,
      settledCostCurrency: "CNY",
      settledCostCents,
      settledCostUnits,
      evidenceReusableForRanking: false,
      probeReusable: false,
      matrixRunsReusable: false,
      ledgerReusable: false,
    }),
    restart: Object.freeze({
      campaignId: DESIGN_SPEC_FULL_RESTART_CAMPAIGN_ID,
      dispatchExecutions: 73,
      probeExecutions: 1,
      matrixExecutions: 72,
      maximumWireCalls: 146,
      mechanicalHardCeilingCents: 2920,
      requiredQuotaPoints: 14_600_000,
      currentCanonicalRunnerCanExecute: true,
      scopedResumeRunnerRequired: false,
      targetExecutionsByAlias,
      executionKeys,
      executionListSha256: executionKeySha256(executionKeys),
      runBinding,
    }),
    pricingReference: Object.freeze({
      authority: "openox_model_marketplace",
      capturedAt: string(pricingSnapshot.capturedAt, "pricing capturedAt"),
      entries: Object.freeze(pricingEntries),
      revalidation: "REQUIRED_BEFORE_COST_AUTHORIZATION",
      expectedCost: "PENDING_FRESH_OPENOX_SNAPSHOT_AND_TOKEN_ENVELOPE",
    }),
    credentialGate: Object.freeze({
      status: "FRESH_FINITE_EXACT_CREDENTIAL_REQUIRED",
      purpose: "site_builder_model_evaluation",
      quotaMode: "limited",
      exactAliases: REQUIRED_ALIASES,
      quotaCapPoints: 14_600_000,
      remainingQuotaPoints: 14_600_000,
      credentialMaterial: "not_persisted",
    }),
    stopConditions: Object.freeze([
      "fresh_preflight_not_exactly_bound_to_fixed_commit",
      "fresh_finite_exact_credential_missing_or_not_full_cap",
      "openox_price_missing_or_drifted",
      "channel_or_protocol_binding_not_exact",
      "new_authorization_or_ledger_identity_missing_or_reused",
      "separate_real_cost_authorization_missing",
      "capability_probe_not_proven",
      "execution_or_wire_call_manifest_exhausted",
      "protocol_or_model_identity_mismatch",
      "unknown_or_over_budget_settlement",
    ]),
    dispatchAuthorization: "NOT_AUTHORIZED",
    actualNetworkCalls: 0,
    actualModelWireCalls: 0,
    actualModelCostCents: 0,
    responseMaterial: "not_persisted",
    promotion: "NOT_AUTHORIZED",
  } as const);
}

export function renderDesignSpecFullRestartDecisionCard(
  report: DesignSpecFullRestartPrepReport,
): string {
  const priceRows = report.pricingReference.entries
    .map(
      (entry) =>
        `| \`${entry.alias}\` | \`${entry.protocol}\` | ${entry.currency} ${entry.effectiveInputRatePerMillionTokens} | ${entry.currency} ${entry.effectiveOutputRatePerMillionTokens} |`,
    )
    .join("\n");
  return `# M1-g design_spec full canonical restart preparation

Status: **${report.status}**  
Product decision: **${report.productDecision}**  
Dispatch authorization: **${report.dispatchAuthorization}**

## Outcome

- Start one new campaign with **${report.restart.dispatchExecutions} executions** and at most **${report.restart.maximumWireCalls} wire calls**.
- The canonical runner supports this full campaign; no scoped resume or cross-campaign evidence merge is allowed.
- All 17 prior executions remain historical provenance only. Their probe, matrix outputs, authorization and ledger are not reusable for ranking.
- The new campaign requires a fresh GPT-5.5 probe, all 72 matrix executions, a new authorization id and a new durable ledger directory.

## Cost boundary

- Prior reconciled actual cost: **CNY ${report.priorCampaign.settledCostUnits.toFixed(6)}** (${report.priorCampaign.settledCostCents.toFixed(4)} CNY cents).
- Full-restart mechanical hard ceiling: **$${(report.restart.mechanicalHardCeilingCents / 100).toFixed(2)}** (${report.restart.mechanicalHardCeilingCents} policy cents at 20 cents per possible wire call).
- Expected cost remains **not authorizable** until a fresh OpenOx snapshot, exact execution token envelope and full-cap finite credential are frozen.
- Native currencies stay separate; no FX conversion is inferred.

## Historical OpenOx reference only

Captured at: \`${report.pricingReference.capturedAt}\`  
Revalidation: **${report.pricingReference.revalidation}**

| Alias | Protocol | Input / 1M tokens | Output / 1M tokens |
| --- | --- | ---: | ---: |
${priceRows}

## Fresh credential and campaign gate

- Purpose: \`${report.credentialGate.purpose}\`
- Exact aliases: ${report.credentialGate.exactAliases.map((alias) => `\`${alias}\``).join(", ")}
- Required quota cap and remaining balance: \`${report.credentialGate.quotaCapPoints}\` points each.
- Campaign id: \`${report.restart.runBinding.campaignId}\`
- Frozen preflight input: \`${report.restart.runBinding.preflightPath}\`
- Execution preflight output: \`${report.restart.runBinding.executionPreflightOutputPath}\`
- Ledger id: \`${report.restart.runBinding.ledgerId}\`

This preparation made **${report.actualNetworkCalls} network calls**, **${report.actualModelWireCalls} model wire calls**, and incurred **${report.actualModelCostCents} model cost**. It does not create or modify a credential, authorize dispatch, merge evidence, promote a model, or change a runtime route.
`;
}
