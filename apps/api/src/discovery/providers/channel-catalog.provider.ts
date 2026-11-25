/**
 * channel_catalog 发现适配器（Batch 1.4-B；local_query 零出网血缘变体）：
 *
 * 与 `RegistryFrameDiscoveryProvider` 同构：零出网、零成本，从平台表 `source_channel_record`
 * 读取已审核（APPROVED）且所属渠道已启用（ENABLED）的企业记录，按国家与行业/关键词
 * 确定性过滤并构造 `channel_catalog.query` 确定性回执。
 *
 * 双重开关：
 *  - 第一道：`CHANNEL_CATALOG_PROVIDER=on` 时声明 `discovery-company-result-lineage/v1`；
 *    默认 off（与 `REGISTRY_FRAME_PROVIDER` / `COMPANIES_HOUSE_REGISTRY_PROVIDER` 同约定）；
 *  - 第二道：`data_provider.channel_catalog` 状态（seed 默认 DISABLED）。
 */
import type { PrismaClient } from '@prisma/client';
import {
  DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
  type DiscoveryCompanyResultLineageV1,
} from '../company-discovery-lineage';
import {
  CHANNEL_CATALOG_QUERY_PRODUCER_ID,
  buildChannelCatalogLocalQueryReceipt,
  buildChannelCatalogQueryLineage,
  channelCatalogQueryDigest,
} from '../../channels/channel-catalog-receipt';
import {
  buildChannelCatalogQueryInput,
  queryChannelCatalogRecords,
} from '../../channels/channel-catalog-query';
import type {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  DiscoveryOutcome,
  DiscoveryResult,
  ExecutionContext,
  SourceClass,
} from '../provider-contract';

export class ChannelCatalogDiscoveryProvider implements CompanyDiscoveryAdapter {
  readonly key = 'channel_catalog';
  readonly classes: SourceClass[] = ['industry_data'];
  readonly companyResultLineage?: typeof DISCOVERY_COMPANY_RESULT_LINEAGE_V1;

  constructor(private readonly deps: { prisma?: PrismaClient; lineageEnabled?: boolean } = {}) {
    if (deps.lineageEnabled) this.companyResultLineage = DISCOVERY_COMPANY_RESULT_LINEAGE_V1;
  }

  private emptyResult(outcome?: DiscoveryOutcome): DiscoveryResult {
    const base: DiscoveryResult = { records: [], costCents: 0 };
    if (outcome) base.outcome = outcome;
    if (!this.companyResultLineage) return base;
    return {
      ...base,
      lineage: emptyLineage(),
    };
  }

  async discoverCompanies(
    query: CompanyDiscoveryQuery,
    ctx: ExecutionContext,
  ): Promise<DiscoveryResult> {
    const prisma = this.deps.prisma;
    if (!prisma) return this.emptyResult();
    const input = buildChannelCatalogQueryInput({
      filters:
        query.filters && typeof query.filters === 'object' && !Array.isArray(query.filters)
          ? (query.filters as Record<string, unknown>)
          : {},
      keywords: query.keywords,
      limit: query.limit,
    });
    const records = await queryChannelCatalogRecords(prisma, input);
    const emptyOutcome: DiscoveryOutcome | undefined =
      records.length === 0
        ? { errorClass: 'EMPTY_RESULT', reasonCode: 'NO_ROWS' }
        : undefined;
    if (!this.companyResultLineage) {
      return {
        records,
        costCents: 0,
        ...(emptyOutcome ? { outcome: emptyOutcome } : {}),
      };
    }
    const authority = ctx.durableBudgetAuthority;
    const runId = ctx.runId;
    if (!authority || !runId) return this.emptyResult();
    const receipt = buildChannelCatalogLocalQueryReceipt({
      workspaceId: ctx.workspaceId,
      authorityId: authority.authorityId,
      accountId: authority.accountId,
      runId,
      queryDigest: channelCatalogQueryDigest({
        filters: query.filters ?? {},
        keywords: query.keywords,
        limit: query.limit,
      }),
      records,
    });
    ctx.onDurableReceipt?.(CHANNEL_CATALOG_QUERY_PRODUCER_ID, receipt);
    return {
      records,
      costCents: 0,
      lineage: buildChannelCatalogQueryLineage(receipt, records.length),
      ...(emptyOutcome ? { outcome: emptyOutcome } : {}),
    };
  }
}

function emptyLineage(): DiscoveryCompanyResultLineageV1 {
  return Object.freeze({
    schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
    recordCount: 0,
    attemptReceipts: Object.freeze([]),
    receiptCoverage: Object.freeze([]),
  });
}
