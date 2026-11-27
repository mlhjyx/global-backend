import { normalizeCompanyNameTypography } from '../company-name-format';
import { selectAssociationDirectories } from '../association-directory-catalog';
import {
  cleanDirectoryCompanyName,
  dedupeDirectoryRecords,
  isDirectoryNoiseEntry,
  normalizeDirectoryWebsiteDomain,
  resolveDirectoryCompanyCountry,
} from '../directory-record-cleaner';
import { isStableSafeHttpsUrl } from '../raw-source-provider-normalizer';
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
import {
  withUntrustedWebContentGuard,
  wrapUntrustedWebContent,
} from '../../model-gateway/untrusted-content';
import { getTask } from '../../ai-tasks/task-registry';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import type { SearxngSearchOutput } from '../../tools/builtin-tools';
import type { SearchProviderOutput } from '../../tools/search-provider-tools';
import { resolveBraveSearchApiKey, resolveSerperApiKey } from '../../adapters/search-providers';
import { fuseSearchEngineHits, type SearchSourceBucket } from '../cross-source-fusion';
import { buildTradeFairSearchQueries, selectCatalogFairs } from '../trade-fair-catalog';
import type { CrawlResult } from '../../adapters/web-crawler';
import { extractSameSiteLinks } from '../../adapters/site-links';
import { isAllowedByRobots } from '../../adapters/robots';
import { normalizeDomain } from '../identity';
import {
  executeStructuredTaskWithRuntime,
  type RuntimeStructuredModelResult,
} from '../../model-runtime/structured-task-runtime-bridge';
import type { RuntimeTelemetry } from '../../model-runtime/types';
import { artifactSubjectSkipReason } from '../../tools/artifact-subject-denial';
import { isExecutionControlError } from '../../execution-budget/execution-control-error';
import { MODEL_CALL_FAILED, tallyModelExtractions } from '../discovery-model-extractions';
import { settledModelFailureReason } from '../settled-model-failure';
import {
  DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
  buildDiscoveryCompanyResultLineage,
  createDiscoveryCompanyReceiptCollector,
  isDiscoveryCompanyReceiptForwardingFailure,
  isDiscoveryCompanyLineageInvalid,
  type DiscoveryCompanyReceiptCollector,
} from '../company-discovery-lineage';
import {
  MAX_DIRECTORY_LISTING_PAGES,
  MAX_DIRECTORY_PAGINATION,
  MAX_DIRECTORY_SEARCHES_PER_QUERY,
} from '../execution-envelope';
import {
  searchCountryName,
  searchLanguageFor,
  searchableTerms,
  targetCountryCodes,
  type SearchLanguage,
} from '../search-localization';

const PARSER_VERSION = 'directory/v1';

/** 名录页里常见但绝非目标公司官网的平台/聚合域（列表页自身托管处除外）。 */
const NOISE_DOMAINS = [
  'wikipedia.org', 'youtube.com', 'facebook.com', 'linkedin.com', 'instagram.com',
  'x.com', 'twitter.com', 'xing.com', 'amazon.com', 'ebay.com', 'alibaba.com',
  'aliexpress.com', 'made-in-china.com', 'globalsources.com', 'indiamart.com',
  'yelp.com', 'trustpilot.com', 'indeed.com', 'stepstone.de', 'google.com',
];

/** 定位名录/列表页的检索意图词（按目标市场语言选族，覆盖主流出口语种）。 */
const DIRECTORY_INTENTS_EN = ['members directory', 'member companies', 'exhibitor list', 'industry directory'];
const DIRECTORY_INTENTS_DE = ['Mitgliederverzeichnis', 'Mitglieder', 'Ausstellerverzeichnis', 'Aussteller'];
const DIRECTORY_INTENTS_ZH = ['企业名录', '企业黄页', '参展商名单', '供应商目录'];
const DIRECTORY_INTENTS_BY_LANG: Readonly<Partial<Record<SearchLanguage, readonly string[]>>> = Object.freeze({
  it: ['elenco aziende', 'espositori', 'soci associazione', 'catalogo espositori'],
  es: ['directorio empresas', 'expositores', 'socios asociación', 'catálogo expositores'],
  pt: ['diretório empresas', 'expositores', 'associados', 'catálogo expositores'],
  fr: ['annuaire entreprises', 'exposants', 'membres association', 'liste exposants'],
  nl: ['bedrijvengids', 'exposanten', 'ledenlijst', 'deelnemerslijst'],
  pl: ['katalog firm', 'wystawcy', 'lista członków', 'lista wystawców'],
  tr: ['firma rehberi', 'katılımcı listesi', 'üye listesi', 'fuar katılımcıları'],
});

