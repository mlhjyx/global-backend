import { ExecutionControlError } from "../execution-budget/execution-control-error";
import type { RuntimeComponentStatus } from "../runtime/runtime-readiness-registry";
import {
  tryProjectPlatformAutomationReadinessForHealth,
  platformAutomationAggregateFromHealthProjection,
} from "../platform-authority/platform-automation-readiness-health";

/** Refuse schedule polling unless every enabled platform purpose is issuable. */
export async function assertPlatformAuthorityReady(
  inspectCapabilities: () => Promise<unknown>,
): Promise<void> {
  const result = await checkPlatformAuthorityReady(inspectCapabilities);
  if (result.status !== "ok") throw new ExecutionControlError(result.code);
}

/** Shared startup and heartbeat decision; no prior run or Grant is required. */
export async function checkPlatformAuthorityReady(
  inspectCapabilities: () => Promise<unknown>,
): Promise<RuntimeComponentStatus> {
  try {
    const projection = tryProjectPlatformAutomationReadinessForHealth(
      await inspectCapabilities(),
    );
    if (projection && platformAutomationAggregateFromHealthProjection(projection).status === "ok") {
      return { status: "ok" };
    }
  } catch {
    // An unavailable dependency never grants admission or exposes transport details.
  }
  return { status: "failed", code: "PLATFORM_BUDGET_AUTHORITY_NOT_READY" };
}
