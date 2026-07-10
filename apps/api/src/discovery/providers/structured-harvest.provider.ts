import { createHash } from 'node:crypto';
import {
  CompanyEnrichmentAdapter,
  CompanyEnrichmentInput,
  EnrichmentResult,
  ExecutionContext,
} from '../provider-contract';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import type { CrawlHtmlResult } from '../../adapters/web-crawler';
import type { HttpGetInput, HttpGetOutput } from '../../tools/source-tools';
import { isAllowedByRobots } from '../../adapters/robots';
import { extractJsonLd } from './digital-footprint.provider';

const PARSER_VERSION = 'structured-harvest/v1';
const MAX_CHILD_SITEMAPS = 3;
const MAX_URLS = 5000;

/**
 * 结构化收割 Provider（v3.0 P0，signal 源，零付费）。发布者主动供机器消费的公开数据面，
 * 比逆向隐藏 API 更干净🟢。用 sitemap.xml 盘点站点结构、定位 careers 页 → 抓 **JobPosting
 * JSON-LD = 招聘信号**（"现在需要什么"的核心意图），并标注是否在招**采购/sourcing 岗**
 * （= 买家团队扩张，强 timing 信号）。写 attributes.structured_harvest.*。
 * 合规：sitemap 是 robots.txt 主动广告的公开协议数据🟢；抓 careers 页守 robots。
 */
export class StructuredHarvestProvider implements CompanyEnrichmentAdapter {
  readonly key = 'structured_harvest';

  constructor(private readonly deps: { broker?: ExecutionBroker } = {}) {}

  async enrichCompany(input: CompanyEnrichmentInput, ctx: ExecutionContext): Promise<EnrichmentResult> {
    if (!input.domain) return miss();
    // 无闸门 = 不允许原始出网（绝不绕过 ToolBroker）→ 诚实降级 miss（fail-closed）。
    if (!this.deps.broker) {
      console.warn('[structured_harvest] skip: broker unavailable (fail-closed, no raw egress)');
      return miss();
    }
    const broker = this.deps.broker;
    const toolCtx: ToolContext = { workspaceId: ctx.workspaceId, runId: ctx.runId, correlationId: ctx.correlationId };
    const httpGet: HttpGetFn = async (req) => (await broker.invoke<HttpGetInput, HttpGetOutput>('http.get', req, toolCtx)).data;

    const urls = await fetchSitemapUrls(input.domain, httpGet).catch(() => [] as string[]);
    const sections = tallySections(urls);
    const careersUrl = pickCareersUrl(urls) ?? (await probeCommonCareersPath(input.domain, httpGet));

    let hiring: Record<string, unknown> | undefined;
    // ① 优先：sitemap 里的职位详情 URL（把职位放进 sitemap 的公司直接可数，无需 JS 渲染）
    const jobUrls = pickJobDetailUrls(urls);
    if (jobUrls.length) {
      const titles = jobUrls.map(slugToTitle).filter((t) => t.length > 2);
      hiring = {
        source: 'sitemap',
        open_roles: jobUrls.length,
        titles: [...new Set(titles)].slice(0, 12),
        has_buying_role: titles.some(isBuyingRole),
      };
    } else if (careersUrl && (await isAllowedByRobots(careersUrl).catch(() => true))) {
      // ② 兜底：抓 careers 落地页取 JobPosting JSON-LD（若有；robots 亦在 crawl4ai.render 工具内权威强制）
      try {
        const page = await broker.invoke<{ url: string }, CrawlHtmlResult & { robotsBlocked?: boolean }>(
          'crawl4ai.render',
          { url: careersUrl },
          toolCtx,
        );
        const jobs = page.data.robotsBlocked ? [] : extractJsonLd(page.data.html).jobPostings;
        if (jobs.length) {
          const titles = jobs.map((j) => j.title);
          hiring = {
            source: careersUrl,
            open_roles: titles.length,
            titles: titles.slice(0, 12),
            has_buying_role: titles.some(isBuyingRole),
          };
        }
      } catch {
        // careers 抓取失败不致命
      }
    }

    const attributes = prune({
      sitemap_url_count: urls.length || undefined,
      site_sections: Object.keys(sections).length ? sections : undefined,
      careers_url: careersUrl,
      hiring_signal: hiring,
    });
    if (Object.keys(attributes).length === 0) return miss();

    return {
      matched: true,
      confidence: 1,
      attributes,
      provenance: {
        sourceUrl: careersUrl ?? `https://${input.domain}/sitemap.xml`,
        fetchedAt: new Date().toISOString(),
        contentHash: createHash('sha256').update(urls.join('\n')).digest('hex'),
        parserVersion: PARSER_VERSION,
      },
      costCents: 0,
    };
  }
}

