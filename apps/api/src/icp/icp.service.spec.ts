import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFdaQuery, resolveIcpToFda } from '../discovery/icp-to-fda';
import { buildTedQuery, resolveIcpToCpv } from '../discovery/icp-to-cpv';
import { executeStructuredTaskWithRuntime } from '../model-runtime/structured-task-runtime-bridge';
import { IcpService } from './icp.service';

vi.mock('../model-runtime/structured-task-runtime-bridge', () => ({
  executeStructuredTaskWithRuntime: vi.fn(),
}));
vi.mock('../discovery/icp-to-cpv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../discovery/icp-to-cpv')>();
  return {
    ...actual,
    resolveIcpToCpv: vi.fn(),
    buildTedQuery: vi.fn((_resolved, planned) => [
      { source_class: 'public_intelligence', filters: { provider: 'ted' }, keywords: [], rationale: 'TED', priority: 1 },
      ...planned,
    ]),
  };
});
vi.mock('../discovery/icp-to-fda', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../discovery/icp-to-fda')>();
  return {
    ...actual,
    resolveIcpToFda: vi.fn(),
    buildFdaQuery: vi.fn((_resolved, planned) => [
      { source_class: 'public_intelligence', filters: { provider: 'openfda' }, keywords: [], rationale: 'FDA', priority: 1 },
      ...planned,
    ]),
  };
});

const ctx = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  userId: 'operator-1',
  roles: ['acquisition-operator'],
};

function icpRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'icp-1',
    workspaceId: ctx.workspaceId,
    companyId: 'company-1',
    name: 'German pump buyers',
    status: 'HYPOTHESIS',
    version: 1,
    companyAttributes: { industry: 'industrial pumps', product: 'centrifugal pump' },
    targetMarkets: ['DE', 'US'],
    triggerSignals: ['tender'],
    exclusions: [],
    rules: [],
    personas: [],
    roles: [],
    ...overrides,
  };
}

function harness(overrides: Record<string, unknown> = {}) {
  const tx = {
    companyProfile: {
      findUnique: vi.fn(async () => ({
        id: 'company-1',
        name: 'Seller GmbH',
        website: 'https://seller.example',
      })),
    },
    claim: {
      findMany: vi.fn(async () => [
        { type: 'CAPABILITY', statement: 'Makes industrial pumps' },
      ]),
    },
    offering: {
      findMany: vi.fn(async () => [
        { name: 'Centrifugal pump', description: '400 bar' },
      ]),
    },
    icpDefinition: {
      create: vi.fn(async () => icpRow()),
      findMany: vi.fn(async () => [icpRow()]),
      findUnique: vi.fn(async () => icpRow()),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => icpRow({ status: 'ACTIVE', version: 2 })),
    },
    persona: { create: vi.fn(async () => ({})) },
    buyingCommitteeRole: { create: vi.fn(async () => ({})) },
    qualificationRule: {
      create: vi.fn(async (args: unknown) => ({ id: 'rule-1', args })),
      findUnique: vi.fn(async () => ({ id: 'rule-1' })),
      update: vi.fn(async (args: unknown) => ({ id: 'rule-1', args })),
      delete: vi.fn(async () => ({ id: 'rule-1' })),
    },
    outboxEvent: { create: vi.fn(async () => ({ eventId: 'event-1' })) },
    icpBacktest: {
      create: vi.fn(async (args: unknown) => ({ id: 'backtest-1', args })),
      findMany: vi.fn(async () => [{ id: 'backtest-1' }]),
    },
    discoveryQueryPlan: {
      create: vi.fn(async (args: any) => ({ id: 'plan-1', ...args.data })),
      findUnique: vi.fn(async () => ({ id: 'plan-1', status: 'DRAFT' })),
      update: vi.fn(async () => ({ id: 'plan-1', status: 'READY', version: 2 })),
      findMany: vi.fn(async () => [{ id: 'plan-1' }]),
    },
    ...overrides,
  } as any;
  const prisma = {
    withWorkspace: vi.fn(async (_workspaceId: string, work: (value: typeof tx) => unknown) => work(tx)),
  };
  const gateway = {};
  const telemetry = {};
  return {
    service: new IcpService(prisma as any, gateway as any, telemetry as any),
    prisma,
    gateway,
    telemetry,
    tx,
  };
}

