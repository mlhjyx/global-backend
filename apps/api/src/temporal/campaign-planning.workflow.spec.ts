import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `campaignPlanningWorkflow` 编排单测（hermetic proxyActivities-mock；无 Temporal 运行时/出网）。
 * 守：装配 → 规划 → 回调的固定顺序；任何一步失败都把 FAILED + 闭集错误码回写 job 后失败；
 * 负向 4：技能平台停用 → job FAILED `SKILL_PLATFORM_DISABLED`（活动层另有零模型调用的断言）。
 */

vi.mock('@temporalio/workflow', async () => ({
  ...(await import('./testing/temporal-workflow.mock')),
}));

import {
  acts,
  ApplicationFailure,
  resetActivities,
} from './testing/temporal-workflow.mock';
import {
  campaignPlanFailureCode,
  campaignPlanningWorkflow,
  type CampaignPlanningWorkflowInput,
} from './campaign-planning.workflow';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';

function input(
  overrides: Partial<CampaignPlanningWorkflowInput> = {},
): CampaignPlanningWorkflowInput {
  return {
    workspaceId: WORKSPACE_ID,
    campaignId: CAMPAIGN_ID,
    jobId: JOB_ID,
    objective: '在德国找 30 家泵类分销商',
    executionContractVersion: 2,
    executionBudget: {
      authorityId: '44444444-4444-4444-8444-444444444444',
      replay: false,
      scopeKey: WORKSPACE_ID,
      accountKey: 'campaign.plan:campaign:22222222-2222-4222-8222-222222222222:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      purpose: 'campaign.plan',
      subjectType: 'campaign',
      subjectId: CAMPAIGN_ID,
      requestSha256: 'a'.repeat(64),
    },
    ...overrides,
  };
}

const bundle = { objective: 'x', availableIcps: [], seller: null };
const plan = {
  schemaVersion: 'campaign-plan/v0',
  goal: { objective: 'g' },
  audience: { icpIds: [], sizeCap: 10 },
  motions: [{ type: 'discovery', icpIds: [] }],
  budget: { currency: 'USD' },
  approvalPolicy: { required: true },
  decisionPolicy: { maxReplans: 0 },
};

beforeEach(() => resetActivities());

describe('campaignPlanningWorkflow', () => {
  it('assembles, generates, then delivers the raw plan; no failure report on success', async () => {
    acts.assembleCampaignPlanInputs.mockResolvedValue(bundle);
    acts.generateCampaignPlan.mockResolvedValue({ plan });
    acts.deliverCampaignPlanRevision.mockResolvedValue(undefined);

    await campaignPlanningWorkflow(input());

    expect(acts.assembleCampaignPlanInputs).toHaveBeenCalledTimes(1);
    expect(acts.generateCampaignPlan).toHaveBeenCalledTimes(1);
    expect(acts.deliverCampaignPlanRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        campaignId: CAMPAIGN_ID,
        jobId: JOB_ID,
        plan,
      }),
    );
    expect(acts.reportCampaignPlanJobFailure).not.toHaveBeenCalled();
    const assembleOrder =
      acts.assembleCampaignPlanInputs.mock.invocationCallOrder[0];
    const modelOrder = acts.generateCampaignPlan.mock.invocationCallOrder[0];
    const deliverOrder =
      acts.deliverCampaignPlanRevision.mock.invocationCallOrder[0];
    expect(assembleOrder).toBeLessThan(modelOrder);
    expect(modelOrder).toBeLessThan(deliverOrder);
  });

  it('negative 4: skill platform disabled fails the job with SKILL_PLATFORM_DISABLED', async () => {
    acts.assembleCampaignPlanInputs.mockResolvedValue(bundle);
    acts.generateCampaignPlan.mockRejectedValue(
      ApplicationFailure.nonRetryable(
        'SKILL_PLATFORM_DISABLED',
        'SKILL_PLATFORM_DISABLED',
      ),
    );

    await expect(campaignPlanningWorkflow(input())).rejects.toMatchObject({
      type: 'SKILL_PLATFORM_DISABLED',
    });
    expect(acts.deliverCampaignPlanRevision).not.toHaveBeenCalled();
    expect(acts.reportCampaignPlanJobFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        error: 'SKILL_PLATFORM_DISABLED',
      }),
    );
  });

  it('reports CAMPAIGN_PLAN_NO_ICP when input assembly finds no ICP', async () => {
    acts.assembleCampaignPlanInputs.mockRejectedValue(
      ApplicationFailure.nonRetryable('CAMPAIGN_PLAN_NO_ICP', 'CAMPAIGN_PLAN_NO_ICP'),
    );

    await expect(campaignPlanningWorkflow(input())).rejects.toMatchObject({
      type: 'CAMPAIGN_PLAN_NO_ICP',
    });
    expect(acts.generateCampaignPlan).not.toHaveBeenCalled();
    expect(acts.reportCampaignPlanJobFailure).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'CAMPAIGN_PLAN_NO_ICP' }),
    );
  });

  it('maps an unknown activity error to CAMPAIGN_PLAN_FAILED and still rethrows', async () => {
    acts.assembleCampaignPlanInputs.mockResolvedValue(bundle);
    acts.generateCampaignPlan.mockRejectedValue(new Error('boom'));

    await expect(campaignPlanningWorkflow(input())).rejects.toThrow('boom');
    expect(acts.reportCampaignPlanJobFailure).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'CAMPAIGN_PLAN_FAILED' }),
    );
  });

  it('does not let a failing job report replace the original failure', async () => {
    acts.assembleCampaignPlanInputs.mockRejectedValue(
      ApplicationFailure.nonRetryable('CAMPAIGN_PLAN_NO_ICP', 'CAMPAIGN_PLAN_NO_ICP'),
    );
    acts.reportCampaignPlanJobFailure.mockRejectedValue(new Error('control plane down'));

    await expect(campaignPlanningWorkflow(input())).rejects.toMatchObject({
      type: 'CAMPAIGN_PLAN_NO_ICP',
    });
  });

  it('rejects an invalid execution contract/binding and reports CAMPAIGN_PLAN_INPUT_INVALID', async () => {
    await expect(
      campaignPlanningWorkflow(input({ executionContractVersion: 1 as unknown as 2 })),
    ).rejects.toMatchObject({ type: 'CAMPAIGN_PLAN_INPUT_INVALID' });
    expect(acts.assembleCampaignPlanInputs).not.toHaveBeenCalled();
    expect(acts.reportCampaignPlanJobFailure).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'CAMPAIGN_PLAN_INPUT_INVALID' }),
    );
  });

  it('rejects a binding whose purpose or subject does not match campaign.plan/campaign', async () => {
    const bad = input();
    await expect(
      campaignPlanningWorkflow({
        ...bad,
        executionBudget: { ...bad.executionBudget!, purpose: 'understanding.run' },
      }),
    ).rejects.toMatchObject({ type: 'CAMPAIGN_PLAN_INPUT_INVALID' });
  });
});

describe('campaignPlanFailureCode', () => {
  it('keeps only closed ApplicationFailure types and otherwise fails closed', () => {
    expect(
      campaignPlanFailureCode(
        ApplicationFailure.nonRetryable('X', 'CAMPAIGN_PLAN_INVALID'),
      ),
    ).toBe('CAMPAIGN_PLAN_INVALID');
    expect(campaignPlanFailureCode(new Error('free text'))).toBe(
      'CAMPAIGN_PLAN_FAILED',
    );
    expect(campaignPlanFailureCode({ type: 'lowercase type' })).toBe(
      'CAMPAIGN_PLAN_FAILED',
    );
  });
});
