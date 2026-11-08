import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { TemporalClient } from '../temporal/temporal.client';
import { UNDERSTANDING_TASK_QUEUE } from '../temporal/understanding.constants';
import type { ExecutionBudgetBinding } from '../execution-budget/execution-budget-binding';

export interface CampaignPlanDraftLaunchInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly jobId: string;
  readonly objective: string;
  readonly icpId?: string;
  readonly audienceSizeCap?: number;
  readonly budgetCapMicros?: number;
  /** M2.2：允许的自动重规划轮数（0–2）。 */
  readonly maxReplans?: number;
  readonly previousPlan?: unknown;
  readonly replanReason?: { readonly code: 'HUMAN_DECLINE'; readonly detail?: string };
  readonly executionBudget: ExecutionBudgetBinding;
}

/**
 * 启动 `campaignPlanningWorkflow`：workflowId 绑定 jobId，同一 job 重复触发由
 * Temporal 按 WorkflowId 去重（gain-saas 侧另有「同一 campaign 仅一个活跃 job」索引）。
 */
@Injectable()
export class CampaignPlanLauncher {
  private readonly log = new Logger(CampaignPlanLauncher.name);

  constructor(private readonly temporal: TemporalClient) {}

  async launch(input: CampaignPlanDraftLaunchInput): Promise<void> {
    try {
      await this.temporal.client.workflow.start('campaignPlanningWorkflow', {
        taskQueue: UNDERSTANDING_TASK_QUEUE,
        workflowId: `campaign-plan-${input.jobId}`,
        args: [
          {
            ...input,
            maxReplans: input.maxReplans ?? 0,
            executionContractVersion: 2 as const,
          },
        ],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('already started')) {
        this.log.log(`campaign plan already running (${input.jobId})`);
        return;
      }
      throw new ServiceUnavailableException({
        error: {
          code: 'CAMPAIGN_PLAN_LAUNCH_FAILED',
          message: 'CAMPAIGN_PLAN_LAUNCH_FAILED',
        },
      });
    }
  }
}
