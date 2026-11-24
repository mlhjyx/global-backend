/**
 * 实时付费搜索与地点适配器：Serper (Google SERP) / Exa (神经语义 & Lookalike) / Google Places (New API)。
 *
 * 治理口径（与 deepseek-tools.ts 同构）：
 *  - 固定官方 HTTPS 主机（可用 env 覆盖指向自建受控代理），禁止任意 URL SSRF 与鉴权重定向（redirect: 'error'）；
 *  - 响应体严格受控字节读取（readFetchResponseBodyBounded），防止内存放大；
 *  - 只对 429/5xx/网络故障做有界重试并释放连接；401/402/403 原样抛出；
 *  - 每次物理出网前必调用 beforeRequest（由 ToolBroker 工具注入授权 + beforePhysicalWire）；
 *  - 缺 key 返回 undefined，由工具层诚实降级为 degraded 空结果，绝不崩流程；
 *  - Serper 自动剥离 google.com/goto?url=、google.com/url、webcache 等重定向/噪声链接；
 *  - Google Places 遵循 Maps Terms §3.2.3（D4）：不拉取 formattedAddress / 电话 / 评论，只读
 *    places.id / displayName / websiteUri / addressComponents(country)。
 */
import {
  decodeJsonBytes,
  readFetchResponseBodyBounded,
} from './bounded-fetch-response';

const DEFAULT_SERPER_URL = 'https://google.serper.dev';
const DEFAULT_EXA_URL = 'https://api.exa.ai';
const DEFAULT_GOOGLE_PLACES_URL = 'https://places.googleapis.com';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;
const MAX_SEARCH_RESPONSE_BYTES = 2_000_000;

const GOOGLE_PLACES_FIELD_MASK =
  'places.id,places.displayName,places.websiteUri,places.addressComponents';

export interface SearchProviderDeps {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  beforeRequest?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
}

export interface SearchProviderHit {
  url: string;
  title?: string;
}

export interface SearchProviderResponse {
  hits: SearchProviderHit[];
  billed: boolean;
}

export interface GooglePlaceHit {
  placeId: string;
  name?: string;
  websiteUri?: string;
  countryCode?: string;
}

export interface GooglePlacesResponse {
  places: GooglePlaceHit[];
  billed: boolean;
}

export function resolveSerperApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const key = env.SERPER_API_KEY?.trim();
  return key ? key : undefined;
}

export function resolveExaApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const key = env.EXA_API_KEY?.trim();
  return key ? key : undefined;
}

export function resolveGoogleMapsApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const key = env.GOOGLE_MAPS_API_KEY?.trim();
  return key ? key : undefined;
}

const sleepDefault = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function retryDelayMs(response: Response | undefined, attempt: number): number {
  const retryAfter = Number(response?.headers.get('retry-after') ?? '');
  return Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.min(retryAfter, 30) * 1000
    : 400 * (attempt + 1);
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function statusError(prefix: string, status: number): Error {
  if (status === 401 || status === 403) return new Error(`${prefix}_API_KEY_REJECTED`);
  if (status === 402) return new Error(`${prefix}_BALANCE_INSUFFICIENT`);
  if (status === 429) return new Error(`${prefix}_RATE_LIMITED`);
  if (status >= 500) return new Error(`${prefix}_UPSTREAM_UNAVAILABLE`);
  return new Error(`${prefix}_HTTP_${status}`);
}

async function postJson(args: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  prefix: string;
  deps: SearchProviderDeps;
}): Promise<Buffer> {
  const fetchImpl = args.deps.fetchImpl ?? fetch;
  const sleep = args.deps.sleep ?? sleepDefault;
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    await args.deps.beforeRequest?.();
    let response: Response;
    try {
      response = await fetchImpl(args.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...args.headers,
        },
        body: JSON.stringify(args.body),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES) {
        throw new Error(`${args.prefix}_NETWORK_ERROR`, { cause: error });
      }
      await sleep(retryDelayMs(undefined, attempt));
      continue;
    }
    if (retryable(response.status) && attempt < MAX_RETRIES) {
      await response.body?.cancel().catch(() => undefined);
      await sleep(retryDelayMs(response, attempt));
      continue;
    }
    if (!response.ok) throw statusError(args.prefix, response.status);
    return readFetchResponseBodyBounded(
      response,
      MAX_SEARCH_RESPONSE_BYTES,
      `${args.prefix}_RESPONSE_TOO_LARGE`,
    );
  }
  throw new Error(`${args.prefix}_NETWORK_ERROR`, { cause: lastError });
}

const JUNK_SEARCH_HOSTS = new Set([
  'webcache.googleusercontent.com',
  'translate.google.com',
  'accounts.google.com',
  'maps.google.com',
  'policies.google.com',
  'support.google.com',
]);

/**
 * 清洗搜索结果 URL：
 * - 剔除 google.com/goto?url=...、google.com/url?...、google.com/search?... 等跳转壳；
 * - 拒绝非 http(s)、含凭据或噪声缓存域 URL。
 */
