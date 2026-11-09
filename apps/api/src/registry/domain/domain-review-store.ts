/**
 * 人工复核工单存储契约（ch03 §3.9.4 表 `domain_review_task`，执行面批次 3a）。
 *
 * 与内存契约 `domain-review.ts`（分类/SLA/状态机纯函数）配套：
 *  - `openOrGet`：同一 (workspace, resolution, reason) 已有 OPEN 工单则复用（幂等入队），
 *    否则新建；
 *  - `decide`：仅 OPEN 可裁决（终态守卫），裁决结果写 decidedAt/reviewer 备注；
 *    NOT_FOUND 表示「证据不足转 NOT_FOUND」；
 *  - `expireOverdue`：超期 OPEN → EXPIRED（只告警，不改判定；decided_at 记超期时间以过
 *    迁移 CHECK）；
 *  - `listOpen`：按 priority 降序、dueAt 升序（队列消费顺序）。
 */

export const DOMAIN_REVIEW_TASK_STATUSES = [
  'OPEN',
  'APPROVED',
  'REJECTED',
  'NOT_FOUND',
  'EXPIRED',
] as const;

export type DomainReviewTaskStatus = (typeof DOMAIN_REVIEW_TASK_STATUSES)[number];

export const DOMAIN_REVIEW_TASK_REASONS = [
  'low_confidence',
  'name_collision',
  'multi_candidates',
  'audit_sample',
] as const;

export type DomainReviewTaskReason = (typeof DOMAIN_REVIEW_TASK_REASONS)[number];

export interface DomainReviewTaskRow {
  id: string;
  workspaceId: string;
  resolutionId: string;
  reason: DomainReviewTaskReason;
  priority: number;
  status: DomainReviewTaskStatus;
  assignee: string | null;
  dueAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface DomainReviewTaskStore {
  /** 幂等入队：同 (workspace, resolutionId, reason) 的 OPEN 工单已存在则复用。 */
  openOrGet(
    workspaceId: string,
    input: { resolutionId: string; reason: DomainReviewTaskReason; priority: number; dueAt: string },
    nowIso: string,
  ): Promise<{ task: DomainReviewTaskRow; created: boolean }>;
  decide(
    workspaceId: string,
    taskId: string,
    decision: { outcome: 'APPROVED' | 'REJECTED' | 'NOT_FOUND'; reviewer: string; note?: string; nowIso: string },
  ): Promise<DomainReviewTaskRow>;
  /** 超期 OPEN → EXPIRED；返回处理条数。 */
  expireOverdue(workspaceId: string, nowIso: string): Promise<number>;
  listOpen(workspaceId: string): Promise<DomainReviewTaskRow[]>;
}

export class DomainReviewTaskStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainReviewTaskStoreError';
    this.code = code;
  }
}
