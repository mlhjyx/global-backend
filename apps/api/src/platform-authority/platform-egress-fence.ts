import { ExecutionControlError } from "../execution-budget/execution-control-error";
import { PLATFORM_EGRESS_FENCE_UNAVAILABLE } from "./platform-egress-fence.v1";
export {
  PLATFORM_EGRESS_FENCE_UNAVAILABLE,
  PlatformEgressFence,
  PlatformEgressFenceError,
  type PlatformEgressFencePort,
  type PlatformEgressBinding,
} from "./platform-egress-fence.v1";

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
