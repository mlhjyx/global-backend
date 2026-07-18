import { Injectable, Optional } from '@nestjs/common';
import { ModelGateway } from './model-gateway';
import { ModelRouter } from './model-router';
import { ModelProvider } from './model-provider';
import { AiTraceSink } from './ai-trace.sink';
import { checkAgainstSchema } from './schema-validate';
import {
  BudgetLedger,
  BudgetExceededError,
  budgetLedger,
  DEFAULT_LLM_EST_CENTS,
} from '../tools/budget';
import {
  ProviderOutputError,
  TaskOutputValidationError,
} from './providers/provider-output-error';

/**
 * provider 不上报 costUsd 时按 token 折算实际成本（复审 HIGH 修复）：否则 settle 恒按
 * 声明上限（15-20¢/次 vs 真实 ~0.05-0.5¢）记账，$20 run 预算实为 ~100 次调用的硬顶，
 * 规模 run 中后段 fit 判定被静默截断。保守混合价 env 可调（LLM_CENTS_PER_MTOK，默认
 * 100¢/M tok ≈ $1/M——对 flash 档仍高估数倍，作预算上界足够诚实）。
 */
function centsFromTokens(usage?: {
  inputTokens?: number;
  outputTokens?: number;
}): number | null {
  const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  if (tokens <= 0) return null;
  const env = Number(process.env.LLM_CENTS_PER_MTOK);
  const perMtok = Number.isFinite(env) && env > 0 ? env : 100;
  return Math.max(1, Math.ceil((tokens * perMtok) / 1_000_000));
}

/**
 * 合并首调 + 修复重试的 usage（FIX 1）：校验-修复路径无论成功还是失败，都要把两次已消耗 token 汇总，
 * 让网关 catch 按 centsFromTokens 结算真实消耗——否则修复抛错只带修复 usage（漏首调）、recheck 失败
 * 抛裸 Error（记 0¢），都绕过改动 2 的硬预算上界「凡消耗 token 的调用都不该 settle 0¢」。
 */