// ─────────────────────── 纯解析器（可测，不触网） ───────────────────────

/** 解析 sitemap XML：返回 <loc>（普通 sitemap）或子 sitemap 链接（sitemap index）。 */
export function parseSitemapXml(xml: string): { locs: string[]; isIndex: boolean } {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const locs: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) locs.push(m[1].trim());
  return { locs, isIndex };
}

const CAREERS_RE = /career|careers|jobs?|stellen|stellenangebote|karriere|vacanc|join-?us|working-?at|emplo|recruit/i;

/** 从 URL 清单挑最像"招聘/职业"的页面（路径命中招聘词，短路径优先）。 */
export function pickCareersUrl(urls: string[]): string | undefined {
  const hits = urls
    .filter((u) => CAREERS_RE.test(pathOf(u)))
    .sort((a, b) => pathOf(a).length - pathOf(b).length);
  return hits[0];
}

/** 按 URL 一级路径段盘点站点区块（产品/关于/新闻/招聘/…），产出「站点结构」画像。 */
export function tallySections(urls: string[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const u of urls) {
    const seg = pathOf(u).split('/').filter(Boolean)[0]?.toLowerCase();
    if (!seg || seg.length > 24) continue;
    tally[seg] = (tally[seg] ?? 0) + 1;
  }
  // 只留计数靠前的段，避免噪声
  return Object.fromEntries(
    Object.entries(tally)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20),
  );
}

// 职位详情 URL：招聘路径下带具体岗位 slug（≥4 字符 slug，排除落地页本身）
const JOB_DETAIL_RE = /\/(jobs?|stellen(?:angebot(?:e)?)?|vacanc(?:y|ies)|positions?|openings?|karriere)\/[a-z0-9][a-z0-9/_-]{4,}/i;

/** 从 URL 清单挑职位详情页（= 开放岗位）。 */
export function pickJobDetailUrls(urls: string[]): string[] {
  return urls.filter((u) => JOB_DETAIL_RE.test(pathOf(u))).slice(0, 300);
}

/** URL 末段 slug → 可读岗位名（best-effort）。 */
export function slugToTitle(u: string): string {
  const seg = pathOf(u).split('/').filter(Boolean).pop() ?? '';
  return seg
    .replace(/\.\w+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\d{3,}\b/g, '')
    .trim();
}

const BUYING_ROLE_RE =
  /procure|purchas|sourcing|buyer|supply-?chain|category manager|eink(?:a|ä|ae)uf|beschaffung|acquist|approvvigion|achats|compras/i;

/** 招聘岗位是否为采购/供应链角色（= 买家团队扩张，强 timing 信号）。 */
export function isBuyingRole(title: string): boolean {
  return BUYING_ROLE_RE.test(title);
}

// ─────────────────────── 触网取数（sitemap/robots.txt/careers 探测，一律经 http.get 工具） ───────────────────────

/** 出网函数：由 provider 用 ExecutionBroker 绑定到 http.get 工具（SSRF 公网解析护栏在工具内权威强制）。 */
export type HttpGetFn = (input: HttpGetInput) => Promise<HttpGetOutput>;

