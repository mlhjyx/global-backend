/**
 * OpenCorporates API v0.4 —— 各国官方公司注册库聚合客户端（官方 REST，API token 鉴权）。
 * 获客挖掘 vNext W4 · P0 第一源：按「国别 × 检索词」拉注册实体（公司名/注册号/状态/地址）。
 *
 * 契约（https://api.opencorporates.com，v0.4）：
 *  - `GET /v0.4/companies/search?q=<名>&jurisdiction_code=<jur>&per_page=N&api_token=<token>`
 *  - 响应 `{ results: { companies: [ { company: {...} } ], page, per_page, total_pages, total_count } }`
 *  - 公司对象字段：name / company_number / jurisdiction_code / current_status / company_type /
 *    incorporation_date / dissolution_date / registered_address_in_full / opencorporates_url。
 *  - 无效 token/超配额 → 401/403/429；本客户端 429/5xx 退避重试，其余状态原样交回由调用方抛错。
 *
 * 合规（source_compliance_matrix 行 + source_policy api.opencorporates.com）：
 *  - 开放数据许可 ODbL 1.0（署名+同源共享）；**商用 API 无免费路径**，须付费订阅
 *    （调研见 docs/research/buyer-intelligence-v3.md §OpenCorporates）。provider 默认 off、
 *    data_provider 默认 DISABLED，订阅与合规签署前不得上线。
 *  - 公司记录可能内联高管（officers）等个人数据：本客户端**只映射公司字段**，绝不请求或映射
 *    高管/个人字段（源头剥离，非下游过滤）。
 */

const BASE_URL = process.env.OPENCORPORATES_API_URL ?? 'https://api.opencorporates.com/v0.4';
const MAX_RETRIES = 2; // 429/5xx/网络抖动退避
const THROTTLE_MS = 500; // 自限 ~2 req/s（免费档更低，付费档按合同；provider 层另有 rps=1 限流）
const MAX_PER_PAGE = 30;
const TIMEOUT_MS = 20_000;

// ODbL 1.0：开放数据可商用但**署名+同源共享是 license 义务**；商用 API 走订阅合同。
export const OPENCORPORATES_LICENSE = 'ODbL-1.0';
export const OPENCORPORATES_ATTRIBUTION =
  'Source: OpenCorporates (opencorporates.com), reused under the Open Database License (ODbL) v1.0; commercial API use under the OpenCorporates API terms.';

/** OpenCorporates 公司搜索命中（🟢 公司事实，最小画像；绝不含高管/个人字段）。 */
export interface OpenCorporatesCompanyHit {
  name: string;
  companyNumber: string;
  /** 注册辖区代码（'de' / 'fr' / 'us_de' …）——公司号只在辖区内唯一，身份命名空间必须带辖区。 */
  jurisdictionCode: string;
  status?: string;
  companyType?: string;
  incorporationDate?: string;
  dissolutionDate?: string;
  registeredAddress?: string;
  opencorporatesUrl?: string;
}

export interface OpenCorporatesSearchParams {
  /** 检索词（公司名/关键词）。必填——绝不裸拉全库。 */
  query: string;
  /** ISO-3166 alpha-2（'de'/'fr'…）；映射为 jurisdiction_code。与 jurisdictionCode 二者至少其一。 */
  countryCode?: string;
  /** 显式辖区代码（如美国州级 'us_de'——国家码 'us' 在 OpenCorporates 不构成单一辖区）。 */
  jurisdictionCode?: string;
  /** 每页条数，≤30。 */
  limit?: number;
}

