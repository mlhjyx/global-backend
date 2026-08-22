import type { PrismaClient } from '@prisma/client';
import { refreshPatentCache, type PatentRefreshDb, type PatentRefreshSummary } from '../adapters/patent-inventor-cache';
import type { BudgetStore } from '../tools/budget-store';
import { UnavailableBudgetStore } from '../tools/budget-store';
import type { ExecutionBroker } from '../tools/tool-contract';
import type { PlatformScheduleAuthorityActivityInput } from './platform-schedule-authority';
import { attestPlatformScheduleActivity } from './platform-schedule-authority.activities';
import { createPatentCacheBrokerScanner } from './patent-cache-broker-scanner';
import { PATENTS_CACHE_REFRESH_SCHEDULE_ID } from './understanding.constants';
import {
  applyDomainAckConsumerTransactions,
} from '../durable-results/domain-ack-consumer-bindings';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';

export const PATENT_CACHE_BROKER_MAX_ANCHORS = 25;

function boundedMaxAnchors(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0
    ? Math.min(value, PATENT_CACHE_BROKER_MAX_ANCHORS)
    : PATENT_CACHE_BROKER_MAX_ANCHORS;
}

/**
 * 专利发明人缓存刷新的 Temporal 活动（scale-safe #89，第 5 个周期 Schedule 驱动）。
 * **owner 连接**（平台表 patent_* 无 RLS；app_user 无写权、source_policy 亦 owner 读）。
 * 一次共享大扫（BigQuery Job User 只读，护栏②④⑥ 下推）→ 落 postgres 缓存。空队列 → 零 BQ 成本跳过。
 * 🔴 §8.8 用途门自守 + 保留期清理 + encryptPii 落盘 均在 {@link refreshPatentCache} 内。
 */
export function createPatentsCacheActivities(deps: {
  ownerDb: PrismaClient;
  platformWriter?: PrismaClient;
  broker: ExecutionBroker;
  budgetStore?: BudgetStore;
  activityRunId?: () => string | undefined;
}) {
  const budgets = deps.budgetStore ?? new UnavailableBudgetStore('patents cache activities require an authoritative BudgetStore');
  return {
    async refreshPatentCacheActivity(input: ({ maxAnchors?: number } & PlatformScheduleAuthorityActivityInput) = {}): Promise<PatentRefreshSummary> {
      const binding = await attestPlatformScheduleActivity({
        args: input, budgetStore: budgets, scheduleId: PATENTS_CACHE_REFRESH_SCHEDULE_ID, activityRunId: deps.activityRunId,
      });
      const durableReceipts: DurableExecutionReceipt[] = [];
      return refreshPatentCache({
        db: deps.ownerDb as unknown as PatentRefreshDb, // 全 delegate ⊇ PatentRefreshDb 子集
        bq: createPatentCacheBrokerScanner({
          broker: deps.broker,
          accountKey: binding.accountKey,
          onDurableReceipt: (producerId, durableReceipt) => {
            if (producerId !== 'google_patents.search') {
              throw new Error('DOMAIN_ACK_CONSUMER_BINDING_MISSING');
            }
            durableReceipts.push(durableReceipt);
          },
        }),
        applyScanWithAck: async (scan, persist) => {
          if (!durableReceipts.length) return persist(deps.ownerDb as unknown as PatentRefreshDb);
          if (!deps.platformWriter) {
            throw new Error('DOMAIN_ACK_PLATFORM_TRANSACTION_UNAVAILABLE');
          }
          return deps.platformWriter.$transaction(async (tx) => {
            const value = await applyDomainAckConsumerTransactions({
              transaction: tx,
              acknowledgements: durableReceipts.map((durableReceipt) => ({
                producerId: 'google_patents.search',
                receipt: durableReceipt,
                domainAckKey: `${binding.accountKey}:${durableReceipt.operationId}`,
                domainRevision: durableReceipt.resultDigest,
              })),
              apply: (transaction) => persist(transaction as unknown as PatentRefreshDb),
            });
            return value ?? {
              status: 'OK',
              anchorCount: 0,
              rowCount: scan.rows.length,
              bytesScanned: scan.bytesScanned,
              purged: 0,
              cached: 0,
              empty: 0,
            };
          });
        },
        maxAnchors: boundedMaxAnchors(input.maxAnchors),
        log: (msg) => console.warn(`[patents-cache-refresh] ${msg}`),
      });
    },
  };
}

export type PatentsCacheActivities = ReturnType<typeof createPatentsCacheActivities>;
