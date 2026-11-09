/**
 * DeepSeek Search & Fetch（`api.deepseek.com/v1/tools/*`）——模型驱动联网搜索的付费执行后端
 * （获客通路 A：模型工具环 → ToolBroker → 本适配器）。
 *
 * 契约（官方 Search & Fetch 文档，2026-11 核验）：
 *  - `POST /v1/tools/search` body `{ query(1–128 字符), count(1–50，默认 10), need_content(默认 false) }`
 *    → 200 `{ results: [{ title, url, summary, snippet, site_name, date, rerank_score, authority, content? }] }`；
 *  - `POST /v1/tools/fetch` body `{ url(http/https、≤8192 字符、不带凭据) }` → 200 `{ title, content(markdown) }`；
 *  - Bearer 鉴权（`DEEPSEEK_API_KEY`，密钥只在 env，业务码不见具体值）；OpenAI 风格错误体；
 *  - **按成功请求计费**（HTTP 200 且结果/正文非空才计；5 元/1000 次）。
 *
 * 为什么不用 requestPublicHttp：目标主机是固定常量（可经 `DEEPSEEK_API_URL` 覆盖为自建网关），
 * 不存在任意 URL 的 SSRF 面；响应体仍有硬字节上限，超限即拒。任意 URL 的出网仍只能走
 * guarded-http 的钉扎路径（crawl4ai/http.get/social.fetch），本适配器不接收用户给的 host。
 *
 * 重试：只对 429/5xx/网络错误有界重试（这几种上游不计费）；401/402/403 与其他 4xx
 * 原样抛出，不误重试。每次物理发信前调用 `beforeRequest`（授权 + beforePhysicalWire 由工具注入）。
 */
import {
  decodeJsonBytes,
  readFetchResponseBodyBounded,
} from './bounded-fetch-response';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const SEARCH_PATH = '/v1/tools/search';
const FETCH_PATH = '/v1/tools/fetch';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const MAX_SEARCH_RESPONSE_BYTES = 2_000_000;
const MAX_FETCH_RESPONSE_BYTES = 4_000_000;

/** 从 env 取 DeepSeek key（缺失返回 undefined；调用方降级为 unconfigured，不抛崩）。 */
export function resolveDeepSeekApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const key = env.DEEPSEEK_API_KEY?.trim();
  return key ? key : undefined;
}

export interface DeepSeekToolsDeps {
  /** 测试注入点；默认全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 显式 key（测试用）；缺省执行时读 env。 */
  apiKey?: string;
  /** 每次物理发信前的授权/围栏回调（工具注入）。 */
  beforeRequest?: () => Promise<void>;
  /** 退避等待（测试注入点）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 覆盖 API 根（自建网关；默认 https://api.deepseek.com）。 */
  baseUrl?: string;
}

/** 一条搜索结果：只留 url/title —— 摘要/正文/引擎元数据不离开适配器。 */
export interface DeepSeekSearchHit {
  url: string;
  title?: string;
}

export interface DeepSeekSearchResponse {
  hits: DeepSeekSearchHit[];
  /** 上游按「成功且非空」计费：true 时调用方按一次付费请求结算。 */
  billed: boolean;
}

export interface DeepSeekFetchResponse {
  title?: string;
  content: string;
  billed: boolean;
}

const sleepDefault = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function baseUrl(override?: string): string {
  return (override ?? process.env.DEEPSEEK_API_URL ?? DEFAULT_BASE_URL).replace(/\/+$/u, '');
}

function retryDelayMs(response: Response | undefined, attempt: number): number {
  const retryAfter = Number(response?.headers.get('retry-after') ?? '');
  return Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.min(retryAfter, 30) * 1000
    : 500 * (attempt + 1);
}

