import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { scoreLead } from '../lead/scoring';
import { RuleLike } from '../icp/rule-engine';

export interface QualifyRunInput {
  workspaceId: string;
  icpId: string;
}

/**
 * Qualify 处理链（PRD 5.6）：canonical 候选 → 确定性评分 → Lead + 四队列。
 * 幂等：lead 按 (workspace, icp, company) upsert，重跑刷新分数不重复建。
 */
export function createQualifyActivities(deps: { prisma: PrismaService }) {
  return {
    async scoreCandidates(args: QualifyRunInput & { batchSize?: number }): Promise<{
      scored: number;
      queues: Record<string, number>;
    }> {
      const batchSize = args.batchSize ?? 100;
      // ICP 载入单独短事务；批循环**每批一个事务**——全量千余家塞单个交互事务会撞
      // Prisma 默认 5s 事务超时（P2028），且长事务持连接。批间用 id>cursor 续扫。
      const icpForScoring = await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const icp = await tx.icpDefinition.findUnique({
          where: { id: args.icpId },
          include: { rules: true, roles: true },
        });
        if (!icp) throw new Error(`icp ${args.icpId} not found`);
        if (icp.status !== 'ACTIVE') throw new Error(`icp is ${icp.status}; qualify requires ACTIVE`);
        return {
          rules: icp.rules.map(
            (r): RuleLike => ({
              id: r.id,
              kind: r.kind as RuleLike['kind'],
              field: r.field,
              operator: r.operator,
              value: r.value,
              weight: r.weight,
            }),
          ),
          triggerSignals: Array.isArray(icp.triggerSignals) ? (icp.triggerSignals as string[]) : [],
          committeeRoles: icp.roles.map((r) => ({ role: r.role, title: r.title })),
        };
      });

      let cursor: string | undefined;
      let scored = 0;
      const queues: Record<string, number> = { recommended: 0, needs_review: 0, rejected: 0, suppressed: 0 };
      for (;;) {
        const done = await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
          const companies = await tx.canonicalCompany.findMany({
            take: batchSize,
            ...(cursor ? { where: { id: { gt: cursor } } } : {}),
            orderBy: { id: 'asc' },
            include: { contacts: { include: { contactPoints: true } } },
          });
          if (!companies.length) return true;
          for (const c of companies) {
            const result = scoreLead(
              {
                name: c.name,
                domain: c.domain,
                country: c.country,
                industry: c.industry,
                employeeCount: c.employeeCount,
                revenueUsd: c.revenueUsd,
                attributes: c.attributes as Record<string, unknown> | null,
                status: c.status,
                contacts: c.contacts.map((ct) => ({
                  title: ct.title,
                  seniority: ct.seniority,
                  contactPoints: ct.contactPoints.map((p) => ({ type: p.type, status: p.status })),
                })),
              },
              icpForScoring,
              // ICP 资格门（LLM 四门）作为权威 Fit 传入：只覆盖 Fit 维，队列归属由六维总分 +
              // Reachability 硬底决定（此前 match 直接盖整个队列 → 推荐里大半联系不上）。
              { authoritativeFit: c.fitVerdict as 'match' | 'weak' | 'mismatch' | null },
            );
            const queue = result.queue;
            const status =
              queue === 'suppressed' ? 'SUPPRESSED' : queue === 'rejected' ? 'REJECTED' : 'REVIEW';
            const scoreDetail = { ...result.detail, fitVerdict: c.fitVerdict ?? null };
            const existing = await tx.lead.findUnique({
              where: {
                workspaceId_icpId_canonicalCompanyId: {
                  workspaceId: args.workspaceId,
                  icpId: args.icpId,
                  canonicalCompanyId: c.id,
                },
              },
              select: { id: true, status: true },
            });
            // 人工已裁决（QUALIFIED/REJECTED via decision/CONTACTED+）的 Lead 不被重评覆盖状态
            const humanFinal = existing && ['QUALIFIED', 'CONTACTED', 'CONVERTED'].includes(existing.status);
            await tx.lead.upsert({
              where: {
                workspaceId_icpId_canonicalCompanyId: {
                  workspaceId: args.workspaceId,
                  icpId: args.icpId,
                  canonicalCompanyId: c.id,
                },
              },
              update: {
                totalScore: result.totalScore,
                scores: result.scores as unknown as Prisma.InputJsonValue,
                scoreDetail: scoreDetail as unknown as Prisma.InputJsonValue,
                ...(humanFinal ? {} : { status: status as never, queue }),
                version: { increment: 1 },
              },
              create: {
                workspaceId: args.workspaceId,
                icpId: args.icpId,
                canonicalCompanyId: c.id,
                status: status as never,
                queue,
                totalScore: result.totalScore,
                scores: result.scores as unknown as Prisma.InputJsonValue,
                scoreDetail: scoreDetail as unknown as Prisma.InputJsonValue,
              },
            });
            queues[queue] += 1;
            scored += 1;
          }
          cursor = companies[companies.length - 1].id;
          return companies.length < batchSize;
        });
        if (done) break;
      }
      await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        tx.outboxEvent.create({
          data: {
            workspaceId: args.workspaceId,
            eventType: 'LeadsScored',
            aggregateType: 'ICP',
            aggregateId: args.icpId,
            payload: { scored, queues } as Prisma.InputJsonValue,
          },
        }),
      );
      return { scored, queues };
    },
  };
}

export type QualifyActivities = ReturnType<typeof createQualifyActivities>;
