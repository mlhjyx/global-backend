import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../adapters/robots', () => ({ isAllowedByRobots: vi.fn(async () => true) }));

// 抽取层（LLM）只在这组单测里被间接调用（首页兜底用例）；用一个按页面文本回人的桩，
// 避免真模型调用。
vi.mock('../../model-runtime/structured-task-runtime-bridge', () => ({
  executeStructuredTaskWithRuntime: vi.fn(
    async (_gateway: unknown, input: { prompt?: string }) => ({
      data: {
        people: (input?.prompt ?? '').includes('HOMEPAGE-TEAM-BLOCK')
          ? [
              { full_name: 'Home Person', title: 'Geschäftsführer', is_target_role: false },
              // 机构名冒充人名：cleanPersonName 应丢弃（只留上面那一个）。
              { full_name: 'Acme Solutions GmbH' },
            ]
          : (input?.prompt ?? '').includes('PAGE-PEOPLE')
            ? [{ full_name: 'Page Person', title: 'Vertrieb', is_target_role: false }]
            : [],
      },
    }),
  ),
}));

import { isAllowedByRobots } from '../../adapters/robots';
import {
  DecisionMakerProvider,
  extractAnchorsFromHtml,
  sameRegistrableHost,
  scorePeoplePageUrl,
} from './decision-maker.provider';
import type { ExecutionBroker } from '../../tools/tool-contract';

const robotsMock = vi.mocked(isAllowedByRobots);

beforeEach(() => {
  robotsMock.mockReset();
  robotsMock.mockResolvedValue(true);
});

describe('决策人页优先级打分（Impressum 优先）', () => {
  it('Impressum/法律声明最高（德国依法列 Geschäftsführer）', () => {
    expect(scorePeoplePageUrl('https://x.de/impressum')).toBe(100);
    expect(scorePeoplePageUrl('https://x.com/en/imprint')).toBe(100);
    expect(scorePeoplePageUrl('https://x.fr/mentions-legales')).toBe(100);
  });

  it('管理层 > 团队 > 关于 > 联系', () => {
    const mgmt = scorePeoplePageUrl('https://x.de/geschaeftsfuehrung');
    const team = scorePeoplePageUrl('https://x.de/team');
    const about = scorePeoplePageUrl('https://x.de/ueber-uns');
    const contact = scorePeoplePageUrl('https://x.de/kontakt');
    expect(mgmt).toBeGreaterThan(team);
    expect(team).toBeGreaterThan(about);
    expect(about).toBeGreaterThan(contact);
    expect(contact).toBeGreaterThan(0);
  });

  it('英文管理层页也命中', () => {
    expect(scorePeoplePageUrl('https://x.com/company/leadership')).toBeGreaterThanOrEqual(95);
    expect(scorePeoplePageUrl('https://x.com/management-team')).toBeGreaterThanOrEqual(95);
  });

  it('非人物页得 0（不误抓产品/新闻页）', () => {
    expect(scorePeoplePageUrl('https://x.de/produkte/laser')).toBe(0);
    expect(scorePeoplePageUrl('https://x.de/news/2026')).toBe(0);
  });
});

