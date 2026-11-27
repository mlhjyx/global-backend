/**
 * SearXNG 客户端（自托管元搜索，发现层的公共底座）。
 * 用户已在 SearXNG 启用 84 个引擎、覆盖 general/news/map/science/it/social/files
 * 等分类——这个客户端把这些查询能力参数化，供多种发现工具复用。
 *
 * 仅内网调用（limiter off，勿对外暴露）。
 */

import { lookup } from 'node:dns/promises';
import { requestDiscoverySourceJson, type DiscoverySourceDispatch } from './discovery-v3-source-http';
import type { ResolvedAddress } from './net-guard';

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

import {
  positiveIntEnv,
  TenantConcurrencySemaphore,
} from '../runtime/tenant-concurrency-semaphore';

let searxngSemaphore: TenantConcurrencySemaphore | undefined;

export function getSearxngTenantSemaphore(): TenantConcurrencySemaphore {
  searxngSemaphore ??= new TenantConcurrencySemaphore({
    name: 'searxng',
    perTenantLimit: positiveIntEnv(process.env, 'SEARXNG_MAX_CONCURRENT_PER_TENANT', 4, 32),
    globalLimit: positiveIntEnv(process.env, 'SEARXNG_MAX_CONCURRENT_GLOBAL', 16, 128),
    acquireTimeoutMs: 30_000,
  });
  return searxngSemaphore;
}

function baseUrl(): string {
  return process.env.SEARXNG_URL ?? 'http://localhost:8081';
}

function searchParams(query: SearxQuery): URLSearchParams {
  const params = new URLSearchParams({ q: query.q, format: 'json' });
  if (query.categories?.length) params.set('categories', query.categories.join(','));
  if (query.engines?.length) params.set('engines', query.engines.join(','));
  params.set('language', query.language ?? 'en');
  if (query.timeRange) params.set('time_range', query.timeRange);
  if (query.pageno && query.pageno > 1) params.set('pageno', String(query.pageno));
  params.set('safesearch', String(query.safesearch ?? 0));
  return params;
}

/** 一次 SearXNG JSON 搜索。失败抛错（由调用方决定容错）。 */
export async function searxSearch(
  query: SearxQuery,
  timeoutMs = 30_000,
  workspaceId?: string,
  semaphore: TenantConcurrencySemaphore = getSearxngTenantSemaphore(),
): Promise<SearxResponse> {
  const params = searchParams(query);

  return semaphore.withTenantSlot(workspaceId, async () => {
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
  });
}

export const SEARXNG_NATIVE_TIMEOUT_MS = 30_000;

/** Fetch an explicit page through the fixed, operator-configured SearXNG service. */
export async function searxSearchPageNative(
  query: SearxQuery,
  workspaceId: string,
  dispatch: DiscoverySourceDispatch,
): Promise<SearxResult[]> {
  const page = query.pageno ?? 1;
  if (!query.q.trim() || query.q.length > 1_000 || !Number.isSafeInteger(page) || page < 1 || page > 20) {
    throw new Error('SEARXNG_NATIVE_QUERY_INVALID');
  }
  const endpoint = new URL(baseUrl());
  if ((endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || endpoint.hostname.startsWith('[')) {
    throw new Error('SEARXNG_NATIVE_ENDPOINT_INVALID');
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, '')}/search`;
  endpoint.search = searchParams(query).toString();
  return getSearxngTenantSemaphore().withTenantSlot(workspaceId, async () => {
    const json = await requestDiscoverySourceJson<Partial<SearxResponse>>(endpoint, {
      source: 'SEARXNG', timeoutMs: SEARXNG_NATIVE_TIMEOUT_MS, headers: { Accept: 'application/json' },
    }, dispatch, async (url) => {
      // The private endpoint is deployment configuration. Query input contributes only URL parameters.
      if (url !== endpoint.href) throw new Error('SEARXNG_NATIVE_ENDPOINT_INVALID');
      const resolved = await lookup(endpoint.hostname, { all: true, verbatim: true });
      const addresses = resolved.flatMap<ResolvedAddress>(({ address, family }) => family === 4 || family === 6
        ? [{ address, family }] : []);
      const pin = addresses[0];
      if (!pin) throw new Error('SEARXNG_NATIVE_ENDPOINT_UNRESOLVED');
      return { url: endpoint, addresses, ip: pin.address, family: pin.family };
    });
    if (!Array.isArray(json.results)) throw new Error('SEARXNG_NATIVE_RESPONSE_INVALID');
    const seen = new Set<string>();
    return json.results.filter((result) => {
      if (typeof result?.url !== 'string' || seen.has(result.url)) return false;
      seen.add(result.url);
      return true;
    });
  });
}

import {
  classifySearxngCooldownReason,
  executeWithSearxngFallback,
  type SearxngFallbackDeps,
  type SearxngFallbackResult,
} from './searxng-fallback';

/**
 * 便捷：多页拉取（分页），用于需要更多候选的发现查询。
 * pages=2 通常够；每页 SearXNG 已聚合多引擎结果。
 * 首页触发 403/429/5xx 限流或封禁错误时显式抛出，便于上层冷却切换至 Serper/Exa；
 * 后续翻页失败保持返回已得结果的容错语义。
 */
export async function searxSearchPaged(
  query: SearxQuery,
  pages = 1,
  timeoutMs = 30_000,
  workspaceId?: string,
): Promise<SearxResult[]> {
  const out: SearxResult[] = [];
  const seen = new Set<string>();
  for (let p = 1; p <= pages; p++) {
    let resp: SearxResponse;
    try {
      resp = await searxSearch({ ...query, pageno: p }, timeoutMs, workspaceId);
    } catch (error) {
      if (p === 1 && out.length === 0 && classifySearxngCooldownReason(error) !== null) {
        throw error;
      }
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

/** 带 403/429 冷却与 Serper/Exa 自动兜底的分页搜索入口。 */
export async function searxSearchPagedWithFallback(
  query: SearxQuery,
  pages = 1,
  timeoutMs = 30_000,
  deps: SearxngFallbackDeps = {},
): Promise<SearxngFallbackResult> {
  return executeWithSearxngFallback(
    () => searxSearchPaged(query, pages, timeoutMs),
    query,
    { pages, ...deps },
  );
}
