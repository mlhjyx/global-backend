import { describe, expect, it, vi } from 'vitest';
import type { SearxResult } from '../adapters/searxng';
import type { RequestContext } from '../auth/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import {
  rankWebsiteCandidates,
  WebsiteCandidatesService,
  type SearxngSearchFn,
} from './website-candidates';

const CTX: RequestContext = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  roles: ['MEMBER'],
  scopes: ['acquisition:write'],
};
const COMPANY_ID = '30000000-0000-4000-8000-000000000003';
const NAME = '四川省川河盛鑫电力工程有限公司';

function result(url: string, title: string): SearxResult {
  return { url, title, content: '' };
}

describe('rankWebsiteCandidates（官网候选排序）', () => {
  it('标题含完整公司名的结果排最前', () => {
    const ranked = rankWebsiteCandidates(
      [
        result('https://unrelated.example/blog', '行业新闻'),
        result('https://sccshx.example', `${NAME} - 官方网站`),
      ],
      NAME,
    );
    expect(ranked[0]?.url).toBe('https://sccshx.example');
  });

  it('过滤 B2B 目录、社交与搜索站（企查查/1688/领英/知乎/百度）', () => {
    const ranked = rankWebsiteCandidates(
      [
        result('https://www.qcc.com/firm/abc.html', `${NAME} - 企查查`),
        result('https://detail.1688.com/offer/1.html', `${NAME} - 1688`),
        result('https://www.linkedin.com/company/x', `${NAME} | LinkedIn`),
        result('https://www.zhihu.com/question/1', `${NAME} 怎么样`),
        result('https://sccshx.example', `${NAME}`),
      ],
      NAME,
    );
    expect(ranked.map((c) => c.url)).toEqual(['https://sccshx.example']);
  });

  it('同一域名只保留分数最高的一条', () => {
    const ranked = rankWebsiteCandidates(
      [
        result('https://sccshx.example/a', '行业资讯'),
        result('https://sccshx.example/about', `${NAME} 简介`),
      ],
      NAME,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.url).toBe('https://sccshx.example/about');
  });

  it('没有任何标题包含公司名时返回空（不猜）', () => {
    const ranked = rankWebsiteCandidates([result('https://random.example', '完全无关')], NAME);
    expect(ranked).toEqual([]);
  });

  it('最多返回 5 条候选', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      result(`https://site${i}.example`, `${NAME} 官网 ${i}`),
    );
    expect(rankWebsiteCandidates(many, NAME)).toHaveLength(5);
  });
});

describe('WebsiteCandidatesService.find', () => {
  function fixture(company: Record<string, unknown> | null, searchImpl?: SearxngSearchFn) {
    const search: SearxngSearchFn = searchImpl ?? vi.fn(async () => ({ results: [], suggestions: [], infoboxes: [], numberOfResults: 0 }));
    const prisma = {
      withWorkspace: vi.fn(async (_ws: string, fn: (tx: unknown) => unknown) =>
        fn({
          companyProfile: { findUnique: vi.fn(async () => company) },
        }),
      ),
    };
    const service = new WebsiteCandidatesService(prisma as unknown as PrismaService, search);
    return { service, search };
  }

  it('中文公司名：用中文语言发「官网」与精确名两个查询并合并结果', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const search: SearxngSearchFn = async (query) => {
      calls.push(query as unknown as Record<string, unknown>);
      return {
        results: [result('https://sccshx.example', NAME)],
        suggestions: [],
        infoboxes: [],
        numberOfResults: 1,
      };
    };
    const { service } = fixture({ id: COMPANY_ID, name: NAME, deletedAt: null }, search);
    const candidates = await service.find(CTX, COMPANY_ID);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ q: `${NAME} 官网`, language: 'zh' });
    expect(calls[1]).toMatchObject({ q: `"${NAME}"` });
    expect(candidates.map((c) => c.url)).toEqual(['https://sccshx.example']);
  });

  it('英文字段名：语言用 en、查询带 official site', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const search: SearxngSearchFn = async (query) => {
      calls.push(query as unknown as Record<string, unknown>);
      return { results: [], suggestions: [], infoboxes: [], numberOfResults: 0 };
    };
    const { service } = fixture({ id: COMPANY_ID, name: 'Acme Bearings GmbH', deletedAt: null }, search);
    await service.find(CTX, COMPANY_ID);
    expect(calls[0]).toMatchObject({ q: 'Acme Bearings GmbH official site', language: 'en' });
  });

  it('搜索失败时返回空列表而不是抛错', async () => {
    const search: SearxngSearchFn = async () => {
      throw new Error('searxng down');
    };
    const { service } = fixture({ id: COMPANY_ID, name: NAME, deletedAt: null }, search);
    await expect(service.find(CTX, COMPANY_ID)).resolves.toEqual([]);
  });

  it('公司不存在或已删除：404', async () => {
    await expect(fixture(null).service.find(CTX, COMPANY_ID)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      fixture({ id: COMPANY_ID, name: NAME, deletedAt: new Date() }).service.find(CTX, COMPANY_ID),
    ).rejects.toMatchObject({ status: 404 });
  });
});
