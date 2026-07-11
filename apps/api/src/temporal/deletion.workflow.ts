import { proxyActivities } from '@temporalio/workflow';
import type { DeletionActivities } from './deletion.activities';
import type { DeletionWorkflowInput, ErasureCounts } from '../compliance/deletion.types';

const acts = proxyActivities<DeletionActivities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 5 },
});

/**
 * 删除编排（收口⑥ PR-B，GDPR Art.17）：冻结 → 擦除 → 回执 三段活动（各幂等，CAS 守状态）。
 * 任一步异常 → failDeletion 标 FAILED 后重抛（失败可观测；Temporal 记录 + 可人工重启）。
 * 🔴 located 只含 uuid + 计数，进 workflow 历史无 PII。sandbox：本文件只 import @temporalio/workflow + 类型。
 */
export async function deletionWorkflow(input: DeletionWorkflowInput): Promise<ErasureCounts> {
  try {
    const located = await acts.freezeSubject(input);
    await acts.eraseSubject({ input, located });
    return await acts.completeDeletion({ input, located });
  } catch (err) {
    await acts.failDeletion({
      workspaceId: input.workspaceId,
      deletionRequestId: input.deletionRequestId,
      error: String(err),
    });
    throw err;
  }
}
