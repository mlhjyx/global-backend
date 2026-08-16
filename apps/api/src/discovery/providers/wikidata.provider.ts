import { createHash } from 'node:crypto';
import {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  DiscoveryOptions,
  DiscoveryResult,
  ExecutionContext,
  ProviderCompanyRecord,
  SourceClass,
} from '../provider-contract';
import type { WikidataCompany } from '../../adapters/wikidata';
import type { ExecutionBroker } from '../../tools/tool-contract';
import { mapIndustryToQids, mapCountryToQid } from '../vocab';
import { authorityProfileForProvider } from '../organization-identity-authority';
import { normalizeAuthorityIdentifiers } from '../organization-identity-v2';

/**
 * Wikidata 结构化发现 Provider（零爬取，CC0 开放数据）。
 * 按 filters.industry/country 映射到 Wikidata QID（词表归一层），SPARQL 直接
 * 拿到 公司名 + 官网 + 员工数 + 坐标。官网命中率高，交给 canonicalize 后由
 * mineDomain 富化。属 company_registry / industry_data 类。
 *
 * 收口②：出网经 ToolBroker（`wikidata.sparql` 为 required 工具）——SUSPENDED/未登记/
 * 用途不符一律 fail-closed；无 broker 不允许直连。
 */
export class WikidataDiscoveryProvider implements CompanyDiscoveryAdapter {
  readonly key = 'wikidata';
  readonly classes: SourceClass[] = ['company_registry', 'industry_data'];

  constructor(private readonly deps?: { broker?: ExecutionBroker }) {}

  async discoverCompanies(query: CompanyDiscoveryQuery, ctx: ExecutionContext, opts?: DiscoveryOptions,
  ): Promise<DiscoveryResult> {
    if (!this.deps?.broker) {
       
      console.warn('[wikidata] broker unavailable, fail-closed (no raw egress)');
      return { records: [], costCents: 0 };
    }
    void opts; // 本源无域名维度，blockedDomains 不适用（签名统一保留）

    const industryQids = mapIndustries(query);
    if (!industryQids.length) return { records: [], costCents: 0 }; // 无法映射行业 → 该源无产出（词表欠账时预期）
    const industryTerms = queryIndustryTerms(query);
    const countryQid = mapCountry(query);

    let companies: WikidataCompany[];
    try {
      const res = await this.deps.broker.invoke<
        { industryQids: string[]; countryQid?: string; limit?: number },
        { companies: WikidataCompany[] }
      >(
        'wikidata.sparql',
        { industryQids, countryQid, limit: Math.min(query.limit, 60) },
        // #51：传本次调用用途，用途门按 discovery 判（否则退回"声明集任一交集"会绕过域策略仅允许 enrichment 的限制）
        { ...ctx, purpose: 'discovery' },
      );
      companies = res.data.companies ?? [];
    } catch (err) {
      // 不在 Provider 层把超时/闸门拒绝伪装成「正常零结果」。上层 activity 用
      // Promise.allSettled 隔离单源失败，并将失败计数带入 run 终态；这里必须保留失败语义。
      console.warn(`[wikidata] discover failed: ${String(err).slice(0, 150)}`);
      throw err;
    }

    const now = new Date().toISOString();
    const records: ProviderCompanyRecord[] = companies.flatMap((c) => {
      const qid = normalizeQid(c.qid);
      if (!qid || !c.name.trim()) return [];
      const lei = normalizeAuthorizedLei(c.lei);
      const identifiers: NonNullable<ProviderCompanyRecord['identifiers']> = [
        { scheme: 'wikidata-qid', jurisdiction: 'GLOBAL', value: qid },
      ];
      if (lei) identifiers.push({ scheme: 'lei', jurisdiction: 'GLOBAL', value: lei });
      return [
        {
          externalId: `wikidata:${qid}`,
          name: c.name,
          domain: c.website ? normalizeToDomain(c.website) : undefined,
          country: c.countryCode,
          employeeCount: c.employees,
          identifiers,
          license: 'CC0-1.0',
          attributes: {
            wikidata_qid: qid,
            ...(c.lei ? { wikidata_lei_claim: c.lei } : {}),
            latitude: c.latitude,
            longitude: c.longitude,
            source_class: query.sourceClass,
            // SPARQL 结果是因为命中这些行业 QID 才返回的。这是来源可验证的命中证据，
            // 不是模型推测；保留在 attributes 内，避免把宽查询词冒充 canonical industry。
            discovery_match: {
              industries: industryTerms,
              industry_qids: industryQids,
            },
          },
          provenance: {
            sourceUrl: `https://www.wikidata.org/wiki/${qid}`,
            fetchedAt: now,
            contentHash: wikidataCompanyContentHash({ ...c, qid }),
            parserVersion: 'wikidata/2',
          },
        },
      ];
    });
    return { records, costCents: 0 };
  }
}

const WIKIDATA_AUTHORITY = authorityProfileForProvider('wikidata');

function normalizeQid(value: string): string | null {
  const normalized = value.trim().toLocaleUpperCase('en-US');
  return /^Q[1-9]\d*$/u.test(normalized) ? normalized : null;
}

function normalizeAuthorizedLei(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return normalizeAuthorityIdentifiers(WIKIDATA_AUTHORITY, [
      { scheme: 'lei', jurisdiction: 'GLOBAL', value },
    ])[0]?.normalizedValue ?? null;
  } catch {
    return null;
  }
}

function wikidataCompanyContentHash(company: WikidataCompany): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        company.qid,
        company.name,
        company.website ?? null,
        company.countryCode ?? null,
        company.employees ?? null,
        company.lei ?? null,
        company.latitude ?? null,
        company.longitude ?? null,
      ]),
    )
    .digest('hex');
}

function mapIndustries(query: CompanyDiscoveryQuery): string[] {
  const f = query.filters ?? {};
  // 优先用活动层归一好的 QID（DB taxonomy）；回退到内置 vocab。
  const resolved = (f._industryQids as string[] | undefined)?.filter(Boolean);
  if (resolved?.length) return resolved;
  const raw = [f.industry, f.sub_industry].flat().filter(Boolean).map(String);
  const kw = (query.keywords ?? []).map(String);
  return mapIndustryToQids([...raw, ...kw]);
}

function queryIndustryTerms(query: CompanyDiscoveryQuery): string[] {
  const f = query.filters ?? {};
  return [f.industry, f.sub_industry]
    .flat()
    .filter(Boolean)
    .map(String)
    .map((term) => term.trim())
    .filter(Boolean);
}

function mapCountry(query: CompanyDiscoveryQuery): string | undefined {
  const f = query.filters ?? {};
  if (f._countryQid) return String(f._countryQid);
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
