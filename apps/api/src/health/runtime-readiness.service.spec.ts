import { describe, expect, it, vi } from 'vitest';
import { RuntimeReadinessService } from './runtime-readiness.service';

function dependencies(overrides: Record<string, unknown> = {}) {
  const transactionClient = {
    $executeRawUnsafe: vi.fn(async () => 0),
    $queryRawUnsafe: vi.fn(async (query: string) =>
      query === 'SELECT 1' ? [{ ok: 1 }] : [{ migration_name: '20260816000000_runtime_process_lease' }],
    ),
  };
  return {
    prisma: {
      $transaction: vi.fn(async (operation: (client: typeof transactionClient) => Promise<unknown>) =>
        operation(transactionClient),
      ),
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
    releaseIdentity: {
      current: vi.fn(() => ({
        attested: true,
        build_sha: 'a'.repeat(40),
        image_digest: `sha256:${'b'.repeat(64)}`,
        artifact_digest: `sha256:${'c'.repeat(64)}`,
        migration_revision: '20260816000000_runtime_process_lease',
      })),
    },
    leases: {
      inspectWorkerQueue: vi.fn(async () => ({ status: 'ok' })),
      inspectRole: vi.fn(async () => ({ status: 'ok' })),
    },
    contributors: {
      check: vi.fn(async () => ({ status: 'ok' })),
    },
    ...overrides,
  };
}

describe('RuntimeReadinessService', () => {
  it('starts fail-closed and publishes a dynamic worker failure into the mutation snapshot', async () => {
    const deps = dependencies({
      leases: {
        inspectWorkerQueue: vi.fn(async () => ({
          status: 'failed',
          code: 'MATCHING_WORKER_NOT_READY',
        })),
        inspectRole: vi.fn(async () => ({ status: 'ok' })),
      },
    });
    const service = new RuntimeReadinessService(
      deps.prisma as never,
      deps.temporal as never,
      deps.admission as never,
      deps.releaseIdentity as never,
      deps.leases as never,
      deps.contributors as never,
    );

    expect(service.current()).toMatchObject({
      status: 'not_ready',
      capabilities: {
        execution_budget_jwks: {
          status: 'not_proven',
          code: 'RUNTIME_READINESS_SNAPSHOT_UNAVAILABLE',
        },
        workspace_budget_authority: {
          status: 'not_proven',
          code: 'RUNTIME_READINESS_SNAPSHOT_UNAVAILABLE',
        },
        platform_budget_authority: {
          status: 'not_proven',
          code: 'RUNTIME_READINESS_SNAPSHOT_UNAVAILABLE',
        },
      },
      components: {
        worker: {
          status: 'not_proven',
          code: 'RUNTIME_READINESS_SNAPSHOT_UNAVAILABLE',
        },
      },
    });
    await expect(service.check()).resolves.toMatchObject({
      status: 'not_ready',
      components: {
        worker: { status: 'failed', code: 'MATCHING_WORKER_NOT_READY' },
      },
    });
    expect(service.current()).toMatchObject({
      status: 'not_ready',
      components: {
        worker: { status: 'failed', code: 'MATCHING_WORKER_NOT_READY' },
      },
    });
  });

  it('requires exact durable worker, relay, migration and storage evidence in development too', async () => {
    const deps = dependencies();
    const service = new RuntimeReadinessService(
      deps.prisma as never,
      deps.temporal as never,
      deps.admission as never,
      deps.releaseIdentity as never,
      deps.leases as never,
      deps.contributors as never,
    );

    await expect(service.check()).resolves.toMatchObject({
      status: 'ready',
      capabilities: {
        execution_budget_jwks: { status: 'ok' },
        workspace_budget_authority: { status: 'ok' },
        platform_budget_authority: { status: 'ok' },
      },
      components: {
        database: { status: 'ok' },
        temporal_control_plane: { status: 'ok' },
        worker: { status: 'ok' },
        outbox_relay: { status: 'ok' },
        api_runtime: { status: 'ok' },
        migration: { status: 'ok' },
        storage: { status: 'ok' },
        redis: { status: 'ok' },
        model_gateway: { status: 'ok' },
        renderer: { status: 'ok' },
        browser: { status: 'ok' },
        budget_grant_verification: { status: 'ok' },
        admission: { status: 'ok' },
      },
    });
    expect(deps.contributors.check).toHaveBeenCalledWith('storage');
    expect(deps.contributors.check).toHaveBeenCalledWith('api_runtime_lease');
    expect(deps.contributors.check).toHaveBeenCalledWith('redis');
    expect(deps.contributors.check).toHaveBeenCalledWith('model_gateway');
    expect(deps.contributors.check).toHaveBeenCalledWith('renderer');
    expect(deps.contributors.check).toHaveBeenCalledWith('browser');
    expect(deps.contributors.check).toHaveBeenCalledWith('budget_grant_verification');
    expect(deps.contributors.check).toHaveBeenCalledWith('execution_budget_jwks');
    expect(deps.contributors.check).toHaveBeenCalledWith('platform_budget_authority');
  });

  it('keeps root readiness additive when authority capabilities are unavailable', async () => {
    const deps = dependencies({
      contributors: {
        check: vi.fn(async (name: string) => {
          if (name === 'execution_budget_jwks') {
            return {
              status: 'failed',
              code: 'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
            };
          }
          if (name === 'platform_budget_authority') {
            return {
              status: 'failed',
              code: 'PLATFORM_BUDGET_AUTHORITY_WRITER_UNAVAILABLE',
            };
          }
          return { status: 'ok' };
        }),
      },
    });
    const service = new RuntimeReadinessService(
      deps.prisma as never,
      deps.temporal as never,
      deps.admission as never,
      deps.releaseIdentity as never,
      deps.leases as never,
      deps.contributors as never,
    );

    await expect(service.check()).resolves.toMatchObject({
      status: 'ready',
      capabilities: {
        execution_budget_jwks: {
          status: 'failed',
          code: 'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
        },
        workspace_budget_authority: {
          status: 'failed',
          code: 'WORKSPACE_BUDGET_AUTHORITY_VERIFICATION_UNAVAILABLE',
        },
        platform_budget_authority: {
          status: 'failed',
          code: 'PLATFORM_BUDGET_AUTHORITY_VERIFICATION_UNAVAILABLE',
        },
      },
      components: {
        database: { status: 'ok' },
        migration: { status: 'ok' },
      },
    });
  });

  it('reports workspace consumption capability from verifier plus app database and migration evidence without requiring a row', async () => {
    const deps = dependencies();
    const service = new RuntimeReadinessService(
      deps.prisma as never,
      deps.temporal as never,
      deps.admission as never,
      deps.releaseIdentity as never,
      deps.leases as never,
      deps.contributors as never,
    );

    await expect(service.check()).resolves.toMatchObject({
      status: 'ready',
      capabilities: {
        workspace_budget_authority: { status: 'ok' },
      },
    });
    expect(deps.transactionClient.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('bounds both database connection acquisition and the statement itself', async () => {
    const deps = dependencies();
    const service = new RuntimeReadinessService(
      deps.prisma as never,
      deps.temporal as never,
      deps.admission as never,
      deps.releaseIdentity as never,
      deps.leases as never,
      deps.contributors as never,
    );

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

  it('fails every managed environment when a matching worker is not ready', async () => {
    const deps = dependencies({
      leases: {
        inspectWorkerQueue: vi.fn(async () => ({
          status: 'failed',
          code: 'MATCHING_WORKER_NOT_READY',
        })),
        inspectRole: vi.fn(async () => ({ status: 'ok' })),
      },
    });
    const service = new RuntimeReadinessService(
      deps.prisma as never,
      deps.temporal as never,
      deps.admission as never,
      deps.releaseIdentity as never,
      deps.leases as never,
      deps.contributors as never,
    );

    await expect(service.check()).resolves.toMatchObject({
      status: 'not_ready',
      components: {
        worker: { status: 'failed', code: 'MATCHING_WORKER_NOT_READY' },
        outbox_relay: { status: 'ok' },
      },
    });
  });

  it('fails readiness when SaaS budget grant verification is unavailable', async () => {
    const deps = dependencies({
      contributors: {
        check: vi.fn(async (name: string) =>
          name === 'budget_grant_verification'
            ? {
                status: 'failed',
                code: 'BUDGET_GRANT_VERIFICATION_UNAVAILABLE',
              }
            : { status: 'ok' },
        ),
      },
    });
    const service = new RuntimeReadinessService(
      deps.prisma as never,
      deps.temporal as never,
      deps.admission as never,
      deps.releaseIdentity as never,
      deps.leases as never,
      deps.contributors as never,
    );

    await expect(service.check()).resolves.toMatchObject({
      status: 'not_ready',
      components: {
        budget_grant_verification: {
          status: 'failed',
          code: 'BUDGET_GRANT_VERIFICATION_UNAVAILABLE',
        },
      },
    });
  });

  it('fails before Build creation when Redis, Gateway or renderer is not proven', async () => {
    const deps = dependencies({
      contributors: {
        check: vi.fn(async (name: string) => {
          const failures: Record<string, { status: 'failed' | 'not_proven'; code: string }> = {
            redis: { status: 'failed', code: 'REDIS_UNAVAILABLE' },
            model_gateway: {
              status: 'failed',
              code: 'MODEL_GATEWAY_UNAVAILABLE',
            },
            renderer: {
              status: 'not_proven',
              code: 'RENDERER_IDENTITY_NOT_PROVEN',
            },
          };
          return failures[name] ?? { status: 'ok' };
        }),
      },
    });
    const service = new RuntimeReadinessService(
      deps.prisma as never,
      deps.temporal as never,
      deps.admission as never,
      deps.releaseIdentity as never,
      deps.leases as never,
      deps.contributors as never,
    );

    await expect(service.check()).resolves.toMatchObject({
      status: 'not_ready',
      components: {
        redis: { status: 'failed', code: 'REDIS_UNAVAILABLE' },
        model_gateway: {
          status: 'failed',
          code: 'MODEL_GATEWAY_UNAVAILABLE',
        },
        renderer: {
          status: 'not_proven',
          code: 'RENDERER_IDENTITY_NOT_PROVEN',
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
    const service = new RuntimeReadinessService(
      deps.prisma as never,
      deps.temporal as never,
      deps.admission as never,
      deps.releaseIdentity as never,
      deps.leases as never,
      deps.contributors as never,
    );

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

  it('fails readiness when the database migration does not match the release', async () => {
    const deps = dependencies();
    deps.transactionClient.$queryRawUnsafe.mockImplementation(async (query: string) =>
      query === 'SELECT 1' ? [{ ok: 1 }] : [{ migration_name: '20260815000000_previous' }],
    );
    const service = new RuntimeReadinessService(
      deps.prisma as never,
      deps.temporal as never,
      deps.admission as never,
      deps.releaseIdentity as never,
      deps.leases as never,
      deps.contributors as never,
    );

    await expect(service.check()).resolves.toMatchObject({
      status: 'not_ready',
      capabilities: {
        workspace_budget_authority: {
          status: 'failed',
          code: 'WORKSPACE_BUDGET_AUTHORITY_MIGRATION_UNAVAILABLE',
        },
      },
      components: {
        database: { status: 'ok' },
        migration: { status: 'failed', code: 'MIGRATION_REVISION_MISMATCH' },
      },
    });
  });

  it('preserves an invalid live app database principal as a stable readiness failure', async () => {
    const deps = dependencies({
      prisma: {
        reconnect: async () => ({
          status: 'not_ready' as const,
          code: 'DATABASE_PRINCIPAL_INVALID' as const,
        }),
      },
    });
    const service = new RuntimeReadinessService(
      deps.prisma as never,
      deps.temporal as never,
      deps.admission as never,
      deps.releaseIdentity as never,
      deps.leases as never,
      deps.contributors as never,
    );

    await expect(service.check()).resolves.toMatchObject({
      status: 'not_ready',
      capabilities: {
        workspace_budget_authority: {
          status: 'failed',
          code: 'WORKSPACE_BUDGET_AUTHORITY_DATABASE_UNAVAILABLE',
        },
      },
      components: {
        database: { status: 'failed', code: 'DATABASE_PRINCIPAL_INVALID' },
        migration: {
          status: 'not_proven',
          code: 'MIGRATION_REVISION_NOT_PROVEN',
        },
      },
    });
  });
});
