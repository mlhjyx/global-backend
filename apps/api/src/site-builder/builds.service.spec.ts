import { HttpException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { BuildsService } from './builds.service';
import type {
  RefurbishLaunchResult,
  RefurbishLauncher,
} from './refurbish-launcher';
import { buildDemoSpec } from './demo-spec';

const CTX = {
  userId: 'u1',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  roles: [],
};
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const ACK: RefurbishLaunchResult = {
  workflowId: 'site-refurbish-run-1',
  firstExecutionRunId: 'temporal-run-1',
};

interface FakeDb {
  sites: Record<string, unknown>[];
  runs: Record<string, unknown>[];
  budgets: Record<string, unknown>[];
  steps: Record<string, unknown>[];
  idempotencies: Record<string, unknown>[];
}

function makeService(
  opts: {
    siteExists?: boolean;
    existingRuns?: Record<string, unknown>[];
    existingIdempotencies?: Record<string, unknown>[];
    launcher?: Partial<RefurbishLauncher>;
    failAckUpdate?: boolean;
    beforeCancelCas?: (run: Record<string, unknown>) => void;
    activeSpec?: ReturnType<typeof buildDemoSpec>;
  } = {},
) {
  const db: FakeDb = {
    sites:
      opts.siteExists === false
        ? []
        : [
            {
              id: SITE_ID,
              workspaceId: CTX.workspaceId,
              activeVersionId: opts.activeSpec ? 'active-version' : null,
            },
          ],
    runs: [...(opts.existingRuns ?? [])],
    budgets: (opts.existingRuns ?? [])
      .filter((run) => run.kind === 'refurbish')
      .map((run) => ({
        buildRunId: run.id,
        workspaceId: CTX.workspaceId,
        siteId: run.siteId,
        capMicrousd: 5_000_000n,
        reservedMicrousd: 0n,
        chargedMicrousd: 0n,
        paidCallsEnabled: true,
        disabledReason: null,
        exhaustedAt: null,
      })),
    steps: [],
    idempotencies: [...(opts.existingIdempotencies ?? [])],
  };
  let seq = db.runs.length;
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [{ reconciled: 0 }],
    site: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        db.sites.find((site) => site.id === where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = db.sites.find((site) => site.id === where.id);
        if (!row) throw new Error('missing site');
        Object.assign(row, data);
        return row;
      },
    },
    siteVersion: {
      findFirst: async () =>
        opts.activeSpec
          ? { id: 'active-version', spec: opts.activeSpec }
          : null,
      updateMany: async () => ({ count: 0 }),
    },
    siteBuildStep: {
      findMany: async ({ where }: { where: { buildRunId: string } }) =>
        db.steps.filter((step) => step.buildRunId === where.buildRunId),
      updateMany: async ({
        where,
        data,
      }: {
        where: { buildRunId: string; status?: { in: string[] } };
        data: Record<string, unknown>;
      }) => {
        let count = 0;
        for (const step of db.steps) {
          if (
            step.buildRunId === where.buildRunId &&
            (!where.status?.in || where.status.in.includes(step.status as string))
          ) {
            Object.assign(step, data);
            count += 1;
          }
        }
        return { count };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `step-${db.steps.length + 1}`, ...data };
        db.steps.push(row);
        return row;
      },
    },
    idempotencyKey: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        const key = where.workspaceId_endpoint_key as Record<string, unknown>;
        return (
          db.idempotencies.find(
            (row) =>
              row.workspaceId === key.workspaceId &&
              row.endpoint === key.endpoint &&
              row.key === key.key,
          ) ?? null
        );
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `idem-${db.idempotencies.length + 1}`, ...data };
        db.idempotencies.push(row);
        return row;
      },
    },
    siteBuildBudget: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        db.budgets.push({
          reservedMicrousd: 0n,
          chargedMicrousd: 0n,
          paidCallsEnabled: true,
          disabledReason: null,
          exhaustedAt: null,
          ...data,
        });
        return data;
      },
      findUnique: async ({ where }: { where: { buildRunId: string } }) =>
        db.budgets.find(
          (budget) => budget.buildRunId === where.buildRunId,
        ) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          buildRunId: string;
          paidCallsEnabled?: boolean;
          OR?: Array<{
            paidCallsEnabled?: boolean;
            disabledReason?: { in: string[] };
          }>;
        };
        data: Record<string, unknown>;
      }) => {
        const row = db.budgets.find(
          (budget) => budget.buildRunId === where.buildRunId,
        );
        if (
          !row ||
          (where.paidCallsEnabled !== undefined &&
            row.paidCallsEnabled !== where.paidCallsEnabled) ||
          (where.OR &&
            !where.OR.some(
              (clause) =>
                (clause.paidCallsEnabled === undefined ||
                  row.paidCallsEnabled === clause.paidCallsEnabled) &&
                (!clause.disabledReason ||
                  clause.disabledReason.in.includes(
                    row.disabledReason as string,
                  )),
            ))
        ) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    siteBuildSpend: {
      findMany: async () => [],
    },
    siteBuildRun: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        db.runs.find((run) => run.id === where.id) ?? null,
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.scope) {
          const want = (where.scope as { equals: string }).equals;
          return (
            db.runs.find(
              (run) =>
                (!where.siteId || run.siteId === where.siteId) &&
                (run.scope as { idempotencyKey?: string } | null)
                  ?.idempotencyKey === want,
            ) ?? null
          );
        }
        const statuses = (where.status as { in: string[] } | undefined)?.in;
        return (
          db.runs.find(
            (run) =>
              run.siteId === where.siteId &&
              (!statuses || statuses.includes(run.status as string)),
          ) ?? null
        );
      },
      count: async ({ where }: { where: Record<string, unknown> }) => {
        const createdAt = where.createdAt as { gte: Date } | undefined;
        return db.runs.filter(
          (run) =>
            run.siteId === where.siteId &&
            (!createdAt || (run.createdAt as Date) >= createdAt.gte) &&
            !(run.status === 'failed' && run.temporalRunId == null),
        ).length;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `run-${++seq}`,
          status: 'queued',
          temporalWorkflowId: null,
          temporalRunId: null,
          createdAt: new Date(),
          ...data,
        };
        db.runs.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        if (opts.failAckUpdate && 'temporalRunId' in data)
          throw new Error('database unavailable');
        const row = db.runs.find((run) => run.id === where.id);
        if (!row) throw new Error('missing run');
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; kind?: string; status?: { in: string[] } };
        data: Record<string, unknown>;
      }) => {
        const row = db.runs.find((run) => run.id === where.id);
        if (!row) return { count: 0 };
        opts.beforeCancelCas?.(row);
        if (where.kind && row.kind !== where.kind) return { count: 0 };
        if (where.status?.in && !where.status.in.includes(row.status as string))
          return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  };
  const prisma = {
    withWorkspace: async <T>(
      _workspaceId: string,
      fn: (client: typeof tx) => Promise<T>,
    ): Promise<T> => fn(tx),
  };
  const launched: string[] = [];
  const launchedInputs: Array<Record<string, unknown>> = [];
  const recovered: string[] = [];
  const cancelled: Array<[string, string | null | undefined]> = [];
  const launcher: RefurbishLauncher = {
    launchRefurbish: async (input) => {
      const { buildRunId } = input;
      launched.push(buildRunId);
      launchedInputs.push(input as unknown as Record<string, unknown>);
      return { ...ACK, workflowId: `site-refurbish-${buildRunId}` };
    },
    recoverRefurbish: async ({ buildRunId }) => {
      recovered.push(buildRunId);
      return { ...ACK, workflowId: `site-refurbish-${buildRunId}` };
    },
    cancelRefurbish: async (buildRunId, workflowId) => {
      cancelled.push([buildRunId, workflowId]);
      const run = db.runs.find((candidate) => candidate.id === buildRunId);
      if (run) {
        opts.beforeCancelCas?.(run);
        if (['queued', 'running'].includes(run.status as string)) {
          run.status = 'cancelled';
          run.finishedAt = new Date();
        }
      }
      return { terminalStatus: 'cancelled' };
    },
    ...opts.launcher,
  };
  return {
    service: new BuildsService(prisma as never, launcher),
    db,
    launched,
    launchedInputs,
    recovered,
    cancelled,
  };
}

