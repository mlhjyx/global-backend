import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  judgeFitCompany: vi.fn(),
  loadIcpBrief: vi.fn(async () => ({ icp_name: 'DE pump distributors' })),
}));

/**
 * P3 J02 W4：Temporal 活动上下文。默认 null（等价于旧行为：直接调用工厂函数没有上下文），
 * 需要验证 heartbeat/取消的用例显式设置。
 */
const activityRuntime = vi.hoisted(() => ({
  context: null as null | { heartbeat: ReturnType<typeof vi.fn>; cancellationSignal: { aborted: boolean } },
  heartbeat: vi.fn(),
}));

vi.mock('@temporalio/activity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@temporalio/activity')>();
  return {
    ...actual,
    Context: class {
      static current(): unknown {
        if (activityRuntime.context === null) {
          throw new Error('Activity context not initialized');
        }
        return activityRuntime.context;
      }
    },
  };
});

vi.mock('../model-runtime/structured-task-runtime-bridge', () => ({
  executeStructuredTaskWithRuntime: mocks.execute,
}));
vi.mock('../discovery/fit-judge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../discovery/fit-judge')>();
  return {
    ...actual,
    judgeFitCompany: mocks.judgeFitCompany,
    loadIcpBrief: mocks.loadIcpBrief,
  };
});

import { createRun2Activities } from './discovery.run2.activities';
import { ExternalActionDeniedError, ProviderHttpError } from '../model-gateway/providers/provider-output-error';
import { CancelledFailure } from '@temporalio/common';
import { getTask } from '../ai-tasks/task-registry';
import { StaticSkillResolver } from '../skills/skill-runtime';
import { resetSanctionsStaleAlertDedupeForTests } from '../discovery/judgment/gate-chain';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const ICP_ID = '33333333-3333-4333-8333-333333333333';
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
  executionContractVersion: 2 as const,
  executionBudget: EXECUTION_BUDGET,
};

