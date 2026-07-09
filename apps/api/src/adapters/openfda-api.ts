/**
 * openFDA（api.fda.gov）—— 美国 FDA 官方开放数据 API，零鉴权 REST 客户端。
 * 器械注册目录 `device/registrationlisting` = 在美注册的制造商/进口商 → 可解析的活跃公司名单。
 *
 * 契约据 docs/backend/openfda-provider-spec.md §1（2026-07-08 活体实测 + 对抗核实）：
 *  - `GET https://api.fda.gov/device/registrationlisting.json?search=<field>:<value>&limit=N&skip=M`。
 *  - **无 `fields` 投影**（不同于 TED）——响应是全字段记录，消费方自取。
 *  - 分页：`limit≤1000`、`skip≤25000`（超返错）；深翻用 `search_after` 游标（本 P1 只做有界样本，不深翻）。
 *  - 0 命中 → `{"error":{"code":"NOT_FOUND"}}`（无 `results`）——消费方必判 error。
 *  - `meta.results.total` = 命中总数（sizing）。限流：无 key 240/min+1000/天，免费 key 240/min+120k/天 → 429 退避。
 *  - `openfda` 谐调块**精确匹配、失败即整块缺失** → 缺块/缺字段当 null。
 *
 * 合规（spec §3）：CC0 公共领域（**署名非义务**，与 TED 强制 CC BY 不同）；establishment 法人事实 🟢。
 * 本客户端**绝不提取** `registration.us_agent` / `contact` 等 🔴 具名个人字段（GDPR，走隔离路径）。
 * 「注册/收录 ≠ FDA 核准」——记录只承载自报事实，绝不标「FDA 认证/批准」（§3.3.2 文案红线）。
 */

const BASE_URL = process.env.OPENFDA_API_URL ?? 'https://api.fda.gov';
const API_KEY = process.env.OPENFDA_API_KEY; // 免费 key（可选）→ 提配额到 120k/天
const MAX_LIMIT = 1000; // 每调硬上限
const MAX_SKIP = 25_000; // skip 上限（超返 "Skip value must 25000 or less."）
const THROTTLE_MS = 300; // 自限（240/min ≈ 4/s，留余量）
const MAX_RETRIES = 2; // 429/5xx/网络抖动退避
const MAX_PAGES = 30; // 有界样本安全阀（绝不 grind 32 万全量——那是 Schedule 增量的活）
// CC0 1.0：公共领域，可商用、**署名非义务**（展示可附，非 license 强制）。
export const OPENFDA_LICENSE = 'CC0-1.0';
export const OPENFDA_ATTRIBUTION = 'Source: openFDA (U.S. FDA), public domain (CC0 1.0)';
// 🔴 文案红线：注册≠核准。绿事实记录统一附此免责，绝不呈现为 FDA 认证/背书。
export const FDA_REGISTRATION_DISCLAIMER = '已在 FDA 注册/清关（自报事实，非 FDA 核准/认证/背书）';

/** device/classification `openfda` 谐调块（分类便利富集；缺块当 null）。 */
export interface OpenFdaDeviceFacts {
  deviceName?: string;
  deviceClass?: string; // "1"/"2"/"3"/"U"/"N"/"F"
  medicalSpecialtyDescription?: string;
  regulationNumber?: string;
}

/** 一条 registrationlisting 记录 → 归一 establishment（🟢 法人事实，无具名个人）。 */
export interface OpenFdaEstablishment {
  registrationNumber?: string; // FDA 分配（全局唯一）→ 身份主键
  feiNumber?: string;
  name: string;
  country?: string; // ISO alpha-2（registration.iso_country_code）
  city?: string;
  stateCode?: string;
  statusCode?: string;
  /** 贸易角色（顶层 establishment_type[]，活枚举以数据为准）。 */
  establishmentTypes: string[];
  /** §8.1：美国进口商 = `registration.initial_importer_flag:'Y'`（**非** establishment_type:Importer）。 */
  initialImporter: boolean;
  /** 该 establishment 名下产品的 product code（去重）。 */
  productCodes: string[];
  /** 分类事实：优先取**匹配 ICP 搜索码**的产品（否则首个带谐调块的产品；缺块当 null）。 */
  deviceFacts?: OpenFdaDeviceFacts;
  /** 全部产品谐调块里的 device_name（去重）——喂 fit 门可读设备描述（比不透明 3 字母码有用）。 */
  deviceNames: string[];
  /** products[].owner_operator_number（🟢 非个人法人 id，跨设施归同一 firm 用；不含 owner_operator 具名个人）。 */
  ownerOperatorNumbers: string[];
  /** 记录里最早的 product created_date（YYYY-MM-DD，若有）。 */
  createdDate?: string;
}

