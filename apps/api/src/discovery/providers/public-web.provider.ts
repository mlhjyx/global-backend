import { createHash } from 'node:crypto';
import { resolveMx } from 'node:dns/promises';
import {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  ContactDiscoveryAdapter,
  ContactDiscoveryResult,
  DiscoveryOptions,
  DiscoveryResult,
  EmailVerdict,
  EmailVerificationAdapter,
  EmailVerifyContext,
  ExecutionContext,
  externalActionAuthorized,
  GENERIC_CONTACT_TITLE,
  ProviderCompanyRecord,
  ProviderContactRecord,
  SourceClass,
} from '../provider-contract';
import { ModelGateway } from '../../model-gateway/model-gateway';
import { getTask } from '../../ai-tasks/task-registry';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import type { SearxngSearchOutput, SearxngSearchResult } from '../../tools/builtin-tools';
import type { CrawlResult } from '../../adapters/web-crawler';
import { extractSameSiteLinks } from '../../adapters/site-links';
import { extractPublicContacts, type PublicContact } from '../../adapters/contact-extractor';
import { cleanEmail } from '../../acquisition/clean';
import { canonicalizeSuppressionValue } from '../suppression-value';
import { isAllowedByRobots } from '../../adapters/robots';
import { normalizeDomain } from '../identity';
import { MAX_PUBLIC_WEB_DOMAINS_PER_QUERY } from '../execution-envelope';
import { isControlledBusinessTerm, isStableSafeHttpsUrl } from '../raw-source-provider-normalizer';
import { COUNTRY_ISO, lookupCountryIso } from '../vocab';
import { sanitizeEvidenceUrl } from '../../site-builder/agents/evidence-ref';
import {
  MAX_SEARCHES_PER_QUERY,
  isForeignCountryDomain,
  searchLanguageFor,
  searchableTerms,
  targetCountryTlds,
  tradeRoleFor,
  tradeRoleTerms,
} from '../search-localization';

export { searchLanguageFor, tradeRoleFor } from '../search-localization';
import {
  executeStructuredTaskWithRuntime,
  type RuntimeStructuredModelResult,
} from '../../model-runtime/structured-task-runtime-bridge';
import type { RuntimeTelemetry } from '../../model-runtime/types';
import { isExecutionControlError } from '../../execution-budget/execution-control-error';
import {
  DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
  buildDiscoveryCompanyResultLineage,
  createDiscoveryCompanyReceiptCollector,
  isDiscoveryCompanyReceiptForwardingFailure,
  isDiscoveryCompanyLineageInvalid,
  type DiscoveryCompanyReceiptCollector,
  type DiscoveryCompanyReceiptObservation,
} from '../company-discovery-lineage';

const PARSER_VERSION = 'public_web/v2-search';

/** 搜索结果里永远不是目标公司官网的域名（词典/百科/社媒/平台市场/招聘站…）。 */
const NOISE_DOMAINS = [
  'wikipedia.org', 'wikidata.org', 'wiktionary.org', 'merriam-webster.com', 'dictionary.com', 'britannica.com',
  'youtube.com', 'facebook.com', 'linkedin.com', 'instagram.com', 'x.com', 'twitter.com',
  'reddit.com', 'quora.com', 'pinterest.com', 'tiktok.com',
  'amazon.com', 'amazon.de', 'ebay.com', 'alibaba.com', 'aliexpress.com', 'made-in-china.com',
  'globalsources.com', 'indiamart.com', 'thomasnet.com', 'yelp.com', 'trustpilot.com',
  'glassdoor.com', 'indeed.com', 'stepstone.de', 'kununu.com',
  'sciencedirect.com', 'researchgate.net', 'springer.com', 'mdpi.com', 'arxiv.org',
  'github.com', 'stackoverflow.com', 'medium.com', 'sciencenotes.org',
  // 大型 SaaS/科技平台产品页 —— 不是 B2B 目标客户
  'google.com', 'withgoogle.com', 'microsoft.com', 'cloud.microsoft', 'apple.com',
  'cloudflare.com', 'baidu.com', 'toutiao.com', 'ensun.io', 'zaixianjisuan.com',
];

const JUDGE_CONCURRENCY = 5;
const MAX_HITS_PER_DOMAIN = 3;
const MAX_SEARCH_EVIDENCE_CHARS = 4_000;
/** Raw governance stores at most 20 products and 20 keywords (TypeScript boundary and database writer alike). */
const MAX_RAW_TERMS = 20;

