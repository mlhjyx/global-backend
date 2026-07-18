import { describe, expect, it } from 'vitest';

import { VERIFIED_GATEWAY_MODEL_TRANSPORTS } from './model-transports';

describe('verified gateway model transports', () => {
  it('keeps Terra on Responses so reasoning-only Chat completions cannot become empty artifacts', () => {
    expect(VERIFIED_GATEWAY_MODEL_TRANSPORTS['gpt-5.6-terra']).toBe(
      'openai-responses',
    );
  });

  it('keeps Sonnet on native Messages', () => {
    expect(VERIFIED_GATEWAY_MODEL_TRANSPORTS['claude-sonnet-5']).toBe(
      'anthropic-messages',
    );
  });
});
