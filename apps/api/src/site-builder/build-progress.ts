import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

export const BUILD_PHASES = [
  'P1_understanding',
  'P2_assets',
  'P3_assembly',
  'P5_publish',
] as const;
export type BuildPhase = (typeof BUILD_PHASES)[number];

export const BUILD_STEP_KEYS = [
  'kb_ingest',
  'brand_profile',
  'image_pipeline',
  'copy',
  'assemble_build',
  'quality_loop',
] as const;
export type BuildStepKey = (typeof BUILD_STEP_KEYS)[number];
export type BuildStepStatus =
  'queued' | 'running' | 'done' | 'degraded' | 'failed' | 'skipped' | 'aborted';

export interface BuildProgressInput {
  workspaceId: string;
  buildRunId: string;
}

export interface BuildProgressEvent {
  key: BuildStepKey;
  itemKey?: string;
  attempt?: number;
  status: BuildStepStatus;
  phase: BuildPhase;
  progress: number;
  errorCode?: string | null;
}

const PHASE_RANK = new Map(BUILD_PHASES.map((phase, index) => [phase, index]));
const STATUS_RANK: Record<BuildStepStatus, number> = {
  queued: 0,
  running: 1,
  done: 2,
  degraded: 2,
  failed: 2,
  skipped: 2,
  aborted: 2,
};
const TERMINAL_STEP = new Set<BuildStepStatus>([
  'done',
  'degraded',
  'failed',
  'skipped',
  'aborted',
]);

function publicStatus(statuses: BuildStepStatus[]): BuildStepStatus {
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('queued')) return 'queued';
  if (statuses.includes('aborted')) return 'aborted';
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.length > 0 && statuses.every((status) => status === 'skipped'))
    return 'skipped';
  return 'done';
}

type StepRow = {
  key: string;
  itemKey: string;
  attempt: number;
  status: string;
  progress: number;
  degraded: boolean;
  errorCode: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
};