type SearchHit = Readonly<{ url: string; title: string }>;

export interface ExtractedCompany {
  is_company_site: boolean;
  name?: string;
  country?: string;
  industry?: string;
  employee_count?: number | null;
  products?: string[];
  keywords?: string[];
  evidence?: string;
  confidence?: number;
}

/**
 * 真实公开数据挖掘 Provider（PRD 7.4.11 Public Intelligence / DAT-013）。
 * 发现管线（G3 2026-09-24「搜索优先、建档后再抓」）：SearXNG 元搜索（语言随目标国、
 * 查询串随贸易角色）→ 噪声域名 + 非目标国 ccTLD 过滤 → LLM 仅凭同域名的搜索标题/URL
 * 判站并抽取（只取搜索结果中存在的）→ 带搜索证据指纹的记录。官网页面只在公司建档之后、
 * 以该公司为主体抓取（官网画像富集阶段）。
 *
 * 联系人路径：抓 contact/impressum/about 页 → 确定性正则抽公开邮箱/电话（不做
 * 人名画像 —— 个人数据留给 SourcePolicy/合规门后的版本）；只留公司域名（含子域）上的邮箱，
 * 个人邮箱记它实际所在的页。
 * 邮箱验证：语法 + MX（诚实上限是 RISKY；VALID 需要真正的 SMTP 验证源）。
 */
