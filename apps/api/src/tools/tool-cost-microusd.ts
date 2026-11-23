import { ExecutionControlError } from "../execution-budget/execution-control-error";
import type { CostModel, ToolResult, ToolContext } from "./tool-contract";
import { centsToMicrousd, parseCanonicalMicrousd } from "./microusd";

/** The explicit micro field is authoritative. Legacy tools keep integer-cent validation. */
export function estimatedToolMicrousd(cost: CostModel): bigint {
  if ("estimatedMicrousd" in cost) {
    if (typeof cost.estimatedMicrousd !== "string")
      throw new TypeError("estimatedMicrousd must be a canonical string");
    return parseCanonicalMicrousd("estimatedMicrousd", cost.estimatedMicrousd);
  }
  return centsToMicrousd(cost.estimatedCents);
}

export function observedToolMicrousd(
  result: Pick<ToolResult, "costCents" | "costMicrousd">,
): bigint {
  if ("costMicrousd" in result) {
    if (typeof result.costMicrousd !== "string")
      throw new TypeError("costMicrousd must be a canonical string");
    return parseCanonicalMicrousd("costMicrousd", result.costMicrousd);
  }
  return centsToMicrousd(result.costCents);
}

export function assertToolCostContextCompatible(
  cost: CostModel,
  context: Pick<ToolContext, "paidCost">,
): void {
  if ("estimatedMicrousd" in cost && context.paidCost !== undefined)
    throw new ExecutionControlError("BUDGET_MICROUSD_PAID_COST_UNSUPPORTED");
}

export function noNewMicroToolReplayCost<T>(
  result: ToolResult<T>,
): ToolResult<T> {
  if (!("costMicrousd" in result)) return result;
  observedToolMicrousd(result);
  return { ...result, costCents: 0, costMicrousd: "0" };
}
