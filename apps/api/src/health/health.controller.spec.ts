import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { REQUIRED_AUTH_SCOPES } from '../auth/auth-scopes';
import type { RequestContext } from '../auth/request-context';
import { ScopesGuard } from '../auth/scopes.guard';
import type { PrismaService } from '../prisma/prisma.service';
import type { RuntimeIdentityService } from '../runtime/runtime-admission';
import type { RuntimeOpsReadService } from '../runtime-ops/runtime-ops-read.service';
import { HealthController } from './health.controller';
import type { ReadinessService } from './readiness.service';

const BUILD_HEALTH = Object.freeze({
  status: 'VERIFIED' as const,
  service: 'global-api' as const,
  deploymentStage: 'pilot' as const,
  identity: Object.freeze({
    buildSha: 'a'.repeat(40),
    buildTime: '2026-08-07T12:34:56.000Z',
    artifactDigest: `sha256:${'b'.repeat(64)}`,
    migrationManifestDigest: `sha256:${'c'.repeat(64)}`,
    migrationRevision: '202608070001_runtime_identity',
    migrationCount: 1,
  }),
  missingFields: [] as const,
});

function makeController(readinessResult: { status: 'READY' | 'NOT_READY' }) {
  const queryRaw = vi.fn().mockResolvedValue([{ '?column?': 1 }]);
  const runtime = {
    getBuildHealth: () => BUILD_HEALTH,
  } as unknown as RuntimeIdentityService;
  const readiness = {
    check: vi.fn().mockResolvedValue({
      ...readinessResult,
      service: 'global-api',
      ts: '2026-08-07T13:00:00.000Z',
      checks: [],
    }),
  } as unknown as ReadinessService;
  const runtimeOpsSnapshot = Object.freeze({
    schemaVersion: 'runtime-ops/v1' as const,
    observedAt: '2026-08-08T10:00:00.000Z',
    runtime: Object.freeze({
      status: 'DEGRADED' as const,
      workers: Object.freeze({
        expectedBuildSha: 'a'.repeat(40),
        queues: Object.freeze([
          Object.freeze({ taskQueue: 'acquisition', state: 'POLLING' as const }),
        ]),
        observedBuildShas: Object.freeze(['a'.repeat(40)]),
      }),
      schedules: Object.freeze({
        expected: 8,
        tracked: 8,
        drifted: 0,
        paused: 1,
        late: 0,
        staleEvidence: 0,
        unobservable: 0,
        missedCatchup: 0,
        skippedOverlap: 0,
      }),
      workflows: Object.freeze({ failed24h: 0, budgetTruncated24h: 0 }),
      signalIngest: Object.freeze({ pending: 0, expiredLeases: 0, errors: 0 }),
    }),
    workspace: Object.freeze({
      outbox: Object.freeze({ parked: 1, dead: 0 }),
      acquisitionBudget: Object.freeze({
        exhausted: 0,
        frozen: 0,
        unknownSettlement: 0,
      }),
    }),
    global: Object.freeze({ suspendedSourcePolicies: 0 }),
    proof: Object.freeze({
      outboxRelay: 'UNVERIFIED' as const,
      gatewayAdmission: 'UNVERIFIED' as const,
      providerConsecutiveZeroResults: 'UNOBSERVABLE' as const,
    }),
  });
  const runtimeOps = {
    snapshotForWorkspace: vi.fn().mockResolvedValue(runtimeOpsSnapshot),
  } as unknown as RuntimeOpsReadService;
  return {
    controller: new HealthController(
      { $queryRaw: queryRaw } as unknown as PrismaService,
      runtime,
      readiness,
      runtimeOps,
    ),
    queryRaw,
    runtimeOps,
    runtimeOpsSnapshot,
  };
}

describe('HealthController', () => {
  it('preserves /health and /health/db behavior', async () => {
    const { controller, queryRaw } = makeController({ status: 'READY' });

    expect(controller.check()).toMatchObject({
      status: 'ok',
      service: 'global-api',
    });
    expect(Number.isNaN(Date.parse(controller.check().ts))).toBe(false);
    await expect(controller.db()).resolves.toEqual({ db: 'ok' });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('exposes separate liveness and injected build provenance', () => {
    const { controller } = makeController({ status: 'READY' });

    expect(controller.live()).toMatchObject({
      status: 'ok',
      service: 'global-api',
    });
    expect(controller.build()).toEqual(BUILD_HEALTH);
  });

  it.each([
    ['READY', 200],
    ['NOT_READY', 503],
  ] as const)(
    'maps %s readiness to HTTP %i without an error envelope',
    async (status, httpStatus) => {
      const { controller } = makeController({ status });
      const response = {
        status: vi.fn().mockReturnThis(),
      } as unknown as Response;

      const body = await controller.ready(response);

      expect(response.status).toHaveBeenCalledWith(httpStatus);
      expect(body.status).toBe(status);
      expect(body).not.toHaveProperty('error');
    },
  );

  it('protects only /health/ops with AuthGuard and the ops:read scope', async () => {
    const publicMethods = ['check', 'live', 'build', 'ready', 'db'] as const;
    for (const method of publicMethods) {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, HealthController.prototype[method]),
      ).toBeUndefined();
      expect(
        Reflect.getMetadata(
          REQUIRED_AUTH_SCOPES,
          HealthController.prototype[method],
        ),
      ).toBeUndefined();
    }

    expect(
      Reflect.getMetadata(GUARDS_METADATA, HealthController.prototype.ops),
    ).toEqual([AuthGuard, ScopesGuard]);
    expect(
      Reflect.getMetadata(REQUIRED_AUTH_SCOPES, HealthController.prototype.ops),
    ).toEqual(['ops:read']);
  });

  it('derives the ops workspace exclusively from signed request context', async () => {
    const { controller, runtimeOps, runtimeOpsSnapshot } = makeController({
      status: 'READY',
    });
    const ctx: RequestContext = Object.freeze({
      userId: 'operator-1',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      roles: Object.freeze(['pilot.ops']),
    });

    await expect(controller.ops(ctx)).resolves.toEqual(runtimeOpsSnapshot);
    expect(runtimeOps.snapshotForWorkspace).toHaveBeenCalledWith(ctx.workspaceId);
    expect(JSON.stringify(runtimeOpsSnapshot)).not.toMatch(
      /operator-1|payload|lastError|freezeReason|authorizationHash|@/iu,
    );
  });
});
