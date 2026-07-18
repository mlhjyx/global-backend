import type { GatewayModelTransport } from './providers/openai-compatible.provider';

/**
 * Model-to-wire-protocol bindings proven through the current New API gateway.
 * Unknown models deliberately retain the provider's OpenAI Chat default.
 */
export const VERIFIED_GATEWAY_MODEL_TRANSPORTS: Readonly<
  Record<string, GatewayModelTransport>
> = Object.freeze({
  // Keep Terra on the protocol used by the locked 12/12 evidence. The live
  // Chat route twice returned finish_reason=stop with no visible content for
  // the same task-shaped fixture; reasoning-only fields must not be promoted
  // to business output as a workaround.
  'gpt-5.6-terra': 'openai-responses',
  'claude-sonnet-5': 'anthropic-messages',
});
