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
const DEFAULT_BRAVE_URL = 'https://api.search.brave.com';
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
  dispatchDiscoveryV3Wire?: (send: (signal: AbortSignal) => Promise<Response>) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
}

export interface SearchProviderHit {
  url: string;
  title?: string;
  snippet?: string;
  highlights?: string[];
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

export function resolveBraveSearchApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const key = env.BRAVE_SEARCH_API_KEY?.trim();
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
  const request = (signal: AbortSignal) => fetchImpl(args.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...args.headers },
    body: JSON.stringify(args.body),
    redirect: 'error',
    signal,
  });
  if (args.deps.dispatchDiscoveryV3Wire) {
    await args.deps.beforeRequest?.();
    const response = await args.deps.dispatchDiscoveryV3Wire(request);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw statusError(args.prefix, response.status);
    }
    return readFetchResponseBodyBounded(response, MAX_SEARCH_RESPONSE_BYTES, `${args.prefix}_RESPONSE_TOO_LARGE`);
  }
  const sleep = args.deps.sleep ?? sleepDefault;
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    await args.deps.beforeRequest?.();
    let response: Response;
    try {
      response = await request(AbortSignal.timeout(REQUEST_TIMEOUT_MS));
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

async function getJson(args: {
  url: string;
  headers: Record<string, string>;
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
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          ...args.headers,
        },
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
  includeSnippet?: boolean;
}

/** Serper Google SERP 搜索：默认仅保留去噪后的 url + title；个人搜人模式下可显式开启 snippet。 */
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
    const rawSnippet =
      input.includeSnippet === true ? (item as { snippet?: unknown }).snippet : undefined;
    const title = typeof rawTitle === 'string' && rawTitle.trim().length > 0 ? rawTitle.trim() : undefined;
    const snippet =
      typeof rawSnippet === 'string' && rawSnippet.trim().length > 0 ? rawSnippet.trim() : undefined;
    hits.push({
      url,
      ...(title !== undefined ? { title } : {}),
      ...(snippet !== undefined ? { snippet } : {}),
    });
  }
  return { hits, billed: true };
}

export interface BraveSearchInput {
  query: string;
  count?: number;
  country?: string;
  searchLang?: string;
}

/** Brave Web Search API（独立索引，仅保留去噪后的 url + title）。 */
export async function braveSearch(
  input: BraveSearchInput,
  deps: SearchProviderDeps = {},
): Promise<SearchProviderResponse> {
  const apiKey = deps.apiKey ?? resolveBraveSearchApiKey();
  if (!apiKey) throw new Error('BRAVE_SEARCH_API_KEY_NOT_CONFIGURED');
  const base = (deps.baseUrl ?? process.env.BRAVE_SEARCH_API_URL ?? DEFAULT_BRAVE_URL).replace(/\/+$/u, '');
  const params = new URLSearchParams({
    q: input.query,
    count: String(Math.min(20, Math.max(1, Math.trunc(input.count ?? 10)))),
  });
  if (input.country && /^[a-z]{2}$/iu.test(input.country)) {
    params.set('country', input.country.toUpperCase());
  }
  if (input.searchLang && /^[a-z]{2}(?:-[a-z]{2})?$/iu.test(input.searchLang)) {
    params.set('search_lang', input.searchLang.toLowerCase());
  }

  const bytes = await getJson({
    url: `${base}/res/v1/web/search?${params.toString()}`,
    headers: { 'X-Subscription-Token': apiKey },
    prefix: 'BRAVE_SEARCH',
    deps,
  });
  const payload = decodeJsonBytes<{ web?: { results?: unknown } }>(
    bytes,
    'BRAVE_SEARCH_RESPONSE_INVALID',
  );
  if (!payload || typeof payload !== 'object') {
    throw new Error('BRAVE_SEARCH_RESPONSE_INVALID');
  }
  const results = Array.isArray(payload.web?.results) ? payload.web.results : [];
  const hits: SearchProviderHit[] = [];
  for (const item of results) {
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
  return { hits, billed: true };
}

export interface ExaSearchInput {
  query: string;
  numResults?: number;
  excludeDomains?: readonly string[];
  includeDomains?: readonly string[];
  category?: 'company' | 'people';
  includeHighlights?: boolean;
}

export interface ExaFindSimilarInput {
  url: string;
  numResults?: number;
  excludeDomains?: readonly string[];
}

const EXA_TITLE_SUFFIX_RE = /\s*[|–—-]\s*Exa\s*$/iu;
const EXA_HEADLINE_SPLIT_RE = /\s*[|·]\s*|\s+[–—-]\s+/u;

function firstNonEmptyString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const named = (value as { name?: unknown }).name;
      if (typeof named === 'string' && named.trim().length > 0) return named.trim();
    }
  }
  return undefined;
}

function isExaLibraryPersonUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./u, '');
    return (host === 'exa.ai' || host.endsWith('.exa.ai')) && /^\/library\/person\//iu.test(parsed.pathname);
  } catch {
    return false;
  }
}

function extractExaPeopleHighlights(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim())
        .slice(0, 3)
    : [];
}

/**
 * 解析 Exa People 搜人命中：兼容标准 `{ url, title }`（剥离尾部 `| Exa` / `- Exa`）
 * 与 `entities[0].properties` / `author` 结构化字段；若 `url` 为 `exa.ai/library/person/...`
 * 则优先取实体里的 `linkedinUrl` / `profileUrl`；若标题缺职位或公司段则拼合为
 * `"{name} - {role} - {company}"` 以对齐现有三段社媒校验器。
 */
export function parseExaPeopleHit(item: unknown): SearchProviderHit | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  const entities = Array.isArray(record.entities) ? record.entities : [];
  const firstEntity = entities.find((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)) as
    | Record<string, unknown>
    | undefined;
  const props =
    firstEntity?.properties && typeof firstEntity.properties === 'object' && !Array.isArray(firstEntity.properties)
      ? (firstEntity.properties as Record<string, unknown>)
      : undefined;

  const rawUrl = sanitizeSearchProviderUrl(record.url);
  const entityUrl = sanitizeSearchProviderUrl(
    firstNonEmptyString(
      props?.linkedinUrl,
      props?.linkedin_url,
      props?.profileUrl,
      props?.profile_url,
      props?.url,
    ),
  );
  const url = rawUrl && !isExaLibraryPersonUrl(rawUrl) ? rawUrl : (entityUrl ?? rawUrl);
  if (!url) return null;

  const rawTitle =
    typeof record.title === 'string' ? record.title.replace(EXA_TITLE_SUFFIX_RE, '').trim() : '';
  const segments = rawTitle
    ? rawTitle
        .split(EXA_HEADLINE_SPLIT_RE)
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0 && !/^(linkedin|xing|exa)$/iu.test(segment))
    : [];

  const entityName = firstNonEmptyString(props?.name, props?.fullName, props?.full_name, record.author);
  const entityRole = firstNonEmptyString(
    props?.role,
    props?.title,
    props?.jobTitle,
    props?.job_title,
    props?.position,
    props?.headline,
  );
  const entityCompany = firstNonEmptyString(
    props?.company,
    props?.organization,
    props?.companyName,
    props?.company_name,
    props?.employer,
  );

  let title: string | undefined;
  if (segments.length >= 3) {
    title = rawTitle;
  } else if (entityRole || entityCompany) {
    const name = entityName ?? segments[0];
    const role = entityRole ?? (segments.length >= 2 ? segments[1] : undefined);
    const company = entityCompany ?? (segments.length >= 2 && entityRole ? segments[1] : undefined);
    const composed = [name, role, company].filter((part): part is string => Boolean(part && part.trim())).join(' - ');
    title = composed || rawTitle || undefined;
  } else {
    title = rawTitle || entityName || undefined;
  }

  const highlights = extractExaPeopleHighlights(record.highlights);
  return {
    url,
    ...(title ? { title } : {}),
    ...(highlights.length > 0 ? { highlights } : {}),
  };
}

function parseExaHits(bytes: Buffer, errorCode: string, peopleMode = false): SearchProviderHit[] {
  const payload = decodeJsonBytes<{ results?: unknown }>(bytes, errorCode);
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.results)) {
    throw new Error(errorCode);
  }
  const hits: SearchProviderHit[] = [];
  for (const item of payload.results) {
    if (peopleMode) {
      const hit = parseExaPeopleHit(item);
      if (hit) hits.push(hit);
      continue;
    }
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

/** Exa 神经语义搜索。People 搜索额外请求有界的上下文片段。 */
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
  if (input.category === 'people' || input.includeHighlights === true) {
    body.contents = { highlights: { maxCharacters: 720 } };
  }
  if (input.includeDomains?.length) body.includeDomains = [...input.includeDomains].slice(0, 20);
  // Exa 官方 /search 在 category:"people" 下传 excludeDomains 直接报 HTTP 400，必须跳过。
  if (input.category !== 'people' && input.excludeDomains?.length) {
    body.excludeDomains = [...input.excludeDomains].slice(0, 20);
  }

  const bytes = await postJson({
    url: `${base}/search`,
    headers: { 'x-api-key': apiKey },
    body,
    prefix: 'EXA_SEARCH',
    deps,
  });
  return {
    hits: parseExaHits(bytes, 'EXA_SEARCH_RESPONSE_INVALID', input.category === 'people'),
    billed: true,
  };
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
