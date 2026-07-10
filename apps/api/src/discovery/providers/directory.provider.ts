import { createHash } from 'node:crypto';
import {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  DiscoveryOptions,
  DiscoveryResult,
  ExecutionContext,
  ProviderCompanyRecord,
  SourceClass,
} from '../provider-contract';
import { ModelGateway } from '../../model-gateway/model-gateway';
import { getTask } from '../../ai-tasks/task-registry';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import type { SearxResult } from '../../adapters/searxng';
import type { CrawlResult } from '../../adapters/web-crawler';
import { extractSameSiteLinks } from '../../adapters/site-links';
import { isAllowedByRobots } from '../../adapters/robots';
import { normalizeDomain } from '../identity';

const PARSER_VERSION = 'directory/v1';

/** 名录页里常见但绝非目标公司官网的平台/聚合域（列表页自身托管处除外）。 */
const NOISE_DOMAINS = [
  'wikipedia.org', 'youtube.com', 'facebook.com', 'linkedin.com', 'instagram.com',
  'x.com', 'twitter.com', 'xing.com', 'amazon.com', 'ebay.com', 'alibaba.com',
  'aliexpress.com', 'made-in-china.com', 'globalsources.com', 'indiamart.com',
  'yelp.com', 'trustpilot.com', 'indeed.com', 'stepstone.de', 'google.com',
];

/** 定位名录/列表页的检索意图词（EN + DE，覆盖协会名录 / 展会参展商 / 行业目录）。 */
const DIRECTORY_INTENTS_EN = ['members directory', 'member companies', 'exhibitor list', 'industry directory'];
const DIRECTORY_INTENTS_DE = ['Mitgliederverzeichnis', 'Mitglieder', 'Ausstellerverzeichnis', 'Aussteller'];

/** 列表页 URL/标题的正向信号（用于从搜索命中里挑真正的名录页）。 */
const LISTING_HINT = /member|mitglied|exhibitor|aussteller|directory|verzeichnis|list|catalog|katalog|branchenbuch/i;

const MAX_LISTING_PAGES = 8; // 深挖的候选名录页上限（控成本/时长）
const MAX_PAGINATION = 3; // 单个名录最多翻的分页数
const CRAWL_CONCURRENCY = 4;

interface ExtractedList {
  is_directory: boolean;
  list_kind?: string;
  companies?: { name: string; website?: string; location?: string; detail_url?: string }[];
  has_next_page?: boolean;
}

/**
 * 名录/列表发现 Provider（PRD 7.4.11；行业协会会员名录 + 展会参展商名单 + 行业目录）。
 * 管线：SearXNG 定位名录页（意图词）→ 正向信号过滤 + robots → Crawl4AI 抓列表页
 * （有限翻页）→ LLM（gemini-2.5-flash）**列表抽取**（一页多公司）→ 每家一条记录。
 * 与 public_web 的区别：那边一页一公司，这边一页多公司。产出的 website 交 mineDomain 富化。
 * 属 industry_data 类；source_hint=directory/association/trade_fair 可二级路由到本源。
 */
export class DirectoryDiscoveryProvider implements CompanyDiscoveryAdapter {
  readonly key = 'directory';
  readonly classes: SourceClass[] = ['industry_data'];

  constructor(private readonly deps: { gateway: ModelGateway; broker?: ExecutionBroker }) {}

  private log(msg: string): void {

    console.log(`[directory] ${msg}`);
  }

  /** 工具出网上下文：真租户/run 归属 + taskContractId 绑定（allowedTools 白名单生效点）。 */
  private toolCtx(ctx: ExecutionContext, taskContractId: string): ToolContext {
    return { workspaceId: ctx.workspaceId, runId: ctx.runId, correlationId: ctx.correlationId, taskContractId };
  }

