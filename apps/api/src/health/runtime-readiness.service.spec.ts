import { describe, expect, it, vi } from 'vitest';
import { RuntimeReadinessService } from './runtime-readiness.service';

function dependencies(overrides: Record<string, unknown> = {}) {
  const transactionClient = {
    $executeRawUnsafe: vi.fn(async () => 0),
    $queryRawUnsafe: vi.fn(async () => [{ ok: 1 }]),
  };
  return {
    prisma: {
      $transaction: vi.fn(async (operation: (client: typeof transactionClient) => Promise<unknown>) =>
        operation(transactionClient),
      ),
      $queryRawUnsafe: vi.fn(async (_query: string, component: string) => [
        {
          component,
          state: 'RUNNING',
          heartbeat_at: new Date('2026-08-12T08:00:00.000Z'),
          age_ms: 1_000,
        },
      ]),
    },
    transactionClient,
    temporal: {
      probe: vi.fn(async () => ({ connected: true })),
    },
    admission: {
      current: vi.fn(() => ({
        mode: 'development',
        admitted: true,
        checks: {},
      })),
    },
    ...overrides,
  };
}

describe('RuntimeReadinessService', () => {
  it('requires fresh durable worker and relay heartbeats before reporting ready', async () => {
    const deps = dependencies();
    const service = new RuntimeReadinessService(deps.prisma as never, deps.temporal as never, deps.admission as never);

    await expect(service.check()).resolves.toMatchObject({
      status: 'ready',
      components: {
        database: { status: 'ok' },
        temporal_control_plane: { status: 'ok' },
        worker: {
          status: 'ok',
          evidence: {
            source: 'postgresql_lease',
            heartbeat_at: '2026-08-12T08:00:00.000Z',
            age_ms: 1_000,
          },
        },
        outbox_relay: {
          status: 'ok',
          evidence: {
            source: 'postgresql_lease',
            heartbeat_at: '2026-08-12T08:00:00.000Z',
            age_ms: 1_000,
          },
        },
        admission: { status: 'ok' },
      },
    });
  });

  it('bounds both database connection acquisition and the statement itself', async () => {
    const deps = dependencies();
    const service = new RuntimeReadinessService(deps.prisma as never, deps.temporal as never, deps.admission as never);

    await expect(service.check()).resolves.toMatchObject({
      components: { database: { status: 'ok' } },
    });
    expect(deps.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 1_000,
      timeout: 2_500,
    });
    expect(deps.transactionClient.$executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL statement_timeout = 2000');
    expect(deps.transactionClient.$queryRawUnsafe).toHaveBeenCalledWith('SELECT 1');
  });

  it('allows pilot readiness when durable worker and relay evidence is fresh', async () => {
    const deps = dependencies({
      admission: {
        current: vi.fn(() => ({ mode: 'pilot', admitted: true, checks: {} })),
      },
    });
    const service = new RuntimeReadinessService(deps.prisma as never, deps.temporal as never, deps.admission as never);

    await expect(service.check()).resolves.toMatchObject({
      status: 'ready',
      components: {
        worker: { status: 'ok' },
        outbox_relay: { status: 'ok' },
      },
    });
  });

  it('fails readiness when a worker heartbeat is stale even if Temporal is reachable', async () => {
    const deps = dependencies({
      prisma: {
        $transaction: vi.fn(async (operation: (client: typeof transactionClient) => Promise<unknown>) =>
          operation(transactionClient),
        ),
        $queryRawUnsafe: vi.fn(async (_query: string, component: string) => [
          {
            component,
            state: 'RUNNING',
            heartbeat_at: new Date('2026-08-12T08:00:00.000Z'),
            age_ms: component === 'WORKER' ? 20_001 : 1_000,
          },
        ]),
      },
    });
    const service = new RuntimeReadinessService(deps.prisma as never, deps.temporal as never, deps.admission as never);

    await expect(service.check()).resolves.toMatchObject({
      status: 'not_ready',
      components: {
        temporal_control_plane: { status: 'ok' },
        worker: {
          status: 'failed',
          code: 'DURABLE_HEARTBEAT_STALE',
          evidence: { age_ms: 20_001 },
        },
        outbox_relay: { status: 'ok' },
      },
    });
  });

  it('fails closed when a durable component has never reported', async () => {
    const deps = dependencies({
      prisma: {
        $transaction: vi.fn(async (operation: (client: typeof transactionClient) => Promise<unknown>) =>
          operation(transactionClient),
        ),
        $queryRawUnsafe: vi.fn(async (_query: string, component: string) =>
          component === 'OUTBOX_RELAY' ? [] : [{ state: 'RUNNING', heartbeat_at: new Date(), age_ms: 100 }],
        ),
      },
    });
    const service = new RuntimeReadinessService(deps.prisma as never, deps.temporal as never, deps.admission as never);

    await expect(service.check()).resolves.toMatchObject({
      status: 'not_ready',
      components: {
        worker: { status: 'ok' },
        outbox_relay: {
          status: 'failed',
          code: 'DURABLE_HEARTBEAT_MISSING',
        },
      },
    });
  });

  it('never exposes raw dependency errors in the probe response', async () => {
    const deps = dependencies({
      prisma: {
        $transaction: vi.fn(async () => {
          throw new Error('postgresql://owner:password@db/customer');
        }),
      },
    });
    const service = new RuntimeReadinessService(deps.prisma as never, deps.temporal as never, deps.admission as never);

    const report = await service.check();
    expect(report).toMatchObject({
      status: 'not_ready',
      components: {
        database: { status: 'failed', code: 'DATABASE_UNAVAILABLE' },
      },
    });
    expect(JSON.stringify(report)).not.toContain('password');
    expect(JSON.stringify(report)).not.toContain('customer');
  });
});
