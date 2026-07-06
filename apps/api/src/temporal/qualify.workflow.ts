import { proxyActivities } from '@temporalio/workflow';
import type { QualifyActivities, QualifyRunInput } from './qualify.activities';

const acts = proxyActivities<QualifyActivities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3 },
});

/** Qualify 编排（PRD 5.6）：对 ACTIVE ICP 的全部候选做确定性评分与队列分配。 */
export async function qualifyWorkflow(input: QualifyRunInput): Promise<void> {
  await acts.scoreCandidates(input);
}
