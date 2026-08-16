import { createHash } from 'node:crypto';
import { Context } from '@temporalio/activity';
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
import { organizationMayUseExternalProcessing } from '../discovery/organization-identity-root';

export interface QualifyRunInput {
  workspaceId: string;
  icpId: string;
}

interface ScoreCandidatesResult {
  scored: number;
  queues: Record<string, number>;
}

const SCORE_CANDIDATES_IDEMPOTENCY_ENDPOINT = 'TEMPORAL scoreCandidates/v1';
const SCORE_CANDIDATES_LEAD_IDEMPOTENCY_ENDPOINT = 'TEMPORAL scoreCandidates/lead/v1';

function currentActivityExecutionKey(): string | null {
  try {
    const info = Context.current().info;
    return `${info.workflowExecution?.runId ?? 'unknown-workflow-run'}:${info.activityId}`;
  } catch {
    // Unit callers and non-Temporal maintenance code have no activity context.
    // They retain the historical behavior unless they inject an explicit key.
    return null;
  }
}

function scoreCandidatesRequestHash(args: QualifyRunInput & { batchSize?: number }): string {
  return createHash('sha256')
    .update(JSON.stringify({ batchSize: args.batchSize ?? 100, icpId: args.icpId }))
    .digest('hex');
}

function storedScoreCandidatesResult(value: unknown): ScoreCandidatesResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('corrupt scoreCandidates idempotency result');
  }
  const candidate = value as { scored?: unknown; queues?: unknown };
  if (!Number.isSafeInteger(candidate.scored) || (candidate.scored as number) < 0) {
    throw new Error('corrupt scoreCandidates idempotency result');
  }
  if (!candidate.queues || typeof candidate.queues !== 'object' || Array.isArray(candidate.queues)) {
    throw new Error('corrupt scoreCandidates idempotency result');
  }
  const queues = Object.fromEntries(
    Object.entries(candidate.queues as Record<string, unknown>).map(([key, count]) => {
      if (!Number.isSafeInteger(count) || (count as number) < 0) {
        throw new Error('corrupt scoreCandidates idempotency result');
      }
      return [key, count as number];
    }),
  );
  return { scored: candidate.scored as number, queues };
}

function storedScoredLeadQueue(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('corrupt scoreCandidates lead idempotency result');
  }
  const queue = (value as { queue?: unknown }).queue;
  if (typeof queue !== 'string' || !queue) {
    throw new Error('corrupt scoreCandidates lead idempotency result');
  }
  return queue;
}

/**
 * Qualify 处理链（PRD 5.6）：已完成 ICP fit 判定的 Lead → 确定性评分 → 四队列。
 * 企业发现只写 Raw/Canonical；Lead 只由 fit 判定创建。本活动只刷新既有 Lead，
 * 防止模型不可用或尚未判定时把整个客户池误物化成 needs_review 线索。
 */