  async discoverCompanies(query: CompanyDiscoveryQuery, ctx: ExecutionContext, opts?: DiscoveryOptions): Promise<DiscoveryResult> {
    // 无闸门 = 不允许原始出网（绝不绕过 ToolBroker）→ 诚实降级空结果。
    if (!this.deps.broker) {
      this.log('skip: broker unavailable (fail-closed, no raw egress)');
      return { records: [], costCents: 0 };
    }
    const blocked = new Set((opts?.blockedDomains ?? []).map((d) => d.toLowerCase()));
    const searches = buildDirectorySearches(query);

    // 1) 找候选名录页（跨多条意图查询取并集，正向信号优先）
    const listingUrls = new Map<string, string>(); // url → title
    for (const q of searches) {
      const hits = await this.search(q, ctx);
      for (const h of hits) {
        const domain = normalizeDomain(h.url);
        if (!domain || blocked.has(domain)) continue;
        if (NOISE_DOMAINS.some((n) => domain === n || domain.endsWith(`.${n}`))) continue;
        if (!LISTING_HINT.test(h.url) && !LISTING_HINT.test(h.title)) continue; // 非名录相貌的先跳过
        if (!listingUrls.has(h.url)) listingUrls.set(h.url, h.title);
      }
    }
    const urls = [...listingUrls.keys()].slice(0, MAX_LISTING_PAGES);
    if (!urls.length) return { records: [], costCents: 0 };

    // 2) 抓每个名录页 + 列表抽取（有限并发），记录按 name+domain 去重
    const dedup = new Map<string, ProviderCompanyRecord>();
    for (let i = 0; i < urls.length; i += CRAWL_CONCURRENCY) {
      const batch = urls.slice(i, i + CRAWL_CONCURRENCY);
      const settled = await Promise.allSettled(batch.map((u) => this.mineListing(u, query, ctx)));
      for (const s of settled) {
        if (s.status !== 'fulfilled') continue;
        for (const rec of s.value) {
          const key = rec.domain ?? `n:${rec.name.toLowerCase()}`;
          if (!dedup.has(key)) dedup.set(key, rec);
        }
      }
    }
    return { records: [...dedup.values()], costCents: 0 };
  }

  /** SearXNG 元搜索（经 Broker：searxng.search 工具）。 */
  private async search(q: string, ctx: ExecutionContext): Promise<{ url: string; title: string }[]> {
    const res = await this.deps.broker!.invoke<{ q: string; language?: string }, { results: SearxResult[] }>(
      'searxng.search',
      { q, language: 'en' },
      this.toolCtx(ctx, 'discovery.extract_list'),
    );
    return res.data.results.slice(0, 20);
  }

  /** 抓一个名录页（含有限翻页）→ 列表抽取 → 该页所有公司记录。 */
  private async mineListing(listUrl: string, query: CompanyDiscoveryQuery, ctx: ExecutionContext): Promise<ProviderCompanyRecord[]> {
    const out: ProviderCompanyRecord[] = [];
    let pageUrl: string | null = listUrl;
    const visited = new Set<string>();

    for (let page = 0; page < MAX_PAGINATION && pageUrl && !visited.has(pageUrl); page++) {
      visited.add(pageUrl);
      if (!(await isAllowedByRobots(pageUrl))) {
        this.log(`skip ${pageUrl}: robots disallow`);
        break;
      }
      let text: string;
      try {
        const crawled = await this.deps.broker!.invoke<{ url: string }, CrawlResult>(
          'crawl4ai.fetch',
          { url: pageUrl },
          this.toolCtx(ctx, 'discovery.extract_list'),
        );
        text = crawled.data.text.slice(0, 60_000);
      } catch (err) {
        this.log(`skip ${pageUrl}: crawl failed (${String(err).slice(0, 80)})`);
        break;
      }
      if (text.trim().length < 200) break;

      const extracted = await this.extractList(pageUrl, text, query, ctx);
      if (!extracted?.is_directory || !extracted.companies?.length) {
        if (page === 0) this.log(`${pageUrl}: not a directory (llm)`);
        break; // 首页就不是名录 → 放弃；翻页中途变样 → 停
      }
      const sourceDomain = normalizeDomain(pageUrl) ?? '';
      for (const c of extracted.companies) {
        if (!c.name?.trim()) continue;
        const domain = c.website ? normalizeDomain(c.website) : undefined;
        if (domain && NOISE_DOMAINS.some((n) => domain === n || domain.endsWith(`.${n}`))) continue;
        out.push({
          externalId: domain ? `directory:${domain}` : `directory:${sourceDomain}:${slug(c.name)}`,
          name: c.name.trim(),
          domain: domain || undefined,
          attributes: {
            source_kind: extracted.list_kind ?? 'directory',
            source_directory: sourceDomain,
            listing_location: c.location ?? null,
            detail_url: c.detail_url ?? null,
            source_class: query.sourceClass,
          },
          provenance: {
            sourceUrl: pageUrl,
            fetchedAt: new Date().toISOString(),
            contentHash: createHash('sha256').update(`${pageUrl}:${c.name}`).digest('hex'),
            parserVersion: PARSER_VERSION,
          },
        });
      }
      this.log(`✓ ${pageUrl}: +${extracted.companies.length} companies (page ${page + 1})`);
      pageUrl = extracted.has_next_page ? nextPageLink(text, pageUrl) : null;
    }
    return out;
  }

