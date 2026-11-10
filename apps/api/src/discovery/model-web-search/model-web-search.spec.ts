import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '../../model-gateway/types';
import {
  MODEL_WEB_SEARCH_MAX_ROUNDS,
  MODEL_WEB_SEARCH_MAX_ROUNDS_CAPPED,
  MODEL_WEB_SEARCH_MAX_ROUNDS_MAX,
  MODEL_WEB_SEARCH_MAX_TOOL_CALLS,
  MODEL_WEB_SEARCH_MAX_TOOL_CALLS_CAPPED,
  MODEL_WEB_SEARCH_MAX_TOOL_CALLS_MAX,
  MODEL_WEB_SEARCH_TASK_ID,
  ModelWebSearchError,
  UNCAPPED_MODEL_WEB_SEARCH_MAX_ROUNDS,
  UNCAPPED_MODEL_WEB_SEARCH_MAX_TOOL_CALLS,
  buildModelWebSearchMessages,
  parseModelWebSearchAnswer,
  resolveModelWebSearchLoopLimits,
  runModelWebSearch,
  type ModelWebSearchTurn,
} from './model-web-search';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const ANSWER = JSON.stringify({
  candidates: [
    {
      companyName: 'Solar Import GmbH',
      domain: 'solar-import.example.de',
      countryCode: 'DE',
      evidenceUrls: ['https://solar-import.example.de/about'],
      query: 'HJT solar importer Germany',
    },
    {
      companyName: 'Epv Distribution',
      domain: 'https://www.epv.example/de/about',
      countryCode: 'de',
      evidenceUrls: ['https://www.epv.example/de/about'],
    },
  ],
});

function turn(partial: Partial<ModelWebSearchTurn>): ModelWebSearchTurn {
  return { text: '', toolUses: [], stopReason: 'end', ...partial };
}

describe('model-web-search（获客通路 A 骨架）', () => {
  it('任务常量与消息：画像、市场与语言进入 prompt，工具只有一个 web_search', () => {
    expect(MODEL_WEB_SEARCH_TASK_ID).toBe('discovery.web_search_candidates');
    const messages = buildModelWebSearchMessages({
      icp: '德国泵类进口商',
      market: 'DE',
      language: 'de',
      maxCandidates: 5,
    });
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('web_search');
    expect(messages[0]?.content).toContain('最多输出 5 家');
    expect(messages[1]).toEqual({
      role: 'user',
      content: '德国泵类进口商\n目标市场：DE。检索语言：de。',
    });
  });

  it('工具环：先 web_search 后给出答案；证据缺失、重复域名与大小写域名的处理', async () => {
    const seenMessages: ChatMessage[][] = [];
    const queries: string[] = [];
    const turns: ModelWebSearchTurn[] = [
      turn({
        stopReason: 'tool_use',
        text: 'searching',
        toolUses: [
          { id: 't1', name: 'web_search', input: { query: 'HJT solar importer Germany' } },
        ],
      }),
      turn({ text: ANSWER }),
    ];
    const result = await runModelWebSearch(
      {
        generateChat: async (input) => {
          seenMessages.push([...input.messages]);
          return turns.shift()!;
        },
        search: async (q) => {
          queries.push(q);
          return [{ url: 'https://solar-import.example.de/about', title: 'About' }];
        },
      },
      { icp: 'HJT 光伏采购商', market: 'DE' },
    );
    expect(queries).toEqual(['HJT solar importer Germany']);
    // 第二轮上下文里带回了工具结果
    expect(seenMessages[1]?.some((m) => m.role === 'tool')).toBe(true);
    // https:// 前缀与路径被规整为域名
    expect(result.candidates.map((c) => c.domain)).toEqual([
      'solar-import.example.de',
      'www.epv.example',
    ]);
    // 非法 countryCode 被置 null
    expect(result.candidates[1]?.countryCode).toBeNull();
    expect(result.rounds).toBe(2);
    expect(result.toolCalls).toBe(1);
  });

  it('支持 ```json 围栏输出', () => {
    expect(parseModelWebSearchAnswer('```json\n' + ANSWER + '\n```')).toHaveLength(2);
  });

  it('fail-closed：非 JSON、空候选、缺证据、非法域名、越权工具、轮数/调用超限、max_tokens', async () => {
    const base = {
      search: async () => [{ url: 'https://a.example/' }],
    };
    await expect(
      runModelWebSearch(
        { ...base, generateChat: async () => turn({ text: 'not json' }) },
        { icp: 'x' },
      ),
    ).rejects.toMatchObject({ code: 'MODEL_WEB_SEARCH_ANSWER_NOT_JSON' });

    await expect(
      runModelWebSearch(
        {
          ...base,
          generateChat: async () => turn({ text: '{"candidates":[]}' }),
        },
        { icp: 'x' },
      ),
    ).rejects.toBeInstanceOf(ModelWebSearchError);

    expect(() =>
      parseModelWebSearchAnswer(
        '{"candidates":[{"companyName":"A","domain":"a.example","evidenceUrls":[]}]}',
      ),
    ).toThrow(/证据/);

    expect(() =>
      parseModelWebSearchAnswer(
        '{"candidates":[{"companyName":"A","domain":"not a domain","evidenceUrls":["https://a.example"]}]}',
      ),
    ).toThrow(/域名/);

    await expect(
      runModelWebSearch(
        {
          ...base,
          generateChat: async () =>
            turn({
              stopReason: 'tool_use',
              toolUses: [{ id: 't1', name: 'web_fetch', input: { url: 'https://a' } }],
            }),
        },
        { icp: 'x' },
      ),
    ).rejects.toMatchObject({ code: 'MODEL_WEB_SEARCH_UNKNOWN_TOOL' });

    await expect(
      runModelWebSearch(
        {
          ...base,
          maxRounds: 1,
          generateChat: async () =>
            turn({
              stopReason: 'tool_use',
              toolUses: [{ id: 't1', name: 'web_search', input: { query: 'aa' } }],
            }),
        },
        { icp: 'x' },
      ),
    ).rejects.toMatchObject({ code: 'MODEL_WEB_SEARCH_ROUND_BUDGET_EXCEEDED' });

    let calls = 0;
    await expect(
      runModelWebSearch(
        {
          ...base,
          maxRounds: 2,
          maxToolCalls: 1,
          generateChat: async () => {
            calls += 1;
            return turn({
              stopReason: 'tool_use',
              toolUses: [
                { id: `t${calls}a`, name: 'web_search', input: { query: 'one two' } },
                { id: `t${calls}b`, name: 'web_search', input: { query: 'three four' } },
              ],
            });
          },
        },
        { icp: 'x' },
      ),
    ).rejects.toMatchObject({ code: 'MODEL_WEB_SEARCH_TOOL_BUDGET_EXCEEDED' });

    await expect(
      runModelWebSearch(
        { ...base, generateChat: async () => turn({ stopReason: 'max_tokens' }) },
        { icp: 'x' },
      ),
    ).rejects.toMatchObject({ code: 'MODEL_WEB_SEARCH_MAX_TOKENS' });

    await expect(
      runModelWebSearch(
        {
          ...base,
          generateChat: async () =>
            turn({
              stopReason: 'tool_use',
              toolUses: [{ id: 't1', name: 'web_search', input: { query: 'x' } }],
            }),
        },
        { icp: 'x' },
      ),
    ).rejects.toMatchObject({ code: 'MODEL_WEB_SEARCH_TOOL_INPUT_INVALID' });
  });
});