export class PublicWebDiscoveryProvider
  implements CompanyDiscoveryAdapter, ContactDiscoveryAdapter, EmailVerificationAdapter
{
  readonly key = 'public_web';
  readonly classes: SourceClass[] = ['public_intelligence', 'industry_data'];
  readonly companyResultLineage = DISCOVERY_COMPANY_RESULT_LINEAGE_V1;

  constructor(private readonly deps: {
    gateway: ModelGateway;
    broker?: ExecutionBroker;
    runtimeTelemetry?: RuntimeTelemetry;
  },
  ) {}

  private log(msg: string): void {

    console.log(`[public_web] ${msg}`);
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
          providerKey: 'public_web',
          recordCount: 0,
          observations: [],
        }),
      };
    }
    const blocked = new Set((opts?.blockedDomains ?? []).map((d) => d.toLowerCase()));
    const searches = buildSearchQueries(query);
    const language = searchLanguageFor(query);
    const targetTlds = targetCountryTlds(query);
    // G3（规格 2026-09-24 §3）：搜索优先、建档后再抓——发现阶段只用搜索结果判站，不抓任何页面。
    const candidates = new Map<string, SearchHit[]>(); // domain → 该域名的搜索命中（按出现顺序）

    const perQuery: SearxngSearchResult[][] = [];
    for (const q of searches) perQuery.push(await this.search(q, language, ctx));
    // Round-robin across queries so each role query contributes candidates
    // before the per-query domain cap applies.
    const interleaved: SearxngSearchResult[] = [];
    for (let i = 0; perQuery.some((results) => i < results.length); i += 1) {
      for (const results of perQuery) if (results[i]) interleaved.push(results[i]!);
    }
    for (const r of interleaved) {
      const domain = normalizeDomain(r.url);
      if (!domain) continue;
      if (NOISE_DOMAINS.some((n) => domain === n || domain.endsWith(`.${n}`))) continue;
      if (blocked.has(domain)) continue;
      if (isForeignCountryDomain(domain, targetTlds)) continue;
      const hits = candidates.get(domain) ?? [];
      if (hits.length < MAX_HITS_PER_DOMAIN && !hits.some((h) => h.url === r.url)) {
        hits.push({ url: r.url, title: r.title ?? '' });
      }
      candidates.set(domain, hits);
    }

    const domains = [...candidates.keys()].slice(0, MAX_PUBLIC_WEB_DOMAINS_PER_QUERY);
    const dedup = new Map<string, ProviderCompanyRecord>();
    const observations: DiscoveryCompanyReceiptObservation[] = [];

    // 有限并发地：按搜索命中让 LLM 判站 + 抽取（输入只有标题与 URL：搜索摘要不出 searxng.search，见其持久契约）
    for (let i = 0; i < domains.length; i += JUDGE_CONCURRENCY) {
      const batch = domains.slice(i, i + JUDGE_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((d) => this.mineDomain(d, candidates.get(d) ?? [], query, ctx)),
      );
      for (const s of settled) {
        if (s.status === 'rejected' && isExecutionControlError(s.reason)) throw s.reason;
        if (s.status === 'rejected' && isDiscoveryCompanyReceiptForwardingFailure(s.reason)) throw s.reason;
        if (s.status === 'rejected' && isDiscoveryCompanyLineageInvalid(s.reason)) throw s.reason;
        if (s.status !== 'fulfilled') continue;
        const recordIndexes: number[] = [];
        if (s.value.record) {
          const key = s.value.record.domain ?? s.value.record.externalId;
          if (!dedup.has(key)) {
            recordIndexes.push(dedup.size);
            dedup.set(key, s.value.record);
          }
        }
        if (s.value.collector) {
          observations.push(s.value.collector.finish(recordIndexes));
        }
      }
    }
    const records = [...dedup.values()];
    const lineage = buildDiscoveryCompanyResultLineage({
      providerKey: 'public_web',
      recordCount: records.length,
      observations,
    });
    return {
      records,
      costCents: 0,
      ...(lineage ? { lineage } : {}),
    };
  }

  /** SearXNG 元搜索（经 Broker：searxng.search 工具），语言随目标国。 */
  private async search(
    q: string,
    language: string,
    ctx: ExecutionContext,
  ): Promise<SearxngSearchResult[]> {
    const res = await this.deps.broker!.invoke<{ q: string; language?: string }, SearxngSearchOutput>(
      'searxng.search',
      { q, language },
      this.toolCtx(ctx, 'discovery.extract_company'),
    );
    return res.data.results.slice(0, 20);
  }

  private async mineDomain(
    domain: string,
    hits: readonly SearchHit[],
    query: CompanyDiscoveryQuery,
    ctx: ExecutionContext,
  ): Promise<Readonly<{
    record: ProviderCompanyRecord | null;
    collector?: DiscoveryCompanyReceiptCollector;
  }>> {
    const text = searchEvidenceText(hits);
    if (!text) {
      this.log(`skip ${domain}: no usable search text`);
      return Object.freeze({ record: null });
    }

    const contract = getTask('discovery.extract_company');
    const collector = createDiscoveryCompanyReceiptCollector({
      providerKey: 'public_web',
      producerId: 'discovery.extract_company',
      parentOnDurableReceipt: ctx.onDurableReceipt,
    });
    collector.markExpectedInvocation();
    let result: RuntimeStructuredModelResult<ExtractedCompany>;
    try {
      result = await executeStructuredTaskWithRuntime<ExtractedCompany>(
        this.deps.gateway,
        {
          task: contract?.id ?? 'discovery.extract_company',
          prompt: `目标画像上下文（仅用于判断相关性，禁止照抄进字段）：${JSON.stringify({
            filters: query.filters,
            keywords: query.keywords,
          }).slice(0, 1200)}\n\n搜索结果（同一域名 ${domain}，只含标题与 URL）：\n${text}`,
          system: contract?.description,
          model: contract?.model,
          schema: contract?.outputSchema ?? { required: ['is_company_site'] },
        },
        // 真租户归属（收口②）：ai_trace/usage_ledger 按真实 workspace 记账；runId 供预算归账。
        {
          ...ctx,
          durableResultSchema: 'discovery-extract-company/v1',
          onDurableReceipt: collector.onDurableReceipt,
        },
        { telemetry: this.deps.runtimeTelemetry },
      );
    } catch (error) {
      if (
        collector.isForwardingFailure(error) ||
        isExecutionControlError(error) ||
        isDiscoveryCompanyLineageInvalid(error)
      ) {
        throw error;
      }
      this.log('skip: extract failed (ERROR)');
      return Object.freeze({ record: null, collector });
    }
    const out = result.data;
    // Same normalization as the record: a name of only quotes or trademark signs is no name.
    const name = out?.name ? companyName(out.name) : '';
    if (!out?.is_company_site || !name) {
      this.log(`skip ${domain}: not a company site (llm)`);
      return Object.freeze({ record: null, collector });
    }
    this.log(`✓ ${domain}: ${name}`);

    return Object.freeze({
      record: mapPublicWebCompanyToRecord({
        domain,
        hitUrls: hits.map((hit) => hit.url),
        sourceText: text,
        extracted: out,
        sourceClass: query.sourceClass,
        fetchedAt: new Date().toISOString(),
      }),
      collector,
    });
  }

  // ── 联系人（公开、确定性）────────────────────────────────────────────────

  async discoverContacts(
    company: { name: string; domain?: string },
    ctx: ExecutionContext,
  ): Promise<ContactDiscoveryResult> {
    if (!company.domain) return { contacts: [], costCents: 0 };
    if (!this.deps.broker) return { contacts: [], costCents: 0 }; // fail-closed：无闸门不出网
    const base = `https://${company.domain}/`;
    if (!(await isAllowedByRobots(base, {
        authorizeExternalAction: ctx.authorizeExternalAction,
      }))) return { contacts: [], costCents: 0 };
    const crawl = (url: string) =>
      this.deps.broker!.invoke<{ url: string }, CrawlResult>('crawl4ai.fetch', { url }, {
        // FIX C（Codex P1）：显式用途，防 crawl4ai site_builder 扩宽波及本发现抓取。
        ...this.toolCtx(ctx, 'contact.find_decision_makers'),
        purpose: ['discovery', 'enrichment'],
      },
      );
    const pages: { url: string; text: string }[] = [];
    try {
      const home = await crawl(base);
      pages.push({ url: base, text: home.data.text.slice(0, 40_000) });
      const links = extractSameSiteLinks(home.data.text, base).filter((l) =>
        /contact|kontakt|impressum|imprint|about|legal/i.test(l),
      );
      for (const link of links.slice(0, 2)) {
        try {
          const p = await crawl(link);
          pages.push({ url: link, text: p.data.text.slice(0, 40_000) });
        } catch (error) {
          if (isExecutionControlError(error)) throw error;
          // 单页失败可容忍
        }
      }
    } catch (error) {
      if (isExecutionControlError(error)) throw error;
      return { contacts: [], costCents: 0 };
    }

    const found = extractPublicContacts(pages);
    const emails = found.filter((c) => c.type === 'email');
    const phones = found.filter((c) => c.type === 'phone');
    return { contacts: buildPublicContacts(company.domain, emails, phones[0]?.value), costCents: 0,
    };
  }

  // ── 邮箱验证（语法 + MX；诚实上限 RISKY）─────────────────────────────────

  async verifyEmail(email: string, ctx?: EmailVerifyContext): Promise<EmailVerdict> {
    if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) {
      return { status: 'INVALID', detail: 'syntax', costCents: 0 };
    }
    const domain = email.split('@')[1];
    if (!(await externalActionAuthorized(ctx ?? {}))) {
      return {
        status: 'BLOCKED',
        detail: 'suppression_action_gate',
        costCents: 0,
      };
    }
    try {
      const mx = await resolveMx(domain);
      if (!mx.length) return { status: 'INVALID', detail: 'no MX records', costCents: 0 };
      // 没有 SMTP 级验证源之前，不谎报 VALID —— MX 存在只能说明「可能可达」。
      return { status: 'RISKY', detail: `MX present (${mx[0].exchange}); mailbox unverified`,
        costCents: 0,
      };
    } catch {
      return { status: 'INVALID', detail: 'DNS lookup failed', costCents: 0 };
    }
  }
}

