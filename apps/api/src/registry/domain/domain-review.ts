/**
 * 人工复核队列契约（ch03 §3.12.5 / T3-15 的离线骨架）。
 *
 * 域名校验产出 AMBIGUOUS（或抽样审计的 VERIFIED）后进入人工队列：
 *  - 入队规则：AMBIGUOUS → low_confidence / name_collision（同名冲突）/ multi_candidates
 *    （集团门户多注册号）；VERIFIED 按可注入的抽样率（默认 5%）进 audit_sample；
 *  - SLA：3 个工作日（§3.12.5），`dueAt` 只跳周末（v0 无节假日日历，报告注明）；
 *  - 状态机：OPEN → APPROVED / REJECTED / NOT_FOUND（证据不足） / EXPIRED（超期告警，
 *    **不自动改判**——§3.8.2 reviewTimeout 只提醒）；终态不可重复裁决；
 *  - 指标：吞吐、SLA 达成率、按原因的积压（§3.12.5），超期任务显式暴露；
 *  - 裁决回写映射：APPROVED→resolution VERIFIED(selected)；REJECTED→REJECTED；
 *    NOT_FOUND→NOT_FOUND（全部为行草案，DB 写入属执行面 T3-10/T3-15 在线部分）。
 *
 * 本模块纯函数 + 注入抽样器：无 IO、无随机源（可复算），落库与运营台 API 留给执行面。
 */
import type { VerifyCandidateSetResult } from './domain-verifier';

export type ReviewTaskStatus = 'OPEN' | 'APPROVED' | 'REJECTED' | 'NOT_FOUND' | 'EXPIRED';

export type ReviewReason = 'low_confidence' | 'name_collision' | 'multi_candidates' | 'audit_sample';

export interface DomainReviewTask {
  id: string;
  reason: ReviewReason;
  candidateDomain: string;
  /** 自动判定落库行的引用（执行面为 company_domain_resolution.id；离线为 candidateDomain）。 */
  resolutionRef: string;
  /** 自动判定的置信分（0–100），用于队列排序与抽检留痕。 */
  confidence: number;
  priority: number;
  status: ReviewTaskStatus;
  createdAt: string;
  /** 3 个工作日 SLA（只跳周末）。 */
  dueAt: string;
  assignee: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
}

export class DomainReviewError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainReviewError';
    this.code = code;
  }
}

const DEFAULT_SLA_BUSINESS_DAYS = 3;
const DEFAULT_AUDIT_SAMPLE_RATE = 0.05;

/** 加 N 个工作日（跳过周六/周日；v0 不含节假日日历，报告需注明口径）。 */
export function addBusinessDays(fromIso: string, days: number): string {
  if (!Number.isInteger(days) || days < 0) {
    throw new DomainReviewError('SLA_DAYS_INVALID', `工作日天数非法：${days}`);
  }
  const date = new Date(fromIso);
  if (Number.isNaN(date.getTime())) {
    throw new DomainReviewError('SLA_DATE_INVALID', `时间非法：${fromIso}`);
  }
  let remaining = days;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return date.toISOString();
}

function reasonPriority(reason: ReviewReason): number {
  switch (reason) {
    case 'name_collision':
      return 80;
    case 'multi_candidates':
      return 70;
    case 'low_confidence':
      return 50;
    case 'audit_sample':
      return 30;
  }
}

export interface BuildReviewTasksOptions {
  now: string;
  /** 任务 id 生成器（默认 candidateDomain+reason 顺序编号；注入可复算）。 */
  nextId?: (candidateDomain: string, reason: ReviewReason, index: number) => string;
  slaBusinessDays?: number;
  auditSampleRate?: number;
  /** 抽样器：返回 true 表示该 VERIFIED 行进入抽样复核（默认基于注入的均匀随机数）。 */
  auditSampler?: (index: number) => boolean;
}

