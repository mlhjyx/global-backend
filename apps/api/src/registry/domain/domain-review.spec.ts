import { describe, expect, it } from 'vitest';
import {
  DomainReviewError,
  addBusinessDays,
  buildReviewTasksFromVerification,
  decideReviewTask,
  decisionToResolutionUpdate,
  expireOverdueTasks,
  summarizeReviewSla,
  type DomainReviewTask,
} from './domain-review';
import type {
  DomainVerificationResult,
  DomainVerificationSignals,
  VerifyCandidateSetResult,
} from './domain-verifier';

const NOW = '2026-11-09T09:00:00Z'; // 周一

function signals(overrides: Partial<DomainVerificationSignals> = {}): DomainVerificationSignals {
  return {
    registerNumberExact: null,
    registerMismatch: false,
    multipleRegisters: false,
    vatExactAndViesValid: null,
    postalCodeAndCityMatch: false,
    nameSimilarity: 0.2,
    domainTokenMatchesBrand: false,
    parkedDomain: false,
    noLegalPage: false,
    ...overrides,
  };
}

function result(
  candidateDomain: string,
  overrides: Partial<DomainVerificationResult> = {},
): { candidateDomain: string } & DomainVerificationResult {
  return {
    candidateDomain,
    verdict: 'AMBIGUOUS',
    score: 60,
    matchType: 'name_only',
    signals: signals(),
    rejectReasons: [],
    pageRegister: null,
    pageVatId: null,
    evidenceUrls: [],
    ...overrides,
  };
}

function verification(
  results: VerifyCandidateSetResult['results'],
  overrides: Partial<VerifyCandidateSetResult> = {},
): VerifyCandidateSetResult {
  return { results, selectedDomain: null, nameCollision: false, ...overrides };
}

describe('addBusinessDays (SLA 3 工作日)', () => {
  it('skips weekends', () => {
    expect(addBusinessDays('2026-11-06T09:00:00Z', 3)).toBe('2026-11-11T09:00:00.000Z'); // 周五 → 周三
    expect(addBusinessDays('2026-11-07T09:00:00Z', 1)).toBe('2026-11-09T09:00:00.000Z'); // 周六 → 周一
    expect(addBusinessDays(NOW, 0)).toBe('2026-11-09T09:00:00.000Z');
  });

  it('rejects invalid inputs', () => {
    expect(() => addBusinessDays(NOW, -1)).toThrow(DomainReviewError);
    expect(() => addBusinessDays('not-a-date', 1)).toThrow(DomainReviewError);
  });
});

describe('buildReviewTasksFromVerification', () => {
  it('classifies AMBIGUOUS results by signal and sets the 3-business-day SLA', () => {
    const tasks = buildReviewTasksFromVerification(
      verification([
        result('collision-a.de', { score: 95 }),
        result('collision-b.de', { score: 90 }),
        result('portal.de', { signals: signals({ multipleRegisters: true }) }),
        result('rejected.de', { verdict: 'REJECTED', rejectReasons: ['LOW_SCORE'] }),
      ], { nameCollision: true }),
      { now: NOW },
    );
    expect(tasks.map((task) => [task.candidateDomain, task.reason, task.priority])).toEqual([
      ['collision-a.de', 'name_collision', 80],
      ['collision-b.de', 'name_collision', 80],
      ['portal.de', 'multi_candidates', 70],
    ]);
    // 非冲突场景的 AMBIGUOUS 落 low_confidence。
    const lowOnly = buildReviewTasksFromVerification(
      verification([result('weak.de', { score: 60 })]),
      { now: NOW },
    );
    expect(lowOnly.map((task) => [task.reason, task.priority])).toEqual([['low_confidence', 50]]);
    for (const task of tasks) {
      expect(task.status).toBe('OPEN');
      expect(task.dueAt).toBe('2026-11-12T09:00:00.000Z'); // 周一 + 3 个工作日 = 周四
      expect(task.assignee).toBeNull();
    }
  });

  it('samples VERIFIED results deterministically through the injected sampler', () => {
    const verified = verification(
      [
        result('a.de', { verdict: 'VERIFIED', score: 95 }),
        result('b.de', { verdict: 'VERIFIED', score: 92 }),
      ],
      { selectedDomain: 'a.de' },
    );
    const sampled = buildReviewTasksFromVerification(verified, {
      now: NOW,
      auditSampleRate: 0.5,
      auditSampler: (index) => index === 0,
    });
    expect(sampled).toHaveLength(1);
    expect(sampled[0]).toMatchObject({ candidateDomain: 'a.de', reason: 'audit_sample', priority: 30 });
    // 默认抽样器不抽 → 不产生审计任务；REJECTED 永不入队。
    expect(buildReviewTasksFromVerification(verified, { now: NOW })).toEqual([]);
    expect(
      buildReviewTasksFromVerification(
        verification([result('x.de', { verdict: 'REJECTED', rejectReasons: ['PARKED_DOMAIN'] })]),
        { now: NOW },
      ),
    ).toEqual([]);
  });

  it('rejects an invalid audit sample rate', () => {
    expect(() =>
      buildReviewTasksFromVerification(verification([]), { now: NOW, auditSampleRate: 1.5 }),
    ).toThrow(DomainReviewError);
  });
});

