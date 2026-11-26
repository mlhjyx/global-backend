import type { ToolContext } from "./tool-contract";
import {
  assertStatelessTaskCallBudget,
  resolveLegacyExecutionBudgetMode,
  TechnicalTaskLimitExceededError,
  type LegacyExecutionBudgetMode,
} from "../execution-budget/legacy-execution-budget-mode";

const MAX_TRACKED_BYPASS_ACCOUNTS = 2_048;

export function isWorkspaceToolBudgetBypass(
  ctx: ToolContext,
  explicitMode?: LegacyExecutionBudgetMode,
): boolean {
  return (
    !ctx.paidCost &&
    !ctx.platformEgress &&
    ctx.workspaceId !== "platform" &&
    (explicitMode ?? resolveLegacyExecutionBudgetMode()) === "bypass"
  );
}

export function enforceBypassToolCallLimit(params: {
  readonly counts: Map<string, number>;
  readonly workspaceId: string;
  readonly accountKey: string;
  readonly maxCalls?: number;
  readonly onLimitExceeded: (reason: string) => void;
}): void {
  const key = `${params.workspaceId}\0${params.accountKey}`;
  const next = (params.counts.get(key) ?? 0) + 1;
  try {
    assertStatelessTaskCallBudget("tool", next, params.maxCalls);
  } catch (err) {
    if (err instanceof TechnicalTaskLimitExceededError) {
      params.onLimitExceeded(
        `technical limit exceeded: ${err.message.slice(0, 150)}`,
      );
    }
    throw err;
  }
  if (!params.counts.has(key) && params.counts.size >= MAX_TRACKED_BYPASS_ACCOUNTS) {
    const oldest = params.counts.keys().next().value;
    if (oldest !== undefined) params.counts.delete(oldest);
  }
  params.counts.set(key, next);
}
