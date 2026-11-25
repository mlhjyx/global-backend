import type { ModelGateway } from "../model-gateway/model-gateway";
import { definiteModelFailureCode } from "../model-gateway/definite-model-failure";
import { resolveCrossChannelFallbackModels } from "../model-gateway/model-fallback";
import { checkAgainstSchema } from "../model-gateway/schema-validate";
import type {
  AiContext,
  GenerateStructuredInput,
  ModelResolutionSource,
  ModelResult,
} from "../model-gateway/types";
import { canonicalDigest, ContextEngine } from "./context-engine";
import {
  ModelExecutionRuntime,
  unwrapModelExecutionError,
} from "./model-execution-runtime";
import type {
  ModelExecutionState,
  ModelProtocol,
  ReasoningLevel,
  RuntimeTelemetry,
  TaskModelContract,
} from "./types";
import { getTask } from "../ai-tasks/task-registry";
import {
  activeLlmResultCache,
  llmResultCacheKey,
  llmResultCacheTtlHours,
} from "./llm-result-cache";

const STRUCTURED_CONTEXT_WINDOW = 128_000;
const MAX_PROVIDER_OUTPUT_TOKENS = 16_000;

export interface StructuredTaskRuntimeMetadata {
  contractVersion: string;
  protocol: ModelProtocol;
  contextDigest: string;
  promptDigest: string;
  states: readonly ModelExecutionState[];
  transportAttempts: number;
  repairAttempts: number;
  physicalCalls: number;
  gatewayRepairCalls: number;
  requestedAlias: string;
  runtimeResolvedAlias: string;
  gatewayResolvedModel: string;
  provider: string;
  reportedModel?: string;
  modelResolutionSource?: ModelResolutionSource;
  /** PR-B：本次结果来自 llm_extraction_cache（未发生网关调用、未结算）。 */
  cacheHit?: boolean;
}

export type RuntimeStructuredModelResult<Output> = ModelResult<Output> & {
  runtimeExecution: StructuredTaskRuntimeMetadata;
};

export interface StructuredTaskRuntimeOptions {
  contractVersion?: string;
  protocol?: ModelProtocol;
  telemetry?: RuntimeTelemetry;
}

function reasoning(input: GenerateStructuredInput): ReasoningLevel {
  return input.reasoningEffort ?? "none";
}

function reasoningReserve(level: ReasoningLevel): number {
  if (level === "high") return 2_048;
  if (level === "medium") return 1_024;
  if (level === "low") return 256;
  return 0;
}

function estimatedTokens(content: unknown): number {
  return Math.max(
    1,
    Math.ceil(Buffer.byteLength(JSON.stringify(content), "utf8") / 3),
  );
}

/** 缓存命中结果复用前重跑同一条输出门（schema + 任务级校验）；不合法按 miss 处理。 */
function cachedResultIsValid<Output>(
  schema: Record<string, unknown>,
  result: unknown,
  validateOutput?: (output: Output) => void,
): boolean {
  try {
    const validation = checkAgainstSchema(schema, result);
    if (!validation.valid) return false;
    validateOutput?.(result as Output);
    return true;
  } catch {
    return false;
  }
}

function boundedStructuredTaskInput(input: GenerateStructuredInput) {
  const registeredTask = getTask(input.task);
  const registeredMaxOutputTokens = registeredTask?.maxOutputTokens;
  const maxOutputTokens = input.maxTokens ?? registeredMaxOutputTokens;
  if (
    registeredMaxOutputTokens === undefined ||
    !Number.isSafeInteger(maxOutputTokens) ||
    (maxOutputTokens ?? 0) < 1 ||
    (maxOutputTokens ?? 0) > MAX_PROVIDER_OUTPUT_TOKENS ||
    (registeredMaxOutputTokens !== undefined &&
      (maxOutputTokens ?? 0) > registeredMaxOutputTokens)
  ) {
    throw new Error("TASK_MAX_OUTPUT_TOKENS_UNAVAILABLE");
  }
  const boundedInput = Object.freeze({
    ...input,
    maxTokens: maxOutputTokens as number,
  });
  return { registeredTask, boundedInput };
}

function structuredTaskRequestMaterial(input: GenerateStructuredInput, maxOutputTokens: number) {
  return {
    task: input.task,
    prompt: input.prompt,
    ...(input.system === undefined ? {} : { system: input.system }),
    ...(input.model === undefined ? {} : { model: input.model }),
    maxOutputTokens,
  };
}

