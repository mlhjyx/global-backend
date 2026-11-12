/**
 * registry_frame 发现适配器（ch03 T3-09；A 方案 local_query 血缘变体已落地）。
 *
 * 零出网、零成本：本地查 `registry_entity` 平台表（app_user 只读），经
 * `registry/query.ts` 的白名单 filters → 参数化查询 → `ProviderCompanyRecord`。
 * 不需要 ToolBroker / model gateway。
 *
 * 两种运行形态由 `REGISTRY_FRAME_PROVIDER` 控制（默认 off，关闭即回滚到今天行为）：
 *  - off：不声明公司血缘 → 被 `routeCompanyDiscovery` 的血缘闸门排除
 *    （计划期计 `SOURCE_LINEAGE_UNAVAILABLE`，由测试钉死）；
 *  - on：声明 `discovery-company-result-lineage/v1`，并在每次执行时构造
 *    **确定性 local_query 回执**（`registry/local-query-receipt.ts`：producer
 *    `registry.query`，operationId 由 runId+queryDigest 派生，resultDigest 为归一
 *    候选集的规范哈希，成本 usage 恒 0 / `not_incurred`），经 `ctx.onDurableReceipt`
 *    上报。治理注册（PROVIDER_RECEIPT_CONTRACT / domain-ack 绑定 / governed plan）
 *    均已就位；`data_provider.status`（seed 默认 DISABLED）是独立的第二道开关。
 */
import type { PrismaClient } from '@prisma/client';
import {
  DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
  type DiscoveryCompanyResultLineageV1,
} from '../company-discovery-lineage';
import { resolveNacePrefixes } from '../../registry/industry-map';
import {
  REGISTRY_QUERY_PRODUCER_ID,
  buildRegistryLocalQueryReceipt,
  buildRegistryQueryLineage,
  registryQueryDigest,
} from '../../registry/local-query-receipt';
import { RegistryQueryError, parseRegistryQueryFilters, queryRegistryEntities } from '../../registry/query';
import { targetCountryCodes } from '../search-localization';
import type {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  DiscoveryOutcome,
  DiscoveryResult,
  ExecutionContext,
  SourceClass,
} from '../provider-contract';

export class RegistryFrameDiscoveryProvider implements CompanyDiscoveryAdapter {
  readonly key = 'registry_frame';
  readonly classes: SourceClass[] = ['company_registry'];
  /** off（默认）不声明血缘；on 时由构造器置位（见文件头）。 */
  readonly companyResultLineage?: typeof DISCOVERY_COMPANY_RESULT_LINEAGE_V1;

  constructor(private readonly deps: { prisma?: PrismaClient; lineageEnabled?: boolean } = {}) {
    if (deps.lineageEnabled) this.companyResultLineage = DISCOVERY_COMPANY_RESULT_LINEAGE_V1;
  }

  private emptyResult(ctx: ExecutionContext, outcome?: DiscoveryOutcome): DiscoveryResult {
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
    if (!prisma) {
      // seed-only 构造 / 无库环境：诚实返回空，不伪造候选。
      return this.emptyResult(ctx);
    }
    const raw =
      query.filters !== null && typeof query.filters === 'object' && !Array.isArray(query.filters)
        ? (query.filters as Record<string, unknown>)
        : {};
    // 行业 → NACE：显式 nace_prefix 优先；否则用 ISIC 交叉表的确定性命中
    // （industry 自由词 / taxonomy 注入的 _industryCodes，见 registry/industry-map.ts）。
    const nacePrefixes = resolveNacePrefixes({
      nacePrefix: raw.nace_prefix,
      industry: raw.industry,
      industryCodes: raw._industryCodes,
    });
    // 计划里的 country 可能是展示词（Germany / 德国 / DE）；registry 契约只接受
    // ISO 3166-1 alpha-2。先在边界归一，无法归一即 PARAM_INVALID，不把参数错误
    // 伪装成「源里没有数据」。只取 registry 契约认识的键，其余忽略。
    const countryInput = raw.country ?? raw._countryCode;
    const countryValues = Array.isArray(countryInput)
      ? countryInput.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : typeof countryInput === 'string' && countryInput.trim().length > 0
        ? [countryInput]
        : [];
    if (countryValues.length !== 1) {
      return this.emptyResult(ctx, {
        errorClass: 'PARAM_INVALID',
        reasonCode: 'COUNTRY_INVALID',
        issues: ['country 必填且必须是单个 ISO 3166-1 alpha-2 或可归一的国家词'],
      });
    }
    const countryCodes = targetCountryCodes({ filters: { country: countryValues } });
    if (countryCodes.length !== 1) {
      return this.emptyResult(ctx, {
        errorClass: 'PARAM_INVALID',
        reasonCode: 'COUNTRY_UNRESOLVED',
        issues: [`country 无法归一为单一 ISO2：${countryValues[0]}`],
      });
    }
    const candidate: Record<string, unknown> = {
      country: countryCodes[0]!.toUpperCase(),
      ...(raw.scheme !== undefined ? { scheme: raw.scheme } : {}),
      ...(nacePrefixes.length > 0 ? { nace_prefix: nacePrefixes } : {}),
      ...(raw.employee_band !== undefined ? { employee_band: raw.employee_band } : {}),
      ...(raw.legal_form !== undefined ? { legal_form: raw.legal_form } : {}),
      ...(raw.status !== undefined ? { status: raw.status } : {}),
      ...(raw.postal_prefix !== undefined ? { postal_prefix: raw.postal_prefix } : {}),
      limit: query.limit,
    };
    let filters;
    try {
      filters = parseRegistryQueryFilters(candidate);
    } catch (error) {
      // fail-safe：filters 不合格返回空（与结构化源的「无过滤条件即空」约定一致），
      // 但带 PARAM_INVALID，调用方可与「有效查询但 0 行」区分。
      if (error instanceof RegistryQueryError) {
        return this.emptyResult(ctx, {
          errorClass: 'PARAM_INVALID',
          reasonCode: 'FILTERS_INVALID',
          issues: error.issues,
        });
      }
      throw error;
    }
    const records = await queryRegistryEntities(prisma, filters);
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
    // local_query 血缘：回执身份来自 run 执行预算绑定；缺失即 fail-closed（空集 + 空血缘），
    // 绝不产出无法与执行器校验对上的回执。
    const authority = ctx.durableBudgetAuthority;
    const runId = ctx.runId;
    if (!authority || !runId) {
      return this.emptyResult(ctx);
    }
    const receipt = buildRegistryLocalQueryReceipt({
      workspaceId: ctx.workspaceId,
      authorityId: authority.authorityId,
      accountId: authority.accountId,
      runId,
      queryDigest: registryQueryDigest({
        filters: query.filters ?? {},
        keywords: query.keywords,
        limit: query.limit,
      }),
      records,
    });
    ctx.onDurableReceipt?.(REGISTRY_QUERY_PRODUCER_ID, receipt);
    return {
      records,
      costCents: 0,
      lineage: buildRegistryQueryLineage(receipt, records.length),
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
