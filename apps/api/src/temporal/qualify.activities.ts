import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { scoreLead } from '../lead/scoring';
import { RuleLike } from '../icp/rule-engine';
import {
  SanctionsScreeningService,
  reconcileReviewState,
  matchesFromJson,
} from '../sanctions/sanctions-screening.service';
import type { ScreenMatch } from '../sanctions/sanctions-matcher';

export interface QualifyRunInput {
  workspaceId: string;
  icpId: string;
}

/**
 * Qualify 处理链（PRD 5.6）：canonical 候选 → 确定性评分 → Lead + 四队列。
 * 幂等：lead 按 (workspace, icp, company) upsert，重跑刷新分数不重复建。
 */
export function createQualifyActivities(deps: { prisma: PrismaService; sanctionsScreening?: SanctionsScreeningService }) {
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

      // 第五门：每 qualify run 重建一次制裁索引（worker 长驻进程与每日名单刷新间保持新鲜；
      // DISABLED 时空索引→screen 恒 not_screened→no-op，不阻断）。
      await deps.sanctionsScreening?.rebuildIndex().catch(() => undefined);

      let cursor: string | undefined;
      let scored = 0;
      const queues: Record<string, number> = { recommended: 0, needs_review: 0, rejected: 0, suppressed: 0, sanctions_hold: 0 };
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
            // 该 (icpId, company) 的既有 Lead——资格门① 写在这里（fitVerdict/fitReasons），是 CandidateAssessment。
            // 权威 Fit 来自**本 ICP 的 Lead**（不再读 canonical，那是「上一个判定该公司的 ICP」的值 → 串 ICP 的根 bug）。
            const existing = await tx.lead.findUnique({
              where: {
                workspaceId_icpId_canonicalCompanyId: {
                  workspaceId: args.workspaceId,
                  icpId: args.icpId,
                  canonicalCompanyId: c.id,
                },
              },
              select: { id: true, status: true, fitVerdict: true },
            });
            const authoritativeFit = (existing?.fitVerdict ?? null) as 'match' | 'weak' | 'mismatch' | null;

            // 第五门制裁筛查（召回优先，内存索引）：命中且未被人工清 → sanctionsHold（queue 强制 sanctions_hold）。
            // DISABLED/清白 → not_screened/clear → sanctionsHold=false（fail-open，不影响队列）。
            const screen = deps.sanctionsScreening?.screen(c.name, c.country);
            let sanctionsHold = false;
            let screenMatches: ScreenMatch[] = [];
            let screenReviewState: 'open' | 'cleared_false_positive' | 'confirmed_true_hit' = 'open';
            let screenListVersions: Record<string, string> = {};
            if (screen && screen.status === 'potential_match') {
              screenMatches = screen.matches;
              screenListVersions = screen.listVersions;
              const prior = await tx.sanctionsScreeningResult.findFirst({
                where: { canonicalCompanyId: c.id },
                orderBy: { screenedAt: 'desc' },
                select: { reviewState: true, matches: true },
              });
              screenReviewState = reconcileReviewState(
                prior ? { reviewState: prior.reviewState, matches: matchesFromJson(prior.matches) } : null,
                screen.matches,
              );
              // 已清(无新命中) → 不 hold（尊重人工 false-positive 判定，抑制复发）；open/confirmed → hold。
              sanctionsHold = screenReviewState !== 'cleared_false_positive';
            }

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
              { authoritativeFit, sanctionsHold },
            );
            const queue = result.queue;
            const status =
              queue === 'suppressed' ? 'SUPPRESSED' : queue === 'rejected' ? 'REJECTED' : 'REVIEW';
            const scoreDetail = { ...result.detail, fitVerdict: authoritativeFit };
            // 人工已裁决（QUALIFIED/REJECTED via decision/CONTACTED+）的 Lead 不被重评覆盖状态
            const humanFinal = existing && ['QUALIFIED', 'CONTACTED', 'CONVERTED'].includes(existing.status);
            // 评分只写 scores/queue/status —— **绝不覆盖 fitVerdict/fitReasons**（那是资格门① 的产物）。
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
            // 记/更制裁审计件（命中时）：名单/条目 ref/版本/分数/复核态——🔴 非个人传记（只公司名 + 名单条目引用）。
            if (screenMatches.length) {
              const priorRow = await tx.sanctionsScreeningResult.findFirst({
                where: { canonicalCompanyId: c.id },
                orderBy: { screenedAt: 'desc' },
                select: { id: true },
              });
              const data = {
                workspaceId: args.workspaceId,
                canonicalCompanyId: c.id,
                screenedName: c.name,
                status: 'potential_match',
                matches: screenMatches as unknown as Prisma.InputJsonValue,
                topScore: screenMatches[0]?.score ?? null,
                reviewState: screenReviewState,
                listVersions: screenListVersions as unknown as Prisma.InputJsonValue,
                screenedAt: new Date(),
              };
              if (priorRow) await tx.sanctionsScreeningResult.update({ where: { id: priorRow.id }, data });
              else await tx.sanctionsScreeningResult.create({ data });
            }
            queues[queue] = (queues[queue] ?? 0) + 1;
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
