import { describe, expect, it, vi } from 'vitest';
import { RuntimeReadinessService } from './runtime-readiness.service';

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    prisma: { $queryRawUnsafe: vi.fn(async () => [{ ok: 1 }]) },
    temporal: {
      probe: vi.fn(async () => ({ connected: true })),
    },
    admission: {
      current: vi.fn(() => ({ mode: 'development', admitted: true, checks: {} })),
    },
    ...overrides,
  };
}

describe('RuntimeReadinessService', () => {
  it('keeps worker and relay explicitly not_proven instead of promoting local process state', async () => {
    const deps = dependencies();
    const service = new RuntimeReadinessService(
      deps.prisma as never,
      deps.temporal as never,
      deps.admission as never,
    );

    await expect(service.check()).resolves.toMatchObject({
      status: 'ready',
      components: {
        database: { status: 'ok' },
        temporal_control_plane: { status: 'ok' },
        worker: { status: 'not_proven', code: 'DURABLE_HEARTBEAT_NOT_IMPLEMENTED' },
        outbox_relay: { status: 'not_proven', code: 'DURABLE_RELAY_EVIDENCE_NOT_IMPLEMENTED' },
        admission: { status: 'ok' },
      },
    });
  });

  it('keeps pilot readiness closed until durable worker and relay evidence exists', async () => {
    const deps = dependencies({
      admission: {
        current: vi.fn(() => ({ mode: 'pilot', admitted: true, checks: {} })),
      },
    });
    const service = new RuntimeReadinessService(
      deps.prisma as never,
      deps.temporal as never,
      deps.admission as never,
    );

    await expect(service.check()).resolves.toMatchObject({
      status: 'not_ready',
      components: {
        worker: { status: 'not_proven' },
        outbox_relay: { status: 'not_proven' },
      },
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
