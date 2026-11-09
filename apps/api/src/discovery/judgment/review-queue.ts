/**
 * 人工复核队列（P3 J17；设计 §4.3.8）。
 *
 * 队列模型：`judgment_review_task`（状态机 queued → in_review → resolved / expired，
 * app_user 可 SELECT/INSERT/UPDATE、不可 DELETE）。复核结论不改写原记录：
 * 在新 `judgment_record`（append-only）里落一条 `model_requested='human'` 的判定，
 * 并把结论回流到 `judgment_golden_label`（split='candidate'）。
 *
 * 本模块是纯编排：优先级公式、状态机、摘要计算都是确定性纯函数，DB 交互只走
 * `withWorkspace`（RLS）内的事务；Lead 投影（`upsertLeadFit`）留给 J06 统一接线，
 * 避免两处各写一份 verdict→queue 映射。
 */

import { createHash } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

import {
  CRITERION_IDS,
  CRITERION_LABELS,
  RUBRIC_VERSION,
  type CriterionId,
} from './fit-rubric';
import type { JudgeCriterionOutput } from './judge-output-v2';

export const REVIEW_REASONS = [
  'UNKNOWN',
  'BORDERLINE',
  'RANDOM_AUDIT',
  'DRIFT_AUDIT',
  'APPEAL',
  'CONFORMAL_ABSTAIN',
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export const REVIEW_STATUSES = [
  'queued',
  'in_review',
  'resolved',
  'expired',
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_VERDICTS = ['FIT', 'NOT_FIT', 'UNKNOWN'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** 0=P0 … 3=P3（设计 §4.3.8.2）。 */
export const REVIEW_PRIORITIES = [0, 1, 2, 3] as const;
export type ReviewPriority = (typeof REVIEW_PRIORITIES)[number];

/** SLA（小时）：P0 24h / P1 72h / P2 5 工作日 / P3 7 天。 */
export const REVIEW_SLA_HOURS: Readonly<Record<ReviewPriority, number>> =
  Object.freeze({ 0: 24, 1: 72, 2: 120, 3: 168 });

/**
 * 优先级公式（设计 §4.3.8.2）：
 *  P0 = UNKNOWN/CONFORMAL_ABSTAIN 且高价值账户；
 *  P1 = 其余 UNKNOWN/CONFORMAL_ABSTAIN；
 *  P2 = 自动 FIT 的随机抽检（RANDOM_AUDIT）；P3 = 漂移审计与申诉。
 * BORDERLINE 归入 P1 档（borderline 需要人判，但非弃权语义）。
 */
export function computeReviewPriority(
  reason: ReviewReason,
  options: { highValue: boolean } = { highValue: false },
): ReviewPriority {
  switch (reason) {
    case 'UNKNOWN':
    case 'CONFORMAL_ABSTAIN':
      return options.highValue ? 0 : 1;
    case 'BORDERLINE':
      return 1;
    case 'RANDOM_AUDIT':
      return 2;
    case 'DRIFT_AUDIT':
    case 'APPEAL':
      return 3;
  }
}

export function reviewDueAt(
  priority: ReviewPriority,
  now: Date,
): Date {
  return new Date(
    now.getTime() + REVIEW_SLA_HOURS[priority] * 60 * 60 * 1000,
  );
}

/** 人工判定在 `judgment_record.prompt_hash` 中的身份（DB CHECK 要求 64 位 hex）。 */
export const HUMAN_PROMPT_HASH = createHash('sha256')
  .update('human-judgment/v1', 'utf8')
  .digest('hex');

export const HUMAN_MODEL_REQUESTED = 'human';

export class ReviewTaskNotFoundError extends Error {
  readonly code = 'REVIEW_TASK_NOT_FOUND';
  constructor(taskId: string) {
    super(`review task not found: ${taskId}`);
    this.name = 'ReviewTaskNotFoundError';
  }
}

export class ReviewTaskStateError extends Error {
  readonly code = 'REVIEW_TASK_STATE_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'ReviewTaskStateError';
  }
}

export class ReviewOverrideError extends Error {
  readonly code = 'REVIEW_OVERRIDE_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'ReviewOverrideError';
  }
}

export interface CriterionOverride {
  id: CriterionId;
  label?: (typeof CRITERION_LABELS)[number];
  score?: null | number;
}

export interface EnqueueReviewTaskInput {
  highValue?: boolean;
  now?: Date;
  probabilitySample?: boolean;
  reason: ReviewReason;
  recordId: string;
}

export interface ReviewTaskListItem {
  companyName: string | null;
  dueAt: Date | null;
  id: string;
  judgmentRecordId: string;
  priority: ReviewPriority;
  reason: ReviewReason;
  status: ReviewStatus;
  verdictAtJudge: ReviewVerdict;
}

export interface ResolveReviewTaskInput {
  criterionOverrides?: CriterionOverride[];
  note?: string | null;
  verdict: ReviewVerdict;
}

export interface ResolveReviewTaskResult {
  goldenLabelId: string;
  recordId: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function canonicalDigest(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function isReason(value: string): value is ReviewReason {
  return (REVIEW_REASONS as readonly string[]).includes(value);
}

function isVerdict(value: string): value is ReviewVerdict {
  return (REVIEW_VERDICTS as readonly string[]).includes(value);
}

function assertCriterionOverride(override: CriterionOverride): void {
  if (!(CRITERION_IDS as readonly string[]).includes(override.id)) {
    throw new ReviewOverrideError(`unknown criterion ${String(override.id)}`);
  }
  if (override.score !== undefined && override.score !== null) {
    if (!Number.isInteger(override.score) || override.score < 0 || override.score > 10) {
      throw new ReviewOverrideError(`criterion ${override.id} score must be 0..10 or null`);
    }
  }
  if (
    override.label !== undefined &&
    !(CRITERION_LABELS as readonly string[]).includes(override.label)
  ) {
    throw new ReviewOverrideError(`criterion ${override.id} label is not a known label`);
  }
}

/**
 * 把人工覆写应用到原 criteria（返回新数组，不改入参）；未知 criterion 或越界分数拒绝。
 */
export function applyCriterionOverrides(
  criteria: readonly JudgeCriterionOutput[],
  overrides: readonly CriterionOverride[] = [],
): JudgeCriterionOutput[] {
  for (const override of overrides) assertCriterionOverride(override);
  const byId = new Map(overrides.map((override) => [override.id, override]));
  return criteria.map((criterion) => {
    const override = byId.get(criterion.id);
    if (!override) return criterion;
    return {
      ...criterion,
      ...(override.score !== undefined ? { score: override.score } : {}),
      ...(override.label !== undefined ? { label: override.label } : {}),
    };
  });
}

interface ReviewRecordRow {
  attempt: number;
  canonicalCompanyId: string;
  criteria: unknown;
  evidenceCompleteness: boolean;
  icpId: string;
  inputDigest: string;
  judgeLevel: number;
  runId: string | null;
  rubricVersion: string;
  schemaVersion: string;
  verdict: string;
  workspaceId: string;
}

function recordVerdict(value: string): ReviewVerdict {
  if (!isVerdict(value)) {
    throw new ReviewTaskStateError(`judgment record has unknown verdict ${value}`);
  }
  return value;
}

function asCriteria(criteria: unknown): JudgeCriterionOutput[] {
  if (!Array.isArray(criteria)) {
    throw new ReviewTaskStateError('judgment record criteria is not an array');
  }
  return criteria as JudgeCriterionOutput[];
}

/** 入队（幂等：同 record+reason 已存在则复用）。须在 withWorkspace 事务内调用。 */
export async function enqueueReviewTask(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  input: EnqueueReviewTaskInput,
): Promise<{ created: boolean; id: string }> {
  if (!isReason(input.reason)) {
    throw new ReviewTaskStateError(`unknown review reason ${String(input.reason)}`);
  }
  const priority = computeReviewPriority(input.reason, {
    highValue: input.highValue ?? false,
  });
  const now = input.now ?? new Date();
  const existing = await tx.judgmentReviewTask.findUnique({
    where: {
      judgmentRecordId_reason: {
        judgmentRecordId: input.recordId,
        reason: input.reason,
      },
    },
    select: { id: true },
  });
  if (existing) return { id: existing.id, created: false };

  const record = await tx.judgmentRecord.findUnique({
    where: { id: input.recordId },
    select: { workspaceId: true },
  });
  if (!record || record.workspaceId !== workspaceId) {
    throw new ReviewTaskNotFoundError(input.recordId);
  }

  const created = await tx.judgmentReviewTask.create({
    data: {
      workspaceId,
      judgmentRecordId: input.recordId,
      reason: input.reason,
      priority,
      dueAt: reviewDueAt(priority, now),
    },
    select: { id: true },
  });
  return { id: created.id, created: true };
}

export interface ListReviewTasksFilter {
  cursor?: string;
  limit?: number;
  priority?: ReviewPriority;
  status?: ReviewStatus;
}

export interface ListReviewTasksResult {
  items: ReviewTaskListItem[];
  nextCursor: string | null;
}

interface QueueCursor {
  dueAt: string | null;
  id: string;
  priority: number;
}

function encodeCursor(task: {
  dueAt: Date | null;
  id: string;
  priority: number;
}): string {
  const payload: QueueCursor = {
    id: task.id,
    priority: task.priority,
    dueAt: task.dueAt ? task.dueAt.toISOString() : null,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): QueueCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as QueueCursor;
    if (typeof parsed.id !== 'string' || typeof parsed.priority !== 'number') {
      throw new Error('bad cursor');
    }
    return parsed;
  } catch {
    throw new ReviewTaskStateError('invalid review queue cursor');
  }
}

/**
 * 队列列表：按 (priority, dueAt, id) 升序，keyset 分页。
 * 列表天然在 RLS 之下（withWorkspace 事务），跨租户不可见。
 */
export async function listReviewTasks(
  prisma: PrismaClient,
  workspaceId: string,
  filter: ListReviewTasksFilter = {},
): Promise<ListReviewTasksResult> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
    const where: Prisma.JudgmentReviewTaskWhereInput = {
      workspaceId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.priority !== undefined ? { priority: filter.priority } : {}),
    };
    if (filter.cursor) {
      const cursor = decodeCursor(filter.cursor);
      // keyset：priority 更大，或 priority 相同且 (dueAt,id) 在游标之后。
      where.OR = [
        { priority: { gt: cursor.priority } },
        {
          priority: cursor.priority,
          ...(cursor.dueAt === null
            ? { dueAt: null, id: { gt: cursor.id } }
            : {
                OR: [
                  { dueAt: { gt: new Date(cursor.dueAt) } },
                  { dueAt: new Date(cursor.dueAt), id: { gt: cursor.id } },
                ],
              }),
        },
      ];
    }
    const rows = await tx.judgmentReviewTask.findMany({
      where,
      orderBy: [{ priority: 'asc' }, { dueAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const next = rows.length > limit ? page[page.length - 1] : undefined;

    const recordIds = [...new Set(page.map((row) => row.judgmentRecordId))];
    const records = recordIds.length
      ? await tx.judgmentRecord.findMany({
          where: { id: { in: recordIds } },
          select: {
            id: true,
            verdict: true,
            canonicalCompanyId: true,
          },
        })
      : [];
    const recordById = new Map(records.map((record) => [record.id, record]));
    const companyIds = [...new Set(records.map((record) => record.canonicalCompanyId))];
    const companies = companyIds.length
      ? await tx.canonicalCompany.findMany({
          where: { id: { in: companyIds } },
          select: { id: true, name: true },
        })
      : [];
    const companyNameById = new Map(companies.map((company) => [company.id, company.name]));

    return {
      items: page.map((row) => {
        const record = recordById.get(row.judgmentRecordId);
        return {
          id: row.id,
          judgmentRecordId: row.judgmentRecordId,
          reason: row.reason as ReviewReason,
          priority: row.priority as ReviewPriority,
          status: row.status as ReviewStatus,
          dueAt: row.dueAt,
          verdictAtJudge: record ? recordVerdict(record.verdict) : 'UNKNOWN',
          companyName: record
            ? (companyNameById.get(record.canonicalCompanyId) ?? null)
            : null,
        };
      }),
      nextCursor: next && next.id ? encodeCursor(next) : null,
    };
  });
}

/** 认领：queued → in_review（同 assignee 重复认领幂等）。 */
export async function claimReviewTask(
  prisma: PrismaClient,
  workspaceId: string,
  taskId: string,
  assignee: string,
): Promise<{ status: ReviewStatus }> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
    const claimed = await tx.judgmentReviewTask.updateMany({
      where: { id: taskId, workspaceId, status: 'queued' },
      data: { status: 'in_review', assignee },
    });
    if (claimed.count > 0) return { status: 'in_review' as const };
    const current = await tx.judgmentReviewTask.findUnique({
      where: { id: taskId },
      select: { workspaceId: true, status: true, assignee: true },
    });
    if (!current || current.workspaceId !== workspaceId) {
      throw new ReviewTaskNotFoundError(taskId);
    }
    if (current.status === 'in_review' && current.assignee === assignee) {
      return { status: 'in_review' as const };
    }
    throw new ReviewTaskStateError(
      `cannot claim review task in status ${current.status}`,
    );
  });
}

