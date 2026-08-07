import { canonicalDigest } from "../../model-runtime/context-engine";
import { COPY_TASK } from "../agents/copy";
import { COPY_ASSEMBLY_EVAL_FIXTURES } from "./copy-assembly-eval";
import { COPY_EVALUATION_V2_CANDIDATES } from "./copy-evaluation-v2-candidates";

const FIXTURE = (() => {
  const fixture = COPY_ASSEMBLY_EVAL_FIXTURES.find(
    ({ fixtureId }) => fixtureId === "copy-factual-claims",
  );
  if (!fixture) throw new Error("COPY_CAPABILITY_PILOT_FIXTURE_MISSING");
  return fixture;
})();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

const EXECUTIONS = COPY_EVALUATION_V2_CANDIDATES.map((candidate, index) =>
  deepFreeze({
    executionKey: `copy-capability-${index + 1}-${candidate.alias}`,
    kind: "capability_probe" as const,
    fixtureId: FIXTURE.fixtureId,
    alias: candidate.alias,
    protocol: candidate.protocol,
    reasoning: candidate.reasoning,
    maximumWireCalls: 2 as const,
    maximumRepairCalls: 1 as const,
    maximumOutputTokens: 1_200 as const,
    timeoutMs: 240_000 as const,
    requirements: deepFreeze({
      structuredOutput: true,
      reportsUsage: true,
      reportsModel: true,
      reportsRequestId: true,
      exactReportedModel: true,
      knownSettlement: true,
      noProviderWarnings: true,
    }),
  }),
);

const CHILD_CAMPAIGNS = EXECUTIONS.map((execution, index) =>
  deepFreeze({
    childSlotId: `copy-capability-child-${index + 1}-${execution.alias}`,
    executionKey: execution.executionKey,
    alias: execution.alias,
    protocol: execution.protocol,
    reasoning: execution.reasoning,
    maximumExecutions: 1 as const,
    maximumWireCalls: 2 as const,
    maximumRepairCallsPerExecution: 1 as const,
    unknownSettlementPolicy: "freeze_selected_child_campaign" as const,
    sharedDriftPolicy: "freeze_all_child_campaigns" as const,
  }),
);

const PLAN = {
  schemaVersion: "site-builder-copy-capability-pilot-plan/2026-08-07-v10",
  planId: "site-builder-copy-capability-pilot/2026-08-07-v10",
  executionStatus: "REAL_RUNTIME_READY_POST_MERGE_V10_MANIFEST_REQUIRED",
  dispatchAuthorization: "NOT_AUTHORIZED",
  observedModelWireCalls: 0,
  observedModelCost: { CNY: 0, USD: 0 },
  evidenceClassification: "CAPABILITY_ONLY_NOT_QUALITY_EVIDENCE",
  taskId: "site_builder.copy",
  plannedExecutions: 3,
  maximumWireCalls: 6,
  maximumRepairCallsPerExecution: 1,
  unknownSettlementPolicy: "freeze_selected_child_campaign",
  sharedDriftPolicy: "freeze_all_child_campaigns",
  cachePolicy: "disabled",
  settlementPolicy: "known_per_physical_call_required",
  fixedCommitPolicy: "separate_create_only_manifest_required",
  credentialPolicy: "finite_exact_alias_protocol_allowlist_required",
  completedTestOnlyGates: deepFreeze([
    "append_only_hash_chained_execution_ledger",
    "unique_execution_and_wire_claim",
    "runtime_receipt_bound_to_completed_ledger",
    "global_execution_and_wire_caps",
    "post_wire_failure_durably_freezes_campaign",
    "structured_output_failure_cannot_be_business_validated",
    "loopback_only_native_adapter_factory",
    "one_shot_real_authorization_and_reservation_ledger",
    "request_bound_real_settlement_ledger",
    "gateway_settlement_claim_requires_proof",
    "known_settlement_invalid_output_closed_repair",
    "real_gateway_post_wire_freeze",
    "real_gateway_repair_payload_binding",
  ] as const),
  completedPreparationGates: deepFreeze([
    "exact_real_candidate_scope_contract",
    "fixed_source_commit_and_bundle_verification_contract",
    "finite_credential_attestation_contract",
    "authorization_binding_and_global_caps_contract",
    "bounded_request_bound_settlement_contract",
    "closed_non_dispatch_admission_envelope_validator",
    "purpose_specific_live_finite_credential_factory",
    "fixed_source_runtime_reverification_factory",
    "trusted_dispatch_runner_and_candidate_receipt_factory",
  ] as const),
  blockingGates: deepFreeze([
    "post_merge_create_only_fixed_commit_manifest",
    "installed_real_gateway_credential_attestation",
    "durable_real_gateway_authorization_reservation",
    "separate_exact_scope_dispatch_authorization",
    "git_reviewed_runtime_settlement_evidence",
  ] as const),
  source: {
    fixtureId: FIXTURE.fixtureId,
    taskContractVersion: COPY_TASK.contractVersion,
    inputDigest: canonicalDigest(FIXTURE.input),
    outputSchemaDigest: canonicalDigest(COPY_TASK.outputSchema),
    promptDigest: canonicalDigest({
      system: COPY_TASK.system,
      prompt: COPY_TASK.buildPrompt(FIXTURE.input),
    }),
  },
  executions: EXECUTIONS,
  childCampaigns: CHILD_CAMPAIGNS,
} as const;

export const COPY_CAPABILITY_PILOT_PLAN = deepFreeze(PLAN);
const EXPECTED_PLAN_DIGEST = canonicalDigest(COPY_CAPABILITY_PILOT_PLAN);

/** Exact zero-call guard for future durable admission and runner work. */
export function validateCopyCapabilityPilotPlan(plan: unknown): void {
  try {
    if (canonicalDigest(plan) !== EXPECTED_PLAN_DIGEST) throw new Error();
  } catch {
    throw new Error("COPY_CAPABILITY_PILOT_PLAN_DRIFT");
  }
}