/**
 * One judged company → the record Raw ingestion governs (`validateRawSourceProviderPayload`, then the
 * database writer `write_raw_source_record_v2`). Each value is shaped here so that a real model answer
 * passes that boundary instead of failing it as a whole (discovery run 733fbf03: 21 of 21 rejected):
 * - `domain` (= `externalId`): the suppression canonicalization (lower case, no leading "www.", ASCII form);
 * - `name`: {@link companyName}; `country`: {@link countryIso};
 * - `products` / `keywords`: {@link keepControlledTerms}; `provenance.sourceUrl`: {@link sourcePageUrl}.
 * The free-text `industry` and `evidence` stay on the record: Raw drops the first and stores a digest of the second.
 */
export function mapPublicWebCompanyToRecord(args: {
  domain: string;
  /** URLs of this domain's search hits, in result order. */
  hitUrls: readonly string[];
  sourceText: string;
  extracted: ExtractedCompany;
  sourceClass: SourceClass;
  fetchedAt: string;
}): ProviderCompanyRecord {
  const name = args.extracted.name ? companyName(args.extracted.name) : '';
  if (!name) throw new Error('public web company name is required');
  const domain = canonicalizeSuppressionValue('domain', args.domain) ?? args.domain;
  const employeeCount = args.extracted.employee_count;
  return {
    externalId: domain,
    name,
    domain,
    country: countryIso(args.extracted.country),
    industry: args.extracted.industry || undefined,
    employeeCount:
      typeof employeeCount === 'number' && Number.isSafeInteger(employeeCount) && employeeCount >= 0
        ? employeeCount
        : undefined,
    attributes: {
      products: keepControlledTerms(args.extracted.products),
      keywords: keepControlledTerms(args.extracted.keywords),
      extraction_evidence: args.extracted.evidence ?? null,
      extraction_confidence: args.extracted.confidence ?? null,
      source_class: args.sourceClass,
    },
    provenance: {
      sourceUrl: sourcePageUrl(domain, args.hitUrls),
      fetchedAt: args.fetchedAt,
      contentHash: createHash('sha256').update(args.sourceText).digest('hex'),
      parserVersion: PARSER_VERSION,
    },
  };
}

