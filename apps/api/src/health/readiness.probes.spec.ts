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

const MIGRATION_ENTRIES = Object.freeze([
  Object.freeze({
    name: '20260801000000_first',
    checksum: '1'.repeat(64),
  }),
  Object.freeze({
    name: '20260802000000_second',
    checksum: '2'.repeat(64),
  }),
]);
const MIGRATION_MANIFEST_DIGEST = `sha256:${'c'.repeat(64)}`;
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
    migrationRevision: MIGRATION_ENTRIES.at(-1)!.name,
    migrationManifestDigest: MIGRATION_MANIFEST_DIGEST,
    migrationManifest: Object.freeze({
      schemaVersion: 'global-api-migration-manifest/v1' as const,
      digest: MIGRATION_MANIFEST_DIGEST,
      entries: MIGRATION_ENTRIES,
    }),
    missingFields: [] as const,
  }),
});

type MigrationRow = Readonly<{
  migrationName: string;
  checksum: string;
  finishedAt: Date | null;
  rolledBackAt: Date | null;
  appliedStepsCount: number;
}>;

function runtime(
  snapshot: RuntimeAdmission = COMPLETE_SNAPSHOT,
): RuntimeIdentityService {
  return { getSnapshot: () => snapshot } as RuntimeIdentityService;
}

function appliedRows(): MigrationRow[] {
  return MIGRATION_ENTRIES.map((entry) => ({
    migrationName: entry.name,
    checksum: entry.checksum,
    finishedAt: new Date('2026-08-07T12:00:00.000Z'),
    rolledBackAt: null,
    appliedStepsCount: 1,
  }));
}

function prismaForRows(rows: readonly MigrationRow[]): {
  prisma: PrismaService;
  queryRaw: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
} {
  const queryRaw = vi
    .fn()
    .mockResolvedValueOnce([{ statementTimeout: '750ms' }])
    .mockResolvedValueOnce(rows);
  const transaction = vi.fn(
    async (
      callback: (tx: { $queryRaw: typeof queryRaw }) => Promise<unknown>,
    ) => callback({ $queryRaw: queryRaw }),
  );
  return {
    prisma: { $transaction: transaction } as unknown as PrismaService,
    queryRaw,
    transaction,
  };
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

  it('sets a transaction-local DB timeout and verifies the entire name/checksum manifest', async () => {
    const { prisma, queryRaw, transaction } = prismaForRows(appliedRows());
    const probe = new DatabaseReadinessProbe(prisma, runtime());

    await expect(probe.check()).resolves.toEqual({
      status: 'PASS',
      code: 'DATABASE_REACHABLE_AND_MIGRATED',
    });
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(String(queryRaw.mock.calls[0]?.[0])).toContain('set_config');
    expect(String(queryRaw.mock.calls[0]?.[0])).toContain('statement_timeout');
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 250,
      timeout: 900,
    });
  });

  it.each([
    [
      'unfinished migration',
      () => [{ ...appliedRows()[0]!, finishedAt: null }],
      'DATABASE_MIGRATION_DIRTY',
    ],
    [
      'missing migration',
      () => appliedRows().slice(0, 1),
      'MIGRATION_MANIFEST_MISMATCH',
    ],
    [
      'extra migration',
      () => [
        ...appliedRows(),
        {
          ...appliedRows()[0]!,
          migrationName: '20260803000000_extra',
        },
      ],
      'MIGRATION_MANIFEST_MISMATCH',
    ],
    [
      'duplicate migration',
      () => [...appliedRows(), appliedRows()[0]!],
      'MIGRATION_MANIFEST_MISMATCH',
    ],
    [
      'checksum drift',
      () => [{ ...appliedRows()[0]!, checksum: 'f'.repeat(64) }, appliedRows()[1]!],
      'MIGRATION_CHECKSUM_MISMATCH',
    ],
  ] as const)(
    'fails closed for %s without returning migration identities',
    async (_name, rows, code) => {
      const { prisma } = prismaForRows(rows());
      const result = await new DatabaseReadinessProbe(
        prisma,
        runtime(),
      ).check();
      expect(result).toEqual({ status: 'FAIL', code });
      expect(JSON.stringify(result)).not.toContain('202608');
      expect(JSON.stringify(result)).not.toContain('ffff');
    },
  );

  it('ignores rolled-back history only when the active applied set is exact', async () => {
    const { prisma } = prismaForRows([
      {
        ...appliedRows()[0]!,
        checksum: 'f'.repeat(64),
        rolledBackAt: new Date('2026-08-06T00:00:00.000Z'),
      },
      ...appliedRows(),
    ]);
    await expect(
      new DatabaseReadinessProbe(prisma, runtime()).check(),
    ).resolves.toEqual({
      status: 'PASS',
      code: 'DATABASE_REACHABLE_AND_MIGRATED',
    });
  });

  it('still verifies DB connectivity while reporting a missing development migration receipt', async () => {
    const { prisma, queryRaw } = prismaForRows([]);
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
        migrationManifestDigest: null,
        migrationManifest: null,
        missingFields: [
          'BUILD_SHA',
          'BUILD_TIME',
          'ARTIFACT_DIGEST',
          'MIGRATION_MANIFEST_DIGEST',
        ],
      },
    });
    const probe = new DatabaseReadinessProbe(prisma, incompleteRuntime);

    await expect(probe.check()).resolves.toEqual({
      status: 'UNVERIFIED',
      code: 'DATABASE_REACHABLE_MIGRATION_UNVERIFIED',
    });
    expect(queryRaw).toHaveBeenCalledTimes(2);
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
