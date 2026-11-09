/**
 * 单测用内存版 DomainResolutionStore / DomainReviewTaskStore：语义与 Prisma 实现一致
 * （业务键 upsert、仅 VERIFIED 可选中、同公司至多一行 selected、工单状态机终态守卫、
 * 超期只转 EXPIRED），行为可断言。产品构建排除（tsconfig.build 的 **\/*.test-fixture.ts）。
 */
import { randomUUID } from 'node:crypto';
import {
  DomainResolutionStoreError,
  validateResolutionUpsert,
  type DomainResolutionRow,
  type DomainResolutionStore,
  type DomainResolutionUpsert,
} from './domain-resolution-store';
import {
  DomainReviewTaskStoreError,
  type DomainReviewTaskReason,
  type DomainReviewTaskRow,
  type DomainReviewTaskStore,
} from './domain-review-store';

type StoredResolution = DomainResolutionRow;

function resolutionKey(workspaceId: string, companyId: string, domain: string, route: string): string {
  return `${workspaceId}\u0001${companyId}\u0001${domain}\u0001${route}`;
}

export class InMemoryDomainResolutionStore implements DomainResolutionStore {
  readonly rows = new Map<string, StoredResolution>();

  constructor(private readonly newId: () => string = () => randomUUID()) {}

  async upsert(
    workspaceId: string,
    companyId: string,
    input: DomainResolutionUpsert,
    nowIso: string,
  ): Promise<{ id: string; inserted: boolean }> {
    validateResolutionUpsert(input);
    const key = resolutionKey(workspaceId, companyId, input.candidateDomain, input.route);
    const existing = this.rows.get(key);
    if (existing) {
      // 幂等更新；selected 只能经 selectVerified 变化，upsert 不碰。
      Object.assign(existing, {
        routeRank: input.routeRank,
        status: input.status,
        matchType: input.matchType ?? null,
        confidence: input.confidence ?? null,
        evidenceUrl: input.evidenceUrl ?? null,
        evidenceHash: input.evidenceHash ?? null,
        evidenceJson: input.evidenceJson ?? null,
        extractorVersion: input.extractorVersion ?? null,
        verifiedAt: input.verifiedAt ?? null,
        expiresAt: input.expiresAt ?? null,
        updatedAt: nowIso,
      });
      return { id: existing.id, inserted: false };
    }
    const row: StoredResolution = {
      id: this.newId(),
      workspaceId,
      companyId,
      candidateDomain: input.candidateDomain,
      route: input.route,
      routeRank: input.routeRank,
      status: input.status,
      matchType: input.matchType ?? null,
      confidence: input.confidence ?? null,
      evidenceUrl: input.evidenceUrl ?? null,
      evidenceHash: input.evidenceHash ?? null,
      evidenceJson: input.evidenceJson ?? null,
      extractorVersion: input.extractorVersion ?? null,
      selected: false,
      verifiedAt: input.verifiedAt ?? null,
      expiresAt: input.expiresAt ?? null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.rows.set(key, row);
    return { id: row.id, inserted: true };
  }

  async selectVerified(
    workspaceId: string,
    companyId: string,
    resolutionId: string,
    nowIso: string,
  ): Promise<void> {
    const target = [...this.rows.values()].find(
      (row) => row.id === resolutionId && row.workspaceId === workspaceId && row.companyId === companyId,
    );
    if (!target) {
      throw new DomainResolutionStoreError('RESOLUTION_NOT_FOUND', `resolution ${resolutionId} 不存在`);
    }
    if (target.status !== 'VERIFIED') {
      throw new DomainResolutionStoreError(
        'RESOLUTION_NOT_VERIFIABLE',
        `只有 VERIFIED 行可被选中（当前 ${target.status}）`,
      );
    }
    for (const row of this.rows.values()) {
      if (row.workspaceId === workspaceId && row.companyId === companyId && row.selected) {
        row.selected = false;
        row.updatedAt = nowIso;
      }
    }
    target.selected = true;
    target.updatedAt = nowIso;
  }

  async clearSelected(workspaceId: string, companyId: string, nowIso: string): Promise<number> {
    let count = 0;
    for (const row of this.rows.values()) {
      if (row.workspaceId === workspaceId && row.companyId === companyId && row.selected) {
        row.selected = false;
        row.updatedAt = nowIso;
        count++;
      }
    }
    return count;
  }

  async listForCompany(workspaceId: string, companyId: string): Promise<DomainResolutionRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.workspaceId === workspaceId && row.companyId === companyId)
      .sort((a, b) => a.routeRank - b.routeRank || a.candidateDomain.localeCompare(b.candidateDomain))
      .map((row) => ({ ...row }));
  }

  /** 断言辅助：当前被选中的行（同公司至多一行）。 */
  selectedFor(workspaceId: string, companyId: string): DomainResolutionRow[] {
    return [...this.rows.values()].filter(
      (row) => row.workspaceId === workspaceId && row.companyId === companyId && row.selected,
    );
  }
}

