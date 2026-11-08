import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `createCampaignPlanningActivities` 单测（无 DB / 无网络 / 无模型）：
 * - 负向 4：技能平台停用 → SKILL_PLATFORM_DISABLED，**零模型调用**，job 回写 FAILED；
 * - 语义后检：ICP 越界 / 超上限 → CAMPAIGN_PLAN_INVALID + issues 落 job；
 * - 输入装配：ICP 不存在 → CAMPAIGN_PLAN_ICP_NOT_FOUND，且只读（无业务写）；
 * - 回调交付：422 → CAMPAIGN_PLAN_INVALID（附 issues），网络失败保持可重试。
 */

vi.mock('../model-runtime/structured-task-runtime-bridge', () => ({
  executeStructuredTaskWithRuntime: vi.fn(),
}));

import { executeStructuredTaskWithRuntime } from '../model-runtime/structured-task-runtime-bridge';
import type { PrismaService } from '../prisma/prisma.service';
import type { ModelGateway } from '../model-gateway/model-gateway';
import type { BudgetStore } from '../tools/budget-store';
import type { MemoryQueryService } from '../memory/memory-query.service';
import { TaskOutputValidationError } from '../model-gateway/providers/provider-output-error';
import { SkillUnavailableError } from '../skills/skill-runtime';
import type { SkillResolver } from '../skills/skill-runtime';
import {
  CampaignControlPlaneError,
  type CampaignControlPlane,
} from './campaign-control-plane.client';
import {
  campaignPlanSemanticIssues,
  createCampaignPlanningActivities,
  type CampaignPlanInputBundle,
  type CampaignPlanOutput,
} from './campaign-planning.activities';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';
const ICP_A = '55555555-5555-4555-8555-555555555555';
const ICP_B = '66666666-6666-4666-8666-666666666666';
const AUTHORITY_ID = '44444444-4444-4444-8444-444444444444';

const binding = {
  authorityId: AUTHORITY_ID,
  replay: false,
  scopeKey: WORKSPACE_ID,
  accountKey: 'campaign.plan:campaign:22222222-2222-4222-8222-222222222222:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  purpose: 'campaign.plan' as const,
  subjectType: 'campaign',
  subjectId: CAMPAIGN_ID,
  requestSha256: 'a'.repeat(64),
};

function plan(overrides: Partial<CampaignPlanOutput> = {}): CampaignPlanOutput {
  return {
    schemaVersion: 'campaign-plan/v0',
    goal: { objective: '在德国找 30 家泵类分销商' },
    audience: { icpIds: [ICP_A], sizeCap: 200 },
    motions: [{ type: 'discovery', icpIds: [ICP_A] }],
    budget: { currency: 'USD' },
    approvalPolicy: { required: true },
    decisionPolicy: { maxReplans: 0 },
    ...overrides,
  };
}

function bundle(
  overrides: Partial<CampaignPlanInputBundle> = {},
): CampaignPlanInputBundle {
  return {
    objective: '在德国找 30 家泵类分销商',
    availableIcps: [
      {
        id: ICP_A,
        name: 'DE distributor',
        status: 'ACTIVE',
        targetMarkets: ['DE'],
        companyAttributes: {},
      },
    ],
    seller: null,
    poolStats: { totalCompanies: 0, byCountry: [], byIndustry: [] },
    memoryBrief: { text: '', truncated: false },
    limits: { maxReplans: 0 },
    ...overrides,
  };
}

