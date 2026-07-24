import { describe, expect, it } from 'vitest';

import { CANDIDATE_GATEWAY_VISION_TRANSPORTS, VERIFIED_GATEWAY_MODEL_TRANSPORTS } from './model-transports';

describe('verified gateway model transports', () => {
  it('keeps Terra on Responses so reasoning-only Chat completions cannot become empty artifacts', () => {
    expect(VERIFIED_GATEWAY_MODEL_TRANSPORTS['gpt-5.6-terra']).toBe('openai-responses');
  });

  it('keeps Sonnet on native Messages', () => {
    expect(VERIFIED_GATEWAY_MODEL_TRANSPORTS['claude-sonnet-5']).toBe('anthropic-messages');
  });

  it('registers only task-probed vision candidate adapters without promoting a route', () => {
    expect(CANDIDATE_GATEWAY_VISION_TRANSPORTS).toEqual({
      'gemini-3.5-flash': 'google-generate-content',
      'gpt-5.6-terra': 'openai-responses',
      'gpt-5.6-sol': 'openai-responses',
      'claude-sonnet-5': 'anthropic-messages',
    });
  });
});