function modelIcpOutput(overrides: Record<string, unknown> = {}) {
  return {
    name: 'German pump buyers',
    company_attributes: { industry: 'industrial pumps' },
    pain_points: ['downtime'],
    trigger_signals: ['tender'],
    exclusions: ['consumer-only'],
    value_props: ['reliability'],
    target_markets: ['DE'],
    personas: [{ title: 'Procurement', goals: ['availability'], pain_points: ['lead time'] }],
    buying_committee: [{ role: 'economic buyer', title: 'CPO', concerns: ['TCO'] }],
    qualification_rules: [
      { kind: 'must_have', field: 'country', operator: 'eq', value: 'DE' },
      { kind: 'not-real', field: 'country', operator: 'eq', value: 'DE' },
      { kind: 'must_have', field: 'country', operator: 'not-real', value: 'DE' },
    ],
    ...overrides,
  };
}

describe('IcpService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveIcpToCpv).mockResolvedValue({ cpvCodes: ['42122000'] } as any);
    vi.mocked(resolveIcpToFda).mockResolvedValue({ productCodes: ['KFM'] } as any);
  });

  it('fails before model execution for an absent company or no approved claims', async () => {
    const missing = harness();
    missing.tx.companyProfile.findUnique.mockResolvedValue(null);
    await expect(missing.service.generateFromCompany(ctx, 'missing')).rejects.toBeInstanceOf(NotFoundException);

    const noClaims = harness();
    noClaims.tx.claim.findMany.mockResolvedValue([]);
    await expect(noClaims.service.generateFromCompany(ctx, 'company-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(executeStructuredTaskWithRuntime).not.toHaveBeenCalled();
  });

  it('persists model output, optional collections, and only valid qualification rules', async () => {
    vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValue({
      data: modelIcpOutput(),
    } as any);
    const { service, tx } = harness();

    const result = await service.generateFromCompany(ctx, 'company-1');

    expect(result).toMatchObject({ id: 'icp-1' });
    expect(executeStructuredTaskWithRuntime).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        task: 'icp.design',
        prompt: expect.stringContaining('Centrifugal pump：400 bar'),
      }),
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      expect.anything(),
    );
    expect(tx.persona.create).toHaveBeenCalledOnce();
    expect(tx.buyingCommitteeRole.create).toHaveBeenCalledOnce();
    expect(tx.qualificationRule.create).toHaveBeenCalledOnce();
    expect(tx.qualificationRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'MUST_HAVE', weight: 1, rationale: null }),
    });
  });

  it('uses safe defaults when optional model fields and offering descriptions are absent', async () => {
    vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValue({
      data: modelIcpOutput({
        name: undefined,
        personas: undefined,
        buying_committee: undefined,
        qualification_rules: undefined,
      }),
    } as any);
    const { service, tx } = harness();
    tx.offering.findMany.mockResolvedValue([{ name: 'Bare pump', description: null }]);

    await service.generateFromCompany(ctx, 'company-1');

    expect(tx.icpDefinition.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: '未命名 ICP' }),
    });
    expect(tx.persona.create).not.toHaveBeenCalled();
    expect(tx.buyingCommitteeRole.create).not.toHaveBeenCalled();
    expect(tx.qualificationRule.create).not.toHaveBeenCalled();
  });

  it('lists, gets, and rejects an absent full ICP projection', async () => {
    const { service, tx } = harness();
    await service.list(ctx, 'company-1');
    await service.list(ctx);
    expect(tx.icpDefinition.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { companyId: 'company-1' } }),
    );
    expect(tx.icpDefinition.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: {} }),
    );
    await expect(service.get(ctx, 'icp-1')).resolves.toMatchObject({ id: 'icp-1' });
    tx.icpDefinition.findUnique.mockResolvedValueOnce(null);
    await expect(service.get(ctx, 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('activates only mutable ICP states and emits the handoff event', async () => {
    const { service, tx } = harness();
    tx.icpDefinition.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(icpRow({ status: 'ACTIVE' }))
      .mockResolvedValueOnce(icpRow({ status: 'VALIDATING' }))
      .mockResolvedValueOnce(icpRow({ status: 'ACTIVE' }));

    await expect(service.activate(ctx, 'missing')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.activate(ctx, 'icp-1')).rejects.toBeInstanceOf(ConflictException);
    await expect(service.activate(ctx, 'icp-1')).resolves.toMatchObject({ id: 'icp-1', status: 'ACTIVE' });
    expect(tx.icpDefinition.updateMany).toHaveBeenCalledOnce();
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: 'ICPActivated', aggregateId: 'icp-1' }),
    });
  });

  it('enforces update existence, state, and optimistic version before applying every patch field', async () => {
    const patch = {
      name: 'Updated',
      companyAttributes: { industry: 'pump' },
      painPoints: ['cost'],
      triggerSignals: ['RFQ'],
      exclusions: ['retail'],
      valueProps: ['uptime'],
      targetMarkets: ['EU'],
    };
    const { service, tx } = harness();
    tx.icpDefinition.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(icpRow({ status: 'ARCHIVED' }))
      .mockResolvedValueOnce(icpRow({ version: 3 }))
      .mockResolvedValueOnce(icpRow({ version: 3 }))
      .mockResolvedValueOnce(icpRow({ version: 4 }));

    await expect(service.update(ctx, 'missing', {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.update(ctx, 'icp-1', {})).rejects.toBeInstanceOf(ConflictException);
    await expect(service.update(ctx, 'icp-1', {}, 2)).rejects.toBeInstanceOf(ConflictException);
    await service.update(ctx, 'icp-1', patch, 3);
    expect(tx.icpDefinition.update).toHaveBeenCalledWith({
      where: { id: 'icp-1' },
      data: expect.objectContaining({
        name: 'Updated',
        companyAttributes: { industry: 'pump' },
        painPoints: ['cost'],
        triggerSignals: ['RFQ'],
        exclusions: ['retail'],
        valueProps: ['uptime'],
        targetMarkets: ['EU'],
        version: { increment: 1 },
      }),
    });
    await service.update(ctx, 'icp-1', {});
    expect(tx.icpDefinition.update).toHaveBeenLastCalledWith({
      where: { id: 'icp-1' },
      data: { version: { increment: 1 } },
    });
  });

  it('validates, creates, updates, and deletes qualification rules', async () => {
    const { service, tx } = harness();
    const valid = { kind: 'nice_to_have', field: 'country', operator: 'in', value: ['DE'] };

    await expect(service.addRule(ctx, 'icp-1', { ...valid, kind: 'invalid' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.addRule(ctx, 'icp-1', { ...valid, operator: 'invalid' })).rejects.toBeInstanceOf(BadRequestException);
    tx.icpDefinition.findUnique.mockResolvedValueOnce(null);
    await expect(service.addRule(ctx, 'missing', valid)).rejects.toBeInstanceOf(NotFoundException);
    await service.addRule(ctx, 'icp-1', valid);
    expect(tx.qualificationRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'NICE_TO_HAVE', weight: 1, rationale: null }),
    });

    tx.qualificationRule.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'rule-1' })
      .mockResolvedValueOnce({ id: 'rule-1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'rule-1' });
    await expect(service.updateRule(ctx, 'missing', {})).rejects.toBeInstanceOf(NotFoundException);
    await service.updateRule(ctx, 'rule-1', {});
    await service.updateRule(ctx, 'rule-1', {
      kind: 'exclusion',
      field: 'employeeCount',
      operator: 'gte',
      value: 50,
      weight: 2,
      rationale: 'industrial scale',
    });
    expect(tx.qualificationRule.update).toHaveBeenLastCalledWith({
      where: { id: 'rule-1' },
      data: expect.objectContaining({
        kind: 'EXCLUSION',
        field: 'employeeCount',
        operator: 'gte',
        value: 50,
        weight: 2,
        rationale: 'industrial scale',
      }),
    });
    await expect(service.deleteRule(ctx, 'missing')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.deleteRule(ctx, 'rule-1')).resolves.toEqual({ deleted: true });
  });

  it('validates a partial rule update before accessing storage', async () => {
    const { service, prisma } = harness();
    await expect(service.updateRule(ctx, 'rule-1', { kind: 'bad' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateRule(ctx, 'rule-1', { operator: 'bad' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
  });

  it('backtests rules, advances hypotheses, and calculates promote/revise/null metrics', async () => {
    const rule = { id: 'r1', kind: 'MUST_HAVE', field: 'country', operator: 'eq', value: 'DE', weight: 1 };
    const { service, tx } = harness();
    tx.icpDefinition.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(icpRow({ rules: [] }))
      .mockResolvedValueOnce(icpRow({ rules: [rule], status: 'HYPOTHESIS' }))
      .mockResolvedValueOnce(icpRow({ rules: [rule], status: 'ACTIVE' }));

    await expect(service.runBacktest(ctx, 'missing', [])).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.runBacktest(ctx, 'icp-1', [])).rejects.toBeInstanceOf(BadRequestException);
    await service.runBacktest(ctx, 'icp-1', [
      { name: 'Good', attributes: { country: 'DE' }, expected: 'match' },
      { name: 'Bad', domain: 'bad.example', attributes: { country: 'US' }, expected: 'exclude' },
    ]);
    const firstMetrics = tx.icpBacktest.create.mock.calls[0]?.[0].data.metrics;
    expect(firstMetrics).toMatchObject({ matchHitRate: 1, excludeCatchRate: 1, recommendation: 'promote' });
    expect(tx.icpDefinition.update).toHaveBeenCalledWith({
      where: { id: 'icp-1' },
      data: { status: 'VALIDATING' },
    });

    await service.runBacktest(ctx, 'icp-1', []);
    const emptyMetrics = tx.icpBacktest.create.mock.calls[1]?.[0].data.metrics;
    expect(emptyMetrics).toEqual({
      matchHitRate: null,
      excludeCatchRate: null,
      unknownFieldRate: null,
      recommendation: 'promote',
    });
    expect(tx.icpDefinition.update).toHaveBeenCalledTimes(1);
  });

  it('returns saved backtests', async () => {
    const { service, tx } = harness();
    await expect(service.listBacktests(ctx, 'icp-1')).resolves.toEqual([{ id: 'backtest-1' }]);
    expect(tx.icpBacktest.findMany).toHaveBeenCalledWith({
      where: { icpId: 'icp-1' },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('requires an ACTIVE ICP before generating a query plan', async () => {
    const { service, tx } = harness();
    tx.icpDefinition.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(icpRow({ status: 'HYPOTHESIS' }));
    await expect(service.generateQueryPlan(ctx, 'missing')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.generateQueryPlan(ctx, 'icp-1')).rejects.toBeInstanceOf(ConflictException);
    expect(executeStructuredTaskWithRuntime).not.toHaveBeenCalled();
  });

  it.each([
    { estimated: 12.6, expected: 13 },
    { estimated: Number.POSITIVE_INFINITY, expected: null },
  ])('generates a gated query plan and normalizes estimated volume ($estimated)', async ({ estimated, expected }) => {
    vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValue({
      data: {
        queries: [{ source_class: 'public_web', filters: {}, keywords: ['pump'], rationale: 'discover', priority: 2 }],
        estimated_volume: estimated,
      },
    } as any);
    const { service, tx } = harness();
    tx.icpDefinition.findUnique.mockResolvedValue(icpRow({ status: 'ACTIVE' }));

    const plan = await service.generateQueryPlan(ctx, 'icp-1');

    expect(plan).toMatchObject({ status: 'DRAFT', estimatedVolume: expected });
    expect(resolveIcpToCpv).toHaveBeenCalledOnce();
    expect(resolveIcpToFda).toHaveBeenCalledOnce();
    expect(tx.discoveryQueryPlan.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'DRAFT',
        queries: expect.arrayContaining([
          expect.objectContaining({ filters: { provider: 'ted' } }),
          expect.objectContaining({ filters: { provider: 'openfda' } }),
        ]),
      }),
    });
  });

  it('keeps the model plan when deterministic taxonomy injection fails', async () => {
    vi.mocked(resolveIcpToCpv).mockRejectedValueOnce(new Error('cpv unavailable'));
    vi.mocked(resolveIcpToFda).mockRejectedValueOnce(new Error('fda unavailable'));
    vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValue({
      data: { queries: undefined, estimated_volume: 0 },
    } as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { service, tx } = harness();
    tx.icpDefinition.findUnique.mockResolvedValue(icpRow({
      status: 'ACTIVE',
      companyAttributes: { industry: 'pump', trade_side: 'importer' },
      targetMarkets: null,
    }));

    await service.generateQueryPlan(ctx, 'icp-1');

    expect(tx.discoveryQueryPlan.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ queries: [], estimatedVolume: 0 }),
    });
    expect(buildTedQuery).not.toHaveBeenCalled();
    expect(buildFdaQuery).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('confirms only DRAFT query plans and lists their history', async () => {
    const { service, tx } = harness();
    tx.discoveryQueryPlan.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'plan-1', status: 'READY' })
      .mockResolvedValueOnce({ id: 'plan-1', status: 'DRAFT' });
    await expect(service.confirmQueryPlan(ctx, 'missing')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.confirmQueryPlan(ctx, 'plan-1')).rejects.toBeInstanceOf(ConflictException);
    await expect(service.confirmQueryPlan(ctx, 'plan-1')).resolves.toMatchObject({ status: 'READY' });
    await expect(service.listQueryPlans(ctx, 'icp-1')).resolves.toEqual([{ id: 'plan-1' }]);
  });
});

