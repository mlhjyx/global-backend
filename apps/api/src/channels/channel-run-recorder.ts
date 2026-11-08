import { ExecutionControlError } from '../execution-budget/execution-control-error';
import type { PrismaService } from '../prisma/prisma.service';
import { evaluateChannelHealth } from './channel-health';

export interface RecordChannelRunInput {
  readonly channelId: string;
  /**
   * 平台工作流运行的稳定标识（= ChannelCrawlWorkflowInput.crawlRunId）。
   * finalize 是 at-least-once 活动：携带它时按 `crawl_run_id` 唯一键收敛到同一行，
   * 重试不再推进 failureStreak（设计 2026-11-06 §4.2）。
   */
  readonly crawlRunId?: string;
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly pagesFetched: number;
  readonly recordsFound: number;
  readonly recordsMaterialized: number;
  readonly failures: number;
  readonly truncated?: boolean;
  readonly errorCode?: string;
  /** 平台发起的运行没有租户工作空间：triggered_by_workspace_id 记 NULL。 */
  readonly triggeredByWorkspaceId?: string;
}

export interface RecordedChannelRun {
  readonly runId: string;
  readonly autoDisabled: boolean;
  readonly failureStreak: number;
}

type RecorderTx = {
  sourceChannelRun: {
    findUnique: (args: never) => Promise<{ id: string } | null>;
    create: (args: never) => Promise<{ id: string }>;
    createMany: (args: never) => Promise<{ count: number }>;
    update: (args: never) => Promise<{ id: string }>;
  };
  sourceChannel: {
    findUnique: (args: never) => Promise<{
      failureStreak: number;
      status: string;
      consecutiveFailures?: number | null;
      lastSuccessAt?: Date | null;
      createdAt?: Date | null;
    } | null>;
    update: (args: never) => Promise<unknown>;
  };
  sourceChannelHealthEvent?: {
    findFirst: (args: never) => Promise<{ id: string } | null>;
    create: (args: never) => Promise<unknown>;
  };
};

/**
 * 渠道运行收尾（章节 §6.3.6.6 双层规则，同一事务内收敛）：
 *   1. 失败率规则（快）：FAILED 或 failures/pagesFetched>0.3 → 坏轮；连续 3 坏轮 → AUTO_DISABLED。
 *   2. streak 规则（长尾）：FAILED → consecutive_failures+1；SUCCEEDED → 清零 + last_success_at；
 *      ≥20 次且 ≥4 天无成功 → WARNING_20_4D 事件；≥30 次且 ≥7 天无成功 → AUTO_DISABLED(AUTO_STREAK)。
 * 两套规则互不清零；finalize 重放（同 crawlRunId）不重复推进任何计数或事件。
 */
