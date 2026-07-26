import { describe, expect, it } from 'vitest';
import {
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
      resolveReportedModelIdentity(
        'gemini-3.5-flash',
        'gemini-default',
      ),
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
});
