import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';

type ClaimTarget = 'APPROVED' | 'REVOKED';

@Injectable()
export class ClaimService {
  constructor(private readonly prisma: PrismaService) {}

  listForCompany(ctx: RequestContext, companyId: string, status?: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.claim.findMany({
        where: { companyId, ...(status ? { status: status as never } : {}) },
        orderBy: { createdAt: 'desc' },
        include: { evidence: true }, // 溯源：来源 URL + 原文片段
      }),
    );
  }

  /**
   * Human Gate (PRD KNW-003): only NEEDS_REVIEW claims can be approved/rejected.
   * Optimistic-locked; approval appends a ClaimApproved event.
   */
  async transition(ctx: RequestContext, claimId: string, target: ClaimTarget, expectedVersion?: number) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const claim = await tx.claim.findUnique({ where: { id: claimId } });
      if (!claim) {
        throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'claim not found' } });
      }
      if (claim.status !== 'NEEDS_REVIEW') {
        throw new ConflictException({
          error: {
            code: 'INVALID_STATE',
            message: `claim is ${claim.status}; only NEEDS_REVIEW can be ${target === 'APPROVED' ? 'approved' : 'rejected'}`,
          },
        });
      }
      if (expectedVersion != null && claim.version !== expectedVersion) {
        throw new ConflictException({
          error: { code: 'VERSION_CONFLICT', message: 'stale version', details: { current: claim.version } },
        });
      }

      const updated = await tx.claim.update({
        where: { id: claimId },
        data: target === 'APPROVED'
          ? {
              status: target,
              version: { increment: 1 },
              verifiedBy: ctx.userId,
              verifiedAt: new Date(),
              verificationMethod: 'human_review',
              verificationProof: {
                action: 'claim_approval',
                approvedVersion: claim.version + 1,
              },
            }
          : { status: target, version: { increment: 1 } },
      });

      if (target === 'APPROVED') {
        await tx.outboxEvent.create({
          data: {
            workspaceId: ctx.workspaceId,
            eventType: 'ClaimApproved',
            aggregateType: 'Claim',
            aggregateId: claimId,
            payload: { companyId: claim.companyId, type: claim.type },
          },
        });
        // 完整度 Gate（5.2.7）：审批达到最低阈值后企业才可用（REVIEW → ACTIVE）
        const approved = await tx.claim.count({ where: { companyId: claim.companyId, status: 'APPROVED' } });
        if (approved >= ACTIVATION_MIN_APPROVED_CLAIMS) {
          await tx.companyProfile.updateMany({
            where: { id: claim.companyId, status: 'REVIEW' },
            data: { status: 'ACTIVE' },
          });
        }
      }
      return updated;
    });
  }

  /** 手工录入企业事实（KNW-001 手工输入路径）：manual 来源，进同一审批生命周期。 */
  async createManual(
    ctx: RequestContext,
    companyId: string,
    input: { type: string; statement: string; evidence?: string },
  ) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.companyProfile.findUnique({ where: { id: companyId }, select: { id: true } });
      if (!company) {
        throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'company not found' } });
      }
      const source = await tx.knowledgeSource.create({
        data: {
          workspaceId: ctx.workspaceId,
          companyId,
          type: 'manual',
          uri: `manual:${ctx.userId}`,
          status: 'PARSED',
        },
      });
      const claim = await tx.claim.create({
        data: {
          workspaceId: ctx.workspaceId,
          companyId,
          sourceId: source.id,
          type: input.type,
          statement: input.statement,
          status: 'NEEDS_REVIEW',
          confidence: 1,
        },
      });
      await tx.evidence.create({
        data: {
          workspaceId: ctx.workspaceId,
          claimId: claim.id,
          sourceUrl: null,
          snippet: input.evidence ?? `人工录入（${ctx.userId}）`,
          confidence: 1,
          fetchedAt: new Date(),
        },
      });
      return tx.claim.findUniqueOrThrow({ where: { id: claim.id }, include: { evidence: true } });
    });
  }

  /** KNW-003：已批准事实必须可撤销（用户纠正后，下游不再使用）。 */
  async revoke(ctx: RequestContext, claimId: string, expectedVersion?: number) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const claim = await tx.claim.findUnique({ where: { id: claimId } });
      if (!claim) {
        throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'claim not found' } });
      }
      if (claim.status !== 'APPROVED') {
        throw new ConflictException({
          error: { code: 'INVALID_STATE', message: `claim is ${claim.status}; only APPROVED can be revoked` },
        });
      }
      if (expectedVersion != null && claim.version !== expectedVersion) {
        throw new ConflictException({
          error: { code: 'VERSION_CONFLICT', message: 'stale version', details: { current: claim.version } },
        });
      }
      const updated = await tx.claim.update({
        where: { id: claimId },
        data: { status: 'REVOKED', version: { increment: 1 } },
      });
      await tx.outboxEvent.create({
        data: {
          workspaceId: ctx.workspaceId,
          eventType: 'ClaimRevoked',
          aggregateType: 'Claim',
          aggregateId: claimId,
          payload: { companyId: claim.companyId, type: claim.type },
        },
      });
      return updated;
    });
  }

  // ── 知识冲突（KNW-004）────────────────────────────────────────────────────

  listConflicts(ctx: RequestContext, companyId: string, status?: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const conflicts = await tx.knowledgeConflict.findMany({
        where: { companyId, ...(status ? { status } : {}) },
        orderBy: { createdAt: 'desc' },
      });
      const claimIds = [...new Set(conflicts.flatMap((c) => [c.claimAId, c.claimBId]))];
      const claims = await tx.claim.findMany({
        where: { id: { in: claimIds } },
        select: { id: true, statement: true, status: true, type: true },
      });
      const byId = new Map(claims.map((c) => [c.id, c]));
      return conflicts.map((c) => ({
        ...c,
        claimA: byId.get(c.claimAId) ?? null,
        claimB: byId.get(c.claimBId) ?? null,
      }));
    });
  }

  /** 人工裁决冲突：保留一条，另一条 REVOKED（若已审批）或保持并标记（未审批则直接 REVOKED 语义上等于弃用）。 */
  async resolveConflict(ctx: RequestContext, conflictId: string, keep: 'a' | 'b') {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const conflict = await tx.knowledgeConflict.findUnique({ where: { id: conflictId } });
      if (!conflict) {
        throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'conflict not found' } });
      }
      if (conflict.status !== 'OPEN') {
        throw new ConflictException({ error: { code: 'INVALID_STATE', message: 'conflict already resolved' } });
      }
      const loserId = keep === 'a' ? conflict.claimBId : conflict.claimAId;
      await tx.claim.updateMany({ where: { id: loserId }, data: { status: 'REVOKED' } });
      return tx.knowledgeConflict.update({
        where: { id: conflictId },
        data: {
          status: 'RESOLVED',
          resolution: keep === 'a' ? 'kept_a' : 'kept_b',
          resolvedBy: ctx.userId,
          resolvedAt: new Date(),
        },
      });
    });
  }
}

/** 完整度阈值（5.2.7 最低标准）：审批过的事实达到该数量 → 企业可用。 */
const ACTIVATION_MIN_APPROVED_CLAIMS = 3;
