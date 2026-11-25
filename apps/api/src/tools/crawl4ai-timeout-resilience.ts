import { createHash } from "node:crypto";
import { EgressBlockedError, type DispatchPhysicalWire } from "../adapters/guarded-http";
import {
  CRAWL4AI_RENDER_DEGRADED_EMPTY_HTML,
  crawlHtml,
  type CrawlHtmlResult,
  isCrawl4aiHtmlBody,
  isCrawlTimeoutError,
} from "../adapters/web-crawler";
import {
  ExecutionControlError,
  isExecutionControlError,
} from "../execution-budget/execution-control-error";
import {
  assertToolExternalActionAuthorized,
  ExternalToolActionDeniedError,
  type ToolContext,
  type ToolResult,
} from "./tool-contract";

const hash = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, 24);

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
  if (ctx.platformEgress) return false;
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

/**
 * Executes `crawlHtml` for `crawl4ai.render` and settles workspace timeouts or
 * blank/non-HTML upstream bodies into a contract-valid $0 degraded HTML payload
 * so ToolBroker never leaves the budget operation stuck in RESERVED/RESULT_UNKNOWN.
 */
export async function executeCrawl4aiRenderWithResilience(
  url: string,
  ctx: ToolContext,
  dispatchPhysicalWire?: DispatchPhysicalWire,
): Promise<ToolResult<CrawlHtmlResult & { robotsBlocked?: boolean }>> {
  let r: CrawlHtmlResult;
  try {
    r = await crawlHtml(
      url,
      () => assertToolExternalActionAuthorized(ctx),
      undefined,
      ctx.beforePhysicalWire,
      dispatchPhysicalWire,
    );
  } catch (error) {
    if (isDegradableWorkspaceCrawlTimeout(error, ctx)) {
      return {
        data: { url, html: CRAWL4AI_RENDER_DEGRADED_EMPTY_HTML, headers: {} },
        costCents: 0,
        degraded: true,
      };
    }
    throw error;
  }
  if (!ctx.platformEgress && !isCrawl4aiHtmlBody(r.html)) {
    return {
      data: { url: r.url, html: CRAWL4AI_RENDER_DEGRADED_EMPTY_HTML, headers: r.headers },
      costCents: 0,
      degraded: true,
    };
  }
  return {
    data: r,
    costCents: 1,
    provenance: {
      sourceUrl: url,
      fetchedAt: new Date().toISOString(),
      contentHash: hash(r.html),
      parserVersion: "crawl4ai/1",
    },
  };
}
