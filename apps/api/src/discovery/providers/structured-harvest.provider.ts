import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { CompanyEnrichmentAdapter, CompanyEnrichmentInput, EnrichmentResult } from '../provider-contract';
import { crawlHtml } from '../../adapters/web-crawler';
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

  async enrichCompany(input: CompanyEnrichmentInput): Promise<EnrichmentResult> {
    if (!input.domain) return miss();

    const urls = await fetchSitemapUrls(input.domain).catch(() => [] as string[]);
    const sections = tallySections(urls);
    const careersUrl = pickCareersUrl(urls) ?? (await probeCommonCareersPath(input.domain));

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
      // ② 兜底：抓 careers 落地页取 JobPosting JSON-LD（若有）
      try {
        const jobs = extractJsonLd((await crawlHtml(careersUrl)).html).jobPostings;
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

// ─────────────────────── 触网取数（sitemap/robots，普通 fetch，快） ───────────────────────

/** 取域名的 sitemap URL 全集：robots.txt 的 Sitemap: 指令 + /sitemap.xml + /sitemap_index.xml，
 *  遇 sitemap index 再取前若干子 sitemap；支持 .gz。总量与子表数有上限。 */
export async function fetchSitemapUrls(domain: string): Promise<string[]> {
  const roots = new Set<string>();
  for (const line of (await fetchText(`https://${domain}/robots.txt`).catch(() => '')).split('\n')) {
    const m = line.match(/^\s*sitemap:\s*(\S+)/i);
    if (m) roots.add(m[1].trim());
  }
  roots.add(`https://${domain}/sitemap.xml`);
  roots.add(`https://${domain}/sitemap_index.xml`);

  const out: string[] = [];
  let childBudget = MAX_CHILD_SITEMAPS;
  for (const root of roots) {
    if (out.length >= MAX_URLS) break;
    const xml = await fetchText(root).catch(() => '');
    if (!xml) continue;
    const { locs, isIndex } = parseSitemapXml(xml);
    if (isIndex) {
      for (const child of locs) {
        if (childBudget-- <= 0 || out.length >= MAX_URLS) break;
        const childXml = await fetchText(child).catch(() => '');
        out.push(...parseSitemapXml(childXml).locs);
      }
    } else {
      out.push(...locs);
    }
  }
  return [...new Set(out)].slice(0, MAX_URLS);
}

/** 常见 careers 固定路径兜底（sitemap 无命中时）。 */
export async function probeCommonCareersPath(domain: string): Promise<string | undefined> {
  for (const p of ['/careers', '/en/careers', '/career', '/jobs', '/karriere', '/company/careers']) {
    const u = `https://${domain}${p}`;
    try {
      const res = await fetch(u, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) });
      if (res.ok) return res.url || u;
    } catch {
      // 试下一个
    }
  }
  return undefined;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GlobalBot/1.0)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // gzip 魔数 → 解压（.xml.gz sitemap 常见）
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf).toString('utf8');
  return buf.toString('utf8');
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
