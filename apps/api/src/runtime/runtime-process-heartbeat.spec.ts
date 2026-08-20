import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRuntimeProcessHeartbeat } from './runtime-process-heartbeat';
import { RuntimeReadinessContributorRegistry } from './runtime-readiness-registry';

const identity = Object.freeze({
  attested: true as const,
  migration_revision: '20260816220000_production_parity_budget_runtime',
});

function fixture(
  heartbeat: ReturnType<typeof vi.fn>,
  migrationQuery: ReturnType<typeof vi.fn> = vi.fn(async () => [
    { migration_name: identity.migration_revision },
  ]),
) {
  const registry = new RuntimeReadinessContributorRegistry();
  const service = new ApiRuntimeProcessHeartbeat(
    {
      $queryRawUnsafe: migrationQuery,
    } as never,
    { current: () => ({ admitted: true }) } as never,
    { current: () => identity } as never,
    { heartbeat } as never,
    registry,
  );
  return { service, registry };
}

describe('ApiRuntimeProcessHeartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps API readiness closed when initial lease registration fails', async () => {
    const { service, registry } = fixture(
      vi.fn(async () => {
        throw new Error('writer password must not leak');
      }),
    );

    await service.onApplicationBootstrap();
    await expect(registry.check('api_runtime_lease')).resolves.toEqual({
      status: 'failed',
      code: 'API_RUNTIME_LEASE_NOT_READY',
    });
    await service.onApplicationShutdown();
  });

  it('closes API readiness immediately when a running heartbeat fails and can recover', async () => {
    const heartbeat = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(undefined);
    const { service, registry } = fixture(heartbeat);

    await service.onApplicationBootstrap();
    await expect(registry.check('api_runtime_lease')).resolves.toEqual({ status: 'ok' });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(registry.check('api_runtime_lease')).resolves.toEqual({
      status: 'failed',
      code: 'API_RUNTIME_LEASE_NOT_READY',
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(registry.check('api_runtime_lease')).resolves.toEqual({ status: 'ok' });
    await service.onApplicationShutdown();
  });

  it('retries migration admission after a transient bootstrap outage without reopening readiness early', async () => {
    const heartbeat = vi.fn(async () => undefined);
    const migrationQuery = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary database outage'))
      .mockResolvedValue([{ migration_name: identity.migration_revision }]);
    const { service, registry } = fixture(heartbeat, migrationQuery);

    await service.onApplicationBootstrap();
    await expect(registry.check('api_runtime_lease')).resolves.toEqual({
      status: 'failed',
      code: 'API_RUNTIME_LEASE_NOT_READY',
    });
    expect(heartbeat).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(registry.check('api_runtime_lease')).resolves.toEqual({
      status: 'ok',
    });
    expect(heartbeat).toHaveBeenNthCalledWith(1, 'API', 'STARTING', null);
    expect(heartbeat).toHaveBeenNthCalledWith(2, 'API', 'READY', null);
    await service.onApplicationShutdown();
  });
});
