import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TaxonomyResolver } from '../discovery/taxonomy-resolver';
import type { ExecutionBroker } from '../tools/tool-contract';
import { resolveIcpToCpv, collectIndustryTerms, splitTerms, PlanQueryShape } from '../discovery/icp-to-cpv';
import { resolveIcpToFda } from '../discovery/icp-to-fda';
import { TedIntentProjectionService, ProjectTendersResult } from '../intent/ted-intent-projection.service';
import { OpenFdaIntentProjectionService, ProjectClearancesResult } from '../intent/openfda-intent-projection.service';

const DEFAULT_MAX_NOTICES = 100; // 单 ICP 有界样本（绝不 grind 全库）
const DEFAULT_MAX_RECORDS = 100;
const TED_PROVIDER = 'ted';
const OPENFDA_PROVIDER = 'openfda';

export interface ExternalIntentTarget {
  workspaceId: string;
  icpId: string;
}

export interface ExternalIntentIcpResult {
  workspaceId: string;
  icpId: string;
  cpvCodes: number;
  fdaProductCodes: number;
  tenders?: ProjectTendersResult;
  clearances?: ProjectClearancesResult;
  error?: string;
}

/**
 * **外部源 intent sweep** 的 Temporal 活动：把已落地的 TED 招标 + openFDA 510(k) 清关 intent 投影**接进周期调度**，
 * 让「已建的东西在生产真跑」（loop 收口）——此前两投影只在 verify 脚本里活，生产永不触发。
 *
 * 架构与 intent.activities（web_watch sweep）并列但**分开调度**：外部源按 ICP 拉、web_watch 按监控源拉。
 * 跨租户枚举 ACTIVE ICP 走 ownerDb 只读（RLS 下 app_user 不可见，同 OutboxRelay/backlog 的「受信系统扫描器」先例）；
 * 每 ICP 的投影写仍走各自 service 的 `withWorkspace`（RLS 安全）。ICP→CPV/FDA 码用**确定性**解析（`allowLlm:false`，
 * 调度里不臆造码、可复现、零 LLM 成本）。§8.8 门（收口②）：ted.search/openfda.search 为 required 工具，
 * SUSPENDED/未登记/用途不符由 ExecutionBroker 单点 fail-closed（无 broker → 两 service 零投影不出网）。
 */
