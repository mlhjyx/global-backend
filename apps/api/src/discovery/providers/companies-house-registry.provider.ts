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
  CompaniesHouseInput,
  CompaniesHouseOutput,
} from '../../tools/source-tools';
import type { ExecutionBroker } from '../../tools/tool-contract';
import { ToolDurableResultProjectionError } from '../../tools/tool-broker';
import type { ChCompanyHit } from '../../adapters/companies-house';
import { COMPANIES_HOUSE_ATTRIBUTION, COMPANIES_HOUSE_LICENSE } from '../../adapters/companies-house';
import { companyIdentity } from '../identity';
import { BudgetOperationReplayError } from '../../tools/budget-store';
import {
  DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
  buildDiscoveryCompanyResultLineage,
  createDiscoveryCompanyReceiptCollector,
  isDiscoveryCompanyLineageInvalid,
} from '../company-discovery-lineage';
import { searchableTerms, searchLanguageFor, targetCountryCodes } from '../search-localization';

const PARSER_VERSION = 'companies_house_registry/v1';
/** 受治理 API 域（无查询串的来源锚点，raw-source provenance 只收稳定 https 无 query）。 */
const SEARCH_URL = 'https://api.company-information.service.gov.uk/search/companies';
const RESULT_CAP = 25; // 有界样本上限（与 MAX_DISCOVERY_PROVIDER_RECORDS 产品帽一致）
const ID_SCHEME = 'ch-company-number'; // UK 注册号（8 位数字或 2 字母前缀 + 6 位）在 GB 内唯一
const GB = 'GB';

/**
 * Companies House 公司注册发现 Provider（获客 vNext W4 · P0 第二源；company_registry 类）。
 * 复用既有受治理工具 `companies_house.search`（op=search）按名称搜索 GB 注册实体 →
 * 每个命中一条 canonical 线索（注册号 + 名称 + 状态），走 discovery→fit→enrich 全管线。
 *
 * 与既有联系人向 `companies_house` provider 分开注册（key `companies_house_registry`）：
 * 同一 data_provider kill-switch 键无法同时承载 contact_discovery 与 company_registry
 * 两类清单（source-class 清单按 key 精确比对），故发现侧独立 key、独立开关。
 *
 * 三重关闭（默认零行为）：
 *  1) env `COMPANIES_HOUSE_REGISTRY_PROVIDER=on` 才声明公司血缘（off 时被血缘闸门排除，不路由）；
 *  2) data_provider 行 `companies_house_registry` 默认 DISABLED（第二道 kill switch）；
 *  3) 缺 `COMPANIES_HOUSE_API_KEY` 时工具抛错 → fail-safe 有效空（degraded 由工具层）。
 * 合规：OGL v3.0（© Crown copyright，署名义务写入 license）；只映射公司字段（注册号/名称/状态），
 * 绝不读取 officers 等具名个人数据（op=search 的输出本身不含个人字段）。
 */
export class CompaniesHouseRegistryDiscoveryProvider implements CompanyDiscoveryAdapter {
  readonly key = 'companies_house_registry';
  readonly classes: SourceClass[] = ['company_registry'];
  /** env off（默认）不声明血缘；on 时由构造器置位（见文件头）。 */
  readonly companyResultLineage?: typeof DISCOVERY_COMPANY_RESULT_LINEAGE_V1;

  constructor(
    private readonly deps?: {
      broker?: ExecutionBroker;
      env?: NodeJS.ProcessEnv;
      lineageEnabled?: boolean;
    },
  ) {
    const env = deps?.env ?? process.env;
    const enabled = deps?.lineageEnabled ?? ((env.COMPANIES_HOUSE_REGISTRY_PROVIDER ?? '').trim().toLowerCase() === 'on');
    if (enabled) this.companyResultLineage = DISCOVERY_COMPANY_RESULT_LINEAGE_V1;
  }

  private enabled(): boolean {
    return this.companyResultLineage === DISCOVERY_COMPANY_RESULT_LINEAGE_V1;
  }

