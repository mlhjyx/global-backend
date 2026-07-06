import { Injectable } from '@nestjs/common';
import { ModelProvider } from '../model-provider';
import {
  EmbedInput,
  GenerateStructuredInput,
  GenerateTextInput,
  HealthStatus,
  ModelOp,
  ModelResult,
} from '../types';

/**
 * Deterministic, key-free provider so the understanding pipeline runs before real
 * models are wired. Kept last in the routing order; real providers (Anthropic /
 * OpenAI / LiteLLM) take precedence once registered.
 */
@Injectable()
export class StubModelProvider implements ModelProvider {
  readonly id = 'stub';

  supports(_op: ModelOp): boolean {
    return true;
  }

  async health(): Promise<HealthStatus> {
    return { healthy: true, detail: 'stub' };
  }

  async generateText(input: GenerateTextInput): Promise<ModelResult<string>> {
    return {
      data: `[stub:${input.task}] ${input.prompt.slice(0, 80)}`,
      provider: this.id,
      model: 'stub-v0',
    };
  }

  async generateStructured<T = unknown>(
    input: GenerateStructuredInput,
  ): Promise<ModelResult<T>> {
    // Placeholder shaped by the schema's top-level required keys.
    const shape: Record<string, unknown> = {};
    const required = (input.schema?.required as string[] | undefined) ?? [];
    for (const key of required) shape[key] = null;
    return { data: shape as T, provider: this.id, model: 'stub-v0' };
  }

  async embed(input: EmbedInput): Promise<ModelResult<number[][]>> {
    const vectors = input.input.map(() => Array.from({ length: 8 }, () => 0));
    return { data: vectors, provider: this.id, model: 'stub-embed-v0' };
  }
}
