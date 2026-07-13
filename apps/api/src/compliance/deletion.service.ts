import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DeletionReason, DeletionStatus, DeletionSubjectType } from './deletion.types';

export interface CreateDeletionRequest {
  subjectType: DeletionSubjectType;
  subjectId: string;
  reason?: string;
  requestRef?: string;
}

export interface DeletionReceiptView {
  contactsErased: number;
  contactPointsErased: number;
  fieldEvidenceErased: number;
  signalsRevoked: number;
  companiesSuppressed: number;
  leadsRescoreRequested: number;
  patentCacheErased: number;
  ruleVersion: string;
  createdAt: string;
}

export interface DeletionRequestView {
  id: string;
  status: DeletionStatus;
  subjectType: DeletionSubjectType;
  subjectId: string;
  reason: string | null;
  requestRef: string | null;
  createdAt: string;
  completedAt: string | null;
  receipt: DeletionReceiptView | null;
}

/**
 * 收口⑥ PR-B DeletionService（GDPR Art.17）：受理数据主体删除请求 → 落 deletion_request +
 * **事务性 outbox 发 DeletionRequested 命令**（relay 起 deletionWorkflow；Temporal 暂挂也靠 relay 重试起，
 * 保证「受理即必然执行」——比直接 start 更符合合规「删除编排先于发送」的可靠性要求）。
 * 幂等：同主体在途（RECEIVED/FROZEN/ERASING）请求直接复用，不重复建、不重复发命令。
 * 🔴 subjectId 是行 id 引用（非人名/邮箱）；RLS 保证只能删本 workspace 内主体（跨租户不可见 → 404）。
 */
@Injectable()
export class DeletionService {
  constructor(private readonly prisma: PrismaService) {}

  async createRequest(
    workspaceId: string,
    actorId: string,
    dto: CreateDeletionRequest,
  ): Promise<DeletionRequestView> {
    const exists = await this.subjectExists(workspaceId, dto.subjectType, dto.subjectId);
    if (!exists) {
      throw new NotFoundException({
        error: {
          code: 'SUBJECT_NOT_FOUND',
          message: `${dto.subjectType} ${dto.subjectId} not found in workspace`,
        },
      });
    }

    const reason: DeletionReason = (dto.reason as DeletionReason) ?? 'erasure';
    const activeWhere = {
      subjectType: dto.subjectType,
      subjectId: dto.subjectId,
      status: { in: ['RECEIVED', 'FROZEN', 'ERASING'] },
    };
    try {
      const row = await this.prisma.withWorkspace(workspaceId, async (tx) => {
        const active = await tx.deletionRequest.findFirst({
          where: activeWhere,
          orderBy: { createdAt: 'desc' },
          include: { receipt: true },
        });
        if (active) return active; // 幂等：在途请求复用，不重复触发编排

        const created = await tx.deletionRequest.create({
          data: {
            workspaceId,
            subjectType: dto.subjectType,
            subjectId: dto.subjectId,
            requestedBy: actorId,
            requestRef: dto.requestRef ?? null,
            reason,
          },
          include: { receipt: true },
        });
        // 事务性 outbox：请求落库 ⇔ DeletionRequested 命令存在（同 tx 原子）。payload 只带 uuid 引用，无 PII。
        await tx.outboxEvent.create({
          data: {
            workspaceId,
            eventType: 'DeletionRequested',
            aggregateType: 'DeletionRequest',
            aggregateId: created.id,
            payload: { subjectType: dto.subjectType, subjectId: dto.subjectId } as Prisma.InputJsonValue,
          },
        });
        return created;
      });
      return toView(row);
    } catch (err) {
      // 并发第二插入撞「同主体至多一条在途」部分唯一索引（P2002）→ 复用已提交的在途请求（幂等，非报错）。
      // findFirst 在 READ COMMITTED 下看不到对方未提交插入，故靠 DB 唯一索引兜底，冲突后另起事务重读。
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const active = await this.prisma.withWorkspace(workspaceId, (tx) =>
          tx.deletionRequest.findFirst({
            where: activeWhere,
            orderBy: { createdAt: 'desc' },
            include: { receipt: true },
          }),
        );
        if (active) return toView(active);
      }
      throw err;
    }
  }

  async getRequest(workspaceId: string, id: string): Promise<DeletionRequestView> {
    const row = await this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.deletionRequest.findUnique({ where: { id }, include: { receipt: true } }),
    );
    if (!row) {
      throw new NotFoundException({
        error: { code: 'NOT_FOUND', message: `deletion request ${id} not found` },
      });
    }
    return toView(row);
  }

  private async subjectExists(
    workspaceId: string,
    subjectType: DeletionSubjectType,
    subjectId: string,
  ): Promise<boolean> {
    return this.prisma.withWorkspace(workspaceId, async (tx) => {
      if (subjectType === 'contact') {
        return (await tx.canonicalContact.count({ where: { id: subjectId } })) > 0;
      }
      return (await tx.canonicalCompany.count({ where: { id: subjectId } })) > 0;
    });
  }
}

type DeletionRequestRow = Prisma.DeletionRequestGetPayload<{ include: { receipt: true } }>;

function toView(row: DeletionRequestRow): DeletionRequestView {
  return {
    id: row.id,
    status: row.status as DeletionStatus,
    subjectType: row.subjectType as DeletionSubjectType,
    subjectId: row.subjectId,
    reason: row.reason,
    requestRef: row.requestRef,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    receipt: row.receipt
      ? {
          contactsErased: row.receipt.contactsErased,
          contactPointsErased: row.receipt.contactPointsErased,
          fieldEvidenceErased: row.receipt.fieldEvidenceErased,
          signalsRevoked: row.receipt.signalsRevoked,
          companiesSuppressed: row.receipt.companiesSuppressed,
          leadsRescoreRequested: row.receipt.leadsRescoreRequested,
          patentCacheErased: row.receipt.patentCacheErased,
          ruleVersion: row.receipt.ruleVersion,
          createdAt: row.receipt.createdAt.toISOString(),
        }
      : null,
  };
}
