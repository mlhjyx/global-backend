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
  ProviderCompanyRecord,
  SourceClass,
} from '../provider-contract';
import { ModelGateway } from '../../model-gateway/model-gateway';
import { getTask } from '../../ai-tasks/task-registry';
import { crawlUrl } from '../../adapters/web-crawler';
import { extractSameSiteLinks } from '../../adapters/site-links';
import { extractPublicContacts } from '../../adapters/contact-extractor';
import { isAllowedByRobots } from '../../adapters/robots';
import { normalizeDomain } from '../identity';

const PARSER_VERSION = 'public_web/v1';

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

interface ExtractedCompany {
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
 * 管线：SearXNG 元搜索发现候选 → 噪声域名过滤 + Source Registry SUSPENDED 检查 →
 * Crawl4AI 抓官网 → LLM（gemini-2.5-flash）判站并抽取结构化属性（只取文本中存在的）→
 * 带页面指纹的记录。所有值都可回溯到真实抓取的页面（P-04）。
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

  constructor(private readonly deps: { gateway: ModelGateway; searxngUrl?: string }) {}

  private get searxng(): string {
    return this.deps.searxngUrl ?? process.env.SEARXNG_URL ?? 'http://localhost:8081';
  }

  private log(msg: string): void {
     
    console.log(`[public_web] ${msg}`);
  }

  async discoverCompanies(query: CompanyDiscoveryQuery, opts?: DiscoveryOptions): Promise<DiscoveryResult> {
    const blocked = new Set((opts?.blockedDomains ?? []).map((d) => d.toLowerCase()));
    const searches = buildSearchQueries(query);
    const candidates = new Map<string, { url: string; title: string }>(); // domain → first hit

    for (const q of searches) {
      const results = await this.search(q);
      for (const r of results) {
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
      const settled = await Promise.allSettled(batch.map((d) => this.mineDomain(d, query)));
      for (const s of settled) {
        if (s.status === 'fulfilled' && s.value) records.push(s.value);
      }
    }
    return { records, costCents: 0 };
  }

  /** SearXNG JSON 搜索（自托管元搜索，engines 池化降低单引擎被封影响）。 */
  private async search(q: string): Promise<{ url: string; title: string }[]> {
    const url = `${this.searxng}/search?q=${encodeURIComponent(q)}&format=json&language=en&safesearch=0`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`searxng ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { results?: { url: string; title: string }[] };
    return (json.results ?? []).slice(0, 20);
  }

  private async mineDomain(domain: string, query: CompanyDiscoveryQuery): Promise<ProviderCompanyRecord | null> {
    const homeUrl = `https://${domain}/`;
    // 合规闸门（DAT-011）：robots 禁抓则放弃，不换 UA 硬闯
    if (!(await isAllowedByRobots(homeUrl))) {
      this.log(`skip ${domain}: robots disallow`);
      return null;
    }
    let text: string;
    try {
      const crawled = await crawlUrl(homeUrl);
      text = crawled.text.slice(0, 30_000);
    } catch (err) {
      this.log(`skip ${domain}: crawl failed (${String(err).slice(0, 80)})`);
      return null; // 站点不可达 → 放弃该候选
    }
    if (text.trim().length < 200) {
      this.log(`skip ${domain}: too little text (${text.trim().length})`);
      return null;
    }

    const contract = getTask('discovery.extract_company');
    const result = await this.deps.gateway.generateStructured<ExtractedCompany>(
      {
        task: contract?.id ?? 'discovery.extract_company',
        prompt: `目标画像上下文（仅用于判断相关性，禁止照抄进字段）：${JSON.stringify({
          filters: query.filters,
          keywords: query.keywords,
        }).slice(0, 1200)}\n\n网页文本（URL: ${homeUrl}）：\n${text}`,
        system: contract?.description,
        model: contract?.model,
        schema: contract?.outputSchema ?? { required: ['is_company_site'] },
      },
      { workspaceId: 'discovery' }, // trace 维度；RLS 数据写入在活动层完成
    );
    const out = result.data;
    if (!out?.is_company_site || !out.name?.trim()) {
      this.log(`skip ${domain}: not a company site (llm)`);
      return null;
    }
    this.log(`✓ ${domain}: ${out.name}`);

    return {
      externalId: domain,
      name: out.name.trim(),
      domain,
      country: out.country || undefined,
      industry: out.industry || undefined,
      employeeCount: typeof out.employee_count === 'number' ? out.employee_count : undefined,
      attributes: {
        products: out.products ?? [],
        keywords: out.keywords ?? [],
        extraction_evidence: out.evidence ?? null,
        extraction_confidence: out.confidence ?? null,
        source_class: query.sourceClass,
      },
      provenance: {
        sourceUrl: homeUrl,
        fetchedAt: new Date().toISOString(),
        contentHash: createHash('sha256').update(text).digest('hex'),
        parserVersion: PARSER_VERSION,
      },
    };
  }

  // ── 联系人（公开、确定性）────────────────────────────────────────────────

  async discoverContacts(company: { name: string; domain?: string }): Promise<ContactDiscoveryResult> {
    if (!company.domain) return { contacts: [], costCents: 0 };
    const base = `https://${company.domain}/`;
    if (!(await isAllowedByRobots(base))) return { contacts: [], costCents: 0 };
    const pages: { url: string; text: string }[] = [];
    try {
      const home = await crawlUrl(base);
      pages.push({ url: base, text: home.text.slice(0, 40_000) });
      const links = extractSameSiteLinks(home.text, base).filter((l) =>
        /contact|kontakt|impressum|imprint|about|legal/i.test(l),
      );
      for (const link of links.slice(0, 2)) {
        try {
          const p = await crawlUrl(link);
          pages.push({ url: link, text: p.text.slice(0, 40_000) });
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
    const contacts = emails.slice(0, 5).map((e, i) => {
      const local = e.value.split('@')[0];
      const personal = /^[a-z]+[._-][a-z]+$/i.test(local);
      const fullName = personal
        ? local.split(/[._-]/).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
        : `公开联系点 (${local}@)`;
      return {
        externalId: `${company.domain}:${e.value}`,
        fullName,
        title: personal ? undefined : 'switchboard',
        department: personal ? undefined : 'general',
        email: e.value,
        phone: i === 0 ? phones[0]?.value : undefined,
      };
    });
    return { contacts, costCents: 0 };
  }

  // ── 邮箱验证（语法 + MX；诚实上限 RISKY）─────────────────────────────────

  async verifyEmail(email: string): Promise<EmailVerdict> {
    if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) {
      return { status: 'INVALID', detail: 'syntax', costCents: 0 };
    }
    const domain = email.split('@')[1];
    try {
      const mx = await resolveMx(domain);
      if (!mx.length) return { status: 'INVALID', detail: 'no MX records', costCents: 0 };
      // 没有 SMTP 级验证源之前，不谎报 VALID —— MX 存在只能说明「可能可达」。
      return { status: 'RISKY', detail: `MX present (${mx[0].exchange}); mailbox unverified`, costCents: 0 };
    } catch {
      return { status: 'INVALID', detail: 'DNS lookup failed', costCents: 0 };
    }
  }
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