function structuredTaskSegment(
  kind: 'policy' | 'schema' | 'request', sourceRef: string, content: unknown,
  sensitivity: 'public' | 'workspace', cacheClass: 'stable-prefix' | 'request-local',
) {
  return { kind, sourceRef, sourceDigest: canonicalDigest(content), sensitivity, cacheClass,
    estimatedTokens: estimatedTokens(content), content };
}

function assembleStructuredTaskContext(
  context: AiContext, contractVersion: string, refs: Record<string, string>,
  segments: ReturnType<typeof structuredTaskSegment>[], maxTokens: number, effort: ReasoningLevel,
) {
  return new ContextEngine().assemble({
    workspaceId: context.workspaceId,
    policy: { version: `${contractVersion}/context-v1`, allowedSourceRefs: Object.values(refs) },
    segments,
    budget: { contextWindow: STRUCTURED_CONTEXT_WINDOW, outputReserve: maxTokens,
      reasoningReserve: reasoningReserve(effort) },
  });
}

/** Same complete required context, with no grant, cache or gateway side effects. */
export function prepareStructuredTaskRuntimeInput(
  input: GenerateStructuredInput, context: AiContext, options: StructuredTaskRuntimeOptions = {},
) {
  const { registeredTask, boundedInput } = boundedStructuredTaskInput(input);
  const contractVersion = options.contractVersion ?? `structured-task-contract/${input.task}/v1`;
  const protocol = options.protocol ?? "openai_chat_completions";
  const requestedAlias = input.model ?? "gateway-default";
  const effort = reasoning(input);
  const requestMaterial = structuredTaskRequestMaterial(input, boundedInput.maxTokens);
  const policy = {
    task: input.task, contractVersion, system: input.system ?? "", model: requestedAlias,
    protocol, gatewayRepair: "single_closed_repair", maxOutputTokens: boundedInput.maxTokens,
  };
  const refs = {
    policy: `task-policy:${input.task}@${contractVersion}`,
    schema: `task-schema:${input.task}@${contractVersion}`,
    request: `task-request:${input.task}@${canonicalDigest(requestMaterial)}`,
  };
  const segments = [
    structuredTaskSegment("policy", refs.policy, policy, "public", "stable-prefix"),
    structuredTaskSegment("schema", refs.schema, input.schema, "public", "stable-prefix"),
    structuredTaskSegment("request", refs.request, requestMaterial, "workspace", "request-local"),
  ];
  const envelope = assembleStructuredTaskContext(context, contractVersion, refs, segments, boundedInput.maxTokens, effort);
  return { registeredTask, boundedInput, contractVersion, protocol, requestedAlias, effort, requestMaterial, refs, envelope };
}

