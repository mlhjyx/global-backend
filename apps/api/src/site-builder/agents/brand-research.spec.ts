import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import { researchBrand } from './brand-research';

/**
 * 品牌 web 研究（09 §2.4 / C1-C4）：一切出网经 ToolBroker（searxng.search + crawl4ai.fetch），
 * robots/限流/预算由工具层与 Broker 复用，本模块不做任何裸出网；R1-safety 的完整
 * SSRF egress gate 已由 adapter/Crawl4AI 层实现，本单测只验证本模块不绕过它。
 * fail-safe：任一步失败 → degraded=true，返回已有内容，绝不阻断 brandProfile。
 */

type InvokeImpl = (toolId: string, input: unknown, ctx: ToolContext) => Promise<{ data: unknown }>;

function brokerWith(impl: InvokeImpl): { broker: ExecutionBroker; invocations: { toolId: string; input: unknown; ctx: ToolContext }[] } {
  const invocations: { toolId: string; input: unknown; ctx: ToolContext }[] = [];
  const broker = {
    checkSourcePolicy: vi.fn(),
    invoke: vi.fn(async (toolId: string, input: unknown, ctx: ToolContext) => {
      invocations.push({ toolId, input, ctx });
      return impl(toolId, input, ctx);
    }),
  } as unknown as ExecutionBroker;
  return { broker, invocations };
}

const SEARCH_RESULTS = {
  results: [
    { title: 'Acme GmbH — pump maker', url: 'https://directory.example/acme', content: 'German pump manufacturer' },
    { title: 'Acme on own site', url: 'https://acme.example/about', content: 'self page' },
    { title: 'Trade fair listing', url: 'https://fair.example/exhibitors/acme', content: 'exhibitor Acme' },
  ],
};

const ARGS = {
  workspaceId: 'ws-1',
  runId: 'run-1',
  companyName: 'Acme GmbH',
  industry: 'industrial pumps',
  websiteUrl: 'https://acme.example',
};
const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

