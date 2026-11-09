import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  judgeFitCompany: vi.fn(),
  loadIcpBrief: vi.fn(async () => ({ icp_name: 'DE pump distributors' })),
  persistJudgmentRecordInTransaction: vi.fn(async () => undefined),
}));

vi.mock('../discovery/fit-judge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../discovery/fit-judge')>();
  return {
    ...actual,
    judgeFitCompany: mocks.judgeFitCompany,
    loadIcpBrief: mocks.loadIcpBrief,
    persistJudgmentRecordInTransaction: mocks.persistJudgmentRecordInTransaction,
  };
});

import { createRun2PipelineActivities } from './discovery.run2.pipeline.activities';
import { resetSanctionsStaleAlertDedupeForTests } from '../discovery/judgment/gate-chain';

/**
 * P3 J07 深判接线（fitCompanyOnce）：L0 门链在模型调用前评估，行为按 JUDGE_CONTRACT_MODE：
 *  - off：不评估 L0（旧行为）；
 *  - shadow：评估并记录，不拦截（v1 判定照旧）；
 *  - enforce：FAIL 拦截（不调模型、不写 Lead）；yellow/red 只注入 stale 标记。
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const ICP_ID = '33333333-3333-4333-8333-333333333333';
const COMPANY_ID = '44444444-4444-4444-8444-444444444444';
const EXECUTION_BUDGET = {
  authorityId: '55555555-5555-4555-8555-555555555555',
  replay: false,
  scopeKey: WORKSPACE_ID,
  accountKey: `discovery.run:discovery_run:request:${'c'.repeat(64)}:${'c'.repeat(64)}`,
  purpose: 'discovery.run',
  subjectType: 'discovery_run',
  subjectId: `request:${'c'.repeat(64)}`,
  requestSha256: 'c'.repeat(64),
};
const ARGS = {
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  icpId: ICP_ID,
  companyId: COMPANY_ID,
  executionContractVersion: 2 as const,
  executionBudget: EXECUTION_BUDGET,
};

function makeActivities(world: {
  screening?: Record<string, unknown> | null;
  sources?: Array<{ key: string; lastRefreshedAt: Date | null; lastFetchStatus: string | null }>;
}) {
  const leadUpserts: Array<Record<string, unknown>> = [];
  const gateFindFirst = vi.fn(async () => ({
    id: COMPANY_ID,
    name: 'Muster Pumpen Handel GmbH',
    domain: 'muster-pumpen.de',
    country: 'DE',
    industry: '工业泵分销',
    employeeCount: 85,
    revenueUsd: null,
    status: 'NEW',
    attributes: {},
  }));
  const tx = {
    $queryRaw: vi.fn(async () => []),
    canonicalCompany: {
      findUnique: vi.fn(async () => ({
        id: COMPANY_ID,
        name: 'Muster Pumpen Handel GmbH',
        domain: 'muster-pumpen.de',
        country: 'DE',
        industry: '工业泵分销',
        employeeCount: 85,
        revenueUsd: null,
        status: 'NEW',
        attributes: {},
      })),
      findFirst: gateFindFirst,
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    icpDefinition: { findFirst: vi.fn(async () => ({ companyAttributes: {}, targetMarkets: [] })) },
    qualificationRule: { findMany: vi.fn(async () => []) },
    sanctionsScreeningResult: { findUnique: vi.fn(async () => world.screening ?? null) },
    sanctionsSource: { findMany: vi.fn(async () => world.sources ?? []) },
    suppressionRecord: { findMany: vi.fn(async () => []) },
    hardGateResult: { createMany: vi.fn(async () => ({ count: 0 })) },
    gateEnrichmentTask: { createMany: vi.fn(async () => ({ count: 0 })) },
    outboxEvent: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
    },
    lead: {
      upsert: vi.fn(async (args: Record<string, unknown>) => {
        leadUpserts.push(args);
        return {};
      }),
    },
  };
  const prisma = {
    withWorkspace: vi.fn(
      async (_workspaceId: string, callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
    ),
  };
  const activities = createRun2PipelineActivities({
    prisma: prisma as never,
    providers: {} as never,
    gateway: {} as never,
    budgetStore: { attestAuthorized: vi.fn(async () => undefined) } as never,
  });
  return { activities, tx, leadUpserts, gateFindFirst };
}

const FIT_RESULT = {
  verdict: 'match' as const,
  fitReasons: {
    material: 'pass',
    role: 'pass',
    process: 'pass',
    business_model: 'pass',
    reasons: ['ok'],
  },
};

beforeEach(() => {
  mocks.judgeFitCompany.mockReset();
  mocks.judgeFitCompany.mockResolvedValue(FIT_RESULT);
  mocks.persistJudgmentRecordInTransaction.mockReset();
  vi.unstubAllEnvs();
  resetSanctionsStaleAlertDedupeForTests();
});

describe('fitCompanyOnce × L0 门链（P3 J07）', () => {
  it('off：不评估 L0（旧行为），模型判定照常', async () => {
    const { activities, gateFindFirst } = makeActivities({});

    const result = await activities.fitCompanyOnce(ARGS);

    expect(result).toMatchObject({ judged: true, verdict: 'match' });
    expect(gateFindFirst).not.toHaveBeenCalled();
    expect(mocks.judgeFitCompany).toHaveBeenCalledTimes(1);
    expect(mocks.judgeFitCompany.mock.calls[0]![4]).toMatchObject({ judgeContractMode: 'off' });
  });

  it('enforce：G1 命中在模型调用前拦截（不调模型、不写 Lead）', async () => {
    vi.stubEnv('JUDGE_CONTRACT_MODE', 'enforce');
    const { activities, leadUpserts } = makeActivities({
      screening: { status: 'potential_match', reviewState: 'open', listVersions: {} },
    });

    const result = await activities.fitCompanyOnce(ARGS);

    expect(result).toMatchObject({ judged: false, verdict: 'mismatch', skipped: true });
    expect(mocks.judgeFitCompany).not.toHaveBeenCalled();
    expect(leadUpserts).toHaveLength(0);
  });

  it('shadow：G1 命中只记录不拦截（v1 判定照旧，Lead 照写）', async () => {
    vi.stubEnv('JUDGE_CONTRACT_MODE', 'shadow');
    const { activities, leadUpserts } = makeActivities({
      screening: { status: 'potential_match', reviewState: 'open', listVersions: {} },
    });

    const result = await activities.fitCompanyOnce(ARGS);

    expect(result).toMatchObject({ judged: true, verdict: 'match' });
    expect(mocks.judgeFitCompany).toHaveBeenCalledTimes(1);
    expect(leadUpserts).toHaveLength(1);
  });

  it('shadow + 名单 yellow：不判 NOT_FIT，stale 标记写进 Lead 的 fitReasons', async () => {
    vi.stubEnv('JUDGE_CONTRACT_MODE', 'shadow');
    const { activities, leadUpserts } = makeActivities({
      screening: { status: 'clear', reviewState: 'open', listVersions: {} },
      sources: [
        {
          key: 'eu_fsf',
          lastRefreshedAt: new Date(Date.now() - 24 * 3_600_000),
          lastFetchStatus: 'FAILED',
        },
      ],
    });

    const result = await activities.fitCompanyOnce(ARGS);

    expect(result).toMatchObject({ judged: true, verdict: 'match' });
    expect(leadUpserts).toHaveLength(1);
    const data = leadUpserts[0]!.create as { fitVerdict: string; fitReasons: Record<string, unknown> };
    expect(data.fitVerdict).toBe('match');
    expect(data.fitReasons).toMatchObject({ sanctionsStale: 'yellow' });
  });
});