describe('raw-HTML anchor fallback（M5：markdown 丢链接时补抽人物页）', () => {
  it('handles unquoted hrefs and hostile unterminated markup in linear time', () => {
    expect(extractAnchorsFromHtml('<a href=team>Team</a>', 'https://acme.de/')).toEqual([
      'https://acme.de/team',
    ]);
    // 3MB 的未闭合 `<a ` 串：回溯正则会二次方卡死；线性扫描必须是秒级完成。
    const hostile = '<a '.repeat(300_000);
    const started = Date.now();
    expect(extractAnchorsFromHtml(hostile, 'https://acme.de/')).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('only follows a redirected host inside the same registrable domain', () => {
    expect(sameRegistrableHost('www.acme.de', 'acme.de')).toBe(true);
    expect(sameRegistrableHost('shop.acme.de', 'www.acme.de')).toBe(true);
    expect(sameRegistrableHost('parked.example', 'acme.de')).toBe(false);
  });

  it('extracts same-site anchors from raw HTML with relative links and www tolerance', () => {
    const html = `
      <a href="common/info/impressum.html">Impressum</a>
      <a href="https://www.acme.de/team/">Team</a>
      <a href="mailto:x@acme.de">mail</a>
      <a href="javascript:void(0)">js</a>
      <a href="https://other.example/impressum">ext</a>
      <a href="/impressum#top">dup</a>`;
    expect(extractAnchorsFromHtml(html, 'https://acme.de/')).toEqual([
      'https://acme.de/common/info/impressum.html',
      // 尾斜杠是站点给出的形态，必须原样保留（部分站点两种形态返回不同内容）。
      'https://www.acme.de/team/',
      'https://acme.de/impressum',
    ]);
  });

  it('keeps the trailing-slash form and dedupes its slash-less twin', () => {
    // M5：michalowski-gmbh.de 对无尾斜杠形态回 39 字节反爬空壳，crawl4ai 直接 500；
    // 归一化去斜杠会把好链接换成坏链接。
    const html =
      '<a href="https://acme.de/impressum/">Impressum</a>' +
      '<a href="https://acme.de/impressum">dup</a>' +
      '<a href="/team/">Team</a><a href="/team">dup</a>' +
      // 反过来（无斜杠先出现）也要留下可抓的带斜杠形态。
      '<a href="/kontakt">Kontakt</a><a href="/kontakt/">dup</a>';
    expect(extractAnchorsFromHtml(html, 'https://acme.de/')).toEqual([
      'https://acme.de/impressum/',
      'https://acme.de/team/',
      'https://acme.de/kontakt/',
    ]);
  });

  it('uses the redirected host and prefetches people pages when markdown carries none', async () => {
    const calls: Array<{ tool: string; url?: string }> = [];
    const broker = {
      invoke: vi.fn(async (tool: string, input: { url?: string }) => {
        calls.push({ tool, url: input.url });
        if (tool === 'crawl4ai.fetch' && input.url === 'https://acme.de/') {
          return { data: { url: input.url, text: 'H'.repeat(200) } };
        }
        if (tool === 'http.get') {
          return {
            data: {
              status: 200,
              ok: true,
              mediaType: 'text/plain',
              finalUrl: 'https://www.acme.de/',
              // 非标准路径的 Impressum：不在 FIXED_PATHS 里，只有锚点补抽能找到。
              text: '<a href="/team">Team</a><a href="common/info/impressum.html">Impressum</a>',
            },
          };
        }
        return { data: { url: input.url, text: '' } };
      }),
    } as unknown as ExecutionBroker;
    const provider = new DecisionMakerProvider({ gateway: {} as never, broker });

    await provider.findDecisionMakers(
      { domain: 'acme.de', name: 'Acme' },
      {
        workspaceId: 'w',
        runId: 'r',
        artifactSubject: { subjectType: 'company', subjectId: 'c1' },
      } as never,
    );

    const crawlUrls = calls.filter((call) => call.tool === 'crawl4ai.fetch').map((call) => call.url);
    expect(calls.some((call) => call.tool === 'http.get' && call.url === 'https://acme.de/')).toBe(true);
    // 只有锚点补抽能找到的非标准路径，且排在固定路径之前。
    expect(crawlUrls).toContain('https://www.acme.de/common/info/impressum.html');
    expect(crawlUrls[1]).toBe('https://www.acme.de/common/info/impressum.html');
    expect(crawlUrls).toContain('https://www.acme.de/team');
  });

  it('markdown 已有 3 条人物页链接时仍用原始 HTML 补抽（M5 ava-berlin.de）', async () => {
    // 旧门槛「不足 3 条才补」会让恰好 3 条的非 Impressum 链接挡住真实 Impressum
    // （只在原始 HTML 里，如 common/info/impressum.html）。
    const calls: Array<{ tool: string; url?: string }> = [];
    const markdown =
      '[Über uns](https://acme.de/ueber-uns) [Hier finden Sie uns](https://acme.de/ueber-uns/hier-finden-sie-uns) ' +
      '[Kontakt](https://acme.de/common/info/kontakt.html)';
    const broker = {
      invoke: vi.fn(async (tool: string, input: { url?: string }) => {
        calls.push({ tool, url: input.url });
        if (tool === 'crawl4ai.fetch' && input.url === 'https://acme.de/') {
          return { data: { url: input.url, text: markdown } };
        }
        if (tool === 'http.get') {
          return {
            data: {
              status: 200,
              ok: true,
              mediaType: 'text/plain',
              finalUrl: 'https://acme.de/',
              text: '<a href="common/info/impressum.html">Impressum</a>',
            },
          };
        }
        return { data: { url: input.url, text: '' } };
      }),
    } as unknown as ExecutionBroker;
    const provider = new DecisionMakerProvider({ gateway: {} as never, broker });

    await provider.findDecisionMakers(
      { domain: 'acme.de', name: 'Acme' },
      {
        workspaceId: 'w',
        runId: 'r',
        artifactSubject: { subjectType: 'company', subjectId: 'c1' },
      } as never,
    );

    expect(calls.some((call) => call.tool === 'http.get' && call.url === 'https://acme.de/')).toBe(true);
    const crawlUrls = calls.filter((call) => call.tool === 'crawl4ai.fetch').map((call) => call.url);
    expect(crawlUrls).toContain('https://acme.de/common/info/impressum.html');
  });
});

describe('robots 判定（M5：裸域 robots.txt 坏跳转）', () => {
  it('裸域 robots 被坏跳转误伤时改从 www origin 抓取', async () => {
    // avag-pumpen.de 的 Apache 把 robots.txt 301 到 https://www.avag-pumpen.derobots.txt
    // （少斜杠），SSRF 护栏拒绝解析 → 旧逻辑当作全站禁抓；www origin 的 robots 放行。
    robotsMock.mockImplementation(async (url: string) => !url.startsWith('https://acme.de/'));
    const calls: Array<{ tool: string; url?: string }> = [];
    const broker = {
      invoke: vi.fn(async (tool: string, input: { url?: string }) => {
        calls.push({ tool, url: input.url });
        if (tool === 'crawl4ai.fetch') {
          return { data: { url: input.url, text: 'short page' } };
        }
        if (tool === 'http.get') {
          return {
            data: {
              status: 200,
              ok: true,
              mediaType: 'text/plain',
              finalUrl: 'https://www.acme.de/',
              text: '<a href="/team">Team</a>',
            },
          };
        }
        return { data: { url: input.url, text: '' } };
      }),
    } as unknown as ExecutionBroker;
    const provider = new DecisionMakerProvider({ gateway: {} as never, broker });

    await provider.findDecisionMakers(
      { domain: 'acme.de', name: 'Acme' },
      {
        workspaceId: 'w',
        runId: 'r',
        artifactSubject: { subjectType: 'company', subjectId: 'c1' },
      } as never,
    );

    expect(robotsMock).toHaveBeenCalledWith('https://acme.de/', expect.anything());
    expect(robotsMock).toHaveBeenCalledWith('https://www.acme.de/', expect.anything());
    // 首页抓取改从 robots 放行的 www origin 开始。
    const firstCrawl = calls.find((call) => call.tool === 'crawl4ai.fetch');
    expect(firstCrawl?.url).toBe('https://www.acme.de/');
  });

  it('存储域名自带 www 时对称回退到裸域', async () => {
    robotsMock.mockImplementation(async (url: string) => !url.startsWith('https://www.acme.de/'));
    const calls: Array<{ tool: string; url?: string }> = [];
    const broker = {
      invoke: vi.fn(async (tool: string, input: { url?: string }) => {
        calls.push({ tool, url: input.url });
        if (tool === 'crawl4ai.fetch') {
          return { data: { url: input.url, text: 'short page' } };
        }
        if (tool === 'http.get') {
          return {
            data: {
              status: 200,
              ok: true,
              mediaType: 'text/plain',
              finalUrl: 'https://acme.de/',
              text: '<a href="/team">Team</a>',
            },
          };
        }
        return { data: { url: input.url, text: '' } };
      }),
    } as unknown as ExecutionBroker;
    const provider = new DecisionMakerProvider({ gateway: {} as never, broker });

    await provider.findDecisionMakers(
      { domain: 'www.acme.de', name: 'Acme' },
      {
        workspaceId: 'w',
        runId: 'r',
        artifactSubject: { subjectType: 'company', subjectId: 'c1' },
      } as never,
    );

    expect(robotsMock).toHaveBeenCalledWith('https://www.acme.de/', expect.anything());
    expect(robotsMock).toHaveBeenCalledWith('https://acme.de/', expect.anything());
    const firstCrawl = calls.find((call) => call.tool === 'crawl4ai.fetch');
    expect(firstCrawl?.url).toBe('https://acme.de/');
  });

  it('两个 origin 都被 robots 拒绝时才放弃', async () => {
    robotsMock.mockResolvedValue(false);
    const broker = { invoke: vi.fn() } as unknown as ExecutionBroker;
    const provider = new DecisionMakerProvider({ gateway: {} as never, broker });

    const people = await provider.findDecisionMakers(
      { domain: 'acme.de', name: 'Acme' },
      { workspaceId: 'w', runId: 'r' } as never,
    );

    expect(people).toEqual([]);
    expect((broker.invoke as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

describe('首页兜底抽取（M5：团队只出现在首页的小站）', () => {
  it('选定人物页抽不到人时抽取首页自身，并过滤机构名', async () => {
    // jaeckel-ohg.de 的 geschäftsführende Gesellschafter 只在首页团队区块出现，
    // Impressum 页没有具名人；选定页全空时首页文本应作为最后的抽取目标。
    const homeMarkdown = `HOMEPAGE-TEAM-BLOCK Unser Team: ${'细节 '.repeat(60)}`;
    const broker = {
      invoke: vi.fn(async (tool: string, input: { url?: string }) => {
        if (tool === 'crawl4ai.fetch' && input.url === 'https://acme.de/') {
          return { data: { url: input.url, text: homeMarkdown } };
        }
        if (tool === 'crawl4ai.fetch') {
          // 选定的人物页抓取为空（无具名人 / 反爬空壳）。
          return { data: { url: input.url, text: '' } };
        }
        if (tool === 'http.get') {
          return {
            data: {
              status: 200,
              ok: true,
              mediaType: 'text/plain',
              finalUrl: 'https://acme.de/',
              text: '<a href="/team">Team</a>',
            },
          };
        }
        return { data: { url: input.url, text: '' } };
      }),
    } as unknown as ExecutionBroker;
    const provider = new DecisionMakerProvider({ gateway: {} as never, broker });

    const people = await provider.findDecisionMakers(
      { domain: 'acme.de', name: 'Acme' },
      {
        workspaceId: 'w',
        runId: 'r',
        artifactSubject: { subjectType: 'company', subjectId: 'c1' },
      } as never,
    );

    expect(people).toHaveLength(1);
    expect(people[0]!.fullName).toBe('Home Person');
    expect(people[0]!.sourcePage).toBe('https://acme.de/');
  });

  it('选定页已有人时不额外抽取首页（控制成本）', async () => {
    const homeMarkdown = `HOMEPAGE-TEAM-BLOCK Unser Team: ${'细节 '.repeat(60)}`;
    const broker = {
      invoke: vi.fn(async (tool: string, input: { url?: string }) => {
        if (tool === 'crawl4ai.fetch' && input.url === 'https://acme.de/') {
          return { data: { url: input.url, text: homeMarkdown } };
        }
        if (tool === 'crawl4ai.fetch') {
          return {
            data: { url: input.url, text: `PAGE-PEOPLE 员工页文本 ${'细节 '.repeat(40)}` },
          };
        }
        if (tool === 'http.get') {
          return {
            data: {
              status: 200,
              ok: true,
              mediaType: 'text/plain',
              finalUrl: 'https://acme.de/',
              text: '<a href="/team">Team</a>',
            },
          };
        }
        return { data: { url: input.url, text: '' } };
      }),
    } as unknown as ExecutionBroker;
    const provider = new DecisionMakerProvider({ gateway: {} as never, broker });

    const people = await provider.findDecisionMakers(
      { domain: 'acme.de', name: 'Acme' },
      {
        workspaceId: 'w',
        runId: 'r',
        artifactSubject: { subjectType: 'company', subjectId: 'c1' },
      } as never,
    );

    // 页面已抽到人 → 首页兜底不触发：结果里只有页面来源的人，没有 Home Person。
    expect(people).toHaveLength(1);
    expect(people[0]!.fullName).toBe('Page Person');
    expect(people[0]!.sourcePage).toBe('https://acme.de/team');
  });
});

describe('DecisionMakerProvider execution envelope', () => {
  it('projects at most 25 contacts from an untrusted aggregate result', () => {
    const people = Array.from({ length: 26 }, (_, index) => ({
      fullName: `Person ${index}`,
      personalData: true,
      sourcePage: `https://acme.example/people/${index}`,
    }));

    expect(DecisionMakerProvider.toContactRecords(people)).toHaveLength(25);
  });
});
