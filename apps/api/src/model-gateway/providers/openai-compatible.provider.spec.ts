import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from './openai-compatible.provider';

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

afterEach(() => vi.unstubAllGlobals());

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
  it('content 为空 + finish_reason=length → 抛可诊断错误（含 finish_reason 与模型名）', async () => {
    mockChatResponse({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { completion_tokens: 2000 },
    });
    await expect(
      provider.generateStructured({ task: 't', prompt: 'p', schema: {}, model: 'deepseek-v4-pro' }),
    ).rejects.toThrow(/empty content.*finish_reason=length/s);
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

  it('JSON 中途截断 + finish_reason=length → 显式 truncated 错误（真机实证：v4-pro Unterminated string）', async () => {
    mockChatResponse({
      choices: [{ message: { content: '{"facts": ["pump' }, finish_reason: 'length' }],
      usage: {},
    });
    await expect(
      provider.generateStructured({ task: 't', prompt: 'p', schema: {} }),
    ).rejects.toThrow(/output truncated at max_tokens/);
  });

  it('JSON 不合法但 finish_reason=stop → 保留原始 SyntaxError（不误报截断）', async () => {
    mockChatResponse({
      choices: [{ message: { content: 'not json' }, finish_reason: 'stop' }],
      usage: {},
    });
    await expect(
      provider.generateStructured({ task: 't', prompt: 'p', schema: {} }),
    ).rejects.toThrow(SyntaxError);
  });
});
