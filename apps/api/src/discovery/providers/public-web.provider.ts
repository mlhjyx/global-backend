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
  ProviderCallUsageBreakdown,
  ProviderCompanyRecord,
  ProviderContactRecord,
  SourceClass,
} from '../provider-contract';
import { ModelGateway } from '../../model-gateway/model-gateway';
import { getTask } from '../../ai-tasks/task-registry';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import type { CrawlResult } from '../../adapters/web-crawler';
import { extractSameSiteLinks } from '../../adapters/site-links';
import { extractPublicContacts } from '../../adapters/contact-extractor';
import { normalizeDomain } from '../identity';
import { executeStructuredTaskWithRuntime } from '../../model-runtime/structured-task-runtime-bridge';
import type { RuntimeTelemetry } from '../../model-runtime/types';
import {
  invokePublicWebSearch,
  resolvePublicWebSearchBackends,
  type PublicWebSearchResult,
  type PublicWebSearchToolId,
} from './public-web-search';
import {
  buildVerifiedCandidateSearchQueries,
  resolveAiCandidateExpansionEnabled,
  type AiCompanyCandidateHypotheses,
} from './public-web-ai-candidates';
import {
  extractDeterministicPublicWebCompany,
  PUBLIC_WEB_DETERMINISTIC_PARSER_VERSION,
} from './public-web-deterministic-company';

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

const MAX_DOMAINS_PER_QUERY = 14; // 每条计划查询最多深挖的候选域名数（控成本/时长）
const CRAWL_CONCURRENCY = 5;

function aggregateUsage(
  entries: readonly ProviderCallUsageBreakdown[],
): ProviderCallUsageBreakdown[] {
  const aggregate = new Map<string, ProviderCallUsageBreakdown>();
  for (const entry of entries) {
    const key = `${entry.phase}\0${entry.backend}`;
    const current = aggregate.get(key);
    if (current) {
      current.callCount += entry.callCount;
      current.completedCount += entry.completedCount;
      current.costCents += entry.costCents;
    } else {
      aggregate.set(key, { ...entry });
    }
  }
  return [...aggregate.values()];
}

