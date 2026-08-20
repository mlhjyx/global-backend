import type { PrismaClient } from '@prisma/client';
import { Context as ActivityContext } from '@temporalio/activity';
import type { ExecutionBroker } from '../tools/tool-contract';
import { SanctionsRefreshService, type SanctionsRefreshSummary } from '../sanctions/sanctions-refresh.service';
import type { SanctionsScreeningService } from '../sanctions/sanctions-screening.service';
import { PLATFORM_WORKSPACE } from '../discovery/provider-contract';
import { sweepBudgetCents } from '../tools/budget';
import {
  BudgetStoreUnavailableError,
  type BudgetStore,
  UnavailableBudgetStore,
} from '../tools/budget-store';

/**
 * 制裁名单刷新活动（Qualify 第五门，每日 Schedule）。owner 连接写平台表，下载经 broker（source_policy 门）。
 * ENABLED 源全刷；DISABLED 源零动作（refreshAll 只取 ENABLED）。刷新后重建 worker 内 qualify 用的内存索引。
 */
export function createSanctionsRefreshActivities(deps: {
  ownerDb: PrismaClient;
  broker: ExecutionBroker;
  sanctionsScreening?: SanctionsScreeningService;
  budgetStore?: BudgetStore;
  activityRunId?: () => string | undefined;
}) {
  const service = new SanctionsRefreshService({ ownerDb: deps.ownerDb, broker: deps.broker });
  const budgets =
    deps.budgetStore ??
    new UnavailableBudgetStore('sanctions refresh activities require an authoritative BudgetStore');

  const workflowAccountKey = (): string => {
    let workflowRunId: string | undefined;
    try {
      workflowRunId = deps.activityRunId?.() ?? ActivityContext.current().info.workflowExecution?.runId;
    } catch {
      workflowRunId = undefined;
    }
    if (!workflowRunId) {
      throw new BudgetStoreUnavailableError('sanctions refresh activity requires a Temporal workflow run id');
    }
    return `sanctions-refresh:${workflowRunId}`;
  };

  return {
    async refreshSanctionsLists(): Promise<{ sources: number; summaries: SanctionsRefreshSummary[] }> {
      const accountKey = workflowAccountKey();
      await budgets.open({
        workspaceId: PLATFORM_WORKSPACE,
        accountKey,
        capCents: sweepBudgetCents(),
        replayScope: true,
      });
      try {
        const summaries = await service.refreshAll(accountKey);
        // 名单变更即刻生效于本 worker 进程后续 qualify（index 从 ENABLED 源重建；DISABLED → 空 → no-op）。
        await deps.sanctionsScreening?.rebuildIndex().catch(() => undefined);
        return { sources: summaries.length, summaries };
      } finally {
        await budgets.close({ workspaceId: PLATFORM_WORKSPACE, accountKey });
      }
    },
  };
}

export type SanctionsRefreshActivities = ReturnType<typeof createSanctionsRefreshActivities>;
