const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const PER_WIRE_CALL_CAP_CENTS = 20;

type JsonRecord = Record<string, unknown>;

interface EvidenceInput {
  value: unknown;
  sha256: string;
}

export interface DesignSpecResumePrepInput {
  preparedFixedCommitSha: string;
  manifest: EvidenceInput;
  preflight: EvidenceInput;
  stopped: EvidenceInput;
  probe: EvidenceInput;
  reconciliation: EvidenceInput;
}

export interface DesignSpecResumeExecution {
  resumeOrdinal: number;
  sourceOrdinal: number;
  executionKey: string;
  kind: "capability_probe" | "target";
  alias: string;
  protocol: string;
  fixtureId: string;
  attempt: number;
  maximumWireCalls: 2;
  maximumRepairCalls: 1;
}

export interface DesignSpecResumePrepReport {
  schemaVersion: "site-builder-design-spec-resume-prep/v1";
  status: "READY_FOR_PRODUCT_DECISION";
  preparedFixedCommitSha: string;
  sourceEvidence: {
    manifestSha256: string;
    preflightSha256: string;
    executionPreflightReportSha256: string;
    stoppedEvidenceSha256: string;
    probeEvidenceSha256: string;
    reconciliationSha256: string;
  };
  pricingSnapshot: {
    authority: "openox_model_marketplace";
    capturedAt: string;
    entries: readonly {
      alias: string;
      protocol: string;
      currency: string;
      effectiveInputRatePerMillionTokens: string;
      effectiveOutputRatePerMillionTokens: string;
    }[];
    revalidation: "REQUIRED_BEFORE_COST_AUTHORIZATION";
  };
  priorSettledCost: {
    currency: "CNY";
    totalCents: number;
    totalUnits: number;
  };
  priorCampaign: {
    executionsStarted: 17;
    probeExecutions: 1;
    matrixExecutionsConsumed: 16;
    authorizationReusable: false;
  };
  resume: {
    remainingMatrixExecutions: 56;
    newProcessProbeExecutions: 1;
    minimumFutureDispatchExecutions: 57;
    maximumFutureWireCalls: 114;
    mechanicalHardCeilingCents: number;
    priorProbeReusable: false;
    priorProbeReuseReason: "TRUSTED_IN_MEMORY_CAMPAIGN_ONLY";
    currentRunnerCanResumeAsIs: false;
    currentRunnerCapacity: "73_EXECUTIONS_146_WIRE_CALLS";
    requiredImplementation:
      | "SCOPED_RESUME_RUN_AND_EVIDENCE_MERGE_CONTRACT"
      | "FULL_CANONICAL_CAMPAIGN_RESTART";
  };
  settlementPolling: {
    previousMaximumWaitMs: 2000;
    proposedDelaysMs: readonly [250, 500, 1000, 2000, 4000, 8000, 12000];
    proposedMaximumWaitMs: 27750;
    unknownAfterWindowPolicy: "FREEZE_CAMPAIGN";
  };
  executions: readonly DesignSpecResumeExecution[];
  dispatchAuthorization: "NOT_AUTHORIZED";
  actualNetworkCalls: 0;
  actualModelWireCalls: 0;
  actualModelCostCents: 0;
  credentialMaterial: "not_persisted";
  responseMaterial: "not_persisted";
  promotion: "NOT_AUTHORIZED";
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

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function evidenceSha256(input: EvidenceInput, label: string): string {
  if (!SHA256.test(input.sha256)) {
    throw new Error(`${label} SHA-256 is invalid`);
  }
  return input.sha256;
}

function manifestExecution(value: unknown): DesignSpecResumeExecution {
  const item = record(value, "manifest execution");
  const kind = string(item.kind, "manifest execution kind");
  if (kind !== "capability_probe" && kind !== "target") {
    throw new Error("manifest execution kind is invalid");
  }
  if (item.maximumWireCalls !== 2 || item.maximumRepairCalls !== 1) {
    throw new Error("manifest execution repair ceiling drifted");
  }
  return {
    resumeOrdinal: 0,
    sourceOrdinal: integer(item.ordinal, "manifest execution ordinal"),
    executionKey: string(item.executionKey, "manifest execution key"),
    kind,
    alias: string(item.alias, "manifest execution alias"),
    protocol: string(item.protocol, "manifest execution protocol"),
    fixtureId: string(item.fixtureId, "manifest execution fixture"),
    attempt: integer(item.attempt, "manifest execution attempt"),
    maximumWireCalls: 2,
    maximumRepairCalls: 1,
  };
}

function stoppedRunKey(
  groupAlias: string,
  value: unknown,
): {
  executionKey: string;
  run: JsonRecord;
} {
  const run = record(value, "stopped run");
  const alias = string(run.alias, "stopped run alias");
  if (alias !== groupAlias) throw new Error("stopped run alias group drifted");
  return {
    executionKey: [
      "target",
      alias,
      string(run.expectedProtocol, "stopped run protocol"),
      string(run.fixtureId, "stopped run fixture"),
      integer(run.attempt, "stopped run attempt"),
    ].join("/"),
    run,
  };
}

export function buildDesignSpecResumePrep(
  input: DesignSpecResumePrepInput,
): DesignSpecResumePrepReport {
  if (!COMMIT_SHA.test(input.preparedFixedCommitSha)) {
    throw new Error("prepared fixed commit SHA is invalid");
  }
  const manifestSha256 = evidenceSha256(input.manifest, "manifest");
  const preflightSha256 = evidenceSha256(input.preflight, "preflight");
  const stoppedEvidenceSha256 = evidenceSha256(
    input.stopped,
    "stopped evidence",
  );
  const probeEvidenceSha256 = evidenceSha256(input.probe, "probe evidence");
  const reconciliationSha256 = evidenceSha256(
    input.reconciliation,
    "reconciliation",
  );
  const manifest = record(input.manifest.value, "manifest");
  const preflight = record(input.preflight.value, "preflight");
  const stopped = record(input.stopped.value, "stopped evidence");
  const probe = record(input.probe.value, "probe evidence");
  const reconciliation = record(input.reconciliation.value, "reconciliation");

  const pricing = record(preflight.pricing, "preflight pricing");
  const pricingEntries = array(
    pricing.entries,
    "preflight pricing entries",
  ).map((value) => {
    const entry = record(value, "preflight price entry");
    return Object.freeze({
      alias: string(entry.alias, "price alias"),
      protocol: string(entry.protocol, "price protocol"),
      currency: string(entry.currency, "price currency"),
      effectiveInputRatePerMillionTokens: string(
        entry.effectiveInputRate,
        "effective input price",
      ),
      effectiveOutputRatePerMillionTokens: string(
        entry.effectiveOutputRate,
        "effective output price",
      ),
    });
  });
  const expectedPrices = [
    "claude-sonnet-5:anthropic-messages:USD",
    "gpt-5.5:openai-responses:CNY",
    "gpt-5.6-terra:openai-responses:CNY",
  ];
  const actualPrices = pricingEntries
    .map(({ alias, protocol, currency }) => `${alias}:${protocol}:${currency}`)
    .sort();
  if (
    preflight.schemaVersion !==
      "site-builder-design-spec-evidence-preflight/v2" ||
    !SHA256.test(string(preflight.reportSha256, "preflight report SHA-256")) ||
    pricing.authority !== "openox_model_marketplace" ||
    pricingEntries.length !== 3 ||
    JSON.stringify(actualPrices) !== JSON.stringify(expectedPrices)
  ) {
    throw new Error("frozen OpenOx pricing snapshot is invalid");
  }

  const executions = array(manifest.executions, "manifest executions").map(
    manifestExecution,
  );
  if (
    manifest.schemaVersion !==
      "site-builder-design-spec-evaluation-manifest-prep/v1" ||
    manifest.executionCount !== 73 ||
    manifest.maximumWireCallCount !== 146 ||
    executions.length !== 73 ||
    new Set(executions.map(({ executionKey }) => executionKey)).size !== 73 ||
    executions.some(({ sourceOrdinal }, index) => sourceOrdinal !== index + 1)
  ) {
    throw new Error("canonical 73-execution manifest is invalid");
  }
  const declaredProbe = executions[0];
  if (
    declaredProbe?.kind !== "capability_probe" ||
    declaredProbe.alias !== "gpt-5.5" ||
    declaredProbe.protocol !== "openai-responses"
  ) {
    throw new Error("canonical GPT-5.5 probe is invalid");
  }
  if (
    probe.schemaVersion !==
      "site-builder-design-spec-capability-probe-evidence/v1" ||
    probe.responseMaterial !== "not_persisted" ||
    record(probe.validation, "probe validation").status !== "capability_proven"
  ) {
    throw new Error("persisted probe evidence is invalid");
  }
  if (
    stopped.schemaVersion !== "site-builder-design-spec-real-evidence/v1" ||
    stopped.status !== "EVIDENCE_STOPPED_REVIEW_REQUIRED" ||
    stopped.probeStatus !== "capability_proven" ||
    stopped.stopReason !==
      "settlement_budget_protocol_or_identity_gate_failed" ||
    stopped.responseMaterial !== "not_persisted" ||
    stopped.promotion !== "NOT_AUTHORIZED"
  ) {
    throw new Error("stopped evidence boundary is invalid");
  }
  const executionPreflightReportSha256 = string(
    stopped.preflightReportSha256,
    "execution preflight report SHA-256",
  );
  if (!SHA256.test(executionPreflightReportSha256)) {
    throw new Error("execution preflight report SHA-256 is invalid");
  }

  const observedRuns = array(stopped.runs, "stopped candidate groups").flatMap(
    (groupValue) => {
      const group = record(groupValue, "stopped candidate group");
      const alias = string(group.alias, "stopped candidate alias");
      return array(group.runs, "stopped candidate runs").map((run) =>
        stoppedRunKey(alias, run),
      );
    },
  );
  const targetExecutions = executions.slice(1);
  const targetCounts = new Map<string, number>();
  for (const execution of targetExecutions) {
    const expectedProtocol =
      execution.alias === "claude-sonnet-5"
        ? "anthropic-messages"
        : "openai-responses";
    if (
      !["gpt-5.6-terra", "gpt-5.5", "claude-sonnet-5"].includes(
        execution.alias,
      ) ||
      execution.protocol !== expectedProtocol
    ) {
      throw new Error("canonical target route set drifted");
    }
    targetCounts.set(
      execution.alias,
      (targetCounts.get(execution.alias) ?? 0) + 1,
    );
  }
  if (
    [...targetCounts.values()].some((count) => count !== 24) ||
    targetCounts.size !== 3
  ) {
    throw new Error("canonical target matrix drifted");
  }
  if (
    observedRuns.some(({ run }) => {
      const assessment = run.assessment;
      return (
        run.artifactRetention !== "digest_only" ||
        Object.hasOwn(run, "artifact") ||
        (assessment !== null &&
          (typeof assessment !== "object" ||
            Array.isArray(assessment) ||
            Object.hasOwn(assessment, "stabilityKey") ||
            !SHA256.test(
              string(
                (assessment as JsonRecord).stabilityKeySha256,
                "redacted stability key SHA-256",
              ),
            )))
      );
    })
  ) {
    throw new Error("stopped run contains response material");
  }
  const observedKeys = observedRuns.map(({ executionKey }) => executionKey);
  const expectedPrefix = targetExecutions
    .slice(0, observedKeys.length)
    .map(({ executionKey }) => executionKey);
  if (
    observedRuns.length !== 16 ||
    JSON.stringify(observedKeys) !== JSON.stringify(expectedPrefix)
  ) {
    throw new Error("stopped runs must be one contiguous manifest prefix");
  }
  const unknownRuns = observedRuns.filter(
    ({ run }) =>
      record(run.costSettlement, "run settlement").state === "unknown",
  );
  if (
    unknownRuns.length !== 1 ||
    unknownRuns[0] !== observedRuns.at(-1) ||
    observedRuns
      .slice(0, -1)
      .some(
        ({ run }) =>
          record(run.costSettlement, "run settlement").state !== "settled",
      )
  ) {
    throw new Error("stopped settlement sequence is invalid");
  }

  const reconciledStopped = record(
    reconciliation.stoppedEvidence,
    "reconciled stopped evidence",
  );
  const reconciledProbe = record(
    reconciliation.probeEvidence,
    "reconciled probe evidence",
  );
  const late = record(reconciliation.lateSettlement, "late settlement");
  const unknown = unknownRuns[0]!.run;
  if (
    reconciliation.schemaVersion !==
      "site-builder-design-spec-settlement-reconciliation/v1" ||
    reconciliation.status !== "RECONCILED_AFTER_CAMPAIGN_FREEZE" ||
    reconciledStopped.sha256 !== stoppedEvidenceSha256 ||
    reconciledProbe.sha256 !== probeEvidenceSha256 ||
    late.result !== "EXACT_LOG_ROW_VISIBLE_AFTER_RESOLVER_POLL_WINDOW" ||
    late.alias !== unknown.alias ||
    late.protocol !== unknown.expectedProtocol ||
    late.fixtureId !== unknown.fixtureId ||
    late.attempt !== unknown.attempt ||
    late.inputTokens !==
      record(unknown.usage, "unknown run usage").inputTokens ||
    late.outputTokens !==
      record(unknown.usage, "unknown run usage").outputTokens
  ) {
    throw new Error("late settlement reconciliation is not exact");
  }
  const accounting = record(
    reconciliation.dispatchAccounting,
    "dispatch accounting",
  );
  const remaining = record(reconciliation.remainingMatrix, "remaining matrix");
  const ledger = record(reconciliation.ledger, "reconciled ledger");
  const costAccounting = record(
    reconciliation.costAccounting,
    "reconciled cost accounting",
  );
  if (
    costAccounting.currency !== "CNY" ||
    !Number.isFinite(costAccounting.totalReconciledCnyCents) ||
    !Number.isFinite(costAccounting.totalReconciledCny) ||
    Number(costAccounting.totalReconciledCnyCents) < 0 ||
    Number(costAccounting.totalReconciledCny) < 0
  ) {
    throw new Error("reconciled cost accounting is invalid");
  }
  if (ledger.reusable !== false) {
    throw new Error("original authorization must remain non-reusable");
  }
  if (
    accounting.executionsStarted !== 17 ||
    accounting.gpt55ProbeExecutions !== 1 ||
    accounting.terraMatrixExecutions !== 16 ||
    accounting.gpt55MatrixExecutions !== 0 ||
    accounting.sonnetMatrixExecutions !== 0 ||
    remaining.executions !== 56 ||
    remaining.authorization !== "NOT_AUTHORIZED"
  ) {
    throw new Error("reconciled execution accounting is invalid");
  }

  const missingTargets = targetExecutions.slice(observedRuns.length);
  if (missingTargets.length !== 56) {
    throw new Error("remaining target execution count drifted");
  }
  const resumeExecutions = [declaredProbe, ...missingTargets].map(
    (execution, index) =>
      Object.freeze({ ...execution, resumeOrdinal: index + 1 }),
  );
  const maximumFutureWireCalls = resumeExecutions.reduce(
    (total, execution) => total + execution.maximumWireCalls,
    0,
  );
  if (maximumFutureWireCalls !== 114) {
    throw new Error("resume wire-call ceiling drifted");
  }
  if (maximumFutureWireCalls * PER_WIRE_CALL_CAP_CENTS !== 2_280) {
    throw new Error("resume cost ceiling drifted");
  }

  return Object.freeze({
    schemaVersion: "site-builder-design-spec-resume-prep/v1",
    status: "READY_FOR_PRODUCT_DECISION",
    preparedFixedCommitSha: input.preparedFixedCommitSha,
    sourceEvidence: Object.freeze({
      manifestSha256,
      preflightSha256,
      executionPreflightReportSha256,
      stoppedEvidenceSha256,
      probeEvidenceSha256,
      reconciliationSha256,
    }),
    pricingSnapshot: Object.freeze({
      authority: "openox_model_marketplace",
      capturedAt: string(pricing.capturedAt, "pricing capturedAt"),
      entries: Object.freeze(pricingEntries),
      revalidation: "REQUIRED_BEFORE_COST_AUTHORIZATION",
    }),
    priorSettledCost: Object.freeze({
      currency: "CNY",
      totalCents: Number(costAccounting.totalReconciledCnyCents),
      totalUnits: Number(costAccounting.totalReconciledCny),
    }),
    priorCampaign: Object.freeze({
      executionsStarted: 17,
      probeExecutions: 1,
      matrixExecutionsConsumed: 16,
      authorizationReusable: false,
    }),
    resume: Object.freeze({
      remainingMatrixExecutions: 56,
      newProcessProbeExecutions: 1,
      minimumFutureDispatchExecutions: 57,
      maximumFutureWireCalls: 114,
      mechanicalHardCeilingCents: 2280 as const,
      priorProbeReusable: false,
      priorProbeReuseReason: "TRUSTED_IN_MEMORY_CAMPAIGN_ONLY",
      currentRunnerCanResumeAsIs: false,
      currentRunnerCapacity: "73_EXECUTIONS_146_WIRE_CALLS",
      requiredImplementation: "SCOPED_RESUME_RUN_AND_EVIDENCE_MERGE_CONTRACT",
    }),
    settlementPolling: Object.freeze({
      previousMaximumWaitMs: 2_000,
      proposedDelaysMs: Object.freeze([
        250, 500, 1_000, 2_000, 4_000, 8_000, 12_000,
      ] as const),
      proposedMaximumWaitMs: 27_750,
      unknownAfterWindowPolicy: "FREEZE_CAMPAIGN",
    }),
    executions: Object.freeze(resumeExecutions),
    dispatchAuthorization: "NOT_AUTHORIZED",
    actualNetworkCalls: 0,
    actualModelWireCalls: 0,
    actualModelCostCents: 0,
    credentialMaterial: "not_persisted",
    responseMaterial: "not_persisted",
    promotion: "NOT_AUTHORIZED",
  });
}

export function renderDesignSpecResumeDecisionCard(
  report: DesignSpecResumePrepReport,
): string {
  const priceRows = report.pricingSnapshot.entries
    .map(
      (entry) =>
        `| \`${entry.alias}\` | \`${entry.protocol}\` | ${entry.currency} ${entry.effectiveInputRatePerMillionTokens} | ${entry.currency} ${entry.effectiveOutputRatePerMillionTokens} |`,
    )
    .join("\n");
  return `# M1-g design_spec resume preparation decision card

Status: **${report.status}**  
Dispatch authorization: **${report.dispatchAuthorization}**

## Outcome

- The stopped campaign consumed 1 GPT-5.5 probe and 16 Terra matrix executions.
- The original authorization ledger is frozen and non-reusable.
- 56 matrix executions remain. A new process also requires a new GPT-5.5 capability probe, so the minimum continuation is **57 executions** and at most **114 wire calls**.
- The current canonical runner is fixed at 73 executions / 146 wire calls and cannot safely represent this subset as-is.
- The next implementation decision is either a scoped resume-run plus evidence-merge contract, or a complete canonical campaign restart. This card authorizes neither.

## Cost boundary

- Previous reconciled actual cost: **CNY ${report.priorSettledCost.totalUnits.toFixed(6)}** (${report.priorSettledCost.totalCents.toFixed(4)} CNY cents).
- Continuation mechanical hard ceiling: **$${(
    report.resume.mechanicalHardCeilingCents / 100
  ).toFixed(
    2,
  )}** (${report.resume.mechanicalHardCeilingCents} policy cents at 20 cents per possible wire call).
- Expected continuation cost: **not yet calculable as an authorization amount**. A scoped executable runner, fresh OpenOx snapshot, finite credential quota, and exact execution-level token envelope are still required.
- No currency conversion is inferred; OpenOx native currencies remain separate.

## Frozen OpenOx price reference

Captured at: \`${report.pricingSnapshot.capturedAt}\`  
Revalidation: **${report.pricingSnapshot.revalidation}**

| Alias | Protocol | Input / 1M tokens | Output / 1M tokens |
| --- | --- | ---: | ---: |
${priceRows}

## Settlement correction

- Old maximum wait: 2,000 ms.
- New bounded schedule: ${report.settlementPolling.proposedDelaysMs.join(
    " + ",
  )} ms = ${report.settlementPolling.proposedMaximumWaitMs.toLocaleString(
    "en-US",
  )} ms maximum.
- If an exact log row is still absent, settlement remains unknown and the campaign freezes.

## Credential and authorization gate

Before any future model call, create a new purpose-specific, finite credential limited to exactly \`gpt-5.6-terra\`, \`gpt-5.5\`, and \`claude-sonnet-5\`, their reviewed protocols/channels, and the newly approved monetary/quota ceiling. Credential material and recoverable identifiers must not enter Git evidence.

This preparation made **${report.actualNetworkCalls} network calls**, **${report.actualModelWireCalls} model wire calls**, and incurred **${report.actualModelCostCents} model cost**. A separate implementation PR and a later exact cost authorization are required before dispatch. Promotion remains **${report.promotion}**.
`;
}
