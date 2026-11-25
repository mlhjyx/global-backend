import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isCrossChannelFallbackEnabled,
  resolveCrossChannelFallbackModels,
} from './model-fallback';
import type { ModelGateway } from './model-gateway';
import { ProviderHttpError } from './providers/provider-output-error';
import { executeStructuredTaskWithRuntime } from '../model-runtime/structured-task-runtime-bridge';

describe('model-fallback (Batch 1.4-A cross-channel resilience)', () => {
  afterEach(() => {
    delete process.env.MODEL_CROSS_CHANNEL_FALLBACK_ENABLED;
    delete process.env.MODEL_CROSS_CHANNEL_FALLBACKS_JSON;
    vi.restoreAllMocks();
  });

  it('stays disabled by default when neither flag nor JSON map is configured', () => {
    expect(isCrossChannelFallbackEnabled({})).toBe(false);
    expect(resolveCrossChannelFallbackModels('claude-sonnet-5-5', 'outreach.first_contact_draft', {})).toEqual([]);
  });

  it('returns reviewed cross-channel fallbacks for outreach when enabled', () => {
    const env = { MODEL_CROSS_CHANNEL_FALLBACK_ENABLED: 'on' };
    expect(resolveCrossChannelFallbackModels('claude-sonnet-5-5', 'outreach.first_contact_draft', env)).toEqual([
      'gpt-6.2-sol',
      'deepseek-flash',
    ]);
    expect(resolveCrossChannelFallbackModels('gpt-6-luna', 'discovery.quick_judge', env)).toEqual([
      'deepseek-flash',
      'gpt-6.2-sol',
    ]);
  });

  it('enforces JUDGE_MODEL_ALLOWLIST on discovery.qualify_fit and blocks non-allowlisted flash models', () => {
    const env = {
      MODEL_CROSS_CHANNEL_FALLBACK_ENABLED: 'on',
      MODEL_CROSS_CHANNEL_FALLBACKS_JSON: JSON.stringify({
        'gpt-6.2-sol': ['deepseek-flash', 'claude-sonnet-5-5', 'gemini-4-argon'],
      }),
    };
    expect(resolveCrossChannelFallbackModels('gpt-6.2-sol', 'discovery.qualify_fit', env)).toEqual([
      'claude-sonnet-5-5',
      'gemini-4-argon',
    ]);
  });

  it('honors explicit off override even if fallback JSON is present', () => {
    const env = {
      MODEL_CROSS_CHANNEL_FALLBACK_ENABLED: 'off',
      MODEL_CROSS_CHANNEL_FALLBACKS_JSON: '{"claude-sonnet-5-5":["gpt-6.2-sol"]}',
    };
    expect(isCrossChannelFallbackEnabled(env)).toBe(false);
    expect(resolveCrossChannelFallbackModels('claude-sonnet-5-5', 'outreach.first_contact_draft', env)).toEqual([]);
  });

  it('executeStructuredTaskWithRuntime falls back on definite unbilled 503 and refuses fallback on 504 timeout', async () => {
    process.env.MODEL_CROSS_CHANNEL_FALLBACK_ENABLED = 'on';
    const seen: Array<{ model: string | undefined; correlationId: string | undefined }> = [];
    const schema = {
      type: 'object',
      required: ['subject', 'body', 'body_zh', 'language', 'cited_claim_ids'],
      properties: {
        subject: { type: 'string' },
        body: { type: 'string' },
        body_zh: { type: 'string' },
        language: { type: 'string' },
        cited_claim_ids: { type: 'array', items: { type: 'string' } },
      },
    };
    const stubGateway = {
      generateStructured: async (input: { model?: string }, ctx: { correlationId?: string }) => {
        seen.push({ model: input.model, correlationId: ctx.correlationId });
        if (input.model === 'claude-sonnet-5-5') {
          throw new ProviderHttpError({
            provider: 'gateway',
            model: 'claude-sonnet-5-5',
            status: 503,
            body: 'channel unavailable',
          });
        }
        return {
          data: {
            subject: 'Quick check',
            body: 'Hello team',
            body_zh: '你好',
            language: 'en',
            cited_claim_ids: [],
          },
          provider: 'gateway',
          model: input.model ?? 'gpt-6.2-sol',
          usage: { inputTokens: 20, outputTokens: 30 },
        };
      },
    } as unknown as ModelGateway;

    const ok = await executeStructuredTaskWithRuntime(
      stubGateway,
      {
        task: 'outreach.first_contact_draft',
        model: 'claude-sonnet-5-5',
        prompt: 'draft email',
        schema,
      },
      { workspaceId: 'ws-1', correlationId: 'corr-1' },
    );
    expect(ok.model).toBe('gpt-6.2-sol');
    expect(seen).toEqual([
      { model: 'claude-sonnet-5-5', correlationId: 'corr-1' },
      { model: 'gpt-6.2-sol', correlationId: 'corr-1:fb:gpt-6.2-sol' },
    ]);

    // HTTP 504 may have been billed upstream (D13): must NOT trigger cross-channel fallback.
    seen.length = 0;
    const gw504 = {
      generateStructured: async (input: { model?: string }, ctx: { correlationId?: string }) => {
        seen.push({ model: input.model, correlationId: ctx.correlationId });
        throw new ProviderHttpError({
          provider: 'gateway',
          model: 'claude-sonnet-5-5',
          status: 504,
          body: 'gateway timeout',
        });
      },
    } as unknown as ModelGateway;
    await expect(
      executeStructuredTaskWithRuntime(
        gw504,
        {
          task: 'outreach.first_contact_draft',
          model: 'claude-sonnet-5-5',
          prompt: 'draft email',
          schema,
        },
        { workspaceId: 'ws-1', correlationId: 'corr-2' },
      ),
    ).rejects.toBeInstanceOf(ProviderHttpError);
    expect(seen).toEqual([{ model: 'claude-sonnet-5-5', correlationId: 'corr-2' }]);
  });
});
