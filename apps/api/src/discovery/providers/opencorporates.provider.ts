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
import type {
  OpenCorporatesSearchInput,
  OpenCorporatesSearchOutput,
} from '../../tools/source-tools';
import type { ExecutionBroker } from '../../tools/tool-contract';
import { ToolDurableResultProjectionError } from '../../tools/tool-broker';
import type { OpenCorporatesCompanyHit } from '../../adapters/opencorporates-api';
import { companyIdentity } from '../identity';
import { BudgetOperationReplayError } from '../../tools/budget-store';
import {
  DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
  buildDiscoveryCompanyResultLineage,
  createDiscoveryCompanyReceiptCollector,
  isDiscoveryCompanyLineageInvalid,
} from '../company-discovery-lineage';
import { searchLanguageFor, searchableTerms, targetCountryCodes } from '../search-localization';

const PARSER_VERSION = 'opencorporates/v1';
const SEARCH_BASE = 'https://api.opencorporates.com/v0.4/companies/search';
// ODbL 1.0：可商用但**署名+同源共享是 license 义务**（commercial API 另受订阅合同约束）。
const OPENCORPORATES_LICENSE = 'ODbL-1.0';
const OPENCORPORATES_ATTRIBUTION =
  'Source: OpenCorporates (opencorporates.com), reused under the Open Database License (ODbL) v1.0';
const RESULT_CAP = 30; // 有界样本上限（绝不 grind 全量；全量是 Schedule 增量蚕食的活）
const ID_SCHEME = 'oc-company-number'; // 注册号只在**辖区**内唯一：scheme 带辖区，绝不跨辖区串号

/**
 * OpenCorporates 公司注册库发现 Provider（归 company_registry 类；获客挖掘 vNext W4 · P0 第一源）。
 * 按「国别/辖区 × 检索词」拉注册实体 → 每个实体一条 canonical 线索。以注册号（辖区命名空间）
 * 为主解析键；注册地址/状态/类型入 attributes。
 *
 * 开关：`OPENCORPORATES_PROVIDER=on` 才生效（默认 off 时 fail-safe 返回有效空血缘）；
 * data_provider.status 是第二道 kill switch（默认 DISABLED）。无检索词或无法确定辖区时
 * 返回空（fail-safe，绝不裸拉全库）。真实 API key 走 env OPENCORPORATES_API_TOKEN
 * （工具层缺 key 时返回有效空 degraded，不抛错）。
 *
 * 合规：工具 opencorporates.search 在 Broker 单点判定（source_policy + 源合规矩阵
 * sourceKey='opencorporates'，enforce 时未批准即拒）；adapter 只映射公司字段，
 * 绝不读高管等个人数据。
 */
export class OpenCorporatesDiscoveryProvider implements CompanyDiscoveryAdapter {
  readonly key = 'opencorporates';
  readonly classes: SourceClass[] = ['company_registry'];
  readonly companyResultLineage = DISCOVERY_COMPANY_RESULT_LINEAGE_V1;

  constructor(
    private readonly deps?: {
      broker?: ExecutionBroker;
      env?: NodeJS.ProcessEnv;
    },
  ) {}

  private enabled(): boolean {
    return ((this.deps?.env ?? process.env).OPENCORPORATES_PROVIDER ?? '').trim().toLowerCase() === 'on';
  }

  private emptyLineage(): DiscoveryResult {
    return {
      records: [],
      costCents: 0,
      lineage: buildDiscoveryCompanyResultLineage({
        providerKey: 'opencorporates',
        recordCount: 0,
        observations: [],
      }),
    };
  }

