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

  async discoverCompanies(query: CompanyDiscoveryQuery, ctx: ExecutionContext, opts?: DiscoveryOptions): Promise<DiscoveryResult> {
    if (!this.deps?.broker) {
       
      console.warn('[wikidata] broker unavailable, fail-closed (no raw egress)');
      return { records: [], costCents: 0 };
    }
    void opts; // 本源无域名维度，blockedDomains 不适用（签名统一保留）

    const industryQids = mapIndustries(query);
    if (!industryQids.length) return { records: [], costCents: 0 }; // 无法映射行业 → 该源无产出（词表欠账时预期）
    const countryQid = mapCountry(query);

    let companies: WikidataCompany[];
    try {
      const res = await this.deps.broker.invoke<
        { industryQids: string[]; countryQid?: string; limit?: number },
        { companies: WikidataCompany[] }
      >(
        'wikidata.sparql',
        { industryQids, countryQid, limit: Math.min(query.limit, 60) },
        { workspaceId: ctx.workspaceId, runId: ctx.runId, correlationId: ctx.correlationId },
      );
      companies = res.data.companies ?? [];
    } catch (err) {
      // fail-safe：单源失败/闸门拒绝不阻断其余源（CLAUDE.md §5）；拒绝原因已入 Broker DENIED trace
       
      console.warn(`[wikidata] discover failed: ${String(err).slice(0, 150)}`);
      return { records: [], costCents: 0 };
    }

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
  // 优先用活动层归一好的 QID（DB taxonomy）；回退到内置 vocab。
  const resolved = (f._industryQids as string[] | undefined)?.filter(Boolean);
  if (resolved?.length) return resolved;
  const raw = [f.industry, f.sub_industry].flat().filter(Boolean).map(String);
  const kw = (query.keywords ?? []).map(String);
  return mapIndustryToQids([...raw, ...kw]);
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
