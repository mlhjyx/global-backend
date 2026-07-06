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
        data: { status: target, version: { increment: 1 } },
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
      }
      return updated;
    });
  }
}
