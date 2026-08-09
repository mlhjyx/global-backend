import { describe, expect, it, vi } from 'vitest';
import { RuntimeReadinessService } from './runtime-readiness.service';

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    prisma: { $queryRawUnsafe: vi.fn(async () => [{ ok: 1 }]) },
    temporal: {
      readiness: vi.fn(async () => ({
        server: true,
        workflowPollers: 1,
        activityPollers: 1,
      })),
    },
    relay: {
      readiness: vi.fn(() => ({ ready: true, state: 'running' })),
    },
    admission: {
      current: vi.fn(() => ({ admitted: true, checks: {} })),
    },
    ...overrides,
  };
}

describe('RuntimeReadinessService', () => {
  it('reports ready only when DB, Temporal, worker pollers, relay, and admission are ready', async () => {
    const deps = dependencies();
    const service = new RuntimeReadinessService(
      deps.prisma as never,
      deps.temporal as never,
      deps.relay as never,
      deps.admission as never,
    );

    await expect(service.check()).resolves.toMatchObject({
      status: 'ready',
      components: {
        database: { status: 'ok' },
        temporal: { status: 'ok' },
        worker: { status: 'ok', workflow_pollers: 1, activity_pollers: 1 },
        outbox_relay: { status: 'ok' },
        admission: { status: 'ok' },
      },
    });
  });

  it('reports not_ready when no worker poller is visible', async () => {
    const deps = dependencies({
      temporal: {
        readiness: vi.fn(async () => ({ server: true, workflowPollers: 0, activityPollers: 1 })),
      },
    });
    const service = new RuntimeReadinessService(
      deps.prisma as never,
      deps.temporal as never,
      deps.relay as never,
      deps.admission as never,
    );

    await expect(service.check()).resolves.toMatchObject({
      status: 'not_ready',
      components: { worker: { status: 'failed', code: 'WORKER_POLLER_MISSING' } },
    });
  });

  it('never exposes raw dependency errors in the probe response', async () => {
    const deps = dependencies({
      prisma: {
        $queryRawUnsafe: vi.fn(async () => {
          throw new Error('postgresql://owner:password@db/customer');
        }),
      },
    });
    const service = new RuntimeReadinessService(
      deps.prisma as never,
      deps.temporal as never,
      deps.relay as never,
      deps.admission as never,
    );

    const report = await service.check();
    expect(report).toMatchObject({
      status: 'not_ready',
      components: { database: { status: 'failed', code: 'DATABASE_UNAVAILABLE' } },
    });
    expect(JSON.stringify(report)).not.toContain('password');
    expect(JSON.stringify(report)).not.toContain('customer');
  });
});