function company(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Company ${id}`,
    domain: `${id}.example`,
    country: 'DE',
    industry: 'industrial pumps',
    employeeCount: 30,
    revenueUsd: 5,
    attributes: {},
    ...overrides,
  };
}

function makePrisma(state: {
  rules?: Array<Record<string, unknown>>;
  companies?: Array<Record<string, unknown>>;
  jobs?: Array<Record<string, unknown>>;
  leads?: Array<Record<string, unknown>>;
  mayUse?: (companyId: string) => boolean;
  run?: Record<string, unknown>;
  /** 可变禁联事实：测试可在预检之后追加，模拟 TOCTOU 窗口。 */
  suppressions?: Array<{ type: string; value: string }>;
  /** P3 J07/J08：L0 门链的 ICP（companyAttributes/targetMarkets）与制裁事实。 */
  icp?: Record<string, unknown>;
  screening?: Record<string, unknown> | null;
  sanctionsSources?: Array<{ key: string; lastRefreshedAt: Date | null; lastFetchStatus: string | null }>;
}) {
  const jobUpserts: Array<{ where: unknown; create: Record<string, unknown> }> = [];
  const jobUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const events: Array<Record<string, unknown>> = [];
  const leadUpserts: Array<Record<string, unknown>> = [];
  const phaseUpdates: Array<Record<string, unknown>> = [];
  const shadowUpserts: Array<Record<string, unknown>> = [];
  const gateResults: Array<Record<string, unknown>> = [];
  const enrichmentTasks: Array<Record<string, unknown>> = [];
  const outboxEvents: Array<Record<string, unknown>> = [];
  // 两套 replay 键（与迁移里的表达式唯一索引同语义）：同键第二次写入被跳过。
  const resultKeys = new Set<string>();
  const taskKeys = new Set<string>();
  const insertMany = (
    target: Array<Record<string, unknown>>,
    keys: Set<string>,
    makeKey: (row: Record<string, unknown>) => string,
  ) =>
    vi.fn(async (args: { data: Array<Record<string, unknown>> }) => {
      let count = 0;
      for (const row of args.data) {
        const key = makeKey(row);
        if (keys.has(key)) continue;
        keys.add(key);
        target.push(row);
        count += 1;
      }
      return { count };
    });
  let seq = 0n;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    qualificationRule: { findMany: vi.fn(async () => state.rules ?? []) },
    canonicalCompany: {
      count: vi.fn(async () => (state.companies ?? []).length),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const match = (state.companies ?? []).find((c) => c.id === where.id);
        return match
          ? {
              id: match.id,
              name: match.name,
              domain: match.domain,
              country: match.country ?? null,
              industry: match.industry ?? null,
              employeeCount: match.employeeCount ?? null,
              revenueUsd: match.revenueUsd ?? null,
              status: 'NEW',
              attributes: match.attributes ?? {},
            }
          : null;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const match = (state.companies ?? []).find((c) => c.id === where.id);
        return match
          ? { id: match.id, name: match.name, domain: match.domain, status: 'NEW', attributes: {} }
          : null;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async (args: { where?: { id?: { in?: string[] } } }) => {
        const ids = args?.where?.id?.in;
        return ids ? (state.companies ?? []).filter((c) => ids.includes(c.id as string)) : state.companies ?? [];
      }),
    },
    icpDefinition: {
      findFirst: vi.fn(async () => state.icp ?? { companyAttributes: {}, targetMarkets: [] }),
    },
    sanctionsScreeningResult: { findUnique: vi.fn(async () => state.screening ?? null) },
    sanctionsSource: { findMany: vi.fn(async () => state.sanctionsSources ?? []) },
    hardGateResult: {
      createMany: insertMany(
        gateResults,
        resultKeys,
        (row) =>
          `${String(row.workspaceId)}|${String(row.canonicalCompanyId)}|${String(row.icpId ?? '')}|${String(row.gateId)}|${String(row.inputDigest)}`,
      ),
    },
    gateEnrichmentTask: {
      createMany: insertMany(
        enrichmentTasks,
        taskKeys,
        (row) =>
          `${String(row.workspaceId)}|${String(row.canonicalCompanyId)}|${String(row.icpId ?? '')}|${String(row.gateId)}`,
      ),
    },
    outboxEvent: {
      findMany: vi.fn(async () => outboxEvents.map((payload) => ({ payload }))),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        outboxEvents.push(args.data.payload as Record<string, unknown>);
        return args.data;
      }),
    },
    discoveryCompanyJob: {
      upsert: vi.fn(async (args: { where: unknown; create: Record<string, unknown> }) => {
        jobUpserts.push(args);
        return {};
      }),
      findMany: vi.fn(async () => state.jobs ?? []),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        jobUpdates.push(args);
        return {};
      }),
    },
    $queryRaw: vi.fn(async () => []),
    runEvent: {
      aggregate: vi.fn(async () => ({ _max: { seq: seq === 0n ? null : seq } })),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        seq += 1n;
        events.push(args.data);
        return args.data;
      }),
    },
    lead: {
      upsert: vi.fn(async (args: Record<string, unknown>) => {
        leadUpserts.push(args);
        return {};
      }),
      findMany: vi.fn(async () => state.leads ?? []),
    },
    discoveryRun: {
      findUnique: vi.fn(async () => state.run ?? { phases: null, createdAt: new Date(Date.now() - 5 * 60_000) }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        phaseUpdates.push(data);
        return {};
      }),
    },
    runShadowDiff: {
      upsert: vi.fn(async (args: Record<string, unknown>) => {
        shadowUpserts.push(args);
        return {};
      }),
    },
    // companyMayUseExternalProcessing reads suppression records + company status.
    canonicalContact: { findUnique: vi.fn(async () => null) },
    suppressionRecord: { findMany: vi.fn(async () => state.suppressions ?? []) },
    suppressionDecision: { findFirst: vi.fn(async () => null) },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_workspaceId: string, callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  return {
    prisma,
    tx,
    jobUpserts,
    jobUpdates,
    events,
    leadUpserts,
    phaseUpdates,
    shadowUpserts,
    gateResults,
    enrichmentTasks,
    outboxEvents,
  };
}

function makeActivities(
  state: Parameters<typeof makePrisma>[0],
  skills?: import('../skills/skill-runtime').SkillResolver,
  agentRuntime?: import('../agents/agent-round').AgentRoundRuntime,
  extraDeps?: { domainStatusFor?: (companyId: string) => Promise<'ALIVE' | 'DEAD' | 'UNKNOWN' | null> },
) {
  const harness = makePrisma(state);
  const activities = createRun2Activities({
    prisma: harness.prisma as never,
    gateway: {} as never,
    budgetStore: { attestAuthorized: vi.fn(async () => undefined) } as never,
    ...(skills ? { skills } : {}),
    ...(agentRuntime ? { agentRuntime } : {}),
    ...(extraDeps?.domainStatusFor ? { domainStatusFor: extraDeps.domainStatusFor } : {}),
  });
  return { activities, ...harness };
}

function activeQualifier() {
  return {
    resolve: vi.fn(async () => ({
      agentKey: 'discovery.qualifier',
      name: '资格判定员',
      rolePromptVersion: 'v1',
      skillKeys: ['discovery.qualify_fit'],
      modelPolicy: {},
      memoryScope: 'run',
      loopPolicy: { maxRounds: 1 },
    })),
  };
}

beforeEach(() => {
  mocks.execute.mockReset();
  mocks.judgeFitCompany.mockReset();
  mocks.loadIcpBrief.mockResolvedValue({ icp_name: 'DE pump distributors' });
  activityRuntime.context = null;
  activityRuntime.heartbeat.mockReset();
  vi.unstubAllEnvs();
  resetSanctionsStaleAlertDedupeForTests();
});

describe('M0③ prefilterPool', () => {
  it('writes queued jobs for candidates and prefiltered_out jobs for rule rejects', async () => {
    const { activities, jobUpserts, events } = makeActivities({
      rules: [{ id: 'r1', kind: 'EXCLUSION', field: 'country', operator: 'in', value: ['CN'], weight: 1 }],
      companies: [company('c-de'), company('c-cn', { country: 'CN' })],
    });

    await expect(activities.prefilterPool(ARGS)).resolves.toEqual({
      poolSize: 2,
      candidates: 1,
      prefilteredOut: 1,
    });
    const stages = jobUpserts.map((upsert) => upsert.create.stage);
    expect(stages.sort()).toEqual(['prefiltered_out', 'queued']);
    expect(events.some((event) => event.type === 'phase_started')).toBe(true);
    expect(
      events.some((event) => event.type === 'company_done' && (event.payload as { stage?: string }).stage === 'prefiltered_out'),
    ).toBe(true);
  });
});

describe('M0③ quickJudgeBatch', () => {
  it('judges a batch in one call and writes each verdict onto its job', async () => {
    const jobs = [
      { id: 'j1', canonicalCompanyId: 'c1' },
      { id: 'j2', canonicalCompanyId: 'c2' },
      { id: 'j3', canonicalCompanyId: 'c3' },
    ];
    const { activities, jobUpdates, events } = makeActivities({
      jobs,
      companies: [company('c1'), company('c2'), company('c3')],
    });
    mocks.execute.mockResolvedValue({
      data: {
        judgments: [
          { index: 0, verdict: 'match', reason: 'distributor' },
          { index: 1, verdict: 'mismatch', reason: 'competitor' },
          { index: 2, verdict: 'weak', reason: 'unclear' },
        ],
      },
      durableReceipt: undefined,
    });

    const result = await activities.quickJudgeBatch(ARGS);

    expect(mocks.execute).toHaveBeenCalledTimes(1);
    // P3 W5：批量路径使用独立的 L1 契约 discovery.quick_judge（flash 档），不再借用
    // L2 深判 discovery.qualify_fit。
    const batchInput = mocks.execute.mock.calls[0]![1] as { task: string; model: string };
    expect(batchInput.task).toBe('discovery.quick_judge');
    expect(batchInput.model).toBe(getTask('discovery.quick_judge')!.model);
    expect(mocks.judgeFitCompany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ judged: 3, verdicts: { match: 1, mismatch: 1, weak: 1 }, fallbackPerCompany: 0, ruleFallback: 0 });
    const verdictByJob = new Map(jobUpdates.map((u) => [u.where.id, u.data.verdictQuick]));
    expect(verdictByJob.get('j1')).toBe('match');
    expect(verdictByJob.get('j2')).toBe('mismatch');
    expect(verdictByJob.get('j3')).toBe('weak');
    expect(events.filter((e) => e.type === 'company_done')).toHaveLength(3);
  });

  it('resolves the batch call through the discovery.quick_judge skill key', async () => {
    const inner = new StaticSkillResolver();
    const resolver = {
      kind: 'static' as const,
      resolve: vi.fn(inner.resolve.bind(inner)),
    };
    const { activities } = makeActivities(
      {
        jobs: [
          { id: 'j1', canonicalCompanyId: 'c1' },
          { id: 'j2', canonicalCompanyId: 'c2' },
        ],
        companies: [company('c1'), company('c2')],
      },
      resolver,
    );
    mocks.execute.mockResolvedValue({
      data: {
        judgments: [
          { index: 0, verdict: 'match', reason: 'distributor' },
          { index: 1, verdict: 'weak', reason: 'unclear' },
        ],
      },
    });

    await activities.quickJudgeBatch(ARGS);

    expect(resolver.resolve).toHaveBeenCalledWith(
      'discovery.quick_judge',
      WORKSPACE_ID,
      expect.objectContaining({ effectiveModel: getTask('discovery.quick_judge')!.model }),
    );
  });

  it('degrades to per-company judgment when the batch output cannot be parsed', async () => {
    const { activities, jobUpdates } = makeActivities({
      jobs: [
        { id: 'j1', canonicalCompanyId: 'c1' },
        { id: 'j2', canonicalCompanyId: 'c2' },
      ],
      companies: [company('c1'), company('c2')],
    });
    mocks.execute.mockResolvedValue({ data: { nonsense: true } });
    mocks.judgeFitCompany.mockResolvedValue({ verdict: 'match' });

    const result = await activities.quickJudgeBatch(ARGS);

    expect(mocks.judgeFitCompany).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ judged: 2, fallbackPerCompany: 2, verdicts: { match: 2 } });
    expect(jobUpdates.every((u) => u.data.stage === 'quick_judged')).toBe(true);
  });

  it('refuses to degrade when the qualify_fit skill is disabled (kill switch)', async () => {
    const { SkillUnavailableError } = await import('../skills/skill-runtime');
    const disabledSkill = {
      kind: 'db' as const,
      resolve: vi.fn(async () => {
        throw new SkillUnavailableError('SKILL_PLATFORM_DISABLED', 'ops kill switch');
      }),
    };
    const { activities } = makeActivities(
      {
        jobs: [
          { id: 'j1', canonicalCompanyId: 'c1' },
          { id: 'j2', canonicalCompanyId: 'c2' },
        ],
        companies: [company('c1'), company('c2')],
      },
      disabledSkill,
    );

    await expect(activities.quickJudgeBatch(ARGS)).rejects.toBeInstanceOf(SkillUnavailableError);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.judgeFitCompany).not.toHaveBeenCalled();
  });

  it('falls back to a weak rule verdict when the model is unavailable for a company (Q20)', async () => {
    const { activities, jobUpdates, events } = makeActivities({
      jobs: [
        { id: 'j1', canonicalCompanyId: 'c1' },
        { id: 'j2', canonicalCompanyId: 'c2' },
      ],
      companies: [company('c1'), company('c2')],
    });
    mocks.execute.mockRejectedValue(new Error('model upstream down'));
    mocks.judgeFitCompany.mockResolvedValue(null);

    const result = await activities.quickJudgeBatch(ARGS);

    expect(result).toMatchObject({ judged: 2, ruleFallback: 2, verdicts: { weak: 2 } });
    expect(jobUpdates.every((u) => u.data.verdictQuick === 'weak')).toBe(true);
    // P3 J02 W4：规则兜底不是 failed，但批量失败的分类码要随事件可追溯（不再是聚合码）。
    const doneEvents = events.filter((event) => event.type === 'company_done');
    expect(doneEvents).toHaveLength(2);
    for (const event of doneEvents) {
      expect((event.payload as Record<string, unknown>).failureCode).toBe('UNKNOWN_UPSTREAM');
      expect((event.payload as Record<string, unknown>).failureStage).toBe('provider');
    }
  });

  it('classifies per-company judge failures instead of the QUICK_JUDGE_FAILED aggregate (P3 J02 W4)', async () => {
    const { activities, events } = makeActivities({
      jobs: [
        { id: 'j1', canonicalCompanyId: 'c1' },
        { id: 'j2', canonicalCompanyId: 'c2' },
      ],
      companies: [company('c1'), company('c2')],
    });
    // 批量协议与逐家降级都撞 429（HTTP 错误不会被 fit-judge 吞掉）→ 逐家失败码应是 PROVIDER_HTTP_429。
    mocks.execute.mockRejectedValue(
      new ProviderHttpError({ status: 429, provider: 'p', model: 'm' }),
    );
    mocks.judgeFitCompany.mockRejectedValue(
      new ProviderHttpError({ status: 429, provider: 'p', model: 'm' }),
    );

    const result = await activities.quickJudgeBatch(ARGS);

    expect(result).toMatchObject({ judged: 2, ruleFallback: 2, verdicts: { weak: 2 } });
    const doneEvents = events.filter((event) => event.type === 'company_done');
    expect(doneEvents).toHaveLength(2);
    for (const event of doneEvents) {
      expect((event.payload as Record<string, unknown>).failureCode).toBe('PROVIDER_HTTP_429');
      expect((event.payload as Record<string, unknown>).failureStage).toBe('provider');
    }
    for (const event of events) {
      expect(JSON.stringify(event.payload ?? {})).not.toContain('QUICK_JUDGE_FAILED');
    }
  });

  it('heartbeats after every batch (P3 J02 W4)', async () => {
    activityRuntime.context = {
      heartbeat: activityRuntime.heartbeat,
      cancellationSignal: { aborted: false },
    };
    const { activities } = makeActivities({
      jobs: [
        { id: 'j1', canonicalCompanyId: 'c1' },
        { id: 'j2', canonicalCompanyId: 'c2' },
      ],
      companies: [company('c1'), company('c2')],
    });
    mocks.execute.mockResolvedValue({
      data: {
        judgments: [
          { index: 0, verdict: 'match', reason: 'distributor' },
          { index: 1, verdict: 'weak', reason: 'unclear' },
        ],
      },
    });

    await activities.quickJudgeBatch(ARGS);

    // 活动开始 1 次 + 每批后 1 次（2 家 = 1 批）
    expect(activityRuntime.heartbeat).toHaveBeenCalledTimes(2);
    expect(activityRuntime.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'quick_judge', batches: 1, judged: 2 }),
    );
  });

  it('stops between batches when the activity was cancelled (P3 J02 W4)', async () => {
    activityRuntime.context = {
      heartbeat: activityRuntime.heartbeat,
      cancellationSignal: { aborted: true },
    };
    const { activities, jobUpdates } = makeActivities({
      jobs: [{ id: 'j1', canonicalCompanyId: 'c1' }],
      companies: [company('c1')],
    });

    await expect(activities.quickJudgeBatch(ARGS)).rejects.toBeInstanceOf(CancelledFailure);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(jobUpdates).toHaveLength(0);
  });
});

/**
 * P3 J08（W9 域名门 / 补数队列）与 P3 J07（W8 L0 门链接线与陈旧告警）。
 * 零容器：假事务模拟两张门表的表达式唯一索引（同键第二次写入被跳过）。
 */
describe('P3 J08 快扫 G5 域名门与补数队列', () => {
  it('无域名公司写 gate_enrichment_task(queued) 且不进模型批量', async () => {
    const { activities, jobUpdates, enrichmentTasks, events } = makeActivities({
      jobs: [
        { id: 'j1', canonicalCompanyId: 'c1' },
        { id: 'j2', canonicalCompanyId: 'c2' },
        { id: 'j3', canonicalCompanyId: 'c3' },
      ],
      companies: [company('c1'), company('c2', { domain: null }), company('c3')],
    });
    mocks.execute.mockResolvedValue({
      data: {
        judgments: [
          { index: 0, verdict: 'match', reason: 'distributor' },
          { index: 1, verdict: 'weak', reason: 'unclear' },
        ],
      },
    });

    const result = await activities.quickJudgeBatch(ARGS);

    expect(result).toMatchObject({ judged: 2, gated: 1 });
    // 补数任务：G5 UNKNOWN（无域名）进队列，状态 queued。
    expect(enrichmentTasks).toHaveLength(1);
    expect(enrichmentTasks[0]).toMatchObject({
      canonicalCompanyId: 'c2',
      gateId: 'G_DOMAIN',
      reasonCode: 'GATE_DOMAIN_MISSING',
      status: 'queued',
    });
    // 不进模型批量：模型输入里没有这家公司。
    const prompt = (mocks.execute.mock.calls[0]![1] as { prompt: string }).prompt;
    expect(prompt).not.toContain('Company c2');
    expect(mocks.judgeFitCompany).not.toHaveBeenCalled();
    // job 停在 skipped 并留下拦截原因；company_done 事件标明 gate_blocked。
    expect(jobUpdates.find((update) => update.where.id === 'j2')?.data).toMatchObject({
      stage: 'skipped',
      lastErrorCode: 'GATE_DOMAIN_MISSING',
    });
    const gateEvent = events.find(
      (event) => (event.payload as Record<string, unknown>).stage === 'gate_blocked',
    );
    expect(gateEvent?.payload).toMatchObject({
      companyId: 'c2',
      gateId: 'G_DOMAIN',
      reasonCode: 'GATE_DOMAIN_MISSING',
      verdict: 'UNKNOWN',
    });
  });

  it('DEAD 域名同样进补数队列（P2 域名存活结果的接入缝）', async () => {
    const { activities, enrichmentTasks, jobUpdates } = makeActivities(
      {
        jobs: [
          { id: 'j1', canonicalCompanyId: 'c1' },
          { id: 'j2', canonicalCompanyId: 'c2' },
        ],
        companies: [company('c1'), company('c2')],
      },
      undefined,
      undefined,
      {
        domainStatusFor: async (companyId) =>
          companyId === 'c1' ? 'DEAD' : null,
      },
    );
    mocks.judgeFitCompany.mockResolvedValue({ verdict: 'weak' });

    const result = await activities.quickJudgeBatch(ARGS);

    expect(result).toMatchObject({ judged: 1, gated: 1 });
    expect(enrichmentTasks).toHaveLength(1);
    expect(enrichmentTasks[0]).toMatchObject({
      canonicalCompanyId: 'c1',
      gateId: 'G_DOMAIN',
      reasonCode: 'GATE_DOMAIN_DEAD',
    });
    expect(jobUpdates.find((update) => update.where.id === 'j1')?.data).toMatchObject({
      stage: 'skipped',
      lastErrorCode: 'GATE_DOMAIN_DEAD',
    });
  });

  it('allow_domainless=true 的 ICP：无域名照常判（NOT_APPLICABLE）', async () => {
    const { activities, enrichmentTasks } = makeActivities({
      jobs: [
        { id: 'j1', canonicalCompanyId: 'c1' },
        { id: 'j2', canonicalCompanyId: 'c2' },
      ],
      companies: [company('c1'), company('c2', { domain: null })],
      icp: { companyAttributes: { allow_domainless: true }, targetMarkets: [] },
    });
    mocks.execute.mockResolvedValue({
      data: {
        judgments: [
          { index: 0, verdict: 'match', reason: 'distributor' },
          { index: 1, verdict: 'weak', reason: 'unclear' },
        ],
      },
    });

    const result = await activities.quickJudgeBatch(ARGS);

    expect(result).toMatchObject({ judged: 2, gated: 0 });
    expect(enrichmentTasks).toHaveLength(0);
    expect((mocks.execute.mock.calls[0]![1] as { prompt: string }).prompt).toContain('Company c2');
  });

  it('replay 幂等：同一 (company, icp, gate) 重跑不重复建补数任务', async () => {
    const state = {
      jobs: [{ id: 'j1', canonicalCompanyId: 'c1' }],
      companies: [company('c1', { domain: null })],
    };
    const { activities, enrichmentTasks } = makeActivities(state);

    await activities.quickJudgeBatch(ARGS);
    await activities.quickJudgeBatch(ARGS);

    expect(enrichmentTasks).toHaveLength(1);
  });
});

describe('P3 J07 L0 门链与制裁陈旧告警（快扫）', () => {
  const sanctionsSources = (lastRefreshedAt: Date, lastFetchStatus: string) => [
    { key: 'eu_fsf', lastRefreshedAt, lastFetchStatus },
  ];

  it('shadow：G1 命中只记录不拦截（模型照常判，门结果落库）', async () => {
    vi.stubEnv('JUDGE_CONTRACT_MODE', 'shadow');
    const { activities, gateResults, jobUpdates } = makeActivities({
      jobs: [
        { id: 'j1', canonicalCompanyId: 'c1' },
        { id: 'j2', canonicalCompanyId: 'c2' },
      ],
      companies: [company('c1'), company('c2')],
      screening: { status: 'potential_match', reviewState: 'open', listVersions: {} },
    });
    mocks.execute.mockResolvedValue({
      data: {
        judgments: [
          { index: 0, verdict: 'mismatch', reason: 'competitor' },
          { index: 1, verdict: 'weak', reason: 'unclear' },
        ],
      },
    });

    const result = await activities.quickJudgeBatch(ARGS);

    expect(result).toMatchObject({ judged: 2, gated: 0 });
    // shadow 的 L0 结果只记录：G_SANCTIONS FAIL 行在 hard_gate_result 里可查。
    expect(
      gateResults.some(
        (row) => row.gateId === 'G_SANCTIONS' && row.verdict === 'FAIL' && row.reasonCode === 'GATE_SANCTIONS_HIT',
      ),
    ).toBe(true);
    expect(jobUpdates.every((update) => update.data.stage === 'quick_judged')).toBe(true);
  });

  it('enforce：G1 命中在模型调用前拦截（不送 LLM）', async () => {
    vi.stubEnv('JUDGE_CONTRACT_MODE', 'enforce');
    const { activities, jobUpdates, gateResults } = makeActivities({
      jobs: [
        { id: 'j1', canonicalCompanyId: 'c1' },
        { id: 'j2', canonicalCompanyId: 'c2' },
      ],
      companies: [company('c1'), company('c2')],
      screening: { status: 'potential_match', reviewState: 'open', listVersions: {} },
    });

    const result = await activities.quickJudgeBatch(ARGS);

    expect(result).toMatchObject({ judged: 0, gated: 2 });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.judgeFitCompany).not.toHaveBeenCalled();
    expect(
      gateResults.some(
        (row) => row.gateId === 'G_SANCTIONS' && row.verdict === 'FAIL',
      ),
    ).toBe(true);
    for (const update of jobUpdates) {
      expect(update.data).toMatchObject({ stage: 'skipped', lastErrorCode: 'GATE_SANCTIONS_HIT' });
    }
  });

  it('yellow/red 不拦截：结果带 stale 标记，告警同源同状态只发一次', async () => {
    const { activities, events, outboxEvents } = makeActivities({
      jobs: [
        { id: 'j1', canonicalCompanyId: 'c1' },
        { id: 'j2', canonicalCompanyId: 'c2' },
      ],
      companies: [company('c1'), company('c2')],
      screening: { status: 'clear', reviewState: 'open', listVersions: {} },
      // 24h 前刷新成功但最新一次 FAILED → yellow（>72h 或从未刷新才进 red）。
      sanctionsSources: sanctionsSources(new Date(Date.now() - 24 * 3_600_000), 'FAILED'),
    });
    mocks.execute.mockResolvedValue({
      data: {
        judgments: [
          { index: 0, verdict: 'match', reason: 'distributor' },
          { index: 1, verdict: 'weak', reason: 'unclear' },
        ],
      },
    });

    const result = await activities.quickJudgeBatch(ARGS);

    // stale 是 PASS 的降级标记：不判 NOT_FIT、不拦截。
    expect(result).toMatchObject({ judged: 2, gated: 0, verdicts: { match: 1, weak: 1 } });
    for (const event of events.filter((entry) => entry.type === 'company_done')) {
      expect((event.payload as Record<string, unknown>).sanctionsStale).toBe('yellow');
    }
    // 两家公司共享同一（状态×源集合）去重键：只发一条 SANCTIONS_LIST_STALE 事件。
    expect(outboxEvents).toHaveLength(1);
    expect(outboxEvents[0]).toMatchObject({
      code: 'SANCTIONS_LIST_STALE',
      freshness: 'yellow',
      reason: 'stale',
      failedSourceKeys: ['eu_fsf'],
      thresholds: { freshMaxHours: 72, yellowMaxHours: 168 },
    });
  });
});

describe('M0③ materializeProvisionalLeads', () => {
  it('upserts provisional leads for match/weak verdicts only, idempotently', async () => {
    const { activities, leadUpserts } = makeActivities({
      jobs: [
        { canonicalCompanyId: 'c1', verdictQuick: 'match' },
        { canonicalCompanyId: 'c2', verdictQuick: 'weak' },
        { canonicalCompanyId: 'c3', verdictQuick: 'mismatch' },
      ],
    });

    await expect(activities.materializeProvisionalLeads(ARGS)).resolves.toEqual({ leads: 2 });
    expect(leadUpserts).toHaveLength(2);
    for (const upsert of leadUpserts) {
      expect(upsert.create).toMatchObject({
        workspaceId: WORKSPACE_ID,
        icpId: ICP_ID,
        queue: 'needs_review',
        fitReasons: { source: 'quick_scan', tier: 'quick' },
      });
    }
  });
});

describe('M0⑥ finalize V2 辅助（阶段时间/告警/影子对比）', () => {
  it('merges a phase timestamp into discovery_run.phases without dropping earlier phases', async () => {
    const { activities, phaseUpdates } = makeActivities({
      run: { phases: { quickStartedAt: '2026-11-04T04:00:00.000Z' }, createdAt: new Date() },
    });
    await activities.markRunPhase({ workspaceId: WORKSPACE_ID, runId: RUN_ID, phase: 'quick_done' });
    const phases = phaseUpdates[0]!.phases as Record<string, unknown>;
    expect(phases.quickStartedAt).toBe('2026-11-04T04:00:00.000Z');
    expect(typeof phases.quickDoneAt).toBe('string');
  });

  it('reports the elapsed minutes of a run for the duration alert', async () => {
    const { activities } = makeActivities({
      run: { phases: null, createdAt: new Date(Date.now() - 42 * 60_000) },
    });
    const elapsed = await activities.runElapsedMinutes({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
    expect(elapsed.minutes).toBeGreaterThanOrEqual(41);
  });

  it('compares legacy fit verdicts with shadow quick verdicts and records recall/agreement', async () => {
    const { activities, shadowUpserts } = makeActivities({
      leads: [
        { canonicalCompanyId: 'c1', fitVerdict: 'match', fitReasons: { material: 'x' } },
        { canonicalCompanyId: 'c2', fitVerdict: 'weak', fitReasons: { material: 'x' } },
        { canonicalCompanyId: 'c3', fitVerdict: 'mismatch', fitReasons: { material: 'x' } },
        { canonicalCompanyId: 'c9', fitVerdict: 'match', fitReasons: { source: 'quick_scan' } },
      ],
      jobs: [
        { canonicalCompanyId: 'c1', verdictQuick: 'match' },
        { canonicalCompanyId: 'c2', verdictQuick: 'weak' },
        { canonicalCompanyId: 'c3', verdictQuick: 'weak' },
        { canonicalCompanyId: 'c4', verdictQuick: 'match' },
      ],
    });

    const diff = await activities.recordRunShadowDiff({
      ...ARGS,
      shadowFallback: 1,
    });
    expect(diff).toEqual({
      legacyJudged: 3,
      legacyPositive: 2,
      shadowJudged: 4,
      shadowPositive: 4,
      agreement: 2,
      compared: 3,
      shadowFallback: 1,
      recallNotLower: true,
    });
    expect(shadowUpserts).toHaveLength(1);
    expect(shadowUpserts[0]).toMatchObject({
      where: { runId: RUN_ID },
      create: expect.objectContaining({ workspaceId: WORKSPACE_ID, runId: RUN_ID, shadowPositive: 4 }),
    });
  });

  it('judges recall within the compared companies, not on unequal pool totals', async () => {
    // 2026-11-04 影子验收第二轮实况：老路径判 66 家（正面 27），快扫只判 27 家（正面 6，
    // 其中与老路径重叠的 27 家里正面 4 家）。按两侧总数比 6<27 会误报「召回下降」；
    // 同集合口径 6>=4 才是正确结论。
    const { activities } = makeActivities({
      leads: [
        { canonicalCompanyId: 'c1', fitVerdict: 'match', fitReasons: { material: 'x' } },
        { canonicalCompanyId: 'c2', fitVerdict: 'weak', fitReasons: { material: 'x' } },
        { canonicalCompanyId: 'c3', fitVerdict: 'mismatch', fitReasons: { material: 'x' } },
        { canonicalCompanyId: 'c4', fitVerdict: 'match', fitReasons: { material: 'x' } },
        { canonicalCompanyId: 'c5', fitVerdict: 'mismatch', fitReasons: { material: 'x' } },
        // The legacy path judges the whole canonicalized pool; these positives lie
        // outside the prefiltered set the shadow quick pass ever saw.
        { canonicalCompanyId: 'x1', fitVerdict: 'match', fitReasons: { material: 'x' } },
        { canonicalCompanyId: 'x2', fitVerdict: 'match', fitReasons: { material: 'x' } },
        { canonicalCompanyId: 'x3', fitVerdict: 'match', fitReasons: { material: 'x' } },
        { canonicalCompanyId: 'x4', fitVerdict: 'match', fitReasons: { material: 'x' } },
      ],
      jobs: [
        { canonicalCompanyId: 'c1', verdictQuick: 'match' },
        { canonicalCompanyId: 'c2', verdictQuick: 'weak' },
        { canonicalCompanyId: 'c3', verdictQuick: 'weak' },
        { canonicalCompanyId: 'c4', verdictQuick: 'match' },
        { canonicalCompanyId: 'c5', verdictQuick: 'mismatch' },
      ],
    });

    const diff = await activities.recordRunShadowDiff({
      ...ARGS,
      shadowFallback: 0,
    });
    // Aggregates stay as recorded (they describe each path's reach)…
    expect(diff.legacyJudged).toBe(9);
    expect(diff.legacyPositive).toBe(7);
    expect(diff.shadowJudged).toBe(5);
    expect(diff.shadowPositive).toBe(4);
    expect(diff.compared).toBe(5);
    // …but recall is judged on the same-company set: legacy 3 positive vs shadow 4
    // (aggregate 4 < 7 would have reported a false recall drop).
    expect(diff.recallNotLower).toBe(true);
  });
});

describe('M2 步 9b 资格判定员角色化：fit.judge 轨迹 + agent 回合门（零行为变化）', () => {
  it('records one fit.judge trace per batch with verdicts and rejected mismatch candidates', async () => {
    const traces = { record: vi.fn(async () => undefined) };
    const { activities } = makeActivities(
      {
        jobs: [
          { id: 'j1', canonicalCompanyId: 'c1' },
          { id: 'j2', canonicalCompanyId: 'c2' },
          { id: 'j3', canonicalCompanyId: 'c3' },
        ],
        companies: [company('c1'), company('c2'), company('c3')],
      },
      undefined,
      { agents: activeQualifier(), traces },
    );
    mocks.execute.mockResolvedValue({
      data: {
        judgments: [
          { index: 0, verdict: 'match', reason: 'distributor' },
          { index: 1, verdict: 'mismatch', reason: 'competitor' },
          { index: 2, verdict: 'weak', reason: 'unclear' },
        ],
      },
    });

    await activities.quickJudgeBatch(ARGS);

    expect(traces.record).toHaveBeenCalledTimes(1);
    const trace = traces.record.mock.calls[0]![0] as {
      decisionType: string;
      stepType: string;
      agentKey: string;
      discriminator: string;
      chosenOption: { batchSize: number; judged: number; verdicts: Record<string, number> };
      rejectedCandidates: Array<{ candidateRef: string; rejectReason: string; revivable: boolean }>;
    };
    expect(trace).toMatchObject({
      decisionType: 'fit.judge',
      stepType: 'discovery.quick_scan',
      agentKey: 'discovery.qualifier',
    });
    expect(trace.discriminator.startsWith('batch:')).toBe(true);
    expect(trace.chosenOption).toMatchObject({
      batchSize: 3,
      judged: 3,
      verdicts: { match: 1, mismatch: 1, weak: 1 },
    });
    expect(trace.rejectedCandidates).toEqual([
      { candidateRef: 'c2', rejectReason: 'VERDICT_MISMATCH', revivable: true },
    ]);
  });

  it('fails closed with nonRetryable AGENT_DISABLED before any model call', async () => {
    const { AgentUnavailableError } = await import('../agents/agent-runtime');
    const traces = { record: vi.fn(async () => undefined) };
    const { activities } = makeActivities(
      {
        jobs: [{ id: 'j1', canonicalCompanyId: 'c1' }],
        companies: [company('c1')],
      },
      undefined,
      {
        agents: {
          resolve: vi.fn(async () => {
            throw new AgentUnavailableError('AGENT_DISABLED', 'ops kill switch');
          }),
        },
        traces,
      },
    );

    await expect(activities.quickJudgeBatch(ARGS)).rejects.toMatchObject({
      type: 'AGENT_DISABLED',
      nonRetryable: true,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.judgeFitCompany).not.toHaveBeenCalled();
    expect(traces.record).not.toHaveBeenCalled();
  });

  // 设计 §8 负向 3：技能被平台停用 → 回合 fail-closed 且轨迹落 SKILL_PLATFORM_DISABLED。
  it('records SKILL_PLATFORM_DISABLED on the trace and rethrows when the skill is disabled', async () => {
    const { SkillUnavailableError } = await import('../skills/skill-runtime');
    const disabledSkill = {
      kind: 'db' as const,
      resolve: vi.fn(async () => {
        throw new SkillUnavailableError('SKILL_PLATFORM_DISABLED', 'ops kill switch');
      }),
    };
    const traces = { record: vi.fn(async () => undefined) };
    const { activities } = makeActivities(
      {
        jobs: [{ id: 'j1', canonicalCompanyId: 'c1' }],
        companies: [company('c1')],
      },
      disabledSkill,
      { agents: activeQualifier(), traces },
    );

    await expect(activities.quickJudgeBatch(ARGS)).rejects.toBeInstanceOf(SkillUnavailableError);
    expect(traces.record).toHaveBeenCalledTimes(1);
    expect(traces.record.mock.calls[0]![0]).toMatchObject({
      decisionType: 'fit.judge',
      agentKey: 'discovery.qualifier',
      discriminator: 'skill-gate',
      reasonCode: 'SKILL_PLATFORM_DISABLED',
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe('ch08 §3.1.5 quickJudge 批量 wire-time 出网闸门', () => {
  it('revalidates every company at wire time; a suppression landing after prefilter downgrades to per-company and skips the denied one', async () => {
    const state = {
      jobs: [
        { id: 'j1', canonicalCompanyId: 'c1' },
        { id: 'j2', canonicalCompanyId: 'c2' },
      ],
      companies: [company('c1'), company('c2')],
      suppressions: [] as Array<{ type: string; value: string }>,
    };
    const { activities, jobUpdates } = makeActivities(state);

    mocks.execute.mockImplementation(
      async (
        _gateway: unknown,
        _input: unknown,
        context: { authorizeExternalAction?: () => Promise<boolean> },
      ) => {
        // 预检通过之后、物理 wire 之前新增一条域名禁联（TOCTOU 窗口）。
        state.suppressions.push({ type: 'domain', value: 'c1.example' });
        const allowed = await context.authorizeExternalAction!();
        if (!allowed) throw new ExternalActionDeniedError();
        return {
          data: {
            judgments: [
              { index: 0, verdict: 'match', reason: 'distributor' },
              { index: 1, verdict: 'weak', reason: 'unclear' },
            ],
          },
        };
      },
    );
    mocks.judgeFitCompany.mockImplementation(
      async (
        _gateway: unknown,
        _workspaceId: unknown,
        _brief: unknown,
        _company: unknown,
        opts: { authorizeExternalAction?: () => Promise<boolean> },
      ) => {
        if (!(await opts.authorizeExternalAction!())) throw new ExternalActionDeniedError();
        return { verdict: 'match' };
      },
    );

    const result = await activities.quickJudgeBatch(ARGS);

    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      judged: 1,
      skipped: 1,
      verdicts: { match: 1 },
      // 批量 wire 被拒后整批降级逐家：放行的 c2 走 single 路径。
      fallbackPerCompany: 1,
      ruleFallback: 0,
    });
    const byJob = new Map(jobUpdates.map((u) => [u.where.id, u.data]));
    expect(byJob.get('j1')!.stage).toBe('skipped');
    expect(byJob.get('j2')!.stage).toBe('quick_judged');
    expect(byJob.get('j2')!.verdictQuick).toBe('match');
  });

  it('batch authorizeExternalAction consults the suppression gate instead of a constant true', async () => {
    const state = {
      jobs: [
        { id: 'j1', canonicalCompanyId: 'c1' },
        { id: 'j2', canonicalCompanyId: 'c2' },
      ],
      companies: [company('c1'), company('c2')],
      suppressions: [] as Array<{ type: string; value: string }>,
    };
    const { activities } = makeActivities(state);

    let first: boolean | undefined;
    let second: boolean | undefined;
    mocks.execute.mockImplementation(
      async (
        _gateway: unknown,
        _input: unknown,
        context: { authorizeExternalAction?: () => Promise<boolean> },
      ) => {
        first = await context.authorizeExternalAction!();
        // wire 之前 c2 被禁联：下一次回调必须返回 false（不是恒 true）。
        state.suppressions.push({ type: 'domain', value: 'c2.example' });
        second = await context.authorizeExternalAction!();
        throw new ExternalActionDeniedError();
      },
    );
    mocks.judgeFitCompany.mockResolvedValue({ verdict: 'weak' });

    await activities.quickJudgeBatch(ARGS);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});
