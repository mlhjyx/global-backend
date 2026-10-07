import { describe, expect, it } from 'vitest';
import {
  canonicalReportedModelIdentifier,
  hasTrustedModelIdentity,
  resolveReportedModelIdentity,
} from './model-identity';

describe('model identity aliases', () => {
  it('resolves the reviewed Gemini alias only on its exact transport', () => {
    expect(
      resolveReportedModelIdentity(
        'gemini-3.5-flash',
        'gemini-default',
        'google-generate-content',
      ),
    ).toBe('gemini-3.5-flash');
  });

  it('rejects a reviewed alias when transport provenance is missing', () => {
    expect(
      resolveReportedModelIdentity('gemini-3.5-flash', 'gemini-default'),
    ).toBeUndefined();
  });

  it('rejects a reviewed alias on an unreviewed transport', () => {
    expect(
      hasTrustedModelIdentity({
        requestedModel: 'gemini-3.5-flash',
        reportedModel: 'gemini-default',
        resolvedModel: 'gemini-3.5-flash',
        transport: 'openai-chat-completions',
      }),
    ).toBe(false);
  });

  it('accepts an exact reported identity without alias transport metadata', () => {
    expect(
      hasTrustedModelIdentity({
        requestedModel: 'gpt-5.6-sol',
        reportedModel: 'gpt-5.6-sol',
        resolvedModel: 'gpt-5.6-sol',
      }),
    ).toBe(true);
  });

  it.each([
    [undefined, undefined],
    [null, undefined],
    [42, undefined],
    [' model with spaces ', undefined],
    [`m${'x'.repeat(120)}`, undefined],
    ['gpt-5.6-terra', 'gpt-5.6-terra'],
  ])('bounds an untrusted reported-model value %j', (value, expected) => {
    expect(canonicalReportedModelIdentifier(value)).toBe(expected);
  });
});

describe('DeepSeek v4 pro upstream identity aliases (OpenOx, observed 2026-10-07)', () => {
  // The same model is reported as a provider-prefixed name in stream chunks
  // and as a dated GA build in plain bodies. Only these two reviewed names
  // resolve, and only on the chat-completions transport that produced them.
  it.each(['deepseek.deepseek-v4-pro', 'deepseek-v4-pro-ga-260813'])(
    'resolves the reviewed pro alias %s on chat completions',
    (reported) => {
      expect(
        resolveReportedModelIdentity(
          'deepseek-v4-pro',
          reported,
          'openai-chat-completions',
        ),
      ).toBe('deepseek-v4-pro');
    },
  );

  it.each([undefined, 'openai-responses', 'anthropic-messages'])(
    'rejects the reviewed pro alias without its exact transport (%s)',
    (transport) => {
      expect(
        resolveReportedModelIdentity(
          'deepseek-v4-pro',
          'deepseek.deepseek-v4-pro',
          transport,
        ),
      ).toBeUndefined();
    },
  );

  it('still rejects another model family reported for pro', () => {
    expect(
      resolveReportedModelIdentity(
        'deepseek-v4-pro',
        'gpt-5.6-sol',
        'openai-chat-completions',
      ),
    ).toBeUndefined();
  });

  it.each(['deepseek-v4-pro', 'deepseek.deepseek-v4-pro'])(
    'never lets a pro identity (%s) stand in for a flash request',
    (reported) => {
      expect(
        resolveReportedModelIdentity(
          'deepseek-v4-flash',
          reported,
          'openai-chat-completions',
        ),
      ).toBeUndefined();
    },
  );
});
