import type { GatewayModelTransport } from './providers/openai-compatible.provider';
import type { GatewayVisionTransport } from './providers/openai-compatible.provider';

/**
 * Model-to-wire-protocol bindings proven through the current New API gateway.
 * Unknown models deliberately retain the provider's OpenAI Chat default.
 */
export const VERIFIED_GATEWAY_MODEL_TRANSPORTS: Readonly<Record<string, GatewayModelTransport>> = Object.freeze({
  // Keep Terra on the protocol used by the locked 12/12 evidence. The live
  // Chat route twice returned finish_reason=stop with no visible content for
  // the same task-shaped fixture; reasoning-only fields must not be promoted
  // to business output as a workaround.
  'gpt-5.6-terra': 'openai-responses',
  'claude-sonnet-5': 'anthropic-messages',
});

/**
 * Explicit wire adapter registrations for MODEL-1 vision probes. Registration
 * means only that the application knows how to shape the request; it is not a
 * capability or promotion claim. PR6 must still prove the live model, schema,
 * provenance, latency, and cost before any route can be activated.
 */
export const CANDIDATE_GATEWAY_VISION_TRANSPORTS: Readonly<Record<string, GatewayVisionTransport>> = Object.freeze({
  'gemini-3.5-flash': 'google-generate-content',
  'gpt-5.6-terra': 'openai-responses',
  'gpt-5.6-sol': 'openai-responses',
  'claude-sonnet-5': 'anthropic-messages',
});
