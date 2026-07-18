import type { GatewayModelTransport } from './providers/openai-compatible.provider';

/**
 * Model-to-wire-protocol bindings proven through the current New API gateway.
 * Unknown models deliberately retain the provider's OpenAI Chat default.
 */
export const VERIFIED_GATEWAY_MODEL_TRANSPORTS: Readonly<
  Record<string, GatewayModelTransport>
> = Object.freeze({
  // TeamoRouter documents both OpenAI formats for GPT models, but the live
  // Terra Responses route intermittently reaches an upstream that requires a
  // Chat `messages` body. Repeated Chat probes were stable, so production and
  // evaluation deliberately use the compatible Chat wire format.
  'gpt-5.6-terra': 'openai-chat-completions',
  'claude-sonnet-5': 'anthropic-messages',
});
