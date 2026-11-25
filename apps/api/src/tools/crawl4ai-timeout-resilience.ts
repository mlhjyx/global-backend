import { EgressBlockedError } from "../adapters/guarded-http";
import { isCrawlTimeoutError } from "../adapters/web-crawler";
import {
  ExecutionControlError,
  isExecutionControlError,
} from "../execution-budget/execution-control-error";
import {
  ExternalToolActionDeniedError,
  type ToolContext,
} from "./tool-contract";

/**
 * True only for workspace-scoped Crawl4AI client/transport timeouts (never
 * platformEgress, control errors, suppression gates, or SSRF egress blocks).
 * Handles Node.js DOMException (TimeoutError/AbortError) explicitly before
 * `isExecutionControlError`, whose strict prototype check fails closed on DOMException.
 */
export function isDegradableWorkspaceCrawlTimeout(
  error: unknown,
  ctx: ToolContext,
): boolean {
  if (ctx.platformEgress || ctx.workspaceId === "platform") return false;
  if (
    error instanceof ExecutionControlError ||
    error instanceof ExternalToolActionDeniedError ||
    error instanceof EgressBlockedError
  ) {
    return false;
  }
  if (error instanceof DOMException) {
    return error.name === "TimeoutError" || error.name === "AbortError";
  }
  if (isExecutionControlError(error)) return false;
  return isCrawlTimeoutError(error);
}
