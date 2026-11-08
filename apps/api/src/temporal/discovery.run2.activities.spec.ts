import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  judgeFitCompany: vi.fn(),
  loadIcpBrief: vi.fn(async () => ({ icp_name: 'DE pump distributors' })),
}));

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
import { ExternalActionDeniedError } from '../model-gateway/providers/provider-output-error';

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
}) {
  const jobUpserts: Array<{ where: unknown; create: Record<string, unknown> }> = [];
  const jobUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const events: Array<Record<string, unknown>> = [];
  const leadUpserts: Array<Record<string, unknown>> = [];
  const phaseUpdates: Array<Record<string, unknown>> = [];
  const shadowUpserts: Array<Record<string, unknown>> = [];
  let seq = 0n;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    qualificationRule: { findMany: vi.fn(async () => state.rules ?? []) },
    canonicalCompany: {
      count: vi.fn(async () => (state.companies ?? []).length),
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
  return { prisma, tx, jobUpserts, jobUpdates, events, leadUpserts, phaseUpdates, shadowUpserts };
}

function makeActivities(
  state: Parameters<typeof makePrisma>[0],
  skills?: import('../skills/skill-runtime').SkillResolver,
  agentRuntime?: import('../agents/agent-round').AgentRoundRuntime,
) {
  const harness = makePrisma(state);
  const activities = createRun2Activities({
    prisma: harness.prisma as never,
    gateway: {} as never,
    budgetStore: { attestAuthorized: vi.fn(async () => undefined) } as never,
    ...(skills ? { skills } : {}),
    ...(agentRuntime ? { agentRuntime } : {}),
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
    expect(mocks.judgeFitCompany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ judged: 3, verdicts: { match: 1, mismatch: 1, weak: 1 }, fallbackPerCompany: 0, ruleFallback: 0 });
    const verdictByJob = new Map(jobUpdates.map((u) => [u.where.id, u.data.verdictQuick]));
    expect(verdictByJob.get('j1')).toBe('match');
    expect(verdictByJob.get('j2')).toBe('mismatch');
    expect(verdictByJob.get('j3')).toBe('weak');
    expect(events.filter((e) => e.type === 'company_done')).toHaveLength(3);
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
    const { activities, jobUpdates } = makeActivities({
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
        _skills: unknown,
        _gateway: unknown,
        _key: unknown,
        _input: unknown,
        opts: { authorizeExternalAction?: () => Promise<boolean> },
      ) => {
        // 预检通过之后、物理 wire 之前新增一条域名禁联（TOCTOU 窗口）。
        state.suppressions.push({ type: 'domain', value: 'c1.example' });
        const allowed = await opts.authorizeExternalAction!();
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
      fallbackPerCompany: 0,
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
        _skills: unknown,
        _gateway: unknown,
        _key: unknown,
        _input: unknown,
        opts: { authorizeExternalAction?: () => Promise<boolean> },
      ) => {
        first = await opts.authorizeExternalAction!();
        // wire 之前 c2 被禁联：下一次回调必须返回 false（不是恒 true）。
        state.suppressions.push({ type: 'domain', value: 'c2.example' });
        second = await opts.authorizeExternalAction!();
        throw new ExternalActionDeniedError();
      },
    );
    mocks.judgeFitCompany.mockResolvedValue({ verdict: 'weak' });

    await activities.quickJudgeBatch(ARGS);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});