/**
 * 从一次多候选校验结果生成复核任务：
 *  - AMBIGUOUS → 按信号分类 low_confidence / name_collision / multi_candidates；
 *  - VERIFIED → 以 auditSampleRate 抽样进入 audit_sample（抽样器可注入以保持确定性）；
 *  - REJECTED 不入队（负证据在报告中留痕即可）。
 */
export function buildReviewTasksFromVerification(
  verification: VerifyCandidateSetResult,
  options: BuildReviewTasksOptions,
): DomainReviewTask[] {
  const slaDays = options.slaBusinessDays ?? DEFAULT_SLA_BUSINESS_DAYS;
  const sampleRate = options.auditSampleRate ?? DEFAULT_AUDIT_SAMPLE_RATE;
  if (sampleRate < 0 || sampleRate > 1) {
    throw new DomainReviewError('AUDIT_RATE_INVALID', `抽样率必须在 0..1：${sampleRate}`);
  }
  const dueAt = addBusinessDays(options.now, slaDays);
  const nextId =
    options.nextId ?? ((domain: string, reason: ReviewReason, index: number) => `${domain}:${reason}:${index}`);
  const sampler = options.auditSampler ?? (() => false);

  const tasks: DomainReviewTask[] = [];
  let auditIndex = 0;
  for (const [index, result] of verification.results.entries()) {
    let reason: ReviewReason | null = null;
    if (result.verdict === 'AMBIGUOUS') {
      // 信号优先：集团门户（多注册号）比泛化的同名冲突更具体。
      if (result.signals.multipleRegisters) reason = 'multi_candidates';
      else if (verification.nameCollision && result.score >= 55) reason = 'name_collision';
      else reason = 'low_confidence';
    } else if (result.verdict === 'VERIFIED' && sampleRate > 0) {
      if (sampler(auditIndex)) reason = 'audit_sample';
      auditIndex += 1;
    }
    if (!reason) continue;
    tasks.push({
      id: nextId(result.candidateDomain, reason, index),
      reason,
      candidateDomain: result.candidateDomain,
      resolutionRef: result.candidateDomain,
      confidence: result.score,
      priority: reasonPriority(reason),
      status: 'OPEN',
      createdAt: options.now,
      dueAt,
      assignee: null,
      decidedAt: null,
      decidedBy: null,
      decisionNote: null,
    });
  }
  return tasks;
}

export type ReviewOutcome = 'APPROVED' | 'REJECTED' | 'NOT_FOUND';

export interface ReviewDecision {
  outcome: ReviewOutcome;
  reviewer: string;
  note?: string;
  now: string;
}

/** 状态机守卫：只有 OPEN 可被裁决；终态重复裁决抛错（幂等由调用方按 id 去重）。 */
export function decideReviewTask(task: DomainReviewTask, decision: ReviewDecision): DomainReviewTask {
  if (task.status !== 'OPEN') {
    throw new DomainReviewError(
      'REVIEW_TASK_NOT_OPEN',
      `任务 ${task.id} 状态为 ${task.status}，不能再裁决`,
    );
  }
  if (!decision.reviewer.trim()) {
    throw new DomainReviewError('REVIEWER_REQUIRED', '裁决必须记录 reviewer');
  }
  return {
    ...task,
    status: decision.outcome,
    decidedAt: decision.now,
    decidedBy: decision.reviewer,
    decisionNote: decision.note ?? null,
  };
}

/** SLA 超期告警：OPEN 且已过 dueAt → EXPIRED（只提醒，不改判定——§3.8.2）。 */
export function expireOverdueTasks(tasks: readonly DomainReviewTask[], now: string): {
  expired: DomainReviewTask[];
  unchanged: DomainReviewTask[];
} {
  const nowMs = new Date(now).getTime();
  const expired: DomainReviewTask[] = [];
  const unchanged: DomainReviewTask[] = [];
  for (const task of tasks) {
    if (task.status === 'OPEN' && new Date(task.dueAt).getTime() < nowMs) {
      expired.push({ ...task, status: 'EXPIRED', decidedAt: now, decidedBy: null, decisionNote: 'SLA_TIMEOUT' });
    } else {
      unchanged.push(task);
    }
  }
  return { expired, unchanged };
}

