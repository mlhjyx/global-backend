import { Injectable, Optional } from '@nestjs/common';
import { ModelGateway } from './model-gateway';
import { ModelRouter } from './model-router';
import { ModelProvider } from './model-provider';
import { AiTraceSink } from './ai-trace.sink';
import { checkAgainstSchema } from './schema-validate';
import { BudgetLedger, BudgetExceededError, budgetLedger, DEFAULT_LLM_EST_CENTS } from '../tools/budget';
import { getTask } from '../ai-tasks/task-registry';

/**
 * provider 不上报 costUsd 时按 token 折算实际成本（复审 HIGH 修复）：否则 settle 恒按
 * 声明上限（15-20¢/次 vs 真实 ~0.05-0.5¢）记账，$20 run 预算实为 ~100 次调用的硬顶，
 * 规模 run 中后段 fit 判定被静默截断。保守混合价 env 可调（LLM_CENTS_PER_MTOK，默认
 * 100¢/M tok ≈ $1/M——对 flash 档仍高估数倍，作预算上界足够诚实）。
 */
function centsFromTokens(usage?: { inputTokens?: number; outputTokens?: number }): number | null {
  const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  if (tokens <= 0) return null;
  const env = Number(process.env.LLM_CENTS_PER_MTOK);
  const perMtok = Number.isFinite(env) && env > 0 ? env : 100;
  return Math.max(1, Math.ceil((tokens * perMtok) / 1_000_000));
}
import {
  AiContext,
  EmbedInput,
  GenerateStructuredInput,
  GenerateTextInput,
  ModelOp,
  ModelResult,
} from './types';

/**
 * Routes each call across the provider chain, falling back on failure (PRD 9.5).
 * Adds the gateway-level guarantees business code relies on:
 * - every call is traced (ai_trace + usage_ledger, PRD 9.10) — fire-and-forget
 * - structured outputs are validated against the task schema, with ONE repair
 *   retry that feeds the validation errors back to the model (PRD 9.6)
 */
@Injectable()
export class RouterModelGateway extends ModelGateway {
  /**
   * 预算账本（收口② D：LLM 是最大真实成本源，网关是预算门的正确位置）。
   * 进程级单例，测试可替换。不走 Nest DI（worker 侧手动构造网关，保持两处组装一致）。
   */
  budget: BudgetLedger = budgetLedger;

  constructor(
    private readonly router: ModelRouter,
    @Optional() private readonly trace?: AiTraceSink,
  ) {
    super();
  }

  generateText(input: GenerateTextInput, ctx: AiContext): Promise<ModelResult<string>> {
    return this.run('generateText', input, ctx, (p) => p.generateText(input, ctx));
  }

  generateStructured<T = unknown>(
    input: GenerateStructuredInput,
    ctx: AiContext,
  ): Promise<ModelResult<T>> {
    return this.run('generateStructured', input, ctx, async (p) => {
      const first = await p.generateStructured<T>(input, ctx);
      if (p.id === 'stub') return first; // stub 输出不参与 schema 校验（dev 兜底）
      const check = checkAgainstSchema(input.schema, first.data);
      if (check.valid) return first;
      // 修复重试：把校验错误反馈给模型，仅一次（PRD 9.6 校验-修复循环）。
      const repair = await p.generateStructured<T>(
        {
          ...input,
          prompt: `${input.prompt}\n\n上一次输出未通过 JSON Schema 校验，错误：\n${(check.errors ?? []).join('\n')}\n请修正后重新只输出合法 JSON。`,
        },
        ctx,
      );
      const recheck = checkAgainstSchema(input.schema, repair.data);
      if (!recheck.valid) {
        throw new Error(
          `structured output failed schema validation after repair: ${(recheck.errors ?? []).join('; ')}`,
        );
      }
      // usage 合并：重试消耗也要入账
      return {
        ...repair,
        usage: {
          inputTokens: (first.usage?.inputTokens ?? 0) + (repair.usage?.inputTokens ?? 0),
          outputTokens: (first.usage?.outputTokens ?? 0) + (repair.usage?.outputTokens ?? 0),
        },
      };
    });
  }

  embed(input: EmbedInput, ctx: AiContext): Promise<ModelResult<number[][]>> {
    return this.run('embed', input, ctx, (p) => p.embed(input, ctx));
  }

  private async run<T>(
    op: ModelOp,
    input: { task: string; model?: string },
    ctx: AiContext,
    call: (p: ModelProvider) => Promise<ModelResult<T>>,
  ): Promise<ModelResult<T>> {
    const chain = this.router.route(op, input.task);
    if (chain.length === 0) throw new Error(`no model provider for ${op}/${input.task}`);

    // 预算门（收口② D）：task.maxCostCents 从纯声明变真闸——reserve-then-settle，
    // 账户（runId ?? workspaceId）超限即抛 BudgetExceededError（调用不发生=真拦截）。
    // settle 优先级：costUsd（按实）→ token 折算（centsFromTokens）→ est 兜底。
    const estCents = getTask(input.task)?.maxCostCents ?? DEFAULT_LLM_EST_CENTS;
    let reservation: { runId: string; estCents: number };
    try {
      reservation = this.budget.reserve(ctx.runId ?? ctx.workspaceId, estCents);
    } catch (err) {
      // 预算拒绝必须可审计（对齐 ToolBroker 的 DENIED trace）：否则截断完全不可观测。
      if (err instanceof BudgetExceededError) {
        this.trace?.record({
          workspaceId: ctx.workspaceId,
          task: input.task,
          op,
          provider: 'budget-gate',
          model: input.model ?? 'n/a',
          status: 'ERROR',
          errorMessage: `budget exceeded (DENIED before call): ${err.message.slice(0, 300)}`,
          latencyMs: 0,
          correlationId: ctx.correlationId,
        });
      }
      throw err;
    }
    let settled = false;
    const settle = (actualCents: number) => {
      if (settled) return;
      settled = true;
      this.budget.settle(reservation, actualCents);
    };

    let lastErr: unknown;
    try {
      for (const provider of chain) {
        const started = Date.now();
        try {
          const result = await call(provider);
          const costUsd = result.usage?.costUsd;
          settle(costUsd != null ? Math.ceil(costUsd * 100) : centsFromTokens(result.usage) ?? estCents);
          this.trace?.record({
            workspaceId: ctx.workspaceId,
            task: input.task,
            op,
            provider: result.provider,
            model: result.model,
            status: 'OK',
            latencyMs: Date.now() - started,
            inputTokens: result.usage?.inputTokens,
            outputTokens: result.usage?.outputTokens,
            costUsd: result.usage?.costUsd,
            correlationId: ctx.correlationId,
          });
          return result;
        } catch (err) {
          this.trace?.record({
            workspaceId: ctx.workspaceId,
            task: input.task,
            op,
            provider: provider.id,
            model: input.model ?? 'unknown',
            status: 'ERROR',
            errorMessage: String(err),
            latencyMs: Date.now() - started,
            correlationId: ctx.correlationId,
          });
          lastErr = err; // try the next provider (fallback)
        }
      }
      throw lastErr;
    } finally {
      settle(0); // 全链失败不计费（对齐 PRD 7.4.8）；成功路径已按实/按上限结算
    }
  }
}
