/**
 * Wikidata 结构化企业发现（零爬取的公开开放数据源）。
 * 通过 SPARQL 按「行业 + 国家 + 有官网」直接查出公司名 + 官网 + 员工数 + 坐标，
 * 官网再交给现有 Crawl4AI→Gemini 富化。属 CompanyRegistry/IndustryData 类能力。
 *
 * 合规：Wikidata 是 CC0 公开数据，官方 SPARQL 端点，遵守其 UA 与限流约定。
 */

const ENDPOINT = process.env.WIKIDATA_SPARQL_URL ?? 'https://query.wikidata.org/sparql';
const WD_API = process.env.WIKIDATA_API_URL ?? 'https://www.wikidata.org/w/api.php';
const USER_AGENT = process.env.WIKIDATA_UA ?? 'GlobalDiscoveryBot/1.0 (b2b discovery; contact ops)';

export interface WikidataCompany {
  qid: string;
  name: string;
  website?: string;
  employees?: number;
  countryCode?: string;
  latitude?: number;
  longitude?: number;
}

interface SparqlBinding {
  [k: string]: { type: string; value: string } | undefined;
}

/**
 * 按行业 QID + 国家 QID 发现公司。industryQids/countryQid 由查询计划映射提供
 * （词表归一层的产物：ICP 行业词 → Wikidata QID）。
 * 例：金属加工机械制造 industry，德国 country。
 */
export async function discoverCompaniesByIndustry(params: {
  industryQids: string[];
  countryQid?: string;
  requireWebsite?: boolean;
  limit?: number;
}): Promise<WikidataCompany[]> {
  const { industryQids, countryQid, requireWebsite = true, limit = 50 } = params;
  if (!industryQids.length) return [];

  const values = industryQids.map((q) => `wd:${q}`).join(' ');
  const websiteClause = requireWebsite ? '?company wdt:P856 ?website .' : 'OPTIONAL { ?company wdt:P856 ?website }';
  const countryClause = countryQid ? `?company wdt:P17 wd:${countryQid} .` : '';
  const query = `
SELECT ?company ?companyLabel ?website ?employees ?coord ?countryCode WHERE {
  VALUES ?industry { ${values} }
  ?company wdt:P452 ?industry .
  ${countryClause}
  ${websiteClause}
  OPTIONAL { ?company wdt:P1128 ?employees }
  OPTIONAL { ?company wdt:P625 ?coord }
  OPTIONAL { ?company wdt:P17 ?country . ?country wdt:P297 ?countryCode }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,de,zh" }
} LIMIT ${Math.min(limit, 200)}`;

  const rows = await runSparql(query);
  return rows.map(bindingToCompany).filter((c): c is WikidataCompany => c !== null);
}