/** © ® ℠ ™ */
const TRADEMARK_SIGNS = /[\u{a9}\u{ae}\u{2120}\u{2122}]/gu;
/** ` ʻ ʼ ‘ ’ ‚ ‛ ′ (´ is handled before NFKC) */
const APOSTROPHES = /[`\u{2bb}\u{2bc}\u{2018}\u{2019}\u{201a}\u{201b}\u{2032}]/gu;
/** ‐ ‑ ‒ – — ― − */
const DASHES = /[\u{2010}-\u{2015}\u{2212}]/gu;
/** Separators that search titles put between a company name and a slogan: | ¦ · • ‧ ∙ ⋅ */
const TITLE_SEPARATORS = /[|\u{a6}\u{b7}\u{2022}\u{2027}\u{2219}\u{22c5}]/gu;
/** " « » “ ” „ ‟ ‹ › */
const DOUBLE_QUOTES = /["\u{ab}\u{bb}\u{201c}-\u{201f}\u{2039}\u{203a}]/gu;
/** Single quotes around a word or phrase ('Pumpen' GmbH): quotation marks, unlike the apostrophe in O'Brien. */
const QUOTED_PHRASE = /(^|[\s(])'([^']+)'(?=$|[\s),.:/-])/gu;

/**
 * The model's company name as the Raw boundary stores it: NFKC text of letters, digits, spaces and
 * `._+&'(),/#:-`. Typographic apostrophes and dashes become their plain form, and so do the separators of a
 * copied search title ("Pumpen Müller GmbH | Großhandel"); double quotation marks, single quotes around a
 * word, trademark signs and invisible format characters go; "_" becomes a space; white space collapses.
 * A name that still fails, such as one carrying a phone number, an email address or a URL, is not
 * repaired: the boundary rejects it with a value-free receipt.
 */
function companyName(raw: string): string {
  return raw
    // Before NFKC, which spells ™ and ℠ out as "TM" and "SM" and splits ´ into a space and a combining accent.
    .replace(TRADEMARK_SIGNS, '')
    .replace(/\u{b4}/gu, "'")
    .normalize('NFKC')
    .replace(APOSTROPHES, "'")
    .replace(DASHES, '-')
    .replace(TITLE_SEPARATORS, '-')
    .replace(DOUBLE_QUOTES, '')
    .replace(/\p{Cf}/gu, '')
    // The database writer's contact rules read "_" as a word break, so "Pumpen_Secret" must reach the
    // TypeScript boundary as "Pumpen Secret": both then refuse it, instead of the writer raising alone.
    .replace(/_/gu, ' ')
    .replace(QUOTED_PHRASE, '$1$2')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * ISO 3166-1 alpha-2 code of the model's free-text country ("Germany", "Deutschland", "德国" → DE) from the
 * discovery vocabulary; Raw only takes two upper-case letters. An answer that already is one of the
 * vocabulary's codes ("DE", "de") is kept. Anything else ("DACH", "Österreich", "Germany (Bavaria)") is
 * omitted, not guessed.
 */
function countryIso(country: string | undefined): string | undefined {
  const term = country?.trim();
  if (!term) return undefined;
  const code = term.toUpperCase();
  return lookupCountryIso(term) ?? (Object.values(COUNTRY_ISO).includes(code) ? code : undefined);
}

/**
 * Products or keywords as Raw stores them. Raw only accepts terms made entirely of its controlled business
 * vocabulary (`isControlledBusinessTerm`, a data-minimisation control that is not widened here) and rejects
 * the whole record for one other term, so the rest (German product names, "submersible") is dropped here.
 * Words are rejoined with single spaces: "centrifugal-pumps" becomes "centrifugal pumps", and a stray
 * leading or trailing "-" or "_", which the database writer's term check reads as an empty word, goes.
 * Case-insensitive duplicates are dropped; at most 20 terms are kept.
 */
function keepControlledTerms(terms: readonly unknown[] | undefined): string[] {
  const kept = new Map<string, string>();
  for (const term of terms ?? []) {
    if (kept.size === MAX_RAW_TERMS) break;
    if (typeof term !== 'string') continue;
    const words = term.normalize('NFKC').split(/[\s_-]+/u).filter(Boolean).join(' ');
    const key = words.toLowerCase();
    if (!kept.has(key) && isControlledBusinessTerm(words)) kept.set(key, words);
  }
  return [...kept.values()];
}

/**
 * Provenance page of a public_web record. Raw binds its host to `domain` exactly, in the TypeScript
 * boundary and again in the database writer, and `domain` has no leading "www." (normalizeDomain). So the
 * first search hit served from exactly that host is kept; a hit on www.<domain>, on a subdomain or over
 * plain http falls back to the home page https://<domain>/. So does a hit the database might not store
 * ({@link isStorableSourceUrl}): the writer raises on such a URL, quarantined rows included, and the raise
 * aborts the whole query's transaction.
 */
function sourcePageUrl(domain: string, hitUrls: readonly string[]): string {
  for (const hit of hitUrls) {
    const url = provenanceUrl(hit);
    if (url && new URL(url).hostname === domain && isStorableSourceUrl(url)) return url;
  }
  return `https://${domain}/`;
}

/**
 * A source URL that both the TypeScript boundary (`isStableSafeHttpsUrl`) and the database writer
 * (`raw_source_safe_https_url_v2`) store. The database refuses every percent-escape but %20, such as an
 * umlaut path, and its contact rules read "_" as a word break where TypeScript's do not: in
 * `/Kreiselpumpe_SK-40_160` it finds a `sk-` key token that TypeScript misses. Without "%" and "_" the URL
 * is plain ASCII, on which the two sets of rules read alike.
 */
function isStorableSourceUrl(url: string): boolean {
  return isStableSafeHttpsUrl(url) && !/[%_]/u.test(url);
}

/**
 * 从公开邮箱构造联系人记录（纯函数，可测）。只有职能邮箱白名单（`cleanEmail`，与采集清洗、合规门同一份）
 * 里的本地部分（info@、vertrieb@、sales2@ …）算公司联系点：非个人数据，不标 personalData，给通用占位
 * title/department。其余一律按**个人数据**处理（GDPR Art.4）：first.last@ 与 max@、mueller@、mm@ 这类
 * 单名或缩写都可能指向具体的人 → `personalData=true` + `sourcePage`（persistDiscoveredContacts 据此写
 * person.profile 侧写证据）。只有 first.last@ 形反推姓名；其余个人邮箱推不出「名 + 姓」，给占位名
 * 「个人邮箱 (max@)」，否则 email-format-learning 会把邮箱自身反推出的单名学成 `first` 命名法。
 *
 * 只留公司域名或其子域上的邮箱：建站公司、外部数据保护官、gmail 等其他域名的地址不属于这家公司，
 * 直接丢弃、不存。`sourcePage` 是该邮箱实际被抓到的页（常是 Impressum，GDPR Art.14 的来源说明），
 * 按公司来源同一规则去掉账号口令、查询串与片段；说不出来源页的个人邮箱不存。
 * 只首个联系点带电话（与原行为一致）。最多 5 个。
 */
export function buildPublicContacts(
  domain: string,
  emails: ReadonlyArray<Pick<PublicContact, 'value' | 'sourceUrl'>>,
  firstPhone: string | undefined,
): ProviderContactRecord[] {
  const companyDomain = canonicalizeSuppressionValue('domain', domain);
  if (!companyDomain) return [];
  // 先筛后取前 5 个：丢弃的地址不占名额，电话给第一个真正留下的联系点。
  const kept = emails.flatMap((e) => {
    if (!onCompanyDomain(e.value, companyDomain)) return [];
    // 白名单外一律个人：未知的本地部分可能就是人名（max@），保守判 personal。
    const personal = cleanEmail(e.value)?.kind !== 'role';
    const sourcePage = provenanceUrl(e.sourceUrl) ?? undefined;
    // 个人数据要说得出来源页（GDPR Art.14），说不出就不存。
    return personal && !sourcePage ? [] : [{ value: e.value, personal, sourcePage }];
  });
  return kept.slice(0, 5).map(({ value, personal, sourcePage }, i) => {
    const local = value.split('@')[0];
    const nameShaped = /^[a-z]+[._-][a-z]+$/i.test(local);
    const fullName = !personal
      ? `公开联系点 (${local}@)`
      : nameShaped
        ? local
            .split(/[._-]/)
            .map((w) => w[0].toUpperCase() + w.slice(1))
            .join(' ')
        : `个人邮箱 (${local}@)`;
    return {
      externalId: `${domain}:${value}`,
      fullName,
      title: personal ? undefined : GENERIC_CONTACT_TITLE,
      department: personal ? undefined : 'general',
      email: value,
      phone: i === 0 ? firstPhone : undefined,
      // 🔴 具名个人邮箱 = 个人数据（GDPR Art.4）：标记 → 持久化写 person.profile 证据（此前漏标，#58 P2）。
      ...(personal ? { personalData: true, sourcePage } : {}),
    };
  });
}

/**
 * 邮箱是否在公司域名（已规范化）或其子域上。主机名与联系人持久化判域名禁联用同一套规范化
 *（小写、去 www.、国际化域名转 ASCII、去末尾点）；`acme.de.evil.com`、`notacme.de` 都不算。
 */
function onCompanyDomain(email: string, companyDomain: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 1) return false;
  const host = canonicalizeSuppressionValue('domain', email.slice(at + 1));
  return !!host && (host === companyDomain || host.endsWith(`.${companyDomain}`));
}

/** Provenance URL (search hit or crawled contact page): sanitized, without query string or fragment. */
function provenanceUrl(raw: string | undefined): string | null {
  const sanitized = sanitizeEvidenceUrl(raw);
  if (!sanitized) return null;
  const url = new URL(sanitized);
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** 同一域名的搜索命中 → 给模型的证据文本（标题/URL；无标题的命中不算证据）。 */
export function searchEvidenceText(hits: readonly SearchHit[]): string {
  const lines = hits
    .filter((h) => h.title.trim())
    .map((h) => `- 标题：${h.title.trim()}\n  URL：${h.url}`);
  return lines.join('\n').slice(0, MAX_SEARCH_EVIDENCE_CHARS);
}

/**
 * 从计划查询构造 ≤3 条搜索串（G3 §4.3）：品类词 × 目标国语言的贸易角色词
 * （分销商 ICP → Großhandel/Händler/Vertrieb）；角色未知时只用品类词，不再硬加
 * 'manufacturer company'。中文等中日韩文字的词先剔除再取前几个：规划器为词表映射
 * 保留的中文行业词不得进入目标国语言的检索串，全是中文时不发起检索。
 */
export function buildSearchQueries(query: CompanyDiscoveryQuery): string[] {
  const f = query.filters ?? {};
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);
  const industries = searchableTerms([...arr(f.industry), ...arr(f.sub_industry)]).slice(0, 2);
  const products = searchableTerms(arr(f.product)).slice(0, 2);
  const keywords = searchableTerms(query.keywords ?? []).slice(0, 3);
  const terms = [...keywords, ...products, ...industries]
    .map((t) => t.trim())
    .filter((t, i, a) => t.length > 0 && a.indexOf(t) === i);
  if (!terms.length) return [];
  const language = searchLanguageFor(query);
  const roleTerms = tradeRoleTerms(tradeRoleFor(query), language);

  const queries = roleTerms.length
    ? roleTerms.map((role, i) => `${terms[i % terms.length]} ${role}`)
    : [terms.slice(0, 2).join(' '), terms[2] ?? ''];
  return queries
    .map((q) => q.trim())
    .filter((q, i, a) => q.length > 3 && a.indexOf(q) === i)
    .slice(0, MAX_SEARCHES_PER_QUERY);
}
