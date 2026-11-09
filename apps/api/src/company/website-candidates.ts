import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { SearxQuery, SearxResponse } from '../adapters/searxng';
import type { RequestContext } from '../auth/request-context';
import { PrismaService } from '../prisma/prisma.service';
import type { ToolBroker } from '../tools/tool-broker';

/**
 * 「自动找官网」（2026-11-03）：卖家档案没有官网时，用自托管 SearXNG 搜候选站点，
 * 由卖家在 UI 里人工确认后再落 website（不自动采信，避免理解到错误公司）。
 * 只返回 {url,title,score}，不抓页面、不读个人数据。
 *
 * WEB-10（v3.0 第 6 章）：元搜索出网必须经 ToolBroker（source_policy/预算/限流/Trace 与
 * 幂等键都在闸门内）——本模块不再直接调用 `searxSearch`；组合根用
 * `brokerBackedSearxSearch` 注入工具环执行器，缺失时 fail-closed（503），
 * 不存在未登记的直连出网路径。
 */

export interface WebsiteSearchContext {
  workspaceId: string;
  correlationId?: string;
}

export type SearxngSearchFn = (
  query: SearxQuery,
  context: WebsiteSearchContext,
) => Promise<SearxResponse>;

export const SEARXNG_SEARCH = Symbol('SEARXNG_SEARCH');

export interface WebsiteCandidate {
  url: string;
  title: string;
  score: number;
}

/** B2B 目录、企业信息聚合、社交与搜索站：不是公司官网，直接排除。 */
const EXCLUDED_HOST_SUFFIXES = [
  'qcc.com',
  'qichacha.com',
  'tianyancha.com',
  'aiqicha.baidu.com',
  '1688.com',
  'alibaba.com',
  'made-in-china.com',
  'globalsources.com',
  'tradekey.com',
  'ec21.com',
  'kompass.com',
  'crunchbase.com',
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'x.com',
  'twitter.com',
  'weibo.com',
  'zhihu.com',
  'baike.baidu.com',
  'baidu.com',
  'sohu.com',
  'sina.com.cn',
  '163.com',
  'qq.com',
  'bilibili.com',
  'douyin.com',
  'zhaopin.com',
  '51job.com',
  'liepin.com',
  'zhipin.com',
  'google.com',
  'bing.com',
  'wikipedia.org',
];

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function hostOf(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname.replace(/^www\./u, '').toLowerCase();
  } catch {
    return null;
  }
}

function isExcludedHost(host: string): boolean {
  return EXCLUDED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function candidateScore(title: string, normalizedName: string): number {
  const normalizedTitle = normalizeName(title);
  if (!normalizedTitle || !normalizedName) return 0;
  if (normalizedTitle.includes(normalizedName)) return 3;
  // 中文名很长时允许命中前半段（标题常截断/加后缀）。
  if (normalizedName.length >= 8 && normalizedTitle.includes(normalizedName.slice(0, 8))) return 1;
  return 0;
}

/** 纯函数：搜索结果 → 去重、过滤、按得分排序的官网候选（最多 limit 条）。 */
export function rankWebsiteCandidates(
  results: readonly { url: string; title?: string }[],
  companyName: string,
  limit = 5,
): WebsiteCandidate[] {
  const normalizedName = normalizeName(companyName);
  const bestByHost = new Map<string, WebsiteCandidate>();
  for (const item of results) {
    const host = hostOf(item.url);
    if (!host || isExcludedHost(host)) continue;
    const title = item.title ?? '';
    const score = candidateScore(title, normalizedName);
    if (score <= 0) continue;
    const current = bestByHost.get(host);
    if (!current || current.score < score) {
      bestByHost.set(host, { url: item.url, title, score });
    }
  }
  return [...bestByHost.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

const CJK_PATTERN = /[㐀-鿿]/u;

/**
 * ToolBroker 版本的 searxng 执行器：searxng.search 工具（sourcePolicy=none、cost 0）
 * 的 durable 投影只保留 {url,title}，与候选排序所需字段一致。
 */
export function brokerBackedSearxSearch(
  broker: Pick<ToolBroker, 'invoke'>,
): SearxngSearchFn {
  return async (query, context) => {
    const result = await broker.invoke<
      {
        q: string;
        categories?: SearxQuery['categories'];
        engines?: string[];
        language?: string;
        timeRange?: SearxQuery['timeRange'];
      },
      { results: { url: string; title?: string }[] }
    >(
      'searxng.search',
      {
        q: query.q,
        ...(query.categories ? { categories: query.categories } : {}),
        ...(query.engines ? { engines: query.engines } : {}),
        ...(query.language ? { language: query.language } : {}),
        ...(query.timeRange ? { timeRange: query.timeRange } : {}),
      },
      {
        workspaceId: context.workspaceId,
        ...(context.correlationId ? { correlationId: context.correlationId } : {}),
      },
    );
    const rows = Array.isArray(result.data?.results) ? result.data.results : [];
    return {
      results: rows
        .filter((row) => typeof row?.url === 'string' && row.url.length > 0)
        .map((row) => ({ url: row.url, title: row.title ?? '' })),
      suggestions: [],
      infoboxes: [],
      numberOfResults: rows.length,
    };
  };
}

@Injectable()
export class WebsiteCandidatesService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(SEARXNG_SEARCH)
    private readonly search?: SearxngSearchFn,
  ) {}

  async find(ctx: RequestContext, companyId: string): Promise<WebsiteCandidate[]> {
    if (!this.search) {
      // WEB-10：没有 ToolBroker 执行器就不出网（不存在未登记的直连 searxng 路径）。
      throw new ServiceUnavailableException({
        error: {
          code: 'WEBSITE_CANDIDATE_SEARCH_UNAVAILABLE',
          message: 'website candidate search requires the governed tool broker',
        },
      });
    }
    const company = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.companyProfile.findUnique({
        where: { id: companyId },
        select: { id: true, name: true, deletedAt: true },
      }),
    );
    if (!company || company.deletedAt) {
      throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'company not found' } });
    }
    const name = company.name.trim();
    if (!name) return [];
    const cjk = CJK_PATTERN.test(name);
    const queries: SearxQuery[] = [
      { q: cjk ? `${name} 官网` : `${name} official site`, categories: ['general'], language: cjk ? 'zh' : 'en' },
      { q: `"${name}"`, categories: ['general'], language: cjk ? 'zh' : 'en' },
    ];
    const search = this.search;
    const settled = await Promise.allSettled(
      queries.map((query) =>
        search(query, {
          workspaceId: ctx.workspaceId,
          correlationId: `website-candidates:${companyId}`,
        }),
      ),
    );
    const results = settled.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? outcome.value.results : [],
    );
    return rankWebsiteCandidates(results, name);
  }
}
