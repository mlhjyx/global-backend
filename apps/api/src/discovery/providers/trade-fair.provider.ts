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
import type { FairExhibitor } from '../../adapters/trade-fair-algolia';
import type { TradeFairAlgoliaInput } from '../../tools/source-tools';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import { selectFairs, TradeFairTemplate } from '../trade-fairs';
import { normalizeDomain } from '../identity';
import {
  DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
  buildDiscoveryCompanyResultLineage,
  createDiscoveryCompanyReceiptCollector,
  isDiscoveryCompanyLineageInvalid,
  type DiscoveryCompanyReceiptObservation,
} from '../company-discovery-lineage';

const PARSER_VERSION = 'trade_fair/v1';
const PER_FAIR_LIMIT = 400; // 单展会拉取上限（护栏；尊重 Algolia 限流）

/**
 * 展会参展商发现 Provider（PRD 7.4.11；逐站/逐平台模板）。按 ICP 行业词选相关展会
 * （trade-fairs.ts 注册表），直接打其托管搜索 API（RX/Algolia）拿参展商结构化名录：
 * 公司名 + 官网 + **公开邮箱/电话**（展会公示的商务联系点）+ 国家 + 展位 + 产品 + 招聘信号。
 * 大展会 SPA 的 JS 渲染短板由此绕开。属 industry_data 类；source_hint=trade_fair 二级路由。
 *
 * 收口②：出网经 ToolBroker（`tradefair.algolia` 为 required 工具，ToS 灰偏红源）——
 * SUSPENDED/未登记/用途不符一律 fail-closed；无 broker 不允许直连。
 */
export class TradeFairDiscoveryProvider implements CompanyDiscoveryAdapter {
  readonly key = 'trade_fair';
  readonly classes: SourceClass[] = ['industry_data'];
  readonly companyResultLineage = DISCOVERY_COMPANY_RESULT_LINEAGE_V1;

  constructor(private readonly deps?: { broker?: ExecutionBroker }) {}

  private log(msg: string): void {

    console.log(`[trade_fair] ${msg}`);
  }

  async discoverCompanies(
    query: CompanyDiscoveryQuery,
    ctx: ExecutionContext,
    opts?: DiscoveryOptions,
  ): Promise<DiscoveryResult> {
    const broker = this.deps?.broker;
    if (!broker) {
      console.warn('[trade_fair] broker unavailable, fail-closed (no raw egress)');
      return {
        records: [],
        costCents: 0,
        lineage: buildDiscoveryCompanyResultLineage({
          providerKey: 'trade_fair',
          recordCount: 0,
          observations: [],
        }),
      };
    }

    const f = query.filters ?? {};
    const industryTerms = [f.industry, f.sub_industry].flat().filter(Boolean).map(String);
    const fairs = selectFairs({
      industryTerms,
      keywords: query.keywords,
      region: String(f.region ?? ''),
    });
    if (!fairs.length) {
      return {
        records: [],
        costCents: 0,
        lineage: buildDiscoveryCompanyResultLineage({
          providerKey: 'trade_fair',
          recordCount: 0,
          observations: [],
        }),
      };
    }

    const toolCtx: ToolContext = { ...ctx };
    const blocked = new Set((opts?.blockedDomains ?? []).map((d) => d.toLowerCase()));
    const dedup = new Map<string, ProviderCompanyRecord>();
    const observations: DiscoveryCompanyReceiptObservation[] = [];
    const perFair = Math.min(PER_FAIR_LIMIT, Math.max(query.limit, 50));

    for (const fair of fairs) {
      const collector = createDiscoveryCompanyReceiptCollector({
        providerKey: 'trade_fair',
        producerId: 'tradefair.algolia',
        parentOnDurableReceipt: ctx.onDurableReceipt,
      });
      collector.markExpectedInvocation();
      let records: ProviderCompanyRecord[];
      try {
        records = await this.pullFair(
          broker,
          { ...toolCtx, onDurableReceipt: collector.onDurableReceipt },
          fair,
          perFair,
          query.sourceClass,
        );
      } catch (err) {
        if (
          collector.isForwardingFailure(err) ||
          isDiscoveryCompanyLineageInvalid(err)
        ) {
          throw err;
        }
        observations.push(collector.finish([]));
        this.log(`skip ${fair.slug}: ${String(err).slice(0, 100)}`);
        continue; // 单展会失败/闸门拒绝不影响其余（如 key 换届失效、SUSPENDED）
      }
      const recordIndexes: number[] = [];
      for (const rec of records) {
        if (rec.domain && blocked.has(rec.domain)) continue;
        const key = rec.domain ?? rec.externalId;
        if (!dedup.has(key)) {
          recordIndexes.push(dedup.size);
          dedup.set(key, rec);
        }
      }
      observations.push(collector.finish(recordIndexes));
      this.log(`✓ ${fair.slug}: ${records.length} exhibitors`);
    }
    const records = [...dedup.values()];
    const lineage = buildDiscoveryCompanyResultLineage({
      providerKey: 'trade_fair',
      recordCount: records.length,
      observations,
    });
    return {
      records,
      costCents: 0,
      ...(lineage ? { lineage } : {}),
    };
  }

  private async pullFair(
    broker: ExecutionBroker,
    toolCtx: ToolContext,
    fair: TradeFairTemplate,
    limit: number,
    sourceClass: SourceClass,
  ): Promise<ProviderCompanyRecord[]> {
    const res = await broker.invoke<TradeFairAlgoliaInput, { exhibitors: FairExhibitor[] }>(
      'tradefair.algolia',
      { cfg: fair.algolia, limit },
      toolCtx,
    );
    const exhibitors = res.data.exhibitors ?? [];
    const now = new Date().toISOString();
    return exhibitors.map((exhibitor) =>
      mapTradeFairExhibitorToRecord({
        fair,
        exhibitor,
        sourceClass,
        fetchedAt: now,
      }),
    );
  }
}

export function mapTradeFairExhibitorToRecord(args: {
  fair: Pick<TradeFairTemplate, 'slug' | 'name' | 'exhibitorUrl'>;
  exhibitor: FairExhibitor;
  sourceClass: SourceClass;
  fetchedAt: string;
}): ProviderCompanyRecord {
  const { fair, exhibitor } = args;
  return {
    externalId: `${fair.slug}:${exhibitor.externalId}`,
    name: exhibitor.companyName,
    domain: exhibitor.website
      ? (normalizeDomain(exhibitor.website) ?? undefined)
      : undefined,
    country: exhibitor.country,
    attributes: {
      // 展会公示的公开商务联系点（非个人数据）——adapter 输出保持不变；Raw boundary 另做公司事实净化。
      public_email: exhibitor.email ?? null,
      public_phone: exhibitor.phone ?? null,
      stand: exhibitor.stand ?? null,
      products: exhibitor.products,
      description: exhibitor.description ?? null,
      hiring_signal: exhibitor.hiring ?? false,
      source_fair: fair.slug,
      source_fair_name: fair.name,
      source_class: args.sourceClass,
    },
    provenance: {
      sourceUrl: fair.exhibitorUrl,
      fetchedAt: args.fetchedAt,
      contentHash: createHash('sha256')
        .update(`${fair.slug}:${exhibitor.externalId}`)
        .digest('hex'),
      parserVersion: PARSER_VERSION,
    },
  };
}
