import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';

/**
 * M2 反馈闭环（设计 §7.1）：人工判断 → 聚合 → 查询权重与 ICP 建议卡。
 *
 * - 数据：lead_decision（已有）按来源/渠道/行业/国家聚合接受率与 mismatch 理由分布；
 * - 查询权重：来源类目的 EMA 质量分（Alpha=0.3），供查询计划生成时加权/降权；
 * - ICP 建议卡：**只给建议**，人工采纳后才改 ICP（绝不自动改）。
 */

export const FEEDBACK_EMA_ALPHA = 0.3;
/** 建议卡触发阈值：样本量下限。 */
export const SUGGESTION_MIN_SAMPLES = 5;

export interface IcpFeedbackRow {
  dimension: 'source' | 'channel' | 'industry' | 'country';
  dimensionKey: string;
  accepted: number;
  rejected: number;
  reasonCounts: Record<string, number>;
}

export interface IcpSuggestion {
  type: string;
  dimension: IcpFeedbackRow['dimension'];
  key: string;
  sampleSize: number;
  acceptanceRate: number;
  message: string;
}

interface DecisionRow {
  leadId: string;
  action: string;
  reasonCode: string | null;
  createdAt: Date;
}

@Injectable()
export class IcpFeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 重算某 ICP 的聚合（幂等覆盖）。被 lead 决策/结果反馈触发，也可由运维手动重跑。
   */
  async recompute(
    ctx: RequestContext,
    icpId: string,
  ): Promise<{ dimensions: number; families: number }> {
    const {
      leads,
      decisions,
      companies,
      sourceByCompany,
      channelsByCompany,
    } = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const leads = await tx.lead.findMany({
        where: { icpId },
        select: { id: true, canonicalCompanyId: true },
      });
      const leadIds = leads.map((lead) => lead.id);
      const decisions = leadIds.length
        ? await tx.leadDecision.findMany({
            where: { leadId: { in: leadIds } },
            select: { leadId: true, action: true, reasonCode: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
          })
        : [];
      const companyIds = [...new Set(leads.map((lead) => lead.canonicalCompanyId))];
      const companies = companyIds.length
        ? await tx.canonicalCompany.findMany({
            where: { id: { in: companyIds } },
            select: { id: true, industry: true, country: true },
          })
        : [];
      const links = companyIds.length
        ? await tx.identityLink.findMany({
            where: { canonicalType: 'company', canonicalId: { in: companyIds } },
            select: { canonicalId: true, rawRecordId: true },
            orderBy: { rawRecordId: 'asc' },
          })
        : [];
      const rawIds = [...new Set(links.map((link) => link.rawRecordId))];
      const raws = rawIds.length
        ? await tx.rawSourceRecord.findMany({
            where: { id: { in: rawIds } },
            select: { id: true, sourceClass: true },
          })
        : [];
      const sourceClassByRaw = new Map(raws.map((raw) => [raw.id, raw.sourceClass]));
      const sourceByCompany = new Map<string, string>();
      for (const link of links) {
        if (sourceByCompany.has(link.canonicalId)) continue;
        const sourceClass = sourceClassByRaw.get(link.rawRecordId);
        if (sourceClass) sourceByCompany.set(link.canonicalId, sourceClass);
      }
      const sightings = companyIds.length
        ? await tx.companyChannelSighting.findMany({
            where: { companyId: { in: companyIds }, channelId: { not: null } },
            select: { companyId: true, channelId: true },
          })
        : [];
      const channelIds = [...new Set(sightings.map((row) => row.channelId!))];
      const channels = channelIds.length
        ? await tx.sourceChannel.findMany({ where: { id: { in: channelIds } }, select: { id: true, name: true } })
        : [];
      const channelNameById = new Map(channels.map((channel) => [channel.id, channel.name]));
      const channelsByCompany = new Map<string, string[]>();
      for (const sighting of sightings) {
        const name = sighting.channelId ? channelNameById.get(sighting.channelId) : undefined;
        if (!name) continue;
        const list = channelsByCompany.get(sighting.companyId) ?? [];
        if (!list.includes(name)) list.push(name);
        channelsByCompany.set(sighting.companyId, list);
      }
      return { leads, decisions, companies, sourceByCompany, channelsByCompany };
    });

    const latestDecision = new Map<string, DecisionRow>();
    for (const decision of decisions) latestDecision.set(decision.leadId, decision);
    const companyById = new Map(companies.map((company) => [company.id, company]));

    const rows = new Map<string, IcpFeedbackRow>();
    const bump = (
      dimension: IcpFeedbackRow['dimension'],
      key: string,
      action: 'accept' | 'reject',
      reasonCode: string | null,
    ): void => {
      const normalized = key.trim().slice(0, 200) || 'unknown';
      const id = `${dimension}\0${normalized}`;
      const row = rows.get(id) ?? {
        dimension,
        dimensionKey: normalized,
        accepted: 0,
        rejected: 0,
        reasonCounts: {},
      };
      if (action === 'accept') row.accepted += 1;
      else {
        row.rejected += 1;
        if (reasonCode) row.reasonCounts[reasonCode] = (row.reasonCounts[reasonCode] ?? 0) + 1;
      }
      rows.set(id, row);
    };

    for (const lead of leads) {
      const decision = latestDecision.get(lead.id);
      if (!decision) continue;
      const action = decision.action === 'accept' ? 'accept' : 'reject';
      const company = companyById.get(lead.canonicalCompanyId);
      bump('industry', company?.industry ?? 'unknown', action, decision.reasonCode);
      bump('country', company?.country ?? 'unknown', action, decision.reasonCode);
      bump('source', this.sourceByCompanyGet(sourceByCompany, lead.canonicalCompanyId), action, decision.reasonCode);
      for (const channel of channelsByCompany.get(lead.canonicalCompanyId) ?? []) {
        bump('channel', channel, action, decision.reasonCode);
      }
    }

    const families = new Map<string, { accepted: number; samples: number }>();
    for (const row of rows.values()) {
      if (row.dimension !== 'source') continue;
      const sampleCount = row.accepted + row.rejected;
      if (sampleCount === 0) continue;
      families.set(`source:${row.dimensionKey}`, { accepted: row.accepted, samples: sampleCount });
    }

    await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      await tx.icpFeedback.deleteMany({ where: { icpId } });
      for (const row of rows.values()) {
        await tx.icpFeedback.create({
          data: {
            workspaceId: ctx.workspaceId,
            icpId,
            dimension: row.dimension,
            dimensionKey: row.dimensionKey,
            accepted: row.accepted,
            rejected: row.rejected,
            reasonCounts: row.reasonCounts,
          },
        });
      }
      const previous = await tx.icpQueryPerformance.findMany({
        where: { icpId },
        select: { queryFamily: true, qualityEma: true },
      });
      const previousEma = new Map(previous.map((row) => [row.queryFamily, row.qualityEma]));
      for (const [family, stats] of families) {
        const rate = stats.accepted / stats.samples;
        const ema = FEEDBACK_EMA_ALPHA * rate + (1 - FEEDBACK_EMA_ALPHA) * (previousEma.get(family) ?? rate);
        await tx.icpQueryPerformance.upsert({
          where: { workspaceId_icpId_queryFamily: { workspaceId: ctx.workspaceId, icpId, queryFamily: family } },
          update: { samples: stats.samples, accepted: stats.accepted, qualityEma: ema },
          create: {
            workspaceId: ctx.workspaceId,
            icpId,
            queryFamily: family,
            samples: stats.samples,
            accepted: stats.accepted,
            qualityEma: ema,
          },
        });
      }
    });

    return { dimensions: rows.size, families: families.size };
  }

  private sourceByCompanyGet(map: Map<string, string>, companyId: string): string {
    return map.get(companyId) ?? 'unknown';
  }

  /** 建议卡：只给「看起来该改什么」的提示，人工采纳后才改 ICP。 */
  async suggestions(ctx: RequestContext, icpId: string): Promise<{
    rows: IcpFeedbackRow[];
    families: Array<{ queryFamily: string; samples: number; accepted: number; qualityEma: number }>;
    suggestions: IcpSuggestion[];
  }> {
    const { rows, families } = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const rows = await tx.icpFeedback.findMany({ where: { icpId } });
      const families = await tx.icpQueryPerformance.findMany({ where: { icpId } });
      return { rows, families };
    });
    const normalize = (row: (typeof rows)[number]): IcpFeedbackRow => ({
      dimension: row.dimension as IcpFeedbackRow['dimension'],
      dimensionKey: row.dimensionKey,
      accepted: row.accepted,
      rejected: row.rejected,
      reasonCounts: (row.reasonCounts ?? {}) as Record<string, number>,
    });
    const normalized = rows.map(normalize);
    const suggestions: IcpSuggestion[] = [];
    for (const row of normalized) {
      const sampleSize = row.accepted + row.rejected;
      if (sampleSize < SUGGESTION_MIN_SAMPLES) continue;
      const acceptanceRate = row.accepted / sampleSize;
      if (row.accepted === 0) {
        const topReason = Object.entries(row.reasonCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
        suggestions.push({
          type: `${row.dimension}_zero_accept`,
          dimension: row.dimension,
          key: row.dimensionKey,
          sampleSize,
          acceptanceRate,
          message:
            row.dimension === 'industry'
              ? `行业「${row.dimensionKey}」的 ${sampleSize} 条线索全部被拒绝${topReason ? `（主要原因：${topReason}）` : ''}——考虑收紧或移除该行业条件`
              : row.dimension === 'channel'
                ? `渠道「${row.dimensionKey}」的 ${sampleSize} 条线索零接受——考虑停用该渠道`
                : row.dimension === 'country'
                  ? `国家「${row.dimensionKey}」的 ${sampleSize} 条线索全部被拒绝——检查目标市场设置`
                  : `来源「${row.dimensionKey}」的 ${sampleSize} 条线索零接受——考虑降低该来源权重`,
          ...(topReason ? { reason: topReason } as never : {}),
        });
      } else if (acceptanceRate >= 0.5 && row.accepted >= 3) {
        suggestions.push({
          type: `${row.dimension}_strong_segment`,
          dimension: row.dimension,
          key: row.dimensionKey,
          sampleSize,
          acceptanceRate,
          message: `${row.dimension === 'industry' ? '行业' : row.dimension === 'channel' ? '渠道' : row.dimension === 'country' ? '国家' : '来源'}「${row.dimensionKey}」接受率 ${(acceptanceRate * 100).toFixed(0)}%——可以加大投入`,
        });
      }
    }
    return {
      rows: normalized,
      families: families.map((row) => ({
        queryFamily: row.queryFamily,
        samples: row.samples,
        accepted: row.accepted,
        qualityEma: row.qualityEma,
      })),
      suggestions: suggestions.slice(0, 20),
    };
  }

  /** 查询计划生成时的加权说明（无历史反馈时返回 null）。 */
  async plannerNote(ctx: RequestContext, icpId: string): Promise<string | null> {
    const families = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.icpQueryPerformance.findMany({ where: { icpId, samples: { gte: SUGGESTION_MIN_SAMPLES } } }),
    );
    if (families.length === 0) return null;
    const lines = families
      .sort((a, b) => b.qualityEma - a.qualityEma)
      .map((row) => `- ${row.queryFamily}：接受率 ${(row.qualityEma * 100).toFixed(0)}%（样本 ${row.samples}）`);
    return [
      '历史判断反馈（按接受率加权；接受率低的来源少生成、高的多生成）：',
      ...lines,
    ].join('\n');
  }
}