export function sanitizeSearchProviderUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./u, '');
  if (JUNK_SEARCH_HOSTS.has(host)) return null;
  if (
    host === 'google.com' ||
    /^google\.[a-z]{2,3}(?:\.[a-z]{2})?$/u.test(host)
  ) {
    if (/^\/(?:goto|url|search|aclk|imgres|preferences)\b/iu.test(parsed.pathname)) {
      return null;
    }
  }
  return trimmed;
}

export interface SerperSearchInput {
  query: string;
  num?: number;
  gl?: string;
  hl?: string;
}

/** Serper Google SERP 搜索：仅保留去噪后的 url + title。 */
export async function serperSearch(
  input: SerperSearchInput,
  deps: SearchProviderDeps = {},
): Promise<SearchProviderResponse> {
  const apiKey = deps.apiKey ?? resolveSerperApiKey();
  if (!apiKey) throw new Error('SERPER_API_KEY_NOT_CONFIGURED');
  const base = (deps.baseUrl ?? process.env.SERPER_API_URL ?? DEFAULT_SERPER_URL).replace(/\/+$/u, '');
  const body: Record<string, unknown> = {
    q: input.query,
    num: Math.min(20, Math.max(1, Math.trunc(input.num ?? 10))),
  };
  if (input.gl && /^[a-z]{2}$/iu.test(input.gl)) body.gl = input.gl.toLowerCase();
  if (input.hl && /^[a-z]{2}(?:-[a-z]{2})?$/iu.test(input.hl)) body.hl = input.hl.toLowerCase();

  const bytes = await postJson({
    url: `${base}/search`,
    headers: { 'X-API-KEY': apiKey },
    body,
    prefix: 'SERPER_SEARCH',
    deps,
  });
  const payload = decodeJsonBytes<{ organic?: unknown }>(bytes, 'SERPER_SEARCH_RESPONSE_INVALID');
  if (!payload || typeof payload !== 'object') {
    throw new Error('SERPER_SEARCH_RESPONSE_INVALID');
  }
  const organic = Array.isArray(payload.organic) ? payload.organic : [];
  const hits: SearchProviderHit[] = [];
  for (const item of organic) {
    if (!item || typeof item !== 'object') continue;
    const url = sanitizeSearchProviderUrl((item as { link?: unknown }).link);
    if (!url) continue;
    const rawTitle = (item as { title?: unknown }).title;
    hits.push(
      typeof rawTitle === 'string' && rawTitle.trim().length > 0
        ? { url, title: rawTitle.trim() }
        : { url },
    );
  }
  return { hits, billed: true };
}

export interface ExaSearchInput {
  query: string;
  numResults?: number;
  excludeDomains?: readonly string[];
  includeDomains?: readonly string[];
  category?: 'company';
}

export interface ExaFindSimilarInput {
  url: string;
  numResults?: number;
  excludeDomains?: readonly string[];
}

function parseExaHits(bytes: Buffer, errorCode: string): SearchProviderHit[] {
  const payload = decodeJsonBytes<{ results?: unknown }>(bytes, errorCode);
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.results)) {
    throw new Error(errorCode);
  }
  const hits: SearchProviderHit[] = [];
  for (const item of payload.results) {
    if (!item || typeof item !== 'object') continue;
    const url = sanitizeSearchProviderUrl((item as { url?: unknown }).url);
    if (!url) continue;
    const rawTitle = (item as { title?: unknown }).title;
    hits.push(
      typeof rawTitle === 'string' && rawTitle.trim().length > 0
        ? { url, title: rawTitle.trim() }
        : { url },
    );
  }
  return hits;
}

/** Exa 神经语义搜索（personalData:false，仅保留 url + title）。 */
export async function exaSearch(
  input: ExaSearchInput,
  deps: SearchProviderDeps = {},
): Promise<SearchProviderResponse> {
  const apiKey = deps.apiKey ?? resolveExaApiKey();
  if (!apiKey) throw new Error('EXA_API_KEY_NOT_CONFIGURED');
  const base = (deps.baseUrl ?? process.env.EXA_API_URL ?? DEFAULT_EXA_URL).replace(/\/+$/u, '');
  const body: Record<string, unknown> = {
    query: input.query,
    numResults: Math.min(20, Math.max(1, Math.trunc(input.numResults ?? 10))),
    type: 'auto',
  };
  if (input.category) body.category = input.category;
  if (input.includeDomains?.length) body.includeDomains = [...input.includeDomains].slice(0, 20);
  if (input.excludeDomains?.length) body.excludeDomains = [...input.excludeDomains].slice(0, 20);

  const bytes = await postJson({
    url: `${base}/search`,
    headers: { 'x-api-key': apiKey },
    body,
    prefix: 'EXA_SEARCH',
    deps,
  });
  return { hits: parseExaHits(bytes, 'EXA_SEARCH_RESPONSE_INVALID'), billed: true };
}