function deps(overrides: {
  resolve?: () => Promise<unknown>;
  prisma?: unknown;
  controlPlane?: Partial<CampaignControlPlane>;
  memory?: unknown;
} = {}) {
  const skills = {
    kind: 'static',
    resolve:
      overrides.resolve ??
      (async () => ({
        skillKey: 'campaign.plan',
        version: '1.0.0',
        packType: 'growth_motion',
        skillKind: 'model_task',
        tenantDefault: 'enabled',
        taskContractId: 'campaign.plan',
        taskContractDigest: 'b'.repeat(64),
        manifestDigest: 'c'.repeat(64),
        modelPolicy: 'contract-default',
        allowedTools: [],
        maxCostCents: 60,
        resolverVersion: 'skill-resolver/v0',
      })),
  } as unknown as SkillResolver;
  const gateway = {
    generateStructured: vi.fn(),
    generate: vi.fn(),
  };
  const controlPlane: CampaignControlPlane = {
    deliverRevision: vi.fn().mockResolvedValue(undefined),
    reportJobFailure: vi.fn().mockResolvedValue(undefined),
    ...overrides.controlPlane,
  };
  const budgetStore = {
    attestAuthorized: vi.fn().mockResolvedValue(undefined),
  };
  const memory = overrides.memory ?? {
    buildMemoryBrief: vi.fn().mockResolvedValue({
      text: 'memory brief',
      citations: [],
      tokenEstimate: 3,
      truncated: false,
      semanticEnabled: false,
    }),
  };
  const prisma = overrides.prisma ?? {
    withWorkspace: vi.fn(async (_ws: string, fn: (tx: unknown) => unknown) => fn({})),
  };
  const activities = createCampaignPlanningActivities({
    prisma: prisma as unknown as PrismaService,
    gateway: gateway as unknown as ModelGateway,
    budgetStore: budgetStore as unknown as BudgetStore,
    skills,
    memory: memory as unknown as MemoryQueryService,
    controlPlane,
  });
  return { activities, gateway, controlPlane, budgetStore, skills };
}

const executeMock = vi.mocked(executeStructuredTaskWithRuntime);

beforeEach(() => {
  executeMock.mockReset();
});

