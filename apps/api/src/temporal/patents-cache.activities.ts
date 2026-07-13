import type { PrismaClient } from '@prisma/client';
import { bigqueryPatents } from '../adapters/bigquery-patents';
import { refreshPatentCache, type PatentRefreshDb, type PatentRefreshSummary } from '../adapters/patent-inventor-cache';

/**
 * 专利发明人缓存刷新的 Temporal 活动（scale-safe #89，第 5 个周期 Schedule 驱动）。
 * **owner 连接**（平台表 patent_* 无 RLS；app_user 无写权、source_policy 亦 owner 读）。
 * 一次共享大扫（BigQuery Job User 只读，护栏②④⑥ 下推）→ 落 postgres 缓存。空队列 → 零 BQ 成本跳过。
 * 🔴 §8.8 用途门自守 + 保留期清理 + encryptPii 落盘 均在 {@link refreshPatentCache} 内。
 */
export function createPatentsCacheActivities(deps: { ownerDb: PrismaClient }) {
  return {
    async refreshPatentCacheActivity(input?: { maxAnchors?: number }): Promise<PatentRefreshSummary> {
      return refreshPatentCache({
        db: deps.ownerDb as unknown as PatentRefreshDb, // 全 delegate ⊇ PatentRefreshDb 子集
        bq: bigqueryPatents, // env 驱动惰性建真 client；无 SA key → 天然 no-op（扫描返空）
        maxAnchors: input?.maxAnchors,
        log: (msg) => console.warn(`[patents-cache-refresh] ${msg}`),
      });
    },
  };
}

export type PatentsCacheActivities = ReturnType<typeof createPatentsCacheActivities>;
