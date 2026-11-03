import { describe, expect, it, vi } from 'vitest';

vi.mock('../../adapters/robots', () => ({ isAllowedByRobots: vi.fn(async () => true) }));

import {
  DecisionMakerProvider,
  extractAnchorsFromHtml,
  sameRegistrableHost,
  scorePeoplePageUrl,
} from './decision-maker.provider';
import type { ExecutionBroker } from '../../tools/tool-contract';

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
      'https://www.acme.de/team',
      'https://acme.de/impressum',
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
