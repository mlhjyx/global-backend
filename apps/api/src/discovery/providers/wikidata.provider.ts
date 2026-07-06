import {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  DiscoveryResult,
  ProviderCompanyRecord,
  SourceClass,
} from '../provider-contract';
import { discoverCompaniesByIndustry } from '../../adapters/wikidata';
import { mapIndustryToQids, mapCountryToQid } from '../vocab';

/**
 * Wikidata 结构化发现 Provider（零爬取，CC0 开放数据）。
 * 按 filters.industry/country 映射到 Wikidata QID（词表归一层），SPARQL 直接
 * 拿到 公司名 + 官网 + 员工数 + 坐标。官网命中率高，交给 canonicalize 后由
 * mineDomain 富化。属 company_registry / industry_data 类。
 */
export class WikidataDiscoveryProvider implements CompanyDiscoveryAdapter {
  readonly key = 'wikidata';
  readonly classes: SourceClass[] = ['company_registry', 'industry_data'];

  async discoverCompanies(query: CompanyDiscoveryQuery): Promise<DiscoveryResult> {
    const industryQids = mapIndustries(query);
    if (!industryQids.length) return { records: [], costCents: 0 }; // 无法映射行业 → 该源无产出（词表欠账时预期）
    const countryQid = mapCountry(query);

    const companies = await discoverCompaniesByIndustry({
      industryQids,
      countryQid,
      requireWebsite: false,
      limit: Math.min(query.limit, 60),
    });

    const now = new Date().toISOString();
    const records: ProviderCompanyRecord[] = companies.map((c) => ({
      externalId: `wikidata:${c.qid}`,
      name: c.name,
      domain: c.website ? normalizeToDomain(c.website) : undefined,
      country: c.countryCode,
      employeeCount: c.employees,
      attributes: {
        wikidata_qid: c.qid,
        latitude: c.latitude,
        longitude: c.longitude,
        source_class: query.sourceClass,
      },
      provenance: {
        sourceUrl: `https://www.wikidata.org/wiki/${c.qid}`,
        fetchedAt: now,
        contentHash: c.qid,
        parserVersion: 'wikidata/1',
      },
    }));
    return { records, costCents: 0 };
  }
}

function mapIndustries(query: CompanyDiscoveryQuery): string[] {
  const f = query.filters ?? {};
  const raw = [f.industry, f.sub_industry].flat().filter(Boolean).map(String);
  const kw = (query.keywords ?? []).map(String);
  return mapIndustryToQids([...raw, ...kw]);
}

function mapCountry(query: CompanyDiscoveryQuery): string | undefined {
  const f = query.filters ?? {};
  const raw = [f.country, f.region].flat().filter(Boolean).map(String);
  for (const term of raw) {
    const q = mapCountryToQid(term);
    if (q) return q;
  }
  return undefined;
}

function normalizeToDomain(website: string): string | undefined {
  try {
    const u = website.includes('://') ? new URL(website) : new URL(`https://${website}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}