/** 取域名的 sitemap URL 全集：robots.txt 的 Sitemap: 指令 + /sitemap.xml + /sitemap_index.xml，
 *  遇 sitemap index 再取前若干子 sitemap。总量与子表数有上限。 */
export async function fetchSitemapUrls(domain: string, httpGet: HttpGetFn): Promise<string[]> {
  const roots = new Set<string>();
  for (const line of (await fetchText(`https://${domain}/robots.txt`, httpGet).catch(() => '')).split('\n')) {
    const m = line.match(/^\s*sitemap:\s*(\S+)/i);
    if (m) roots.add(m[1].trim());
  }
  roots.add(`https://${domain}/sitemap.xml`);
  roots.add(`https://${domain}/sitemap_index.xml`);

  const out: string[] = [];
  let childBudget = MAX_CHILD_SITEMAPS;
  for (const root of roots) {
    if (out.length >= MAX_URLS) break;
    // robots.txt 广告的 Sitemap: / sitemap-index 的 <loc> 可能是任意 URL → 只收同注册域
    //（业务归属规则，留在 provider 侧；私网/SSRF 拦截由 http.get 工具权威强制）
    if (!isSameSiteUrl(root, domain)) continue;
    const xml = await fetchText(root, httpGet).catch(() => '');
    if (!xml) continue;
    const { locs, isIndex } = parseSitemapXml(xml);
    if (isIndex) {
      for (const child of locs) {
        if (childBudget-- <= 0 || out.length >= MAX_URLS) break;
        if (!isSameSiteUrl(child, domain)) continue;
        const childXml = await fetchText(child, httpGet).catch(() => '');
        out.push(...parseSitemapXml(childXml).locs);
      }
    } else {
      out.push(...locs);
    }
  }
  return [...new Set(out)].slice(0, MAX_URLS);
}

/** 「同站」业务校验：URL 必须 http(s)、同注册域(含子域)、非 IP 字面量——确保采到的数据归属目标公司域。
 *  （私网/云元数据 IP 的 SSRF 拦截已在 http.get 工具内权威强制，不在此重复 DNS 解析。） */
function isSameSiteUrl(raw: string, domain: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  const d = domain.toLowerCase();
  if (host !== d && !host.endsWith(`.${d}`)) return false; // 只允许同注册域(含子域)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return false; // 拒 IP 字面量
  return true;
}

/** 常见 careers 固定路径兜底（sitemap 无命中时；HEAD 探测经 http.get 工具）。
 *  返回重定向后**最终落地 URL**（与原实现语义一致——证据记录真实入口）；跳出注册域退回探测路径。 */
export async function probeCommonCareersPath(domain: string, httpGet: HttpGetFn): Promise<string | undefined> {
  for (const p of ['/careers', '/en/careers', '/career', '/jobs', '/karriere', '/company/careers']) {
    const u = `https://${domain}${p}`;
    try {
      const res = await httpGet({ url: u, method: 'HEAD', timeoutMs: 8000 });
      if (res.ok) return res.finalUrl && isSameSiteUrl(res.finalUrl, domain) ? res.finalUrl : u;
    } catch {
      // 试下一个
    }
  }
  return undefined;
}

async function fetchText(url: string, httpGet: HttpGetFn): Promise<string> {
  const res = await httpGet({ url, timeoutMs: 12_000 });
  // blocked = SSRF 护栏拦截（未出网）；非 ok 与原 fetch 失败路径同义 → 抛错交由调用方 catch 降级。
  if (res.blocked || !res.ok) throw new Error(`http.get ${res.blocked ?? res.status}`);
  return res.text;
}

// ─────────────────────── helpers ───────────────────────
function pathOf(u: string): string {
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
}
function prune(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
}
function miss(): EnrichmentResult {
  return { matched: false, confidence: 0, attributes: {}, costCents: 0 };
}