const BASE = { scope: 'site' as const };

describe('BuildsService.create', () => {
  const activeSpec = buildDemoSpec({
    siteName: 'Acme',
    intake: {
      company: { nameZh: '安可', nameEn: 'Acme' },
      industry: 'pumps',
      products: ['pumps'],
      targetMarkets: ['DE'],
      hasWebsite: false,
      businessEmail: 'sales@acme.test',
    },
  });

  it('creates one run and returns only after the Temporal identity pair is durable', async () => {
    const { service, db, launched } = makeService();

    const response = await service.create(CTX, SITE_ID, {
      ...BASE,
      options: { stylePreset: 'precision-light', locales: ['en'] },
    });

    expect(response).toEqual({ buildId: 'run-1', status: 'queued' });
    expect(db.runs[0]).toMatchObject({
      kind: 'refurbish',
      workspaceId: CTX.workspaceId,
      siteId: SITE_ID,
      scope: {
        scope: 'site',
        options: { stylePreset: 'precision-light', locales: ['en'] },
      },
      temporalWorkflowId: 'site-refurbish-run-1',
      temporalRunId: 'temporal-run-1',
    });
    expect(db.budgets).toEqual([
      expect.objectContaining({
        buildRunId: 'run-1',
        workspaceId: CTX.workspaceId,
        siteId: SITE_ID,
        capMicrousd: 5_000_000n,
        paidCallsEnabled: true,
      }),
    ]);
    expect(launched).toEqual(['run-1']);
  });

  it('returns 404 when the site is not workspace-visible', async () => {
    const { service } = makeService({ siteExists: false });
    await expect(service.create(CTX, SITE_ID, BASE)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('accepts active page/section targets and freezes their exact base SiteVersion', async () => {
    for (const request of [
      { scope: 'page' as const, targetId: 'products' },
      { scope: 'section' as const, targetId: 'AboutBlock-demo-1' },
      { scope: 'site' as const, options: { pages: ['home', 'contact'] } },
    ]) {
      const { service, db, launchedInputs } = makeService({ activeSpec });
      await expect(
        service.create(CTX, SITE_ID, request),
      ).resolves.toMatchObject({ status: 'queued' });
      expect(db.runs[0].scope).toEqual({
        ...request,
        baseVersionId: 'active-version',
      });
      expect(launchedInputs[0]).toMatchObject({
        scope: { ...request, baseVersionId: 'active-version' },
      });
    }
  });

  it('returns stable 404 before launch when the active target does not exist', async () => {
    const { service, launched } = makeService({ activeSpec });
    const error = await service
      .create(CTX, SITE_ID, {
        scope: 'page',
        targetId: 'missing-page',
      })
      .catch((caught) => caught);
    expect(errorContract(error)).toMatchObject({
      status: 404,
      code: 'BUILD_TARGET_NOT_FOUND',
    });
    expect(launched).toEqual([]);
  });

  it('fails closed when a section identifier is ambiguous in the active SiteSpec', async () => {
    const duplicate = structuredClone(activeSpec);
    duplicate.pages[1].puck.content.push(
      structuredClone(duplicate.pages[0].puck.content[0]),
    );
    const { service } = makeService({ activeSpec: duplicate });
    const targetId = duplicate.pages[0].puck.content[0].props.id as string;
    const error = await service
      .create(CTX, SITE_ID, {
        scope: 'section',
        targetId,
      })
      .catch((caught) => caught);
    expect(errorContract(error)).toMatchObject({
      status: 422,
      code: 'BUILD_TARGET_AMBIGUOUS',
    });
  });

  it('enforces one active build per site', async () => {
    const { service } = makeService({
      existingRuns: [
        {
          id: 'running-1',
          siteId: SITE_ID,
          status: 'running',
          createdAt: new Date(),
        },
      ],
    });
    const error = await service.create(CTX, SITE_ID, BASE).catch((e) => e);
    expect(errorContract(error)).toMatchObject({
      status: 409,
      code: 'BUILD_IN_PROGRESS',
    });
  });

  it('replays the same fingerprint to the same ACKed run without relaunch', async () => {
    const { service, db, launched } = makeService();
    const first = await service.create(CTX, SITE_ID, {
      ...BASE,
      idempotencyKey: 'same-request',
    });

    const replay = await service.create(CTX, SITE_ID, {
      ...BASE,
      idempotencyKey: 'same-request',
    });

    expect(replay).toEqual(first);
    expect(db.runs).toHaveLength(1);
    expect(db.idempotencies).toHaveLength(1);
    expect(launched).toEqual(['run-1']);
  });

  it('replays a durable partial-build key even if the active pointer later changes', async () => {
    const { service, db, launched } = makeService({ activeSpec });
    const request = {
      scope: 'page' as const,
      targetId: 'products',
      idempotencyKey: 'partial-replay',
    };
    const first = await service.create(CTX, SITE_ID, request);
    db.sites[0].activeVersionId = null;
    const replay = await service.create(CTX, SITE_ID, request);
    expect(replay).toEqual(first);
    expect(launched).toEqual(['run-1']);
  });

  it('rejects reuse of one key for a different normalized request', async () => {
    const { service } = makeService();
    await service.create(CTX, SITE_ID, {
      ...BASE,
      idempotencyKey: 'reused-key',
    });

    const error = await service
      .create(CTX, SITE_ID, {
        ...BASE,
        idempotencyKey: 'reused-key',
        options: { stylePreset: 'precision-light' },
      })
      .catch((e) => e);

    expect(errorContract(error)).toEqual({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('treats the siteId as request identity, not as an idempotency ledger partition', async () => {
    const otherSiteId = '33333333-3333-4333-8333-333333333333';
    const { service, db } = makeService();
    db.sites.push({ id: otherSiteId, workspaceId: CTX.workspaceId });
    await service.create(CTX, SITE_ID, {
      ...BASE,
      idempotencyKey: 'workspace-operation-key',
    });

    const error = await service
      .create(CTX, otherSiteId, {
        ...BASE,
        idempotencyKey: 'workspace-operation-key',
      })
      .catch((caught) => caught);

    expect(errorContract(error)).toEqual({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(db.runs).toHaveLength(1);
  });

  it('fails closed for a legacy key that has no request fingerprint', async () => {
    const { service } = makeService({
      existingRuns: [
        {
          id: 'legacy-run',
          siteId: SITE_ID,
          status: 'succeeded',
          scope: { scope: 'site', idempotencyKey: 'legacy-key' },
          createdAt: new Date(),
        },
      ],
    });
    const error = await service
      .create(CTX, SITE_ID, { ...BASE, idempotencyKey: 'legacy-key' })
      .catch((e) => e);
    expect(errorContract(error)).toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('fails closed when a legacy key was used by another Site in the workspace', async () => {
    const { service, db } = makeService({
      existingRuns: [
        {
          id: 'legacy-other-site',
          siteId: '33333333-3333-4333-8333-333333333333',
          status: 'succeeded',
          scope: { scope: 'site', idempotencyKey: 'legacy-cross-site' },
          createdAt: new Date(),
        },
      ],
    });
    const error = await service
      .create(CTX, SITE_ID, {
        ...BASE,
        idempotencyKey: 'legacy-cross-site',
      })
      .catch((caught) => caught);
    expect(errorContract(error)).toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(db.runs).toHaveLength(1);
  });

  it('repairs the exact no-key queued request after an ambiguous start', async () => {
    const { service, db, launched } = makeService({
      existingRuns: [
        {
          id: 'ambiguous-no-key',
          siteId: SITE_ID,
          kind: 'refurbish',
          status: 'queued',
          temporalWorkflowId: null,
          temporalRunId: null,
          scope: { scope: 'site' },
          createdAt: new Date(),
        },
      ],
    });
    await expect(service.create(CTX, SITE_ID, BASE)).resolves.toEqual({
      buildId: 'ambiguous-no-key',
      status: 'queued',
    });
    expect(db.runs).toHaveLength(1);
    expect(launched).toEqual(['ambiguous-no-key']);
  });

  it('does not attach a different no-key request to an ambiguous queued run', async () => {
    const { service, launched } = makeService({
      existingRuns: [
        {
          id: 'ambiguous-different',
          siteId: SITE_ID,
          kind: 'refurbish',
          status: 'queued',
          temporalWorkflowId: null,
          temporalRunId: null,
          scope: {
            scope: 'site',
            options: { stylePreset: 'precision-light' },
          },
          createdAt: new Date(),
        },
      ],
    });
    const error = await service.create(CTX, SITE_ID, BASE).catch((e) => e);
    expect(errorContract(error)).toMatchObject({
      status: 409,
      code: 'BUILD_IN_PROGRESS',
    });
    expect(launched).toEqual([]);
  });

  it('does not count failed rows without an acknowledged Temporal run against quota', async () => {
    const failed = Array.from({ length: 10 }, (_, index) => ({
      id: `failed-${index}`,
      siteId: SITE_ID,
      status: 'failed',
      temporalRunId: null,
      createdAt: new Date(),
    }));
    const { service } = makeService({ existingRuns: failed });
    await expect(service.create(CTX, SITE_ID, BASE)).resolves.toMatchObject({
      status: 'queued',
    });
  });

  it('counts acknowledged executions against the daily quota', async () => {
    const runs = Array.from({ length: 10 }, (_, index) => ({
      id: `used-${index}`,
      siteId: SITE_ID,
      status: 'failed',
      temporalRunId: `temporal-${index}`,
      createdAt: new Date(),
    }));
    const { service } = makeService({ existingRuns: runs });
    const error = await service.create(CTX, SITE_ID, BASE).catch((e) => e);
    expect(errorContract(error)).toEqual({
      status: 429,
      code: 'QUOTA_EXCEEDED',
      details: { remaining: 0 },
    });
  });

  it('keeps the original queued run after ambiguous start and safely retries the same key', async () => {
    let unavailable = true;
    const { service, db } = makeService({
      launcher: {
        launchRefurbish: async ({ buildRunId }) => {
          if (unavailable) throw new Error('start response lost');
          return {
            workflowId: `site-refurbish-${buildRunId}`,
            firstExecutionRunId: 'recovered-run',
          };
        },
        recoverRefurbish: async ({ buildRunId }) => {
          if (unavailable) throw new Error('describe unavailable');
          return {
            workflowId: `site-refurbish-${buildRunId}`,
            firstExecutionRunId: 'recovered-run',
          };
        },
      },
    });

    const firstError = await service
      .create(CTX, SITE_ID, { ...BASE, idempotencyKey: 'ack-loss' })
      .catch((e) => e);
    expect(errorContract(firstError)).toEqual({
      status: 502,
      code: 'BUILD_LAUNCH_UNAVAILABLE',
      details: { buildId: 'run-1' },
    });
    expect(db.runs[0]).toMatchObject({
      id: 'run-1',
      status: 'queued',
      temporalRunId: null,
    });

    unavailable = false;
    const replay = await service.create(CTX, SITE_ID, {
      ...BASE,
      idempotencyKey: 'ack-loss',
    });
    expect(replay.buildId).toBe('run-1');
    expect(db.runs).toHaveLength(1);
    expect(db.runs[0]).toMatchObject({ temporalRunId: 'recovered-run' });
  });

  it('recovers a known execution when the initial start call loses its response', async () => {
    const { service, recovered } = makeService({
      launcher: {
        launchRefurbish: async () => {
          throw new Error('transport down after send');
        },
      },
    });
    await expect(service.create(CTX, SITE_ID, BASE)).resolves.toEqual({
      buildId: 'run-1',
      status: 'queued',
    });
    expect(recovered).toEqual(['run-1']);
  });

  it('returns 502 with the stable buildId when ACK persistence fails', async () => {
    const { service, db } = makeService({ failAckUpdate: true });
    const error = await service
      .create(CTX, SITE_ID, { ...BASE, idempotencyKey: 'ack-db' })
      .catch((e) => e);
    expect(errorContract(error)).toEqual({
      status: 502,
      code: 'BUILD_LAUNCH_UNAVAILABLE',
      details: { buildId: 'run-1' },
    });
    expect(db.runs).toHaveLength(1);
    expect(db.runs[0]).toMatchObject({ status: 'queued' });
  });

  it('rejects a launcher workflow identity that is not owned by this BuildRun', async () => {
    const { service, db } = makeService({
      launcher: {
        launchRefurbish: async () => ({
          workflowId: 'site-refurbish-someone-else',
          firstExecutionRunId: 'foreign-run',
        }),
      },
    });
    const error = await service
      .create(CTX, SITE_ID, BASE)
      .catch((caught) => caught);
    expect(errorContract(error)).toMatchObject({
      status: 502,
      code: 'BUILD_LAUNCH_UNAVAILABLE',
      details: { buildId: 'run-1' },
    });
    expect(db.runs[0]).toMatchObject({
      temporalWorkflowId: null,
      temporalRunId: null,
    });
  });

  it('rejects persistence when the durable execution identity conflicts', async () => {
    const endpoint = 'POST /api/v1/site-builder/sites/:id/builds';
    const { service, db } = makeService({
      existingRuns: [
        {
          id: 'conflict-run',
          siteId: SITE_ID,
          status: 'running',
          temporalWorkflowId: 'different-workflow',
          temporalRunId: null,
          createdAt: new Date(),
        },
      ],
      existingIdempotencies: [
        {
          workspaceId: CTX.workspaceId,
          endpoint,
          key: 'conflict-key',
          requestHash:
            'f80e8c2c1e0c834983f747e14a20245fce256be46b8053cda1382b790d34e60d',
          response: { buildId: 'conflict-run' },
        },
      ],
    });
    // Use the service-computed hash rather than treating this fixture as a request mismatch.
    db.idempotencies[0].requestHash = (
      await import('./build-request-contract')
    ).buildRequestHash(SITE_ID, BASE);

    const error = await service
      .create(CTX, SITE_ID, { ...BASE, idempotencyKey: 'conflict-key' })
      .catch((e) => e);
    expect(errorContract(error)).toMatchObject({
      status: 502,
      code: 'BUILD_LAUNCH_UNAVAILABLE',
    });
    expect(db.runs[0]).toMatchObject({
      temporalWorkflowId: 'different-workflow',
      temporalRunId: null,
    });
  });
});

describe('BuildsService.get / cancel', () => {
  it('returns a visible run and 404 for a missing run', async () => {
    const { service } = makeService({
      existingRuns: [
        {
          id: 'run-visible',
          siteId: SITE_ID,
          status: 'running',
          phase: 'P1_understanding',
          createdAt: new Date(),
        },
      ],
    });
    await expect(service.get(CTX, 'run-visible')).resolves.toMatchObject({
      phase: 'P1_understanding',
    });
    await expect(service.get(CTX, 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('cancels by the persisted workflow identity', async () => {
    const { service, db, cancelled } = makeService({
      existingRuns: [
        {
          id: 'run-cancel',
          siteId: SITE_ID,
          kind: 'refurbish',
          status: 'running',
          temporalWorkflowId: 'site-refurbish-run-cancel',
          createdAt: new Date(),
        },
      ],
    });
    await service.cancel(CTX, 'run-cancel');
    expect(db.runs[0]).toMatchObject({ status: 'cancelled' });
    expect(cancelled).toEqual([['run-cancel', 'site-refurbish-run-cancel']]);
  });

  it('returns cancelled when workflow compensation wins the terminal CAS', async () => {
    const { service, db } = makeService({
      existingRuns: [
        {
          id: 'cancel-compensated',
          siteId: SITE_ID,
          kind: 'refurbish',
          status: 'running',
          createdAt: new Date(),
        },
      ],
      beforeCancelCas: (run) => {
        run.status = 'cancelled';
      },
    });
    await expect(service.cancel(CTX, 'cancel-compensated')).resolves.toEqual({
      buildId: 'cancel-compensated',
      status: 'cancelled',
    });
    expect(db.runs[0]).toMatchObject({ status: 'cancelled' });
  });

  it('rejects terminal and non-refurbish cancellations', async () => {
    const terminal = makeService({
      existingRuns: [
        {
          id: 'done',
          siteId: SITE_ID,
          kind: 'refurbish',
          status: 'succeeded',
          createdAt: new Date(),
        },
      ],
    });
    expect(
      errorContract(await terminal.service.cancel(CTX, 'done').catch((e) => e)),
    ).toMatchObject({ status: 409, code: 'BUILD_ALREADY_TERMINAL' });

    const demo = makeService({
      existingRuns: [
        {
          id: 'demo',
          siteId: SITE_ID,
          kind: 'demo_v0',
          status: 'running',
          createdAt: new Date(),
        },
      ],
    });
    expect(
      errorContract(await demo.service.cancel(CTX, 'demo').catch((e) => e)),
    ).toMatchObject({ status: 409, code: 'BUILD_NOT_CANCELLABLE' });
  });

  it('fails closed instead of cancelling a persisted foreign workflow identity', async () => {
    const { service, db, cancelled } = makeService({
      existingRuns: [
        {
          id: 'identity-corrupt',
          siteId: SITE_ID,
          kind: 'refurbish',
          status: 'running',
          temporalWorkflowId: 'site-refurbish-another-build',
          createdAt: new Date(),
        },
      ],
    });
    const error = await service
      .cancel(CTX, 'identity-corrupt')
      .catch((caught) => caught);
    expect(errorContract(error)).toMatchObject({
      status: 409,
      code: 'BUILD_NOT_CANCELLABLE',
    });
    expect(db.runs[0]).toMatchObject({ status: 'running' });
    expect(cancelled).toEqual([]);
  });

  it('does not overwrite a terminal state won between read and cancel CAS', async () => {
    const { service, db, cancelled } = makeService({
      existingRuns: [
        {
          id: 'race',
          siteId: SITE_ID,
          kind: 'refurbish',
          status: 'running',
          createdAt: new Date(),
        },
      ],
      beforeCancelCas: (run) => {
        run.status = 'succeeded';
      },
    });
    const error = await service.cancel(CTX, 'race').catch((e) => e);
    expect(errorContract(error)).toMatchObject({
      status: 409,
      code: 'BUILD_ALREADY_TERMINAL',
      details: { status: 'succeeded' },
    });
    expect(db.runs[0]).toMatchObject({ status: 'succeeded' });
    expect(cancelled).toEqual([['race', undefined]]);
  });

  it('keeps the run active and returns 502 when Temporal does not acknowledge cancellation', async () => {
    const { service, db } = makeService({
      existingRuns: [
        {
          id: 'cancel-best-effort',
          siteId: SITE_ID,
          kind: 'refurbish',
          status: 'queued',
          createdAt: new Date(),
        },
      ],
      launcher: {
        cancelRefurbish: async () => {
          throw new Error('Temporal unavailable');
        },
      },
    });
    const error = await service
      .cancel(CTX, 'cancel-best-effort')
      .catch((caught) => caught);
    expect(errorContract(error)).toEqual({
      status: 502,
      code: 'BUILD_CANCEL_UNAVAILABLE',
      details: { buildId: 'cancel-best-effort' },
    });
    expect(db.runs[0]).toMatchObject({ status: 'queued' });
    expect(db.budgets[0]).toMatchObject({
      paidCallsEnabled: false,
      disabledReason: 'cancellation_requested',
    });
  });

  it('redrives cancelled compensation after the workflow chain is conclusively closed', async () => {
    const { service, db } = makeService({
      existingRuns: [
        {
          id: 'cancel-without-compensation',
          siteId: SITE_ID,
          kind: 'refurbish',
          status: 'running',
          createdAt: new Date(),
        },
      ],
      launcher: {
        cancelRefurbish: async () => ({ terminalStatus: 'cancelled' }),
      },
    });
    const error = await service
      .cancel(CTX, 'cancel-without-compensation')
      .catch((caught) => caught);
    expect(error).toEqual({
      buildId: 'cancel-without-compensation',
      status: 'cancelled',
    });
    expect(db.runs[0]).toMatchObject({ status: 'cancelled' });
    expect(db.runs[0].costSummary).toMatchObject({
      schemaVersion: 'site-builder-cost-summary/v1',
      budget: {
        reservedMicrousd: 0,
        paidCallsEnabled: false,
        disabledReason: 'cancellation_requested',
      },
      operations: { unknown: 0 },
    });
    expect(db.steps).toHaveLength(6);
    expect(db.steps.every((step) => step.status === 'aborted')).toBe(true);
  });

  it('redrives failed compensation and reports the repaired terminal truth', async () => {
    const { service, db } = makeService({
      existingRuns: [
        {
          id: 'failed-without-compensation',
          siteId: SITE_ID,
          kind: 'refurbish',
          status: 'running',
          createdAt: new Date(),
        },
      ],
      launcher: {
        cancelRefurbish: async () => ({ terminalStatus: 'failed' }),
      },
    });
    const error = await service
      .cancel(CTX, 'failed-without-compensation')
      .catch((caught) => caught);
    expect(errorContract(error)).toMatchObject({
      status: 409,
      code: 'BUILD_ALREADY_TERMINAL',
      details: { status: 'failed' },
    });
    expect(db.runs[0]).toMatchObject({ status: 'failed' });
    expect(db.steps).toHaveLength(6);
    expect(db.steps.every((step) => step.status === 'aborted')).toBe(true);
  });

  it('keeps active on a completed-chain invariant violation', async () => {
    const { service, db } = makeService({
      existingRuns: [
        {
          id: 'completed-but-active',
          siteId: SITE_ID,
          kind: 'refurbish',
          status: 'running',
          createdAt: new Date(),
        },
      ],
      launcher: {
        cancelRefurbish: async () => ({ terminalStatus: 'completed' }),
      },
    });
    const error = await service
      .cancel(CTX, 'completed-but-active')
      .catch((caught) => caught);
    expect(errorContract(error)).toMatchObject({
      status: 502,
      code: 'BUILD_CANCEL_UNAVAILABLE',
    });
    expect(db.runs[0]).toMatchObject({ status: 'running' });
  });

  it('reports the DB terminal truth when cancel races a completed workflow', async () => {
    const holder: { db?: FakeDb } = {};
    const made = makeService({
      existingRuns: [
        {
          id: 'cancel-rpc-terminal-race',
          siteId: SITE_ID,
          kind: 'refurbish',
          status: 'running',
          createdAt: new Date(),
        },
      ],
      launcher: {
        cancelRefurbish: async () => {
          holder.db!.runs[0].status = 'succeeded';
          throw new Error('workflow already completed');
        },
      },
    });
    holder.db = made.db;
    const error = await made.service
      .cancel(CTX, 'cancel-rpc-terminal-race')
      .catch((caught) => caught);
    expect(errorContract(error)).toMatchObject({
      status: 409,
      code: 'BUILD_ALREADY_TERMINAL',
      details: { status: 'succeeded' },
    });
  });
});

function errorContract(error: unknown): {
  status?: number;
  code?: string;
  details?: Record<string, unknown>;
} {
  if (!(error instanceof HttpException)) return {};
  const response = error.getResponse() as {
    error?: { code?: string; details?: Record<string, unknown> };
  };
  return {
    status: error.getStatus(),
    code: response.error?.code,
    ...(response.error?.details ? { details: response.error.details } : {}),
  };
}
