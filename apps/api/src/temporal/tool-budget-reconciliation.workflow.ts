import { ApplicationFailure, proxyActivities } from '@temporalio/workflow';

import type { ToolBudgetReconciliationActivities } from './tool-budget-reconciliation.activities';

/**
 * B4（审计 F1）：未结预算操作的独立清收 sweep（客户侧 sweep 调度器，默认每小时）。
 *
 * 枚举「含超期 RESERVED/RESULT_UNKNOWN 的 workspace」→ 逐 workspace：
 *   1) 释放「预留后未出网」的 RESERVED；
 *   2) 按预留额保守结清「已出网结果未知」的 RESULT_UNKNOWN。
 * 单 workspace 失败不阻塞其余；全部失败以 nonRetryable 暴露（不静默绿）。
 * 重放安全：每 workspace 只调一次活动（批内循环在活动/数据库函数里），循环次数由活动
 * 返回的列表长度决定，无 workflow 侧数值常量。
 */
const acts = proxyActivities<
  Pick<
    ToolBudgetReconciliationActivities,
    'listWorkspacesWithUnresolvedToolBudget' | 'drainStaleToolBudgetReservations' | 'settleUnknownToolBudgetOperations'
  >
>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 5 },
});

export interface ToolBudgetReconciliationInput {
  olderThanHours?: number;
  limit?: number;
  /** 单轮最多翻的枚举页数（每页 limit 个 workspace，游标防饿死）。 */
  maxPages?: number;
}

export interface ToolBudgetReconciliationResult {
  workspaces: number;
  released: number;
  settledUnknown: number;
  failed: number;
}

export async function toolBudgetReconciliationWorkflow(
  input: ToolBudgetReconciliationInput = {},
): Promise<ToolBudgetReconciliationResult> {
  const olderThanHours = input.olderThanHours ?? 2;
  const limit = input.limit ?? 50;
  const maxPages = input.maxPages ?? 4;
  let released = 0;
  let settledUnknown = 0;
  let failed = 0;
  let examined = 0;
  let afterWorkspaceId: string | undefined;
  // 游标分页：超出单页上限的 workspace 不会因为 UUID 排序前缀被永久饿死。
  for (let page = 0; page < maxPages; page += 1) {
    const listed = await acts.listWorkspacesWithUnresolvedToolBudget({
      olderThanHours,
      limit,
      ...(afterWorkspaceId ? { afterWorkspaceId } : {}),
    });
    const workspaceIds = listed.workspaceIds;
    examined += workspaceIds.length;
    for (const workspaceId of workspaceIds) {
      // 两个 SINK 相互独立：释放失败不能连带跳过结清（反之亦然）。
      try {
        const drain = await acts.drainStaleToolBudgetReservations({ workspaceId, olderThanHours });
        released += drain.released;
      } catch {
        failed += 1;
        console.warn(`[tool-budget-sweep] release failed for ${workspaceId}`);
      }
      try {
        const settle = await acts.settleUnknownToolBudgetOperations({ workspaceId, olderThanHours });
        settledUnknown += settle.settled;
      } catch {
        failed += 1;
        console.warn(`[tool-budget-sweep] settle-unknown failed for ${workspaceId}`);
      }
    }
    if (workspaceIds.length < limit) return finish();
    afterWorkspaceId = workspaceIds[workspaceIds.length - 1];
  }
  return finish();

  function finish(): ToolBudgetReconciliationResult {
    if (examined > 0 && released === 0 && settledUnknown === 0 && failed > 0) {
      // 全部失败（例如账本/连接池同时不可用）不能让 sweep 静默绿。
      throw ApplicationFailure.nonRetryable(
        `TOOL_BUDGET_RECONCILIATION_ALL_FAILED:${failed}`,
        'TOOL_BUDGET_RECONCILIATION_ALL_FAILED',
      );
    }
    return { workspaces: examined, released, settledUnknown, failed };
  }
}
