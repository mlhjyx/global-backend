import { createHash } from 'node:crypto';
import { resolveMx } from 'node:dns/promises';
import { CompanyEnrichmentAdapter, CompanyEnrichmentInput, EnrichmentResult } from '../provider-contract';
import { crawlHtml } from '../../adapters/web-crawler';
import { isAllowedByRobots } from '../../adapters/robots';

const PARSER_VERSION = 'digital-footprint/v1';

/**
 * 数字足迹指纹 Provider（v3.0 意图/富集层，signal 源 → 只写 attributes，不建 canonical）。
 * 对有官网的公司，从**渲染后的原始 HTML + 响应头**解析六类🟢公司/基础设施事实（无个人数据）：
 *   - 结构化收割：schema.org JSON-LD（Organization 事实 / Product / **JobPosting=招聘信号**）
 *   - 在投广告：Meta/Google Ads/LinkedIn/TikTok 像素（is_advertiser = 市场活跃需求，最高 ROI）
 *   - 技术栈平台：Shopify/Magento/WooCommerce/…（是否在线卖货）
 *   - 服务市场：hreflang → 服务哪些国家/语言
 *   - 邮件商：MX 记录 → Google Workspace / M365 / 自建（规模+定验邮箱策略）
 * 全部零付费、大半零边际成本（复用 discovery/enrich 已抓 HTML；这里独立抓一次以自洽）。
 * 合规：公司/基础设施事实🟢；抓取守 robots（crawl4ai politeness + 本门 robots 校验）。
 */
export class DigitalFootprintProvider implements CompanyEnrichmentAdapter {
  readonly key = 'digital_footprint';

  async enrichCompany(input: CompanyEnrichmentInput): Promise<EnrichmentResult> {
    if (!input.domain) return miss();
    const base = `https://${input.domain}/`;
    if (!(await isAllowedByRobots(base).catch(() => true))) return miss();

    const page = await crawlHtml(base).catch(() => null);
    if (!page) return miss();
    const { html, headers } = page;
    if (html.length < 200) return miss();

    const jsonld = extractJsonLd(html);
    const pixels = detectAdPixels(html);
    const platforms = detectPlatform(html, headers);
    const markets = detectServedMarkets(html);
    const emailProvider = await classifyMxProvider(input.domain).catch(() => undefined);

    const attributes = prune({
      tech_platform: platforms.length ? platforms : undefined,
      ad_pixels: pixels.length ? pixels : undefined,
      is_advertiser: pixels.some((p) => AD_INTENT_PIXELS.has(p)) || undefined,
      served_markets: markets.countries.length ? markets.countries : undefined,
      served_langs: markets.langs.length ? markets.langs : undefined,
      hiring_signal: jsonld.jobPostings.length
        ? { open_roles: jsonld.jobPostings.length, titles: jsonld.jobPostings.slice(0, 8).map((j) => j.title) }
        : undefined,
      structured_org: jsonld.organization,
      structured_products: jsonld.products.length ? jsonld.products.slice(0, 12) : undefined,
      email_provider: emailProvider,
    });
    if (Object.keys(attributes).length === 0) return miss();

    return {
      matched: true,
      confidence: 1,
      attributes,
      provenance: {
        sourceUrl: base,
        fetchedAt: new Date().toISOString(),
        contentHash: createHash('sha256').update(html).digest('hex'),
        parserVersion: PARSER_VERSION,
      },
      costCents: 0,
    };
  }
}

// ─────────────────────── 纯解析器（可测，不触网） ───────────────────────

export interface JsonLdFacts {
  organization?: Record<string, unknown>;
  products: string[];
  jobPostings: { title: string; datePosted?: string }[];
  types: string[];
}

/** 解析页面内所有 schema.org JSON-LD（含 @graph / 数组），抽 Organization/Product/JobPosting。 */
export function extractJsonLd(html: string): JsonLdFacts {
  const out: JsonLdFacts = { products: [], jobPostings: [], types: [] };
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const nodes: Record<string, unknown>[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue; // 跳过畸形 JSON-LD
    }
    const graph =
      Array.isArray(parsed) ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)['@graph'])
        ? ((parsed as Record<string, unknown>)['@graph'] as unknown[])
        : [parsed];
    for (const n of graph) if (n && typeof n === 'object') nodes.push(n as Record<string, unknown>);
  }
  for (const n of nodes) {
    const types = ([] as unknown[]).concat(n['@type'] ?? []).map(String);
    out.types.push(...types);
    if (types.some((t) => /Organization|Corporation|LocalBusiness/i.test(t)) && !out.organization) {
      const addr = n.address as Record<string, unknown> | undefined;
      out.organization = prune({
        name: str(n.name),
        url: str(n.url),
        founding_date: str(n.foundingDate),
        employees: extractNum(n.numberOfEmployees),
        country: str(addr?.addressCountry) ?? undefined,
        same_as: Array.isArray(n.sameAs) ? (n.sameAs as unknown[]).map(String).slice(0, 8) : undefined,
      });
    }
    if (types.some((t) => /^Product$/i.test(t)) && str(n.name)) out.products.push(str(n.name)!.trim());
    if (types.some((t) => /JobPosting/i.test(t)) && str(n.title)) {
      out.jobPostings.push(prune({ title: str(n.title)!.trim(), datePosted: str(n.datePosted) }) as { title: string; datePosted?: string });
    }
  }
  out.products = [...new Set(out.products)].slice(0, 20);
  out.types = [...new Set(out.types)];
  return out;
}

