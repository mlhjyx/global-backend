import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { buildStepReadModel, recordBuildProgress } from './build-progress';

describe('buildStepReadModel', () => {
  it('uses only the latest attempt per item and aggregates degraded state', () => {
    const at = new Date('2026-07-17T00:00:00Z');
    const model = buildStepReadModel([
      {
        key: 'image_pipeline',
        itemKey: 'a',
        attempt: 1,
        status: 'failed',
        progress: 0.3,
        degraded: false,
        errorCode: 'OLD',
        startedAt: at,
        finishedAt: at,
      },
      {
        key: 'image_pipeline',
        itemKey: 'a',
        attempt: 2,
        status: 'done',
        progress: 0.4,
        degraded: false,
        errorCode: null,
        startedAt: at,
        finishedAt: at,
      },
      {
        key: 'image_pipeline',
        itemKey: 'b',
        attempt: 1,
        status: 'degraded',
        progress: 0.5,
        degraded: true,
        errorCode: 'IMAGE_DEGRADED',
        startedAt: at,
        finishedAt: at,
      },
    ]) as unknown as Array<Record<string, unknown>>;
    expect(model.find((step) => step.key === 'image_pipeline')).toMatchObject({
      status: 'degraded',
      attempt: 2,
      progress: 0.5,
      degraded: true,
      itemCount: 2,
    });
    expect(model.find((step) => step.key === 'kb_ingest')).toMatchObject({
      status: 'queued',
      progress: 0,
    });
  });
});

describe('recordBuildProgress', () => {
  it('rejects late attempts and never moves phase or progress backwards', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const run = {
      status: 'running',
      phase: 'P2_assets',
      progress: 0.5,
      steps: null as unknown,
    };
    type UpsertArgs = {
      where: { buildRunId_key_itemKey_attempt: Record<string, unknown> };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    const upsert = vi.fn(async ({ where, create, update }: UpsertArgs) => {
      const identity = where.buildRunId_key_itemKey_attempt;
      const found = rows.find(
        (row) =>
          row.buildRunId === identity.buildRunId &&
          row.key === identity.key &&
          row.itemKey === identity.itemKey &&
          row.attempt === identity.attempt,
      );
      if (found) Object.assign(found, update);
      else rows.push({ id: `step-${rows.length + 1}`, ...create });
      return found ?? rows.at(-1);
    });
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      siteBuildRun: {
        findUnique: vi.fn(async () => ({ ...run })),
        updateMany: vi.fn(
          async ({ data }: { data: Record<string, unknown> }) => {
            Object.assign(run, data);
            return { count: 1 };
          },
        ),
      },
      siteBuildStep: {
        findFirst: vi.fn(
          async ({ where }: { where: Record<string, unknown> }) => {
            return (
              rows
                .filter(
                  (row) =>
                    row.buildRunId === where.buildRunId &&
                    row.key === where.key &&
                    row.itemKey === where.itemKey,
                )
                .sort((a, b) => Number(b.attempt) - Number(a.attempt))[0] ??
              null
            );
          },
        ),
        upsert,
        findMany: vi.fn(async () => rows),
      },
    };
    const prisma = {
      withWorkspace: async (
        _workspaceId: string,
        fn: (client: typeof tx) => Promise<unknown>,
      ) => fn(tx),
    } as unknown as PrismaService;
    const input = { workspaceId: 'ws-1', buildRunId: 'run-1' };

    await recordBuildProgress(prisma, input, {
      key: 'image_pipeline',
      itemKey: 'batch-a',
      attempt: 2,
      status: 'done',
      phase: 'P2_assets',
      progress: 0.6,
    });
    await recordBuildProgress(prisma, input, {
      key: 'image_pipeline',
      itemKey: 'batch-a',
      attempt: 1,
      status: 'failed',
      phase: 'P1_understanding',
      progress: 0.2,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      attempt: 2,
      status: 'done',
      progress: 0.6,
    });
    expect(run).toMatchObject({ phase: 'P2_assets', progress: 0.6 });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('keeps running and done writes on one logical attempt and makes a terminal result immutable', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const run = {
      status: 'running',
      phase: 'P1_understanding',
      progress: 0.1,
      steps: null as unknown,
    };
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      siteBuildRun: {
        findUnique: vi.fn(async () => ({ ...run })),
        updateMany: vi.fn(
          async ({ data }: { data: Record<string, unknown> }) => {
            Object.assign(run, data);
            return { count: 1 };
          },
        ),
      },
      siteBuildStep: {
        findFirst: vi.fn(async () => rows.at(-1) ?? null),
        upsert: vi.fn(
          async ({
            create,
            update,
          }: {
            create: Record<string, unknown>;
            update: Record<string, unknown>;
          }) => {
            if (rows[0]) Object.assign(rows[0], update);
            else rows.push({ id: 'step-1', ...create });
            return rows[0];
          },
        ),
        findMany: vi.fn(async () => rows),
      },
    };
    const prisma = {
      withWorkspace: async (
        _workspaceId: string,
        fn: (client: typeof tx) => Promise<unknown>,
      ) => fn(tx),
    } as unknown as PrismaService;
    const input = { workspaceId: 'ws-1', buildRunId: 'run-1' };

    await recordBuildProgress(prisma, input, {
      key: 'kb_ingest',
      status: 'running',
      phase: 'P1_understanding',
      progress: 0.1,
    });
    await recordBuildProgress(prisma, input, {
      key: 'kb_ingest',
      status: 'done',
      phase: 'P1_understanding',
      progress: 0.2,
    });
    await recordBuildProgress(prisma, input, {
      key: 'kb_ingest',
      status: 'failed',
      phase: 'P1_understanding',
      progress: 0.3,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      attempt: 1,
      status: 'done',
      progress: 0.2,
    });
  });
});