/** 明确非名录的组织介绍、治理架构、工作组、登录、资讯类路径（命中直接排除）。 */
const NON_LISTING_PATH_RE =
  /(?:^|\/)(?:board[-_]?of[-_]?members|governing[-_]?board|gruppi[-_]?di[-_]?lavoro|working[-_]?groups?|become[-_]?a[-_]?member|join[-_]?us|membership[-_]?(?:fees?|benefits?|apply)|login|sign[-_]?in|register|contact(?:[-_]?us)?|contatti|privacy|cookie|terms|news|blog|press|article)(?:\/|$)/iu;

const ABOUT_ONLY_PATH_RE = /^\/(?:[a-z]{2}\/)?(?:chi-siamo|about(?:-us)?|qui-sommes-nous|ueber-uns|quienes-somos)\/?$/iu;
const ROOT_OR_LOCALE_HOME_RE = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/?)?$/iu;

/** 列表页 URL/标题的正向信号（词边界精确匹配，剔除 `soci`/`asociaci`/`list`/`member` 泛子串误匹配）。 */
const LISTING_HINT =
  /(?:^|[^a-z\p{L}])(?:members?[-_/\s]+(?:directory|list|companies|catalogue?|index)|member[-_/\s]+companies|(?:our|meet[-_/\s]+our|current|esmc)[-_/\s]+members|list[-_/\s]+of[-_/\s]+(?:members|corporate[-_/\s]+partners)|directory|directories|exhibitors?|aussteller(?:verzeichnis|liste)?|mitglieder(?:verzeichnis|liste|suche)?|verzeichnis|branchenbuch|katalog|catalog(?:ue|o)?|elenco(?:[-_/\s]+(?:aziende|soci|associati|imprese))?|espositori?|associati|associad[oa]s|i[-_/\s]+nostri[-_/\s]+(?:soci|associati)|(?:lista|albo)[-_/\s]+(?:soci|associati|aziende)|directorio|expositores?|listado[-_/\s]+(?:empresas|socios)|annuaire|exposants?|liste[-_/\s]+(?:des[-_/\s]+)?(?:membres|exposants|entreprises)|bedrijvengids|leden(?:lijst)?|deelnemers(?:lijst)?|wystawc[a-z\p{L}]*|lista[-_/\s]+(?:cz[łl]onk[óo]w|wystawc[óo]w)|firma[-_/\s]+rehberi|kat[ıi]l[ıi]mc[ıi]|(?:kurumsal[-_/\s]+)?[uü]yeler(?:imiz)?|k[uü]me[-_/\s]+[uü]yelerimiz|üye[-_/\s]+listesi|spqp\/listing|(?:exhibitor|company|supplier|buyer|vendor|manufacturer|distributor)[-_/\s]+list)(?:$|[^a-z\p{L}])|\/(?:about(?:-us)?\/)?(?:members|membership)\/?$|名录|黄页|企业库|企业大全|参展商|会员企业|供应商目录/iu;

const HOME_TITLE_DIRECTORY_HINT =
  /(?:^|[^a-z\p{L}])(?:members?[-_\s]+directory|exhibitor[-_\s]+list|industry[-_\s]+directory|yellow[-_\s]+pages|branchenbuch|bedrijvengids|annuaire|directorio|elenco[-_\s]+aziende)(?:$|[^a-z\p{L}])|企业名录|企业黄页|企业大全|参展商名单|供应商目录/iu;

/** 搜索结果是否名录/黄页相貌（过滤掉协会首页/介绍/董事会/工作组等非名录页，保留真名录）。 */
export function isDirectoryListingShaped(url: string, title: string): boolean {
  let path = url;
  try {
    const parsed = new URL(url);
    path = decodeURIComponent(parsed.pathname);
    if (NON_LISTING_PATH_RE.test(path) || ABOUT_ONLY_PATH_RE.test(path)) return false;
    if (ROOT_OR_LOCALE_HOME_RE.test(path)) {
      return HOME_TITLE_DIRECTORY_HINT.test(title);
    }
  } catch {
    /* non-standard test URL falls back to full-string check */
  }
  return LISTING_HINT.test(path) || LISTING_HINT.test(title);
}

