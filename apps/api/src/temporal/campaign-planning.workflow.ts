import {
  ApplicationFailure,
  CancellationScope,
  proxyActivities,
} from '@temporalio/workflow';
import { describeRunFailure } from './discovery.run-failure';
import type { CampaignPlanIssue } from './campaign-control-plane.client';
import type {
  CampaignPlanInputBundle,
  CampaignPlanReplanEntry,
  CampaignPlanReplanReason,
  CampaignPlanningActivities,
} from './campaign-planning.activities';
import {
  parseExecutionBudgetBinding,
  type ExecutionBudgetBinding,
} from '../execution-budget/execution-budget-binding';

// 只读装配是几次 DB 读：快、幂等。
const assembleActs = proxyActivities<CampaignPlanningActivities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 },
});

// 规划是单次推理档模型调用（含活动内一次 schema 修复）；429 突发需要拉开间隔。
const modelActs = proxyActivities<CampaignPlanningActivities>({
  startToCloseTimeout: '4 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    maximumInterval: '60 seconds',
  },
});

// 回调 gain-saas：网络抖动重试；4xx/422 分类在活动内已按 nonRetryable 处理。
const deliverActs = proxyActivities<CampaignPlanningActivities>({
  startToCloseTimeout: '1 minute',
  retry: {
    maximumAttempts: 5,
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
  },
});

// 失败回写 job：尽力而为，重试后仍失败也不顶替原始错误。
const reportActs = proxyActivities<CampaignPlanningActivities>({
  startToCloseTimeout: '1 minute',
  retry: {
    maximumAttempts: 5,
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
  },
});

export interface CampaignPlanningWorkflowInput {
  workspaceId: string;
  campaignId: string;
  jobId: string;
  objective: string;
  icpId?: string;
  audienceSizeCap?: number;
  budgetCapMicros?: number;
  /** M2.2：本 job 允许的自动重规划轮数（0–2，缺省 0 = 单轮行为不变）。 */
  maxReplans?: number;
  /** M2.2：人工拒绝后的重生成——上一版被拒计划与拒绝理由（截断 500 字）。 */
  previousPlan?: unknown;
  replanReason?: { code: 'HUMAN_DECLINE'; detail?: string };
  executionContractVersion?: 2;
  executionBudget?: ExecutionBudgetBinding;
}

const EXECUTION_CONTRACT_VERSION = 2 as const;
/** 闭集错误码：全大写 token（类型/控制码）；类名等混合大小写一律不落到 job。 */
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

function invalidInput(): never {
  throw ApplicationFailure.nonRetryable(
    'CAMPAIGN_PLAN_INPUT_INVALID',
    'CAMPAIGN_PLAN_INPUT_INVALID',
  );
}

/**
 * 活动失败在 workflow 侧只保留闭集 token（诊断失败转换器会抹掉自由文本）。
 * Temporal 交给 workflow 的是 ActivityFailure，application type 在 cause 链上；
 * 复用 discovery 的 cause 链分类器，取不出全大写 token 的一律归为 CAMPAIGN_PLAN_FAILED。
 */
export function campaignPlanFailureCode(error: unknown): string {
  const { errorType } = describeRunFailure(error);
  return errorType !== 'UNCLASSIFIED' && FAILURE_CODE.test(errorType)
    ? errorType
    : 'CAMPAIGN_PLAN_FAILED';
}

/**
 * M2.1 受限 Campaign 规划（设计 §3/§5）：创建 job → 只读装配 → 模型产计划 →
 * 回调 gain-saas 落 DRAFT revision。任何一步失败都把 `FAILED` + 闭集错误码回写 job
 * 后结束；本工作流不执行任何外部动作（影子期结构上不执行，D-M2.1-c）。
 */
function replanBudgetOf(input: CampaignPlanningWorkflowInput): number {
  const value = input.maxReplans;
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2) {
    invalidInput();
  }
  return value;
}

/**
 * M2.2 有界重规划：首轮（或人工拒绝后的重生成）+ 至多 maxReplans 轮校验反馈重规划。
 * 每轮独立模型调用与 usage 记账；轮次耗尽仍不合法 → job `NEEDS_HUMAN`（人工可直接改
 * plan JSON 另存新 revision）。任何非「校验不通过」的失败仍是既有的 FAILED 语义。
 */
