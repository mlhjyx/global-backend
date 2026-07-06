import { Injectable } from '@nestjs/common';
import { ModelGateway } from './model-gateway';
import { ModelRouter } from './model-router';
import { ModelProvider } from './model-provider';
import {
  AiContext,
  EmbedInput,
  GenerateStructuredInput,
  GenerateTextInput,
  ModelOp,
  ModelResult,
} from './types';

/** Routes each call across the provider chain, falling back on failure (PRD 9.5). */
@Injectable()
export class RouterModelGateway extends ModelGateway {
  constructor(private readonly router: ModelRouter) {
    super();
  }

  generateText(input: GenerateTextInput, ctx: AiContext): Promise<ModelResult<string>> {
    return this.run('generateText', input.task, (p) => p.generateText(input, ctx));
  }

  generateStructured<T = unknown>(
    input: GenerateStructuredInput,
    ctx: AiContext,
  ): Promise<ModelResult<T>> {
    return this.run('generateStructured', input.task, (p) => p.generateStructured<T>(input, ctx));
  }

  embed(input: EmbedInput, ctx: AiContext): Promise<ModelResult<number[][]>> {
    return this.run('embed', input.task, (p) => p.embed(input, ctx));
  }

  private async run<R>(
    op: ModelOp,
    task: string,
    call: (p: ModelProvider) => Promise<R>,
  ): Promise<R> {
    const chain = this.router.route(op, task);
    if (chain.length === 0) throw new Error(`no model provider for ${op}/${task}`);
    let lastErr: unknown;
    for (const provider of chain) {
      try {
        return await call(provider);
      } catch (err) {
        lastErr = err; // try the next provider (fallback)
      }
    }
    throw lastErr;
  }
}
