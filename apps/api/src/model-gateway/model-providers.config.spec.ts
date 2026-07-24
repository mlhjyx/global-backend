import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { buildGatewayProvider } from './model-providers.config';

function providerEnv(): NodeJS.ProcessEnv {
  return {
    MODEL_GATEWAY_URL: 'http://gw.test/v1',
    MODEL_GATEWAY_KEY: 'test-key',
    MODEL_DEFAULT_MODEL: 'deepseek-v4-flash',
  };
}

function mockResponse(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })),
  );
}

function request(): { url: string; headers: Record<string, string> } {
  const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
  return {
    url: fetchMock.mock.calls[0][0] as string,
    headers: fetchMock.mock.calls[0][1].headers as Record<string, string>,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('buildGatewayProvider — verified production model transports', () => {
  it('Terra uses the verified native Responses endpoint', async () => {
    mockResponse({
      status: 'completed',
      model: 'gpt-5.6-terra',
      output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const provider = buildGatewayProvider(providerEnv());
    expect(provider).not.toBeNull();
    await provider!.generateStructured({
      task: 'site_builder.brand_profile',
      model: 'gpt-5.6-terra',
      prompt: 'p',
      schema: {},
      maxTokens: 100,
    });
    expect(request().url).toBe('http://gw.test/v1/responses');
  });

  it('Sonnet uses the verified native Messages endpoint and headers', async () => {
    mockResponse({
      stop_reason: 'end_turn',
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: '{"ok":true}' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const provider = buildGatewayProvider(providerEnv());
    expect(provider).not.toBeNull();
    await provider!.generateStructured({
      task: 'site_builder.brand_profile',
      model: 'claude-sonnet-5',
      prompt: 'p',
      schema: {},
      maxTokens: 100,
    });
    expect(request()).toMatchObject({
      url: 'http://gw.test/v1/messages',
      headers: {
        'x-api-key': 'test-key',
        'anthropic-version': '2023-06-01',
      },
    });
  });

  it('unregistered models keep the existing OpenAI Chat transport', async () => {
    mockResponse({
      model: 'deepseek-v4-flash',
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const provider = buildGatewayProvider(providerEnv());
    expect(provider).not.toBeNull();
    await provider!.generateStructured({
      task: 'legacy',
      model: 'deepseek-v4-flash',
      prompt: 'p',
      schema: {},
      maxTokens: 100,
    });
    expect(request().url).toBe('http://gw.test/v1/chat/completions');
  });

  it('registers the Gemini vision adapter without changing any active text route', async () => {
    mockResponse({
      model: 'gemini-3.5-flash',
      choices: [
        { message: { content: '{"ok":true}' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const provider = buildGatewayProvider(providerEnv());
    expect(provider?.supports('reviewVision')).toBe(true);
    const bytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    await provider!.reviewVision({
      task: 'site_builder.aesthetic_review',
      model: 'gemini-3.5-flash',
      prompt: 'review',
      schema: {},
      maxTokens: 100,
      maxCostCents: 20,
      images: [
        {
          materialClass: 'workspace_site_screenshot',
          workspaceId: 'workspace-test',
          artifactId: 'case-home-375',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          mimeType: 'image/png',
          bytes,
          target: { locale: 'en', pageId: 'home', breakpoint: 375 },
        },
      ],
    });
    expect(request().url).toBe('http://gw.test/v1/chat/completions');
  });
});
