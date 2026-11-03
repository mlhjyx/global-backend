import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { searxSearch, type SearxQuery, type SearxResponse } from '../adapters/searxng';
import type { RequestContext } from '../auth/request-context';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 「自动找官网」（2026-11-03）：卖家档案没有官网时，用自托管 SearXNG 搜候选站点，
 * 由卖家在 UI 里人工确认后再落 website（不自动采信，避免理解到错误公司）。
 * 只返回 {url,title,score}，不抓页面、不读个人数据。
 */

export type SearxngSearchFn = (query: SearxQuery) => Promise<SearxResponse>;

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

@Injectable()
export class WebsiteCandidatesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SEARXNG_SEARCH)
    private readonly search: SearxngSearchFn = searxSearch,
  ) {}

  async find(ctx: RequestContext, companyId: string): Promise<WebsiteCandidate[]> {
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
    const settled = await Promise.allSettled(queries.map((query) => this.search(query)));
    const results = settled.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? outcome.value.results : [],
    );
    return rankWebsiteCandidates(results, name);
  }
}
