import { canonicalDigest } from "../../model-runtime";
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
    maximumOutputTokens: 4_000 as const,
    timeoutMs: 120_000 as const,
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

const PLAN = {
  schemaVersion: "site-builder-copy-capability-pilot-plan/2026-08-05-v1",
  planId: "site-builder-copy-capability-pilot/2026-08-05-v1",
  executionStatus: "BLOCKED_ON_DURABLE_ADMISSION_AND_BRANDED_RUNNER",
  dispatchAuthorization: "NOT_AUTHORIZED",
  observedModelWireCalls: 0,
  observedModelCost: { CNY: 0, USD: 0 },
  evidenceClassification: "CAPABILITY_ONLY_NOT_QUALITY_EVIDENCE",
  taskId: "site_builder.copy",
  plannedExecutions: 3,
  maximumWireCalls: 6,
  maximumRepairCallsPerExecution: 1,
  cachePolicy: "disabled",
  settlementPolicy: "known_per_physical_call_required",
  fixedCommitPolicy: "separate_create_only_manifest_required",
  credentialPolicy: "finite_exact_alias_protocol_allowlist_required",
  blockingGates: deepFreeze([
    "durable_authorization_reserve_and_unique_wire_claim",
    "all_post_wire_paths_settled_or_durably_frozen",
    "trusted_gateway_bound_adapter_factory",
    "runtime_branded_receipt_bound_to_ledger",
    "global_execution_and_wire_caps",
    "structured_output_failure_cannot_be_business_validated",
    "repair_payload_digest_matches_sent_payload",
    "bounded_settlement_observation",
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
