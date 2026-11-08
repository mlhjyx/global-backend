import { describe, expect, it, vi } from 'vitest';
import { ChannelHealthSweepService } from './channel-health-sweep.service';

const NOW = new Date('2026-11-09T00:00:00Z');
const DAY = 86_400_000;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ch-1',
    name: 'Acme 渠道',
    status: 'ENABLED',
    consecutiveFailures: 20,
    lastSuccessAt: new Date(NOW.getTime() - 5 * DAY),
    createdAt: new Date(NOW.getTime() - 60 * DAY),
    ...overrides,
  };
}

function makePrisma(rows: Array<Record<string, unknown>>, existingWarning = false) {
  const writes = { updates: [] as Array<Record<string, unknown>>, events: [] as Array<Record<string, unknown>> };
  const tx = {
    sourceChannel: {
      findMany: vi.fn(async () => rows),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        writes.updates.push({ id: where.id, ...data });
        return {};
      }),
    },
    sourceChannelHealthEvent: {
      findFirst: vi.fn(async () => (existingWarning ? { id: 'evt-old' } : null)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.events.push(data);
        return { id: `evt-${writes.events.length}`, ...data };
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    sourceChannel: { findMany: tx.sourceChannel.findMany },
  };
  return { prisma, writes };
}

describe('渠道健康扫描（20/4 预警、30/7 自动停用）', () => {
  it('30 次且 7 天无成功 → AUTO_DISABLED + AUTO_STREAK 原因 + 事件', async () => {
    const { prisma, writes } = makePrisma([
      row({ consecutiveFailures: 30, lastSuccessAt: new Date(NOW.getTime() - 8 * DAY) }),
    ]);
    const service = new ChannelHealthSweepService(prisma as never);
    const result = await service.sweep(NOW);
    expect(result).toMatchObject({ scanned: 1, autoDisabled: 1 });
    expect(writes.updates[0]).toMatchObject({ status: 'AUTO_DISABLED', disabledReason: 'AUTO_STREAK' });
    expect(writes.events[0]).toMatchObject({ event: 'AUTO_DISABLED_30_7D' });
  });

  it('20 次且 4 天无成功 → WARNING 事件；已有未清的 WARNING 不重复写', async () => {
    const fresh = makePrisma([row()]);
    const service = new ChannelHealthSweepService(fresh.prisma as never);
    await expect(service.sweep(NOW)).resolves.toMatchObject({ scanned: 1, warned: 1, autoDisabled: 0 });
    expect(fresh.writes.events[0]).toMatchObject({ event: 'WARNING_20_4D' });

    const deduped = makePrisma([row()], true);
    const service2 = new ChannelHealthSweepService(deduped.prisma as never);
    await expect(service2.sweep(NOW)).resolves.toMatchObject({ scanned: 1, warned: 0 });
    expect(deduped.writes.events).toHaveLength(0);
  });

  it('时间窗未到（4 天内成功过）不预警', async () => {
    const { prisma, writes } = makePrisma([
      row({ consecutiveFailures: 25, lastSuccessAt: new Date(NOW.getTime() - 2 * DAY) }),
    ]);
    const service = new ChannelHealthSweepService(prisma as never);
    await expect(service.sweep(NOW)).resolves.toMatchObject({ scanned: 1, warned: 0, autoDisabled: 0 });
    expect(writes.updates).toHaveLength(0);
    expect(writes.events).toHaveLength(0);
  });

  it('扫描范围只含 ENABLED 且连续失败 ≥20 的渠道', async () => {
    const { prisma } = makePrisma([]);
    const service = new ChannelHealthSweepService(prisma as never);
    await service.sweep(NOW);
    const args = (prisma.sourceChannel.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(args.where).toMatchObject({ status: 'ENABLED', consecutiveFailures: { gte: 20 } });
  });
});
