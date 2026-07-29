import {
  AiContext,
  EmbedInput,
  GenerateStructuredInput,
  GenerateTextInput,
  HealthStatus,
  ModelOp,
  ModelResult,
  ReviewVisionInput,
} from './types';
import type {
  PaidModelCallPlan,
  PaidModelPreflightEvidence,
} from './paid-model-settlement';

/**
 * A single backend model provider: Anthropic, OpenAI, a LiteLLM proxy (which is
 * itself a multi-vendor aggregator), a local/Chinese model, or a stub.
 *
 * Register many; the ModelGateway routes across them and presents ONE API to
 * callers. Business code never imports a vendor SDK (ADR-007).
 */
export interface ModelProvider {
  readonly id: string;
  supports(op: ModelOp, task?: string): boolean;
  health(): Promise<HealthStatus>;
  /**
   * Required before every durable paid model execution. Implementations must
   * complete without invoking a generative endpoint.
   */
  preflightPaidCall?(
    input: PaidModelCallPlan,
    ctx: AiContext,
  ): Promise<PaidModelPreflightEvidence>;
  generateText(input: GenerateTextInput, ctx: AiContext): Promise<ModelResult<string>>;
  generateStructured<T = unknown>(
    input: GenerateStructuredInput,
    ctx: AiContext,
  ): Promise<ModelResult<T>>;
  reviewVision<T = unknown>(
    input: ReviewVisionInput,
    ctx: AiContext,
  ): Promise<ModelResult<T>>;
  embed(input: EmbedInput, ctx: AiContext): Promise<ModelResult<number[][]>>;
}
