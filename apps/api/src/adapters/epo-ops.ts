/**
 * EPO OPS（European Patent Office Open Patent Services，`ops.epo.org/3.2`）—— 欧洲专利局官方开放专利服务客户端。
 * 待办 3 第二个身份源：按 applicant(公司) 检索近期专利 → 具名 inventor（工程/研发技术买家）。
 *
 * 契约（以真实 API 实测校准；单测注入假 fetch，不依赖线上形状）：
 *  - **OAuth2 client-credentials**：`POST /3.2/auth/accesstoken`，头 `Authorization: Basic base64(key:secret)`，
 *    体 `grant_type=client_credentials` → `{access_token, expires_in≈1200(秒,字符串)}`。token 进程内缓存 + 过期/401 重取一次。
 *  - `GET /3.2/rest-services/published-data/search/biblio?q=<CQL>&Range=1-N`，头 `Authorization: Bearer <token>`、
 *    `Accept: application/json` → OPS 世界专利数据 JSON（单/数组不定、`$` 文本节点、`@data-format` epodoc/original 并存）。
 *  - CQL：`pa="<applicant>" and pd within "<from> <to>"`（pa=申请人，pd=公开日年份区间）。
 *  - 限流：`X-Throttling-Control` 头；429 + `Retry-After` 退避；免费档 3.5GB/周。
 *
 * 合规（本文件 §7 / decision-maker-p1-epo-ops-inventor-design.md）：
 *  - inventor = 🔴 具名个人（GDPR）。本客户端**数据最小化**：只映射 inventor `name`，
 *    **绝不提取** residence / 地址 / 国籍（源头剥离，非下游过滤）。applicant 国别是公司事实，仅供公司对齐。
 *  - EPO OPS 数据 = CC BY 4.0（署名义务，见 {@link EPO_OPS_ATTRIBUTION}）。
 */

const OPS_BASE = process.env.EPO_OPS_URL ?? 'https://ops.epo.org/3.2';
const AUTH_PATH = '/auth/accesstoken';
const SEARCH_PATH = '/rest-services/published-data/search/biblio';
const THROTTLE_MS = 500; // 429/5xx/网络抖动退避基
const MAX_RETRIES = 2;
const TOKEN_SAFETY_MS = 60_000; // 提前 60s 视 token 过期，避免边界 401
const DEFAULT_RANGE = 25; // 一次检索取的专利条数（与发明人上限同量级即够）

// CC BY 4.0：可商用但**署名是 license 义务**（展示/证据须附）。照 TED CC BY 先例。
export const EPO_OPS_LICENSE = 'CC-BY-4.0';
export const EPO_OPS_ATTRIBUTION = 'Data © European Patent Office (EPO), licensed under CC BY 4.0.';

/** 专利申请人（🟢 公司事实；name 供对齐，country 供国别门）。 */
export interface EpoApplicant {
  name: string;
  /** ISO alpha-2（EPO biblio `residence.country`）；缺则无。 */
  country?: string;
}
/** 专利发明人（🔴 具名个人，**数据最小化**）——只含 name，**不含** residence/地址/国籍。 */
export interface EpoInventor {
  name: string;
}
/** 一条专利的最小画像（对齐 + 发明人抽取所需）。 */
export interface EpoPatentRecord {
  applicants: EpoApplicant[];
  inventors: EpoInventor[];
  /** 公开年（CQL 已按年限过滤，此字段留痕/调试）。 */
  publicationYear?: number;
}

/** 注入点（测试用假 fetch/creds/clock；生产走全局 fetch + env creds + Date.now）。 */
export interface EpoOpsDeps {
  fetchImpl?: typeof fetch;
  consumerKey?: string;
  consumerSecret?: string;
  now?: () => number;
}

// ── CQL 构造（纯）────────────────────────────────────────────────────────────