function mergeStructuredUsage(
  a?: { inputTokens?: number; outputTokens?: number },
  b?: { inputTokens?: number; outputTokens?: number },
): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
  };
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
 *   retry that feeds schema errors, or an explicitly opted-in task-gate error,
 *   back to the same model (PRD 9.6)
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

  generateText(
    input: GenerateTextInput,
    ctx: AiContext,
  ): Promise<ModelResult<string>> {
    return this.run('generateText', input, ctx, (p) =>
      p.generateText(input, ctx),
    );
  }

  generateStructured<T = unknown>(
    input: GenerateStructuredInput,
    ctx: AiContext,
  ): Promise<ModelResult<T>> {
    return this.run('generateStructured', input, ctx, async (p) => {
      const validateTaskOutput = (result: ModelResult<T>): ModelResult<T> => {
        try {
          input.validateOutput?.(result.data);
          return result;
        } catch (err) {
          throw new TaskOutputValidationError(
            `task output hard gate rejected: ${err instanceof Error ? err.message : String(err)}`,
            result.usage,
            {
              cause: err,
              callCount: result.callCount ?? 1,
              provider: result.provider,
              model: result.model,
              reportedModel: result.reportedModel,
              modelResolutionSource: result.modelResolutionSource,
            },
          );
        }
      };
      const first = await p.generateStructured<T>(input, ctx);
      if (p.id === 'stub') return first; // stub 输出不参与 schema 校验（dev 兜底）
      const check = checkAgainstSchema(input.schema, first.data);
      let repairReason: string;
      let repairKind: 'JSON Schema' | '任务确定性硬门';
      if (check.valid) {
        try {
          return validateTaskOutput(first);
        } catch (error) {
          if (
            !input.repairTaskOutput ||
            !(error instanceof TaskOutputValidationError)
          ) {
            throw error;
          }
          repairKind = '任务确定性硬门';
          repairReason = error.message;
        }
      } else {
        repairKind = 'JSON Schema';
        repairReason = (check.errors ?? []).join('\n');
      }
      // 修复重试：schema 或任务硬门只共享这唯一一次调用，绝不形成开放循环。
      let repair: ModelResult<T>;
      try {
        repair = await p.generateStructured<T>(
          {
            ...input,
            prompt: `${input.prompt}\n\n上一次输出未通过${repairKind}校验，错误：\n${repairReason}\n请只修正被拒字段，不得新增、猜测或放宽任何事实；重新只输出同时通过 JSON Schema 和任务硬门的合法 JSON。`,
          },
          ctx,
        );
      } catch (err) {
        // FIX 1：修复调用抛错也要带上首调已消耗的 token（否则网关 catch 只结算修复那次、漏首调，少记绕硬顶）。
        throw new ProviderOutputError(
          `repair call failed: ${String(err)}`,
          mergeStructuredUsage(
            first.usage,
            err instanceof ProviderOutputError ? err.usage : undefined,
          ),
          {
            cause: err,
            callCount:
              1 + (err instanceof ProviderOutputError ? err.callCount : 1),
            provider:
              err instanceof ProviderOutputError
                ? (err.provider ?? first.provider)
                : first.provider,
            model:
              err instanceof ProviderOutputError
                ? (err.model ?? first.model)
                : first.model,
            reportedModel:
              err instanceof ProviderOutputError
                ? (err.reportedModel ?? first.reportedModel)
                : first.reportedModel,
            modelResolutionSource:
              err instanceof ProviderOutputError
                ? (err.modelResolutionSource ?? first.modelResolutionSource)
                : first.modelResolutionSource,
          },
        );
      }
      const recheck = checkAgainstSchema(input.schema, repair.data);
      if (!recheck.valid) {
        // FIX 1：修复后仍不过 schema → 抛 ProviderOutputError 携首调+修复合并 usage（原为裸 Error →
        // 网关 catch 记 0¢，两次调用白烧、绕过硬预算上界）。
        throw new ProviderOutputError(
          `structured output failed schema validation after repair: ${(recheck.errors ?? []).join('; ')}`,
          mergeStructuredUsage(first.usage, repair.usage),
          {
            callCount: 2,
            provider: repair.provider,
            model: repair.model,
            reportedModel: repair.reportedModel,
            modelResolutionSource: repair.modelResolutionSource,
          },
        );
      }
      // usage 合并：重试消耗也要入账。callCount=2 → 无 usage 上报时 settle 按**两次**兜底（否则少记一次、
      // 退还预留的另一半，40¢ 上限跑一个修复过的 20¢ 任务仍剩 20¢，硬上界失效，#82 P2）。
      return validateTaskOutput({
        ...repair,
        usage: mergeStructuredUsage(first.usage, repair.usage),
        callCount: 2,
      });
    });
  }

  embed(input: EmbedInput, ctx: AiContext): Promise<ModelResult<number[][]>> {
    return this.run('embed', input, ctx, (p) => p.embed(input, ctx));
  }

  private async run<T>(
    op: ModelOp,
    input: { task: string; model?: string; maxCostCents?: number },
    ctx: AiContext,
    call: (p: ModelProvider) => Promise<ModelResult<T>>,
  ): Promise<ModelResult<T>> {
    const chain = this.router.route(op, input.task);
    if (chain.length === 0)
      throw new Error(`no model provider for ${op}/${input.task}`);

    // 预算门（收口② D）：task.maxCostCents 从纯声明变真闸——reserve-then-settle，
    // 账户（runId ?? workspaceId）超限即抛 BudgetExceededError（调用不发生=真拦截）。
    // settle 优先级：costUsd（按实）→ token 折算（centsFromTokens）→ est 兜底。
    const registeredTask =
      input.maxCostCents === undefined
        ? (await import('../ai-tasks/task-registry')).getTask(input.task)
        : undefined;
    const baseCents =
      input.maxCostCents ??
      registeredTask?.maxCostCents ??
      DEFAULT_LLM_EST_CENTS;
    // generateStructured 可能做一次校验-修复重试（第二次模型调用，见下）——预留**两次**上限，否则账户仅够
    // 一次时修复仍会执行、settle 后把账户打成负数（#51 P2）。settle 兜底仍用单次 baseCents（无 usage 时不高估）。
    const reserveCents =
      op === 'generateStructured' ? baseCents * 2 : baseCents;
    let reservation: { runId: string; estCents: number };
    try {
      reservation = this.budget.reserve(
        ctx.runId ?? ctx.workspaceId,
        reserveCents,
      );
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
          modelPolicy: ctx.modelPolicy,
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
          settle(
            costUsd != null
              ? Math.ceil(costUsd * 100)
              : (centsFromTokens(result.usage) ??
                  baseCents * (result.callCount ?? 1)),
          );
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
            modelPolicy: ctx.modelPolicy,
          });
          return result;
        } catch (err) {
          // 改动 2：provider 消费了 token 却输出不可用（空/截断/非 JSON）→ 结算真实消耗，
          // 否则全链失败 finally settle(0) 会把真实 token 记 0¢、绕过硬预算上界。单次 settle 语义不变
          // （[real 抛带 usage, stub 成功]：real 先 settle → settled 置位 → stub 成功 settle no-op，只记 real）。
          const c =
            err instanceof ProviderOutputError
              ? (centsFromTokens(err.usage) ?? baseCents * err.callCount)
              : null;
          if (c != null) settle(c);
          const failedUsage =
            err instanceof ProviderOutputError ? err.usage : undefined;
          this.trace?.record({
            workspaceId: ctx.workspaceId,
            task: input.task,
            op,
            provider: provider.id,
            model: input.model ?? 'unknown',
            status: 'ERROR',
            errorMessage: String(err),
            latencyMs: Date.now() - started,
            inputTokens: failedUsage?.inputTokens,
            outputTokens: failedUsage?.outputTokens,
            correlationId: ctx.correlationId,
            modelPolicy: ctx.modelPolicy,
          });
          if (err instanceof TaskOutputValidationError) throw err;
          lastErr = err; // try the next provider (fallback)
        }
      }
      throw lastErr;
    } finally {
      settle(0); // 全链失败不计费（对齐 PRD 7.4.8）；成功路径已按实/按上限结算
    }
  }
}
