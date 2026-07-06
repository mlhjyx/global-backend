/**
 * SearXNG 客户端（自托管元搜索，发现层的公共底座）。
 * 用户已在 SearXNG 启用 84 个引擎、覆盖 general/news/map/science/it/social/files
 * 等分类——这个客户端把这些查询能力参数化，供多种发现工具复用。
 *
 * 仅内网调用（limiter off，勿对外暴露）。
 */

export type SearxCategory =
  | 'general'
  | 'news'
  | 'map'
  | 'science'
  | 'it'
  | 'social media'
  | 'files'
  | 'images'
  | 'videos';

export interface SearxQuery {
  q: string;
  categories?: SearxCategory[];
  engines?: string[]; // 指定单/多引擎，如 ['wikidata'] / ['openstreetmap']
  language?: string; // 'en' | 'de' | 'zh' ...
  timeRange?: 'day' | 'week' | 'month' | 'year'; // 新闻信号常用
  pageno?: number;
  safesearch?: 0 | 1 | 2;
}

export interface SearxResult {
  url: string;
  title: string;
  content?: string;
  engine?: string;
  publishedDate?: string | null;
  // wikidata/结构化引擎可能带的附加字段
  attributes?: { label: string; value: string }[];
  latitude?: number;
  longitude?: number;
}

export interface SearxResponse {
  results: SearxResult[];
  suggestions: string[];
  infoboxes: unknown[];
  numberOfResults: number;
}

function baseUrl(): string {
  return process.env.SEARXNG_URL ?? 'http://localhost:8081';
}

/** 一次 SearXNG JSON 搜索。失败抛错（由调用方决定容错）。 */
export async function searxSearch(query: SearxQuery, timeoutMs = 30_000): Promise<SearxResponse> {
  const params = new URLSearchParams({ q: query.q, format: 'json' });
  if (query.categories?.length) params.set('categories', query.categories.join(','));
  if (query.engines?.length) params.set('engines', query.engines.join(','));
  params.set('language', query.language ?? 'en');
  if (query.timeRange) params.set('time_range', query.timeRange);
  if (query.pageno && query.pageno > 1) params.set('pageno', String(query.pageno));
  params.set('safesearch', String(query.safesearch ?? 0));

  const res = await fetch(`${baseUrl()}/search?${params.toString()}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`searxng ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as Partial<SearxResponse> & {
    results?: SearxResult[];
  };
  return {
    results: json.results ?? [],
    suggestions: json.suggestions ?? [],
    infoboxes: json.infoboxes ?? [],
    numberOfResults: json.numberOfResults ?? (json.results?.length ?? 0),
  };
}

/**
 * 便捷：多页拉取（分页），用于需要更多候选的发现查询。
 * pages=2 通常够；每页 SearXNG 已聚合多引擎结果。
 */
export async function searxSearchPaged(query: SearxQuery, pages = 1, timeoutMs = 30_000): Promise<SearxResult[]> {
  const out: SearxResult[] = [];
  const seen = new Set<string>();
  for (let p = 1; p <= pages; p++) {
    let resp: SearxResponse;
    try {
      resp = await searxSearch({ ...query, pageno: p }, timeoutMs);
    } catch {
      break; // 某页失败则停止翻页，返回已得
    }
    for (const r of resp.results) {
      if (!seen.has(r.url)) {
        seen.add(r.url);
        out.push(r);
      }
    }
    if (!resp.results.length) break;
  }
  return out;
}
