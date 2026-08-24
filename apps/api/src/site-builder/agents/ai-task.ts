import type { ModelGateway } from '../../model-gateway/model-gateway';
import { checkAgainstSchema } from '../../model-gateway/schema-validate';
import type {
  AiContext,
  ModelResolutionSource,
  ModelResult,
  ModelUsage,
} from '../../model-gateway/types';
import { ProviderOutputError } from '../../model-gateway/providers/provider-output-error';
import type { SiteBuilderTaskId, TaskRoute } from './task-routes';
import type {
  ModelExecutionPolicySnapshot,
  ModelRouteSnapshot,
} from '@global/contracts';
import {
  PaidCallDeniedError,
  PaidOperationUnknownError,
} from '../site-build-cost-ledger';
import {
  executeSiteBuilderModelAttempt,
  type SiteBuilderRuntimeExecutionMetadata,
} from '../../model-runtime/site-builder-ai-task-bridge';
import { unwrapModelExecutionError } from '../../model-runtime/model-execution-runtime';
import type { RuntimeTelemetry } from '../../model-runtime/types';
import { SITE_BUILDER_GENERATIVE_TASK_IDS } from './task-route-bindings';

/**
 * L2 AiTask 统一执行器（09 §2.4，镜像获客侧「有界任务契约，非超级 Agent」哲学）。
 *
 * 职责分层（刻意不重复网关已有的轮子）：
 * - 本层：输入 JSON Schema fail-fast → 固化 prompt（用户数据只进模板变量位，C2 结构性保证）
 *   → 按 task 路由（模型/预算/超时/effort）→ 模型回退链 → 用量聚合
 *   → 可诊断聚合错误。
 * - 网关内：输出 JSON Schema 校验 + 一次修复重试（PRD 9.6）、trace；预算 reserve-settle
 *   仅对已由持久 BudgetStore 开立的账户生效；refurbish 使用专用 Grant/Spend ledger，
 *   无 runaway），预算门真接线 + 截断路径 usage 结算见 fast-follow。
 * - 任务模块内：业务出口闸（如 brandProfile 的 evidence 闸）——确定性纯函数，不进本层。
 */

export interface SiteBuilderTaskDefinition<TIn, TOut> {
  id: SiteBuilderTaskId;
  /** Semantic contract version; defaults to the first unified-runtime contract. */
  contractVersion?: string;
  /** 输入契约（ajv 校验，fail-fast：不合格绝不调模型）。 */
  inputSchema: Record<string, unknown>;
  /** 输出契约（透传网关 generateStructured 做校验+修复重试）。 */
  outputSchema: Record<string, unknown>;
  buildPrompt: (input: TIn) => string;
  /** 确定性任务硬门；抛错即拒绝本模型产物并进入回退链。 */
  validateOutput?: (input: TIn, output: TOut) => void;
  /** 允许网关把首次硬门拒绝原因反馈给同一模型做唯一一次修复。 */
  repairTaskOutput?: boolean;
  system?: string;
  /** 供 TS 侧标注输出类型（运行时校验靠 outputSchema）。 */
  __out?: TOut;
}

export interface AiTaskRunResult<TOut> {
  data: TOut;
  /** 实际服务的模型（回退链命中哪个）。 */
  model: string;
  /** Provider identifier that served the successful response. */
  provider: string;
  /** Upstream-reported identifier; absent when only the request is known. */
  reportedModel?: string;
  modelResolutionSource?: ModelResolutionSource;
  usage: { inputTokens: number; outputTokens: number; calls: number };
  /** Resolved profile, lifecycle, data handling and cost ceiling used for this run. */
  routePolicy: ModelExecutionPolicySnapshot;
  /** Requested primary/fallback model snapshot, before provider-side alias resolution. */
  modelSnapshot: ModelRouteSnapshot;
  /** Zero-based position in modelSnapshot that produced this result. */
  fallbackIndex: number;
  /** Unified runtime provenance surrounding the existing durable gateway call. */
  runtimeExecution: SiteBuilderRuntimeExecutionMetadata;
}

export interface AiTaskAttempt {
  model: string;
  error: string;
  provider?: string;
  resolvedModel?: string;
  reportedModel?: string;
  modelResolutionSource?: ModelResolutionSource;
}

export class AiTaskError extends Error {
  constructor(
    readonly taskId: string,
    readonly attempts: AiTaskAttempt[],
    /** Token usage spent on unsuccessful attempts, where the provider reported it. */
    readonly usage: {
      inputTokens: number;
      outputTokens: number;
      calls: number;
    },
  ) {
    super(
      `AI task ${taskId} failed on all models: ` +
        attempts.map((a) => `${a.model}: ${a.error}`).join(' | '),
    );
    this.name = 'AiTaskError';
  }
}

export interface AiTaskDeps {
  gateway: ModelGateway;
  ctx: AiContext;
  /** 测试注入位；生产缺省走 resolveTaskRoute（env 可覆盖）。 */
  route?: TaskRoute;
  /** Temporal/activity cancellation. Cancellation is terminal and never advances the fallback chain. */
  signal?: AbortSignal;
  /** Optional fail-open telemetry sink; never participates in routing or settlement. */
  runtimeTelemetry?: RuntimeTelemetry;
}

const sum = (
  usage: ModelUsage | undefined,
  field: 'inputTokens' | 'outputTokens',
): number => usage?.[field] ?? 0;

function addUsage(
  total: { inputTokens: number; outputTokens: number; calls: number },
  usage: ModelUsage | undefined,
  calls: number,
): { inputTokens: number; outputTokens: number; calls: number } {
  return {
    inputTokens: total.inputTokens + sum(usage, 'inputTokens'),
    outputTokens: total.outputTokens + sum(usage, 'outputTokens'),
    calls: total.calls + calls,
  };
}