function openTask(overrides: Partial<DomainReviewTask> = {}): DomainReviewTask {
  return {
    id: 'task-1',
    reason: 'low_confidence',
    candidateDomain: 'muster-pumpen.de',
    resolutionRef: 'muster-pumpen.de',
    confidence: 61,
    priority: 50,
    status: 'OPEN',
    createdAt: NOW,
    dueAt: '2026-11-12T09:00:00Z',
    assignee: null,
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    ...overrides,
  };
}

describe('decideReviewTask / expireOverdueTasks', () => {
  it('moves OPEN tasks to terminal states with reviewer and timestamps', () => {
    const decided = decideReviewTask(openTask(), {
      outcome: 'APPROVED',
      reviewer: 'ops-anna',
      note: 'Impressum 命中',
      now: '2026-11-10T10:00:00Z',
    });
    expect(decided).toMatchObject({
      status: 'APPROVED',
      decidedBy: 'ops-anna',
      decidedAt: '2026-11-10T10:00:00Z',
      decisionNote: 'Impressum 命中',
    });
  });

  it('refuses to re-decide a terminal task or to decide without a reviewer', () => {
    const approved = decideReviewTask(openTask(), {
      outcome: 'APPROVED',
      reviewer: 'ops-anna',
      now: NOW,
    });
    try {
      decideReviewTask(approved, { outcome: 'REJECTED', reviewer: 'ops-bob', now: NOW });
      expect.unreachable();
    } catch (error) {
      expect((error as DomainReviewError).code).toBe('REVIEW_TASK_NOT_OPEN');
    }
    expect(() => decideReviewTask(openTask(), { outcome: 'APPROVED', reviewer: ' ', now: NOW })).toThrow(
      DomainReviewError,
    );
  });

  it('expires overdue OPEN tasks without changing their verdict (告警不改判)', () => {
    const { expired, unchanged } = expireOverdueTasks(
      [openTask({ id: 'late' }), openTask({ id: 'fresh', dueAt: '2026-12-01T09:00:00Z' })],
      '2026-11-13T09:00:00Z',
    );
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ id: 'late', status: 'EXPIRED', decisionNote: 'SLA_TIMEOUT' });
    expect(unchanged.map((task) => task.id)).toEqual(['fresh']);
  });
});

describe('summarizeReviewSla', () => {
  it('reports backlog, SLA rate, average decision hours and per-reason counts', () => {
    const tasks: DomainReviewTask[] = [
      openTask({ id: 't1', status: 'APPROVED', decidedAt: '2026-11-10T09:00:00Z', decidedBy: 'a' }), // 24h, in SLA
      openTask({
        id: 't2',
        reason: 'name_collision',
        status: 'REJECTED',
        decidedAt: '2026-11-14T09:00:00Z',
        decidedBy: 'b',
      }), // 120h, late
      openTask({ id: 't3', status: 'EXPIRED' }),
      openTask({ id: 't4', createdAt: '2026-11-08T09:00:00Z' }), // open 48h at NOW
    ];
    const summary = summarizeReviewSla(tasks, NOW);
    expect(summary).toMatchObject({
      total: 4,
      open: 1,
      decided: 2,
      expired: 1,
      slaMetRate: 1 / 3,
      avgDecisionHours: 72,
      oldestOpenHours: 24,
    });
    expect(summary.byReason.name_collision).toEqual({ open: 0, decided: 1 });
    expect(summary.byReason.low_confidence).toEqual({ open: 1, decided: 1 });
  });

  it('returns null metrics for an empty queue', () => {
    expect(summarizeReviewSla([], NOW)).toMatchObject({
      total: 0,
      slaMetRate: null,
      avgDecisionHours: null,
      oldestOpenHours: null,
    });
  });
});

describe('decisionToResolutionUpdate', () => {
  it('maps approvals/rejections/insufficient-evidence onto resolution drafts', () => {
    expect(decisionToResolutionUpdate(openTask({ status: 'APPROVED' }))).toEqual({
      status: 'VERIFIED',
      selected: true,
      matchType: 'manual',
    });
    expect(decisionToResolutionUpdate(openTask({ status: 'REJECTED' }))).toMatchObject({
      status: 'REJECTED',
      selected: false,
    });
    expect(decisionToResolutionUpdate(openTask({ status: 'NOT_FOUND' }))).toMatchObject({
      status: 'NOT_FOUND',
      selected: false,
    });
    expect(() => decisionToResolutionUpdate(openTask())).toThrow(DomainReviewError);
  });
});
