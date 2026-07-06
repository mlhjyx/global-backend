import {
  AiContext,
  EmbedInput,
  GenerateStructuredInput,
  GenerateTextInput,
  ModelResult,
} from './types';

/**
 * The single unified API business code depends on (PRD 9.5 / 9.12). Behind it:
 * many providers, routed and aggregated with fallback. Swapping providers — or
 * the whole LiteLLM kernel — never changes callers.
 */
export abstract class ModelGateway {
  abstract generateText(input: GenerateTextInput, ctx: AiContext): Promise<ModelResult<string>>;
  abstract generateStructured<T = unknown>(
    input: GenerateStructuredInput,
    ctx: AiContext,
  ): Promise<ModelResult<T>>;
  abstract embed(input: EmbedInput, ctx: AiContext): Promise<ModelResult<number[][]>>;
}