function statusError(operation: 'SEARCH' | 'FETCH', status: number): Error {
  if (status === 401 || status === 403) return new Error(`DEEPSEEK_API_KEY_REJECTED`);
  if (status === 402) return new Error(`DEEPSEEK_BALANCE_INSUFFICIENT`);
  if (status === 429) return new Error(`DEEPSEEK_${operation}_RATE_LIMITED`);
  if (status >= 500) return new Error(`DEEPSEEK_UPSTREAM_UNAVAILABLE`);
  return new Error(`DEEPSEEK_${operation}_HTTP_${status}`);
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

interface PostResult {
  status: number;
  bytes: Buffer;
}

async function postJson(
  path: string,
  body: Record<string, unknown>,
  apiKey: string,
  maximumBytes: number,
  operation: 'SEARCH' | 'FETCH',
  deps: DeepSeekToolsDeps,
): Promise<PostResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? sleepDefault;
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    await deps.beforeRequest?.();
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl(deps.baseUrl)}${path}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
        // 固定主机不接受重定向：一次已鉴权的 POST 不能被带去别的 host。
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES) {
        throw new Error(`DEEPSEEK_${operation}_NETWORK_ERROR`, { cause: error });
      }
      await sleep(retryDelayMs(undefined, attempt));
      continue;
    }
    if (retryable(response.status) && attempt < MAX_RETRIES) {
      // 不消费的重试响应会让 undici 无法复用连接；释放后再退避。
      await response.body?.cancel().catch(() => undefined);
      await sleep(retryDelayMs(response, attempt));
      continue;
    }
    if (!response.ok) throw statusError(operation, response.status);
    const bytes = await readFetchResponseBodyBounded(
      response,
      maximumBytes,
      `DEEPSEEK_${operation}_RESPONSE_TOO_LARGE`,
    );
    return { status: response.status, bytes };
  }
  throw new Error(`DEEPSEEK_${operation}_NETWORK_ERROR`, { cause: lastError });
}

function invalid(code: string): never {
  throw new Error(code);
}

/**
 * 一次 DeepSeek 网页搜索。结构校验是防御性的：结果项缺 url 静默丢弃，
 * 其余字段一律不读——摘要/正文/作者/引擎元数据可能承载个人数据，不离开本函数。
 */
export async function deepSeekToolSearch(
  input: { query: string; count: number },
  deps: DeepSeekToolsDeps = {},
): Promise<DeepSeekSearchResponse> {
  const apiKey = deps.apiKey ?? resolveDeepSeekApiKey();
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY_NOT_CONFIGURED');
  const { bytes } = await postJson(
    SEARCH_PATH,
    { query: input.query, count: input.count, need_content: false },
    apiKey,
    MAX_SEARCH_RESPONSE_BYTES,
    'SEARCH',
    deps,
  );
  const payload = decodeJsonBytes<{ results?: unknown }>(
    bytes,
    'DEEPSEEK_SEARCH_RESPONSE_INVALID',
  );
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.results)) {
    return invalid('DEEPSEEK_SEARCH_RESPONSE_INVALID');
  }
  const hits: DeepSeekSearchHit[] = [];
  for (const item of payload.results) {
    if (!item || typeof item !== 'object') invalid('DEEPSEEK_SEARCH_RESPONSE_INVALID');
    const url = (item as { url?: unknown }).url;
    if (typeof url !== 'string' || url.length === 0) continue;
    const title = (item as { title?: unknown }).title;
    hits.push(
      typeof title === 'string' && title.length > 0 ? { url, title } : { url },
    );
  }
  return { hits, billed: hits.length > 0 };
}

/** 一次 DeepSeek 页面抓取（markdown 正文）。正文为空 = 未命中，不计费。 */
export async function deepSeekToolFetch(
  input: { url: string },
  deps: DeepSeekToolsDeps = {},
): Promise<DeepSeekFetchResponse> {
  const apiKey = deps.apiKey ?? resolveDeepSeekApiKey();
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY_NOT_CONFIGURED');
  const { bytes } = await postJson(
    FETCH_PATH,
    { url: input.url },
    apiKey,
    MAX_FETCH_RESPONSE_BYTES,
    'FETCH',
    deps,
  );
  const payload = decodeJsonBytes<{ title?: unknown; content?: unknown }>(
    bytes,
    'DEEPSEEK_FETCH_RESPONSE_INVALID',
  );
  if (!payload || typeof payload !== 'object') {
    return invalid('DEEPSEEK_FETCH_RESPONSE_INVALID');
  }
  const content = payload.content;
  if (typeof content !== 'string') return invalid('DEEPSEEK_FETCH_RESPONSE_INVALID');
  const title = payload.title;
  return {
    ...(typeof title === 'string' && title.length > 0 ? { title } : {}),
    content,
    billed: content.trim().length > 0,
  };
}
