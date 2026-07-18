import type { GatewayModelTransport } from './providers/openai-compatible.provider';

/**
 * Model-to-wire-protocol bindings proven through the current New API gateway.
 * Unknown models deliberately retain the provider's OpenAI Chat default.
 */
export const VERIFIED_GATEWAY_MODEL_TRANSPORTS: Readonly<
  Record<string, GatewayModelTransport>
> = Object.freeze({
  'gpt-5.6-terra': 'openai-responses',
  'claude-sonnet-5': 'anthropic-messages',
});