describe('generateCampaignPlan', () => {
  it('negative 4: SKILL_PLATFORM_DISABLED fails the job with zero model calls', async () => {
    const { activities, gateway, controlPlane, budgetStore } = deps({
      resolve: async () => {
        throw new SkillUnavailableError('SKILL_PLATFORM_DISABLED', 'campaign.plan');
      },
    });

    await expect(
      activities.generateCampaignPlan({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        bundle: bundle(),
        executionBudget: binding,
      }),
    ).rejects.toMatchObject({ type: 'SKILL_PLATFORM_DISABLED' });

    expect(executeMock).not.toHaveBeenCalled();
    expect(gateway.generateStructured).not.toHaveBeenCalled();
    expect(budgetStore.attestAuthorized).toHaveBeenCalledWith({
      authorityId: AUTHORITY_ID,
      scopeKey: WORKSPACE_ID,
      accountKey: 'campaign.plan:campaign:22222222-2222-4222-8222-222222222222:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(controlPlane.reportJobFailure).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: JOB_ID, error: 'SKILL_PLATFORM_DISABLED' }),
    );
  });

  it('runs exactly one skill-bound structured call and returns the raw plan', async () => {
    executeMock.mockResolvedValue({
      data: plan(),
      provider: 'new-api',
      model: 'deepseek-flash',
    });
    const { activities, controlPlane } = deps();

    const result = await activities.generateCampaignPlan({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      bundle: bundle(),
      executionBudget: binding,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.plan.schemaVersion).toBe('campaign-plan/v0');
    expect(controlPlane.reportJobFailure).not.toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalledTimes(1);
    const [gatewayArg, input, context] = executeMock.mock.calls[0]!;
    expect(gatewayArg).toBeDefined();
    expect(input).toMatchObject({
      task: 'campaign.plan',
      model: expect.any(String),
    });
    expect(context).toMatchObject({
      workspaceId: WORKSPACE_ID,
      runId: 'campaign.plan:campaign:22222222-2222-4222-8222-222222222222:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      durableResultSchema: 'campaign-plan/v1',
    });
  });

  it('returns the issues to the workflow instead of failing the job (M2.2 replan loop)', async () => {
    executeMock.mockRejectedValue(new TaskOutputValidationError('invalid output'));
    const { activities, controlPlane } = deps();

    const result = await activities.generateCampaignPlan({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      bundle: bundle(),
      executionBudget: binding,
    });

    // 校验不通过交给工作流决定重规划或 NEEDS_HUMAN；活动层不自行回写 FAILED。
    expect(result.status).toBe('issues');
    if (result.status !== 'issues') throw new Error('unreachable');
    expect(result.issues.length).toBeGreaterThan(0);
    expect(controlPlane.reportJobFailure).not.toHaveBeenCalled();
  });

  it('installs the semantic ICP gate as the runtime task hard gate (repairable)', async () => {
    executeMock.mockResolvedValue({
      data: plan(),
      provider: 'new-api',
      model: 'deepseek-flash',
    });
    const { activities } = deps();

    await activities.generateCampaignPlan({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      bundle: bundle(),
      executionBudget: binding,
    });

    // 路由层在 schema 通过后调用该硬门；不合法必须抛 TaskOutputValidationError（可触发一次修复）。
    const input = executeMock.mock.calls[0]![1] as {
      validateOutput?: (data: unknown) => void;
      repairTaskOutput?: boolean;
    };
    expect(input.repairTaskOutput).toBe(true);
    expect(() => input.validateOutput?.(plan())).not.toThrow();
    expect(() =>
      input.validateOutput?.(plan({ audience: { icpIds: [ICP_B], sizeCap: 200 } })),
    ).toThrow(/CAMPAIGN_PLAN_INVALID/);
  });
});

describe('campaignPlanSemanticIssues', () => {
  it('accepts a plan within limits and flags motion/audience/limit violations', () => {
    expect(campaignPlanSemanticIssues(plan(), bundle())).toEqual([]);
    const issues = campaignPlanSemanticIssues(
      plan({
        audience: { icpIds: [ICP_A], sizeCap: 500 },
        motions: [
          { type: 'discovery', icpIds: [ICP_B] },
        ],
        budget: { capMicros: 900, currency: 'USD' },
      }),
      bundle({ limits: { audienceSizeCap: 100, budgetCapMicros: 500, maxReplans: 0 } }),
    );
    expect(issues.map((issue) => issue.path)).toEqual([
      'motions.0.icpIds.0',
      'audience.sizeCap',
      'budget.capMicros',
    ]);
  });
});

describe('assembleCampaignPlanInputs', () => {
  it('rejects an unknown ICP with CAMPAIGN_PLAN_ICP_NOT_FOUND', async () => {
    const prisma = {
      withWorkspace: vi.fn(async (_ws: string, fn: (tx: unknown) => unknown) =>
        fn({
          icpDefinition: { findFirst: vi.fn().mockResolvedValue(null) },
        }),
      ),
    };
    const { activities } = deps({ prisma });

    await expect(
      activities.assembleCampaignPlanInputs({
        workspaceId: WORKSPACE_ID,
        objective: 'x',
        icpId: ICP_A,
      }),
    ).rejects.toMatchObject({ type: 'CAMPAIGN_PLAN_ICP_NOT_FOUND' });
  });

  it('rejects when the workspace has no eligible ICP', async () => {
    const prisma = {
      withWorkspace: vi.fn(async (_ws: string, fn: (tx: unknown) => unknown) =>
        fn({
          icpDefinition: { findMany: vi.fn().mockResolvedValue([]) },
        }),
      ),
    };
    const { activities } = deps({ prisma });

    await expect(
      activities.assembleCampaignPlanInputs({
        workspaceId: WORKSPACE_ID,
        objective: 'x',
      }),
    ).rejects.toMatchObject({ type: 'CAMPAIGN_PLAN_NO_ICP' });
  });

  it('assembles read-only inputs (ICP, seller facts, pool counts, memory brief)', async () => {
    const tx = {
      icpDefinition: {
        findFirst: vi.fn().mockResolvedValue({
          id: ICP_A,
          name: 'DE distributor',
          status: 'ACTIVE',
          companyId: '77777777-7777-4777-8777-777777777777',
          targetMarkets: ['DE'],
          companyAttributes: { industry: 'pumps' },
        }),
      },
      companyProfile: {
        findFirst: vi.fn().mockResolvedValue({
          id: '77777777-7777-4777-8777-777777777777',
          name: 'Seller GmbH',
          website: 'https://seller.example',
          industry: 'pumps',
          summary: 'pump maker',
          targetMarkets: ['DE'],
        }),
      },
      claim: {
        findMany: vi.fn().mockResolvedValue([
          { type: 'capability', statement: 'ISO 9001' },
        ]),
      },
      offering: {
        findMany: vi.fn().mockResolvedValue([
          { name: 'Centrifugal pump', description: 'X' },
        ]),
      },
      canonicalCompany: {
        count: vi.fn().mockResolvedValue(42),
        groupBy: vi
          .fn()
          .mockResolvedValueOnce([{ country: 'DE', _count: { _all: 30 } }])
          .mockResolvedValueOnce([{ industry: 'pumps', _count: { _all: 12 } }]),
      },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_ws: string, fn: (tx: unknown) => unknown) =>
        fn(tx),
      ),
    };
    const { activities } = deps({ prisma });

    const result = await activities.assembleCampaignPlanInputs({
      workspaceId: WORKSPACE_ID,
      objective: '在德国找 30 家泵类分销商',
      icpId: ICP_A,
      audienceSizeCap: 300,
      budgetCapMicros: 5_000_000,
    });

    expect(result.availableIcps).toEqual([
      expect.objectContaining({ id: ICP_A, targetMarkets: ['DE'] }),
    ]);
    expect(result.seller).toMatchObject({
      name: 'Seller GmbH',
      approvedClaims: [{ type: 'capability', statement: 'ISO 9001' }],
    });
    expect(result.poolStats).toEqual({
      totalCompanies: 42,
      byCountry: [{ key: 'DE', count: 30 }],
      byIndustry: [{ key: 'pumps', count: 12 }],
    });
    expect(result.limits).toEqual({
      maxReplans: 0,
      audienceSizeCap: 300,
      budgetCapMicros: 5_000_000,
    });
    expect(result.memoryBrief.text).toBe('memory brief');
  });
});

