import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  RuntimeAdmission,
  RuntimeIdentityService,
} from '../runtime/runtime-admission';
import type { TemporalClient } from '../temporal/temporal.client';
import {
  BuildIdentityReadinessProbe,
  ConfigurationReadinessProbe,
  DatabaseReadinessProbe,
  TemporalReadinessProbe,
  UnavailableProofReadinessProbe,
} from './readiness.probes';

const COMPLETE_SNAPSHOT = Object.freeze({
  deploymentStage: 'pilot' as const,
  apiBindHost: '127.0.0.1' as const,
  port: 3000,
  corsOrigins: Object.freeze(['https://app.example.test']),
  buildIdentity: Object.freeze({
    status: 'VERIFIED' as const,
    buildSha: 'a'.repeat(40),
    buildTime: '2026-08-07T12:34:56.000Z',
    artifactDigest: `sha256:${'b'.repeat(64)}`,
    migrationRevision: '202608070001_runtime_identity',
    missingFields: [] as const,
  }),
});

function runtime(
  snapshot: RuntimeAdmission = COMPLETE_SNAPSHOT,
): RuntimeIdentityService {
  return { getSnapshot: () => snapshot } as RuntimeIdentityService;
}

describe('concrete readiness probes', () => {
  it('checks admitted configuration and injected build identity', async () => {
    await expect(
      new ConfigurationReadinessProbe(runtime()).check(),
    ).resolves.toEqual({
      status: 'PASS',
      code: 'CONFIGURATION_VALID',
    });
    await expect(
      new BuildIdentityReadinessProbe(runtime()).check(),
    ).resolves.toEqual({
      status: 'PASS',
      code: 'BUILD_IDENTITY_VERIFIED',
    });
  });

  it('queries the database without returning query or connection details', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        migrationName: COMPLETE_SNAPSHOT.buildIdentity.migrationRevision,
        finishedAt: new Date('2026-08-07T12:00:00.000Z'),
      },
    ]);
    const probe = new DatabaseReadinessProbe(
      { $queryRaw: queryRaw } as unknown as PrismaService,
      runtime(),
    );

    await expect(probe.check()).resolves.toEqual({
      status: 'PASS',
      code: 'DATABASE_REACHABLE_AND_MIGRATED',
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'dirty migration',
      [{ migrationName: '202608070001_runtime_identity', finishedAt: null }],
      'DATABASE_MIGRATION_DIRTY',
    ],
    [
      'revision mismatch',
      [{ migrationName: '202608060001_previous', finishedAt: new Date() }],
      'MIGRATION_REVISION_MISMATCH',
    ],
  ] as const)(
    'fails closed for %s without returning migration names',
    async (_name, rows, code) => {
      const probe = new DatabaseReadinessProbe(
        {
          $queryRaw: vi.fn().mockResolvedValue(rows),
        } as unknown as PrismaService,
        runtime(),
      );
      const result = await probe.check();
      expect(result).toEqual({ status: 'FAIL', code });
      expect(JSON.stringify(result)).not.toContain('202608');
    },
  );

  it('still verifies DB connectivity while reporting a missing development migration receipt', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const incompleteRuntime = runtime({
      deploymentStage: 'development',
      apiBindHost: '127.0.0.1',
      port: 3000,
      corsOrigins: [],
      buildIdentity: {
        status: 'UNVERIFIED',
        buildSha: null,
        buildTime: null,
        artifactDigest: null,
        migrationRevision: null,
        missingFields: [
          'BUILD_SHA',
          'BUILD_TIME',
          'ARTIFACT_DIGEST',
          'MIGRATION_REVISION',
        ],
      },
    });
    const probe = new DatabaseReadinessProbe(
      { $queryRaw: queryRaw } as unknown as PrismaService,
      incompleteRuntime,
    );

    await expect(probe.check()).resolves.toEqual({
      status: 'UNVERIFIED',
      code: 'DATABASE_REACHABLE_MIGRATION_UNVERIFIED',
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('uses the bounded Temporal system-info seam', async () => {
    const checkSystemInfo = vi.fn().mockResolvedValue(undefined);
    const probe = new TemporalReadinessProbe({
      checkSystemInfo,
    } as unknown as TemporalClient);
    const signal = new AbortController().signal;

    await expect(probe.check(signal)).resolves.toEqual({
      status: 'PASS',
      code: 'TEMPORAL_REACHABLE',
    });
    expect(checkSystemInfo).toHaveBeenCalledWith({ timeoutMs: 750, signal });
  });

  it.each(['worker_heartbeat', 'outbox_relay', 'gateway_admission'] as const)(
    'does not invent a proof source for %s',
    async (name) => {
      const probe = new UnavailableProofReadinessProbe(name);
      expect(probe.required).toBe(true);
      await expect(probe.check()).resolves.toEqual({
        status: 'UNVERIFIED',
        code: 'PROOF_SOURCE_UNAVAILABLE',
      });
    },
  );
});