/**
 * 真实公开数据挖掘 Provider（PRD 7.4.11 Public Intelligence / DAT-013）。
 * 管线：受治理搜索后端发现候选（默认仅 SearXNG；显式配置后可降级 Serper/Brave）→
 * 噪声域名过滤 + Source Registry SUSPENDED 检查 →
 * Crawl4AI 抓官网 → 同站 schema.org Organization JSON-LD 严格判定 →
 * 带页面指纹的最小企业记录。冲突、缺 URL 或跨站声明一律 fail-closed，不回退模型。
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
  private readonly searchBackends: readonly PublicWebSearchToolId[];
  private readonly aiCandidateExpansionEnabled: boolean;

  constructor(private readonly deps: {
    gateway: ModelGateway;
    broker?: ExecutionBroker;
    runtimeTelemetry?: RuntimeTelemetry;
    searchBackends?: readonly PublicWebSearchToolId[];
    aiCandidateExpansionEnabled?: boolean;
  },
  ) {
    this.searchBackends = deps.searchBackends ?? resolvePublicWebSearchBackends(
      process.env.PUBLIC_WEB_SEARCH_BACKENDS,
    );
    this.aiCandidateExpansionEnabled = deps.aiCandidateExpansionEnabled
      ?? resolveAiCandidateExpansionEnabled(process.env.PUBLIC_WEB_AI_CANDIDATES);
  }

  private log(msg: string): void {

    console.log(`[public_web] ${msg}`);
  }

  /** 工具出网上下文：真租户/run 归属 + taskContractId 绑定（allowedTools 白名单生效点）。 */
  private toolCtx(ctx: ExecutionContext, taskContractId: string): ToolContext {
    return { ...ctx, taskContractId, providerKey: this.key };
  }

  async discoverCompanies(
    query: CompanyDiscoveryQuery,
    ctx: ExecutionContext,
    opts?: DiscoveryOptions,
  ): Promise<DiscoveryResult> {
    // 无闸门 = 不允许原始出网（绝不绕过 ToolBroker）→ 诚实降级空结果。
    if (!this.deps.broker) {
      this.log('skip: broker unavailable (fail-closed, no raw egress)');
      return { records: [], costCents: 0 };
    }
    const blocked = new Set((opts?.blockedDomains ?? []).map((d) => d.toLowerCase()));
    const searches = buildSearchQueries(query);
    if (this.aiCandidateExpansionEnabled) {
      try {
        searches.push(...await this.proposeCandidateSearches(query, ctx));
      } catch (error) {
        // Candidate expansion is optional and can never suppress the bounded,
        // deterministic search path.
        this.log(`AI candidate expansion degraded (${String(error).slice(0, 80)})`);
      }
    }
    const candidates = new Map<string, { url: string; title: string }>(); // domain → first hit
    let costCents = 0;
    const usage: ProviderCallUsageBreakdown[] = [];

    for (const q of searches) {
      const searchResult = await this.search(q, ctx);
      costCents += searchResult.costCents;
      usage.push(...searchResult.usage);
      for (const r of searchResult.results) {
        const domain = normalizeDomain(r.url);
        if (!domain) continue;
        if (NOISE_DOMAINS.some((n) => domain === n || domain.endsWith(`.${n}`))) continue;
        if (blocked.has(domain)) continue;
        if (!candidates.has(domain)) candidates.set(domain, { url: r.url, title: r.title });
      }
    }

    const domains = [...candidates.keys()].slice(0, MAX_DOMAINS_PER_QUERY);
    const records: ProviderCompanyRecord[] = [];

    // 有限并发地：抓首页 → LLM 判站 + 抽取
    for (let i = 0; i < domains.length; i += CRAWL_CONCURRENCY) {
      const batch = domains.slice(i, i + CRAWL_CONCURRENCY);
      const settled = await Promise.allSettled(batch.map((d) => this.mineDomain(d, query, ctx)));
      for (const s of settled) {
        if (s.status !== 'fulfilled') continue;
        costCents += s.value.costCents;
        usage.push(...s.value.usage);
        if (s.value.record) records.push(s.value.record);
      }
    }
    const breakdown = aggregateUsage(usage);
    return {
      records,
      costCents,
      usage: {
        callCount: breakdown.reduce((sum, entry) => sum + entry.callCount, 0),
        breakdown,
      },
    };
  }

  /** 受治理搜索后端；外部 quota 后端只有显式配置后才参与降级。 */
  private async search(q: string, ctx: ExecutionContext): Promise<PublicWebSearchResult> {
    const result = await invokePublicWebSearch(
      this.deps.broker!,
      // Serper's bounded free/BYOK contract rejects `num=20` with HTTP 400 for
      // some valid keys. Ten is accepted across the configured backends and is
      // already sufficient for the downstream 14-domain safety cap.
      { q, language: 'en', count: 10 },
      this.toolCtx(ctx, 'discovery.extract_company'),
      this.searchBackends,
      (toolId, error) => this.log(
        `search backend ${toolId} degraded${error ? ` (${String(error).slice(0, 80)})` : ' (empty)'}`,
      ),
    );
    return result;
  }

  private async proposeCandidateSearches(
    query: CompanyDiscoveryQuery,
    ctx: ExecutionContext,
  ): Promise<string[]> {
    const contract = getTask('discovery.propose_company_candidates');
    if (!contract) return [];
    const result = await executeStructuredTaskWithRuntime<AiCompanyCandidateHypotheses>(
      this.deps.gateway,
      {
        task: contract.id,
        prompt: `候选发现范围：${JSON.stringify({
          sourceClass: query.sourceClass,
          filters: query.filters,
          keywords: query.keywords,
        }).slice(0, 2_000)}`,
        system: contract.description,
        model: contract.model,
        schema: contract.outputSchema,
        maxTokens: 800,
      },
      { ...ctx },
      { telemetry: this.deps.runtimeTelemetry },
    );
    return buildVerifiedCandidateSearchQueries(result.data);
  }

  private async mineDomain(
    domain: string,
    query: CompanyDiscoveryQuery,
    ctx: ExecutionContext,
  ): Promise<{
    record: ProviderCompanyRecord | null;
    costCents: number;
    usage: ProviderCallUsageBreakdown[];
  }> {
    const homeUrl = `https://${domain}/`;
    let html: string;
    let crawlCostCents = 0;
    try {
      const crawled = await this.deps.broker!.invoke<
        { url: string },
        { url: string; html: string; headers: Record<string, string> }
      >(
        'crawl4ai.render',
        { url: homeUrl },
        {
          ...this.toolCtx(ctx, 'discovery.extract_company'),
          purpose: ['discovery', 'enrichment'],
        },
      );
      html = crawled.data.html;
      crawlCostCents = crawled.costCents;
    } catch (err) {
      this.log(`skip ${domain}: crawl failed (${String(err).slice(0, 80)})`);
      return {
        record: null,
        costCents: 0,
        usage: [{
          phase: 'crawl',
          backend: 'crawl4ai.render',
          callCount: 1,
          completedCount: 0,
          costCents: 0,
        }],
      }; // 站点不可达/闸门拒绝 → 放弃该候选
    }
    const crawlUsage: ProviderCallUsageBreakdown[] = [{
      phase: 'crawl',
      backend: 'crawl4ai.render',
      callCount: 1,
      completedCount: 1,
      costCents: crawlCostCents,
    }];
    const organization = extractDeterministicPublicWebCompany(html, domain);
    if (!organization) {
      this.log(`skip ${domain}: no same-site Organization JSON-LD proof`);
      return { record: null, costCents: crawlCostCents, usage: crawlUsage };
    }
    this.log(`✓ ${domain}: ${organization.name} (same-site JSON-LD)`);

    return {
      record: {
        externalId: domain,
        name: organization.name,
        domain,
        country: organization.country,
        attributes: {
          extraction_method: 'jsonld_same_site',
          organization_type: organization.organizationType,
          organization_url: organization.organizationUrl,
          source_class: query.sourceClass,
        },
        provenance: {
          sourceUrl: homeUrl,
          fetchedAt: new Date().toISOString(),
          contentHash: createHash('sha256').update(html).digest('hex'),
          parserVersion: PUBLIC_WEB_DETERMINISTIC_PARSER_VERSION,
        },
      },
      costCents: crawlCostCents,
      usage: crawlUsage,
    };
  }

  // ── 联系人（公开、确定性）────────────────────────────────────────────────

  async discoverContacts(
    company: { name: string; domain?: string },
    ctx: ExecutionContext,
  ): Promise<ContactDiscoveryResult> {
    if (!company.domain) return { contacts: [], costCents: 0 };
    if (!this.deps.broker) return { contacts: [], costCents: 0 }; // fail-closed：无闸门不出网
    const base = `https://${company.domain}/`;
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
        } catch {
          // 单页失败可容忍
        }
      }
    } catch {
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

/** 从计划查询构造 2 条搜索串：结构化过滤词 + 关键词的组合。 */
export function buildSearchQueries(query: CompanyDiscoveryQuery): string[] {
  const f = query.filters ?? {};
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);
  const industries = [...arr(f.industry), ...arr(f.sub_industry)].slice(0, 2);
  const countries = arr(f.country ?? f.region).slice(0, 2);
  const keywords = (query.keywords ?? []).slice(0, 3);

  const q1 = [...industries, ...keywords.slice(0, 2), 'manufacturer company', ...countries.slice(0, 1)]
    .join(' ')
    .trim();
  const q2 = [keywords[2] ?? industries[1] ?? industries[0] ?? 'manufacturing', 'supplier', ...countries.slice(1, 2)]
    .join(' ')
    .trim();
  return [q1, q2].filter((q, i, a) => q.length > 3 && a.indexOf(q) === i);
}