export function createExternalIntentActivities(deps: {
  prisma: PrismaService;
  taxonomy: TaxonomyResolver;
  ownerDb?: PrismaClient;
  broker?: ExecutionBroker;
}) {
  const tedProj = new TedIntentProjectionService({ prisma: deps.prisma, broker: deps.broker });
  const openfdaProj = new OpenFdaIntentProjectionService({ prisma: deps.prisma, broker: deps.broker });

  return {
    /**
     * 枚举待投影目标（全部 ACTIVE ICP）+ 两 provider 的 data_provider kill-switch 状态（ops 一键停）。
     * ownerDb 缺失（未注入）→ 空，不跑（不误当全启用）。
     */
    async listExternalIntentTargets(args?: { limit?: number }): Promise<{
      targets: ExternalIntentTarget[];
      tedEnabled: boolean;
      openfdaEnabled: boolean;
    }> {
      if (!deps.ownerDb) return { targets: [], tedEnabled: false, openfdaEnabled: false };
      const providers = await deps.ownerDb.dataProvider.findMany({
        where: { key: { in: [TED_PROVIDER, OPENFDA_PROVIDER] } },
        select: { key: true, status: true },
      });
      const tedEnabled = providers.some((p) => p.key === TED_PROVIDER && p.status === 'ENABLED');
      const openfdaEnabled = providers.some((p) => p.key === OPENFDA_PROVIDER && p.status === 'ENABLED');
      if (!tedEnabled && !openfdaEnabled) return { targets: [], tedEnabled, openfdaEnabled }; // 全停 → 不枚举

      // **无静默截断**：默认枚举全部 ACTIVE ICP（loop 收口要求每个 ICP 最终都被投影）。给了 arbitrary
      // take 上限 + orderBy updatedAt desc 会**永久饿死**旧 ICP——投影只写 canonical_company、不动
      // icp_definition，ICP 的 updatedAt 冻结，一旦 ACTIVE 数超上限，末尾的永远轮不到（同 backlog id>cursor
      // 防活锁的教训）。`limit` 仅供单测/有界跑；生产 schedule 不传 → 全量。超大规模再上 lastSweptAt 水位列增量。
      const icps = await deps.ownerDb.icpDefinition.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, workspaceId: true },
        orderBy: { id: 'asc' }, // 稳定序（非 updatedAt，避免"最近编辑优先"倾斜）
        ...(args?.limit ? { take: args.limit } : {}),
      });
      return { targets: icps.map((i) => ({ workspaceId: i.workspaceId, icpId: i.id })), tedEnabled, openfdaEnabled };
    },

    /**
     * 对一个 ICP 跑外部源 intent 投影：ICP → 确定性解析 CPV/FDA 码 → projectTenders + projectClearances。
     * 各 provider 独立 enabled 门（细粒度 kill-switch）；单 provider 解析/投影失败 fail-safe 不阻断另一个。
     */
    async projectExternalIntentForIcp(args: ExternalIntentTarget & {
      tedEnabled: boolean;
      openfdaEnabled: boolean;
      maxNotices?: number;
      maxRecords?: number;
    }): Promise<ExternalIntentIcpResult> {
      const out: ExternalIntentIcpResult = { workspaceId: args.workspaceId, icpId: args.icpId, cpvCodes: 0, fdaProductCodes: 0 };
      if (!deps.ownerDb) return out;

      const icp = await deps.ownerDb.icpDefinition.findUnique({
        where: { id: args.icpId },
        select: { companyAttributes: true, targetMarkets: true },
      });
      if (!icp) return out;

      // 稀疏 companyAttributes 兜底（Codex 复审）：复用 ICP 已存 discovery 查询计划的 filters.industry 补 industry 词
      // （镜像 icp.service 把 planned 传进 collectIndustryTerms）——否则 industry 空 → 解析 0 码 → 静默跳过该 ICP。
      const plan = await deps.ownerDb.discoveryQueryPlan.findFirst({
        where: { icpId: args.icpId },
        orderBy: { updatedAt: 'desc' },
        select: { queries: true },
      });
      const planned = (Array.isArray(plan?.queries) ? plan!.queries : []) as unknown as PlanQueryShape[];

      const attrs = (icp.companyAttributes ?? {}) as Record<string, unknown>;
      const industryTerms = collectIndustryTerms(icp.companyAttributes, planned);
      const targetCountries = splitTerms(icp.targetMarkets);
      const product = attrs.product ? String(attrs.product) : undefined;
      const tradeSide = attrs.trade_side ? String(attrs.trade_side) : undefined;

      // **逐 ICP 重读 live kill-switch**（Codex 复审）：sweep 现在全量枚举可能很长，若只用 sweep 开始时捕获的
      // args.*Enabled，中途 ops 翻 data_provider 开关本轮不生效、仍打外部 API。live 状态 AND 捕获标志（捕获标志
      // 供单测/有界跑显式关闭；live 供中途生效）→ 任一为停即跳过。
      const live = await deps.ownerDb.dataProvider.findMany({
        where: { key: { in: [TED_PROVIDER, OPENFDA_PROVIDER] } },
        select: { key: true, status: true },
      });
      const tedLive = args.tedEnabled && live.some((p) => p.key === TED_PROVIDER && p.status === 'ENABLED');
      const openfdaLive = args.openfdaEnabled && live.some((p) => p.key === OPENFDA_PROVIDER && p.status === 'ENABLED');

      // TED 招标 intent（CPV 确定性解析 → projectTenders）
      if (tedLive) {
        try {
          const cpv = await resolveIcpToCpv(
            deps.taxonomy,
            { industryTerms, product, targetCountries },
            { allowLlm: false, workspaceId: args.workspaceId },
          );
          out.cpvCodes = cpv.cpvCodes.length;
          // 需 CPV **且**有覆盖买方国别才投影（镜像 discovery 的 buildTedQuery 守卫，Codex 复审）：空 buyerCountries
          // 会令 buildAwardQuery 省略国别子句 → 拉全 EU → 把无关欧盟买方 intent 灌进本 workspace（如非 EU 目标 ICP）。
          if (cpv.cpvCodes.length && cpv.buyerCountries.length) {
            out.tenders = await tedProj.projectTenders(args.workspaceId, {
              cpvCodes: cpv.cpvCodes,
              buyerCountries: cpv.buyerCountries,
              maxNotices: args.maxNotices ?? DEFAULT_MAX_NOTICES,
            });
          }
        } catch (err) {
          out.error = `ted: ${String(err).slice(0, 120)}`;
        }
      }

      // openFDA 510(k) 清关 intent（FDA 产品码确定性解析 → projectClearances）
      if (openfdaLive) {
        try {
          const fda = await resolveIcpToFda(
            deps.taxonomy,
            { industryTerms, product, tradeSide, targetCountries },
            { allowLlm: false, workspaceId: args.workspaceId },
          );
          out.fdaProductCodes = fda.productCodes.length;
          if (fda.productCodes.length) {
            out.clearances = await openfdaProj.projectClearances(args.workspaceId, {
              productCodes: fda.productCodes,
              maxRecords: args.maxRecords ?? DEFAULT_MAX_RECORDS,
            });
          }
        } catch (err) {
          out.error = `${out.error ? out.error + '; ' : ''}openfda: ${String(err).slice(0, 120)}`;
        }
      }
      return out;
    },
  };
}

export type ExternalIntentActivities = ReturnType<typeof createExternalIntentActivities>;
