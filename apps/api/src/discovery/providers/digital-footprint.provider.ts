import { createHash } from 'node:crypto';
import { resolveMx } from 'node:dns/promises';
import {
  CompanyEnrichmentAdapter,
  CompanyEnrichmentInput,
  EnrichmentResult,
  ExecutionContext,
  externalActionAuthorized,
} from '../provider-contract';
import {
  isTerminalExternalActionPolicyDenied,
  type ExecutionBroker,
  type ToolContext,
} from '../../tools/tool-contract';
import type { HttpGetInput, HttpGetOutput } from '../../tools/source-tools';
import type { CrawlHtmlResult } from '../../adapters/web-crawler';
import { isAllowedByRobots } from '../../adapters/robots';

export const DIGITAL_FOOTPRINT_PARSER_VERSION = 'digital-footprint/v3';

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

  constructor(
    private readonly deps: {
      broker?: ExecutionBroker;
      robotsAllowed?: (
        url: string,
        ctx: ExecutionContext,
      ) => Promise<boolean>;
      sitemapUrls?: (domain: string, ctx: ToolContext) => Promise<string[]>;
    } = {},
  ) {}

  async enrichCompany(input: CompanyEnrichmentInput, ctx: ExecutionContext): Promise<EnrichmentResult> {
    if (!input.domain) return miss();
    // 无闸门 = 不允许原始出网（绝不绕过 ToolBroker）→ 诚实降级 miss（fail-closed）。
    if (!this.deps.broker) {
      console.warn('[digital_footprint] skip: broker unavailable (fail-closed, no raw egress)');
      return miss();
    }
    const base = `https://${input.domain}/`;
    const robotsAllowedFor = async (url: string): Promise<boolean> => {
      try {
        return this.deps.robotsAllowed
          ? await this.deps.robotsAllowed(url, ctx)
          : await isAllowedByRobots(url, {
              authorizeExternalAction: ctx.authorizeExternalAction,
            });
      } catch (error) {
        if (isTerminalExternalActionPolicyDenied(error)) throw error;
        return false;
      }
    };
    // robots 早跳过（robots.ts 有缓存；crawl4ai.render 工具内亦权威强制）
    const robotsAllowed = await robotsAllowedFor(base);
    if (!robotsAllowed)
      return miss();

    const toolCtx: ToolContext = { ...ctx };
    let page: { html: string; headers: Record<string, string>; sourceUrl: string } | null = null;
    try {
      const rendered = await this.deps.broker.invoke<
        { url: string },
        CrawlHtmlResult & { robotsBlocked?: boolean }
      >('crawl4ai.render', { url: base }, toolCtx);
      if (!rendered.data.robotsBlocked) {
        page = {
          html: rendered.data.html,
          headers: rendered.data.headers,
          sourceUrl: rendered.data.url || base,
        };
      }
    } catch (error) {
      if (isTerminalExternalActionPolicyDenied(error)) throw error;
      // 本地渲染器不可用时，仍通过同一 ToolBroker 闸门读静态首页。
      // 这不绕过 robots/SSRF/source policy，只是放弃 JS 渲染能力的有界降级。
      try {
        const fallback = await this.deps.broker.invoke<HttpGetInput, HttpGetOutput>(
          'http.get',
          { url: base, method: 'GET', timeoutMs: 15_000 },
          toolCtx,
        );
        if (fallback.data.ok && !fallback.data.blocked) {
          page = {
            html: fallback.data.text,
            headers: {},
            sourceUrl: fallback.data.finalUrl ?? base,
          };
        }
      } catch (fallbackError) {
        if (isTerminalExternalActionPolicyDenied(fallbackError)) throw fallbackError;
      }
    }
    if (!page || page.html.length < 200) return miss();

    let jsonld = extractJsonLd(page.html);
    if (input.purpose === 'fit_evidence' && jsonld.products.length === 0 && this.deps.sitemapUrls) {
      let sitemapUrls: string[] = [];
      try {
        sitemapUrls = await this.deps.sitemapUrls(input.domain, toolCtx);
      } catch (error) {
        if (isTerminalExternalActionPolicyDenied(error)) throw error;
      }
      for (const productUrl of pickProductPageUrls(sitemapUrls, input.domain).slice(0, 3)) {
        try {
          // robots 规则按 URL path 生效：首页允许并不代表 /products/* 允许。
          // 查询失败也必须 fail closed，绝不能用 http.get 绕过未知/拒绝结论。
          if (!(await robotsAllowedFor(productUrl))) continue;
          const productPage = await this.deps.broker.invoke<HttpGetInput, HttpGetOutput>(
            'http.get',
            { url: productUrl, method: 'GET', timeoutMs: 12_000 },
            toolCtx,
          );
          if (!productPage.data.ok || productPage.data.blocked || productPage.data.text.length < 200) continue;
          const resolvedProductUrl = productPage.data.finalUrl ?? productUrl;
          if (!isSameSitePageUrl(resolvedProductUrl, input.domain)) continue;
          const candidateFacts = extractJsonLd(productPage.data.text);
          if (!candidateFacts.products.length) continue;
          page = {
            html: productPage.data.text,
            headers: {},
            sourceUrl: resolvedProductUrl,
          };
          jsonld = candidateFacts;
          break;
        } catch (error) {
          if (isTerminalExternalActionPolicyDenied(error)) throw error;
        }
      }
    }

    // 资格门前只收业务事实。广告像素、技术栈、MX 都不能冒充产品/工艺证据。
    if (input.purpose === 'fit_evidence') {
      if (!jsonld.products.length) return miss();
      return {
        matched: true,
        confidence: 1,
        attributes: {
          structured_products: jsonld.products.slice(0, 12),
          ...(jsonld.businessModels.length
            ? { business_model: jsonld.businessModels.slice(0, 12) }
            : {}),
          fit_evidence_version: DIGITAL_FOOTPRINT_PARSER_VERSION,
        },
        provenance: {
          sourceUrl: page.sourceUrl,
          fetchedAt: new Date().toISOString(),
          contentHash: createHash('sha256').update(page.html).digest('hex'),
          parserVersion: DIGITAL_FOOTPRINT_PARSER_VERSION,
        },
        costCents: 0,
      };
    }

    const { html, headers } = page;
    const pixels = detectAdPixels(html);
    const platforms = detectPlatform(html, headers);
    const markets = detectServedMarkets(html);
    const emailProvider = await classifyMxProvider(input.domain, ctx).catch(() => undefined);

    const attributes = prune({
      tech_platform: platforms.length ? platforms : undefined,
      ad_pixels: pixels.length ? pixels : undefined,
      is_advertiser: pixels.some((p) => AD_INTENT_PIXELS.has(p)) || undefined,
      served_markets: markets.countries.length ? markets.countries : undefined,
      served_langs: markets.langs.length ? markets.langs : undefined,
      hiring_signal: jsonld.jobPostings.length
        ? {
            open_roles: jsonld.jobPostings.length,
            titles: jsonld.jobPostings.slice(0, 8).map((j) => j.title),
          }
        : undefined,
      structured_org: jsonld.organization,
      structured_products: jsonld.products.length ? jsonld.products.slice(0, 12) : undefined,
      business_model: jsonld.businessModels.length ? jsonld.businessModels.slice(0, 12) : undefined,
      email_provider: emailProvider,
    });
    if (Object.keys(attributes).length === 0) return miss();

    return {
      matched: true,
      confidence: 1,
      attributes,
      provenance: {
        sourceUrl: page.sourceUrl,
        fetchedAt: new Date().toISOString(),
        contentHash: createHash('sha256').update(html).digest('hex'),
        parserVersion: DIGITAL_FOOTPRINT_PARSER_VERSION,
      },
      costCents: 0,
    };
  }
}