const CRAWL_CONCURRENCY = 4;
type PolicyCheck = NonNullable<DiscoveryOptions['sourcePolicyCheck']>;
const POLICY_REASONS = new Set([
  'SOURCE_POLICY_MISSING', 'SOURCE_POLICY_SUSPENDED', 'SOURCE_POLICY_PURPOSE_NOT_ALLOWED',
  'INVALID_PROVENANCE', 'SOURCE_POLICY_CONTEXT_MISSING',
]);

function admitsSource(url: string, check: PolicyCheck, denied: string[]): boolean {
  const decision = check(url);
  if (decision.allowed === true) return true;
  const code = decision.reasonCode ?? 'SOURCE_POLICY_CONTEXT_MISSING';
  denied.push(POLICY_REASONS.has(code) ? code : 'SOURCE_POLICY_CONTEXT_MISSING');
  return false;
}

function policyOutcome(denied: readonly string[]): DiscoveryResult['outcome'] {
  if (!denied.length) return undefined;
  const counts = new Map<string, number>();
  for (const code of denied) counts.set(code, (counts.get(code) ?? 0) + 1);
  const issues = [...counts].sort(([a], [b]) => a.localeCompare(b));
  return { errorClass: 'EMPTY_RESULT', reasonCode: issues[0]![0], issues: issues.map(([code, n]) => `${code}:${n}`) };
}

interface ExtractedList {
  is_directory: boolean;
  list_kind?: string;
  companies?: { name: string; website?: string; location?: string; detail_url?: string;
  }[];
  has_next_page?: boolean;
}

type MinedDirectoryRecord = Readonly<{
  record: ProviderCompanyRecord;
  collector: DiscoveryCompanyReceiptCollector;
}>;

