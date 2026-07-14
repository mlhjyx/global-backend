import type { ModelGateway } from '../../model-gateway/model-gateway';
import { checkAgainstSchema } from '../../model-gateway/schema-validate';
import type { AiContext, ModelResult, ModelUsage } from '../../model-gateway/types';
import { resolveTaskRoute, SiteBuilderTaskId, TaskRoute } from './task-routes';

/**
 * L2 AiTask 统一执行器（09 §2.4，镜像获客侧「有界任务契约，非超级 Agent」哲学）。
 *
 * 职责分层（刻意不重复网关已有的轮子）：
 * - 本层：输入 JSON Schema fail-fast → 固化 prompt（用户数据只进模板变量位，C2 结构性保证）
 *   → 按 task 路由（模型/预算/超时/effort）→ 模型回退链 → 🔴 stub 拒绝（假数据绝不充真，
 *   fit-judge 先例）→ 用量聚合 → 可诊断聚合错误。
 * - 网关内：输出 JSON Schema 校验 + 一次修复重试（PRD 9.6）、预算 reserve-settle、trace。
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
}

export class AiTaskError extends Error {
  constructor(
    readonly taskId: string,
    readonly attempts: { model: string; error: string }[],
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
}

const sum = (usage: ModelUsage | undefined, field: 'inputTokens' | 'outputTokens'): number =>
  usage?.[field] ?? 0;

/** 有界等待：超时即抛（网关 provider 另有自身 AbortSignal，这里守的是 per-task 预算）。 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const attempts: { model: string; error: string }[] = [];
  let usage = { inputTokens: 0, outputTokens: 0, calls: 0 };

  for (const model of [route.primary, ...route.fallbacks]) {
    try {
      const result: ModelResult<TOut> = await withTimeout(
        deps.gateway.generateStructured<TOut>(
          {
            task: def.id,
            prompt,
            system: def.system,
            schema: def.outputSchema,
            model,
            maxTokens: route.maxTokens,
            reasoningEffort: route.reasoningEffort,
          },
          deps.ctx,
        ),
        route.timeoutMs,
        `${def.id}@${model}`,
      );
      usage = {
        inputTokens: usage.inputTokens + sum(result.usage, 'inputTokens'),
        outputTokens: usage.outputTokens + sum(result.usage, 'outputTokens'),
        calls: usage.calls + (result.callCount ?? 1),
      };
      if (result.provider === 'stub') {
        // 🔴 stub 兜底绝不写真实产物：dev 网关瞬时失败会 fallback 到 stub（罐头输出）。
        throw new Error('stub provider refused (fake data must never pass as real)');
      }
      return { data: result.data, model: result.model, usage };
    } catch (err) {
      attempts.push({ model, error: err instanceof Error ? err.message : String(err) });
    }
  }

  throw new AiTaskError(def.id, attempts);
}
