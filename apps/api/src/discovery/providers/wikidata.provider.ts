import {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  DiscoveryOptions,
  DiscoveryOutcome,
  DiscoveryResult,
  ExecutionContext,
  ProviderCompanyRecord,
  SourceClass,
} from '../provider-contract';
import type { WikidataCompany } from '../../adapters/wikidata';
import type { ExecutionBroker } from '../../tools/tool-contract';
import { ToolDurableResultProjectionError } from '../../tools/tool-broker';
import { mapIndustryToQids, mapCountryToQid } from '../vocab';
import {
  applyBroadIndustryGate,
  BROAD_FALLBACK_INDUSTRY_QIDS,
  BROAD_WIKIDATA_INDUSTRY_QIDS,
  wikidataBroadIndustryMode,
  type WikidataBroadIndustryMode,
} from '../wikidata-industry-scope';
import {
  DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
  buildDiscoveryCompanyResultLineage,
  createDiscoveryCompanyReceiptCollector,
  isDiscoveryCompanyLineageInvalid,
} from '../company-discovery-lineage';

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
  readonly companyResultLineage = DISCOVERY_COMPANY_RESULT_LINEAGE_V1;
  /** mapIndustries / mapCountry read `_industryQids` / `_countryQid` before the built-in vocabulary. */
  readonly consumesResolvedTaxonomy = true;

  constructor(private readonly deps?: {
    broker?: ExecutionBroker;
    /** 测试与灰度注入；缺省读 DISCOVERY_WIKIDATA_BROAD_INDUSTRY_MODE。 */
    broadIndustryMode?: WikidataBroadIndustryMode;
  }) {}

  private emptyResult(outcome?: DiscoveryOutcome): DiscoveryResult {
    return {
      records: [],
      costCents: 0,
      lineage: buildDiscoveryCompanyResultLineage({
        providerKey: 'wikidata',
        recordCount: 0,
        observations: [],
      }),
      ...(outcome ? { outcome } : {}),
    };
  }

  async discoverCompanies(query: CompanyDiscoveryQuery, ctx: ExecutionContext, opts?: DiscoveryOptions,
  ): Promise<DiscoveryResult> {
    if (!this.deps?.broker) {

      console.warn('[wikidata] broker unavailable, fail-closed (no raw egress)');
      return this.emptyResult();
    }
    void opts; // 本源无域名维度，blockedDomains 不适用（签名统一保留）

    const injectedIndustryQids = Array.isArray(query.filters?._industryQids);
    const industryQids = mapIndustries(query);
    if (!industryQids.length) {
      // 活动层注入空列表 = 解析到的节点全部过宽（有原因可报）；
      // 没有注入 = 根本没有行业词可用（词表欠账时预期，无 outcome）。
      return this.emptyResult(
        injectedIndustryQids
          ? { errorClass: 'EMPTY_RESULT', reasonCode: 'INDUSTRY_QID_TOO_BROAD' }
          : undefined,
      );
    }
    const mode = this.deps.broadIndustryMode ?? wikidataBroadIndustryMode();
    const gate = applyBroadIndustryGate(
      industryQids,
      mode,
      injectedIndustryQids ? BROAD_WIKIDATA_INDUSTRY_QIDS : BROAD_FALLBACK_INDUSTRY_QIDS,
    );
    if (gate.rejected.length) {
      console.warn(
        `[wikidata] broad industry QID(s) ignored: ${gate.rejected.slice(0, 8).join(',')} (${gate.rejected.length}/${industryQids.length})`,
      );
    }
    if (!gate.accepted.length) {
      console.warn(
        `[wikidata] INDUSTRY_QID_TOO_BROAD: no narrow industry QID left (rejected ${gate.rejected.slice(0, 8).join(',')})`,
      );
      return this.emptyResult({ errorClass: 'EMPTY_RESULT', reasonCode: 'INDUSTRY_QID_TOO_BROAD' });
    }
    const countryQid = mapCountry(query);

    const collector = createDiscoveryCompanyReceiptCollector({
      providerKey: 'wikidata',
      producerId: 'wikidata.sparql',
      parentOnDurableReceipt: ctx.onDurableReceipt,
    });
    collector.markExpectedInvocation();
    let companies: WikidataCompany[];
    try {
      const res = await this.deps.broker.invoke<
        { industryQids: string[]; countryQid?: string; limit?: number },
        { companies: WikidataCompany[] }
      >(
        'wikidata.sparql',
        { industryQids: gate.accepted, countryQid, limit: Math.min(query.limit, 60) },
        // #51：传本次调用用途，用途门按 discovery 判（否则退回"声明集任一交集"会绕过域策略仅允许 enrichment 的限制）
        { ...ctx, onDurableReceipt: collector.onDurableReceipt, purpose: 'discovery' },
      );
      companies = res.data.companies ?? [];
    } catch (err) {
      if (collector.isForwardingFailure(err) || isDiscoveryCompanyLineageInvalid(err)) {
        throw err;
      }
      // 结算失败但无回执（投影拒绝/闸门拒绝）可证明未产生公司记录：记 failed，血缘仍有效；
      // 其余未知态保持「调用无回执」→ 血缘作废，让物化准入 fail-closed（与 trade_fair 同约定）。
      if (err instanceof ToolDurableResultProjectionError) collector.markInvocationFailed();
      // fail-safe：单源失败/闸门拒绝不阻断其余源（AGENTS.md §5）；拒绝原因已入 Broker DENIED trace

      console.warn(`[wikidata] discover failed: ${String(err).slice(0, 150)}`);
      const observation = collector.finish([]);
      return {
        records: [],
        costCents: 0,
        lineage: buildDiscoveryCompanyResultLineage({
          providerKey: 'wikidata',
          recordCount: 0,
          observations: [observation],
        }),
      };
    }

    const now = new Date().toISOString();
    const records = companies.map((company) =>
      mapWikidataCompanyToRecord({
        company,
        sourceClass: query.sourceClass,
        fetchedAt: now,
      }),
    );
    const observation = collector.finish(records.map((_, index) => index));
    const lineage = buildDiscoveryCompanyResultLineage({
      providerKey: 'wikidata',
      recordCount: records.length,
      observations: [observation],
    });
    return { records, costCents: 0, ...(lineage ? { lineage } : {}) };
  }
}

export function mapWikidataCompanyToRecord(args: {
  company: WikidataCompany;
  sourceClass: SourceClass;
  fetchedAt: string;
}): ProviderCompanyRecord {
  const { company } = args;
  return {
    externalId: `wikidata:${company.qid}`,
    name: company.name,
    domain: company.website ? normalizeToDomain(company.website) : undefined,
    country: company.countryCode,
    employeeCount: company.employees,
    attributes: {
      wikidata_qid: company.qid,
      latitude: company.latitude,
      longitude: company.longitude,
      source_class: args.sourceClass,
    },
    provenance: {
      sourceUrl: `https://www.wikidata.org/wiki/${company.qid}`,
      fetchedAt: args.fetchedAt,
      contentHash: company.qid,
      parserVersion: 'wikidata/1',
    },
  };
}

function mapIndustries(query: CompanyDiscoveryQuery): string[] {
  const f = query.filters ?? {};
  // 活动层注入的列表是权威的：即使过滤后为空，也不再回退到内置词表——
  // 否则"行业太宽被闸门全部滤掉"会经由 vocab 把宽编号重新带回来。
  if (Array.isArray(f._industryQids)) {
    return (f._industryQids as unknown[]).filter((q): q is string => typeof q === 'string' && !!q);
  }
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