// ─────────────────────── 纯解析器（可测，不触网） ───────────────────────

const PRODUCT_PATH_SEGMENTS = new Set([
  'product',
  'products',
  'produkt',
  'produkte',
  'produits',
  'productos',
  'prodotti',
  'catalog',
  'catalogue',
  'portfolio',
  'solution',
  'solutions',
]);
const NON_PRODUCT_PATH_SEGMENTS = new Set([
  'blog',
  'news',
  'career',
  'careers',
  'jobs',
  'category',
  'categories',
  'tag',
  'search',
]);

/** sitemap 只提供候选导航：同站、有具体 slug 的产品/解决方案页才能进入最多 3 页取证。 */
export function pickProductPageUrls(urls: readonly string[], domain: string): string[] {
  const found = new Set<string>();
  const expectedDomain = domain.toLowerCase();
  for (const raw of urls) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (!isSameSitePageUrl(parsed.toString(), expectedDomain)) continue;
    const segments = parsed.pathname.split('/').filter(Boolean).map((segment) => segment.toLowerCase());
    if (segments.some((segment) => NON_PRODUCT_PATH_SEGMENTS.has(segment))) continue;
    const marker = segments.findIndex((segment) => PRODUCT_PATH_SEGMENTS.has(segment));
    if (marker < 0 || marker >= segments.length - 1) continue;
    if (/\.(?:xml|pdf|jpe?g|png|gif|webp|svg|zip)$/iu.test(parsed.pathname)) continue;
    parsed.hash = '';
    parsed.search = '';
    found.add(parsed.toString());
  }
  return [...found];
}

function isSameSitePageUrl(raw: string, domain: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    const expectedDomain = domain.toLowerCase();
    if (host !== expectedDomain && !host.endsWith(`.${expectedDomain}`)) return false;
    return !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) && !host.includes(':');
  } catch {
    return false;
  }
}