export async function campaignPlanningWorkflow(
  input: CampaignPlanningWorkflowInput,
): Promise<void> {
  const { workspaceId, campaignId, jobId, objective } = input;
  try {
    if (
      typeof workspaceId !== 'string' ||
      typeof campaignId !== 'string' ||
      typeof jobId !== 'string' ||
      typeof objective !== 'string' ||
      input.executionContractVersion !== EXECUTION_CONTRACT_VERSION
    ) {
      invalidInput();
    }
    const maxReplans = replanBudgetOf(input);
    const humanDecline = input.replanReason;
    if (
      humanDecline !== undefined &&
      (humanDecline.code !== 'HUMAN_DECLINE' ||
        (humanDecline.detail !== undefined && typeof humanDecline.detail !== 'string'))
    ) {
      invalidInput();
    }
    try {
      parseExecutionBudgetBinding(input.executionBudget, {
        scopeKey: workspaceId,
        purpose: 'campaign.plan',
        subjectType: 'campaign',
      });
    } catch {
      invalidInput();
    }

    const bundle: CampaignPlanInputBundle =
      await assembleActs.assembleCampaignPlanInputs({
        workspaceId,
        objective,
        maxReplans,
        ...(input.icpId !== undefined ? { icpId: input.icpId } : {}),
        ...(input.audienceSizeCap !== undefined
          ? { audienceSizeCap: input.audienceSizeCap }
          : {}),
        ...(input.budgetCapMicros !== undefined
          ? { budgetCapMicros: input.budgetCapMicros }
          : {}),
      });

    const maxRounds = 1 + maxReplans;
    const replanHistory: CampaignPlanReplanEntry[] = [];
    let lastIssues: readonly CampaignPlanIssue[] | undefined;
    let firstRoundReplan:
      | { reasonCode: CampaignPlanReplanReason; previousPlan?: unknown; detail?: string }
      | undefined;
    if (input.previousPlan !== undefined || humanDecline !== undefined) {
      firstRoundReplan = {
        reasonCode: 'HUMAN_DECLINE',
        ...(input.previousPlan !== undefined ? { previousPlan: input.previousPlan } : {}),
        ...(humanDecline?.detail !== undefined ? { detail: humanDecline.detail.slice(0, 500) } : {}),
      };
    }

    for (let round = 0; round < maxRounds; round += 1) {
      const replan =
        round === 0
          ? firstRoundReplan
          : { reasonCode: 'VALIDATOR_ISSUES' as const, ...(lastIssues ? { issues: lastIssues } : {}) };
      const generated = await modelActs.generateCampaignPlan({
        workspaceId,
        jobId,
        bundle,
        executionBudget: input.executionBudget,
        round,
        ...(replan !== undefined ? { replan } : {}),
      });

      if (generated.status === 'ok') {
        await deliverActs.deliverCampaignPlanRevision({
          workspaceId,
          campaignId,
          jobId,
          plan: generated.plan,
          ...(generated.durableReceipt
            ? { durableReceipt: generated.durableReceipt }
            : {}),
          ...(replanHistory.length > 0 ? { replanHistory } : {}),
        });
        return;
      }

      lastIssues = generated.issues;
      replanHistory.push({
        round,
        reasonCode:
          round === 0 && firstRoundReplan !== undefined
            ? 'HUMAN_DECLINE'
            : 'VALIDATOR_ISSUES',
        issues: generated.issues,
      });
    }

    await reportActs.reportCampaignPlanJobFailure({
      workspaceId,
      jobId,
      error: 'CAMPAIGN_PLAN_NEEDS_HUMAN',
      state: 'NEEDS_HUMAN',
      issues: lastIssues ?? [],
      replanHistory,
    });
  } catch (error) {
    // job 回写放在不可取消作用域；回写失败不顶替原始失败。
    try {
      await CancellationScope.nonCancellable(() =>
        reportActs.reportCampaignPlanJobFailure({
          workspaceId,
          jobId,
          error: campaignPlanFailureCode(error),
        }),
      );
    } catch {
      /* 原始失败才是要报告的结果 */
    }
    throw error;
  }
}