export interface RegistrationSearchParams {
  /** product code 集（3 字母码），至少一个——绝不裸拉全库。 */
  productCodes: string[];
  /** establishment 所在国 ISO-2（如 'CN'/'US'）；空则不加。 */
  isoCountry?: string;
  /** 只要美国进口商（initial_importer_flag:Y）——出海卖家最想要的渠道侧。 */
  importerOnly?: boolean;
  /** 贸易角色过滤（establishment_type，可选，活枚举）。 */
  establishmentTypes?: string[];
  limit?: number; // ≤1000
  maxRecords?: number; // 跨页累计上限（有界样本）
}

/** search 子句 AND 拼接（`field:value AND field:value`）。 */
export function buildRegistrationSearch(p: RegistrationSearchParams): string {
  if (!p.productCodes.length) {
    throw new Error('buildRegistrationSearch: productCodes required (openFDA 发现必须带产品码，绝不裸拉全库)');
  }
  const clauses: string[] = [orClause('products.product_code', p.productCodes)];
  if (p.isoCountry) clauses.push(`registration.iso_country_code:${p.isoCountry.toUpperCase()}`);
  if (p.importerOnly) clauses.push('registration.initial_importer_flag:Y');
  if (p.establishmentTypes?.length) clauses.push(orClause('establishment_type', p.establishmentTypes));
  return clauses.join(' AND ');
}

/** 单值 `field:value`；多值 `(field:a OR field:b)`（openFDA 用 OR + 括号，带引号裹含空格值）。 */
function orClause(field: string, values: string[]): string {
  const parts = values.map((v) => `${field}:${/\s/.test(v) ? `"${v}"` : v}`);
  return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
}

/**
 * 一条原始 registrationlisting 记录 → 归一 establishment。
 * 🔴 **绝不提取** `registration.us_agent` / `contact`（具名个人，GDPR）——绿事实只取法人字段。
 * `openfda` 谐调块缺块/缺字段当 null（谐调精确匹配失败即整块缺失）。
 */
export function mapRegistration(raw: Record<string, unknown>, preferProductCodes?: string[]): OpenFdaEstablishment | null {
  const reg = asObject(raw['registration']);
  const name = str(reg['name'])?.trim();
  if (!name) return null; // 无法人名 → 跳过（主解析键缺失，不臆造）

  const products = asArray(raw['products']).map(asObject);
  const productCodes = dedupe(products.map((p) => str(p['product_code'])).filter(isNonEmpty));
  const createdDates = products.map((p) => str(p['created_date'])).filter(isNonEmpty).sort();
  // 分类事实取**匹配 ICP 搜索码**的产品（openFDA 返回该 establishment 全部产品、顺序不定；
  // 只看 products[0] 会取到无关设备的专科 → 误导 fit 门）。无匹配退首个带谐调块的产品。
  const deviceFacts = pickDeviceFacts(products, preferProductCodes);
  const deviceNames = dedupe(products.map((p) => first(asObject(p['openfda'])['device_name'])).filter(isNonEmpty));
  const ownerOperatorNumbers = dedupe(products.map((p) => str(p['owner_operator_number'])).filter(isNonEmpty));

  return {
    registrationNumber: str(reg['registration_number']),
    feiNumber: str(reg['fei_number']),
    name,
    country: str(reg['iso_country_code'])?.toUpperCase(),
    city: str(reg['city']),
    stateCode: str(reg['state_code']),
    statusCode: str(reg['status_code']),
    establishmentTypes: asArray(raw['establishment_type']).map(String).filter(isNonEmpty),
    initialImporter: str(reg['initial_importer_flag'])?.toUpperCase() === 'Y',
    productCodes,
    deviceFacts,
    deviceNames,
    ownerOperatorNumbers,
    createdDate: createdDates[0],
  };
}