export interface JsonLdFacts {
  organization?: Record<string, unknown>;
  products: string[];
  businessModels: string[];
  jobPostings: { title: string; datePosted?: string }[];
  types: string[];
}

/** 解析页面内所有 schema.org JSON-LD（含 @graph / 数组），抽 Organization/Product/JobPosting。 */
export function extractJsonLd(html: string): JsonLdFacts {
  const out: JsonLdFacts = { products: [], businessModels: [], jobPostings: [], types: [] };
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
    const graph = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)['@graph'])
        ? ((parsed as Record<string, unknown>)['@graph'] as unknown[])
        : [parsed];
    for (const n of graph) if (n && typeof n === 'object') nodes.push(n as Record<string, unknown>);
  }
  const nodesById = new Map<string, Record<string, unknown>>();
  for (const node of nodes) {
    const id = str(node['@id']);
    if (id && !nodesById.has(id)) nodesById.set(id, node);
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
    if (types.some((t) => /^Product$/i.test(t)) && str(n.name)) {
      out.products.push(str(n.name)!.trim());
      for (const name of entityNames(n.manufacturer, nodesById)) {
        out.businessModels.push(`manufacturer:${name}`);
      }
      for (const name of entityNames(n.seller, nodesById)) {
        out.businessModels.push(`seller:${name}`);
      }
      let hasExplicitOffer = false;
      for (const rawOffer of asArray(n.offers)) {
        const offer = resolveSchemaNode(rawOffer, nodesById);
        if (!offer) continue;
        const offerTypes = asArray(offer['@type']).map(String);
        if (!offerTypes.some((type) => /^(?:Offer|AggregateOffer)$/iu.test(type))) continue;
        hasExplicitOffer = true;
        for (const name of entityNames(offer.seller, nodesById)) {
          out.businessModels.push(`seller:${name}`);
        }
      }
      if (hasExplicitOffer) out.businessModels.push('official_product_offer');
    }
    if (types.some((t) => /JobPosting/i.test(t)) && str(n.title)) {
      out.jobPostings.push(
        prune({
          title: str(n.title)!.trim(),
          datePosted: str(n.datePosted),
        }) as { title: string; datePosted?: string },
      );
    }
  }
  out.products = [...new Set(out.products)].slice(0, 20);
  out.businessModels = [...new Set(out.businessModels)].slice(0, 20);
  out.types = [...new Set(out.types)];
  return out;
}

function asArray(value: unknown): unknown[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function resolveSchemaNode(
  value: unknown,
  nodesById: ReadonlyMap<string, Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const node = value as Record<string, unknown>;
  const id = str(node['@id']);
  return (id ? nodesById.get(id) : undefined) ?? node;
}

function entityNames(
  value: unknown,
  nodesById: ReadonlyMap<string, Record<string, unknown>>,
): string[] {
  const names = new Set<string>();
  for (const raw of asArray(value)) {
    const direct = str(raw);
    const node = resolveSchemaNode(raw, nodesById);
    const candidate = direct ?? str(node?.name);
    if (!candidate || /^https?:\/\//iu.test(candidate)) continue;
    names.add(candidate.trim().slice(0, 240));
  }
  return [...names];
}

const PIXEL_SIGS: { key: string; re: RegExp }[] = [
  {
    key: 'meta_pixel',
    re: /fbq\(|connect\.facebook\.net\/[^"']*fbevents\.js/i,
  },
  {
    key: 'google_ads',
    re: /gtag\(\s*['"]event['"]|googleads\.g\.doubleclick|google_conversion|gtag\/js\?id=AW-/i,
  },
  { key: 'google_tag_manager', re: /googletagmanager\.com\/gtm\.js/i },
  {
    key: 'google_analytics',
    re: /googletagmanager\.com\/gtag\/js\?id=G-|google-analytics\.com\/(analytics|ga|g\/collect)/i,
  },
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
  {
    key: 'woocommerce',
    re: /woocommerce|wc-ajax|wp-content\/plugins\/woocommerce/i,
  },
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

export function detectServedMarkets(html: string): {
  langs: string[];
  countries: string[];
} {
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
  return {
    langs: [...langs].slice(0, 30),
    countries: [...countries].slice(0, 60),
  };
}

/** MX 记录 → 邮件服务商分类（DNS，非 SMTP；出网友好）。DNS 解析是 Broker 登记例外，保留直连。 */
export async function classifyMxProvider(
  domain: string,
  ctx: Pick<ExecutionContext, 'authorizeExternalAction'> = {},
): Promise<string | undefined> {
  let mx: { exchange: string }[];
  try {
    if (!(await externalActionAuthorized(ctx))) return undefined;
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