describe('researchBrand — 正常链路', () => {
  it('自有官网 crawl → storefront 源；搜索结果 → web_research 源（排除自域名防重复计源）', async () => {
    const { broker } = brokerWith(async (toolId) => {
      if (toolId === 'searxng.search') return { data: SEARCH_RESULTS };
      return { data: { url: 'https://acme.example', text: 'We build pumps since forever.', contentHash: 'h' } };
    });

    const out = await researchBrand({ broker }, ARGS);

    expect(out.degraded).toBe(false);
    const storefront = out.sources.filter((s) => s.sourceType === 'storefront');
    expect(storefront).toHaveLength(1);
    expect(storefront[0]).toMatchObject({
      url: 'https://acme.example',
      sourceRole: 'fact_candidate',
      upstreamContentHash: sha256('We build pumps since forever.'),
      providerContentHash: 'h',
      parserVersion: 'crawl4ai/1',
    });
    const web = out.sources.filter((s) => s.sourceType === 'web_research');
    expect(web.map((s) => s.url)).toEqual([
      'https://directory.example/acme',
      'https://fair.example/exhibitors/acme',
    ]); // 自域名 acme.example 结果被剔除
    for (const s of out.sources) expect(s.fetchedAt).toBeTruthy();
    for (const s of web) {
      expect(s.sourceRole).toBe('research_hint');
      expect(s.upstreamContentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(s.parserVersion).toBe('searxng-snippet/1');
      expect(s.content.length).toBeLessThanOrEqual(500);
    }
  });

  it('全部出网带 taskContractId=site_builder.brand_profile（Broker allowedTools 白名单按它裁决）', async () => {
    const { broker, invocations } = brokerWith(async (toolId) =>
      toolId === 'searxng.search'
        ? { data: SEARCH_RESULTS }
        : { data: { url: 'https://acme.example', text: 'pumps', contentHash: 'h' } },
    );
    await researchBrand({ broker }, ARGS);
    expect(invocations.length).toBeGreaterThan(0);
    for (const call of invocations) {
      expect(call.ctx.taskContractId).toBe('site_builder.brand_profile');
      expect(call.ctx.workspaceId).toBe('ws-1');
    }
  });

  it('🔴 改动 4：出网用途=[site_builder]（两工具均已声明 site_builder，advisory crawl4ai 门放行）', async () => {
    const { broker, invocations } = brokerWith(async (toolId) =>
      toolId === 'searxng.search'
        ? { data: SEARCH_RESULTS }
        : { data: { url: 'https://acme.example', text: 'pumps', contentHash: 'h' } },
    );
    await researchBrand({ broker }, ARGS);
    expect(invocations.length).toBeGreaterThan(0);
    for (const call of invocations) {
      expect(call.ctx.purpose).toEqual(['site_builder']);
    }
  });

  it('robots 禁抓（工具返回空文本）→ storefront 源缺席，不算失败', async () => {
    const { broker } = brokerWith(async (toolId) =>
      toolId === 'searxng.search'
        ? { data: SEARCH_RESULTS }
        : { data: { url: 'https://acme.example', text: '', contentHash: '' } },
    );
    const out = await researchBrand({ broker }, ARGS);
    expect(out.degraded).toBe(false);
    expect(out.sources.some((s) => s.sourceType === 'storefront')).toBe(false);
  });

  it('🔴 Codex #5 自域名归一化：官网 www.acme.example，搜索命中 acme.example 变体 → 仍剔除（不误当外部源）', async () => {
    const { broker } = brokerWith(async (toolId) =>
      toolId === 'searxng.search'
        ? {
            data: {
              results: [
                { title: 'bare domain variant', url: 'https://acme.example/products', content: 'own site no-www' },
                { title: 'subdomain', url: 'https://shop.acme.example/x', content: 'own subdomain' },
                { title: 'real external', url: 'https://directory.example/acme', content: 'external' },
              ],
            },
          }
        : { data: { url: 'https://www.acme.example', text: 'pumps', contentHash: 'h' } },
    );
    const out = await researchBrand({ broker }, { ...ARGS, websiteUrl: 'https://www.acme.example' });
    const webUrls = out.sources.filter((s) => s.sourceType === 'web_research').map((s) => s.url);
    expect(webUrls).toEqual(['https://directory.example/acme']); // 两个自域名变体都被剔除
  });

  it('无 websiteUrl → 只搜索不 crawl', async () => {
    const { broker, invocations } = brokerWith(async () => ({ data: SEARCH_RESULTS }));
    const out = await researchBrand({ broker }, { ...ARGS, websiteUrl: undefined });
    expect(invocations.every((c) => c.toolId === 'searxng.search')).toBe(true);
    expect(out.sources.every((s) => s.sourceType === 'web_research')).toBe(true);
  });

  it('🔴 C4：第三方搜索 title/snippet/路径中的具名个人不进入冻结候选', async () => {
    const { broker } = brokerWith(async (toolId) =>
      toolId === 'searxng.search'
        ? {
            data: {
              results: [
                {
                  title: 'Acme appoints Jane Smith as CEO',
                  url: 'https://news.example/people/jane-smith?author=Jane+Smith',
                  content: 'CEO Jane Smith announced a new pump factory.',
                },
              ],
            },
          }
        : { data: { url: 'https://acme.example', text: 'pumps', contentHash: 'h' } },
    );

    const out = await researchBrand({ broker }, ARGS);
    const hint = out.sources.find((source) => source.sourceType === 'web_research');

    expect(hint).toMatchObject({
      url: 'https://news.example/',
      title: undefined,
      sourceRole: 'research_hint',
      parserVersion: 'searxng-origin-hint/1',
    });
    expect(hint?.content).not.toMatch(/Jane Smith|CEO|new pump factory/i);
    expect(hint?.content).toContain('Acme GmbH');
  });
});

describe('researchBrand — fail-safe 降级', () => {
  it('搜索抛错 → degraded=true，官网源仍返回', async () => {
    const { broker } = brokerWith(async (toolId) => {
      if (toolId === 'searxng.search') throw new Error('searxng down');
      return { data: { url: 'https://acme.example', text: 'pumps', contentHash: 'h' } };
    });
    const out = await researchBrand({ broker }, ARGS);
    expect(out.degraded).toBe(true);
    expect(out.sources.some((s) => s.sourceType === 'storefront')).toBe(true);
  });

  it('crawl 抛错 → degraded=true，搜索源仍返回', async () => {
    const { broker } = brokerWith(async (toolId) => {
      if (toolId === 'searxng.search') return { data: SEARCH_RESULTS };
      throw new Error('crawl4ai down');
    });
    const out = await researchBrand({ broker }, ARGS);
    expect(out.degraded).toBe(true);
    expect(out.sources.some((s) => s.sourceType === 'web_research')).toBe(true);
  });

  it('全挂 → degraded=true + 空源（brandProfile 仍可仅凭 KB 出 Brief）', async () => {
    const { broker } = brokerWith(async () => {
      throw new Error('all down');
    });
    const out = await researchBrand({ broker }, ARGS);
    expect(out).toEqual({ sources: [], degraded: true });
  });
});
