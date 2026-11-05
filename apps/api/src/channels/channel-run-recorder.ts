import type { PrismaService } from '../prisma/prisma.service';

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

/** 渠道运行收尾的事务体；调用方决定租户上下文（withWorkspace）或平台上下文。 */
export async function recordChannelRunInTransaction(
  tx: {
    sourceChannelRun: {
      findUnique: (args: never) => Promise<{ id: string } | null>;
      create: (args: never) => Promise<{ id: string }>;
      update: (args: never) => Promise<{ id: string }>;
    };
    sourceChannel: {
      findUnique: (args: never) => Promise<{ failureStreak: number; status: string } | null>;
      update: (args: never) => Promise<unknown>;
    };
  },
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
  // A finalize retry carries the same crawlRunId: converge the outcome onto the
  // existing row and leave the failure streak untouched (it advanced once when
  // the row was first recorded, inside that same transaction).
  let run: { id: string } | null = null;
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
    }
  }
  const replayed = run !== null;
  if (!run) {
    run = await tx.sourceChannelRun.create({
      data: {
        channelId: input.channelId,
        ...(input.crawlRunId ? { crawlRunId: input.crawlRunId } : {}),
        triggeredByWorkspaceId: input.triggeredByWorkspaceId ?? null,
        ...outcome,
      },
    } as never);
  }
  const channel = await tx.sourceChannel.findUnique({
    where: { id: input.channelId },
    select: { failureStreak: true, status: true },
  } as never);
  if (!channel) return { runId: run.id, autoDisabled: false, failureStreak: 0 };
  if (replayed) {
    return { runId: run.id, autoDisabled: false, failureStreak: channel.failureStreak };
  }
  const failureRate =
    input.pagesFetched > 0
      ? input.failures / input.pagesFetched
      : input.failures > 0
        ? 1
        : 0;
  const badRound = input.status === 'FAILED' || failureRate > 0.3;
  const streak = badRound ? channel.failureStreak + 1 : 0;
  const autoDisabled =
    badRound && streak >= 3 && channel.status === 'ENABLED';
  await tx.sourceChannel.update({
    where: { id: input.channelId },
    data: {
      lastRunAt: new Date(),
      failureStreak: streak,
      ...(autoDisabled ? { status: 'AUTO_DISABLED' } : {}),
    },
  } as never);
  return { runId: run.id, autoDisabled, failureStreak: streak };
}