/** 按申请人 + 公开年区间构造 CQL。🔴 去引号防 CQL 注入（applicant 是我方 company.name，仍消毒）。 */
export function buildApplicantCql(applicant: string, fromYear: number, toYear: number): string {
  const safe = applicant.replace(/"/g, ' ').trim();
  return `pa="${safe}" and pd within "${fromYear} ${toYear}"`;
}

// ── OPS JSON 解包工具（单/数组不定、`$` 文本节点、`@data-format` epodoc/original）──────

function asArray<T>(v: T | T[] | undefined | null): T[] {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
/** OPS 文本节点：字符串直接返回；`{$:"…"}` 取 `$`；否则 undefined。 */
function textOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  const t = obj(v)['$'];
  return typeof t === 'string' ? t : undefined;
}

/** 按 `@sequence` 分组（同一 party 的 epodoc/original 两条归一组）；缺 sequence 时各自成组。 */
function groupBySequence(list: Record<string, unknown>[]): Record<string, unknown>[][] {
  const bySeq = new Map<string, Record<string, unknown>[]>();
  list.forEach((p, i) => {
    const seq = textOf(p['@sequence']) ?? String(p['@sequence'] ?? `#${i}`);
    const g = bySeq.get(seq) ?? [];
    g.push(p);
    bySeq.set(seq, g);
  });
  return [...bySeq.values()];
}
/** 组内选名：优先指定 `@data-format`，回退任一。nameKey=applicant-name/inventor-name。 */
function pickPartyName(group: Record<string, unknown>[], nameKey: string, prefer: 'original' | 'epodoc'): string | undefined {
  const chosen = group.find((h) => h['@data-format'] === prefer) ?? group[0];
  if (!chosen) return undefined;
  return textOf(obj(chosen[nameKey])['name'])?.trim() || undefined;
}

/** 抽申请人（name + 国别）。对齐用 epodoc 归一名（剥法人后缀更稳）；国别取 `residence.country`（公司事实）。 */
export function extractApplicants(parties: Record<string, unknown>): EpoApplicant[] {
  const list = asArray(obj(parties['applicants'])['applicant']).map(obj);
  const out: EpoApplicant[] = [];
  for (const group of groupBySequence(list)) {
    const name = pickPartyName(group, 'applicant-name', 'epodoc');
    if (!name) continue;
    const withCountry = group.find((h) => obj(h['residence'])['country'] != null) ?? group[0];
    const country = textOf(obj(withCountry['residence'])['country'])?.trim();
    out.push({ name, country: country || undefined });
  }
  return out;
}

/**
 * 抽发明人（🔴 **数据最小化**：只 name）。显示名优先 `original`（自然语序），
 * **绝不**读 residence/地址/国籍（源头剥离，GDPR Art.5(1)(c)）。
 */
export function extractInventors(parties: Record<string, unknown>): EpoInventor[] {
  const list = asArray(obj(parties['inventors'])['inventor']).map(obj);
  const out: EpoInventor[] = [];
  for (const group of groupBySequence(list)) {
    const name = pickPartyName(group, 'inventor-name', 'original');
    if (name) out.push({ name }); // 🔴 只 name，无 residence
  }
  return out;
}

/** 抽公开年（`publication-reference.document-id[].date` YYYYMMDD → year）。 */
export function extractPublicationYear(biblio: Record<string, unknown>): number | undefined {
  const docIds = asArray(obj(biblio['publication-reference'])['document-id']).map(obj);
  for (const d of docIds) {
    const dateStr = textOf(d['date']);
    if (dateStr && /^\d{4}/.test(dateStr)) return Number(dateStr.slice(0, 4));
  }
  return undefined;
}

/** OPS biblio-search JSON → EpoPatentRecord[]（防御式解包，缺键当空）。 */
export function parseSearchResult(json: unknown): EpoPatentRecord[] {
  const search = obj(obj(obj(json)['ops:world-patent-data'])['ops:biblio-search']);
  const result = obj(search['ops:search-result']);
  // exchange-documents 可能是 [{exchange-document:…}] 或 {exchange-document:[…]}——asArray 双向兼容。
  const docs: Record<string, unknown>[] = [];
  for (const container of asArray(result['exchange-documents']).map(obj)) {
    for (const d of asArray(container['exchange-document'])) docs.push(obj(d));
  }
  return docs.map((doc) => {
    const biblio = obj(doc['bibliographic-data']);
    const parties = obj(biblio['parties']);
    return {
      applicants: extractApplicants(parties),
      inventors: extractInventors(parties),
      publicationYear: extractPublicationYear(biblio),
    };
  });
}

// ── OPS 客户端（OAuth token 管理 + 检索）──────────────────────────────────────

interface AuthResponse {
  access_token?: string;
  expires_in?: string | number;
}

/**
 * EPO OPS 客户端。token 进程内缓存（跨调用复用，省重复鉴权）；过期或 401 → 重取一次（有界）。
 * 生产：module 单例 {@link epoOps}（creds 走 env）。测试：`new EpoOpsClient({fetchImpl, consumerKey, consumerSecret, now})` 隔离。
 */
export class EpoOpsClient {
  private token?: { value: string; expiresAt: number };

  constructor(private readonly deps?: EpoOpsDeps) {}

  private now(): number {
    return this.deps?.now?.() ?? Date.now();
  }
  private fetchImpl(): typeof fetch {
    return this.deps?.fetchImpl ?? fetch;
  }
  private creds(): { key: string; secret: string } {
    const key = this.deps?.consumerKey ?? process.env.EPO_OPS_CONSUMER_KEY;
    const secret = this.deps?.consumerSecret ?? process.env.EPO_OPS_CONSUMER_SECRET;
    if (!key || !secret) throw new Error('EPO_OPS_CONSUMER_KEY/EPO_OPS_CONSUMER_SECRET not configured');
    return { key, secret };
  }

  /** 取 access_token（缓存命中且未过期 → 复用；否则鉴权）。无 creds → 抛（provider fail-safe 捕获）。 */
  async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.token && this.token.expiresAt > this.now()) return this.token.value;
    const { key, secret } = this.creds();
    const auth = `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`;
    const res = await this.fetchImpl()(`${OPS_BASE}${AUTH_PATH}`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`epo-ops auth ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as AuthResponse;
    if (!json.access_token) throw new Error('epo-ops auth: no access_token in response');
    const ttlMs = (Number(json.expires_in) || 1200) * 1000;
    this.token = { value: json.access_token, expiresAt: this.now() + ttlMs - TOKEN_SAFETY_MS };
    return this.token.value;
  }

  /**
   * 按申请人检索近期专利（含 applicants + inventors）。网络/鉴权失败向上抛，由 provider fail-safe。
   * 429/5xx 退避；401 刷新 token 重试一次；404/空 → []。
   */
  async searchPatentsByApplicant(
    applicant: string,
    opts: { fromYear: number; toYear: number; range?: number },
  ): Promise<EpoPatentRecord[]> {
    const q = applicant.trim();
    if (!q) return [];
    const url = new URL(`${OPS_BASE}${SEARCH_PATH}`);
    url.searchParams.set('q', buildApplicantCql(q, opts.fromYear, opts.toYear));
    url.searchParams.set('Range', `1-${opts.range ?? DEFAULT_RANGE}`);

    let token = await this.getToken();
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await this.fetchImpl()(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 401 && attempt < MAX_RETRIES) {
          token = await this.getToken(true); // token 失效 → 强制刷新重试
          continue;
        }
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
          const retryAfter = Number(res.headers.get('retry-after'));
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
          continue;
        }
        if (res.status === 404) return []; // 无命中 → 空（不抛）
        if (!res.ok) throw new Error(`epo-ops search ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return parseSearchResult(await res.json());
      } catch (err) {
        lastErr = err;
        if (attempt === MAX_RETRIES) throw err;
        await sleep(backoff(attempt));
      }
    }
    throw lastErr;
  }
}

/** 生产单例（creds 走 env；token 跨工具调用复用）。 */
export const epoOps = new EpoOpsClient();

function backoff(attempt: number): number {
  return THROTTLE_MS * 2 ** attempt;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