/**
 * 复核结论：写新 judgment_record（append-only、prompt_hash=HUMAN_PROMPT_HASH）、
 * 回流 judgment_golden_label（candidate）、任务置 resolved。整单在一个事务里。
 */
export async function resolveReviewTask(
  prisma: PrismaClient,
  workspaceId: string,
  taskId: string,
  input: ResolveReviewTaskInput,
  actor: string,
): Promise<ResolveReviewTaskResult> {
  if (!isVerdict(input.verdict)) {
    throw new ReviewOverrideError(`unknown verdict ${String(input.verdict)}`);
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
    const task = await tx.judgmentReviewTask.findUnique({
      where: { id: taskId },
    });
    if (!task || task.workspaceId !== workspaceId) {
      throw new ReviewTaskNotFoundError(taskId);
    }
    if (task.status !== 'in_review') {
      throw new ReviewTaskStateError(
        `review task must be in_review to resolve (current ${task.status})`,
      );
    }
    const record = (await tx.judgmentRecord.findUnique({
      where: { id: task.judgmentRecordId },
    })) as ReviewRecordRow | null;
    if (!record || record.workspaceId !== workspaceId) {
      throw new ReviewTaskNotFoundError(task.judgmentRecordId);
    }

    const criteria = applyCriterionOverrides(
      asCriteria(record.criteria),
      input.criterionOverrides ?? [],
    );
    const attempt = record.attempt + 1;
    const replayKey = {
      workspaceId,
      canonicalCompanyId: record.canonicalCompanyId,
      icpId: record.icpId,
      inputDigest: record.inputDigest,
      rubricVersion: record.rubricVersion,
      promptHash: HUMAN_PROMPT_HASH,
      judgeLevel: record.judgeLevel,
      attempt,
    };

    await tx.judgmentRecord.createMany({
      data: [
        {
          ...replayKey,
          runId: record.runId,
          verdict: input.verdict,
          verdictProposed: record.verdict,
          criteria: criteria as unknown as Prisma.InputJsonValue,
          evidenceRefs: [],
          evidenceCompleteness: record.evidenceCompleteness,
          schemaVersion: record.schemaVersion,
          outputDigest: canonicalDigest(criteria),
          modelRequested: HUMAN_MODEL_REQUESTED,
          sampling: {},
        },
      ],
      skipDuplicates: true,
    });
    const humanRecord = await tx.judgmentRecord.findUnique({
      where: {
        workspaceId_canonicalCompanyId_icpId_inputDigest_rubricVersion_promptHash_judgeLevel_attempt:
          replayKey,
      },
      select: { id: true, verdict: true },
    });
    if (!humanRecord) {
      throw new ReviewTaskStateError('human judgment record write did not persist');
    }
    if (humanRecord.verdict !== input.verdict) {
      throw new ReviewTaskStateError(
        `human judgment replay conflict (recorded ${humanRecord.verdict})`,
      );
    }

    const label = await tx.judgmentGoldenLabel.create({
      data: {
        workspaceId,
        canonicalCompanyId: record.canonicalCompanyId,
        icpId: record.icpId,
        label: input.verdict,
        labelSource: 'review',
        reviewTaskId: task.id,
        annotatorHash: sha256(actor),
        rubricVersion: record.rubricVersion,
        inputDigest: record.inputDigest,
        split: 'candidate',
      },
      select: { id: true },
    });

    const updated = await tx.judgmentReviewTask.updateMany({
      where: { id: task.id, workspaceId, status: 'in_review' },
      data: {
        status: 'resolved',
        resolvedVerdict: input.verdict,
        resolvedBy: actor,
        resolvedAt: new Date(),
        resolutionNote: input.note ?? null,
        reflowedLabelId: label.id,
      },
    });
    if (updated.count === 0) {
      throw new ReviewTaskStateError('review task state changed during resolve');
    }

    return { recordId: humanRecord.id, goldenLabelId: label.id };
  });
}

