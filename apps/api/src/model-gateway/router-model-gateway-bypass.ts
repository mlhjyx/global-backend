import type { AiTraceSink } from "./ai-trace.sink";
import type { ModelProvider } from "./model-provider";
import {
  ProviderHttpError,
  ProviderOutputError,
} from "./providers/provider-output-error";
import type {
  AiContext,
  GenerateStructuredInput,
  ModelOp,
  ModelResult,
} from "./types";
import { paidOperationKey } from "../site-builder/site-build-cost-ledger";
import {
  assertStatelessModelCallLimits,
  assertStatelessTaskCallBudget,
  resolveLegacyExecutionBudgetMode,
  STATELESS_TASK_HARD_LIMITS,
  TechnicalTaskLimitExceededError,
  type LegacyExecutionBudgetMode,
} from "../execution-budget/legacy-execution-budget-mode";

export function buildCachedStructuredOperationKey(
  input: GenerateStructuredInput,
  context: AiContext,
  accountKey: string,
): string {
  return paidOperationKey([
    accountKey,
    "model-cache",
    "generateStructured",
    input.task,
    input.model ?? "",
    context.correlationId ?? "",
    input.prompt ?? "",
    input.system ?? "",
    input.schema ? JSON.stringify(input.schema) : "",
  ]);
}

const MAX_TRACKED_BYPASS_ACCOUNTS = 2_048;

export function isWorkspaceModelBudgetBypass(
  ctx: AiContext,
  explicitMode?: LegacyExecutionBudgetMode,
): boolean {
  if (ctx.paidCost || ctx.platformEgress || ctx.workspaceId === "platform") {
    return false;
  }
  return (explicitMode ?? resolveLegacyExecutionBudgetMode()) === "bypass";
}

export function resolveModelTaskTimeoutMs(
  registeredTimeoutMs: number | undefined,
  bypassBudget: boolean,
): number | undefined {
  return (
    registeredTimeoutMs ??
    (bypassBudget ? STATELESS_TASK_HARD_LIMITS.defaultModelTimeoutMs : undefined)
  );
}

export function recordBypassModelCall(
  counts: Map<string, number>,
  workspaceId: string,
  accountKey: string,
  maxCalls?: number,
): void {
  const key = `${workspaceId}\0${accountKey}`;
  const next = (counts.get(key) ?? 0) + 1;
  assertStatelessTaskCallBudget("model", next, maxCalls);
  if (!counts.has(key) && counts.size >= MAX_TRACKED_BYPASS_ACCOUNTS) {
    const oldest = counts.keys().next().value;
    if (oldest !== undefined) counts.delete(oldest);
  }
  counts.set(key, next);
}

export function recordCachedStructuredTrace(
  trace: AiTraceSink | undefined,
  input: GenerateStructuredInput,
  context: AiContext,
  model: string,
): void {
  trace?.record({
    workspaceId: context.workspaceId,
    task: input.task,
    op: "generateStructured",
    provider: "llm-cache",
    model,
    status: "OK",
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    correlationId: context.correlationId,
    runId: context.runId,
    modelPolicy: context.modelPolicy,
  });
}