/** Exa Lookalike 相似公司发现（以标杆客户/官网为种子扩展同类买方）。 */
export async function exaFindSimilar(
  input: ExaFindSimilarInput,
  deps: SearchProviderDeps = {},
): Promise<SearchProviderResponse> {
  const apiKey = deps.apiKey ?? resolveExaApiKey();
  if (!apiKey) throw new Error('EXA_API_KEY_NOT_CONFIGURED');
  const safeSeed = sanitizeSearchProviderUrl(input.url);
  if (!safeSeed) throw new Error('EXA_FIND_SIMILAR_URL_INVALID');
  const base = (deps.baseUrl ?? process.env.EXA_API_URL ?? DEFAULT_EXA_URL).replace(/\/+$/u, '');
  const body: Record<string, unknown> = {
    url: safeSeed,
    numResults: Math.min(20, Math.max(1, Math.trunc(input.numResults ?? 10))),
    excludeSourceDomain: true,
  };
  if (input.excludeDomains?.length) body.excludeDomains = [...input.excludeDomains].slice(0, 20);

  const bytes = await postJson({
    url: `${base}/findSimilar`,
    headers: { 'x-api-key': apiKey },
    body,
    prefix: 'EXA_SEARCH',
    deps,
  });
  return { hits: parseExaHits(bytes, 'EXA_SEARCH_RESPONSE_INVALID'), billed: true };
}

export interface GooglePlacesSearchInput {
  textQuery: string;
  maxResultCount?: number;
  regionCode?: string;
  languageCode?: string;
}

function extractCountryCode(components: unknown): string | undefined {
  if (!Array.isArray(components)) return undefined;
  for (const item of components) {
    if (!item || typeof item !== 'object') continue;
    const types = (item as { types?: unknown }).types;
    const shortText = (item as { shortText?: unknown }).shortText;
    if (
      Array.isArray(types) &&
      types.includes('country') &&
      typeof shortText === 'string' &&
      /^[A-Za-z]{2}$/u.test(shortText.trim())
    ) {
      return shortText.trim().toUpperCase();
    }
  }
  return undefined;
}

/**
 * Google Places API (New) 文本搜索：仅请求 id / displayName / websiteUri / addressComponents(country)。
 * 持久回放路径只保留 placeId（D4 §3.2.3 禁止跨缓存持久存储非 place_id 字段）。
 */
export async function googlePlacesSearchText(
  input: GooglePlacesSearchInput,
  deps: SearchProviderDeps = {},
): Promise<GooglePlacesResponse> {
  const apiKey = deps.apiKey ?? resolveGoogleMapsApiKey();
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY_NOT_CONFIGURED');
  const base = (
    deps.baseUrl ?? process.env.GOOGLE_PLACES_API_URL ?? DEFAULT_GOOGLE_PLACES_URL
  ).replace(/\/+$/u, '');
  const body: Record<string, unknown> = {
    textQuery: input.textQuery,
    maxResultCount: Math.min(20, Math.max(1, Math.trunc(input.maxResultCount ?? 10))),
  };
  if (input.regionCode && /^[A-Za-z]{2}$/u.test(input.regionCode)) {
    body.regionCode = input.regionCode.toUpperCase();
  }
  if (input.languageCode && /^[a-z]{2}(?:-[A-Za-z]{2})?$/u.test(input.languageCode)) {
    body.languageCode = input.languageCode;
  }

  const bytes = await postJson({
    url: `${base}/v1/places:searchText`,
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': GOOGLE_PLACES_FIELD_MASK,
    },
    body,
    prefix: 'GOOGLE_PLACES',
    deps,
  });
  const payload = decodeJsonBytes<{ places?: unknown }>(bytes, 'GOOGLE_PLACES_RESPONSE_INVALID');
  if (!payload || typeof payload !== 'object') {
    throw new Error('GOOGLE_PLACES_RESPONSE_INVALID');
  }
  const rawPlaces = Array.isArray(payload.places) ? payload.places : [];
  const places: GooglePlaceHit[] = [];
  for (const item of rawPlaces) {
    if (!item || typeof item !== 'object') continue;
    const record = item as {
      id?: unknown;
      displayName?: { text?: unknown };
      websiteUri?: unknown;
      addressComponents?: unknown;
    };
    const placeId = typeof record.id === 'string' ? record.id.trim() : '';
    if (!placeId || placeId.length > 256) continue;
    const rawName = typeof record.displayName?.text === 'string' ? record.displayName.text.trim() : '';
    const websiteUri = sanitizeSearchProviderUrl(record.websiteUri) ?? undefined;
    const countryCode = extractCountryCode(record.addressComponents);
    places.push({
      placeId,
      ...(rawName ? { name: rawName.slice(0, 500) } : {}),
      ...(websiteUri ? { websiteUri } : {}),
      ...(countryCode ? { countryCode } : {}),
    });
  }
  return { places, billed: true };
}
