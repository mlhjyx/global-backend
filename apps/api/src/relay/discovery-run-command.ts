import { assertManufacturerNetworkAuthority } from "../discovery/manufacturer-network-authority";
import type { ExecutionBudgetBinding } from "../execution-budget/execution-budget-binding";
import {
  DISCOVERY_STREAMING_WORKFLOW,
  DISCOVERY_WORKFLOW,
} from "../temporal/understanding.constants";

/** Plan B rollout switch: DISCOVERY_STREAMING_WORKFLOW=on routes new runs to discoveryStreamingWorkflow. */
export function resolveDiscoveryWorkflowType(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return /^(1|true|on|yes)$/i.test(env.DISCOVERY_STREAMING_WORKFLOW ?? "")
    ? DISCOVERY_STREAMING_WORKFLOW
    : DISCOVERY_WORKFLOW;
}

export class NonRetryableOutboxCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableOutboxCommandError";
  }
}

/** Keep invalid snapshots on the existing parked-command path before any Workflow start. */
export function discoveryManufacturerCommandArguments(
  value: unknown,
  budget: ExecutionBudgetBinding,
  planId: string | undefined,
) {
  try {
    const snapshot = assertManufacturerNetworkAuthority(value, budget, planId);
    return snapshot ? { manufacturerNetworkExecution: snapshot } : {};
  } catch {
    throw new NonRetryableOutboxCommandError(
      "EXECUTION_BUDGET_OUTBOX_COMMAND_PARKED",
    );
  }
}
