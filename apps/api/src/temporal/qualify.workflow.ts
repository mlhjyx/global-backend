import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import type { QualifyActivities, QualifyRunInput } from './qualify.activities';

const acts = proxyActivities<QualifyActivities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3 },
});

/**
 * Qualify 编排（PRD 5.6）：对 ACTIVE ICP 的全部候选做确定性评分与队列分配。
 * runRef = 本次工作流执行的 run id（确定性、replay 安全）：CandidateBatchCompleted 与
 * lead.score_detail.candidateBatchRef 的批次前缀（QGO 步 10）。
 */
export async function qualifyWorkflow(input: QualifyRunInput): Promise<void> {
  await acts.scoreCandidates({ ...input, runRef: input.runRef ?? workflowInfo().runId });
}