/** 从产品数组挑分类事实：优先匹配 preferProductCodes 的产品谐调块，否则首个带谐调块的产品；皆无 → undefined。 */
function pickDeviceFacts(products: Record<string, unknown>[], preferProductCodes?: string[]): OpenFdaDeviceFacts | undefined {
  const prefer = new Set((preferProductCodes ?? []).map((c) => c.toUpperCase()));
  const withBlock = products.filter((p) => Object.keys(asObject(p['openfda'])).length > 0);
  const matched = prefer.size ? withBlock.find((p) => prefer.has(str(p['product_code'])?.toUpperCase() ?? '')) : undefined;
  const chosen = matched ?? withBlock[0];
  return chosen ? unpackDeviceFacts(asObject(chosen['openfda'])) : undefined;
}

function unpackDeviceFacts(openfda: Record<string, unknown>): OpenFdaDeviceFacts | undefined {
  const facts: OpenFdaDeviceFacts = {
    deviceName: first(openfda['device_name']),
    deviceClass: first(openfda['device_class']),
    medicalSpecialtyDescription: first(openfda['medical_specialty_description']),
    regulationNumber: first(openfda['regulation_number']),
  };
  return Object.values(facts).some((v) => v != null) ? facts : undefined; // 整块缺失 → undefined
}

/** 拉器械注册（有界样本分页）。网络/错误向上抛，由 provider fail-safe。0 命中返 []（判 error.NOT_FOUND）。 */
export async function searchRegistrations(params: RegistrationSearchParams): Promise<OpenFdaEstablishment[]> {
  const search = buildRegistrationSearch(params);
  const limit = Math.min(params.limit ?? 100, MAX_LIMIT);
  const maxRecords = params.maxRecords ?? limit;
  const out: OpenFdaEstablishment[] = [];
  for (let page = 0; page < MAX_PAGES && out.length < maxRecords; page++) {
    const skip = page * limit;
    if (skip > MAX_SKIP) break; // 深翻超限 → 停（P1 不做 search_after）
    const json = await openFdaGet('/device/registrationlisting.json', { search, limit, skip });
    if (json.error) break; // NOT_FOUND / 其它 → 视作无更多结果
    const results = Array.isArray(json.results) ? json.results : [];
    for (const r of results) {
      const est = mapRegistration(r as Record<string, unknown>, params.productCodes); // 分类事实优先取搜索命中的产品
      if (est) out.push(est);
      if (out.length >= maxRecords) break;
    }
    if (results.length < limit) break; // 最后一页
    await sleep(THROTTLE_MS);
  }
  return out;
}

/** `count=<field>.exact` 服务端聚合（sizing / top 公司）——秒出 term+计数，不拉全量。 */
export async function countField(endpoint: string, field: string, search?: string): Promise<{ term: string; count: number }[]> {
  const json = await openFdaGet(endpoint, { count: `${field}.exact`, ...(search ? { search } : {}) });
  if (json.error || !Array.isArray(json.results)) return [];
  return (json.results as Record<string, unknown>[])
    .map((r) => ({ term: String(r.term ?? ''), count: Number(r.count ?? 0) }))
    .filter((r) => r.term);
}

interface OpenFdaResponse {
  meta?: { results?: { total?: number } };
  results?: unknown[];
  error?: { code?: string; message?: string };
}

/** 带退避的 GET（api-umbrella 无限流头 → 429 感知 + 退避；其余错误状态原样解析交调用方判 error）。 */
async function openFdaGet(path: string, params: Record<string, string | number>, timeoutMs = 30_000): Promise<OpenFdaResponse> {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  if (API_KEY) url.searchParams.set('api_key', API_KEY);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      // 200 与 404(NOT_FOUND) 都是合法 JSON（404 带 error 体）；非 JSON/其它 → 抛。
      if (!res.ok && res.status !== 404) throw new Error(`openfda ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()) as OpenFdaResponse;
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_RETRIES) throw err;
      await sleep(backoff(attempt));
    }
  }
  throw lastErr;
}

// ── 值解包工具（缺键当 null；openFDA 字段多为标量或数组）──────────────────────
function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
}
/** 标量或数组取首个字符串（openfda 块字段常为单元素数组）。 */
function first(v: unknown): string | undefined {
  if (Array.isArray(v)) return v.map(str).find(isNonEmpty);
  return str(v);
}
function isNonEmpty(v: string | undefined): v is string {
  return !!v && v.length > 0;
}
function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}
function backoff(attempt: number): number {
  return 1000 * 2 ** attempt;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
