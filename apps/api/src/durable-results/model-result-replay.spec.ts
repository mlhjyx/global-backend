import { describe, expect, it } from 'vitest';
import { projectModelResultForReplay, restoreModelResultFromReplay } from './model-result-replay';

describe('model result replay projection', () => {
  it('projects and restores a registered model result through the typed registry', () => {
    const projected = projectModelResultForReplay('taxonomy-code/v1', {
      data: { code: 'CPV-123' },
      provider: 'provider-a',
      model: 'model-a',
      reportedModel: 'upstream-model-a',
      modelResolutionSource: 'upstream_response',
      usage: { inputTokens: 10, outputTokens: 2 },
      callCount: 1,
    });

    expect(projected.kind).toBe('model');
    expect(projected.schema).toBe('taxonomy-code/v1');
    expect(projected.data).toHaveProperty('result');

    expect(restoreModelResultFromReplay('taxonomy-code/v1', projected)).toEqual({
      data: { code: 'CPV-123' },
      provider: 'provider-a',
      model: 'model-a',
      reportedModel: 'upstream-model-a',
      modelResolutionSource: 'upstream_response',
      usage: { inputTokens: 10, outputTokens: 2 },
      callCount: 1,
    });
  });

  it('projects and restores bounded gateway settlement observations byte-identically', () => {
    const projected = projectModelResultForReplay('taxonomy-code/v1', {
      data: { code: 'CPV-123' },
      provider: 'provider-a',
      model: 'model-a',
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        gatewaySettlements: [
          {
            status: 'settled',
            requestId: 'req_123',
            resolverId: 'resolver-v1',
            alias: 'site-builder-copywriter',
            protocol: 'openai-chat-completions',
            channelId: 7,
            basis: 'openox_catalog_token_pricing',
            quota: 1250,
            costMicrousd: 2500,
            inputTokens: 10,
            outputTokens: 2,
          },
          {
            status: 'unknown',
            requestId: null,
            resolverId: 'resolver-v1',
            reason: 'log_unavailable',
          },
        ],
      },
      callCount: 2,
    });

    expect(restoreModelResultFromReplay('taxonomy-code/v1', projected)).toEqual({
      data: { code: 'CPV-123' },
      provider: 'provider-a',
      model: 'model-a',
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        gatewaySettlements: [
          {
            status: 'settled',
            requestId: 'req_123',
            resolverId: 'resolver-v1',
            alias: 'site-builder-copywriter',
            protocol: 'openai-chat-completions',
            channelId: 7,
            basis: 'openox_catalog_token_pricing',
            quota: 1250,
            costMicrousd: 2500,
            inputTokens: 10,
            outputTokens: 2,
          },
          {
            status: 'unknown',
            requestId: null,
            resolverId: 'resolver-v1',
            reason: 'log_unavailable',
          },
        ],
      },
      callCount: 2,
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

  it('rejects malformed replay envelopes without returning a partial model result', () => {
    const projected = projectModelResultForReplay('taxonomy-code/v1', {
      data: { code: 'CPV-123' },
      provider: 'provider-a',
      model: 'model-a',
    });

    expect(() =>
      restoreModelResultFromReplay('taxonomy-code/v1', {
        ...projected,
        data: { output: projected.data },
      }),
    ).toThrow('MODEL_RESULT_REPLAY_INVALID');
    expect(() =>
      restoreModelResultFromReplay('taxonomy-code/v1', {
        ...projected,
        digest: 'b'.repeat(64),
      }),
    ).toThrow('MODEL_RESULT_REPLAY_INVALID');
  });
});