/** 注入点（测试用假 fetch/token/节拍；生产走全局 fetch + env）。 */
export interface OpenCorporatesDeps {
  fetchImpl?: typeof fetch;
  /** 跳过退避 sleep（测试用）。 */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * 国家码 → OpenCorporates 辖区代码。多数国家 = 小写 alpha-2；美国是州级辖区，
 * 裸 'us' 不构成可查询辖区 → 返回 undefined（要求显式 jurisdictionCode，fail-safe 不猜）。
 */
export function jurisdictionCodeForCountry(countryCode: string): string | undefined {
  const code = countryCode.trim().toLowerCase();
  if (!/^[a-z]{2}$/u.test(code)) return undefined;
  if (code === 'us') return undefined;
  return code;
}

/**
 * 一条原始 company 对象 → OpenCorporatesCompanyHit（🟢 公司事实）。
 * 缺 name/company_number/jurisdiction_code → null（主键缺失，不臆造）。
 * 只读公司字段——officers 等个人数据字段**从不读取**。
 */
export function mapCompany(raw: unknown): OpenCorporatesCompanyHit | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const str = (value: unknown): string | undefined => {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return undefined;
  };
  const name = str(record['name']);
  const companyNumber = str(record['company_number']);
  const jurisdictionCode = str(record['jurisdiction_code']);
  if (!name || !companyNumber || !jurisdictionCode) return null;
  return {
    name,
    companyNumber,
    jurisdictionCode,
    status: str(record['current_status']),
    companyType: str(record['company_type']),
    incorporationDate: str(record['incorporation_date']),
    dissolutionDate: str(record['dissolution_date']),
    registeredAddress: str(record['registered_address_in_full']),
    opencorporatesUrl: str(record['opencorporates_url']),
  };
}

interface OpenCorporatesSearchResponse {
  results?: {
    companies?: unknown[];
    page?: number;
    per_page?: number;
    total_pages?: number;
    total_count?: number;
  };
}

/**
 * 按国别/辖区 + 检索词拉公司注册实体。网络失败/非 2xx 向上抛，由 provider fail-safe。
 * 无 token 由调用方先行拦截（本函数要求非空 token）。
 */
export async function searchOpenCorporatesCompanies(
  params: OpenCorporatesSearchParams,
  apiToken: string,
  beforeRequest?: () => Promise<void>,
  deps?: OpenCorporatesDeps,
): Promise<OpenCorporatesCompanyHit[]> {
  const query = params.query.trim();
  if (!query) throw new Error('opencorporates: query required (绝不裸拉全库)');
  if (!apiToken.trim()) throw new Error('opencorporates: API token required');
  const jurisdiction =
    params.jurisdictionCode?.trim().toLowerCase() ||
    (params.countryCode ? jurisdictionCodeForCountry(params.countryCode) : undefined);
  if (!jurisdiction) throw new Error('opencorporates: jurisdiction required (countryCode 不可映射或缺失)');
  const perPage = Math.min(Math.max(params.limit ?? MAX_PER_PAGE, 1), MAX_PER_PAGE);

  const url = new URL(`${BASE_URL}/companies/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('jurisdiction_code', jurisdiction);
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('api_token', apiToken);

  const res = await openCorporatesFetch(url, beforeRequest, deps);
  if (!res.ok) throw new Error(`opencorporates ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as OpenCorporatesSearchResponse;
  const entries = Array.isArray(json.results?.companies) ? json.results!.companies! : [];
  return entries
    .map((entry) => {
      const company =
        entry && typeof entry === 'object' && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)['company']
          : undefined;
      return mapCompany(company);
    })
    .filter((hit): hit is OpenCorporatesCompanyHit => hit !== null);
}

/** 带退避的 GET：429/5xx/网络错误重试；其余状态原样交回由调用方判定（不误重试 401/403）。 */
async function openCorporatesFetch(
  url: URL,
  beforeRequest?: () => Promise<void>,
  deps?: OpenCorporatesDeps,
): Promise<Response> {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const sleep = deps?.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await beforeRequest?.();
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err; // 网络/超时：退避后重试
      if (attempt === MAX_RETRIES) throw err;
      await sleep(backoff(attempt));
    }
  }
  throw lastErr;
}

function backoff(attempt: number): number {
  return THROTTLE_MS * 2 ** attempt; // 500ms, 1s
}