export interface JudgmentDetail {
  canonicalCompanyId: string;
  createdAt: Date;
  criteria: unknown;
  failureCode: string | null;
  id: string;
  modelRequested: string;
  verdict: ReviewVerdict;
}

/** 单条判定明细（只读；RLS 下跨租户不可见）。 */
export async function getJudgment(
  prisma: PrismaClient,
  workspaceId: string,
  recordId: string,
): Promise<JudgmentDetail | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
    const record = await tx.judgmentRecord.findUnique({
      where: { id: recordId },
      select: {
        id: true,
        workspaceId: true,
        verdict: true,
        criteria: true,
        canonicalCompanyId: true,
        modelRequested: true,
        failureCode: true,
        createdAt: true,
      },
    });
    if (!record || record.workspaceId !== workspaceId) return null;
    return {
      id: record.id,
      verdict: recordVerdict(record.verdict),
      criteria: record.criteria,
      canonicalCompanyId: record.canonicalCompanyId,
      modelRequested: record.modelRequested,
      failureCode: record.failureCode,
      createdAt: record.createdAt,
    };
  });
}

export interface JudgmentReviewStats {
  byPriority: Record<string, number>;
  byReason: Record<string, number>;
  byStatus: Record<string, number>;
  overturn: { rate: number | null; resolved: number; overturned: number };
  windowDays: number;
}

