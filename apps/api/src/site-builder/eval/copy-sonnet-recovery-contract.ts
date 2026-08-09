import { canonicalDigest } from "../../model-runtime/context-engine";
import { COPY_CAPABILITY_PILOT_PLAN } from "./copy-capability-pilot";

const SOURCE_SONNET_EXECUTION = COPY_CAPABILITY_PILOT_PLAN.executions.find(
  ({ alias }) => alias === "claude-sonnet-5",
);

if (
  SOURCE_SONNET_EXECUTION?.protocol !== "anthropic_messages" ||
  SOURCE_SONNET_EXECUTION.reasoning !== "medium"
) {
  throw new Error("COPY_SONNET_RECOVERY_SOURCE_EXECUTION_INVALID");
}

export const COPY_SONNET_RECOVERY_EXECUTION = Object.freeze({
  executionKey: "copy-sonnet-recovery-v12-claude-sonnet-5" as const,
  sourcePilotExecutionKey: SOURCE_SONNET_EXECUTION.executionKey,
  alias: "claude-sonnet-5" as const,
  protocol: "anthropic_messages" as const,
  reasoning: "medium" as const,
});

export const COPY_SONNET_RECOVERY_DUPLICATE_PREVENTION = Object.freeze({
  acceptedAliasesExcludedFromDispatch: Object.freeze([
    "gpt-5.6-terra",
    "gpt-5.6-sol",
  ] as const),
  acceptedWireReplayPolicy: "never_repeat_successful_v11_wires" as const,
  consumedAuthorizationPolicy: "never_reuse_v11_authorization" as const,
});

export const COPY_SONNET_RECOVERY_PLAN = Object.freeze({
  schemaVersion: "site-builder-copy-sonnet-recovery-plan/2026-08-08-v1" as const,
  planId: "site-builder-copy-sonnet-recovery/2026-08-08-v12" as const,
  taskId: "site_builder.copy" as const,
  plannedExecutions: 1 as const,
  maximumWireCalls: 2 as const,
  maximumRepairCallsPerExecution: 1 as const,
  execution: COPY_SONNET_RECOVERY_EXECUTION,
  duplicatePrevention: COPY_SONNET_RECOVERY_DUPLICATE_PREVENTION,
});

export const COPY_SONNET_RECOVERY_PLAN_DIGEST = canonicalDigest(
  COPY_SONNET_RECOVERY_PLAN,
);