export interface ReviewSlaSummary {
  total: number;
  open: number;
  decided: number;
  expired: number;
  /** 已完成裁决中在 dueAt 前关闭的比例（含 EXPIRED 视为未达成）；无已关闭任务时为 null。 */
  slaMetRate: number | null;
  /** 平均裁决耗时（小时，基于 decidedAt-createdAt）；无裁决时为 null。 */
  avgDecisionHours: number | null;
  byReason: Record<ReviewReason, { open: number; decided: number }>;
  /** 当前积压（OPEN）中最久等待小时数；无积压为 null。 */
  oldestOpenHours: number | null;
}

/** SLA/吞吐统计（§3.12.5 的质量指标离线口径）。 */
export function summarizeReviewSla(
  tasks: readonly DomainReviewTask[],
  now: string,
): ReviewSlaSummary {
  const nowMs = new Date(now).getTime();
  const byReason: ReviewSlaSummary['byReason'] = {
    low_confidence: { open: 0, decided: 0 },
    name_collision: { open: 0, decided: 0 },
    multi_candidates: { open: 0, decided: 0 },
    audit_sample: { open: 0, decided: 0 },
  };
  let open = 0;
  let decided = 0;
  let expired = 0;
  let slaMet = 0;
  let closed = 0;
  let decisionHoursSum = 0;
  let decisionCount = 0;
  let oldestOpenHours: number | null = null;

  for (const task of tasks) {
    if (task.status === 'OPEN') {
      open += 1;
      byReason[task.reason].open += 1;
      const waitHours = (nowMs - new Date(task.createdAt).getTime()) / 3_600_000;
      if (oldestOpenHours === null || waitHours > oldestOpenHours) oldestOpenHours = waitHours;
      continue;
    }
    if (task.status === 'EXPIRED') {
      expired += 1;
      closed += 1;
      continue;
    }
    decided += 1;
    byReason[task.reason].decided += 1;
    closed += 1;
    if (task.decidedAt && new Date(task.decidedAt).getTime() <= new Date(task.dueAt).getTime()) {
      slaMet += 1;
    }
    if (task.decidedAt) {
      decisionHoursSum += (new Date(task.decidedAt).getTime() - new Date(task.createdAt).getTime()) / 3_600_000;
      decisionCount += 1;
    }
  }

  return {
    total: tasks.length,
    open,
    decided,
    expired,
    slaMetRate: closed > 0 ? slaMet / closed : null,
    avgDecisionHours:
      decisionCount > 0 ? Number((decisionHoursSum / decisionCount).toFixed(2)) : null,
    byReason,
    oldestOpenHours:
      oldestOpenHours === null ? null : Number(oldestOpenHours.toFixed(2)),
  };
}

export interface ResolutionUpdateDraft {
  status: 'VERIFIED' | 'REJECTED' | 'NOT_FOUND';
  selected: boolean;
  matchType: 'manual';
}

/** 裁决 → `company_domain_resolution` 行草案：批准即选中；证据不足转 NOT_FOUND。 */
export function decisionToResolutionUpdate(task: DomainReviewTask): ResolutionUpdateDraft {
  if (task.status === 'APPROVED') {
    return { status: 'VERIFIED', selected: true, matchType: 'manual' };
  }
  if (task.status === 'REJECTED') {
    return { status: 'REJECTED', selected: false, matchType: 'manual' };
  }
  if (task.status === 'NOT_FOUND') {
    return { status: 'NOT_FOUND', selected: false, matchType: 'manual' };
  }
  throw new DomainReviewError(
    'REVIEW_TASK_NOT_DECIDED',
    `任务 ${task.id} 尚未裁决（状态 ${task.status}）`,
  );
}