  private emptyLineage(): DiscoveryResult {
    return {
      records: [],
      costCents: 0,
      lineage: buildDiscoveryCompanyResultLineage({
        providerKey: 'companies_house_registry',
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
    if (!this.enabled()) return { records: [], costCents: 0 };
    // 只服务 GB 目标查询：Companies House 仅覆盖英国辖区（country 含 gb/uk 的查询才启动）。
    if (!targetCountryCodes(query).includes('gb')) return this.emptyLineage();
    const text = readQueryText(query);
    if (!text) return this.emptyLineage(); // fail-safe：无检索词不启动（绝不裸拉全库）

    // §8.8 合规门（Broker 单点判定）：companies_house.search 是 required 工具——SUSPENDED/
    // 未登记/用途不符一律 fail-closed。无 broker = 不允许直连。
    if (!this.deps?.broker) {
      console.warn('[companies_house_registry] broker unavailable, fail-closed (no raw egress)');
      return this.emptyLineage();
    }

    const collector = createDiscoveryCompanyReceiptCollector({
      providerKey: 'companies_house_registry',
      producerId: 'companies_house.search',
      parentOnDurableReceipt: ctx.onDurableReceipt,
    });
    collector.markExpectedInvocation();
    let companies: ChCompanyHit[];
    try {
      const res = await this.deps.broker.invoke<CompaniesHouseInput, CompaniesHouseOutput>(
        'companies_house.search',
        { op: 'search', query: text, limit: Math.min(Math.max(query.limit ?? RESULT_CAP, 1), RESULT_CAP) },
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
      console.warn(`[companies_house_registry] discover failed: ${String(err).slice(0, 150)}`);
      const observation = collector.finish([]);
      return {
        records: [],
        costCents: 0,
        lineage: buildDiscoveryCompanyResultLineage({
          providerKey: 'companies_house_registry',
          recordCount: 0,
          observations: [observation],
        }),
      };
    }

    const blocked = new Set((opts?.blockedDomains ?? []).map((d) => d.toLowerCase()));
    const now = new Date().toISOString();
    const dedup = new Map<string, ProviderCompanyRecord>();
    for (const company of companies) {
      const rec = mapCompanyHitToRecord(company, now);
      if (!rec) continue;
      if (rec.domain && blocked.has(rec.domain)) continue;
      const key = companyIdentity({
        name: rec.name,
        domain: rec.domain,
        country: rec.country,
        identifier: rec.identifier, // 注册号消歧（无域名时按 id 归一，防同名误并）
      }).dedupeKey;
      if (!dedup.has(key)) dedup.set(key, rec); // 先到优先
    }
    const records = [...dedup.values()];
    const observation = collector.finish(records.map((_, index) => index));
    const lineage = buildDiscoveryCompanyResultLineage({
      providerKey: 'companies_house_registry',
      recordCount: records.length,
      observations: [observation],
    });
    return { records, costCents: 0, ...(lineage ? { lineage } : {}) };
  }
}

/**
 * 一条 CH 搜索命中 → ProviderCompanyRecord（🟢 公司事实，OGL 署名；绝不含 officers/个人字段）。
 * 缺注册号或名称 → null（主键缺失，不臆造）。
 */
export function mapCompanyHitToRecord(
  company: ChCompanyHit,
  now: string,
): ProviderCompanyRecord | null {
  const name = company.title.trim();
  const companyNumber = company.companyNumber.trim().toUpperCase();
  if (!name || !companyNumber) return null;
  const status = company.companyStatus?.trim() || undefined;
  return {
    externalId: `companies_house_registry:${companyNumber}`,
    name,
    country: GB,
    identifier: {
      // GB 注册号在英辖区内唯一：scheme 固定 ch-company-number（辖区即 GB，无异辖区同名空间）。
      scheme: ID_SCHEME,
      value: companyNumber,
    },
    license: COMPANIES_HOUSE_LICENSE, // OGL v3.0：© Crown copyright，署名义务（ADR §合规）
    attributes: {
      ch_registry: {
        company_number: companyNumber,
        ...(status ? { company_status: status } : {}),
        attribution: COMPANIES_HOUSE_ATTRIBUTION,
      },
    },
    provenance: {
      // 来源锚定到查询无关的受治理 API 端点（raw-source provenance 只收无 query 的 https）。
      sourceUrl: SEARCH_URL,
      fetchedAt: now,
      contentHash: createHash('sha256')
        .update(`companies_house_registry:${companyNumber}:${name}`)
        .digest('hex'),
      parserVersion: PARSER_VERSION,
    },
  };
}

/** 检索词：keywords 优先，其次 industry/sub_industry/product；剥离非目标语言的词，限量。 */
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