export function buildStepReadModel(rows: StepRow[]): Prisma.InputJsonValue {
  const latest = new Map<string, StepRow>();
  for (const row of rows) {
    const identity = `${row.key}\u0000${row.itemKey}`;
    const prior = latest.get(identity);
    if (!prior || row.attempt > prior.attempt) latest.set(identity, row);
  }
  const groups = new Map<string, StepRow[]>();
  for (const row of latest.values()) {
    const group = groups.get(row.key) ?? [];
    group.push(row);
    groups.set(row.key, group);
  }
  return BUILD_STEP_KEYS.map((key) => {
    const group = groups.get(key) ?? [];
    const statuses = group.map((row) => row.status as BuildStepStatus);
    const started = group
      .map((row) => row.startedAt)
      .filter((value): value is Date => value !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const finished = group
      .map((row) => row.finishedAt)
      .filter((value): value is Date => value !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    return {
      key,
      status: group.length === 0 ? 'queued' : publicStatus(statuses),
      attempt: Math.max(1, ...group.map((row) => row.attempt)),
      progress: Math.max(0, ...group.map((row) => row.progress)),
      degraded: group.some((row) => row.degraded),
      itemCount: group.length,
      ...(started ? { startedAt: started.toISOString() } : {}),
      ...(finished ? { finishedAt: finished.toISOString() } : {}),
      ...(group.find((row) => row.errorCode)?.errorCode
        ? { errorCode: group.find((row) => row.errorCode)!.errorCode }
        : {}),
    };
  }) as unknown as Prisma.InputJsonValue;
}

/**
 * Records one Activity attempt and advances the public BuildRun read model in the same transaction.
 * SiteBuildRun is locked first, so late/older attempts can never move phase/progress/step backwards.
 */
export async function recordBuildProgress(
  prisma: PrismaService,
  input: BuildProgressInput,
  event: BuildProgressEvent,
): Promise<void> {
  // `recordRefurbishProgress` is a separate Temporal Activity from the work it records.
  // Its own retry attempt must never become the logical step attempt: after an ACK-loss retry,
  // the following `done` call would otherwise look older than the preceding `running` call.
  const attempt = event.attempt ?? 1;
  const itemKey = event.itemKey ?? '';
  const progress = Math.max(0, Math.min(1, event.progress));
  await prisma.withWorkspace(input.workspaceId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-progress-${input.buildRunId}`}))`;
    const run = await tx.siteBuildRun.findUnique({
      where: { id: input.buildRunId },
      select: { status: true, phase: true, progress: true },
    });
    if (!run) throw new Error(`build run ${input.buildRunId} not found`);
    if (!['queued', 'running'].includes(run.status)) return;

    const latest = await tx.siteBuildStep.findFirst({
      where: { buildRunId: input.buildRunId, key: event.key, itemKey },
      orderBy: { attempt: 'desc' },
    });
    if (latest && latest.attempt > attempt) return;
    if (
      latest?.attempt === attempt &&
      (STATUS_RANK[latest.status as BuildStepStatus] >
        STATUS_RANK[event.status] ||
        (TERMINAL_STEP.has(latest.status as BuildStepStatus) &&
          latest.status !== event.status))
    ) {
      return;
    }

    const now = new Date();
    await tx.siteBuildStep.upsert({
      where: {
        buildRunId_key_itemKey_attempt: {
          buildRunId: input.buildRunId,
          key: event.key,
          itemKey,
          attempt,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        buildRunId: input.buildRunId,
        key: event.key,
        itemKey,
        attempt,
        status: event.status,
        phase: event.phase,
        progress,
        degraded: event.status === 'degraded',
        errorCode: event.errorCode ?? null,
        startedAt: event.status === 'queued' ? null : now,
        finishedAt: TERMINAL_STEP.has(event.status) ? now : null,
      },
      update: {
        status: event.status,
        phase: event.phase,
        progress: Math.max(latest?.progress ?? 0, progress),
        degraded: latest?.degraded || event.status === 'degraded',
        errorCode: event.errorCode ?? latest?.errorCode ?? null,
        startedAt:
          latest?.startedAt ?? (event.status === 'queued' ? null : now),
        finishedAt: TERMINAL_STEP.has(event.status)
          ? (latest?.finishedAt ?? now)
          : null,
      },
    });

    const rows = await tx.siteBuildStep.findMany({
      where: { buildRunId: input.buildRunId },
      orderBy: [{ key: 'asc' }, { itemKey: 'asc' }, { attempt: 'asc' }],
      select: {
        key: true,
        itemKey: true,
        attempt: true,
        status: true,
        progress: true,
        degraded: true,
        errorCode: true,
        startedAt: true,
        finishedAt: true,
      },
    });
    const currentRank = PHASE_RANK.get(run.phase as BuildPhase) ?? -1;
    const nextRank = PHASE_RANK.get(event.phase) ?? -1;
    await tx.siteBuildRun.updateMany({
      where: { id: input.buildRunId, status: { in: ['queued', 'running'] } },
      data: {
        phase: nextRank >= currentRank ? event.phase : run.phase,
        progress: Math.max(run.progress, progress),
        steps: buildStepReadModel(rows),
      },
    });
  });
}

export async function terminalizeBuildProgress(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    buildRunId: string;
    phase: BuildPhase;
    progress: number;
  },
): Promise<Prisma.InputJsonValue> {
  const rows = await tx.siteBuildStep.findMany({
    where: { buildRunId: input.buildRunId },
    orderBy: [{ key: 'asc' }, { itemKey: 'asc' }, { attempt: 'asc' }],
  });
  const now = new Date();
  await tx.siteBuildStep.updateMany({
    where: {
      buildRunId: input.buildRunId,
      status: { in: ['queued', 'running'] },
    },
    data: {
      status: 'aborted',
      phase: input.phase,
      progress: input.progress,
      finishedAt: now,
    },
  });
  const existingKeys = new Set(rows.map((row) => row.key));
  for (const key of BUILD_STEP_KEYS) {
    if (!existingKeys.has(key)) {
      await tx.siteBuildStep.create({
        data: {
          workspaceId: input.workspaceId,
          buildRunId: input.buildRunId,
          key,
          itemKey: '',
          attempt: 1,
          status: 'aborted',
          phase: input.phase,
          progress: input.progress,
          startedAt: null,
          finishedAt: now,
        },
      });
    }
  }
  const terminalRows = await tx.siteBuildStep.findMany({
    where: { buildRunId: input.buildRunId },
    orderBy: [{ key: 'asc' }, { itemKey: 'asc' }, { attempt: 'asc' }],
    select: {
      key: true,
      itemKey: true,
      attempt: true,
      status: true,
      progress: true,
      degraded: true,
      errorCode: true,
      startedAt: true,
      finishedAt: true,
    },
  });
  return buildStepReadModel(terminalRows);
}
