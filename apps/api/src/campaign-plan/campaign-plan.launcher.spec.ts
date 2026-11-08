import { describe, expect, it, vi } from 'vitest';
import { CampaignPlanLauncher, type CampaignPlanDraftLaunchInput } from './campaign-plan.launcher';
import type { TemporalClient } from '../temporal/temporal.client';

/**
 * ch08 §3.1.4：规划 workflow 必须有总时限——worker 丢失 / workflow task 卡住时，
 * 没有 workflowExecutionTimeout 的 job 会永久 RUNNING 并卡死同 campaign 的再次发起。
 * 这里锁定 launcher 传给 Temporal 的三个超时字段（值即设计值，改动需同步 SaaS reaper 的 75 分钟阈值）。
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';

function input(): CampaignPlanDraftLaunchInput {
  return {
    workspaceId: WORKSPACE_ID,
    campaignId: CAMPAIGN_ID,
    jobId: JOB_ID,
    objective: '在德国找 30 家泵类分销商',
    executionBudget: {
      authorityId: '44444444-4444-4444-8444-444444444444',
      replay: false,
      scopeKey: WORKSPACE_ID,
      accountKey: 'campaign.plan:campaign:22222222-2222-4222-8222-222222222222:abc',
      purpose: 'campaign.plan',
      subjectType: 'campaign',
      subjectId: CAMPAIGN_ID,
      requestSha256: 'a'.repeat(64),
    },
  };
}

describe('CampaignPlanLauncher', () => {
  it('starts the workflow with an explicit execution/run/task timeout', async () => {
    const start = vi.fn(async () => undefined);
    const launcher = new CampaignPlanLauncher({
      client: { workflow: { start } },
    } as unknown as TemporalClient);

    await launcher.launch(input());

    expect(start).toHaveBeenCalledTimes(1);
    const [workflowType, options] = start.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(workflowType).toBe('campaignPlanningWorkflow');
    expect(options).toMatchObject({
      workflowId: `campaign-plan-${JOB_ID}`,
      workflowExecutionTimeout: '60 minutes',
      workflowRunTimeout: '50 minutes',
      workflowTaskTimeout: '30 seconds',
    });
  });

  it('treats an already-started workflow id as idempotent success', async () => {
    const start = vi.fn(async () => {
      throw new Error('workflow execution already started');
    });
    const launcher = new CampaignPlanLauncher({
      client: { workflow: { start } },
    } as unknown as TemporalClient);

    await expect(launcher.launch(input())).resolves.toBeUndefined();
  });

  it('maps other start failures to CAMPAIGN_PLAN_LAUNCH_FAILED', async () => {
    const start = vi.fn(async () => {
      throw new Error('temporal unavailable');
    });
    const launcher = new CampaignPlanLauncher({
      client: { workflow: { start } },
    } as unknown as TemporalClient);

    await expect(launcher.launch(input())).rejects.toMatchObject({
      response: { error: { code: 'CAMPAIGN_PLAN_LAUNCH_FAILED' } },
    });
  });
});
