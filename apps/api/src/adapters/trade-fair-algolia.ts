/**
 * 展会参展商 —— RX(Reed Exhibitions)/Algolia 平台模板。
 * 大展会官网是 JS-SPA，参展商目录由 Algolia 托管搜索驱动；直接打其 public 搜索 API
 * （client-side search-only key，网站本就公开使用）分页取全部参展商结构化 JSON，
 * 绕开 JS 渲染。返回：公司名 / 官网 / 邮箱 / 电话 / 国家 / 展位 / 描述 / 产品。
 *
 * 合规：查询的是展会公开发布、其官网前端同一 public API 暴露的参展商名录（公开商业
 * 信息，非个人数据）；用官方 search-only key、尊重限流、分页有上限。
 *
 * ⚠️ apiKey / eventEditionId / indexName **按届变化**（EuroBLECH 2026 vs 2028）；
 * 换届需重跑网络抓取刷新模板（见 scripts/discover-fair-algolia.mjs 思路：crawl4ai
 * capture_network_requests 抓 *.algolianet.com 请求的 app-id/api-key/index/filter）。
 */

export interface AlgoliaFairConfig {
  appId: string;
  apiKey: string; // public search-only key
  indexName: string;
  eventEditionId: string;
  locale?: string; // 默认 en-gb
}

export interface FairExhibitor {
  externalId: string;
  companyName: string;
  website?: string;
  email?: string;
  phone?: string;
  country?: string;
  stand?: string;
  description?: string;
  products: string[];
  hiring?: boolean;
}

interface AlgoliaHit {
  objectID?: string;
  id?: string;
  companyName?: string;
  exhibitorName?: string;
  website?: string;
  email?: string;
  phone?: string;
  countryName?: string;
  standReference?: string;
  exhibitorDescription?: string;
  products?: { name?: string }[];
  exhibitorFilters?: Record<string, { lvl0?: string[] }>;
}

const ALGOLIA_MAX_PER_PAGE = 1000;

/**
 * 分页拉取一个展会全部（或 limit 上限内）参展商。
 * filters 固定为 recordType:exhibitor + locale + eventEditionId（与官网前端一致）。
 */
export async function queryAlgoliaExhibitors(
  cfg: AlgoliaFairConfig,
  limit = 1000,
): Promise<FairExhibitor[]> {
  const locale = cfg.locale ?? 'en-gb';
  const endpoint =
    `https://${cfg.appId.toLowerCase()}-dsn.algolia.net/1/indexes/${encodeURIComponent(cfg.indexName)}/query` +
    `?x-algolia-application-id=${cfg.appId}&x-algolia-api-key=${cfg.apiKey}`;
  const filters =
    `recordType:exhibitor AND locale:${locale} AND eventEditionId:${cfg.eventEditionId}`;

  const out: FairExhibitor[] = [];
  const seen = new Set<string>();
  const perPage = Math.min(ALGOLIA_MAX_PER_PAGE, limit);
  for (let page = 0; out.length < limit; page++) {
    const params =
      `query=&page=${page}&hitsPerPage=${perPage}` +
      `&filters=${encodeURIComponent(filters)}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: JSON.stringify({ params }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`algolia ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const json = (await res.json()) as { hits?: AlgoliaHit[]; nbPages?: number };
    const hits = json.hits ?? [];
    for (const h of hits) {
      const rec = mapHit(h);
      if (!rec || seen.has(rec.externalId)) continue;
      seen.add(rec.externalId);
      out.push(rec);
      if (out.length >= limit) break;
    }
    if (!hits.length || page + 1 >= (json.nbPages ?? 1)) break;
  }
  return out;
}

function mapHit(h: AlgoliaHit): FairExhibitor | null {
  const companyName = (h.companyName || h.exhibitorName || '').trim();
  const objectID = h.objectID || h.id;
  if (!companyName || !objectID) return null;
  const hiring = Object.values(h.exhibitorFilters ?? {}).some((f) =>
    (f.lvl0 ?? []).some((v) => /hiring|recruit/i.test(v)),
  );
  return {
    externalId: objectID,
    companyName,
    website: h.website || undefined,
    email: h.email || undefined,
    phone: h.phone || undefined,
    country: h.countryName || undefined,
    stand: h.standReference || undefined,
    description: h.exhibitorDescription?.slice(0, 500) || undefined,
    products: (h.products ?? []).map((p) => p.name).filter((n): n is string => !!n).slice(0, 12),
    hiring: hiring || undefined,
  };
}
