import type { PrismaService } from '../prisma/prisma.service';

export interface RecordChannelRunInput {
  readonly channelId: string;
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
    sourceChannelRun: { create: (args: never) => Promise<{ id: string }> };
    sourceChannel: {
      findUnique: (args: never) => Promise<{ failureStreak: number; status: string } | null>;
      update: (args: never) => Promise<unknown>;
    };
  },
  input: RecordChannelRunInput,
): Promise<RecordedChannelRun> {
  const run = await tx.sourceChannelRun.create({
    data: {
      channelId: input.channelId,
      triggeredByWorkspaceId: input.triggeredByWorkspaceId ?? null,
      status: input.status,
      pagesFetched: input.pagesFetched,
      recordsFound: input.recordsFound,
      recordsMaterialized: input.recordsMaterialized,
      failures: input.failures,
      truncated: input.truncated ?? false,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      finishedAt: new Date(),
    },
  } as never);
  const channel = await tx.sourceChannel.findUnique({
    where: { id: input.channelId },
    select: { failureStreak: true, status: true },
  } as never);
  if (!channel) return { runId: run.id, autoDisabled: false, failureStreak: 0 };
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