function cloneRoutePolicy(
  policy: ModelExecutionPolicySnapshot,
): ModelExecutionPolicySnapshot {
  return {
    ...policy,
    dataPolicy: { ...policy.dataPolicy },
    route: {
      primary: policy.route.primary,
      fallbacks: [...policy.route.fallbacks],
    },
  };
}

export async function runAiTask<TIn, TOut>(
  def: SiteBuilderTaskDefinition<TIn, TOut>,
  rawInput: TIn,
  deps: AiTaskDeps,
): Promise<AiTaskRunResult<TOut>> {
  if (!SITE_BUILDER_GENERATIVE_TASK_IDS.some((taskId) => taskId === def.id)) {
    throw new Error(`deterministic Site Builder task ${def.id} cannot dispatch through the model runtime`);
  }
  const inputCheck = checkAgainstSchema(def.inputSchema, rawInput);
  if (!inputCheck.valid) {
    throw new Error(
      `${def.id} input invalid: ${(inputCheck.errors ?? []).join('; ')}`,
    );
  }

  const prompt = def.buildPrompt(rawInput);
  const route =
    deps.route ??
    (await import('./task-routes')).resolveTaskRoute(def.id);
  const routePolicy = cloneRoutePolicy(route.policy);
  const modelSnapshot: ModelRouteSnapshot = {
    primary: routePolicy.route.primary,
    fallbacks: [...routePolicy.route.fallbacks],
  };
  const attempts: AiTaskAttempt[] = [];
  let usage = { inputTokens: 0, outputTokens: 0, calls: 0 };

  for (const [fallbackIndex, model] of [
    route.primary,
    ...route.fallbacks,
  ].entries()) {
    // per-task 超时（复审 Temporal F1）：abort signal 真取消底层 fetch（含网关内修复重试）。
    // 非付费调用继续以 Promise.race 及时换模型；付费调用在 abort 后必须等待网关完成请求级
    // 结算/冻结，不能让外层 fallback 抢跑并产生第二笔费用。
    const controller = new AbortController();
    const forwardCancellation = (): void => {
      controller.abort(
        deps.signal?.reason instanceof Error
          ? deps.signal.reason
          : new Error(`${def.id} cancelled`),
      );
    };
    if (deps.signal?.aborted) forwardCancellation();
    else
      deps.signal?.addEventListener('abort', forwardCancellation, {
        once: true,
      });
    let timer: NodeJS.Timeout | undefined;
    const timeoutError = () =>
      new Error(`${def.id}@${model} timed out after ${route.timeoutMs}ms`);
    let timeout: Promise<never> | undefined;
    if (deps.ctx.paidCost) {
      timer = setTimeout(() => {
        controller.abort(timeoutError());
      }, route.timeoutMs);
    } else {
      timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = timeoutError();
          controller.abort(error);
          reject(error);
        }, route.timeoutMs);
      });
    }
    try {
      const execution = executeSiteBuilderModelAttempt({
        definition: def,
        input: rawInput,
        prompt,
        route,
        model,
        fallbackIndex,
        gateway: deps.gateway,
        signal: controller.signal,
        allowInjectedTestAlias: deps.route !== undefined,
        telemetry: deps.runtimeTelemetry,
        context: {
          ...deps.ctx,
          ...(deps.ctx.paidCost
            ? {
                paidCost: {
                  ...deps.ctx.paidCost,
                  scopeKey: `${deps.ctx.paidCost.scopeKey}:model:${fallbackIndex}:${model}`,
                },
              }
            : {}),
          modelPolicy: {
            ...cloneRoutePolicy(routePolicy),
            fallbackIndex,
          },
        },
      });
      const runtimeResult = deps.ctx.paidCost
        ? await execution
        : await Promise.race([execution, timeout!]);
      const result: ModelResult<TOut> = runtimeResult.gatewayResult;
      usage = addUsage(usage, result.usage, result.callCount ?? 1);
      return {
        data: result.data,
        model: result.model,
        provider: result.provider,
        reportedModel: result.reportedModel,
        modelResolutionSource: result.modelResolutionSource,
        usage,
        routePolicy,
        modelSnapshot,
        fallbackIndex,
        runtimeExecution: runtimeResult.runtime,
      };
    } catch (err) {
      if (deps.signal?.aborted) {
        throw deps.signal.reason instanceof Error
          ? deps.signal.reason
          : new Error(`${def.id} cancelled`);
      }
      // A durable paid-call gate or settlement ambiguity is a terminal task
      // condition. Advancing to another model would spend again after an
      // unknown acknowledgement boundary.
      const executionError = unwrapModelExecutionError(err);
      if (
        executionError instanceof PaidCallDeniedError ||
        executionError instanceof PaidOperationUnknownError
      ) {
        throw executionError;
      }
      // A malformed/truncated provider response can have consumed tokens even
      // though it has no usable artifact. Keep that usage through a fallback
      // or final AiTaskError so evaluations and later cost reconciliation do
      // not silently make rejected attempts look free.
      if (executionError instanceof ProviderOutputError)
        usage = addUsage(usage, executionError.usage, executionError.callCount);
      attempts.push({
        model,
        error:
          executionError instanceof Error
            ? executionError.message
            : String(executionError),
        ...(executionError instanceof ProviderOutputError
          ? {
              provider: executionError.provider,
              resolvedModel: executionError.model,
              reportedModel: executionError.reportedModel,
              modelResolutionSource: executionError.modelResolutionSource,
            }
          : {}),
      });
    } finally {
      clearTimeout(timer);
      deps.signal?.removeEventListener('abort', forwardCancellation);
    }
  }

  throw new AiTaskError(def.id, attempts, usage);
}
