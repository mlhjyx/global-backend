/**
 * INPI RNE dirigeants —— 法国公司注册处法定负责人，经**开放政务网关** API Recherche d'entreprises
 * (`recherche-entreprises.api.gouv.fr`，DINUM 维护；数据源 = **INPI RNE + INSEE Sirene**)。
 * 待办 3 第三个身份源：dirigeant (personne physique) = 具名经济买家 → **name-merge**（无 Tier 0）。
 *
 * 契约（2026-07-11 实测）：
 *  - **零鉴权** REST：`GET /search?q=<名>&page=1&per_page=N`（7 req/s 限流）。
 *  - 响应 `{results[{siren, nom_raison_sociale, nom_complet, etat_administratif, dirigeants[]}],
 *    total_results, page, per_page, total_pages}`。
 *  - `dirigeants[]` 两型：
 *    · personne physique：`{nom, prenoms, qualite, type_dirigeant, (+DOB/nationalite —— 🔴 不摄)}`
 *    · personne morale：`{siren, denomination, qualite, type_dirigeant}` —— **跳过**（法人负责人非自然人买家）
 *
 * 合规（design §7 / trade-fair-intelligence.md §0）：
 *  - dirigeant = 🔴 具名个人（GDPR）。本客户端**数据最小化**：只映射 `nom / prenoms / qualite`，
 *    **绝不提取** date_de_naissance / annee_de_naissance / nationalite（源头剥离，非下游过滤）。
 *  - 数据 = Licence Ouverte 2.0（Etalab），可商用但**署名是 license 义务**（见 INPI_RNE_ATTRIBUTION）。
 *  - 开放网关**自动排除** entreprises non-diffusibles（选择不公示者不返回）——合规内建。
 */

const BASE_URL = process.env.INPI_RNE_API_URL ?? 'https://recherche-entreprises.api.gouv.fr';
const THROTTLE_MS = 300; // 自限（7 req/s 上限，留大余量）
const MAX_RETRIES = 2; // 429/5xx/网络抖动退避
const DEFAULT_SEARCH_LIMIT = 10;

// Licence Ouverte 2.0（Etalab）：公共部门信息可商用、**署名是 license 义务**（展示/证据须附）。
export const INPI_RNE_LICENSE = 'Licence-Ouverte-2.0';
export const INPI_RNE_ATTRIBUTION =
  "Données INSEE (Sirene) et INPI (Registre National des Entreprises) via l'API Recherche d'entreprises (DINUM), Licence Ouverte 2.0.";

/**
 * 法国 dirigeant（🔴 具名个人，**数据最小化**）。
 * 只含身份归并所需的最小字段——**不含** DOB / annee_de_naissance / nationalite（`mapDirigeant` 从不映射）。
 */
export interface FrDirigeant {
  /** 姓（nom）。 */
  nom: string;
  /** 名（prénoms）——可空（部分记录仅姓）。 */
  prenoms?: string;
  /** 职务（Gérant / Président de SAS / Directeur Général…）——显示归一在 provider 层做。 */
  qualite: string;
}

/** 法国公司搜索命中（🟢 公司事实 + 内联 dirigeants）。 */
export interface FrCompanyHit {
  siren: string;
  /** 法定名（nom_raison_sociale，缺则 nom_complet）——公司对齐用。 */
  name: string;
  /** 'A' active / 'C' cessée —— 只对齐 active（对齐 CH 只留 active）。 */
  etatAdministratif: string;
  /** 只含 personne physique dirigeant（已剥离 personne morale / 审计师 / DOB / 国籍）。 */
  dirigeants: FrDirigeant[];
}

/** 注入点（测试用假 fetch；生产走全局 fetch，无 key）。 */
export interface InpiRneDeps {
  fetchImpl?: typeof fetch;
}

/** 审计师 qualite（外部会计师，非买方委员会）——即便 personne physique 也跳过。 */
function isAuditor(qualite: string): boolean {
  return /commissaire aux comptes/i.test(qualite);
}

/**
 * 一条原始 dirigeant → FrDirigeant（🔴 具名个人，**数据最小化**）。
 * 🔴 只取 nom / prenoms / qualite —— **绝不**读 date_de_naissance / annee_de_naissance / nationalite
 *    （GDPR Art.5(1)(c) 最小化，源头剥离，即便 API 主动吐出）。
 * 跳过 → null：personne morale（法人负责人）/ commissaire aux comptes（审计师）/ 缺 nom|qualite。
 */
export function mapDirigeant(raw: Record<string, unknown>): FrDirigeant | null {
  if (str(raw['type_dirigeant'])?.trim().toLowerCase() !== 'personne physique') return null;
  const nom = str(raw['nom'])?.trim();
  const qualite = str(raw['qualite'])?.trim();
  if (!nom || !qualite) return null;
  if (isAuditor(qualite)) return null;
  return { nom, prenoms: str(raw['prenoms'])?.trim() || undefined, qualite };
}

/**
 * 一条 search 命中 → FrCompanyHit（🟢 公司事实）。缺 siren/name → null（主键缺失，不臆造）。
 * dirigeants 内联提取（数据最小化 map，非 physique / 审计师被 mapDirigeant 剥掉）。
 */
export function mapCompanyHit(raw: Record<string, unknown>): FrCompanyHit | null {
  const siren = str(raw['siren'])?.trim();
  const name = (str(raw['nom_raison_sociale']) || str(raw['nom_complet']))?.trim();
  if (!siren || !name) return null;
  const rawDirs = Array.isArray(raw['dirigeants']) ? raw['dirigeants'] : [];
  const dirigeants = rawDirs
    .map((d) => mapDirigeant(d as Record<string, unknown>))
    .filter((d): d is FrDirigeant => d !== null);
  return {
    siren,
    name,
    etatAdministratif: str(raw['etat_administratif'])?.trim().toUpperCase() ?? '',
    dirigeants,
  };
}

/**
 * 按公司名搜法国注册库（dirigeants 内联在响应，一跳同得公司+负责人）。
 * 网络失败向上抛，由 provider fail-safe（诚实降级空）。
 */
export async function searchCompaniesWithDirigeants(
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
  deps?: InpiRneDeps,
): Promise<FrCompanyHit[]> {
  const q = query.trim();
  if (!q) return [];
  const json = await rneGet('/search', { q, page: 1, per_page: limit }, deps);
  const results = Array.isArray(json.results) ? json.results : [];
  return results.map((r) => mapCompanyHit(r as Record<string, unknown>)).filter((c): c is FrCompanyHit => c !== null);
}

interface RneResponse {
  results?: unknown[];
  total_results?: number;
}

/** 带退避的 GET（无鉴权；429/5xx 退避；404 当空不抛）。 */
async function rneGet(
  path: string,
  params: Record<string, string | number>,
  deps?: InpiRneDeps,
  timeoutMs = 20_000,
): Promise<RneResponse> {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      if (res.status === 404) return {}; // 无命中 → 空（不抛）
      if (!res.ok) throw new Error(`inpi-rne ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()) as RneResponse;
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_RETRIES) throw err;
      await sleep(backoff(attempt));
    }
  }
  throw lastErr;
}

// ── 值解包工具（缺键当 null）────────────────────────────────────────────────
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
}
function backoff(attempt: number): number {
  return THROTTLE_MS * 2 ** attempt;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