type MinedDirectoryListing = Readonly<{
  records: readonly MinedDirectoryRecord[];
  collectors: readonly DiscoveryCompanyReceiptCollector[];
  /** One entry per model call on the listing's pages, with the failure reason if it was skipped. */
  extractionCalls: readonly Readonly<{ failureReason?: string }>[];
  policyBlocked: boolean;
}>;

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
  readonly companyResultLineage = DISCOVERY_COMPANY_RESULT_LINEAGE_V1;

  constructor(private readonly deps: {
    gateway: ModelGateway;
    broker?: ExecutionBroker;
    runtimeTelemetry?: RuntimeTelemetry;
  },
  ) {}

  private log(msg: string): void {

    console.log(`[directory] ${msg}`);
  }

  /** 工具出网上下文：真租户/run 归属 + taskContractId 绑定（allowedTools 白名单生效点）。 */
  private toolCtx(ctx: ExecutionContext, taskContractId: string): ToolContext {
    return { ...ctx, taskContractId };
  }

  async discoverCompanies(
    query: CompanyDiscoveryQuery,
    ctx: ExecutionContext,
    opts?: DiscoveryOptions,
  ): Promise<DiscoveryResult> {
    // 无闸门 = 不允许原始出网（绝不绕过 ToolBroker）→ 诚实降级空结果。
    if (!this.deps.broker) {
      this.log('skip: broker unavailable (fail-closed, no raw egress)');
      return {
        records: [],
        costCents: 0,
        lineage: buildDiscoveryCompanyResultLineage({
          providerKey: 'directory',
          recordCount: 0,
          observations: [],
        }),
      };
    }
    const policyCheck = opts?.sourcePolicyCheck;
    if (!policyCheck) return this.emptyResult(['SOURCE_POLICY_CONTEXT_MISSING']);
    const denied: string[] = [];
    const blocked = new Set((opts?.blockedDomains ?? []).map((d) => d.toLowerCase()));
    const urls = await this.findListings(query, ctx, blocked, policyCheck, denied);
    if (!urls.length) {
      return this.emptyResult(denied);
    }

    // 2) 抓每个名录页 + 列表抽取（有限并发），跨名录按规范域名与公司名去重
    const minedItems: MinedDirectoryRecord[] = [];
    const collectors: DiscoveryCompanyReceiptCollector[] = [];
    const extractionCalls: Array<Readonly<{ failureReason?: string }>> = [];
    let allListingsPolicyBlocked = true;
    for (let i = 0; i < urls.length; i += CRAWL_CONCURRENCY) {
      const batch = urls.slice(i, i + CRAWL_CONCURRENCY);
      const settled = await Promise.allSettled(batch.map((u) => this.mineListing(u, query, ctx, policyCheck, denied)));
      for (const s of settled) {
        if (s.status === 'rejected' && isExecutionControlError(s.reason)) throw s.reason;
        if (s.status === 'rejected' && isDiscoveryCompanyReceiptForwardingFailure(s.reason)) throw s.reason;
        if (s.status === 'rejected' && isDiscoveryCompanyLineageInvalid(s.reason)) throw s.reason;
        if (s.status !== 'fulfilled') {
          allListingsPolicyBlocked = false;
          continue;
        }
        if (!s.value.policyBlocked) allListingsPolicyBlocked = false;
        collectors.push(...s.value.collectors);
        extractionCalls.push(...s.value.extractionCalls);
        minedItems.push(...s.value.records);
      }
    }
    const deduped = dedupeDirectoryRecords(minedItems);
    const records = deduped.map((item) => item.record);
    const collectorIndexes = new Map<DiscoveryCompanyReceiptCollector, number[]>();
    deduped.forEach((item, recordIndex) => {
      const existing = collectorIndexes.get(item.collector);
      if (existing) existing.push(recordIndex);
      else collectorIndexes.set(item.collector, [recordIndex]);
    });
    const lineage = buildDiscoveryCompanyResultLineage({
      providerKey: 'directory',
      recordCount: records.length,
      observations: collectors.map((collector) =>
        collector.finish(Object.freeze(collectorIndexes.get(collector) ?? [])),
      ),
    });
    return {
      records,
      costCents: 0,
      ...(lineage ? { lineage } : {}),
      modelExtractions: tallyModelExtractions(extractionCalls),
      ...(!records.length && allListingsPolicyBlocked && !extractionCalls.length
        ? { outcome: policyOutcome(denied) } : {}),
    };
  }

  private emptyResult(denied: readonly string[]): DiscoveryResult {
    return {
      records: [], costCents: 0,
      lineage: buildDiscoveryCompanyResultLineage({ providerKey: 'directory', recordCount: 0, observations: [] }),
      ...(denied.length ? { outcome: policyOutcome(denied) } : {}),
    };
  }

  private async findListings(
    query: CompanyDiscoveryQuery, ctx: ExecutionContext, blocked: ReadonlySet<string>,
    policyCheck: PolicyCheck, denied: string[],
  ): Promise<string[]> {
    const listingUrls = new Set<string>();
    const seen = new Set<string>();
    // 1) 优先直注已批准的行业协会名录入口（严格经 blockedDomains + source_policy 准入闸门）
    for (const seedUrl of selectApprovedAssociationDirectoryUrls(query)) {
      const domain = normalizeDomain(seedUrl);
      if (!domain || blocked.has(domain) || seen.has(seedUrl)) continue;
      seen.add(seedUrl);
      if (admitsSource(seedUrl, policyCheck, denied)) listingUrls.add(seedUrl);
      if (listingUrls.size >= MAX_DIRECTORY_LISTING_PAGES) {
        return [...listingUrls].slice(0, MAX_DIRECTORY_LISTING_PAGES);
      }
    }
    // 2) 搜索引擎补齐剩余名录页配额
    for (const q of buildDirectorySearches(query)) {
      const hits = await this.search(q, ctx, searchLanguageFor(query));
      for (const h of hits) {
        const domain = normalizeDomain(h.url);
        if (!domain || blocked.has(domain)) continue;
        if (NOISE_DOMAINS.some((n) => domain === n || domain.endsWith(`.${n}`))) continue;
        if (!isDirectoryListingShaped(h.url, h.title) || seen.has(h.url)) continue;
        seen.add(h.url);
        if (admitsSource(h.url, policyCheck, denied)) listingUrls.add(h.url);
      }
    }
    // Denied results must not displace approved sources from the existing page cap.
    return [...listingUrls].slice(0, MAX_DIRECTORY_LISTING_PAGES);
  }

  /**
   * SearXNG 元搜索（经 Broker：searxng.search 工具）。language 跟随目标市场语言——
   * 中文市场固定 language=en 时搜索结果会退化成无关页面（2026-11-06 实测）。
   */
  private async search(
    q: string,
    ctx: ExecutionContext,
    language: SearchLanguage,
  ): Promise<{ url: string; title: string }[]> {
    const toolCtx = this.toolCtx(ctx, 'discovery.extract_list');
    const res = await this.deps.broker!.invoke<{ q: string; language?: string }, SearxngSearchOutput>(
      'searxng.search',
      { q, language },
      toolCtx,
    );
    const buckets: SearchSourceBucket[] = [
      { source: 'searxng', hits: res.data.results.slice(0, 20) },
    ];
    if (resolveSerperApiKey()) {
      try {
        const serper = await this.deps.broker!.invoke<
          { query: string; num?: number; hl?: string },
          SearchProviderOutput
        >('serper.search', { query: q, num: 10, hl: language }, toolCtx);
        if (serper.data?.results?.length) {
          buckets.push({ source: 'serper', hits: serper.data.results });
        }
      } catch (error) {
        if (isExecutionControlError(error)) throw error;
        this.log(`optional serper.search degraded: ${String(error).slice(0, 80)}`);
      }
    }
    if (resolveBraveSearchApiKey()) {
      try {
        const brave = await this.deps.broker!.invoke<
          { query: string; count?: number; searchLang?: string },
          SearchProviderOutput
        >('brave.search', { query: q, count: 10, searchLang: language }, toolCtx);
        if (brave.data?.results?.length) {
          buckets.push({ source: 'brave', hits: brave.data.results });
        }
      } catch (error) {
        if (isExecutionControlError(error)) throw error;
        this.log(`optional brave.search degraded: ${String(error).slice(0, 80)}`);
      }
    }
    return fuseSearchEngineHits(buckets).map((item) => ({ url: item.url, title: item.title ?? '' }));
  }

  /** 抓一个名录页（含有限翻页）→ 列表抽取 → 该页所有公司记录。 */
  private async mineListing(
    listUrl: string,
    query: CompanyDiscoveryQuery,
    ctx: ExecutionContext,
    policyCheck: PolicyCheck,
    denied: string[],
  ): Promise<MinedDirectoryListing> {
    const out: MinedDirectoryRecord[] = [];
    const collectors: DiscoveryCompanyReceiptCollector[] = [];
    const extractionCalls: Array<Readonly<{ failureReason?: string }>> = [];
    let policyBlocked = false;
    let pageUrl: string | null = listUrl;
    const visited = new Set<string>();

    for (let page = 0; page < MAX_DIRECTORY_PAGINATION && pageUrl && !visited.has(pageUrl); page++) {
      if (!admitsSource(pageUrl, policyCheck, denied)) {
        policyBlocked = true;
        break;
      }
      const sourceUrl: string = pageUrl;
      visited.add(pageUrl);
      if (
        !(await isAllowedByRobots(pageUrl, {
          authorizeExternalAction: ctx.authorizeExternalAction,
        }))
      ) {
        this.log(`skip ${pageUrl}: robots disallow`);
        break;
      }
      let text: string;
      try {
        const crawled = await this.deps.broker!.invoke<{ url: string; maxChars?: number }, CrawlResult>(
          'crawl4ai.fetch',
          // maxChars=60k：名录列表页单页数百家公司，工具默认 40k 会静默砍掉尾部 1/3 条目（复审 medium）
          { url: pageUrl, maxChars: 60_000 },
          // FIX C（Codex P1）：显式用途，防 crawl4ai site_builder 扩宽波及本发现抓取（复现变更前有效集）。
          {
            ...this.toolCtx(ctx, 'discovery.extract_list'),
            purpose: ['discovery', 'enrichment'],
          },
        );
        const reportedUrl: string = crawled.data.url ?? sourceUrl;
        if (!admitsSource(reportedUrl, policyCheck, denied)) {
          policyBlocked = true;
          break;
        }
        // A persisted URL may be a privacy-safe origin, not a navigation URL.
        // Keep the requested page for pagination and stable per-page identities.
        if (normalizeDomain(reportedUrl) !== normalizeDomain(sourceUrl)) {
          denied.push('INVALID_PROVENANCE');
          policyBlocked = true;
          break;
        }
        text = crawled.data.text.slice(0, 60_000);
      } catch (err) {
        // G3（2026-09-24）：名录页在建档前没有真实主体，抓取被主体绑定禁令拒绝时
        // 只跳过这一页（请求未发出、预算已释放），不让整个发现 run 失败。
        if (artifactSubjectSkipReason(err)) {
          this.log(`skip ${pageUrl}: artifact subject binding held`);
          break;
        }
        if (isExecutionControlError(err)) throw err;
        this.log(`skip ${pageUrl}: crawl failed (${String(err).slice(0, 80)})`);
        break;
      }
      if (text.trim().length < 200) break;

      const extraction = await this.extractList(sourceUrl, text, query, ctx);
      collectors.push(extraction.collector);
      extractionCalls.push(
        extraction.failureReason === undefined ? {} : { failureReason: extraction.failureReason },
      );
      const extracted = extraction.data;
      if (!extracted?.is_directory || !extracted.companies?.length) {
        if (page === 0) this.log(`${pageUrl}: not a directory (llm)`);
        break; // 首页就不是名录 → 放弃；翻页中途变样 → 停
      }
      const sourceDomain = normalizeDomain(sourceUrl) ?? '';
      for (const c of extracted.companies) {
        const cleanedName = cleanDirectoryCompanyName(c.name);
        if (!cleanedName) continue;
        const cleanedDomain = normalizeDirectoryWebsiteDomain(c.website, sourceDomain);
        if (
          isDirectoryNoiseEntry({
            name: cleanedName,
            domain: cleanedDomain,
            sourceDirectoryDomain: sourceDomain,
          })
        ) {
          continue;
        }
        const mapped = mapDirectoryCompanyToRecord({
          company: {
            ...c,
            name: cleanedName,
            website: cleanedDomain ?? undefined,
          },
          listKind: extracted.list_kind,
          pageUrl: sourceUrl,
          sourceClass: query.sourceClass,
        });
        out.push(Object.freeze({ record: mapped, collector: extraction.collector }));
      }
      this.log(`✓ ${pageUrl}: +${out.length} cleaned companies (raw ${extracted.companies.length}, page ${page + 1})`);
      pageUrl = extracted.has_next_page ? nextPageLink(text, sourceUrl) : null;
    }
    return Object.freeze({
      records: Object.freeze(out),
      collectors: Object.freeze(collectors),
      extractionCalls: Object.freeze(extractionCalls),
      policyBlocked,
    });
  }

  private async extractList(
    url: string,
    text: string,
    query: CompanyDiscoveryQuery,
    ctx: ExecutionContext,
  ): Promise<Readonly<{
    data: ExtractedList | null;
    collector: DiscoveryCompanyReceiptCollector;
    /** Why the call failed and the listing was skipped. */
    failureReason?: string;
  }>> {
    const contract = getTask('discovery.extract_list');
    const collector = createDiscoveryCompanyReceiptCollector({
      providerKey: 'directory',
      producerId: 'discovery.extract_list',
      parentOnDurableReceipt: ctx.onDurableReceipt,
    });
    collector.markExpectedInvocation();
    try {
      const result: RuntimeStructuredModelResult<ExtractedList> =
        await executeStructuredTaskWithRuntime<ExtractedList>(
        this.deps.gateway,
        {
          task: contract?.id ?? 'discovery.extract_list',
          prompt: `目标画像（仅用于相关性判断，禁止照抄进字段）：${JSON.stringify({
            filters: query.filters,
            keywords: query.keywords,
          }).slice(0, 800)}\n\n名录页文本（URL: ${url}）：\n${wrapUntrustedWebContent(url, text)}`,
          system: withUntrustedWebContentGuard(contract?.description),
          model: contract?.model,
          schema: contract?.outputSchema ?? {
            required: ['is_directory', 'companies'],
          },
        },
        // 真租户归属（收口②）：ai_trace/usage_ledger 按真实 workspace 记账；runId 供预算归账。
        {
          ...ctx,
          durableResultSchema: 'discovery-extract-list/v1',
          onDurableReceipt: collector.onDurableReceipt,
        },
        { telemetry: this.deps.runtimeTelemetry },
      );
      return Object.freeze({ data: result.data, collector });
    } catch (err) {
      const settledReason = settledModelFailureReason(err);
      if (
        collector.isForwardingFailure(err) ||
        isDiscoveryCompanyLineageInvalid(err) ||
        (settledReason === undefined && isExecutionControlError(err))
      ) {
        throw err;
      }
      // The gateway settled the call without a durable result (an unusable answer or a cut
      // stream): the listing is skipped, the query keeps its lineage, and the run counts the
      // skip. Any other failure leaves the outcome unknown and voids the lineage.
      if (settledReason !== undefined) collector.markInvocationFailed();
      this.log(`extract failed ${url}: ${String(err).slice(0, 80)}`);
      return Object.freeze({
        data: null,
        collector,
        failureReason: settledReason ?? MODEL_CALL_FAILED,
      });
    }
  }
}

