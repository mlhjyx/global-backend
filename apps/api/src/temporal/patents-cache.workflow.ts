import { proxyActivities } from '@temporalio/workflow';
import type { PatentsCacheActivities } from './patents-cache.activities';

const acts = proxyActivities<PatentsCacheActivities>({
  // 一次共享大扫 + 批量落库：BigQuery 全表扫可数十秒~分钟，给足 headroom（overlap=SKIP 已防叠跑）。
  startToCloseTimeout: '15 minutes',
  retry: { maximumAttempts: 2 },
});

/**
 * **专利发明人缓存刷新 sweep**（scale-safe #89，第 5 个周期 Schedule）——一次共享大扫落 postgres，
 * 令逐公司发现零 BQ 字节读缓存。空队列 → SKIPPED_EMPTY（零成本）；§8.8 SUSPENDED → DENIED（不扫）。
 * seed DISABLED + PATENT_SOURCE_MODE=off 时本 sweep 仍可跑（预热/verify），但读侧 provider 关（off）不消费。
 */
export async function patentsCacheRefreshWorkflow(input: { maxAnchors?: number } = {}) {
  return acts.refreshPatentCacheActivity(input);
}
