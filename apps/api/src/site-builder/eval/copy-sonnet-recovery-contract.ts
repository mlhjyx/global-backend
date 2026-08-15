import { canonicalDigest } from "../../model-runtime/context-engine";
import { COPY_CAPABILITY_PILOT_PLAN } from "./copy-capability-pilot";

export const COPY_SONNET_RECOVERY_SOURCE_MANIFEST_PATH =
  "docs/evidence/site-builder/m1-g-copy-sonnet-recovery-manifest-v16.json" as const;
export const COPY_SONNET_RECOVERY_RUNTIME_BINDING_OUTPUT_PATH =
  "docs/evidence/site-builder/m1-g-copy-sonnet-recovery-runtime-binding-v16.json" as const;
export const COPY_SONNET_RECOVERY_RUNTIME_MANIFEST_ID =
  "site-builder-copy-sonnet-recovery-runtime/2026-08-10-v16-v1" as const;
export const COPY_SONNET_RECOVERY_RUNTIME_BINDING_ARTIFACT_ID =
  "site-builder-copy-sonnet-recovery-runtime-binding-prep/2026-08-10-v16-v1" as const;
// v16 is immutable historical provenance. A fixed-source rebase gets a new
// binding identity; it never rewrites this artifact or its recovery plan.
export const COPY_SONNET_RECOVERY_V22_RUNTIME_BINDING_OUTPUT_PATH =
  "docs/evidence/site-builder/m1-g-copy-sonnet-recovery-runtime-binding-v22.json" as const;
export const COPY_SONNET_RECOVERY_V22_RUNTIME_MANIFEST_ID =
  "site-builder-copy-sonnet-recovery-runtime/2026-08-15-v22-v1" as const;
export const COPY_SONNET_RECOVERY_V22_RUNTIME_BINDING_ARTIFACT_ID =
  "site-builder-copy-sonnet-recovery-runtime-binding-prep/2026-08-15-v22-v1" as const;
export const COPY_SONNET_RECOVERY_V16_IDENTITY_PREFIXES = Object.freeze({
  campaignId: "copy-sonnet-recovery-v16-campaign-" as const,
  globalAuthorizationId:
    "copy-sonnet-recovery-v16-global-authorization-" as const,
  childAuthorizationId:
    "copy-sonnet-recovery-v16-child-authorization-" as const,
  reservationId: "copy-sonnet-recovery-v16-child-reservation-" as const,
});

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
  executionKey: "copy-sonnet-recovery-v16-claude-sonnet-5" as const,
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
  acceptedWireReplayPolicy:
    "never_repeat_successful_v11_or_stopped_v12_or_v13_or_v14_or_v15_wires" as const,
  consumedAuthorizationPolicy:
    "never_reuse_v11_v12_v13_v14_or_v15_authorization" as const,
});

export const COPY_SONNET_RECOVERY_PLAN = Object.freeze({
  schemaVersion:
    "site-builder-copy-sonnet-recovery-plan/2026-08-08-v1" as const,
  planId: "site-builder-copy-sonnet-recovery/2026-08-10-v16" as const,
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