describe('deliverCampaignPlanRevision', () => {
  it('delivers the raw plan exactly once (no local hash) and succeeds', async () => {
    const { activities, controlPlane } = deps();
    await activities.deliverCampaignPlanRevision({
      workspaceId: WORKSPACE_ID,
      campaignId: CAMPAIGN_ID,
      jobId: JOB_ID,
      plan: plan(),
    });
    expect(controlPlane.deliverRevision).toHaveBeenCalledWith({
      jobId: JOB_ID,
      workspaceId: WORKSPACE_ID,
      campaignId: CAMPAIGN_ID,
      plan: plan(),
    });
    expect(controlPlane.reportJobFailure).not.toHaveBeenCalled();
  });

  it('turns a 422 contract rejection into CAMPAIGN_PLAN_INVALID with issues on the job', async () => {
    const issues = [{ path: 'goal.objective', message: 'required' }];
    const { activities, controlPlane } = deps({
      controlPlane: {
        deliverRevision: vi
          .fn()
          .mockRejectedValue(
            new CampaignControlPlaneError('CAMPAIGN_PLAN_INVALID', 'x', {
              status: 422,
              issues,
            }),
          ),
      },
    });

    await expect(
      activities.deliverCampaignPlanRevision({
        workspaceId: WORKSPACE_ID,
        campaignId: CAMPAIGN_ID,
        jobId: JOB_ID,
        plan: plan(),
      }),
    ).rejects.toMatchObject({ type: 'CAMPAIGN_PLAN_INVALID' });
    expect(controlPlane.reportJobFailure).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'CAMPAIGN_PLAN_INVALID', issues }),
    );
  });

  it('keeps a network failure retryable (no nonRetryable ApplicationFailure)', async () => {
    const { activities } = deps({
      controlPlane: {
        deliverRevision: vi
          .fn()
          .mockRejectedValue(
            new CampaignControlPlaneError(
              'CAMPAIGN_CONTROL_PLANE_UNAVAILABLE',
              'down',
            ),
          ),
      },
    });

    const error = await activities
      .deliverCampaignPlanRevision({
        workspaceId: WORKSPACE_ID,
        campaignId: CAMPAIGN_ID,
        jobId: JOB_ID,
        plan: plan(),
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CampaignControlPlaneError);
    expect((error as CampaignControlPlaneError).code).toBe(
      'CAMPAIGN_CONTROL_PLANE_UNAVAILABLE',
    );
  });
});
