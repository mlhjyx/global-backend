/**
 * TED（Tenders Electronic Daily）Search API v3 —— 欧盟公共采购官方公报，零鉴权 REST 客户端。
 * 中标公告（award notice）= 具名中标供应商 + 国别 + 税号（+ 常有官网）→ 可解析的活跃公司。
 *
 * 契约据 docs/backend/ted-provider-spec.md §1（2026-07-08 活体实测 + 对抗复验）：
 *  - `POST https://api.ted.europa.eu/v3/notices/search`，body 严格拒未知顶层键；排序写进 query 串。
 *  - expert query：`field OP value ... SORT BY field [DESC]`；日期用相对函数 `today(-N)`（首选）。
 *  - `limit≤250`；超 1.5 万走 `paginationMode:"ITERATION"` 滚动（token 原样回传，query 全程不变）。
 *  - 多语言对象（winner-name/buyer-name）按 lang key 解包（eng 优先）；**缺键即省略 → 当 null**。
 *  - 无限流响应头 → WAF 以 429/403/CAPTCHA 出现 → 自限 ~1 req/s + 4xx 退避。
 *
 * 合规：官方 REST（不爬），绿事实（公司/组织/CPV/日期）可商用但带 CC BY 4.0 署名义务（§3.1）。
 * 本客户端只请求 🟢 绿字段，**绝不请求 winner-email 等 🔴 具名联系点**（个人数据，走隔离路径）。
 */

const SEARCH_URL = process.env.TED_API_URL ?? 'https://api.ted.europa.eu/v3/notices/search';
const MAX_LIMIT = 250; // API 硬上限（500 报 "exceeds maximum allowed value (250)"）
const THROTTLE_MS = 1100; // 自限 ~1 req/s（WAF 无限流头，spec §1.6）
const MAX_RETRIES = 2; // 429/403/5xx/网络抖动退避重试
const MAX_PAGES = 200; // iteration 安全阀（有界样本，绝不 grind 全量）

/** 中标发现只取绿事实字段（🟢 公司/组织事实）；绝不含 winner-email 等 🔴 个人联系点。 */
const AWARD_FIELDS = [
  'publication-number',
  'publication-date',
  'notice-type',
  'form-type',
  'classification-cpv',
  'buyer-name',
  'buyer-country',
  'winner-name',
  'winner-country',
  'winner-identifier',
  'winner-internet-address',
  'winner-city',
];

export interface AwardQueryParams {
  /** 8 位 CPV 码或前缀通配（如 `421*`）。必填 —— TED 发现绝不裸拉全库。 */
  cpvCodes: string[];
  /** 买方国别 ISO-3（DEU/FRA…）；空则不加国别子句。 */
  buyerCountries?: string[];
  /** publication-date>=today(-N)，默认 30。 */
  sinceDays?: number;
  /** 默认 can-standard（中标公告）；招标用 cn-standard。 */
  noticeType?: string;
}

export interface SearchAwardParams extends AwardQueryParams {
  /** 每页条数，≤250。 */
  limit?: number;
  /** ALL=全历史全版本 · ACTIVE=当前开放 · LATEST=最新切片。默认 ACTIVE。 */
  scope?: 'ALL' | 'ACTIVE' | 'LATEST';
  /** 跨页累计上限（有界样本）。默认 = limit。 */
  maxRecords?: number;
}

export interface TedWinner {
  name: string;
  /** ISO-3 国别。 */
  country?: string;
  /** 国家税号/注册号（法人标识，🟢）。 */
  identifier?: string;
  /** 公司官网（经常缺；仅在可安全归属时置值，绝不臆造）。 */
  internetAddress?: string;
  city?: string;
}

export interface TedAwardNotice {
  publicationNumber?: string;
  /** 形如 "2026-07-08+02:00"（日期 + 时区偏移，非全时间戳）。 */
  publicationDate?: string;
  noticeType?: string;
  formType?: string;
  cpvCodes: string[];
  buyerNames: string[];
  buyerCountries: string[];
  winners: TedWinner[];
}

/** expert query 串（过滤 + 排序一体）。空 CPV 抛错（绝不裸拉全库）。 */
export function buildAwardQuery(p: AwardQueryParams): string {
  if (!p.cpvCodes.length) {
    throw new Error('buildAwardQuery: cpvCodes required (TED 发现必须带 CPV 分类过滤)');
  }
  const sinceDays = p.sinceDays ?? 30;
  const noticeType = p.noticeType ?? 'can-standard';
  const parts = [clause('classification-cpv', p.cpvCodes)];
  const countries = (p.buyerCountries ?? []).map((c) => c.toUpperCase()).filter(Boolean);
  if (countries.length) parts.push(clause('buyer-country', countries));
  parts.push(`notice-type=${noticeType}`);
  parts.push(`publication-date>=today(-${sinceDays})`);
  return `${parts.join(' AND ')} SORT BY publication-date DESC`;
}

/** 单值用 `=`，多值用 `IN (a b c)`（空格分隔、括号）。 */
function clause(field: string, values: string[]): string {
  return values.length === 1 ? `${field}=${values[0]}` : `${field} IN (${values.join(' ')})`;
}

