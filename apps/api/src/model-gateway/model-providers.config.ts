import { ModelProvider } from './model-provider';
import { OpenAICompatibleProvider } from './providers/openai-compatible.provider';

/**
 * The app talks to ONE aggregation gateway (中转站: new-api / one-api / LiteLLM).
 * All model management —接入厂商、各家 key、路由、额度、日志 — lives in the
 * gateway's own Web UI/config, NOT here. We only need its URL + one token.
 * Swapping the 中转站 later touches only this file (ADR-007).
 */
export function buildGatewayProvider(env: NodeJS.ProcessEnv = process.env): ModelProvider | null {
  const baseUrl = env.MODEL_GATEWAY_URL;
  const apiKey = env.MODEL_GATEWAY_KEY;
  if (!baseUrl || !apiKey) return null; // not configured yet → stub covers it
  return new OpenAICompatibleProvider({
    id: 'gateway',
    baseUrl,
    apiKey,
    model: env.MODEL_DEFAULT_MODEL ?? 'deepseek-chat',
  });
}
