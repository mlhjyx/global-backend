import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P1-10b：run 内富集 activity 的守卫与接线——无凭据 / data_provider 全关 / 无 lawful basis
 * 时直接跳过（不触碰联系人）；通过守卫后把 run 账户、配置 basis 与「run 剩余 ∩ $0.50」预算
 * 传入公司级核心。
 */
const mocks = vi.hoisted(() => ({
  enrichCompanyContacts: vi.fn(),
}));

vi.mock('../enrichment/waterfall/enrich-company-contacts', () => ({
  enrichCompanyContacts: mocks.enrichCompanyContacts,
}));

import { createRun2PipelineActivities } from './discovery.run2.pipeline.activities';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const ICP_ID = '33333333-3333-4333-8333-333333333333';
const COMPANY_ID = '44444444-4444-4444-8444-444444444444';

const ARGS = {
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  icpId: ICP_ID,
  companyId: COMPANY_ID,
  executionContractVersion: 2 as const,
  executionBudget: {
    authorityId: '55555555-5555-4555-8555-555555555555',
    replay: false,
    scopeKey: WORKSPACE_ID,
    accountKey: `discovery.run:discovery_run:request:${'c'.repeat(64)}:${'c'.repeat(64)}`,
    purpose: 'discovery.run' as const,
    subjectType: 'discovery_run',
    subjectId: `request:${'c'.repeat(64)}`,
    requestSha256: 'c'.repeat(64),
  },
};

function makeActivities(world: {
  enabledFinderKeys?: string[];
  decisionMakerConfig?: Record<string, unknown> | null;
}) {
  const prisma = {
    dataProvider: {
      findMany: vi.fn(async () => (world.enabledFinderKeys ?? []).map((key) => ({ key }))),
      findUnique: vi.fn(async () => ({ config: world.decisionMakerConfig ?? null })),
    },
    withWorkspace: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
  };
  const budgetStore = {
    attestAuthorized: vi.fn(async () => ({
      accountId: 'account-1',
      authorityId: ARGS.executionBudget.authorityId,
      authorizedCapMicrousd: 5_000_000n,
      generation: 1,
    })),
    status: vi.fn(async () => ({ remainingMicrousd: 3_000_000n, exhausted: false, open: true })),
  };
  return createRun2PipelineActivities({
    prisma: prisma as never,
    providers: {} as never,
    gateway: {} as never,
    budgetStore: budgetStore as never,
  });
}

const LAW_BASIS_CONFIG = { lawfulBasis: { basis: 'legitimate_interest', ref: 'LIA-42' } };

function makeSafetyActivities(executeRun: ReturnType<typeof vi.fn>) {
  const prisma = {
    dataProvider: { findMany: vi.fn(async () => [{ key: 'hunter' }]), findUnique: vi.fn(async () => ({ config: LAW_BASIS_CONFIG })) },
    withWorkspace: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
  };
  const budgetStore = { attestAuthorized: vi.fn(async () => ({ accountId: 'account-1', authorityId: ARGS.executionBudget.authorityId, authorizedCapMicrousd: 5_000_000n, generation: 1 })), status: vi.fn(async () => ({ remainingMicrousd: 3_000_000n, exhausted: false, open: true })) };
  return { activities: createRun2PipelineActivities({ prisma: prisma as never, providers: {} as never, gateway: {} as never, budgetStore: budgetStore as never, contactEnrichmentSafety: { executeRun } as never }), budgetStore };
}