/** 若 detail_url 不满足稳定 URL 契约（含查询串/锚点/端口/电话样路径等），
 *  丢弃该字段而不是拒绝整条记录：detail_url 是可选的富化字段，
 *  名录列表页常给带长数字 ID 的详情链接，会被 CONTACT_LIKE_PHONE 判为电话样文本
 *  （2026-11-07 实测：51 条记录因此整条被 normalize 拒绝）。 */
function sanitizeDetailUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return undefined;
    parsed.search = '';
    parsed.hash = '';
    const candidate = parsed.toString();
    return isStableSafeHttpsUrl(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function mapDirectoryCompanyToRecord(args: {
  company: {
    name: string;
    website?: string;
    location?: string;
    detail_url?: string;
  };
  listKind?: string;
  pageUrl: string;
  sourceClass: SourceClass;
}): ProviderCompanyRecord {
  const sourceDomain = normalizeDomain(args.pageUrl) ?? '';
  const name =
    cleanDirectoryCompanyName(args.company.name) ??
    normalizeCompanyNameTypography(args.company.name);
  const domain = normalizeDirectoryWebsiteDomain(args.company.website, sourceDomain) ?? undefined;
  const country = resolveDirectoryCompanyCountry({
    location: args.company.location,
    pageUrl: args.pageUrl,
    sourceDirectoryDomain: sourceDomain,
  });
  return {
    externalId: domain
      ? `directory:${domain}`
      : `directory:${sourceDomain}:${slug(name)}`,
    // Match public-web typography rules before unchanged Raw validation (strips ™/®/quotes, collapses dashes).
    name,
    domain,
    ...(country ? { country } : {}),
    attributes: {
      source_kind: args.listKind ?? 'directory',
      source_directory: sourceDomain,
      listing_location: args.company.location ?? null,
      detail_url: sanitizeDetailUrl(args.company.detail_url) ?? null,
      source_class: args.sourceClass,
    },
    provenance: {
      sourceUrl: args.pageUrl,
      fetchedAt: new Date().toISOString(),
      contentHash: createHash('sha256')
        .update(`${args.pageUrl}:${name}`)
        .digest('hex'),
      parserVersion: PARSER_VERSION,
    },
  };
}

/** 按目标市场与行业词挑选已批准的行业协会会员名录入口 URL（供 findListings 优先直通准入）。 */
export function selectApprovedAssociationDirectoryUrls(query: CompanyDiscoveryQuery): string[] {
  if (searchLanguageFor(query) === 'zh') return [];
  const f = query.filters ?? {};
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)];
  const matched = selectAssociationDirectories({
    industryTerms: [...arr(f.industry), ...arr(f.sub_industry)],
    keywords: query.keywords ?? [],
    countries: targetCountryCodes(query).map((code) => code.toUpperCase()),
    regions: arr(f.region),
  });
  return matched.map((entry) => entry.directoryUrl);
}