/** 通用 SPARQL 执行（供未来更多结构化查询复用）。 */
export async function runSparql(query: string, timeoutMs = 40_000): Promise<SparqlBinding[]> {
  const res = await fetch(`${ENDPOINT}?query=${encodeURIComponent(query)}`, {
    headers: { Accept: 'application/sparql-results+json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`wikidata ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { results?: { bindings?: SparqlBinding[] } };
  return json.results?.bindings ?? [];
}

// ── Wikidata REST API（www.wikidata.org/w/api.php）——用于按名富集 ──────────────
// 与 SPARQL 发现互补，且不依赖 query.wikidata.org（该端点偶发限流/不可达）。

export interface WikidataEntitySummary {
  qid: string;
  label: string;
  description?: string;
}

/** wbsearchentities：按名（模糊）搜实体，返回 QID + 标签 + 描述（描述助消歧）。 */
export async function wikidataSearchEntity(name: string, limit = 7): Promise<WikidataEntitySummary[]> {
  const url =
    `${WD_API}?action=wbsearchentities&search=${encodeURIComponent(name)}` +
    `&language=en&uselang=en&type=item&format=json&origin=*&limit=${Math.min(limit, 20)}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`wikidata search ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const json = (await res.json()) as { search?: { id: string; label?: string; description?: string }[] };
  return (json.search ?? [])
    .filter((r) => r.id && r.label)
    .map((r) => ({ qid: r.id, label: r.label!, description: r.description }));
}

export interface RawEntity {
  claims?: Record<string, { mainsnak?: { datavalue?: { value?: unknown } }; qualifiers?: Record<string, unknown[]> }[]>;
  labels?: Record<string, { value?: string }>;
}

/** wbgetentities：批量取实体（claims + labels，英文）。 */
export async function wikidataGetEntities(
  qids: string[],
  props = 'claims|labels',
): Promise<Record<string, RawEntity>> {
  if (!qids.length) return {};
  const url =
    `${WD_API}?action=wbgetentities&ids=${qids.slice(0, 50).join('|')}` +
    `&props=${encodeURIComponent(props)}&languages=en&format=json&origin=*`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`wikidata getentities ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const json = (await res.json()) as { entities?: Record<string, RawEntity> };
  return json.entities ?? {};
}

export interface WikidataCompanyFacts {
  qid: string;
  label: string;
  isCompany: boolean;
  website?: string;
  industries: string[];
  products: string[];
  employees?: number;
  inceptionYear?: number;
  parentQid?: string;
  parentName?: string;
  subsidiaryCount?: number;
  lei?: string;
  isin?: string;
  countryQid?: string;
  countryName?: string;
  headquartersName?: string;
  stockExchangeName?: string;
}

// Wikidata 属性号
const P = {
  instanceOf: 'P31',
  industry: 'P452',
  product: 'P1056',
  employees: 'P1128',
  inception: 'P571',
  parent: 'P749',
  subsidiary: 'P355',
  lei: 'P1278',
  isin: 'P946',
  website: 'P856',
  country: 'P17',
  headquarters: 'P159',
  stockExchange: 'P414',
} as const;

// 判「是公司/组织」的 instance-of 目标（含常见子类）
const COMPANY_INSTANCE_QIDS = new Set([
  'Q4830453', 'Q6881511', 'Q783794', 'Q891723', 'Q18388277', 'Q43229', 'Q167037',
  'Q4830453', 'Q1058914', 'Q210167', 'Q2085381', 'Q3918', 'Q1589009',
]);

function values(e: RawEntity, prop: string): unknown[] {
  return (e.claims?.[prop] ?? []).map((c) => c.mainsnak?.datavalue?.value).filter((v) => v != null);
}
function entityIds(e: RawEntity, prop: string): string[] {
  return values(e, prop)
    .map((v) => (v as { id?: string })?.id)
    .filter((x): x is string => !!x);
}
function strings(e: RawEntity, prop: string): string[] {
  return values(e, prop).filter((v): v is string => typeof v === 'string');
}
function quantityLatest(e: RawEntity, prop: string): number | undefined {
  const claims = e.claims?.[prop] ?? [];
  let best: { amount: number; when: string } | undefined;
  for (const c of claims) {
    const amt = (c.mainsnak?.datavalue?.value as { amount?: string } | undefined)?.amount;
    if (amt == null) continue;
    const when =
      ((c.qualifiers?.['P585']?.[0] as { datavalue?: { value?: { time?: string } } } | undefined)?.datavalue?.value
        ?.time as string) ?? '';
    if (!best || when > best.when) best = { amount: Number(amt), when };
  }
  return best ? Math.round(best.amount) : undefined;
}
function yearOf(e: RawEntity, prop: string): number | undefined {
  const t = (values(e, prop)[0] as { time?: string } | undefined)?.time;
  const m = t?.match(/^[+-](\d{4})/);
  return m ? Number(m[1]) : undefined;
}

/**
 * 解析一个实体为公司事实。referencedLabels 提供被引 QID（行业/产品/母公司/国家…）的英文标签。
 * isCompany：instance-of 命中公司类，或具备公司性属性（行业/员工/官网/LEI）之一。
 */
export function parseCompanyFacts(
  qid: string,
  e: RawEntity,
  referencedLabels: Record<string, string>,
): WikidataCompanyFacts {
  const instanceOf = entityIds(e, P.instanceOf);
  const industries = entityIds(e, P.industry);
  const products = entityIds(e, P.product);
  const parentQid = entityIds(e, P.parent)[0];
  const countryQid = entityIds(e, P.country)[0];
  const lei = strings(e, P.lei)[0];
  const website = strings(e, P.website)[0];
  const label = e.labels?.en?.value ?? qid;
  const isCompany =
    instanceOf.some((q) => COMPANY_INSTANCE_QIDS.has(q)) ||
    industries.length > 0 ||
    !!lei ||
    (!!website && quantityLatest(e, P.employees) != null);

  const lbl = (q?: string) => (q ? referencedLabels[q] : undefined);
  return {
    qid,
    label,
    isCompany,
    website: website || undefined,
    industries: industries.map((q) => lbl(q)).filter((x): x is string => !!x),
    products: products.map((q) => lbl(q)).filter((x): x is string => !!x),
    employees: quantityLatest(e, P.employees),
    inceptionYear: yearOf(e, P.inception),
    parentQid,
    parentName: lbl(parentQid),
    subsidiaryCount: entityIds(e, P.subsidiary).length || undefined,
    lei,
    isin: strings(e, P.isin)[0],
    countryQid,
    countryName: lbl(countryQid),
    headquartersName: lbl(entityIds(e, P.headquarters)[0]),
    stockExchangeName: lbl(entityIds(e, P.stockExchange)[0]),
  };
}

/** 收集一个实体里所有需要解析标签的被引 QID（行业/产品/母公司/国家/总部/交易所）。 */
export function referencedQids(e: RawEntity): string[] {
  return [
    ...entityIds(e, P.industry),
    ...entityIds(e, P.product),
    ...entityIds(e, P.parent),
    ...entityIds(e, P.country),
    ...entityIds(e, P.headquarters),
    ...entityIds(e, P.stockExchange),
  ];
}

function bindingToCompany(b: SparqlBinding): WikidataCompany | null {
  const uri = b.company?.value;
  const name = b.companyLabel?.value;
  if (!uri || !name) return null;
  const qid = uri.split('/').pop() ?? uri;
  if (name === qid) return null; // 无标签，跳过
  const coord = b.coord?.value; // "Point(lon lat)"
  let latitude: number | undefined;
  let longitude: number | undefined;
  const m = coord?.match(/Point\(([-\d.]+)\s+([-\d.]+)\)/);
  if (m) {
    longitude = Number(m[1]);
    latitude = Number(m[2]);
  }
  return {
    qid,
    name,
    website: b.website?.value,
    employees: b.employees?.value ? Number(b.employees.value) : undefined,
    countryCode: b.countryCode?.value,
    latitude,
    longitude,
  };
}
