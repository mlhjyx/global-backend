import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import type { RuntimeIdentityService } from '../runtime/runtime-admission';
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
  buildIdentity: Object.freeze({
    status: 'VERIFIED' as const,
    buildSha: 'a'.repeat(40),
    buildTime: '2026-08-07T12:34:56.000Z',
    artifactDigest: `sha256:${'b'.repeat(64)}`,
    migrationRevision: '202608070001_runtime_identity',
    missingFields: [] as const,
  }),
});

function runtime(snapshot = COMPLETE_SNAPSHOT): RuntimeIdentityService {
  return { getSnapshot: () => snapshot } as RuntimeIdentityService;
}

describe('concrete readiness probes', () => {
  it('checks admitted configuration and injected build identity', async () => {
    await expect(new ConfigurationReadinessProbe(runtime()).check()).resolves.toEqual({
      status: 'PASS',
      code: 'CONFIGURATION_VALID',
    });
    await expect(new BuildIdentityReadinessProbe(runtime()).check()).resolves.toEqual({
      status: 'PASS',
      code: 'BUILD_IDENTITY_VERIFIED',
    });
  });

  it('queries the database without returning query or connection details', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ '?column?': 1 }]);
    const probe = new DatabaseReadinessProbe({ $queryRaw: queryRaw } as unknown as PrismaService);

    await expect(probe.check()).resolves.toEqual({
      status: 'PASS',
      code: 'DATABASE_REACHABLE',
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('uses the bounded Temporal system-info seam', async () => {
    const checkSystemInfo = vi.fn().mockResolvedValue(undefined);
    const probe = new TemporalReadinessProbe({ checkSystemInfo } as unknown as TemporalClient);
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