export async function executeWorkspaceBypassModelCall<T>(params: {
  readonly op: ModelOp;
  readonly input: {
    readonly task: string;
    readonly model?: string;
    readonly maxTokens?: number;
  };
  readonly ctx: AiContext;
  readonly callCtx: AiContext;
  readonly taskMaxOutputTokens: number | undefined;
  readonly taskSignal: AbortSignal | undefined;
  readonly accountKey: string;
  readonly provider: ModelProvider;
  readonly substitutes: readonly string[];
  readonly call: (
    p: ModelProvider,
    runCtx: AiContext,
    signal?: AbortSignal,
  ) => Promise<ModelResult<T>>;
  readonly trace: AiTraceSink | undefined;
  readonly counts: Map<string, number>;
  readonly maxCalls: number | undefined;
  readonly assertExternalActionAuthorized: (ctx: AiContext) => Promise<void>;
  readonly wrapSubstituteObserver: (
    provider: ModelProvider,
    substitutes: readonly string[],
    onObserved: (model: string) => void,
  ) => ModelProvider;
  readonly buildSubstitution: (
    requestedModel: string | undefined,
    observed: ReadonlySet<string>,
  ) =>
    | { requestedModel: string; substituteModels: readonly string[] }
    | undefined;
}): Promise<ModelResult<T>> {
  const { op, input, ctx, callCtx, provider, substitutes } = params;
  try {
    assertStatelessModelCallLimits({
      taskId: input.task,
      maxTokens: input.maxTokens,
      taskMaxOutputTokens: params.taskMaxOutputTokens,
    });
    recordBypassModelCall(
      params.counts,
      ctx.workspaceId,
      params.accountKey,
      params.maxCalls,
    );
  } catch (err) {
    if (err instanceof TechnicalTaskLimitExceededError) {
      params.trace?.record({
        workspaceId: ctx.workspaceId,
        task: input.task,
        op,
        provider: "technical-limit-gate",
        model: input.model ?? "n/a",
        status: "ERROR",
        errorMessage: `technical limit exceeded (DENIED before call): ${err.message.slice(0, 300)}`,
        latencyMs: 0,
        correlationId: ctx.correlationId,
        runId: ctx.runId,
        modelPolicy: ctx.modelPolicy,
      });
    }
    throw err;
  }
  const substituteAnswers = new Set<string>();
  const dispatchProvider =
    substitutes.length > 0
      ? params.wrapSubstituteObserver(provider, substitutes, (model) =>
          substituteAnswers.add(model),
        )
      : provider;
  const started = Date.now();
  try {
    if (ctx.authorizeExternalAction) {
      await params.assertExternalActionAuthorized(ctx);
    }
    const result = await params.call(
      dispatchProvider,
      callCtx,
      params.taskSignal,
    );
    const substitution = params.buildSubstitution(
      input.model,
      substituteAnswers,
    );
    params.trace?.record({
      workspaceId: ctx.workspaceId,
      task: input.task,
      op,
      provider: result.provider,
      model: result.model,
      ...(substitution ? { modelSubstitution: substitution } : {}),
      ...(substitutes.length > 0 &&
      result.modelResolutionSource === "requested_fallback"
        ? { modelIdentityUnproven: true as const }
        : {}),
      status: "OK",
      latencyMs: Date.now() - started,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      costUsd: result.usage?.costUsd,
      correlationId: ctx.correlationId,
      runId: ctx.runId,
      modelPolicy: ctx.modelPolicy,
    });
    return result;
  } catch (err) {
    const failedUsage =
      err instanceof ProviderOutputError ? err.usage : undefined;
    const failedModel =
      err instanceof ProviderOutputError ? err.model : undefined;
    const failedSubstitution = params.buildSubstitution(
      input.model,
      substituteAnswers,
    );
    params.trace?.record({
      workspaceId: ctx.workspaceId,
      task: input.task,
      op,
      provider: provider.id,
      model:
        failedModel !== undefined && substitutes.includes(failedModel)
          ? failedModel
          : (input.model ?? "unknown"),
      ...(failedSubstitution ? { modelSubstitution: failedSubstitution } : {}),
      status: "ERROR",
      errorMessage:
        err instanceof ProviderOutputError
          ? `${err.name}:${err.reasonCode}`
          : err instanceof ProviderHttpError
            ? `${err.name}:HTTP_${err.status}`
            : err instanceof Error
              ? err.name
              : "model call failed",
      latencyMs: Date.now() - started,
      inputTokens: failedUsage?.inputTokens,
      outputTokens: failedUsage?.outputTokens,
      correlationId: ctx.correlationId,
      runId: ctx.runId,
      modelPolicy: ctx.modelPolicy,
    });
    throw err;
  }
}
