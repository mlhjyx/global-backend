import { proxyActivities } from '@temporalio/workflow';
import type {
  ContactWeeklyReportActivities,
  ContactWeeklyReportInput,
} from './contact-weekly-report.activities';

const { contactWeeklyReportOnce } = proxyActivities<ContactWeeklyReportActivities>({
  // 只读聚合（十来个 SQL）+ 一次快照写入；10 分钟足以覆盖大表抖动。
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 2 },
});

/**
 * P1-17：联系人工程周报（CONTACT_WEEKLY_REPORT，默认 168h，注册即 paused）。
 *
 * 无供应商调用、无出网；指标口径见 enrichment/metrics/contact-metrics.ts（计划 §2.3.12）。
 * 周报正文（Markdown）随工作流结果返回——人工归档到 docs/evidence/ 由运维执行
 * （脚本 `scripts/contact-weekly-report.mts` 提供同一份正文与 --out）。
 */
export async function contactWeeklyReportWorkflow(
  input: ContactWeeklyReportInput = {},
): Promise<Awaited<ReturnType<ContactWeeklyReportActivities['contactWeeklyReportOnce']>>> {
  return contactWeeklyReportOnce(input);
}
