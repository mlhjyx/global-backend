import { ApplicationFailure } from '@temporalio/activity';
import type { PrismaClient } from '@prisma/client';
import {
  computeContactMetrics,
  evaluateContactWeeklyAlerts,
  loadCoverageHistory,
  persistContactMetricsSnapshot,
  prismaQueryRunner,
  renderContactWeeklyReportMarkdown,
  type ContactAlertEvaluation,
  type ContactMetricsSnapshot,
  type ContactMetricsSnapshotClient,
} from '../enrichment/metrics/contact-metrics';

/**
 * P1-17：CONTACT_WEEKLY_REPORT 的活动（每周 Schedule；注册即 paused）。
 *
 * 只读聚合 + 写一行快照（contact_metrics_snapshot）：owner 连接（跨租户汇总口径，
 * workspace_id=NULL）。无供应商调用、无出网——Schedule 启用与否不影响任何第三方。
 * 告警三条按 §2.3.12 评估并随快照落库；通知渠道接线留给后续切片（当前进周报正文）。
 */
export type ContactWeeklyReportResult = {
  status: 'ran';
  window: { since: string; until: string };
  metrics: ContactMetricsSnapshot;
  alerts: ContactAlertEvaluation[];
  report: string;
  persisted: boolean;
};

export interface ContactWeeklyReportInput {
  /** ISO 时间；缺省 = [now-7d, now)。 */
  since?: string;
  until?: string;
  /** 租户过滤（缺省 = 全租户汇总）。 */
  workspaceId?: string;
  /** 是否写入周报快照（缺省 true；dry 演示可关）。 */
  persist?: boolean;
}

function validDate(raw: string | undefined, name: string): Date | null {
  if (raw === undefined) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw ApplicationFailure.nonRetryable(
      `CONTACT_WEEKLY_REPORT_INVALID_${name.toUpperCase()}`,
      'CONTACT_WEEKLY_REPORT_INVALID_WINDOW',
    );
  }
  return parsed;
}

export function createContactWeeklyReportActivities(deps: {
  ownerDb: PrismaClient;
  now?: () => Date;
}) {
  return {
    async contactWeeklyReportOnce(
      args: ContactWeeklyReportInput = {},
    ): Promise<ContactWeeklyReportResult> {
      const now = deps.now ?? (() => new Date());
      const until = validDate(args.until, 'until') ?? now();
      const since = validDate(args.since, 'since') ?? new Date(until.getTime() - 7 * 24 * 3_600_000);
      if (since.getTime() >= until.getTime()) {
        throw ApplicationFailure.nonRetryable(
          'CONTACT_WEEKLY_REPORT_INVALID_WINDOW',
          'CONTACT_WEEKLY_REPORT_INVALID_WINDOW',
        );
      }
      const workspaceId = args.workspaceId ?? null;
      const metrics = await computeContactMetrics(prismaQueryRunner(deps.ownerDb), {
        since,
        until,
        ...(workspaceId ? { workspaceId } : {}),
      });
      // 「连续 2 周下降」序列：本周（当前窗口计算值）+ 最近两条快照（新→旧）。
      const history = await loadCoverageHistory(
        deps.ownerDb as unknown as ContactMetricsSnapshotClient,
        { workspaceId, before: new Date(metrics.window.since), limit: 2 },
      );
      const alerts = evaluateContactWeeklyAlerts({
        validCoverageSeries: [
          metrics.validEmailCompanyCoverage.rate,
          history[0] ?? null,
          history[1] ?? null,
        ],
        verificationErrors: metrics.verificationErrorRate.errors,
        verificationVotes: metrics.verificationErrorRate.votes,
        costMicrousdPerValid: metrics.costPerValidEmail.microusdPerValid,
      });
      const persist = args.persist ?? true;
      if (persist) {
        await persistContactMetricsSnapshot(
          deps.ownerDb as unknown as ContactMetricsSnapshotClient,
          metrics,
          alerts,
          workspaceId,
        );
      }
      return {
        status: 'ran',
        window: metrics.window,
        metrics,
        alerts,
        report: renderContactWeeklyReportMarkdown(metrics, alerts),
        persisted: persist,
      };
    },
  };
}

export type ContactWeeklyReportActivities = ReturnType<typeof createContactWeeklyReportActivities>;
