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
 * Product-boundary guard. Platform calls must carry the runtime-injected 4D
 * dispatcher; ordinary workspace calls remain unaffected. There is no
 * environment override or in-memory fallback.
 */
export function assertPlatformEgressFenceAvailable(context: {
  readonly workspaceId: string;
  readonly platformEgress?: unknown;
}): void {
  if (context.workspaceId === "platform" && !context.platformEgress) {
    throw new ExecutionControlError(PLATFORM_EGRESS_FENCE_UNAVAILABLE);
  }
}
