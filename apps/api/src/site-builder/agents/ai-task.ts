import type { ModelGateway } from '../../model-gateway/model-gateway';
import { checkAgainstSchema } from '../../model-gateway/schema-validate';
import type { AiContext, ModelResult, ModelUsage } from '../../model-gateway/types';
import { resolveTaskRoute, SiteBuilderTaskId, TaskRoute } from './task-routes';
import type { ModelExecutionPolicySnapshot, ModelRouteSnapshot } from '@global/contracts';

/**
 * L2 AiTask 统一执行器（09 §2.4，镜像获客侧「有界任务契约，非超级 Agent」哲学）。
 *
 * 职责分层（刻意不重复网关已有的轮子）：
 * - 本层：输入 JSON Schema fail-fast → 固化 prompt（用户数据只进模板变量位，C2 结构性保证）
 *   → 按 task 路由（模型/预算/超时/effort）→ 模型回退链 → 🔴 stub 拒绝（假数据绝不充真，
 *   fit-judge 先例）→ 用量聚合 → 可诊断聚合错误。
 * - 网关内：输出 JSON Schema 校验 + 一次修复重试（PRD 9.6）、trace；预算 reserve-settle
 *   仅对已 `budgetLedger.open` 的账户生效——refurbish 尚未 open（M1 单 run 成本结构上有界，
 *   无 runaway），预算门真接线 + 截断路径 usage 结算见 fast-follow。
 * - 任务模块内：业务出口闸（如 brandProfile 的 evidence 闸）——确定性纯函数，不进本层。
 */

export interface SiteBuilderTaskDefinition<TIn, TOut> {
  id: SiteBuilderTaskId;
  /** 输入契约（ajv 校验，fail-fast：不合格绝不调模型）。 */
  inputSchema: Record<string, unknown>;
  /** 输出契约（透传网关 generateStructured 做校验+修复重试）。 */
  outputSchema: Record<string, unknown>;
  buildPrompt: (input: TIn) => string;
  system?: string;
  /** 供 TS 侧标注输出类型（运行时校验靠 outputSchema）。 */
  __out?: TOut;
}

export interface AiTaskRunResult<TOut> {
  data: TOut;
  /** 实际服务的模型（回退链命中哪个）。 */
  model: string;
  usage: { inputTokens: number; outputTokens: number; calls: number };
  /** Resolved profile, lifecycle, data handling and cost ceiling used for this run. */
  routePolicy: ModelExecutionPolicySnapshot;
  /** Requested primary/fallback model snapshot, before provider-side alias resolution. */
  modelSnapshot: ModelRouteSnapshot;
  /** Zero-based position in modelSnapshot that produced this result. */
  fallbackIndex: number;
}

export class AiTaskError extends Error {
  constructor(
    readonly taskId: string,
    readonly attempts: { model: string; error: string }[],
  ) {
    super(
      `AI task ${taskId} failed on all models: ` +
        attempts.map((a) => `${a.model}: ${a.error}`).join(' | ') +
        // 复审 F3：dev 链 [gateway, stub] 下网关失败会落 stub→被拒，聚合错误全是「stub refused」；
        // 真实根因（503/截断/schema）只在 ai_trace，提示排障者去查。
        ' — (dev: stub fallback ⇒ 上游网关本次失败，真实根因见 ai_trace)',
    );
    this.name = 'AiTaskError';
  }
}

export interface AiTaskDeps {
  gateway: ModelGateway;
  ctx: AiContext;
  /** 测试注入位；生产缺省走 resolveTaskRoute（env 可覆盖）。 */
  route?: TaskRoute;
}

const sum = (usage: ModelUsage | undefined, field: 'inputTokens' | 'outputTokens'): number => usage?.[field] ?? 0;

function cloneRoutePolicy(policy: ModelExecutionPolicySnapshot): ModelExecutionPolicySnapshot {
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
  const inputCheck = checkAgainstSchema(def.inputSchema, rawInput);
  if (!inputCheck.valid) {
    throw new Error(`${def.id} input invalid: ${(inputCheck.errors ?? []).join('; ')}`);
  }

  const prompt = def.buildPrompt(rawInput);
  const route = deps.route ?? resolveTaskRoute(def.id);
  const routePolicy = cloneRoutePolicy(route.policy);
  const modelSnapshot: ModelRouteSnapshot = {
    primary: routePolicy.route.primary,
    fallbacks: [...routePolicy.route.fallbacks],
  };
  const attempts: { model: string; error: string }[] = [];
  let usage = { inputTokens: 0, outputTokens: 0, calls: 0 };

  for (const [fallbackIndex, model] of [route.primary, ...route.fallbacks].entries()) {
    // per-task 超时（复审 Temporal F1）：既 abort signal（真取消底层 fetch，含网关内修复重试的
    // 两次调用，不留后台弃单烧钱）——又 race 一个 reject 让本层立即换模型，不干等底层响应 abort。
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`${def.id}@${model} timed out after ${route.timeoutMs}ms`);
        controller.abort(e);
        reject(e);
      }, route.timeoutMs);
    });
    try {
      const result: ModelResult<TOut> = await Promise.race([
        deps.gateway.generateStructured<TOut>(
          {
            task: def.id,
            prompt,
            system: def.system,
            schema: def.outputSchema,
            model,
            maxTokens: route.maxTokens,
            maxCostCents: route.maxCostCents,
            reasoningEffort: route.reasoningEffort,
            signal: controller.signal,
          },
          {
            ...deps.ctx,
            modelPolicy: {
              ...cloneRoutePolicy(routePolicy),
              fallbackIndex,
            },
          },
        ),
        timeout,
      ]);
      usage = {
        inputTokens: usage.inputTokens + sum(result.usage, 'inputTokens'),
        outputTokens: usage.outputTokens + sum(result.usage, 'outputTokens'),
        calls: usage.calls + (result.callCount ?? 1),
      };
      if (result.provider === 'stub') {
        // 🔴 stub 兜底绝不写真实产物：dev 网关瞬时失败会 fallback 到 stub（罐头输出）。
        throw new Error('stub provider refused (fake data must never pass as real)');
      }
      return {
        data: result.data,
        model: result.model,
        usage,
        routePolicy,
        modelSnapshot,
        fallbackIndex,
      };
    } catch (err) {
      attempts.push({
        model,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  throw new AiTaskError(def.id, attempts);
}