/**
 * 构造名录检索串：行业/关键词 × 意图词（按目标市场语言选族）× 地区。词的可写性按目标语言判定：
 * 中文市场保留中文主题词、配中文名录意图词（2026-11-06 修复——旧版一律按「非 CJK 才可用」把
 * 中文主题整段剥掉，检索退化成 "manufacturing members directory 中国"，实测只返回无关页面）；
 * 其它市场维持旧行为（本地语言词 + EN/DE 意图词）。主题词一个都写不出时不检索（不退回通用的
 * manufacturing）；地区依次取可写的地区词、国家词、目标国的当地名称，给了地理范围却一个都写不出
 * 时也不检索，免得搜成全球名录。
 */
export function buildDirectorySearches(query: CompanyDiscoveryQuery): string[] {
  const f = query.filters ?? {};
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);
  const rawIndustries = [...arr(f.industry), ...arr(f.sub_industry)];
  const rawKeywords = query.keywords ?? [];
  const language = searchLanguageFor(query);
  // 主题词的语言化过滤只对 zh 启用：其它市场规划器可能合法地给拉丁主题词（如 "pumps" 对
  // 日本市场），按语言剥掉会把检索串清空；zh 则必须保留中文主题词（2026-11-06 修复）。
  const topicLanguage = language === 'zh' ? language : undefined;
  const industries = searchableTerms(rawIndustries, topicLanguage).slice(0, 2);
  const keywords = searchableTerms(rawKeywords, topicLanguage).slice(0, 2);
  if (!industries.length && !keywords.length && (rawIndustries.length || rawKeywords.length)) return [];
  // 地区词：zh 市场保留中文地区/国家词（珠三角、中国）；其它语言维持旧行为
  // （中文地区词让位给可写的拉丁国家词或目标国当地名）。
  const region = (language === 'zh' ? searchableTerms(arr(f.region), 'zh')[0] : searchableTerms(arr(f.region))[0])
    ?? (language === 'zh' ? searchableTerms(arr(f.country), 'zh')[0] : searchableTerms(arr(f.country))[0])
    ?? searchCountryName(query);
  const geographyGiven = [...arr(f.region), ...arr(f.country)].some((value) => value.trim().length > 0);
  if (region === undefined && geographyGiven) return [];
  const topic = [...new Set([industries[0] ?? keywords[0] ?? 'manufacturing', ...keywords.slice(0, 1)])]
    .join(' ')
    .trim();

  const localized = DIRECTORY_INTENTS_BY_LANG[language];
  const intents = language === 'zh'
    ? [...DIRECTORY_INTENTS_ZH]
    : localized
      ? [...localized.slice(0, 2), ...DIRECTORY_INTENTS_EN.slice(0, 2)]
      : [...DIRECTORY_INTENTS_EN.slice(0, 2), ...DIRECTORY_INTENTS_DE.slice(0, 2)];

  // 匹配全球 20 个旗舰展会目录（Intersolar / KEY Energy / RE+ / ProPak 等），按目标国优先注入至多 2 条参展商检索
  // 中文国内市场（language === 'zh'）保持纯中文目录意图串，不混入英文展会检索。
  const catalogFairs = language === 'zh'
    ? []
    : selectCatalogFairs({
        industryTerms: [...industries, ...rawIndustries],
        keywords: [...keywords, ...rawKeywords],
        countries: targetCountryCodes(query).map((code) => code.toUpperCase()),
        regions: arr(f.region),
      });
  const fairQueries = catalogFairs
    .slice(0, 2)
    .flatMap((fair) => buildTradeFairSearchQueries(fair, [...keywords, ...industries], 1))
    .slice(0, 2);

  const directoryQueries = intents.map((intent) => [topic, intent, region ?? ''].filter(Boolean).join(' ').trim());
  const searches = fairQueries.length > 0
    ? [...directoryQueries.slice(0, Math.max(2, MAX_DIRECTORY_SEARCHES_PER_QUERY - fairQueries.length)), ...fairQueries]
    : directoryQueries;
  // 去重 + 去过短
  return [...new Set(searches)].filter((q) => q.length > 5).slice(0, MAX_DIRECTORY_SEARCHES_PER_QUERY);
}

function slug(s: string): string {
  const base = s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  const ascii = base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (base === ascii) return ascii.slice(0, 60);
  // 外部 ID 契约是 ASCII（EXTERNAL_ID，raw-source-provider-schema）；中文名保留可读的
  // ASCII 前缀并追加名称哈希——同一公司跨 run/跨页稳定、同前缀中文名不会互相碰撞。
  // （2026-11-06 真实 run：中文名 slug 让 1878 条无 website 的目录记录全部载荷校验被拒。）
  const digest = createHash('sha256').update(s).digest('hex').slice(0, 16);
  const prefix = ascii.slice(0, 40).replace(/-+$/g, '');
  return prefix ? `${prefix}-${digest}` : digest;
}

/** 从当前页文本里找"下一页"链接（同站，含 next/weiter 或数字页码）。 */
function nextPageLink(markdown: string, baseUrl: string): string | null {
  const links = extractSameSiteLinks(markdown, baseUrl);
  const next = links.find((l) => /[?&](page|p|seite|start|offset)=\d+/i.test(l) || /\/(page|seite)\/\d+/i.test(l));
  return next ?? null;
}