const PIXEL_SIGS: { key: string; re: RegExp }[] = [
  { key: 'meta_pixel', re: /fbq\(|connect\.facebook\.net\/[^"']*fbevents\.js/i },
  { key: 'google_ads', re: /gtag\(\s*['"]event['"]|googleads\.g\.doubleclick|google_conversion|gtag\/js\?id=AW-/i },
  { key: 'google_tag_manager', re: /googletagmanager\.com\/gtm\.js/i },
  { key: 'google_analytics', re: /googletagmanager\.com\/gtag\/js\?id=G-|google-analytics\.com\/(analytics|ga|g\/collect)/i },
  { key: 'linkedin_insight', re: /snap\.licdn\.com|_linkedin_partner_id/i },
  { key: 'tiktok_pixel', re: /analytics\.tiktok\.com|ttq\.(load|page)\(/i },
  { key: 'hubspot', re: /js\.hs-scripts\.com|hs-analytics\.net/i },
];
/** 付费投放型像素（=活跃市场需求信号），区别于纯分析(GA/GTM)。 */
const AD_INTENT_PIXELS = new Set(['meta_pixel', 'google_ads', 'linkedin_insight', 'tiktok_pixel']);

export function detectAdPixels(html: string): string[] {
  return PIXEL_SIGS.filter((s) => s.re.test(html)).map((s) => s.key);
}

const PLATFORM_SIGS: { key: string; re: RegExp }[] = [
  { key: 'shopify', re: /cdn\.shopify\.com|Shopify\.theme|\.myshopify\.com/i },
  { key: 'magento', re: /Magento_|mage\/cookies|\/static\/version\d/i },
  { key: 'woocommerce', re: /woocommerce|wc-ajax|wp-content\/plugins\/woocommerce/i },
  { key: 'wordpress', re: /wp-content|wp-includes/i },
  { key: 'wix', re: /static\.wixstatic\.com|_wix|wix\.com/i },
  { key: 'squarespace', re: /squarespace\.com|static1\.squarespace/i },
  { key: 'hubspot_cms', re: /hs-sites\.com|hubspotusercontent/i },
  { key: 'typo3', re: /typo3temp|\/typo3conf\//i },
];

export function detectPlatform(html: string, headers?: Record<string, string>): string[] {
  const found = new Set<string>();
  for (const s of PLATFORM_SIGS) if (s.re.test(html)) found.add(s.key);
  const hstr = Object.entries(headers ?? {})
    .map(([k, v]) => `${k}:${v}`)
    .join(' ')
    .toLowerCase();
  if (/x-shopify|shopify/.test(hstr)) found.add('shopify');
  if (/x-magento|magento/.test(hstr)) found.add('magento');
  return [...found];
}

export function detectServedMarkets(html: string): { langs: string[]; countries: string[] } {
  const re = /hreflang=["']([a-zA-Z]{2}(?:-[a-zA-Z]{2})?)["']/g;
  const langs = new Set<string>();
  const countries = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const v = m[1].toLowerCase();
    const [lang, country] = v.split('-');
    if (lang) langs.add(lang);
    if (country) countries.add(country.toUpperCase());
  }
  return { langs: [...langs].slice(0, 30), countries: [...countries].slice(0, 60) };
}

/** MX 记录 → 邮件服务商分类（DNS，非 SMTP；出网友好）。 */
export async function classifyMxProvider(domain: string): Promise<string | undefined> {
  let mx: { exchange: string }[];
  try {
    mx = await resolveMx(domain);
  } catch {
    return undefined;
  }
  if (!mx.length) return undefined;
  const hosts = mx.map((r) => r.exchange.toLowerCase()).join(' ');
  if (/aspmx|google|googlemail/.test(hosts)) return 'google_workspace';
  if (/protection\.outlook|outlook|office365/.test(hosts)) return 'microsoft_365';
  if (/pphosted|proofpoint/.test(hosts)) return 'proofpoint';
  if (/mimecast/.test(hosts)) return 'mimecast';
  if (/secureserver\.net/.test(hosts)) return 'godaddy';
  if (/zoho/.test(hosts)) return 'zoho';
  if (/barracuda/.test(hosts)) return 'barracuda';
  return 'other_or_self_hosted';
}

// ─────────────────────── helpers ───────────────────────
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}
function extractNum(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && 'value' in v) return extractNum((v as { value: unknown }).value);
  if (typeof v === 'string') {
    const n = parseInt(v.replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
function prune(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
}
function miss(): EnrichmentResult {
  return { matched: false, confidence: 0, attributes: {}, costCents: 0 };
}
