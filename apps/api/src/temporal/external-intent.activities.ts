import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TaxonomyResolver } from '../discovery/taxonomy-resolver';
import { SourcePolicyReader } from '../tools/tool-broker.factory';
import { resolveIcpToCpv, collectIndustryTerms, splitTerms } from '../discovery/icp-to-cpv';
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
 * 调度里不臆造码、可复现、零 LLM 成本）。§8.8 source_policy 用途门由两 projection service 各自把守（SUSPENDED→fail-closed）。
 */
export function createExternalIntentActivities(deps: {
  prisma: PrismaService;
  taxonomy: TaxonomyResolver;
  ownerDb?: PrismaClient;
  sourcePolicyReader?: SourcePolicyReader;
}) {
  const tedProj = new TedIntentProjectionService({ prisma: deps.prisma, sourcePolicyReader: deps.sourcePolicyReader });
  const openfdaProj = new OpenFdaIntentProjectionService({ prisma: deps.prisma, sourcePolicyReader: deps.sourcePolicyReader });

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

      const icps = await deps.ownerDb.icpDefinition.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, workspaceId: true },
        orderBy: { updatedAt: 'desc' },
        take: args?.limit ?? 200,
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

      const attrs = (icp.companyAttributes ?? {}) as Record<string, unknown>;
      const industryTerms = collectIndustryTerms(icp.companyAttributes, []);
      const targetCountries = splitTerms(icp.targetMarkets);
      const product = attrs.product ? String(attrs.product) : undefined;
      const tradeSide = attrs.trade_side ? String(attrs.trade_side) : undefined;

      // TED 招标 intent（CPV 确定性解析 → projectTenders）
      if (args.tedEnabled) {
        try {
          const cpv = await resolveIcpToCpv(
            deps.taxonomy,
            { industryTerms, product, targetCountries },
            { allowLlm: false, workspaceId: args.workspaceId },
          );
          out.cpvCodes = cpv.cpvCodes.length;
          if (cpv.cpvCodes.length) {
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
      if (args.openfdaEnabled) {
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
