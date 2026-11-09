/**
 * `CompanyDomainResolutionStore` / `DomainReviewTaskStore` 的 Prisma 实现。
 *
 * 租户表（FORCE RLS）：调用方必须传入 `PrismaService.withWorkspace(...)` 事务里的
 * `Prisma.TransactionClient`（app_user + set_config），不得用 owner 连接绕过 RLS。
 * `selectVerified` 还要求在同一事务内运行——company 级 advisory lock 只在事务内有效。
 */
import { Prisma } from '@prisma/client';
import {
  DomainResolutionStoreError,
  validateResolutionUpsert,
  type DomainResolutionRow,
  type DomainResolutionRoute,
  type DomainResolutionStatus,
  type DomainResolutionStore,
  type DomainResolutionUpsert,
} from './domain-resolution-store';
import {
  DomainReviewTaskStoreError,
  type DomainReviewTaskReason,
  type DomainReviewTaskRow,
  type DomainReviewTaskStatus,
  type DomainReviewTaskStore,
} from './domain-review-store';

type TenantClient = Pick<
  Prisma.TransactionClient,
  'companyDomainResolution' | 'domainReviewTask' | '$executeRaw' | '$queryRaw'
>;

function jsonRecord(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toRow(row: {
  id: string;
  workspaceId: string;
  companyId: string;
  candidateDomain: string;
  route: string;
  routeRank: number;
  status: string;
  matchType: string | null;
  confidence: number | null;
  evidenceUrl: string | null;
  evidenceHash: string | null;
  evidenceJson: Prisma.JsonValue | null;
  extractorVersion: string | null;
  selected: boolean;
  verifiedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): DomainResolutionRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    companyId: row.companyId,
    candidateDomain: row.candidateDomain,
    route: row.route as DomainResolutionRoute,
    routeRank: row.routeRank,
    status: row.status as DomainResolutionStatus,
    matchType: row.matchType,
    confidence: row.confidence,
    evidenceUrl: row.evidenceUrl,
    evidenceHash: row.evidenceHash,
    evidenceJson: jsonRecord(row.evidenceJson),
    extractorVersion: row.extractorVersion,
    selected: row.selected,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PrismaDomainResolutionStore implements DomainResolutionStore {
  constructor(private readonly client: TenantClient) {}

  async upsert(
    workspaceId: string,
    companyId: string,
    input: DomainResolutionUpsert,
    nowIso: string,
  ): Promise<{ id: string; inserted: boolean }> {
    validateResolutionUpsert(input);
    // 单条 INSERT ... ON CONFLICT 原子幂等：捕获 P2002 再改走 UPDATE 会中止所在事务
    // （25P02），所以不能用 create+catch。RETURNING (xmax = 0) 精确区分插入/更新；
    // DO UPDATE 刻意不碰 selected —— 选中位只经 selectVerified 变化。
    const now = new Date(nowIso);
    const inserted = await this.client.$queryRaw<{ id: string; inserted: boolean }[]>(
      Prisma.sql`
        INSERT INTO "company_domain_resolution" (
          "id", "workspace_id", "company_id", "candidate_domain", "route", "route_rank", "status",
          "match_type", "confidence", "evidence_url", "evidence_hash", "evidence_json",
          "extractor_version", "verified_at", "expires_at", "created_at", "updated_at"
        ) VALUES (
          gen_random_uuid(), ${workspaceId}::uuid, ${companyId}::uuid, ${input.candidateDomain}, ${input.route},
          ${input.routeRank}, ${input.status}, ${input.matchType ?? null},
          ${input.confidence ?? null}, ${input.evidenceUrl ?? null}, ${input.evidenceHash ?? null},
          ${input.evidenceJson ? JSON.stringify(input.evidenceJson) : null}::jsonb,
          ${input.extractorVersion ?? null},
          ${input.verifiedAt ? new Date(input.verifiedAt) : null},
          ${input.expiresAt ? new Date(input.expiresAt) : null},
          ${now}, ${now}
        )
        ON CONFLICT ("workspace_id", "company_id", "candidate_domain", "route") DO UPDATE SET
          "route_rank" = EXCLUDED."route_rank",
          "status" = EXCLUDED."status",
          "match_type" = EXCLUDED."match_type",
          "confidence" = EXCLUDED."confidence",
          "evidence_url" = EXCLUDED."evidence_url",
          "evidence_hash" = EXCLUDED."evidence_hash",
          "evidence_json" = EXCLUDED."evidence_json",
          "extractor_version" = EXCLUDED."extractor_version",
          "verified_at" = EXCLUDED."verified_at",
          "expires_at" = EXCLUDED."expires_at",
          "updated_at" = EXCLUDED."updated_at"
        RETURNING "id", (xmax = 0) AS "inserted"
      `,
    );
    const row = inserted[0];
    if (!row) throw new Error('company_domain_resolution upsert returned no row');
    return row;
  }

  async selectVerified(
    workspaceId: string,
    companyId: string,
    resolutionId: string,
    nowIso: string,
  ): Promise<void> {
    // company 级串行化：同公司并发选中只会有一个进入临界区（锁随事务结束释放）。
    await this.client.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`domain-resolution:${workspaceId}:${companyId}`}, 0))`,
    );
    const target = await this.client.companyDomainResolution.findFirst({
      where: { id: resolutionId, workspaceId, companyId },
      select: { id: true, status: true },
    });
    if (!target) {
      throw new DomainResolutionStoreError('RESOLUTION_NOT_FOUND', `resolution ${resolutionId} 不存在`);
    }
    if (target.status !== 'VERIFIED') {
      throw new DomainResolutionStoreError(
        'RESOLUTION_NOT_VERIFIABLE',
        `只有 VERIFIED 行可被选中（当前 ${target.status}）`,
      );
    }
    await this.client.companyDomainResolution.updateMany({
      where: { workspaceId, companyId, selected: true, id: { not: resolutionId } },
      data: { selected: false, updatedAt: new Date(nowIso) },
    });
    await this.client.companyDomainResolution.update({
      where: { id: resolutionId },
      data: { selected: true, updatedAt: new Date(nowIso) },
    });
  }

  async clearSelected(workspaceId: string, companyId: string, nowIso: string): Promise<number> {
    const result = await this.client.companyDomainResolution.updateMany({
      where: { workspaceId, companyId, selected: true },
      data: { selected: false, updatedAt: new Date(nowIso) },
    });
    return result.count;
  }

  async listForCompany(workspaceId: string, companyId: string): Promise<DomainResolutionRow[]> {
    const rows = await this.client.companyDomainResolution.findMany({
      where: { workspaceId, companyId },
      orderBy: [{ routeRank: 'asc' }, { candidateDomain: 'asc' }],
    });
    return rows.map(toRow);
  }
}

function reviewRow(row: {
  id: string;
  workspaceId: string;
  resolutionId: string;
  reason: string;
  priority: number;
  status: string;
  assignee: string | null;
  dueAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
}): DomainReviewTaskRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    resolutionId: row.resolutionId,
    reason: row.reason as DomainReviewTaskReason,
    priority: row.priority,
    status: row.status as DomainReviewTaskStatus,
    assignee: row.assignee,
    dueAt: row.dueAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 表结构没有 decided_by 列（对齐 ch03 §3.9.4）：reviewer 编码进 decisionNote 首段。 */
function decisionNoteFor(reviewer: string, note: string | undefined): string {
  return note ? `${reviewer}: ${note}` : reviewer;
}

export class PrismaDomainReviewTaskStore implements DomainReviewTaskStore {
  constructor(private readonly client: TenantClient) {}

  async openOrGet(
    workspaceId: string,
    input: { resolutionId: string; reason: DomainReviewTaskReason; priority: number; dueAt: string },
    nowIso: string,
  ): Promise<{ task: DomainReviewTaskRow; created: boolean }> {
    const existing = await this.client.domainReviewTask.findFirst({
      where: { workspaceId, resolutionId: input.resolutionId, reason: input.reason, status: 'OPEN' },
    });
    if (existing) return { task: reviewRow(existing), created: false };
    const created = await this.client.domainReviewTask.create({
      data: {
        workspaceId,
        resolutionId: input.resolutionId,
        reason: input.reason,
        priority: input.priority,
        dueAt: new Date(input.dueAt),
        createdAt: new Date(nowIso),
      },
    });
    return { task: reviewRow(created), created: true };
  }

  async decide(
    workspaceId: string,
    taskId: string,
    decision: { outcome: 'APPROVED' | 'REJECTED' | 'NOT_FOUND'; reviewer: string; note?: string; nowIso: string },
  ): Promise<DomainReviewTaskRow> {
    if (!decision.reviewer.trim()) {
      throw new DomainReviewTaskStoreError('REVIEWER_REQUIRED', '裁决必须记录 reviewer');
    }
    const task = await this.client.domainReviewTask.findFirst({
      where: { id: taskId, workspaceId },
      select: { id: true, status: true },
    });
    if (!task) {
      throw new DomainReviewTaskStoreError('REVIEW_TASK_NOT_FOUND', `task ${taskId} 不存在`);
    }
    if (task.status !== 'OPEN') {
      throw new DomainReviewTaskStoreError(
        'REVIEW_TASK_NOT_OPEN',
        `任务 ${taskId} 状态为 ${task.status}，不能再裁决`,
      );
    }
    const updated = await this.client.domainReviewTask.update({
      where: { id: taskId },
      data: {
        status: decision.outcome,
        decidedAt: new Date(decision.nowIso),
        decisionNote: decisionNoteFor(decision.reviewer, decision.note),
      },
    });
    return reviewRow(updated);
  }

  async expireOverdue(workspaceId: string, nowIso: string): Promise<number> {
    const now = new Date(nowIso);
    const result = await this.client.domainReviewTask.updateMany({
      where: { workspaceId, status: 'OPEN', dueAt: { lt: now } },
      data: { status: 'EXPIRED', decidedAt: now, decisionNote: 'SLA_TIMEOUT' },
    });
    return result.count;
  }

  async listOpen(workspaceId: string): Promise<DomainReviewTaskRow[]> {
    const rows = await this.client.domainReviewTask.findMany({
      where: { workspaceId, status: 'OPEN' },
      orderBy: [{ priority: 'desc' }, { dueAt: 'asc' }],
    });
    return rows.map(reviewRow);
  }
}
