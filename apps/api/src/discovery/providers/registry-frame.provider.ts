/**
 * registry_frame 发现适配器（ch03 T3-09 · 注册面）。
 *
 * 零出网、零成本：本地查 `registry_entity` 平台表（app_user 只读），经
 * `registry/query.ts` 的白名单 filters → 参数化查询 → `ProviderCompanyRecord`。
 * 不需要 ToolBroker / model gateway。
 *
 * ⚠️ 本适配器**刻意不声明** `companyResultLineage`：discovery 执行器当前恒以
 * governed-lineage 模式运行，血缘契约要求逐记录 durable 回执（物理调用产物）；
 * 本地查询没有任何物理调用可出回执。因此它今天一定会被
 * `routeCompanyDiscovery` 的血缘闸门排除，计划期计 `SOURCE_LINEAGE_UNAVAILABLE`
 * ——这是**预期且被测试钉死**的行为，不是缺陷。执行面要等 local_query 血缘变体
 * 获批（书面设计：docs/superpowers/plans/2026-11-09-registry-frame-local-lineage.md）。
 * `data_provider.status`（seed 默认 DISABLED）是第二道 kill switch。
 */
import type { PrismaClient } from '@prisma/client';
import { RegistryQueryError, parseRegistryQueryFilters, queryRegistryEntities } from '../../registry/query';
import type {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  DiscoveryResult,
  ExecutionContext,
  SourceClass,
} from '../provider-contract';

export class RegistryFrameDiscoveryProvider implements CompanyDiscoveryAdapter {
  readonly key = 'registry_frame';
  readonly classes: SourceClass[] = ['company_registry'];

  constructor(private readonly deps: { prisma?: PrismaClient } = {}) {}

  async discoverCompanies(
    query: CompanyDiscoveryQuery,
    _ctx: ExecutionContext,
  ): Promise<DiscoveryResult> {
    const prisma = this.deps.prisma;
    if (!prisma) {
      // seed-only 构造 / 无库环境：诚实返回空，不伪造候选。
      return { records: [], costCents: 0 };
    }
    const raw =
      query.filters !== null && typeof query.filters === 'object' && !Array.isArray(query.filters)
        ? (query.filters as Record<string, unknown>)
        : {};
    // 计划 filters 里还有行业/国家自由词与 _industryCodes 等词表注入字段；这里只取 registry
    // 契约认识的键，其余忽略。ICP 行业词 → NACE 前缀的映射表是 T3-05 的独立卡片，尚未接线，
    // 因此不把 _industryCodes 当作 NACE（口径不同，误当过滤条件会静默清空结果）。
    const candidate: Record<string, unknown> = {
      country: raw.country ?? raw._countryCode,
      ...(raw.scheme !== undefined ? { scheme: raw.scheme } : {}),
      ...(raw.nace_prefix !== undefined ? { nace_prefix: raw.nace_prefix } : {}),
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
      // fail-safe：filters 不合格返回空（与结构化源的「无过滤条件即空」约定一致），不炸整条查询。
      if (error instanceof RegistryQueryError) return { records: [], costCents: 0 };
      throw error;
    }
    const records = await queryRegistryEntities(prisma, filters);
    return { records, costCents: 0 };
  }
}