export function createQualifyActivities(deps: {
  prisma: PrismaService;
  sanctionsScreening?: SanctionsScreeningService;
  activityExecutionKey?: () => string | null;
}) {
  return {
    async scoreCandidates(args: QualifyRunInput & { batchSize?: number }): Promise<ScoreCandidatesResult> {
      const executionKey = deps.activityExecutionKey?.() ?? currentActivityExecutionKey();
      const requestHash = executionKey ? scoreCandidatesRequestHash(args) : null;
      if (executionKey) {
        const prior = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
          tx.idempotencyKey.findUnique({
            where: {
              workspaceId_endpoint_key: {
                workspaceId: args.workspaceId,
                endpoint: SCORE_CANDIDATES_IDEMPOTENCY_ENDPOINT,
                key: executionKey,
              },
            },
          }),
        );
        if (prior) {
          if (prior.requestHash === null || prior.requestHash !== requestHash) {
            throw new Error('scoreCandidates activity execution key was reused with different input');
          }
          return storedScoreCandidatesResult(prior.response);
        }
      }
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
            where: {
              ...(cursor ? { id: { gt: cursor } } : {}),
              identitySourceMappings: { none: { status: 'ACTIVE' } },
              identityConflictParties: {
                none: { conflict: { status: { in: ['OPEN', 'RESOLVING'] } } },
              },
            },
            orderBy: { id: 'asc' },
            include: {
              contacts: { include: { contactPoints: true } },
              identityCanonicalMappings: {
                where: { status: 'ACTIVE' },
                include: {
                  sourceCompany: { include: { contacts: { include: { contactPoints: true } } } },
                },
              },
            },
          });
          if (!companies.length) return true;
          for (const c of companies) {
            if (!(await organizationMayUseExternalProcessing(tx, args.workspaceId, c.id))) continue;
            const identityContacts = [
              ...c.contacts,
              ...c.identityCanonicalMappings.flatMap((mapping) => mapping.sourceCompany.contacts),
            ];
            // 该 (icpId, company) 的既有 Lead——资格门① 写在这里（fitVerdict/fitReasons），是 CandidateAssessment。
            // 权威 Fit 来自**本 ICP 的 Lead**（不再读 canonical，那是「上一个判定该公司的 ICP」的值 → 串 ICP 的根 bug）。
            const identityCompanyIds = [
              c.id,
              ...c.identityCanonicalMappings.map((mapping) => mapping.sourceCompanyId),
            ];
            const existing = await tx.lead.findFirst({
              where: {
                workspaceId: args.workspaceId,
                icpId: args.icpId,
                canonicalCompanyId: { in: identityCompanyIds },
              },
              select: { id: true, status: true, fitVerdict: true },
            });
            const authoritativeFit = (existing?.fitVerdict ?? null) as 'match' | 'weak' | 'mismatch' | null;
            // Discovery and Lead are separate lifecycle stages. A missing/null
            // fit judgment is not a review verdict and must not create a Lead.
            if (!existing || !authoritativeFit) continue;
            const leadExecutionKey = executionKey ? `${executionKey}:${existing.id}` : null;
            if (leadExecutionKey) {
              if (typeof tx.$executeRaw === 'function') {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${args.workspaceId + ':' + SCORE_CANDIDATES_LEAD_IDEMPOTENCY_ENDPOINT + ':' + leadExecutionKey}, 0))`;
              }
              const priorLead = await tx.idempotencyKey.findUnique({
                where: {
                  workspaceId_endpoint_key: {
                    workspaceId: args.workspaceId,
                    endpoint: SCORE_CANDIDATES_LEAD_IDEMPOTENCY_ENDPOINT,
                    key: leadExecutionKey,
                  },
                },
              });
              if (priorLead) {
                if (priorLead.requestHash === null || priorLead.requestHash !== requestHash) {
                  throw new Error('scoreCandidates lead execution key was reused with different input');
                }
                const replayedQueue = storedScoredLeadQueue(priorLead.response);
                queues[replayedQueue] = (queues[replayedQueue] ?? 0) + 1;
                scored += 1;
                continue;
              }
            }

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
                contacts: identityContacts.map((ct) => ({
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
            const update = {
                totalScore: result.totalScore,
                scores: result.scores as unknown as Prisma.InputJsonValue,
                scoreDetail: scoreDetail as unknown as Prisma.InputJsonValue,
                ...(humanFinal ? {} : { status: status as never, queue }),
                version: { increment: 1 },
              };
            await tx.lead.update({ where: { id: existing.id }, data: update });
            // 记/更制裁审计件（命中时）：名单/条目 ref/版本/分数/复核态——🔴 非个人传记（只公司名 + 名单条目引用）。
            if (screenMatches.length) {
              const data = {
                screenedName: c.name,
                status: 'potential_match',
                matches: screenMatches as unknown as Prisma.InputJsonValue,
                topScore: screenMatches[0]?.score ?? null,
                reviewState: screenReviewState,
                listVersions: screenListVersions as unknown as Prisma.InputJsonValue,
                screenedAt: new Date(),
              };
              // upsert（复审 M1）：唯一键 (workspace, company) 原子收敛，并发多 ICP 不产双行/不遮蔽人工清白。
              await tx.sanctionsScreeningResult.upsert({
                where: { workspaceId_canonicalCompanyId: { workspaceId: args.workspaceId, canonicalCompanyId: c.id } },
                update: data,
                create: { workspaceId: args.workspaceId, canonicalCompanyId: c.id, ...data },
              });
            }
            if (leadExecutionKey) {
              await tx.idempotencyKey.create({
                data: {
                  workspaceId: args.workspaceId,
                  endpoint: SCORE_CANDIDATES_LEAD_IDEMPOTENCY_ENDPOINT,
                  key: leadExecutionKey,
                  requestHash: requestHash!,
                  response: { queue },
                },
              });
            }
            queues[queue] = (queues[queue] ?? 0) + 1;
            scored += 1;
          }
          cursor = companies[companies.length - 1].id;
          return companies.length < batchSize;
        });
        if (done) break;
      }
      const result = { scored, queues };
      const committedResult = await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        if (executionKey && typeof tx.$executeRaw === 'function') {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${args.workspaceId + ':' + SCORE_CANDIDATES_IDEMPOTENCY_ENDPOINT + ':' + executionKey}, 0))`;
          const prior = await tx.idempotencyKey.findUnique({
            where: {
              workspaceId_endpoint_key: {
                workspaceId: args.workspaceId,
                endpoint: SCORE_CANDIDATES_IDEMPOTENCY_ENDPOINT,
                key: executionKey,
              },
            },
          });
          if (prior) {
            if (prior.requestHash === null || prior.requestHash !== requestHash) {
              throw new Error('scoreCandidates activity execution key was reused with different input');
            }
            return storedScoreCandidatesResult(prior.response);
          }
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
        if (executionKey) {
          await tx.idempotencyKey.create({
            data: {
              workspaceId: args.workspaceId,
              endpoint: SCORE_CANDIDATES_IDEMPOTENCY_ENDPOINT,
              key: executionKey,
              requestHash: requestHash!,
              response: result as unknown as Prisma.InputJsonValue,
            },
          });
        }
        return result;
      });
      return committedResult;
    },
  };
}

export type QualifyActivities = ReturnType<typeof createQualifyActivities>;
