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
      const batchSize = args.batchSize ?? 200;
      return deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const icp = await tx.icpDefinition.findUnique({
          where: { id: args.icpId },
          include: { rules: true, roles: true },
        });
        if (!icp) throw new Error(`icp ${args.icpId} not found`);
        if (icp.status !== 'ACTIVE') throw new Error(`icp is ${icp.status}; qualify requires ACTIVE`);

        const icpForScoring = {
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

        let cursor: string | undefined;
        let scored = 0;
        const queues: Record<string, number> = { recommended: 0, needs_review: 0, rejected: 0, suppressed: 0 };
        for (;;) {
          const companies = await tx.canonicalCompany.findMany({
            take: batchSize,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            orderBy: { id: 'asc' },
            include: { contacts: { include: { contactPoints: true } } },
          });
          if (!companies.length) break;
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
            );
            const status =
              result.queue === 'suppressed' ? 'SUPPRESSED' : result.queue === 'rejected' ? 'REJECTED' : 'REVIEW';
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
                scoreDetail: result.detail as unknown as Prisma.InputJsonValue,
                ...(humanFinal ? {} : { status: status as never, queue: result.queue }),
                version: { increment: 1 },
              },
              create: {
                workspaceId: args.workspaceId,
                icpId: args.icpId,
                canonicalCompanyId: c.id,
                status: status as never,
                queue: result.queue,
                totalScore: result.totalScore,
                scores: result.scores as unknown as Prisma.InputJsonValue,
                scoreDetail: result.detail as unknown as Prisma.InputJsonValue,
              },
            });
            queues[result.queue] += 1;
            scored += 1;
          }
          cursor = companies[companies.length - 1].id;
          if (companies.length < batchSize) break;
        }
        await tx.outboxEvent.create({
          data: {
            workspaceId: args.workspaceId,
            eventType: 'LeadsScored',
            aggregateType: 'ICP',
            aggregateId: args.icpId,
            payload: { scored, queues } as Prisma.InputJsonValue,
          },
        });
        return { scored, queues };
      });
    },
  };
}

export type QualifyActivities = ReturnType<typeof createQualifyActivities>;