export async function recordChannelRunInTransaction(
  tx: RecorderTx,
  input: RecordChannelRunInput,
): Promise<RecordedChannelRun> {
  const outcome = {
    status: input.status,
    pagesFetched: input.pagesFetched,
    recordsFound: input.recordsFound,
    recordsMaterialized: input.recordsMaterialized,
    failures: input.failures,
    truncated: input.truncated ?? false,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    finishedAt: new Date(),
  };
  // A finalize retry carries the same crawlRunId and the same outcome (Temporal
  // at-least-once with identical inputs); a replay hit converges the outcome onto
  // the existing row and leaves failureStreak/lastRunAt untouched — they advanced
  // once when the row was first recorded, inside that same transaction.
  let run: { id: string } | null = null;
  let replayed = false;
  if (input.crawlRunId) {
    const existing = await tx.sourceChannelRun.findUnique({
      where: { crawlRunId: input.crawlRunId },
      select: { id: true },
    } as never);
    if (existing) {
      run = await tx.sourceChannelRun.update({
        where: { crawlRunId: input.crawlRunId },
        data: outcome,
      } as never);
      replayed = true;
    } else {
      // ON CONFLICT DO NOTHING keeps a concurrent duplicate from aborting this
      // transaction (a caught unique violation would take the streak update down
      // with it); the read-back below then sees whichever row committed first.
      const created = await tx.sourceChannelRun.createMany({
        data: [
          {
            channelId: input.channelId,
            crawlRunId: input.crawlRunId,
            triggeredByWorkspaceId: input.triggeredByWorkspaceId ?? null,
            ...outcome,
          },
        ],
        skipDuplicates: true,
      } as never);
      const stored = await tx.sourceChannelRun.findUnique({
        where: { crawlRunId: input.crawlRunId },
        select: { id: true },
      } as never);
      if (!stored) throw new ExecutionControlError('CHANNEL_RUN_RECORD_UNAVAILABLE');
      run = stored;
      // count=0: a concurrent finalize won the unique key and committed first.
      replayed = created.count === 0;
    }
  }
  if (!run) {
    run = await tx.sourceChannelRun.create({
      data: {
        channelId: input.channelId,
        triggeredByWorkspaceId: input.triggeredByWorkspaceId ?? null,
        ...outcome,
      },
    } as never);
  }
  const channel = await tx.sourceChannel.findUnique({
    where: { id: input.channelId },
    select: {
      failureStreak: true,
      status: true,
      consecutiveFailures: true,
      lastSuccessAt: true,
      createdAt: true,
    },
  } as never);
  if (!channel) return { runId: run.id, autoDisabled: false, failureStreak: 0 };
  if (replayed) {
    return { runId: run.id, autoDisabled: false, failureStreak: channel.failureStreak };
  }

  const now = new Date();
  const failureRate =
    input.pagesFetched > 0
      ? input.failures / input.pagesFetched
      : input.failures > 0
        ? 1
        : 0;
  const badRound = input.status === 'FAILED' || failureRate > 0.3;
  const streak = badRound ? channel.failureStreak + 1 : 0;
  const consecutiveFailures =
    input.status === 'SUCCEEDED' ? 0 : (channel.consecutiveFailures ?? 0) + 1;
  const health = evaluateChannelHealth({
    consecutiveFailures,
    lastSuccessAt: channel.lastSuccessAt ?? null,
    fallbackSince: channel.createdAt ?? null,
    now,
  });

  const autoDisabledByRate = badRound && streak >= 3 && channel.status === 'ENABLED';
  const autoDisabledByStreak = health.action === 'AUTO_DISABLE' && channel.status === 'ENABLED';
  const autoDisabled = autoDisabledByRate || autoDisabledByStreak;
  const disabledReason = autoDisabled
    ? autoDisabledByStreak
      ? 'AUTO_STREAK'
      : 'AUTO_FAILURE_RATE'
    : undefined;

  await tx.sourceChannel.update({
    where: { id: input.channelId },
    data: {
      lastRunAt: now,
      failureStreak: streak,
      consecutiveFailures,
      ...(input.status === 'SUCCEEDED' ? { lastSuccessAt: now } : {}),
      ...(autoDisabled ? { status: 'AUTO_DISABLED', disabledReason } : {}),
    },
  } as never);

  const events = tx.sourceChannelHealthEvent;
  if (events) {
    if (autoDisabled) {
      await events.create({
        data: {
          channelId: input.channelId,
          event: autoDisabledByStreak ? 'AUTO_DISABLED_30_7D' : 'AUTO_DISABLED_FAILURE_RATE',
          detail: {
            consecutiveFailures,
            failureStreak: streak,
            lastSuccessAt: channel.lastSuccessAt?.toISOString() ?? null,
            errorCode: input.errorCode ?? null,
          },
        },
      } as never);
    } else if (health.action === 'WARNING' && channel.status === 'ENABLED') {
      const reference = channel.lastSuccessAt ?? channel.createdAt ?? new Date(0);
      const prior = await events.findFirst({
        where: {
          channelId: input.channelId,
          event: 'WARNING_20_4D',
          createdAt: { gte: reference },
        },
        select: { id: true },
      } as never);
      if (!prior) {
        await events.create({
          data: {
            channelId: input.channelId,
            event: 'WARNING_20_4D',
            detail: {
              consecutiveFailures,
              lastSuccessAt: channel.lastSuccessAt?.toISOString() ?? null,
            },
          },
        } as never);
      }
    }
  }

  return { runId: run.id, autoDisabled, failureStreak: streak };
}
