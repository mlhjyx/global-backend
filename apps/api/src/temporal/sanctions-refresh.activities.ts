import type { PrismaClient } from '@prisma/client';
import type { ExecutionBroker } from '../tools/tool-contract';
import { SanctionsRefreshService, type SanctionsRefreshSummary } from '../sanctions/sanctions-refresh.service';
import type { SanctionsScreeningService } from '../sanctions/sanctions-screening.service';
import {
  type BudgetStore,
  UnavailableBudgetStore,
} from '../tools/budget-store';
import type { PlatformScheduleAuthorityActivityInput } from './platform-schedule-authority';
import { attestPlatformScheduleActivity } from './platform-schedule-authority.activities';
import { SANCTIONS_REFRESH_SCHEDULE_ID } from './understanding.constants';

/**
 * 制裁名单刷新活动（Qualify 第五门，每日 Schedule）。owner 连接写平台表，下载经 broker（source_policy 门）。
 * ENABLED 源全刷；DISABLED 源零动作（refreshAll 只取 ENABLED）。刷新后重建 worker 内 qualify 用的内存索引。
 */
export function createSanctionsRefreshActivities(deps: {
  ownerDb: PrismaClient;
  broker: ExecutionBroker;
  sanctionsScreening?: SanctionsScreeningService;
  budgetStore?: BudgetStore;
  platformWriter?: PrismaClient;
  activityRunId?: () => string | undefined;
}) {
  const service = new SanctionsRefreshService({
    ownerDb: deps.ownerDb,
    broker: deps.broker,
    platformWriter: deps.platformWriter,
  });
  const budgets =
    deps.budgetStore ??
    new UnavailableBudgetStore('sanctions refresh activities require an authoritative BudgetStore');

  return {
    async refreshSanctionsLists(args: PlatformScheduleAuthorityActivityInput = {}): Promise<{ sources: number; summaries: SanctionsRefreshSummary[] }> {
      const binding = await attestPlatformScheduleActivity({
        args, budgetStore: budgets, scheduleId: SANCTIONS_REFRESH_SCHEDULE_ID, activityRunId: deps.activityRunId,
      });
      const summaries = await service.refreshAll(binding.accountKey);
      await deps.sanctionsScreening?.rebuildIndex().catch(() => undefined);
      return { sources: summaries.length, summaries };
    },
  };
}

export type SanctionsRefreshActivities = ReturnType<typeof createSanctionsRefreshActivities>;
