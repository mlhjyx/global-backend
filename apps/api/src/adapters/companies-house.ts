/**
 * UK Companies House（`api.company-information.service.gov.uk`）—— 英国官方公司注册处 REST 客户端。
 * 待办 3 第一个身份源：active director（具名经济买家 + 稳定 officer_id）→ Tier 0 externalId 精确并。
 *
 * 契约（2026-07-11 实测通）：
 *  - 鉴权 **Basic**：API key 作 username、**空 password** → `Authorization: Basic base64(key + ":")`。
 *  - `GET /search/companies?q=<名>&items_per_page=N` → `items[{company_number, title, company_status}]`。
 *  - `GET /company/{number}/officers?items_per_page=N` → `{items[{name:"SURNAME, Given",
 *    officer_role:"director|secretary|…", resigned_on, links.officer.appointments:"/officers/{ID}/appointments"}]}`。
 *  - 限流 600 req/5min → 429 退避。
 *
 * 合规（本文件 §6 / trade-fair-intelligence.md §0）：
 *  - 董事 = 🔴 具名个人（GDPR）。本客户端**数据最小化**：只映射 `name / officer_role / resigned_on / officer_id`，
 *    **绝不提取** date_of_birth / nationality / occupation / 住址（源头剥离，非下游过滤）。
 *  - CH 免费数据 = OGL v3.0（Crown copyright），可商用但**署名是 license 义务**（见 COMPANIES_HOUSE_ATTRIBUTION）。
 */

const BASE_URL = process.env.CH_API_URL ?? 'https://api.company-information.service.gov.uk';
const THROTTLE_MS = 500; // 自限（600 req/5min ≈ 2/s，留余量）
const MAX_RETRIES = 2; // 429/5xx/网络抖动退避
const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_OFFICER_LIMIT = 50;

// OGL v3.0：公共部门信息，可商用、**署名是 license 义务**（展示/证据须附）。
export const COMPANIES_HOUSE_LICENSE = 'OGL-UK-3.0';
export const COMPANIES_HOUSE_ATTRIBUTION =
  'Contains public sector information licensed under the Open Government Licence v3.0 (© Crown copyright, Companies House).';

/** CH 公司搜索命中（🟢 公司事实，最小画像）。 */
export interface ChCompanyHit {
  companyNumber: string;
  title: string;
  /** active / dissolved / liquidation / …（只有 active 才对齐取董事）。 */
  companyStatus: string;
}

/**
 * CH 董事/高管（🔴 具名个人，**数据最小化**）。
 * 只含身份归并所需的最小字段——**不含** DOB / nationality / occupation / 住址（`mapOfficer` 从不映射）。
 */
export interface ChOfficer {
  /** CH 原始格式 "SURNAME, Given Middle"（显示归一在 provider 层做）。 */
  name: string;
  /** director / secretary / …（active director 才产联系人）。 */
  officerRole: string;
  /** 卸任日（非空 = 已卸任，过滤掉）。 */
  resignedOn?: string;
  /** 稳定 officer id（Tier 0 externalId 精确键）——从 links.officer.appointments 抽；缺则无。 */
  officerId?: string;
}

/** 注入点（测试用假 fetch/key；生产走全局 fetch + env key）。 */
export interface CompaniesHouseDeps {
  fetchImpl?: typeof fetch;
  apiKey?: string;
}

/** 从 `/officers/{OFFICER_ID}/appointments` 抽 officer id（纯函数）。缺/畸形 → undefined。 */
export function extractOfficerId(appointmentsLink?: string): string | undefined {
  if (!appointmentsLink) return undefined;
  const m = appointmentsLink.match(/\/officers\/([^/]+)\/appointments/);
  return m ? m[1] : undefined;
}

/** 一条原始 search 命中 → ChCompanyHit（🟢 公司事实）。缺 company_number/title → null（主键缺失，不臆造）。 */
export function mapCompanyHit(raw: Record<string, unknown>): ChCompanyHit | null {
  const companyNumber = str(raw['company_number'])?.trim();
  const title = str(raw['title'])?.trim();
  if (!companyNumber || !title) return null;
  return { companyNumber, title, companyStatus: str(raw['company_status'])?.trim().toLowerCase() ?? 'unknown' };
}

/**
 * 一条原始 officer 记录 → ChOfficer（🔴 具名个人，**数据最小化**）。
 * 🔴 只取 name / officer_role / resigned_on / officer_id —— **绝不**读 date_of_birth / nationality /
 * occupation / address（GDPR Art.5(1)(c) 最小化，源头剥离）。缺 name/role → null（不臆造）。
 */
export function mapOfficer(raw: Record<string, unknown>): ChOfficer | null {
  const name = str(raw['name'])?.trim();
  const officerRole = str(raw['officer_role'])?.trim().toLowerCase();
  if (!name || !officerRole) return null;
  const links = asObject(raw['links']);
  const officer = asObject(links['officer']);
  return {
    name,
    officerRole,
    resignedOn: str(raw['resigned_on'])?.trim() || undefined,
    officerId: extractOfficerId(str(officer['appointments'])),
  };
}

/** 搜索公司（按名）。网络/鉴权失败向上抛，由 provider fail-safe。无 key → 抛（provider 捕获返空）。 */
export async function searchCompanies(
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
  deps?: CompaniesHouseDeps,
): Promise<ChCompanyHit[]> {
  const q = query.trim();
  if (!q) return [];
  const json = await chGet('/search/companies', { q, items_per_page: limit }, deps);
  const items = Array.isArray(json.items) ? json.items : [];
  return items.map((it) => mapCompanyHit(it as Record<string, unknown>)).filter((c): c is ChCompanyHit => c !== null);
}

/** 取某公司高管列表（数据最小化映射）。网络/鉴权失败向上抛，由 provider fail-safe。 */
export async function listOfficers(
  companyNumber: string,
  limit: number = DEFAULT_OFFICER_LIMIT,
  deps?: CompaniesHouseDeps,
): Promise<ChOfficer[]> {
  const num = companyNumber.trim();
  if (!num) return [];
  const json = await chGet(`/company/${encodeURIComponent(num)}/officers`, { items_per_page: limit }, deps);
  const items = Array.isArray(json.items) ? json.items : [];
  return items.map((it) => mapOfficer(it as Record<string, unknown>)).filter((o): o is ChOfficer => o !== null);
}

interface ChResponse {
  items?: unknown[];
  total_results?: number;
}

/** 带退避的 GET（Basic auth；429/5xx 退避）。无 key → 抛可捕获错（provider fail-safe 返空）。 */
async function chGet(
  path: string,
  params: Record<string, string | number>,
  deps?: CompaniesHouseDeps,
  timeoutMs = 20_000,
): Promise<ChResponse> {
  const apiKey = deps?.apiKey ?? process.env.COMPANIES_HOUSE_API_KEY;
  if (!apiKey) throw new Error('COMPANIES_HOUSE_API_KEY not configured');
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  // Basic auth：key 作 username、空 password → base64(key + ":")。
  const auth = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: { Authorization: auth, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      if (res.status === 404) return {}; // 无此公司/无高管 → 空（不抛）
      if (!res.ok) throw new Error(`companies-house ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()) as ChResponse;
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_RETRIES) throw err;
      await sleep(backoff(attempt));
    }
  }
  throw lastErr;
}

// ── 值解包工具（缺键当 null）────────────────────────────────────────────────
function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
}
function backoff(attempt: number): number {
  return THROTTLE_MS * 2 ** attempt;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
