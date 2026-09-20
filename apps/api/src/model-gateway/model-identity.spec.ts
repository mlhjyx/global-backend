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
