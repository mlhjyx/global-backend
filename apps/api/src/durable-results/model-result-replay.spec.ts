import { describe, expect, it } from 'vitest';
import { projectModelResultForReplay, restoreModelResultFromReplay } from './model-result-replay';

describe('model result replay projection', () => {
  it('projects and restores a registered model result through the typed registry', () => {
    const projected = projectModelResultForReplay('taxonomy-code/v1', {
      data: { code: 'CPV-123' },
      provider: 'provider-a',
      model: 'model-a',
      usage: { inputTokens: 10, outputTokens: 2 },
    });

    expect(projected.kind).toBe('model');
    expect(projected.schema).toBe('taxonomy-code/v1');
    expect(projected.data).toHaveProperty('result');

    expect(restoreModelResultFromReplay('taxonomy-code/v1', projected)).toEqual({
      data: { code: 'CPV-123' },
      provider: 'provider-a',
      model: 'model-a',
    });
  });

  it('rejects provider payloads that try to smuggle prompts or raw responses', () => {
    expect(() =>
      projectModelResultForReplay('taxonomy-code/v1', {
        data: { code: 'CPV-123' },
        provider: 'provider-a',
        model: 'model-a',
        prompt: 'forbidden',
      }),
    ).toThrow('MODEL_RESULT_REPLAY_INVALID');
    expect(() =>
      projectModelResultForReplay('taxonomy-code/v1', {
        data: { code: 'CPV-123', rawResponse: 'forbidden' },
        provider: 'provider-a',
        model: 'model-a',
      }),
    ).toThrow('MODEL_RESULT_REPLAY_INVALID');
  });

  it('rejects schema drift on replay', () => {
    const projected = projectModelResultForReplay('taxonomy-code/v1', {
      data: { code: 'CPV-123' },
      provider: 'provider-a',
      model: 'model-a',
    });

    expect(() =>
      restoreModelResultFromReplay('fit-judgment/v1', projected),
    ).toThrow('MODEL_RESULT_REPLAY_INVALID');
  });
});
