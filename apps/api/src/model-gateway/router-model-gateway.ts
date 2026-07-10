import { Injectable, Optional } from '@nestjs/common';
import { ModelGateway } from './model-gateway';
import { ModelRouter } from './model-router';
import { ModelProvider } from './model-provider';
import { AiTraceSink } from './ai-trace.sink';
import { checkAgainstSchema } from './schema-validate';
import { BudgetLedger, budgetLedger, DEFAULT_LLM_EST_CENTS } from '../tools/budget';
import { getTask } from '../ai-tasks/task-registry';
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
    // provider 不上报真实 costUsd → 按声明上限记账（settle=est，保守上界；有 costUsd 时按实结）。
    const estCents = getTask(input.task)?.maxCostCents ?? DEFAULT_LLM_EST_CENTS;
    const reservation = this.budget.reserve(ctx.runId ?? ctx.workspaceId, estCents);
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
          settle(costUsd != null ? Math.ceil(costUsd * 100) : estCents);
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