  async discoverCompanies(
    query: CompanyDiscoveryQuery,
    ctx: ExecutionContext,
    opts?: DiscoveryOptions,
  ): Promise<DiscoveryResult> {
    if (!this.enabled()) return this.emptyLineage();

    const filters = query.filters ?? {};
    const jurisdiction = readJurisdiction(filters, query);
    const text = readQueryText(query);
    // fail-safe：无检索词或无辖区 → 不启动（绝不裸拉全库；国家码 'us' 不构成单一辖区）。
    if (!jurisdiction || !text) return this.emptyLineage();

    // §8.8 合规门（Broker 单点判定）：opencorporates.search 是 required 工具——SUSPENDED/
    // 未登记/用途不符/源合规矩阵未批准一律 fail-closed。无 broker = 不允许直连。
    if (!this.deps?.broker) {
      console.warn('[opencorporates] broker unavailable, fail-closed (no raw egress)');
      return this.emptyLineage();
    }

    const collector = createDiscoveryCompanyReceiptCollector({
      providerKey: 'opencorporates',
      producerId: 'opencorporates.search',
      parentOnDurableReceipt: ctx.onDurableReceipt,
    });
    collector.markExpectedInvocation();
    let companies: OpenCorporatesCompanyHit[];
    try {
      const res = await this.deps.broker.invoke<
        OpenCorporatesSearchInput,
        OpenCorporatesSearchOutput
      >(
        'opencorporates.search',
        {
          query: text,
          ...jurisdiction,
          limit: Math.min(Math.max(query.limit ?? RESULT_CAP, 1), RESULT_CAP),
        },
        // purpose='discovery'：用途门按本次调用用途判（域策略去掉 discovery 即拦本路径）
        { ...ctx, onDurableReceipt: collector.onDurableReceipt, purpose: 'discovery' },
      );
      companies = res.data.companies ?? [];
    } catch (err) {
      if (collector.isForwardingFailure(err) || isDiscoveryCompanyLineageInvalid(err)) {
        throw err;
      }
      if (err instanceof BudgetOperationReplayError) throw err;
      // 结算失败但无回执（投影拒绝）可证明未产生公司记录：记 failed，血缘仍有效。
      if (err instanceof ToolDurableResultProjectionError) collector.markInvocationFailed();
      // fail-safe：单源失败/闸门拒绝不阻断其余源（AGENTS.md §5）；拒绝原因已入 Broker DENIED trace
      console.warn(`[opencorporates] discover failed: ${String(err).slice(0, 150)}`);
      const observation = collector.finish([]);
      return {
        records: [],
        costCents: 0,
        lineage: buildDiscoveryCompanyResultLineage({
          providerKey: 'opencorporates',
          recordCount: 0,
          observations: [observation],
        }),
      };
    }

    const blocked = new Set((opts?.blockedDomains ?? []).map((d) => d.toLowerCase()));
    const now = new Date().toISOString();
    const dedup = new Map<string, ProviderCompanyRecord>();
    for (const company of companies) {
      const rec = mapCompanyToRecord(company, now);
      if (!rec) continue;
      if (rec.domain && blocked.has(rec.domain)) continue;
      const key = companyIdentity({
        name: rec.name,
        domain: rec.domain,
        country: rec.country,
        identifier: rec.identifier, // 注册号（辖区命名空间）消歧
      }).dedupeKey;
      if (!dedup.has(key)) dedup.set(key, rec); // 先到优先
    }
    const records = [...dedup.values()];
    const observation = collector.finish(records.map((_, index) => index));
    const lineage = buildDiscoveryCompanyResultLineage({
      providerKey: 'opencorporates',
      recordCount: records.length,
      observations: [observation],
    });
    return { records, costCents: 0, ...(lineage ? { lineage } : {}) };
  }
}

/**
 * 一条 OpenCorporates 命中 → ProviderCompanyRecord（🟢 公司/组织事实）。
 * 注册号 + 辖区是法人身份键；地址/状态/类型入 attributes。（provider 已只含公司字段。）
 */
