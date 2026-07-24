import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider, stripJsonFence } from './openai-compatible.provider';
import {
  ProviderHttpError,
  ProviderIdentityError,
  ProviderOutputError,
} from './provider-output-error';

/**
 * M1-b 网关增量（09 §2.4 AiTask 工程护栏的 provider 侧）：
 * ① reasoning_effort 透传（copy 🔴 必配 low，否则 v4 reasoning 延迟不可用）；
 * ② 空输出显式失败（H2 实证：reasoning 模型 max_tokens 过小时 finish_reason=length
 *    且 content 为空——必须给出可诊断错误，而非 JSON.parse('') 的 SyntaxError）。
 */

const provider = new OpenAICompatibleProvider({
  id: 'gateway',
  baseUrl: 'http://gw.test/v1',
  apiKey: 'k',
  model: 'default-model',
});

function mockChatResponse(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })),
  );
}

const lastRequestBody = (): Record<string, unknown> => {
  const mock = fetch as unknown as ReturnType<typeof vi.fn>;
  return JSON.parse(mock.mock.calls[0][1].body as string) as Record<string, unknown>;
};

const lastRequestUrl = (): string => {
  const mock = fetch as unknown as ReturnType<typeof vi.fn>;
  return mock.mock.calls[0][0] as string;
};

const lastRequestHeaders = (): Record<string, string> => {
  const mock = fetch as unknown as ReturnType<typeof vi.fn>;
  return mock.mock.calls[0][1].headers as Record<string, string>;
};

afterEach(() => vi.unstubAllGlobals());

const png = (suffix = 0): Uint8Array =>
  Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, suffix,
  ]);
const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const visionInput = () => ({
  task: 'site_builder.aesthetic_review.eval',
  prompt: 'Review the three responsive screenshots.',
  system: 'Return bounded findings only.',
  model: 'gemini-3.5-flash',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok'],
    properties: { ok: { type: 'boolean' } },
  },
  maxTokens: 1000,
  maxCostCents: 20,
  images: ([375, 768, 1440] as const).map((breakpoint, index) => {
    const bytes = png(index);
    return {
      materialClass: 'model_eval_fixture' as const,
      artifactId: `case-home-${breakpoint}`,
      sha256: sha256(bytes),
      mimeType: 'image/png' as const,
      bytes,
      target: { locale: 'en', pageId: 'home', breakpoint },
    };
  }),
});

describe('OpenAICompatibleProvider — reasoning_effort 透传', () => {
  it('入参带 reasoningEffort → 请求体含 reasoning_effort', async () => {
    mockChatResponse({
      choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }],
      usage: {},
    });
    await provider.generateStructured({
      task: 't',
      prompt: 'p',
      schema: {},
      reasoningEffort: 'low',
    });
    expect(lastRequestBody().reasoning_effort).toBe('low');
  });

  it('未指定 → 请求体不带 reasoning_effort（不干扰非 reasoning 模型）', async () => {
    mockChatResponse({
      choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }],
      usage: {},
    });
    await provider.generateStructured({ task: 't', prompt: 'p', schema: {} });
    expect('reasoning_effort' in lastRequestBody()).toBe(false);
  });
});

