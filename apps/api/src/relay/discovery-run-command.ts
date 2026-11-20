import { assertManufacturerNetworkAuthority } from "../discovery/manufacturer-network-authority";
import type { ExecutionBudgetBinding } from "../execution-budget/execution-budget-binding";

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
