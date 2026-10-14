import { describe, expect, it, vi } from 'vitest';
import { createQualifyActivities } from './qualify.activities';

/**
 * 评分阶段给 lead 盖 scored_at：这是「这条 lead 的队列已由评分决定」的持久事实，
 * 供 API（scored / queueBasis）与 LeadQualified 快照（scored_at）读取。
 */

function harness(existing: { status: string; fitVerdict: string | null; id: string } | null) {
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
  };
  const tx = {
    icpDefinition: {
      findUnique: vi.fn(async () => ({ status: 'ACTIVE', rules: [], roles: [], triggerSignals: [] })),
    },
    canonicalCompany: { findMany: vi.fn(async () => [company]) },
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
  return { activities, leadUpsert };
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