describe('OpenAICompatibleProvider — 空输出显式失败', () => {
  it('content 为空 + finish_reason=length → 抛 ProviderOutputError（含 finish_reason/模型名，携带 usage）', async () => {
    mockChatResponse({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 300, completion_tokens: 2000 },
    });
    const err = await provider
      .generateStructured({ task: 't', prompt: 'p', schema: {}, model: 'deepseek-v4-pro' })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderOutputError);
    expect((err as Error).message).toMatch(/empty content.*finish_reason=length/s);
    // 🔴 改动 2：花了 token 却失败必须带 usage，供网关 catch 结算（否则绕过硬预算上界）
    expect((err as ProviderOutputError).usage).toEqual({ inputTokens: 300, outputTokens: 2000 });
  });

  it('content 为空 + finish_reason=stop → 明确为可见内容通道异常，不能误报截断', async () => {
    mockChatResponse({
      choices: [{ message: { content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 300, completion_tokens: 794 },
    });
    const err = await provider
      .generateStructured({ task: 't', prompt: 'p', schema: {}, model: 'gpt-5.6-terra' })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderOutputError);
    expect((err as Error).message).toMatch(/empty content.*finish_reason=stop.*no visible message content/s);
    expect((err as Error).message).not.toMatch(/output truncated/);
    expect((err as ProviderOutputError).usage).toEqual({ inputTokens: 300, outputTokens: 794 });
  });

  it('content 正常 → 照常解析', async () => {
    mockChatResponse({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: {},
    });
    const r = await provider.generateStructured<{ ok: boolean }>({
      task: 't',
      prompt: 'p',
      schema: {},
    });
    expect(r.data.ok).toBe(true);
  });

  it('new-api 返回已解析模型时，保留该模型用于可重放 trace', async () => {
    mockChatResponse({
      model: 'upstream/claude-sonnet-5-2026-07-18',
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: {},
    });
    const r = await provider.generateStructured<{ ok: boolean }>({ task: 't', prompt: 'p', schema: {} });
    expect(r).toMatchObject({
      model: 'upstream/claude-sonnet-5-2026-07-18',
      reportedModel: 'upstream/claude-sonnet-5-2026-07-18',
      modelResolutionSource: 'upstream_response',
    });
  });

  it('上游不报告 model 时，显式标记为 requested fallback，不能冒充已解析模型', async () => {
    mockChatResponse({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: {},
    });
    const r = await provider.generateStructured<{ ok: boolean }>({
      task: 't',
      prompt: 'p',
      schema: {},
      model: 'requested-model',
    });
    expect(r).toMatchObject({
      model: 'requested-model',
      modelResolutionSource: 'requested_fallback',
    });
    expect(r.reportedModel).toBeUndefined();
  });

  it('JSON 中途截断 + finish_reason=length → 抛 ProviderOutputError（truncated 语义，带 cause+usage）', async () => {
    mockChatResponse({
      choices: [{ message: { content: '{"facts": ["pump' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 120, completion_tokens: 800 },
    });
    const err = await provider
      .generateStructured({ task: 't', prompt: 'p', schema: {} })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderOutputError);
    expect((err as Error).message).toMatch(/output truncated at max_tokens/);
    expect((err as Error).cause).toBeInstanceOf(SyntaxError); // 保留原始解析错
    expect((err as ProviderOutputError).usage).toEqual({ inputTokens: 120, outputTokens: 800 });
    expect(err).toMatchObject({
      provider: 'gateway',
      model: 'default-model',
      modelResolutionSource: 'requested_fallback',
    });
  });

  it('JSON 不合法但 finish_reason=stop → 抛 ProviderOutputError（非截断语义，保留 SyntaxError 为 cause，带 usage）', async () => {
    mockChatResponse({
      choices: [{ message: { content: 'not json' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    });
    const err = await provider
      .generateStructured({ task: 't', prompt: 'p', schema: {} })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderOutputError);
    expect((err as Error).message).not.toMatch(/truncated/); // 不误报截断
    expect((err as Error).cause).toBeInstanceOf(SyntaxError); // 原始解析错保留在 cause
    expect((err as ProviderOutputError).usage).toEqual({ inputTokens: 50, outputTokens: 10 });
  });

  it('🔴 markdown 围栏包裹的 JSON（真机实证：glm-5.2 偶发 ```json）→ 剥壳后正常解析', async () => {
    mockChatResponse({
      choices: [{ message: { content: '```json\n{"ok":true}\n```' }, finish_reason: 'stop' }],
      usage: {},
    });
    const r = await provider.generateStructured<{ ok: boolean }>({ task: 't', prompt: 'p', schema: {} });
    expect(r.data.ok).toBe(true);
  });
});

describe('OpenAICompatibleProvider — explicit native gateway transports', () => {
  it('GPT Responses reads nested output text before the inconsistent output_text helper', async () => {
    const responses = new OpenAICompatibleProvider({
      id: 'gateway',
      baseUrl: 'http://gw.test/v1',
      apiKey: 'k',
      model: 'gpt-5.6-terra',
      modelTransports: { 'gpt-5.6-terra': 'openai-responses' },
    });
    mockChatResponse({
      model: 'gpt-5.6-terra-2026-07-18',
      status: 'completed',
      output_text: '',
      output: [
        { type: 'reasoning', content: [] },
        { type: 'message', content: [{ type: 'output_text', text: '```json\n{"ok":true}\n```' }] },
      ],
      usage: { input_tokens: 101, output_tokens: 45 },
    });

    const result = await responses.generateStructured<{ ok: boolean }>({
      task: 't',
      prompt: 'p',
      schema: {},
      maxTokens: 456,
      reasoningEffort: 'low',
    });

    expect(result).toMatchObject({
      data: { ok: true },
      model: 'gpt-5.6-terra-2026-07-18',
      usage: { inputTokens: 101, outputTokens: 45 },
    });
    expect(lastRequestUrl()).toBe('http://gw.test/v1/responses');
    expect(lastRequestBody()).toMatchObject({
      model: 'gpt-5.6-terra',
      max_output_tokens: 456,
      text: { format: { type: 'json_object' } },
      reasoning: { effort: 'low' },
    });
    expect(lastRequestBody().input).toEqual([
      expect.objectContaining({ role: 'system' }),
      { role: 'user', content: 'p' },
    ]);
  });

  it('GPT Responses rejects incomplete structured output even when the partial text is valid JSON', async () => {
    const responses = new OpenAICompatibleProvider({
      id: 'gateway',
      baseUrl: 'http://gw.test/v1',
      apiKey: 'k',
      model: 'gpt-5.6-terra',
      modelTransports: { 'gpt-5.6-terra': 'openai-responses' },
    });
    mockChatResponse({
      model: 'gpt-5.6-terra',
      status: 'incomplete',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
      usage: { input_tokens: 101, output_tokens: 456 },
    });

    const error = await responses
      .generateStructured({ task: 't', prompt: 'p', schema: {}, maxTokens: 456 })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderOutputError);
    expect((error as Error).message).toContain('status=incomplete');
    expect((error as ProviderOutputError).usage).toEqual({ inputTokens: 101, outputTokens: 456 });
    expect(error).toMatchObject({
      provider: 'gateway',
      model: 'gpt-5.6-terra',
      reportedModel: 'gpt-5.6-terra',
      modelResolutionSource: 'upstream_response',
    });
  });

  it('Claude Messages sends native headers, separates system text, and excludes thinking from output', async () => {
    const messages = new OpenAICompatibleProvider({
      id: 'gateway',
      baseUrl: 'http://gw.test/v1',
      apiKey: 'k',
      model: 'claude-sonnet-5',
      modelTransports: { 'claude-sonnet-5': 'anthropic-messages' },
    });
    mockChatResponse({
      model: 'claude-sonnet-5-2026-07-18',
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'private reasoning must not enter the artifact' },
        { type: 'text', text: '```json\n{"ok":true}\n```' },
      ],
      usage: { input_tokens: 99, output_tokens: 55 },
    });

    const result = await messages.generateStructured<{ ok: boolean }>({ task: 't', prompt: 'p', schema: {}, maxTokens: 456 });

    expect(result).toMatchObject({
      data: { ok: true },
      model: 'claude-sonnet-5-2026-07-18',
      usage: { inputTokens: 99, outputTokens: 55 },
    });
    expect(lastRequestUrl()).toBe('http://gw.test/v1/messages');
    expect(lastRequestHeaders()).toEqual({
      'Content-Type': 'application/json',
      'x-api-key': 'k',
      'anthropic-version': '2023-06-01',
    });
    expect(lastRequestBody()).toMatchObject({
      model: 'claude-sonnet-5',
      max_tokens: 456,
      messages: [{ role: 'user', content: 'p' }],
    });
    expect(lastRequestBody().system).toContain('只返回符合以下 JSON Schema');
  });

  it.each(['max_tokens', 'model_context_window_exceeded'])(
    'Claude Messages rejects %s output even when the partial text is valid JSON',
    async (stopReason) => {
      const messages = new OpenAICompatibleProvider({
        id: 'gateway',
        baseUrl: 'http://gw.test/v1',
        apiKey: 'k',
        model: 'claude-sonnet-5',
        modelTransports: { 'claude-sonnet-5': 'anthropic-messages' },
      });
      mockChatResponse({
        model: 'claude-sonnet-5',
        stop_reason: stopReason,
        content: [{ type: 'text', text: '{"ok":true}' }],
        usage: { input_tokens: 99, output_tokens: 456 },
      });

      const error = await messages
        .generateStructured({ task: 't', prompt: 'p', schema: {}, maxTokens: 456 })
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ProviderOutputError);
      expect((error as Error).message).toContain(`stop_reason=${stopReason}`);
      expect((error as ProviderOutputError).usage).toEqual({ inputTokens: 99, outputTokens: 456 });
      expect(error).toMatchObject({
        provider: 'gateway',
        model: 'claude-sonnet-5',
        reportedModel: 'claude-sonnet-5',
        modelResolutionSource: 'upstream_response',
      });
    },
  );

  it('Claude Messages fails before fetch when the required max token limit is absent', async () => {
    const messages = new OpenAICompatibleProvider({
      id: 'gateway',
      baseUrl: 'http://gw.test/v1',
      apiKey: 'k',
      model: 'claude-sonnet-5',
      modelTransports: { 'claude-sonnet-5': 'anthropic-messages' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(messages.generateText({ task: 't', prompt: 'p' })).rejects.toThrow(
      'maxTokens is required for anthropic-messages transport',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('OpenAICompatibleProvider — bounded vision review', () => {
  const visionProvider = () =>
    new OpenAICompatibleProvider({
      id: 'gateway',
      baseUrl: 'http://gw.test/v1',
      apiKey: 'k',
      model: 'default-model',
      visionModelTransports: {
        'gemini-3.5-flash': 'openai-chat-completions',
      },
      visionEvalFixtureDigests: Object.fromEntries(
        visionInput().images.map((image) => [
          image.artifactId,
          image.sha256,
        ]),
      ),
    });

  it('sends at most three controlled PNGs as local data payloads and proves exact model provenance', async () => {
    mockChatResponse({
      model: 'gemini-3.5-flash',
      choices: [
        { message: { content: '{"ok":true}' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    });
    const result = await visionProvider().reviewVision<{ ok: boolean }>(
      visionInput(),
    );

    expect(lastRequestUrl()).toBe('http://gw.test/v1/chat/completions');
    const body = lastRequestBody();
    expect(body).toMatchObject({
      model: 'gemini-3.5-flash',
      max_tokens: 1000,
      temperature: 0,
      response_format: { type: 'json_object' },
    });
    const messages = body.messages as Array<{
      role: string;
      content:
        | string
        | Array<{ type: string; image_url?: { url: string } }>;
    }>;
    const userContent = messages.find(
      (message) => message.role === 'user',
    )!.content as Array<{ type: string; image_url?: { url: string } }>;
    const imageUrls = userContent
      .filter((item) => item.type === 'image_url')
      .map((item) => item.image_url!.url);
    expect(imageUrls).toHaveLength(3);
    expect(
      imageUrls.every((url) => url.startsWith('data:image/png;base64,')),
    ).toBe(true);
    expect(imageUrls.some((url) => /^https?:/i.test(url))).toBe(false);
    expect(result).toMatchObject({
      data: { ok: true },
      provider: 'gateway',
      model: 'gemini-3.5-flash',
      reportedModel: 'gemini-3.5-flash',
      modelResolutionSource: 'upstream_response',
    });
  });

  it('rejects URL/path shaped inputs before any provider call', async () => {
    const input = visionInput();
    input.images[0] = {
      ...input.images[0]!,
      url: 'https://attacker.example/image.png',
    } as never;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(visionProvider().reviewVision(input)).rejects.toThrow(
      'VISION_REVIEW_REMOTE_OR_PATH_INPUT_FORBIDDEN',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps eval fixtures out of the future runtime task', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      visionProvider().reviewVision({
        ...visionInput(),
        task: 'site_builder.aesthetic_review',
      }),
    ).rejects.toThrow('VISION_REVIEW_IMAGE_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires every eval fixture ID and digest to exist in the immutable provider catalog', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const providerWithoutCatalog = new OpenAICompatibleProvider({
      id: 'gateway',
      baseUrl: 'http://gw.test/v1',
      apiKey: 'k',
      model: 'default-model',
      visionModelTransports: {
        'gemini-3.5-flash': 'openai-chat-completions',
      },
    });
    await expect(
      providerWithoutCatalog.reviewVision(visionInput()),
    ).rejects.toThrow('VISION_REVIEW_EVAL_FIXTURE_UNAUTHORIZED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unregistered model transports before any provider call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      visionProvider().reviewVision({
        ...visionInput(),
        model: 'unproven-vision-model',
      }),
    ).rejects.toThrow('VISION_REVIEW_MODEL_TRANSPORT_UNPROVEN');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when the upstream omits or changes the reported model', async () => {
    mockChatResponse({
      model: 'provider-fallback-model',
      choices: [
        { message: { content: '{"ok":true}' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    });
    await expect(
      visionProvider().reviewVision(visionInput()),
    ).rejects.toBeInstanceOf(ProviderIdentityError);
  });

  it('rejects every non-stop finish reason even when the body contains valid JSON', async () => {
    mockChatResponse({
      model: 'gemini-3.5-flash',
      choices: [
        {
          message: { content: '{"ok":true}' },
          finish_reason: 'content_filter',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    });
    await expect(
      visionProvider().reviewVision(visionInput()),
    ).rejects.toThrow('VISION_REVIEW_FINISH_REASON_INVALID');
  });

  it('preserves HTTP status for capability-probe unavailable mapping', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 429,
        text: async () => 'rate limited',
      })),
    );
    const error = await visionProvider()
      .reviewVision(visionInput())
      .then(() => null)
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({
      status: 429,
      provider: 'gateway',
      model: 'gemini-3.5-flash',
    });
  });
});

describe('stripJsonFence', () => {
  it('剥 ```json 围栏', () => {
    expect(stripJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('剥无语言标签的 ``` 围栏', () => {
    expect(stripJsonFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('无围栏原样返回（trim）', () => {
    expect(stripJsonFence('  {"a":1}  ')).toBe('{"a":1}');
  });
});