describe('工具环上限 —— 产品帽 vs 防爆安全界', () => {
  it('off：产品帽 6 轮 / 10 次调用，忽略 env 覆盖（行为与今天一致）', () => {
    expect(MODEL_WEB_SEARCH_MAX_ROUNDS).toBe(MODEL_WEB_SEARCH_MAX_ROUNDS_CAPPED);
    expect(MODEL_WEB_SEARCH_MAX_TOOL_CALLS).toBe(MODEL_WEB_SEARCH_MAX_TOOL_CALLS_CAPPED);
    expect(
      resolveModelWebSearchLoopLimits({
        DISCOVERY_MODEL_WEB_SEARCH_MAX_ROUNDS: '50',
        DISCOVERY_MODEL_WEB_SEARCH_MAX_TOOL_CALLS: '500',
      } as NodeJS.ProcessEnv),
    ).toEqual({ rounds: 6, toolCalls: 10 });
  });

  it('on：默认防爆界 24 轮 / 100 次；env 可调，畸形/越界回退默认', () => {
    const limits = (overrides: Record<string, string> = {}) =>
      resolveModelWebSearchLoopLimits({
        DISCOVERY_UNCAPPED: 'on',
        ...overrides,
      } as NodeJS.ProcessEnv);

    expect(limits()).toEqual({
      rounds: UNCAPPED_MODEL_WEB_SEARCH_MAX_ROUNDS,
      toolCalls: UNCAPPED_MODEL_WEB_SEARCH_MAX_TOOL_CALLS,
    });
    expect(
      limits({
        DISCOVERY_MODEL_WEB_SEARCH_MAX_ROUNDS: '12',
        DISCOVERY_MODEL_WEB_SEARCH_MAX_TOOL_CALLS: '40',
      }),
    ).toEqual({ rounds: 12, toolCalls: 40 });
    expect(
      limits({ DISCOVERY_MODEL_WEB_SEARCH_MAX_ROUNDS: `${MODEL_WEB_SEARCH_MAX_ROUNDS_MAX}` }),
    ).toMatchObject({ rounds: MODEL_WEB_SEARCH_MAX_ROUNDS_MAX });
    for (const raw of ['0', '-1', '1e3', 'x', '', `${MODEL_WEB_SEARCH_MAX_ROUNDS_MAX + 1}`]) {
      expect(limits({ DISCOVERY_MODEL_WEB_SEARCH_MAX_ROUNDS: raw }).rounds).toBe(
        UNCAPPED_MODEL_WEB_SEARCH_MAX_ROUNDS,
      );
    }
    expect(
      limits({ DISCOVERY_MODEL_WEB_SEARCH_MAX_TOOL_CALLS: `${MODEL_WEB_SEARCH_MAX_TOOL_CALLS_MAX + 1}` })
        .toolCalls,
    ).toBe(UNCAPPED_MODEL_WEB_SEARCH_MAX_TOOL_CALLS);
  });

  it('进程 env DISCOVERY_UNCAPPED=on：模块常量切到防爆界', async () => {
    vi.resetModules();
    vi.stubEnv('DISCOVERY_UNCAPPED', 'on');
    const mod = await import('./model-web-search');
    expect(mod.MODEL_WEB_SEARCH_MAX_ROUNDS).toBe(UNCAPPED_MODEL_WEB_SEARCH_MAX_ROUNDS);
    expect(mod.MODEL_WEB_SEARCH_MAX_TOOL_CALLS).toBe(UNCAPPED_MODEL_WEB_SEARCH_MAX_TOOL_CALLS);
  });
});
