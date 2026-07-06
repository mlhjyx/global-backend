/**
 * Wikidata 结构化企业发现（零爬取的公开开放数据源）。
 * 通过 SPARQL 按「行业 + 国家 + 有官网」直接查出公司名 + 官网 + 员工数 + 坐标，
 * 官网再交给现有 Crawl4AI→Gemini 富化。属 CompanyRegistry/IndustryData 类能力。
 *
 * 合规：Wikidata 是 CC0 公开数据，官方 SPARQL 端点，遵守其 UA 与限流约定。
 */

const ENDPOINT = process.env.WIKIDATA_SPARQL_URL ?? 'https://query.wikidata.org/sparql';
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
