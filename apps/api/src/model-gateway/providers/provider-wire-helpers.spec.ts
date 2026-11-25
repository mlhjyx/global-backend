import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SseResponseTooLargeError,
  buildAnthropicMessagesControlFields,
  classifyBoundedStreamReadError,
  detectUpstreamChannelExhausted,
  fetchWith429Backoff,
  modelDeprecatesTemperature,
  readBoundedResponseText,
  wireTemperatureField,
} from './provider-wire-helpers';

describe('provider-wire-helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('omits temperature for claude-haiku-5-5, claude-sonnet-5-5, and claude-fable-5-*', () => {
    expect(modelDeprecatesTemperature('claude-haiku-5-5')).toBe(true);
    expect(modelDeprecatesTemperature('claude-sonnet-5-5')).toBe(true);
    expect(modelDeprecatesTemperature('claude-fable-5-1')).toBe(true);
    expect(modelDeprecatesTemperature('claude-fable-5-2')).toBe(true);
    expect(modelDeprecatesTemperature('deepseek-flash')).toBe(false);

    expect(wireTemperatureField('claude-sonnet-5-5', 0.2)).toEqual({});
    expect(wireTemperatureField('deepseek-flash', 0.3)).toEqual({ temperature: 0.3 });
    expect(wireTemperatureField('deepseek-flash', undefined)).toEqual({ temperature: 0.2 });
  });

  it('omits temperature on Anthropic Messages when thinking is enabled or model deprecates it', () => {
    const thinking = buildAnthropicMessagesControlFields({
      model: 'claude-sonnet-5',
      temperature: 0.2,
      reasoningEffort: 'medium',
      outputSchema: { type: 'object' },
    });
    expect(thinking).not.toHaveProperty('temperature');
    expect(thinking).toMatchObject({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      tool_choice: { type: 'any', disable_parallel_tool_use: true },
    });

    const sonnet55 = buildAnthropicMessagesControlFields({
      model: 'claude-sonnet-5-5',
      temperature: 0.2,
    });
    expect(sonnet55).not.toHaveProperty('temperature');
  });

  it('enforces bounded SSE stream response size', async () => {
    const small = new Response('data: {"ok":true}\n\n');
    await expect(readBoundedResponseText(small, 1024)).resolves.toContain('{"ok":true}');

    const oversized = new Response('x'.repeat(2048));
    await expect(readBoundedResponseText(oversized, 128)).rejects.toBeInstanceOf(
      SseResponseTooLargeError,
    );
    expect(classifyBoundedStreamReadError(new SseResponseTooLargeError(128)).reasonCode).toBe(
      'CHAT_COMPLETIONS_STREAM_TOO_LARGE',
    );
  });

  it('retries HTTP 429 with Retry-After and stops after maxRetries', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

    const res = await fetchWith429Backoff('http://gw.test/v1/chat/completions', { method: 'POST' }, {
      maxRetries: 2,
      baseDelayMs: 1,
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('detects 403 upstream channel exhaustion while ignoring auth/permission 403 and non-403', async () => {
    const exhausted = new Response(
      JSON.stringify({
        type: 'error',
        error: { type: 'new_api_error', message: 'The token for the current grouped routing channel has been exhausted' },
      }),
      { status: 403 },
    );
    await expect(detectUpstreamChannelExhausted(exhausted)).resolves.toBe(true);

    const authDenied = new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 403 });
    await expect(detectUpstreamChannelExhausted(authDenied)).resolves.toBe(false);

    const okRes = new Response('channel exhausted', { status: 200 });
    await expect(detectUpstreamChannelExhausted(okRes)).resolves.toBe(false);
  });
});
