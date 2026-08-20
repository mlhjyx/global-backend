import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as modelProviderConfig from './model-providers.config';
import { buildGatewayProvider } from './model-providers.config';
import type { ModelProvider } from './model-provider';

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
  it('does not expose an environment-controlled product stub policy', () => {
    expect(modelProviderConfig).not.toHaveProperty('stubAllowed');
  });

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
      stop_reason: 'tool_use',
      model: 'claude-sonnet-5',
      content: [{ type: 'tool_use', name: 'json', input: { ok: true } }],
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

  it('keeps the provider online without any settlement-attestation wiring', async () => {
    // 24h settlement attestation 与逐请求 preflight 已整体移除：付费闸门
    // 上移到 Router 的 reconciliation catalog（缺条目 fail closed）与
    // Worker readiness（缺目录不 ready）。provider 不再读取这些环境变量，
    // 也不再暴露 preflightPaidCall；普通调用保持在线。
    mockResponse({
      model: 'deepseek-v4-flash',
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const provider = buildGatewayProvider({
      ...providerEnv(),
      SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_PATH:
        '/missing/site-builder-settlement-attestation.json',
      SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_SHA256: 'a'.repeat(64),
    });
    expect(provider).not.toBeNull();
    expect(
      (provider as Partial<ModelProvider>).preflightPaidCall,
    ).toBeUndefined();
    await expect(
      provider!.generateStructured({
        task: 'legacy',
        model: 'deepseek-v4-flash',
        prompt: 'p',
        schema: {},
        maxTokens: 100,
      }),
    ).resolves.toMatchObject({ data: { ok: true } });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('registers the native Gemini vision adapter without changing any active text route', async () => {
    mockResponse({
      modelVersion: 'gemini-3.5-flash',
      candidates: [
        {
          content: { parts: [{ text: '{"ok":true}' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    const provider = buildGatewayProvider(providerEnv());
    expect(provider?.supports('reviewVision')).toBe(true);
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
    expect(request().url).toBe('http://gw.test/v1beta/models/gemini-3.5-flash:generateContent');
  });

  it('accepts a reviewed eval fixture catalog only through the explicit evaluation seam', async () => {
    mockResponse({
      modelVersion: 'gemini-3.5-flash',
      candidates: [
        {
          content: { parts: [{ text: '{"ok":true}' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const provider = buildGatewayProvider(providerEnv(), {
      visionEvalFixtureDigests: { 'fixture-home-375': digest },
    });
    await provider!.reviewVision({
      task: 'site_builder.aesthetic_review.eval',
      model: 'gemini-3.5-flash',
      prompt: 'review fixture',
      schema: {},
      maxTokens: 100,
      maxCostCents: 20,
      images: [
        {
          materialClass: 'model_eval_fixture',
          artifactId: 'fixture-home-375',
          sha256: digest,
          mimeType: 'image/png',
          bytes,
          target: { locale: 'en', pageId: 'home', breakpoint: 375 },
        },
      ],
    });
    expect(request().url).toBe('http://gw.test/v1beta/models/gemini-3.5-flash:generateContent');
  });
});
