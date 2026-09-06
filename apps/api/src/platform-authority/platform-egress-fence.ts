import { ExecutionControlError } from "../execution-budget/execution-control-error";

export const PLATFORM_EGRESS_FENCE_UNAVAILABLE =
  "PLATFORM_EGRESS_FENCE_UNAVAILABLE" as const;

/**
 * Temporary product-boundary hold while the 4D linearizable send fence is not
 * installed. It is deliberately code-owned and has no environment override.
 */
export function assertPlatformEgressFenceAvailable(context: {
  readonly workspaceId: string;
}): void {
  if (context.workspaceId === "platform") {
    throw new ExecutionControlError(PLATFORM_EGRESS_FENCE_UNAVAILABLE);
  }
}
