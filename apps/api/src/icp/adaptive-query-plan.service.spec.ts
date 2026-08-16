import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import { AdaptiveQueryPlanService } from './adaptive-query-plan.service';

const CTX: RequestContext = {
  userId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  roles: [],
  scopes: ['acquisition:write'],
};

const RUN_ID = '33333333-3333-4333-8333-333333333333';
const PLAN_ID = '44444444-4444-4444-8444-444444444444';
const ICP_ID = '55555555-5555-4555-8555-555555555555';

const sourcePlan = {
  id: PLAN_ID,
  workspaceId: CTX.workspaceId,
  icpId: ICP_ID,
  status: 'EXECUTED',
  queries: [
    {
      source_class: 'public_intelligence',
      filters: { country: 'DE', industry: 'industrial pumps' },
      keywords: ['industrial pumps', 'distributor'],
      priority: 1,
    },
    {
      source_class: 'company_registry',
      filters: { country: 'DE' },
      keywords: ['industrial pumps'],
      priority: 2,
    },
  ],
  estimatedVolume: 20,
  estimatedCostCents: 4,
  version: 1,
  createdAt: new Date('2026-08-13T00:00:00.000Z'),
  updatedAt: new Date('2026-08-13T00:00:00.000Z'),
};

const completedRun = {
  id: RUN_ID,
  workspaceId: CTX.workspaceId,
  planId: PLAN_ID,
  icpId: ICP_ID,
  status: 'DONE',
  stats: {
    perSource: {
      public_intelligence: {
        rawCount: 1,
        quarantinedCount: 0,
        rejectedCount: 0,
        duplicateCount: 0,
        failedProviderCount: 0,
        provider: 'wikidata',
      },
      company_registry: {
        rawCount: 10,
        quarantinedCount: 0,
        rejectedCount: 0,
        duplicateCount: 0,
        failedProviderCount: 0,
        provider: 'gleif',
      },
    },
    identityQuality: {
      wikidata: { acceptedRows: 1, boundRows: 1, uniqueCompanies: 1, conflictRows: 0 },
      gleif: { acceptedRows: 10, boundRows: 10, uniqueCompanies: 10, conflictRows: 0 },
    },
  },
  createdAt: new Date('2026-08-13T00:00:00.000Z'),
  completedAt: new Date('2026-08-13T00:01:00.000Z'),
};

type StoredPlan = typeof sourcePlan & { id: string };

function harness(options: { run?: typeof completedRun | null; runStatus?: string } = {}) {
  const plans = new Map<string, StoredPlan>([[PLAN_ID, structuredClone(sourcePlan)]]);
  const run = options.run === null
    ? null
    : { ...structuredClone(options.run ?? completedRun), status: options.runStatus ?? completedRun.status };
  const tx = {
    $queryRaw: vi.fn(async () => [{ locked: '' }]),
    discoveryRun: {
      findUnique: vi.fn(async () => run),
    },
    discoveryQueryPlan: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => plans.get(where.id) ?? null),
      create: vi.fn(async ({ data }: { data: Partial<StoredPlan> & Pick<StoredPlan, 'id'> }) => {
        const stored = {
          ...structuredClone(sourcePlan),
          ...data,
          createdAt: new Date('2026-08-13T00:02:00.000Z'),
          updatedAt: new Date('2026-08-13T00:02:00.000Z'),
          version: 1,
        } as StoredPlan;
        plans.set(stored.id, stored);
        return stored;
      }),
    },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_workspaceId: string, fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  return {
    service: new AdaptiveQueryPlanService(prisma as never),
    prisma,
    tx,
    plans,
    run,
  };
}

function trace(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'adaptive-query-plan-suggestion/v1',
    previousRunId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    previousPlanId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    currentRound: 1,
    nextRound: 2,
    maxRounds: 3,
    reasons: [],
    ...overrides,
  };
}

function setPlanQueries(h: ReturnType<typeof harness>, queries: unknown[]) {
  (h.plans.get(PLAN_ID) as { queries: unknown[] }).queries = queries;
}

