import { Injectable, Optional } from '@nestjs/common';
import { ModelGateway } from './model-gateway';
import { ModelRouter } from './model-router';
import { ModelProvider } from './model-provider';
import { AiTraceSink } from './ai-trace.sink';
import { checkAgainstSchema } from './schema-validate';
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
    let lastErr: unknown;
    for (const provider of chain) {
      const started = Date.now();
      try {
        const result = await call(provider);
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
  }
}
