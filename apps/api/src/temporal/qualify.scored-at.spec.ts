import { describe, expect, it, vi } from 'vitest';
import { createQualifyActivities } from './qualify.activities';

/**
 * 评分阶段给 lead 盖 scored_at：这是「这条 lead 的队列已由评分决定」的持久事实，
 * 供 API（scored / queueBasis）与 LeadQualified 快照（scored_at）读取。
 */

function harness(
  existing: { status: string; fitVerdict: string | null; id: string; decisions?: Array<{ id: string }> } | null,
) {
  const leadUpsert = vi.fn(async () => ({}));
  const company = {
    id: 'company-real',
    name: 'Real Co',
    domain: 'real.example',
    country: 'DE',
    industry: 'manufacturing',
    employeeCount: 10,
    revenueUsd: null,
    attributes: {},
    status: 'NEW',
    contacts: [],
    companyContactPoints: [],
  };
  const tx = {
    icpDefinition: {
      findUnique: vi.fn(async () => ({ status: 'ACTIVE', rules: [], roles: [], triggerSignals: [] })),
    },
    canonicalCompany: { findMany: vi.fn(async () => [company]) },
    // Scoring rules v3 (#649) reads company/domain suppressions once per batch.
    suppressionRecord: { findMany: vi.fn(async () => []) },
    fieldEvidence: {
      findMany: vi.fn(async () => [{ entityId: company.id, providerKey: 'companies_house', license: 'OGL-UK-3.0' }]),
    },
    lead: { findUnique: vi.fn(async () => existing), upsert: leadUpsert },
    sanctionsScreeningResult: { findFirst: vi.fn(), upsert: vi.fn() },
    outboxEvent: { create: vi.fn(async () => ({})) },
  };
  const prisma = {
    withWorkspace: async <T>(_workspaceId: string, callback: (client: typeof tx) => Promise<T>): Promise<T> =>
      callback(tx),
  };
  const activities = createQualifyActivities({ prisma: prisma as never });
  return { activities, leadUpsert, leadFindUnique: tx.lead.findUnique };
}

type UpsertArgs = { update: Record<string, unknown>; create: Record<string, unknown> };

describe('scoreCandidates — scored_at', () => {
  it('新建与刷新都盖同一个评分时刻', async () => {
    const { activities, leadUpsert } = harness(null);
    const before = Date.now();

    await expect(activities.scoreCandidates({ workspaceId: 'ws-1', icpId: 'icp-1' })).resolves.toMatchObject({
      scored: 1,
    });

    const args = leadUpsert.mock.calls[0]![0] as unknown as UpsertArgs;
    expect(args.create.scoredAt).toBeInstanceOf(Date);
    expect(args.update.scoredAt).toBeInstanceOf(Date);
    expect((args.create.scoredAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(args.update.scoredAt).toBe(args.create.scoredAt);
  });

  it('人工终态（QUALIFIED）的 lead 不改 status/queue，但分数与 scored_at 照常刷新', async () => {
    const { activities, leadUpsert } = harness({ id: 'lead-1', status: 'QUALIFIED', fitVerdict: 'match' });

    await activities.scoreCandidates({ workspaceId: 'ws-1', icpId: 'icp-1' });

    const args = leadUpsert.mock.calls[0]![0] as unknown as UpsertArgs;
    expect(args.update).not.toHaveProperty('status');
    expect(args.update).not.toHaveProperty('queue');
    expect(args.update.scoredAt).toBeInstanceOf(Date);
    expect(typeof args.update.totalScore).toBe('number');
  });
});

/**
 * 人工拒绝是终态：评分阶段自己也写 status=REJECTED，所以只凭状态分不出人工拒绝与评分拒绝，
 * 与 API 的 queueBasis（human_reject）同一判据——REJECTED 且有一条 reject 裁决。FAILED 收尾也请求
 * 评分（#648）之后，没有这条判据，每次重评分都会把人工拒绝改回 REVIEW/needs_review。
 */
describe('scoreCandidates — 人工拒绝不被重评覆盖', () => {
  it('REJECTED 且有 reject 裁决的 lead：不改 status/queue，分数与 scored_at 照常刷新；裁决只探一条', async () => {
    const { activities, leadUpsert, leadFindUnique } = harness({
      id: 'lead-1',
      status: 'REJECTED',
      fitVerdict: 'match',
      decisions: [{ id: 'decision-1' }],
    });

    await activities.scoreCandidates({ workspaceId: 'ws-1', icpId: 'icp-1' });

    const args = leadUpsert.mock.calls[0]![0] as unknown as UpsertArgs;
    expect(args.update).not.toHaveProperty('status');
    expect(args.update).not.toHaveProperty('queue');
    expect(args.update.scoredAt).toBeInstanceOf(Date);
    expect(typeof args.update.totalScore).toBe('number');
    expect(leadFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          status: true,
          fitVerdict: true,
          decisions: { where: { action: 'reject' }, select: { id: true }, take: 1 },
        }),
      }),
    );
  });

  it('评分写的 REJECTED（没有 reject 裁决）仍由重评分决定 status/queue', async () => {
    const { activities, leadUpsert } = harness({ id: 'lead-1', status: 'REJECTED', fitVerdict: 'match', decisions: [] });

    await activities.scoreCandidates({ workspaceId: 'ws-1', icpId: 'icp-1' });

    const args = leadUpsert.mock.calls[0]![0] as unknown as UpsertArgs;
    expect(args.update).toHaveProperty('status');
    expect(args.update).toHaveProperty('queue');
  });
});