describe('AdaptiveQueryPlanService', () => {
  it('persists only a DRAFT plan with trace metadata and never schedules execution', async () => {
    const { service, prisma, tx } = harness();

    const result = await service.suggestForCompletedRun(CTX, RUN_ID, {
      currentRound: 1,
      maxRounds: 3,
    });

    expect(prisma.withWorkspace).toHaveBeenCalledWith(CTX.workspaceId, expect.any(Function));
    expect(result).toMatchObject({ outcome: 'DRAFT', replayed: false, convergenceReason: null });
    expect(result.plan).toMatchObject({ status: 'DRAFT', icpId: ICP_ID });
    expect(tx.discoveryQueryPlan.create).toHaveBeenCalledTimes(1);
    const created = tx.discoveryQueryPlan.create.mock.calls[0]![0].data;
    expect(created.status).toBe('DRAFT');
    expect(created.estimatedVolume).toBeNull();
    expect(created.estimatedCostCents).toBeNull();
    expect(created.queries[0]).toMatchObject({
      _adaptive: {
        schemaVersion: 'adaptive-query-plan-suggestion/v1',
        previousRunId: RUN_ID,
        previousPlanId: PLAN_ID,
        currentRound: 1,
        nextRound: 2,
        maxRounds: 3,
        reasons: expect.arrayContaining([
          expect.objectContaining({ code: 'LOW_YIELD_BROADENED' }),
        ]),
      },
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('derives the initial round as 1 when currentRound is omitted', async () => {
    const { service, tx } = harness();

    await service.suggestForCompletedRun(CTX, RUN_ID, { maxRounds: 3 });

    const created = tx.discoveryQueryPlan.create.mock.calls[0]![0].data;
    expect(created.queries[0]._adaptive).toMatchObject({ currentRound: 1, nextRound: 2, maxRounds: 3 });
  });

  it('rejects a client currentRound that disagrees with the source plan trace', async () => {
    const h = harness();
    setPlanQueries(h, sourcePlan.queries.map((query) => ({ ...query, _adaptive: trace() })));

    await expect(h.service.suggestForCompletedRun(CTX, RUN_ID, {
      currentRound: 3,
      maxRounds: 3,
    })).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'IDEMPOTENCY_CONFLICT' } },
    });
    expect(h.tx.discoveryQueryPlan.create).not.toHaveBeenCalled();
  });

  it('derives later currentRound and maxRounds from one consistent trace on every query', async () => {
    const h = harness();
    const priorTrace = trace();
    setPlanQueries(h, sourcePlan.queries.map((query) => ({ ...query, _adaptive: priorTrace })));

    await h.service.suggestForCompletedRun(CTX, RUN_ID, { currentRound: 2, maxRounds: 3 });

    const created = h.tx.discoveryQueryPlan.create.mock.calls[0]![0].data;
    expect(created.queries[0]._adaptive).toMatchObject({ currentRound: 2, nextRound: 3, maxRounds: 3 });
  });

  it('rejects a later request that tries to change maxRounds inherited from trace', async () => {
    const h = harness();
    setPlanQueries(h, sourcePlan.queries.map((query) => ({ ...query, _adaptive: trace() })));

    await expect(h.service.suggestForCompletedRun(CTX, RUN_ID, { maxRounds: 4 })).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'IDEMPOTENCY_CONFLICT' } },
    });
  });

  it.each([
    ['mixed traced and untraced queries', [
      { ...sourcePlan.queries[0], _adaptive: trace() },
      sourcePlan.queries[1],
    ]],
    ['inconsistent traces', sourcePlan.queries.map((query, index) => ({
      ...query,
      _adaptive: trace(index === 1 ? { maxRounds: 4 } : {}),
    }))],
    ['non-integer trace round', sourcePlan.queries.map((query) => ({
      ...query,
      _adaptive: trace({ currentRound: 1.5 }),
    }))],
    ['non-consecutive next round', sourcePlan.queries.map((query) => ({
      ...query,
      _adaptive: trace({ nextRound: 3 }),
    }))],
    ['next round beyond maxRounds', sourcePlan.queries.map((query) => ({
      ...query,
      _adaptive: trace({ currentRound: 3, nextRound: 4, maxRounds: 3 }),
    }))],
  ])('fails closed for %s', async (_name, queries) => {
    const h = harness();
    setPlanQueries(h, queries);

    await expect(h.service.suggestForCompletedRun(CTX, RUN_ID, {})).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'ADAPTIVE_FACTS_UNAVAILABLE' } },
    });
    expect(h.tx.discoveryQueryPlan.create).not.toHaveBeenCalled();
  });

  it('rejects duplicate source_class queries because perSource cannot represent them losslessly', async () => {
    const h = harness();
    setPlanQueries(h, [sourcePlan.queries[0], { ...sourcePlan.queries[0], priority: 2 }]);
    if (h.run) {
      h.run.stats.perSource = { public_intelligence: completedRun.stats.perSource.public_intelligence } as never;
    }

    await expect(h.service.suggestForCompletedRun(CTX, RUN_ID, {})).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'ADAPTIVE_FACTS_UNAVAILABLE' } },
    });
  });

  it.each([
    ['missing source stats', {
      public_intelligence: completedRun.stats.perSource.public_intelligence,
    }],
    ['extra source stats', {
      ...completedRun.stats.perSource,
      web: completedRun.stats.perSource.public_intelligence,
    }],
  ])('rejects %s instead of silently preserving a query', async (_name, perSource) => {
    const h = harness();
    if (h.run) h.run.stats.perSource = perSource as never;

    await expect(h.service.suggestForCompletedRun(CTX, RUN_ID, {})).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'ADAPTIVE_FACTS_UNAVAILABLE' } },
    });
  });

  it('replays the same plan for the same run without creating a duplicate', async () => {
    const { service, tx } = harness();

    const first = await service.suggestForCompletedRun(CTX, RUN_ID, {
      currentRound: 1,
      maxRounds: 3,
    });
    const replay = await service.suggestForCompletedRun(CTX, RUN_ID, {
      currentRound: 1,
      maxRounds: 3,
    });

    expect(first.plan?.id).toBe(replay.plan?.id);
    expect(replay.replayed).toBe(true);
    expect(tx.discoveryQueryPlan.create).toHaveBeenCalledTimes(1);
  });

  it('returns the stable existing plan before a later valid stats snapshot can report CONVERGED', async () => {
    const h = harness();
    const first = await h.service.suggestForCompletedRun(CTX, RUN_ID, { maxRounds: 3 });
    if (!h.run) throw new Error('run fixture missing');
    h.run.stats = {
      perSource: {
        public_intelligence: {
          rawCount: 10, quarantinedCount: 0, rejectedCount: 0, duplicateCount: 0,
          failedProviderCount: 0, provider: 'wikidata',
        },
        company_registry: {
          rawCount: 10, quarantinedCount: 0, rejectedCount: 0, duplicateCount: 0,
          failedProviderCount: 0, provider: 'gleif',
        },
      },
      identityQuality: {
        wikidata: { acceptedRows: 10, boundRows: 10, uniqueCompanies: 10, conflictRows: 0 },
        gleif: { acceptedRows: 10, boundRows: 10, uniqueCompanies: 10, conflictRows: 0 },
      },
    };

    const replay = await h.service.suggestForCompletedRun(CTX, RUN_ID, { maxRounds: 3 });

    expect(first.outcome).toBe('DRAFT');
    expect(replay).toMatchObject({ outcome: 'DRAFT', replayed: true, plan: { id: first.plan?.id } });
    expect(h.tx.discoveryQueryPlan.create).toHaveBeenCalledTimes(1);
  });

  it('returns tenant-hidden 404 when the run is not visible in the workspace', async () => {
    const { service, tx } = harness({ run: null });

    await expect(service.suggestForCompletedRun(CTX, RUN_ID, {
      currentRound: 1,
      maxRounds: 3,
    })).rejects.toMatchObject({
      status: 404,
      response: { error: { code: 'NOT_FOUND' } },
    });
    expect(tx.discoveryQueryPlan.create).not.toHaveBeenCalled();
  });

  it.each(['RUNNING', 'FAILED'])('rejects non-successful run status %s without a draft', async (status) => {
    const { service, tx } = harness({ runStatus: status });

    await expect(service.suggestForCompletedRun(CTX, RUN_ID, {
      currentRound: 1,
      maxRounds: 3,
    })).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'INVALID_STATE' } },
    });
    expect(tx.discoveryQueryPlan.create).not.toHaveBeenCalled();
  });

  it('fails closed when a retry changes the round bounds for the same run', async () => {
    const { service, tx } = harness();
    await service.suggestForCompletedRun(CTX, RUN_ID, { currentRound: 1, maxRounds: 3 });

    await expect(service.suggestForCompletedRun(CTX, RUN_ID, {
      currentRound: 1,
      maxRounds: 4,
    })).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'IDEMPOTENCY_CONFLICT' } },
    });
    expect(tx.discoveryQueryPlan.create).toHaveBeenCalledTimes(1);
  });

  it('returns convergence at the round limit derived from the prior source plan trace', async () => {
    const h = harness();
    const priorTrace = trace({ currentRound: 2, nextRound: 3, maxRounds: 3 });
    setPlanQueries(h, sourcePlan.queries.map((query) => ({ ...query, _adaptive: priorTrace })));

    const result = await h.service.suggestForCompletedRun(CTX, RUN_ID, {});

    expect(result).toEqual({
      outcome: 'CONVERGED',
      replayed: false,
      convergenceReason: 'MAX_ROUNDS_REACHED',
      plan: null,
    });
    expect(h.tx.discoveryQueryPlan.create).not.toHaveBeenCalled();
  });
});