export function mapCompanyToRecord(
  company: OpenCorporatesCompanyHit,
  now: string,
): ProviderCompanyRecord | null {
  const name = company.name.trim();
  const companyNumber = company.companyNumber.trim();
  const jurisdictionCode = company.jurisdictionCode.trim().toLowerCase();
  if (!name || !companyNumber || !jurisdictionCode) return null;
  // 辖区代码首段即国家（'de' → DE，'us_de' → US）；用于国别字段与 canonical 归一。
  const country = jurisdictionCode.split('_')[0]!.toUpperCase();
  const isoDate = (value?: string): string | undefined =>
    value && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : undefined;
  const attributes = prune({
    opencorporates: prune({
      company_number: companyNumber,
      jurisdiction_code: jurisdictionCode,
      status: company.status,
      company_type: company.companyType,
      // 只收严格 ISO 日期；上游若给其它形状就省略（raw-source 载荷契约要求 YYYY-MM-DD）。
      incorporation_date: isoDate(company.incorporationDate),
      dissolution_date: isoDate(company.dissolutionDate),
      registered_address: company.registeredAddress,
      opencorporates_url: company.opencorporatesUrl,
      license: OPENCORPORATES_LICENSE,
      attribution: OPENCORPORATES_ATTRIBUTION,
    }),
  });
  return {
    // 注册号可能含空格/斜杠（"HRB 12345"），externalId 用确定性摘要（同 openfda 先例，
    // raw-source 载荷契约只收 [A-Za-z0-9:._/-]）；人读的注册号在 identifier 里。
    externalId: `opencorporates:${createHash('sha256')
      .update(`${jurisdictionCode}:${companyNumber}`)
      .digest('hex')}`,
    name,
    country,
    identifier: {
      // 注册号只在辖内唯一 → scheme 按辖区限定（'oc-company-number:de'），绝不跨辖区误并。
      scheme: `${ID_SCHEME}:${jurisdictionCode}`,
      value: companyNumber,
    },
    license: OPENCORPORATES_LICENSE,
    attributes,
    provenance: {
      sourceUrl:
        company.opencorporatesUrl ??
        `${SEARCH_BASE}?q=${encodeURIComponent(name)}&jurisdiction_code=${encodeURIComponent(jurisdictionCode)}`,
      fetchedAt: now,
      contentHash: createHash('sha256')
        .update(`opencorporates:${jurisdictionCode}:${companyNumber}:${name}`)
        .digest('hex'),
      parserVersion: PARSER_VERSION,
    },
  };
}

/**
 * 从计划查询确定辖区：显式 filters.jurisdiction_code 优先；否则 filters.country_code 或
 * 目标国家（country 过滤/地区）首个 alpha-2 映射为辖区。美国（'us'）无单一国家级辖区
 * → 返回 undefined（要求显式州级 jurisdiction_code，fail-safe 不猜）。
 */
export function readJurisdiction(
  filters: Record<string, unknown>,
  query: Pick<CompanyDiscoveryQuery, 'filters'> = { filters },
): { countryCode?: string; jurisdictionCode?: string } | undefined {
  const explicitJurisdiction = readString(filters.jurisdiction_code);
  if (explicitJurisdiction) {
    const code = explicitJurisdiction.toLowerCase();
    if (/^[a-z]{2}(?:_[a-z0-9]{1,3})?$/u.test(code)) return { jurisdictionCode: code };
    return undefined;
  }
  const explicitCountry = readString(filters.country_code)?.toLowerCase();
  const country =
    explicitCountry && /^[a-z]{2}$/u.test(explicitCountry)
      ? explicitCountry
      : targetCountryCodes(query)[0];
  if (!country || country === 'us') return undefined;
  return { countryCode: country };
}

/** 检索词：keywords 优先，其次 industry/sub_industry/product；剥离与目标语言不符的词（中文等）。 */
export function readQueryText(query: Pick<CompanyDiscoveryQuery, 'keywords' | 'filters'>): string {
  const f = query.filters ?? {};
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);
  const language = searchLanguageFor(query);
  const terms = searchableTerms(
    [...(query.keywords ?? []), ...arr(f.industry), ...arr(f.sub_industry), ...arr(f.product)],
    language,
  )
    .map((term) => term.trim())
    .filter((term, index, list) => term.length > 0 && list.indexOf(term) === index)
    .slice(0, 4);
  return terms.join(' ').slice(0, 200);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function prune(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, val]) => val != null));
}