/** 队列统计（窗口默认 7 天）：状态/原因/优先级分布 + overturn rate。 */
export async function judgmentReviewStats(
  prisma: PrismaClient,
  workspaceId: string,
  windowDays = 7,
): Promise<JudgmentReviewStats> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const [status, reason, priority, resolvedTasks] = await Promise.all([
      tx.judgmentReviewTask.groupBy({
        by: ['status'],
        where: { workspaceId },
        _count: { _all: true },
      }),
      tx.judgmentReviewTask.groupBy({
        by: ['reason'],
        where: { workspaceId, createdAt: { gte: since } },
        _count: { _all: true },
      }),
      tx.judgmentReviewTask.groupBy({
        by: ['priority'],
        where: { workspaceId },
        _count: { _all: true },
      }),
      tx.judgmentReviewTask.findMany({
        where: {
          workspaceId,
          status: 'resolved',
          resolvedAt: { gte: since },
        },
        select: { resolvedVerdict: true, judgmentRecordId: true },
      }),
    ]);

    let overturned = 0;
    if (resolvedTasks.length > 0) {
      const originalRecords = await tx.judgmentRecord.findMany({
        where: {
          id: { in: resolvedTasks.map((task) => task.judgmentRecordId) },
        },
        select: { id: true, verdict: true },
      });
      const verdictById = new Map(
        originalRecords.map((record) => [record.id, record.verdict]),
      );
      for (const task of resolvedTasks) {
        const original = verdictById.get(task.judgmentRecordId);
        if (original && task.resolvedVerdict && task.resolvedVerdict !== original) {
          overturned += 1;
        }
      }
    }

    const asCounts = (rows: Array<Record<string, unknown>>): Record<string, number> =>
      Object.fromEntries(
        rows.map((row) => {
          const key = String(row.status ?? row.reason ?? row.priority);
          const count = (row._count as { _all?: number } | undefined)?._all ?? 0;
          return [key, Number(count)];
        }),
      );

    return {
      windowDays,
      byStatus: asCounts(status as unknown as Array<Record<string, unknown>>),
      byReason: asCounts(reason as unknown as Array<Record<string, unknown>>),
      byPriority: asCounts(priority as unknown as Array<Record<string, unknown>>),
      overturn: {
        resolved: resolvedTasks.length,
        overturned,
        rate: resolvedTasks.length === 0 ? null : overturned / resolvedTasks.length,
      },
    };
  });
}

/** rubric 版本随记录走；保留导出避免调用方各自 hardcode。 */
export const REVIEW_RUBRIC_VERSION = RUBRIC_VERSION;
