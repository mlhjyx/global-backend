import { describe, expect, it, vi } from 'vitest';
import { ChannelService } from './channel.service';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CHANNEL_ID = '33333333-3333-4333-8333-333333333333';
const CTX = { workspaceId: WORKSPACE_ID, userId: USER_ID, roles: [] } as never;
const RECORD_A = '55555555-5555-4555-8555-555555555551';
const RECORD_B = '55555555-5555-4555-8555-555555555552';

function recordRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    crawlRunId: '44444444-4444-4444-8444-444444444444',
    name: 'Acme',
    website: null,
    country: null,
    industry: null,
    products: null,
    keywords: null,
    contactName: null,
    contactTitle: null,
    email: null,
    phone: null,
    sourceUrl: 'https://acme.example',
    firstSeenAt: new Date('2026-11-09T00:00:00Z'),
    lastSeenAt: new Date('2026-11-09T00:00:00Z'),
    contentHash: null,
    reviewStatus: 'PENDING',
    reviewedBy: null,
    reviewedAt: null,
    materializedCompanyId: null,
    ...overrides,
  };
}

function makeService(state: {
  channel?: Record<string, unknown> | null;
  counts?: Array<{ reviewStatus: string; _count: { _all: number } }>;
  found?: Record<string, unknown>[];
  updateManyCount?: number;
} = {}) {
  const writes = { reviews: [] as Array<Record<string, unknown>>, channelUpdates: [] as Array<Record<string, unknown>>, events: [] as Array<Record<string, unknown>> };
  const tx = {
    sourceChannel: {
      findUnique: vi.fn(async () =>
        state.channel === undefined ? { id: CHANNEL_ID, status: 'ENABLED' } : state.channel,
      ),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.channelUpdates.push(data);
        return {};
      }),
    },
    sourceChannelRecord: {
      updateMany: vi.fn(async ({ where, data }: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
        writes.reviews.push({ where, data });
        return { count: state.updateManyCount ?? where.id.in.length };
      }),
      groupBy: vi.fn(async () => state.counts ?? []),
      findMany: vi.fn(async () => state.found ?? []),
    },
    sourceChannelHealthEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.events.push(data);
        return data;
      }),
    },
  };
  const prisma = { withWorkspace: vi.fn(async (_ws: string, cb: (t: typeof tx) => unknown) => cb(tx)) };
  const service = new ChannelService(prisma as never, undefined, undefined);
  return { service, tx, writes };
}

describe('CH-7 观察名单抽检', () => {
  it('批量置 REJECTED：写 reviewedBy/reviewedAt 并返回三态计数', async () => {
    const { service, writes } = makeService({
      counts: [
        { reviewStatus: 'PENDING', _count: { _all: 5 } },
        { reviewStatus: 'REJECTED', _count: { _all: 3 } },
      ],
    });
    const result = await service.reviewChannelRecords(CTX, CHANNEL_ID, {
      recordIds: [RECORD_A, RECORD_B],
      verdict: 'REJECTED',
    });
    expect(writes.reviews[0]!.data).toMatchObject({
      reviewStatus: 'REJECTED',
      reviewedBy: USER_ID,
      reviewedAt: expect.any(Date),
    });
    expect(result).toMatchObject({ reviewed: 2, verdict: 'REJECTED', autoDisabled: false });
    expect(result.counts).toEqual({ PENDING: 5, APPROVED: 0, REJECTED: 3 });
  });

  it('REJECTED 率 >20% 且已抽检 ≥20 → 渠道回 DISABLED(GOVERNANCE) + 健康事件', async () => {
    const { service, writes } = makeService({
      counts: [
        { reviewStatus: 'APPROVED', _count: { _all: 15 } },
        { reviewStatus: 'REJECTED', _count: { _all: 6 } },
      ],
    });
    const result = await service.reviewChannelRecords(CTX, CHANNEL_ID, {
      recordIds: [RECORD_A],
      verdict: 'REJECTED',
    });
    expect(result.autoDisabled).toBe(true);
    expect(writes.channelUpdates[0]).toMatchObject({ status: 'DISABLED', disabledReason: 'GOVERNANCE' });
    expect(writes.events[0]).toMatchObject({
      event: 'MANUAL_DISABLE',
      detail: expect.objectContaining({ reason: 'RECORD_REJECTION_RATE', reviewed: 21, rejected: 6 }),
    });
  });

  it('样本不足 20 条或比率 ≤20% 不触发停用', async () => {
    for (const counts of [
      [{ reviewStatus: 'APPROVED', _count: { _all: 2 } }, { reviewStatus: 'REJECTED', _count: { _all: 1 } }],
      [{ reviewStatus: 'APPROVED', _count: { _all: 20 } }, { reviewStatus: 'REJECTED', _count: { _all: 5 } }],
    ]) {
      const { service, writes } = makeService({ counts });
      const result = await service.reviewChannelRecords(CTX, CHANNEL_ID, {
        recordIds: [RECORD_A],
        verdict: 'REJECTED',
      });
      expect(result.autoDisabled).toBe(false);
      expect(writes.channelUpdates).toHaveLength(0);
    }
  });

  it('非法 verdict / recordIds 或跨渠道 id → 400，且不写库', async () => {
    const { service, writes } = makeService();
    for (const body of [
      { recordIds: ['not-a-uuid'], verdict: 'APPROVED' },
      { recordIds: [], verdict: 'APPROVED' },
      { recordIds: [RECORD_A] },
    ]) {
      await expect(service.reviewChannelRecords(CTX, CHANNEL_ID, body)).rejects.toMatchObject({ status: 400 });
    }
    const partial = makeService({ updateManyCount: 1 });
    await expect(
      partial.service.reviewChannelRecords(CTX, CHANNEL_ID, { recordIds: [RECORD_A, RECORD_B], verdict: 'APPROVED' }),
    ).rejects.toMatchObject({
      status: 400,
      response: { error: { code: 'CHANNEL_RECORD_IDS_INVALID' } },
    });
    expect(writes.reviews).toHaveLength(0);
  });

  it('list 支持 reviewStatus 过滤并返回计数与审计字段', async () => {
    const { service, tx } = makeService({
      found: [recordRow(RECORD_A, { reviewStatus: 'REJECTED', reviewedBy: 'op-1', reviewedAt: new Date('2026-11-09T01:00:00Z') })],
      counts: [{ reviewStatus: 'REJECTED', _count: { _all: 1 } }],
    });
    const result = await service.listChannelRecords(CTX, CHANNEL_ID, '10', 'REJECTED');
    expect(tx.sourceChannelRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { channelId: CHANNEL_ID, reviewStatus: 'REJECTED' }, take: 10 }),
    );
    expect(result.counts).toEqual({ PENDING: 0, APPROVED: 0, REJECTED: 1 });
    expect(result.records[0]).toMatchObject({ reviewStatus: 'REJECTED', reviewedBy: 'op-1' });

    const invalid = makeService();
    await expect(invalid.service.listChannelRecords(CTX, CHANNEL_ID, undefined, 'BOGUS')).rejects.toMatchObject({ status: 400 });
  });
});
