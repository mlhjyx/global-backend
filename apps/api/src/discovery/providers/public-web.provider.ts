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
import type { SearxResult } from '../../adapters/searxng';
import type { CrawlResult } from '../../adapters/web-crawler';
import { extractSameSiteLinks } from '../../adapters/site-links';
import { extractPublicContacts } from '../../adapters/contact-extractor';
import { isAllowedByRobots } from '../../adapters/robots';
import { normalizeDomain } from '../identity';
import {
  MAX_SEARCHES_PER_QUERY,
  isForeignCountryDomain,
  searchLanguageFor,
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
  'wikipedia.org', 'wiktionary.org', 'merriam-webster.com', 'dictionary.com', 'britannica.com',
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

const MAX_DOMAINS_PER_QUERY = 14; // 每条计划查询最多判定的候选域名数（控成本/时长）
const JUDGE_CONCURRENCY = 5;
const MAX_HITS_PER_DOMAIN = 3;
const MAX_SEARCH_EVIDENCE_CHARS = 4_000;

type SearchHit = Readonly<{ url: string; title: string; content: string }>;

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
 * 查询串随贸易角色）→ 噪声域名 + 非目标国 ccTLD 过滤 → LLM 仅凭同域名的搜索标题/摘要/URL
 * 判站并抽取（只取搜索结果中存在的）→ 带搜索证据指纹的记录。官网页面只在公司建档之后、
 * 以该公司为主体抓取（官网画像富集阶段）。
 *
 * 联系人路径：抓 contact/impressum/about 页 → 确定性正则抽公开邮箱/电话（不做
 * 人名画像 —— 个人数据留给 SourcePolicy/合规门后的版本）。
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

    for (const q of searches) {
      const results = await this.search(q, language, ctx);
      for (const r of results) {
        const domain = normalizeDomain(r.url);
        if (!domain) continue;
        if (NOISE_DOMAINS.some((n) => domain === n || domain.endsWith(`.${n}`))) continue;
        if (blocked.has(domain)) continue;
        if (isForeignCountryDomain(domain, targetTlds)) continue;
        const hits = candidates.get(domain) ?? [];
        if (hits.length < MAX_HITS_PER_DOMAIN && !hits.some((h) => h.url === r.url)) {
          hits.push({ url: r.url, title: r.title ?? '', content: r.content ?? '' });
        }
        candidates.set(domain, hits);
      }
    }

    const domains = [...candidates.keys()].slice(0, MAX_DOMAINS_PER_QUERY);
    const dedup = new Map<string, ProviderCompanyRecord>();
    const observations: DiscoveryCompanyReceiptObservation[] = [];

    // 有限并发地：按搜索命中让 LLM 判站 + 抽取（输入只有标题/摘要/URL）
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
  ): Promise<SearxResult[]> {
    const res = await this.deps.broker!.invoke<{ q: string; language?: string }, { results: SearxResult[] }>(
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
    const homeUrl = `https://${domain}/`;
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
          }).slice(0, 1200)}\n\n搜索结果（同一域名 ${domain}，只含标题、摘要与 URL）：\n${text}`,
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
    if (!out?.is_company_site || !out.name?.trim()) {
      this.log(`skip ${domain}: not a company site (llm)`);
      return Object.freeze({ record: null, collector });
    }
    this.log(`✓ ${domain}: ${out.name}`);

    return Object.freeze({
      record: mapPublicWebCompanyToRecord({
        domain,
        homeUrl: hits[0]?.url ?? homeUrl,
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

export function mapPublicWebCompanyToRecord(args: {
  domain: string;
  homeUrl: string;
  sourceText: string;
  extracted: ExtractedCompany;
  sourceClass: SourceClass;
  fetchedAt: string;
}): ProviderCompanyRecord {
  const name = args.extracted.name?.trim();
  if (!name) throw new Error('public web company name is required');
  return {
    externalId: args.domain,
    name,
    domain: args.domain,
    country: args.extracted.country || undefined,
    industry: args.extracted.industry || undefined,
    employeeCount:
      typeof args.extracted.employee_count === 'number'
        ? args.extracted.employee_count
        : undefined,
    attributes: {
      products: args.extracted.products ?? [],
      keywords: args.extracted.keywords ?? [],
      extraction_evidence: args.extracted.evidence ?? null,
      extraction_confidence: args.extracted.confidence ?? null,
      source_class: args.sourceClass,
    },
    provenance: {
      sourceUrl: args.homeUrl,
      fetchedAt: args.fetchedAt,
      contentHash: createHash('sha256').update(args.sourceText).digest('hex'),
      parserVersion: PARSER_VERSION,
    },
  };
}

/**
 * 从公开邮箱构造联系人记录（纯函数，可测）。`first.last@` 形反推**具名个人** → `personalData=true` +
 * `sourcePage`（GDPR Art.4：persistDiscoveredContacts 据此写 person.profile 侧写证据）；总机/职能邮箱
 * （info@…）非个人数据 → 不标 personalData、给通用占位 title/department（generic 公开联系点）。
 * 只首个联系点带电话（与原行为一致）。最多 5 个。
 */
export function buildPublicContacts(
  domain: string,
  emails: { value: string }[],
  firstPhone: string | undefined,
): ProviderContactRecord[] {
  return emails.slice(0, 5).map((e, i) => {
    const local = e.value.split('@')[0];
    const personal = /^[a-z]+[._-][a-z]+$/i.test(local);
    const fullName = personal
      ? local
          .split(/[._-]/)
          .map((w) => w[0].toUpperCase() + w.slice(1))
          .join(' ')
      : `公开联系点 (${local}@)`;
    return {
      externalId: `${domain}:${e.value}`,
      fullName,
      title: personal ? undefined : GENERIC_CONTACT_TITLE,
      department: personal ? undefined : 'general',
      email: e.value,
      phone: i === 0 ? firstPhone : undefined,
      // 🔴 具名个人邮箱 = 个人数据（GDPR Art.4）：标记 → 持久化写 person.profile 证据（此前漏标，#58 P2）。
      ...(personal ? { personalData: true, sourcePage: `https://${domain}/` } : {}),
    };
  });
}

/** 同一域名的搜索命中 → 给模型的证据文本（标题/摘要/URL；空白命中不算证据）。 */
export function searchEvidenceText(hits: readonly SearchHit[]): string {
  const lines = hits
    .filter((h) => h.title.trim() || h.content.trim())
    .map((h) => `- 标题：${h.title.trim()}\n  摘要：${h.content.trim()}\n  URL：${h.url}`);
  return lines.join('\n').slice(0, MAX_SEARCH_EVIDENCE_CHARS);
}

/**
 * 从计划查询构造 ≤3 条搜索串（G3 §4.3）：品类词 × 目标国语言的贸易角色词
 * （分销商 ICP → Großhandel/Händler/Vertrieb）；角色未知时只用品类词，不再硬加
 * 'manufacturer company'。
 */
export function buildSearchQueries(query: CompanyDiscoveryQuery): string[] {
  const f = query.filters ?? {};
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);
  const industries = [...arr(f.industry), ...arr(f.sub_industry)].slice(0, 2);
  const products = arr(f.product).slice(0, 2);
  const keywords = (query.keywords ?? []).slice(0, 3);
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
