import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { ClaimStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import { buildClaimApprovalProof } from './claim-verification';

type ClaimTarget = 'APPROVED' | 'REVOKED';

interface LockedClaimForTransition {
  id: string;
  workspaceId: string;
  companyId: string;
  sourceId: string | null;
  originKey: string | null;
  factKey: string | null;
  type: string;
  statement: string;
  status: ClaimStatus;
  validUntil: Date | null;
  version: number;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  verificationMethod: string | null;
  verificationProof: unknown;
}

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
      const [claim] = await tx.$queryRaw<LockedClaimForTransition[]>`
        SELECT
          c."id",
          c."workspace_id" AS "workspaceId",
          c."company_id" AS "companyId",
          c."source_id" AS "sourceId",
          c."origin_key" AS "originKey",
          c."fact_key" AS "factKey",
          c."type",
          c."statement",
          c."status",
          c."valid_until" AS "validUntil",
          c."version",
          c."verified_by" AS "verifiedBy",
          c."verified_at" AS "verifiedAt",
          c."verification_method" AS "verificationMethod",
          c."verification_proof" AS "verificationProof"
        FROM "claim" c
        WHERE c."id" = ${claimId}::uuid
          AND c."workspace_id" = ${ctx.workspaceId}::uuid
        FOR UPDATE OF c
      `;
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

      if (target === 'APPROVED' && (claim.originKey !== null || claim.factKey !== null)) {
        const exactBridge =
          claim.originKey !== null && claim.factKey !== null
            ? await tx.$queryRaw<Array<{ id: string }>>`
                SELECT bridge."id"
                FROM "brand_profile_claim_bridge" bridge
                JOIN "brand_profile_evidence_ref" ref
                  ON ref."id" = bridge."evidence_ref_id"
                 AND ref."workspace_id" = bridge."workspace_id"
                 AND ref."site_id" = bridge."site_id"
                 AND ref."brand_profile_id" = bridge."brand_profile_id"
                WHERE bridge."claim_id" = ${claim.id}::uuid
                  AND bridge."workspace_id" = ${claim.workspaceId}::uuid
                  AND bridge."company_profile_id" = ${claim.companyId}::uuid
                  AND ref."fact_key" = ${claim.factKey}
                LIMIT 1
              `
            : [];
        if (exactBridge.length === 0) {
          throw new ConflictException({
            error: {
              code: 'CLAIM_BRIDGE_REQUIRED',
              message: 'origin-keyed claim has no surviving exact Site evidence bridge',
            },
          });
        }
      }

      const nextVersion = claim.version + 1;
      const verifiedAt = new Date();
      const verificationMethod = 'human_review' as const;
      const transition = await tx.claim.updateMany({
        where: { id: claimId, status: 'NEEDS_REVIEW', version: claim.version },
        data: target === 'APPROVED'
          ? {
              status: target,
              version: { increment: 1 },
              verifiedBy: ctx.userId,
              verifiedAt,
              verificationMethod,
              verificationProof: buildClaimApprovalProof(claim, nextVersion, {
                verifiedBy: ctx.userId,
                verifiedAt,
                verificationMethod,
              }),
            }
          : { status: target, version: { increment: 1 } },
      });
      if (transition.count !== 1) {
        throw new ConflictException({
          error: { code: 'VERSION_CONFLICT', message: 'claim changed concurrently' },
        });
      }
      const updated = await tx.claim.findUniqueOrThrow({ where: { id: claimId } });

      if (target === 'APPROVED') {
        await tx.outboxEvent.create({
          data: {
            workspaceId: ctx.workspaceId,
            eventType: 'ClaimApproved',
            aggregateType: 'Claim',
            aggregateId: claimId,
            payload: {
              companyId: claim.companyId,
              factKey: claim.factKey,
              type: claim.type,
            },
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
      const transition = await tx.claim.updateMany({
        where: { id: claimId, status: 'APPROVED', version: claim.version },
        data: { status: 'REVOKED', version: { increment: 1 } },
      });
      if (transition.count !== 1) {
        throw new ConflictException({
          error: { code: 'VERSION_CONFLICT', message: 'claim changed concurrently' },
        });
      }
      const updated = await tx.claim.findUniqueOrThrow({ where: { id: claimId } });
      await tx.outboxEvent.create({
        data: {
          workspaceId: ctx.workspaceId,
          eventType: 'ClaimRevoked',
          aggregateType: 'Claim',
          aggregateId: claimId,
          payload: {
            companyId: claim.companyId,
            factKey: claim.factKey,
            type: claim.type,
          },
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
        select: {
          id: true,
          factKey: true,
          statement: true,
          status: true,
          type: true,
        },
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
      const winnerId = keep === 'a' ? conflict.claimAId : conflict.claimBId;
      const loserId = keep === 'a' ? conflict.claimBId : conflict.claimAId;
      // Lock both alternatives in database UUID order before validating or
      // changing either. This serializes concurrent winner revoke/expiry with
      // resolution and gives every resolver the same lock order.
      const claims = await tx.$queryRaw<
        Array<{
          id: string;
          workspaceId: string;
          companyId: string;
          factKey: string | null;
          type: string;
          status: ClaimStatus;
          version: number;
        }>
      >`
        SELECT "id",
               "workspace_id" AS "workspaceId",
               "company_id" AS "companyId",
               "fact_key" AS "factKey",
               "type",
               "status"::text AS "status",
               "version"
          FROM "claim"
         WHERE "id" IN (${winnerId}::uuid, ${loserId}::uuid)
         ORDER BY "id"
         FOR UPDATE`;
      const winner = claims.find((claim) => claim.id === winnerId);
      const loser = claims.find((claim) => claim.id === loserId);
      if (
        conflict.workspaceId !== ctx.workspaceId ||
        !winner ||
        !loser ||
        winner.workspaceId !== ctx.workspaceId ||
        loser.workspaceId !== ctx.workspaceId ||
        winner.companyId !== conflict.companyId ||
        loser.companyId !== conflict.companyId ||
        winner.type !== conflict.claimType ||
        loser.type !== conflict.claimType ||
        winner.status === 'REVOKED' ||
        winner.status === 'EXPIRED'
      ) {
        throw new ConflictException({
          error: {
            code: 'CONFLICT_IDENTITY_MISMATCH',
            message: 'conflict Claims do not match its tenant/company/type or kept Claim is terminal',
          },
        });
      }
      const resolvedAt = new Date();
      const conflictCas = await tx.knowledgeConflict.updateMany({
        where: { id: conflictId, status: 'OPEN' },
        data: {
          status: 'RESOLVED',
          resolution: keep === 'a' ? 'kept_a' : 'kept_b',
          resolvedBy: ctx.userId,
          resolvedAt,
        },
      });
      if (conflictCas.count !== 1) {
        throw new ConflictException({
          error: {
            code: 'VERSION_CONFLICT',
            message: 'conflict changed concurrently',
          },
        });
      }

      if (loser.status !== 'REVOKED' && loser.status !== 'EXPIRED') {
        const loserCas = await tx.claim.updateMany({
          where: {
            id: loser.id,
            status: loser.status,
            version: loser.version,
          },
          data: { status: 'REVOKED', version: { increment: 1 } },
        });
        if (loserCas.count !== 1) {
          throw new ConflictException({
            error: {
              code: 'VERSION_CONFLICT',
              message: 'conflict Claim changed concurrently',
            },
          });
        }
        if (loser.status === 'APPROVED') {
          await tx.outboxEvent.create({
            data: {
              workspaceId: ctx.workspaceId,
              eventType: 'ClaimRevoked',
              aggregateType: 'Claim',
              aggregateId: loser.id,
              payload: {
                companyId: loser.companyId,
                factKey: loser.factKey,
                type: loser.type,
              },
            },
          });
        }
      }

      return tx.knowledgeConflict.findUniqueOrThrow({
        where: { id: conflictId },
      });
    });
  }
}

/** 完整度阈值（5.2.7 最低标准）：审批过的事实达到该数量 → 企业可用。 */
const ACTIVATION_MIN_APPROVED_CLAIMS = 3;
