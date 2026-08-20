import { ModelProvider } from './model-provider';
import {
  CANDIDATE_GATEWAY_VISION_TRANSPORTS,
  VERIFIED_GATEWAY_MODEL_TRANSPORTS,
} from './model-transports';
import { OpenAICompatibleProvider } from './providers/openai-compatible.provider';

export interface GatewayEvaluationConfig {
  /**
   * Reviewed repository fixture identity -> SHA-256. The normal runtime module
   * intentionally omits this; a task-shaped evaluation harness must pass its
   * immutable catalog explicitly.
   */
  visionEvalFixtureDigests?: Readonly<Record<string, string>>;
}

/**
 * The app talks to ONE aggregation gateway (中转站: new-api / one-api / LiteLLM).
 * All model management —接入厂商、各家 key、路由、额度、日志 — lives in the
 * gateway's own Web UI/config, NOT here. We only need its URL + one token.
 * Swapping the 中转站 later touches only this file (ADR-007).
 */
export function buildGatewayProvider(
  env: NodeJS.ProcessEnv = process.env,
  evaluation: GatewayEvaluationConfig = {},
): ModelProvider | null {
  const baseUrl = env.MODEL_GATEWAY_URL;
  const apiKey = env.MODEL_GATEWAY_KEY;
  if (!baseUrl || !apiKey) return null;
  return new OpenAICompatibleProvider({
    id: 'gateway',
    baseUrl,
    apiKey,
    // deepseek-chat/reasoner 旧别名官方 2026-07-24 起彻底关停，默认必须用显式 V4 型号
    model: env.MODEL_DEFAULT_MODEL ?? 'deepseek-v4-flash',
    modelTransports: VERIFIED_GATEWAY_MODEL_TRANSPORTS,
    visionModelTransports: CANDIDATE_GATEWAY_VISION_TRANSPORTS,
    visionEvalFixtureDigests: evaluation.visionEvalFixtureDigests,
  });
}