describe('enrichContactsForCompany safety lane (run caller)', () => {
  beforeEach(() => { mocks.enrichCompanyContacts.mockReset(); process.env.HUNTER_API_KEY = 'hunter-key'; });
  afterEach(() => { delete process.env.HUNTER_API_KEY; });
  it('routes the admitted run through the shared helper with actual business runId and remaining micro only', async () => {
    const executeRun = vi.fn(async () => ({ companyId: COMPANY_ID, tier: 'B', attempted: 1, costMicrousd: 1700, deadlineHit: false, results: [], admission: 'ADMITTED', operationRef: 'd'.repeat(64), qualityCoverage: 'PREREQUISITE_ONLY' }));
    const { activities } = makeSafetyActivities(executeRun);
    const result = await activities.enrichContactsForCompany(ARGS);
    expect(result).toEqual({ skipped: false, tier: 'B', attempted: 1, costMicrousd: 1700, operationRef: 'd'.repeat(64) });
    expect(executeRun).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspaceId: WORKSPACE_ID, companyId: COMPANY_ID, businessRunId: RUN_ID, remainingMicrousd: '3000000', actorId: 'discovery-run:' + RUN_ID, binding: expect.objectContaining({ accountKey: ARGS.executionBudget.accountKey }) }));
    expect(mocks.enrichCompanyContacts).not.toHaveBeenCalled();
  });
  it('reports not-admitted safety preflight as the legacy skipped reason without inventing spend', async () => {
    const executeRun = vi.fn(async () => ({ companyId: COMPANY_ID, tier: 'B', attempted: 0, costMicrousd: 0, deadlineHit: false, results: [], admission: 'NOT_ADMITTED', reasonCode: 'GOVERNANCE_PENDING', qualityCoverage: 'PREREQUISITE_ONLY' }));
    const { activities } = makeSafetyActivities(executeRun);
    expect(await activities.enrichContactsForCompany(ARGS)).toEqual({ skipped: true, reason: 'governance_pending' });
    expect(mocks.enrichCompanyContacts).not.toHaveBeenCalled();
  });
  it('fails closed with source_control_pending and zero legacy wire when no safety service is composed', async () => {
    process.env.HUNTER_API_KEY = 'hunter-key';
    mocks.enrichCompanyContacts.mockResolvedValue({ companyId: COMPANY_ID, tier: 'A', attempted: 2, costMicrousd: 4200, deadlineHit: false, results: [] });
    const activities = makeActivities({ enabledFinderKeys: ['hunter'], decisionMakerConfig: LAW_BASIS_CONFIG });
    expect(await activities.enrichContactsForCompany(ARGS)).toEqual({ skipped: true, reason: 'source_control_pending' });
    expect(mocks.enrichCompanyContacts).not.toHaveBeenCalled();
  });
});


describe('enrichContactsForCompany（P1-10b）', () => {
  beforeEach(() => {
    mocks.enrichCompanyContacts.mockReset();
    mocks.enrichCompanyContacts.mockResolvedValue({
      companyId: COMPANY_ID,
      tier: 'A',
      attempted: 2,
      costMicrousd: 4_200,
      deadlineHit: false,
      results: [],
    });
  });
  afterEach(() => {
    delete process.env.HUNTER_API_KEY;
  });

  it('无已配置凭据 → 跳过且不调用核心', async () => {
    const activities = makeActivities({ enabledFinderKeys: ['hunter'] });
    expect(await activities.enrichContactsForCompany(ARGS)).toEqual({
      skipped: true,
      reason: 'no_configured_finder',
    });
    expect(mocks.enrichCompanyContacts).not.toHaveBeenCalled();
  });

  it('凭据在位但 data_provider 全 DISABLED → 跳过（不写 attempt 账）', async () => {
    process.env.HUNTER_API_KEY = 'hunter-key';
    const activities = makeActivities({ enabledFinderKeys: [] });
    expect(await activities.enrichContactsForCompany(ARGS)).toEqual({
      skipped: true,
      reason: 'no_enabled_finder',
    });
    expect(mocks.enrichCompanyContacts).not.toHaveBeenCalled();
  });

  it('无 lawful basis 配置 → 跳过', async () => {
    process.env.HUNTER_API_KEY = 'hunter-key';
    const activities = makeActivities({
      enabledFinderKeys: ['hunter'],
      decisionMakerConfig: null,
    });
    expect(await activities.enrichContactsForCompany(ARGS)).toEqual({
      skipped: true,
      reason: 'no_lawful_basis_configured',
    });
    expect(mocks.enrichCompanyContacts).not.toHaveBeenCalled();
  });

  it('through the guards, requires the safety lane instead of the legacy core', async () => {
    process.env.HUNTER_API_KEY = 'hunter-key';
    const activities = makeActivities({ enabledFinderKeys: ['hunter'], decisionMakerConfig: LAW_BASIS_CONFIG });
    expect(await activities.enrichContactsForCompany(ARGS)).toEqual({ skipped: true, reason: 'source_control_pending' });
    expect(mocks.enrichCompanyContacts).not.toHaveBeenCalled();
  });
});