  private async extractList(
    url: string,
    text: string,
    query: CompanyDiscoveryQuery,
    ctx: ExecutionContext,
  ): Promise<ExtractedList | null> {
    const contract = getTask('discovery.extract_list');
    try {
      const result = await this.deps.gateway.generateStructured<ExtractedList>(
        {
          task: contract?.id ?? 'discovery.extract_list',
          prompt: `目标画像（仅用于相关性判断，禁止照抄进字段）：${JSON.stringify({
            filters: query.filters,
            keywords: query.keywords,
          }).slice(0, 800)}\n\n名录页文本（URL: ${url}）：\n${text}`,
          system: contract?.description,
          model: contract?.model,
          schema: contract?.outputSchema ?? { required: ['is_directory', 'companies'] },
        },
        // 真租户归属（收口②）：ai_trace/usage_ledger 按真实 workspace 记账；runId 供预算归账。
        { workspaceId: ctx.workspaceId, runId: ctx.runId, correlationId: ctx.correlationId },
      );
      return result.data;
    } catch (err) {
      this.log(`extract failed ${url}: ${String(err).slice(0, 80)}`);
      return null;
    }
  }
}

/** 构造名录检索串：行业/关键词 × 意图词（EN + DE）× 地区。 */
export function buildDirectorySearches(query: CompanyDiscoveryQuery): string[] {
  const f = query.filters ?? {};
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);
  const industries = [...arr(f.industry), ...arr(f.sub_industry)].slice(0, 2);
  const keywords = (query.keywords ?? []).slice(0, 2);
  const region = arr(f.region ?? f.country)[0];
  const topic = [industries[0] ?? keywords[0] ?? 'manufacturing', ...keywords.slice(0, 1)].join(' ').trim();

  const intents = [...DIRECTORY_INTENTS_EN.slice(0, 2), ...DIRECTORY_INTENTS_DE.slice(0, 2)];
  const searches = intents.map((intent) => [topic, intent, region ?? ''].filter(Boolean).join(' ').trim());
  // 去重 + 去过短
  return [...new Set(searches)].filter((q) => q.length > 5).slice(0, 4);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** 从当前页文本里找"下一页"链接（同站，含 next/weiter 或数字页码）。 */
function nextPageLink(markdown: string, baseUrl: string): string | null {
  const links = extractSameSiteLinks(markdown, baseUrl);
  const next = links.find((l) => /[?&](page|p|seite|start|offset)=\d+/i.test(l) || /\/(page|seite)\/\d+/i.test(l));
  return next ?? null;
}
