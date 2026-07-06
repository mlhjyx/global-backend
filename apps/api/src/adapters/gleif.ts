/**
 * GLEIF LEI 结构化富集源（Global Legal Entity Identifier Foundation 官方开放 API）。
 * 免费、无需鉴权，CC0 开放数据。按「法人名 + 国家」查 LEI 记录，拿到：
 *   LEI 码 + 官方法人名 + 法人形式(ELF) + 实体/登记状态 + 注册地址 + 直接/最终母公司。
 *
 * 定位：**富集**（enrichment），不是发现入口 —— GLEIF 按名称/国家索引，不按行业。
 * 给已归一的 canonical 公司补「法律身份 + 母子关系」，改变 B2B 触达策略
 * （子公司 vs 集团总部的决策链不同）。
 *
 * 合规：https://www.gleif.org/en/about/data-use 明确公共领域可自由使用；
 * 官方限流约束宽松，本客户端逐条请求、带超时、404 视为「未申报」优雅降级。
 */

const BASE = process.env.GLEIF_API_URL ?? 'https://api.gleif.org/api/v1';
const ACCEPT = 'application/vnd.api+json';
const MAX_RETRIES = 2; // 瞬时抖动/限流下不静默丢富集

/**
 * 带退避重试的 GLEIF 请求：429/5xx/网络错误各重试一次（尊重 Retry-After）。
 * 404 交给调用方（母公司未申报是正常语义，不重试）。
 */
async function gleifFetch(url: string, timeoutMs = 25_000): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: ACCEPT }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || res.status >= 500) {
        if (attempt === MAX_RETRIES) return res; // 用尽后把响应交回，由调用方抛错
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err; // 网络/超时错误：退避后重试
      if (attempt === MAX_RETRIES) throw err;
      await sleep(backoff(attempt));
    }
  }
  throw lastErr;
}

function backoff(attempt: number): number {
  return 500 * 2 ** attempt; // 500ms, 1s
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface GleifRecord {
  lei: string;
  legalName: string;
  legalFormId?: string;
  entityStatus?: string; // ACTIVE / INACTIVE
  registrationStatus?: string; // ISSUED / LAPSED / RETIRED ...
  country?: string;
  city?: string;
  /** 该记录声明了直接/最终母公司关系（细节需再取 direct-parent 端点） */
  hasDirectParent?: boolean;
  hasUltimateParent?: boolean;
}

export interface GleifParent {
  lei: string;
  legalName: string;
  country?: string;
}

interface JsonApiEntity {
  attributes?: {
    lei?: string;
    entity?: {
      legalName?: { name?: string };
      legalForm?: { id?: string; other?: string | null };
      status?: string;
      legalAddress?: { city?: string; country?: string };
    };
    registration?: { status?: string };
  };
  relationships?: Record<string, { links?: { 'relationship-record'?: string; 'related-record'?: string } }>;
}

/** 按法人名（contains 匹配）+ 可选国家查 LEI 记录。调用方负责最佳匹配 + 置信度门槛。 */
export async function searchLeiRecords(params: {
  name: string;
  country?: string;
  limit?: number;
}): Promise<GleifRecord[]> {
  const { name, country, limit = 10 } = params;
  const qs = new URLSearchParams();
  qs.set('filter[entity.legalName]', name);
  if (country) qs.set('filter[entity.legalAddress.country]', country.toUpperCase());
  qs.set('page[size]', String(Math.min(limit, 50)));

  const res = await gleifFetch(`${BASE}/lei-records?${qs.toString()}`);
  if (!res.ok) throw new Error(`gleif ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { data?: JsonApiEntity[] };
  return (json.data ?? []).map(mapRecord).filter((r): r is GleifRecord => r !== null);
}

/** 取直接母公司（无申报或隐私例外 → 404 → 返回 null，属正常）。 */
export async function getDirectParent(lei: string): Promise<GleifParent | null> {
  return fetchParent(`${BASE}/lei-records/${encodeURIComponent(lei)}/direct-parent`);
}

/** 取最终母公司（集团顶层）。 */
export async function getUltimateParent(lei: string): Promise<GleifParent | null> {
  return fetchParent(`${BASE}/lei-records/${encodeURIComponent(lei)}/ultimate-parent`);
}

async function fetchParent(url: string): Promise<GleifParent | null> {
  const res = await gleifFetch(url);
  if (res.status === 404) return null; // 未申报母公司（例外原因或本就无母公司）
  if (!res.ok) throw new Error(`gleif parent ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const json = (await res.json()) as { data?: JsonApiEntity };
  const rec = json.data ? mapRecord(json.data) : null;
  if (!rec) return null;
  return { lei: rec.lei, legalName: rec.legalName, country: rec.country };
}

function mapRecord(e: JsonApiEntity): GleifRecord | null {
  const lei = e.attributes?.lei;
  const legalName = e.attributes?.entity?.legalName?.name;
  if (!lei || !legalName) return null;
  const ent = e.attributes!.entity!;
  const rels = e.relationships ?? {};
  return {
    lei,
    legalName,
    legalFormId: ent.legalForm?.id ?? undefined,
    entityStatus: ent.status,
    registrationStatus: e.attributes?.registration?.status,
    country: ent.legalAddress?.country,
    city: ent.legalAddress?.city,
    hasDirectParent: !!rels['direct-parent']?.links?.['relationship-record'],
    hasUltimateParent: !!rels['ultimate-parent']?.links?.['relationship-record'],
  };
}