/**
 * 一条原始 notice（按 field 名投影的对象）→ 归一 TedAwardNotice。
 * 多语言解包 eng 优先；缺键当 null；winner-* 按位对齐 per-winner 数组（别天真跨字段 zip）。
 */
export function mapAwardNotice(raw: Record<string, unknown>): TedAwardNotice {
  const names = unpackMultilang(raw['winner-name']);
  const countries = asStringArray(raw['winner-country']);
  const identifiers = asStringArray(raw['winner-identifier']);
  const urls = asStringArray(raw['winner-internet-address']);
  const cities = asStringArray(raw['winner-city']);
  const winners: TedWinner[] = names.map((name, i) => ({
    name,
    country: countries[i],
    identifier: identifiers[i],
    city: cities[i],
    internetAddress: attributeUrl(urls, names.length, i),
  }));
  return {
    publicationNumber: firstString(raw['publication-number']),
    publicationDate: firstString(raw['publication-date']),
    noticeType: firstString(raw['notice-type']),
    formType: firstString(raw['form-type']),
    cpvCodes: asStringArray(raw['classification-cpv']),
    buyerNames: unpackMultilang(raw['buyer-name']),
    buyerCountries: asStringArray(raw['buyer-country']),
    winners,
  };
}

/**
 * 官网 URL → 中标方归属（身份安全，绝不臆造）：
 *  - URL 数 == 中标方数 → 按位对齐；
 *  - 仅一个中标方 → 取首个 URL；
 *  - 其余（多方且数量不等）→ 不归属（回退 name+country key，避免贴错身份）。
 */
function attributeUrl(urls: string[], winnerCount: number, i: number): string | undefined {
  if (!urls.length) return undefined;
  if (urls.length === winnerCount) return urls[i];
  if (winnerCount === 1) return urls[0];
  return undefined;
}

/** 拉中标公告（iteration 滚动，累计到 maxRecords 或翻完为止）。网络失败向上抛，由 provider fail-safe。 */
export async function searchAwardNotices(params: SearchAwardParams): Promise<TedAwardNotice[]> {
  const query = buildAwardQuery(params);
  const limit = Math.min(params.limit ?? MAX_LIMIT, MAX_LIMIT);
  const maxRecords = params.maxRecords ?? limit;
  const scope = params.scope ?? 'ACTIVE';

  const out: TedAwardNotice[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES && out.length < maxRecords; page++) {
    const body: Record<string, unknown> = {
      query,
      fields: AWARD_FIELDS,
      limit,
      scope,
      paginationMode: 'ITERATION',
      // §8.1：ALL 回填必设 onlyLatestVersions，否则被更正的 notice 以旧版本重复摄入，污染发现/intent 历史。
      ...(scope === 'ALL' ? { onlyLatestVersions: true } : {}),
    };
    if (token) body.iterationNextToken = token;

    const json = await tedPost(body);
    const notices = Array.isArray(json.notices) ? json.notices : [];
    for (const n of notices) {
      out.push(mapAwardNotice(n as Record<string, unknown>));
      if (out.length >= maxRecords) break;
    }
    token = typeof json.iterationNextToken === 'string' && json.iterationNextToken ? json.iterationNextToken : undefined;
    if (!token || !notices.length) break;
    await sleep(THROTTLE_MS);
  }
  return out;
}

interface TedSearchResponse {
  notices?: unknown[];
  iterationNextToken?: string;
  totalNoticeCount?: number;
}

async function tedPost(body: Record<string, unknown>): Promise<TedSearchResponse> {
  const res = await tedFetch(body);
  if (!res.ok) throw new Error(`ted ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as TedSearchResponse;
}

/** 带退避的 POST：429/403/5xx/网络错误重试；其余状态原样交回由调用方判定（不误重试 400 语法错）。 */
async function tedFetch(body: Record<string, unknown>, timeoutMs = 30_000): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if ((res.status === 429 || res.status === 403 || res.status >= 500) && attempt < MAX_RETRIES) {
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

// ── 值解包工具（缺键当 null；多语言 eng 优先）──────────────────────────────────

const LANG_PREFERENCE = ['eng', 'en'];

function asStringArray(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter((x) => x != null).map((x) => String(x));
  if (typeof v === 'string') return [v];
  if (typeof v === 'number' || typeof v === 'boolean') return [String(v)];
  return [];
}

/** 多语言对象 `{lang: string[]}` → eng 优先解包；plain 数组/标量原样成数组。 */
function unpackMultilang(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v) || typeof v === 'string') return asStringArray(v);
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (!keys.length) return [];
    const key = LANG_PREFERENCE.find((k) => k in obj) ?? keys[0];
    return asStringArray(obj[key]);
  }
  return [];
}

/** 标量字段取首值（多语言对象取 eng 优先首项）。 */
function firstString(v: unknown): string | undefined {
  const arr =
    typeof v === 'object' && v !== null && !Array.isArray(v) ? unpackMultilang(v) : asStringArray(v);
  return arr[0];
}

function backoff(attempt: number): number {
  return 1000 * 2 ** attempt; // 1s, 2s
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
