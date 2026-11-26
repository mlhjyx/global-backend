import {
  acts,
  ApplicationFailure,
  log,
  patched,
  resetActivities,
  setPatched,
  setWorkflowInfo,
  sleep,
  TemporalFailure,
} from "../../../src/temporal/testing/temporal-workflow.mock";
import type { DiscoveryStreamingInput } from "../../../src/temporal/discovery.streaming.workflow";

export type E2eTargetMode = "integrated" | "harness-selfcheck";

/**
 * Strictly defaults to 'integrated' when E2E_TARGET_MODE is unset or empty.
 * Fails closed on any unrecognized mode string.
 */
export function getE2eTargetMode(
  env: NodeJS.ProcessEnv = process.env,
): E2eTargetMode {
  const raw = env.E2E_TARGET_MODE?.trim().toLowerCase();
  if (!raw) return "integrated";
  if (raw === "integrated") return "integrated";
  if (raw === "harness-selfcheck") return "harness-selfcheck";
  throw new Error(
    "E2E_TARGET_MODE_INVALID: expected 'integrated' or 'harness-selfcheck'.",
  );
}

/**
 * Dual-mode gate:
 * - In 'integrated' mode (default): MUST execute `integratedCheck` strictly and NEVER invoke `selfcheckContract`.
 * - In 'harness-selfcheck' mode: executes only the synthetic contract.
 * Product failures and missing features can never select the synthetic branch.
 */
export async function requireIntegratedOrSelfcheck<T>(opts: {
  readonly featureId: string;
  readonly caseId: string;
  readonly integratedCheck: () => Promise<T> | T;
  readonly selfcheckContract: () => Promise<T> | T;
}): Promise<T> {
  const mode = getE2eTargetMode();
  if (mode === "integrated") {
    return await opts.integratedCheck();
  }
  return await opts.selfcheckContract();
}

export function makeWorkflowAuthority(
  workspaceId: string,
  runId: string,
  overrides: Partial<DiscoveryStreamingInput> = {},
): DiscoveryStreamingInput {
  const requestSha256 = "a".repeat(64);
  const planId = overrides.planId ?? "30000000-0000-4000-8000-000000000003";
  const icpId = overrides.icpId ?? "40000000-0000-4000-8000-000000000004";
  return {
    workspaceId,
    runId,
    planId,
    icpId,
    executionContractVersion: 2,
    executionBudget: {
      authorityId: "50000000-0000-4000-8000-000000000005",
      replay: false,
      scopeKey: workspaceId,
      accountKey: `discovery.run:discovery_run:${runId}:${requestSha256}`,
      purpose: "discovery.run",
      subjectType: "discovery_run",
      subjectId: runId,
      requestSha256,
    },
    ...overrides,
  };
}

export {
  acts,
  ApplicationFailure,
  log,
  patched,
  resetActivities,
  setPatched,
  setWorkflowInfo,
  sleep,
  TemporalFailure,
};