export class InMemoryDomainReviewTaskStore implements DomainReviewTaskStore {
  readonly tasks: DomainReviewTaskRow[] = [];

  constructor(private readonly newId: () => string = () => randomUUID()) {}

  async openOrGet(
    workspaceId: string,
    input: { resolutionId: string; reason: DomainReviewTaskReason; priority: number; dueAt: string },
    nowIso: string,
  ): Promise<{ task: DomainReviewTaskRow; created: boolean }> {
    const existing = this.tasks.find(
      (task) =>
        task.workspaceId === workspaceId &&
        task.resolutionId === input.resolutionId &&
        task.reason === input.reason &&
        task.status === 'OPEN',
    );
    if (existing) return { task: { ...existing }, created: false };
    const task: DomainReviewTaskRow = {
      id: this.newId(),
      workspaceId,
      resolutionId: input.resolutionId,
      reason: input.reason,
      priority: input.priority,
      status: 'OPEN',
      assignee: null,
      dueAt: input.dueAt,
      decidedAt: null,
      decisionNote: null,
      createdAt: nowIso,
    };
    this.tasks.push(task);
    return { task: { ...task }, created: true };
  }

  async decide(
    workspaceId: string,
    taskId: string,
    decision: { outcome: 'APPROVED' | 'REJECTED' | 'NOT_FOUND'; reviewer: string; note?: string; nowIso: string },
  ): Promise<DomainReviewTaskRow> {
    if (!decision.reviewer.trim()) {
      throw new DomainReviewTaskStoreError('REVIEWER_REQUIRED', '裁决必须记录 reviewer');
    }
    const task = this.tasks.find((item) => item.id === taskId && item.workspaceId === workspaceId);
    if (!task) {
      throw new DomainReviewTaskStoreError('REVIEW_TASK_NOT_FOUND', `task ${taskId} 不存在`);
    }
    if (task.status !== 'OPEN') {
      throw new DomainReviewTaskStoreError(
        'REVIEW_TASK_NOT_OPEN',
        `任务 ${taskId} 状态为 ${task.status}，不能再裁决`,
      );
    }
    task.status = decision.outcome;
    task.decidedAt = decision.nowIso;
    task.decisionNote = decision.note ? `${decision.reviewer}: ${decision.note}` : decision.reviewer;
    return { ...task };
  }

  async expireOverdue(workspaceId: string, nowIso: string): Promise<number> {
    let count = 0;
    for (const task of this.tasks) {
      if (task.workspaceId === workspaceId && task.status === 'OPEN' && task.dueAt < nowIso) {
        task.status = 'EXPIRED';
        task.decidedAt = nowIso;
        task.decisionNote = 'SLA_TIMEOUT';
        count++;
      }
    }
    return count;
  }

  async listOpen(workspaceId: string): Promise<DomainReviewTaskRow[]> {
    return this.tasks
      .filter((task) => task.workspaceId === workspaceId && task.status === 'OPEN')
      .sort((a, b) => b.priority - a.priority || a.dueAt.localeCompare(b.dueAt))
      .map((task) => ({ ...task }));
  }
}
