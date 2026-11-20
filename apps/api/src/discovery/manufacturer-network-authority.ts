import { workspaceExecutionBudgetRequestScope } from "../execution-budget/execution-budget-request-scope";
import { ExecutionControlError } from "../execution-budget/execution-control-error";
import type { ExecutionBudgetBinding } from "../execution-budget/execution-budget-binding";
import {
  readManufacturerNetworkExecutionSnapshot,
  type ManufacturerNetworkExecutionSnapshot,
} from "./manufacturer-network-execution";

/** Node boundary: structural history markers never authorize additional work alone. */
export function assertManufacturerNetworkAuthority(
  value: unknown,
  binding: ExecutionBudgetBinding,
  planId?: string,
): ManufacturerNetworkExecutionSnapshot | undefined {
  try {
    const snapshot = readManufacturerNetworkExecutionSnapshot(value);
    if (!snapshot) return undefined;
    const scope = workspaceExecutionBudgetRequestScope({
      operation: "POST /query-plans/:planId/execute",
      planId: snapshot.planId,
      body: snapshot.body,
    });
    if (
      (planId !== undefined && snapshot.planId !== planId) ||
      binding.purpose !== scope.purpose ||
      binding.subjectType !== scope.subjectType ||
      binding.subjectId !== scope.subjectId ||
      binding.requestSha256 !== scope.requestSha256
    )
      throw new Error("mismatch");
    return snapshot;
  } catch {
    throw new ExecutionControlError("EXECUTION_BUDGET_REQUEST_INVALID");
  }
}