export async function executeStructuredTaskWithRuntime<Output>(
  gateway: ModelGateway,
  input: GenerateStructuredInput,
  context: AiContext,
  options: StructuredTaskRuntimeOptions = {},
): Promise<RuntimeStructuredModelResult<Output>> {
  const { registeredTask, boundedInput, contractVersion, protocol, requestedAlias,
    effort, requestMaterial, refs, envelope } = prepareStructuredTaskRuntimeInput(input, context, options);
  const taskInput = requestMaterial;
  const settlementRequired = context.paidCost !== undefined;
  const prompt = { system: input.system ?? "", user: input.prompt };
  const promptDigest = canonicalDigest(prompt);
  const promptVersion = `${contractVersion}/prompt-v1`;
  const schemaDigest = canonicalDigest(input.schema);
  const registeredModel = registeredTask?.model ?? requestedAlias;
  const llmCache = registeredTask?.cacheable === true ? activeLlmResultCache() : null;
  const llmCacheKey = llmCache
    ? llmResultCacheKey({
        workspaceId: context.workspaceId,
        task: input.task,
        contractVersion,
        promptVersion,
        model: registeredModel,
        requestDigest: canonicalDigest(requestMaterial),
        schemaDigest,
        reasoning: effort,
      })
    : null;
  if (llmCache && llmCacheKey) {
    const hit = await llmCache
      .get(context.workspaceId, llmCacheKey)
      .catch(() => null);
    if (hit && cachedResultIsValid(input.schema, hit.result, input.validateOutput)) {
      // 缓存短路必须留下与真实调用同构的 durable 收据：discovery lineage 把
      // 「invoked 但无收据」视为未知结果并整条作废。优先由网关落账（0 成本）。
      const settleCached = gateway.settleCachedStructured?.bind(gateway);
      // durableResultSchema 是收据的同构前提：没有它 projection/receiptFacts 都为
      // undefined，settle 会产出一条无结果的结算——那等于又一次「无收据成功」。
      const canSettleCached =
        settleCached !== undefined &&
        context.durableResultSchema !== undefined &&
        context.paidCost === undefined &&
        context.platformEgress === undefined;
      if (canSettleCached) {
        const settled = await settleCached(input, context, {
          data: hit.result as Output,
          model: registeredModel,
        });
        console.log(`[llm-cache] task=${input.task} hit=true`);
        return {
          ...settled,
          runtimeExecution: {
            contractVersion,
            protocol,
            contextDigest: envelope.digest,
            promptDigest,
            states: [],
            transportAttempts: 0,
            repairAttempts: 0,
            physicalCalls: 0,
            gatewayRepairCalls: 0,
            requestedAlias,
            runtimeResolvedAlias: requestedAlias,
            gatewayResolvedModel: settled.model ?? registeredModel,
            provider: settled.provider,
            ...(settled.reportedModel ? { reportedModel: settled.reportedModel } : {}),
            ...(settled.modelResolutionSource
              ? { modelResolutionSource: settled.modelResolutionSource }
              : {}),
            cacheHit: true,
          },
        };
      }
      const receiptRequired =
        context.durableResultSchema !== undefined ||
        context.onDurableReceipt !== undefined ||
        context.paidCost !== undefined ||
        context.platformEgress !== undefined;
      if (!receiptRequired) {
        console.log(`[llm-cache] task=${input.task} hit=true`);
        return {
          data: hit.result as Output,
          provider: "llm-cache",
          model: registeredModel,
          callCount: 0,
          runtimeExecution: {
            contractVersion,
            protocol,
            contextDigest: envelope.digest,
            promptDigest,
            states: [],
            transportAttempts: 0,
            repairAttempts: 0,
            physicalCalls: 0,
            gatewayRepairCalls: 0,
            requestedAlias,
            runtimeResolvedAlias: requestedAlias,
            gatewayResolvedModel: registeredModel,
            provider: "llm-cache",
            cacheHit: true,
          },
        };
      }
      // 需要持久收据但当前网关不支持缓存落账：按 miss 走真实调用（fail-closed 方向，
      // 绝不返回一条无收据的成功结果）。
      console.log(`[llm-cache] task=${input.task} hit=true unreceipted-fallthrough`);
    }
  }
  let gatewayResult: ModelResult<Output> | undefined;
  const contract: TaskModelContract<typeof taskInput, Output> = {
    taskId: input.task,
    version: contractVersion,
    executionMode: "generative",
    inputSchema: { type: "object" },
    outputSchema: input.schema,
    contextPolicy: {
      version: `${contractVersion}/context-v1`,
      allowedSourceRefs: Object.values(refs),
    },
    capabilityRequirements: {
      protocols: [protocol],
      structuredOutput: true,
      reasoning: effort,
      settlementRequired,
    },
    reasoningPolicy: {
      allowed: [effort],
      default: effort,
      reserveTokens: reasoningReserve(effort),
    },
    cachePolicy: { mode: "disabled" },
    retryPolicy: { transportMaxAttempts: 1, contentRepairMaxAttempts: 0 },
    validateOutput: (_taskInput, output) => {
      const validation = checkAgainstSchema(input.schema, output);
      if (!validation.valid)
        throw new Error(
          `output invalid: ${(validation.errors ?? []).join("; ")}`,
        );
      input.validateOutput?.(output);
    },
  };
  const primaryModel = boundedInput.model ?? registeredTask?.model;
  const canCrossChannelFallback =
    context.paidCost === undefined && context.platformEgress === undefined;
  const fallbackModels = canCrossChannelFallback
    ? resolveCrossChannelFallbackModels(primaryModel, boundedInput.task)
    : [];
  const attemptModels: Array<string | undefined> = [boundedInput.model, ...fallbackModels];

  let activeResolvedAlias = requestedAlias;
  let activeAttemptInput = boundedInput;
  let activeAttemptCtx = context;
  const runtime = new ModelExecutionRuntime<typeof taskInput, Output>({
    telemetry: options.telemetry,
    transport: {
      dispatch: async () => {
        gatewayResult = await gateway.generateStructured<Output>(
          activeAttemptInput,
          activeAttemptCtx,
        );
        return {
          output: gatewayResult.data,
          requestedAlias,
          resolvedAlias: activeResolvedAlias,
          reportedModel: gatewayResult.reportedModel,
          protocol,
          usage: {
            inputTokens: gatewayResult.usage?.inputTokens ?? 0,
            outputTokens: gatewayResult.usage?.outputTokens ?? 0,
          },
          settlement:
            settlementRequired &&
            (!gatewayResult.usage?.gatewaySettlements?.length ||
              gatewayResult.usage.gatewaySettlements.some(
                (item) => item.status === "unknown",
              ))
              ? "unknown"
              : "known",
        };
      },
    },
  });
  let result: Awaited<ReturnType<typeof runtime.execute>> | undefined;
  for (let idx = 0; idx < attemptModels.length; idx += 1) {
    const candidateModel = attemptModels[idx];
    activeResolvedAlias = idx === 0 || !candidateModel ? requestedAlias : candidateModel;
    activeAttemptInput =
      idx === 0 || candidateModel === undefined
        ? boundedInput
        : { ...boundedInput, model: candidateModel };
    activeAttemptCtx =
      idx === 0 || !candidateModel
        ? context
        : {
            ...context,
            correlationId: context.correlationId
              ? `${context.correlationId}:fb:${candidateModel}`
              : `fb:${candidateModel}`,
          };
    gatewayResult = undefined;
    try {
      result = await runtime.execute({
        executionId: `structured:${context.runId ?? context.correlationId ?? context.workspaceId}:${input.task}:${canonicalDigest(requestMaterial).slice(0, 16)}${idx === 0 ? "" : `:fb${idx}`}`,
        fallbackIndex: idx,
        workspaceId: context.workspaceId,
        buildRunId: context.runId ?? context.correlationId ?? context.workspaceId,
        contract,
        input: taskInput,
        inputDigest: canonicalDigest(taskInput),
        context: envelope,
        contextDigest: envelope.digest,
        promptVersion,
        schemaDigest,
        requestedAlias,
        resolvedAlias: activeResolvedAlias,
        protocol,
        reasoning: effort,
        sampling: {},
        locale: "und",
        prompt,
      });
      break;
    } catch (error) {
      const unwrapped = unwrapModelExecutionError(error);
      const hasMore = idx + 1 < attemptModels.length;
      if (!hasMore || !canCrossChannelFallback || definiteModelFailureCode(unwrapped) === undefined) {
        throw unwrapped;
      }
    }
  }
  if (!result || !gatewayResult)
    throw new Error("model runtime completed without a gateway observation");
  if (llmCache && llmCacheKey) {
    try {
      await llmCache.put(
        context.workspaceId,
        llmCacheKey,
        input.task,
        gatewayResult.data,
        llmResultCacheTtlHours(),
      );
    } catch (error) {
      console.warn(
        `[llm-cache] put failed task=${input.task}: ${String(error).slice(0, 160)}`,
      );
    }
    console.log(`[llm-cache] task=${input.task} hit=false`);
  }
  return {
    ...gatewayResult,
    runtimeExecution: {
      contractVersion,
      protocol,
      contextDigest: envelope.digest,
      promptDigest: canonicalDigest(prompt),
      states: result.states,
      transportAttempts: result.transportAttempts,
      repairAttempts: result.repairAttempts,
      physicalCalls: gatewayResult.callCount ?? 1,
      gatewayRepairCalls: Math.max(0, (gatewayResult.callCount ?? 1) - 1),
      requestedAlias,
      runtimeResolvedAlias: activeResolvedAlias,
      gatewayResolvedModel: gatewayResult.model,
      provider: gatewayResult.provider,
      ...(gatewayResult.reportedModel
        ? { reportedModel: gatewayResult.reportedModel }
        : {}),
      ...(gatewayResult.modelResolutionSource
        ? { modelResolutionSource: gatewayResult.modelResolutionSource }
        : {}),
    },
  };
}
