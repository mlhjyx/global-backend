import { describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { PrismaService } from '../prisma/prisma.service';
import type { RuntimeIdentityService } from '../runtime/runtime-admission';
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
    migrationRevision: '202608070001_runtime_identity',
  }),
  missingFields: [] as const,
});

function controller(readinessResult: { status: 'READY' | 'NOT_READY' }) {
  const queryRaw = vi.fn().mockResolvedValue([{ '?column?': 1 }]);
  const runtime = { getBuildHealth: () => BUILD_HEALTH } as unknown as RuntimeIdentityService;
  const readiness = {
    check: vi.fn().mockResolvedValue({
      ...readinessResult,
      service: 'global-api',
      ts: '2026-08-07T13:00:00.000Z',
      checks: [],
    }),
  } as unknown as ReadinessService;
  return {
    controller: new HealthController(
      { $queryRaw: queryRaw } as unknown as PrismaService,
      runtime,
      readiness,
    ),
    queryRaw,
  };
}

describe('HealthController', () => {
  it('preserves /health and /health/db behavior', async () => {
    const { controller, queryRaw } = controller({ status: 'READY' });

    expect(controller.check()).toMatchObject({ status: 'ok', service: 'global-api' });
    expect(Number.isNaN(Date.parse(controller.check().ts))).toBe(false);
    await expect(controller.db()).resolves.toEqual({ db: 'ok' });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('exposes separate liveness and injected build provenance', () => {
    const { controller } = controller({ status: 'READY' });

    expect(controller.live()).toMatchObject({ status: 'ok', service: 'global-api' });
    expect(controller.build()).toEqual(BUILD_HEALTH);
  });

  it.each([
    ['READY', 200],
    ['NOT_READY', 503],
  ] as const)('maps %s readiness to HTTP %i without an error envelope', async (status, httpStatus) => {
    const { controller } = controller({ status });
    const response = { status: vi.fn().mockReturnThis() } as unknown as Response;

    const body = await controller.ready(response);

    expect(response.status).toHaveBeenCalledWith(httpStatus);
    expect(body.status).toBe(status);
    expect(body).not.toHaveProperty('error');
  });
});
