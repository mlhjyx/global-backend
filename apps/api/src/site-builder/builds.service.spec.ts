import { describe, expect, it } from 'vitest';
import {
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { BuildsService } from './builds.service';
import type { RefurbishLauncher } from './refurbish-launcher';

const CTX = { userId: 'u1', workspaceId: '11111111-1111-4111-8111-111111111111', roles: [] };
const SITE_ID = '22222222-2222-4222-8222-222222222222';

interface FakeDb {
  sites: Record<string, unknown>[];
  runs: Record<string, unknown>[];
}

function makeService(
  opts: {
    siteExists?: boolean;
    existingRuns?: Record<string, unknown>[];
    launcher?: Partial<RefurbishLauncher>;
    beforeCancelCas?: (run: Record<string, unknown>) => void;
  } = {},
) {
  const db: FakeDb = {
    sites: opts.siteExists === false ? [] : [{ id: SITE_ID, workspaceId: CTX.workspaceId }],
    runs: [...(opts.existingRuns ?? [])],
  };
  let seq = 0;
  const tx = {
    $executeRaw: async () => 0, // advisory lock no-op（intake 先例同款 fake）
    site: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        db.sites.find((s) => s.id === where.id) ?? null,
    },
    siteBuildRun: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        db.runs.find((r) => r.id === where.id) ?? null,
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.scope && typeof where.scope === 'object' && 'path' in (where.scope as object)) {
          const want = (where.scope as { equals: string }).equals;
          const notStatus = (where.NOT as { status?: string } | undefined)?.status;
          return (
            db.runs.find(
              (r) =>
                r.siteId === where.siteId &&
                (r.scope as { idempotencyKey?: string } | null)?.idempotencyKey === want &&
                (!notStatus || r.status !== notStatus),
            ) ?? null
          );
        }
        const statuses = (where.status as { in: string[] } | undefined)?.in;
        return (
          db.runs.find(
            (r) => r.siteId === where.siteId && (!statuses || statuses.includes(r.status as string)),
          ) ?? null
        );
      },
      count: async ({ where }: { where: { siteId: string; createdAt?: { gte: Date } } }) =>
        db.runs.filter(
          (r) =>
            r.siteId === where.siteId &&
            (!where.createdAt || (r.createdAt as Date) >= where.createdAt.gte),
        ).length,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `run-${++seq}`, status: 'queued', createdAt: new Date(), ...data };
        db.runs.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = db.runs.find((r) => r.id === where.id);
        if (!row) throw new Error('missing run');
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; kind?: string; status?: { in: string[] } };
        data: Record<string, unknown>;
      }) => {
        const row = db.runs.find((r) => r.id === where.id);
        if (!row) return { count: 0 };
        opts.beforeCancelCas?.(row);
        if (where.kind && row.kind !== where.kind) return { count: 0 };
        if (where.status?.in && !where.status.in.includes(row.status as string)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  };
  const prisma = {
    withWorkspace: async <T>(_ws: string, fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
  };
  const launched: string[] = [];
  const cancelled: string[] = [];
  const launcher: RefurbishLauncher = {
    launchRefurbish: async ({ buildRunId }) => {
      launched.push(buildRunId);
    },
    cancelRefurbish: async (buildRunId) => {
      cancelled.push(buildRunId);
    },
    ...opts.launcher,
  };
  const service = new BuildsService(prisma as never, launcher);
  return { service, db, launched, cancelled };
}

const BASE = { scope: 'site' as const };

describe('BuildsService.create（POST /sites/{id}/builds，07 §5 / 09 §2.2）', () => {
  it('建 run（kind=refurbish, status=queued, scope 落 Json）并触发 launcher', async () => {
    const { service, db, launched } = makeService();
    const res = await service.create(CTX, SITE_ID, {
      ...BASE,
      options: { locales: ['en', 'de'] },
    });
    expect(res.status).toBe('queued');
    const run = db.runs[0] as Record<string, unknown>;
    expect(res.buildId).toBe(run.id);
    expect(run.kind).toBe('refurbish');
    expect(run.workspaceId).toBe(CTX.workspaceId);
    expect(run.scope).toMatchObject({ scope: 'site', options: { locales: ['en', 'de'] } });
    expect(launched).toEqual([run.id]);
  });

  it('站点不存在 → 404', async () => {
    const { service } = makeService({ siteExists: false });
    await expect(service.create(CTX, SITE_ID, BASE)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('已有 queued/running run → 409（同 site 单飞，02 §4）；terminal run 不挡', async () => {
    const running = makeService({
      existingRuns: [{ id: 'r0', siteId: SITE_ID, status: 'running', createdAt: new Date() }],
    });
    const err = await running.service.create(CTX, SITE_ID, BASE).catch((e: unknown) => e);
    expect(errorContract(err)).toMatchObject({ status: 409, code: 'BUILD_IN_PROGRESS' });
    const done = makeService({
      existingRuns: [{ id: 'r0', siteId: SITE_ID, status: 'succeeded', createdAt: new Date() }],
    });
    await expect(done.service.create(CTX, SITE_ID, BASE)).resolves.toMatchObject({
      status: 'queued',
    });
  });

  it('scope=page/section 缺 targetId → 400（服务层兜底，不信 DTO）', async () => {
    const { service } = makeService();
    await expect(service.create(CTX, SITE_ID, { scope: 'page' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('Idempotency-Key 命中既有 run → 原样返回，不新建不重启', async () => {
    const { service, db, launched } = makeService();
    const first = await service.create(CTX, SITE_ID, { ...BASE, idempotencyKey: 'idem-1' });
    // 首个 run 结束后同 key 重放：仍返回同一 run，而不是再建一个
    await service.cancel(CTX, first.buildId);
    const replay = await service.create(CTX, SITE_ID, { ...BASE, idempotencyKey: 'idem-1' });
    expect(replay.buildId).toBe(first.buildId);
    expect(db.runs).toHaveLength(1);
    expect(launched).toHaveLength(1);
  });

  it('当日配额用尽 → 429 QUOTA_EXCEEDED', async () => {
    const today = new Date();
    const runs = Array.from({ length: 10 }, (_, i) => ({
      id: `old-${i}`,
      siteId: SITE_ID,
      status: 'failed',
      createdAt: today,
    }));
    const { service } = makeService({ existingRuns: runs });
    const err = await service.create(CTX, SITE_ID, BASE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(errorContract(err)).toEqual({
      status: 429,
      code: 'QUOTA_EXCEEDED',
      details: { remaining: 0 },
    });
  });

  it('launch 失败后同 Idempotency-Key 重试 → 不命中 failed 重放，真正重发新 run（复审 C4）', async () => {
    let failOnce = true;
    const { service, db } = makeService({
      launcher: {
        launchRefurbish: async () => {
          if (failOnce) {
            failOnce = false;
            throw new Error('temporal down');
          }
        },
      },
    });
    const firstError = await service
      .create(CTX, SITE_ID, { ...BASE, idempotencyKey: 'retry-1' })
      .catch((e: unknown) => e);
    expect(errorContract(firstError).code).toBe('BUILD_LAUNCH_UNAVAILABLE');
    const retry = await service.create(CTX, SITE_ID, { ...BASE, idempotencyKey: 'retry-1' });
    expect(retry.status).toBe('queued');
    expect(db.runs).toHaveLength(2); // failed 行留档，新 run 真正重发
  });

  it('launcher 抛错 → run 标 failed + 502（站点绝不删除，可重试）', async () => {
    const { service, db } = makeService({
      launcher: {
        launchRefurbish: async () => {
          throw new Error('temporal unreachable');
        },
      },
    });
    const err = await service.create(CTX, SITE_ID, BASE).catch((e: unknown) => e);
    expect(errorContract(err)).toMatchObject({ status: 502, code: 'BUILD_LAUNCH_UNAVAILABLE' });
    expect(db.sites).toHaveLength(1); // 🔴 refurbish 失败不删用户站（与 demo_v0 补偿相反）
    expect((db.runs[0] as Record<string, unknown>).status).toBe('failed');
  });
});

describe('BuildsService.get / cancel（07 §5）', () => {
  it('get：返回 run；缺失 → 404', async () => {
    const { service } = makeService({
      existingRuns: [
        {
          id: 'r1',
          siteId: SITE_ID,
          status: 'running',
          phase: 'P1_understanding',
          createdAt: new Date(),
        },
      ],
    });
    const run = await service.get(CTX, 'r1');
    expect(run).toMatchObject({ id: 'r1', phase: 'P1_understanding' });
    await expect(service.get(CTX, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('cancel：queued/running → cancelled + 通知 launcher；终态 → 409', async () => {
    const { service, db, cancelled } = makeService({
      existingRuns: [
        { id: 'r1', siteId: SITE_ID, kind: 'refurbish', status: 'running', createdAt: new Date() },
      ],
    });
    await service.cancel(CTX, 'r1');
    expect((db.runs[0] as Record<string, unknown>).status).toBe('cancelled');
    expect(cancelled).toEqual(['r1']);
    const err = await service.cancel(CTX, 'r1').catch((e: unknown) => e);
    expect(errorContract(err)).toMatchObject({ status: 409, code: 'BUILD_ALREADY_TERMINAL' });
  });

  it('cancel：demo_v0 等不可取消类型 → 409 BUILD_NOT_CANCELLABLE', async () => {
    const { service, cancelled } = makeService({
      existingRuns: [
        { id: 'r1', siteId: SITE_ID, kind: 'demo_v0', status: 'running', createdAt: new Date() },
      ],
    });
    const err = await service.cancel(CTX, 'r1').catch((e: unknown) => e);
    expect(errorContract(err)).toMatchObject({ status: 409, code: 'BUILD_NOT_CANCELLABLE' });
    expect(cancelled).toEqual([]);
  });

  it('cancel CAS：读后并发成功时不覆盖 terminal，也不通知 launcher', async () => {
    const { service, db, cancelled } = makeService({
      existingRuns: [
        { id: 'r1', siteId: SITE_ID, kind: 'refurbish', status: 'running', createdAt: new Date() },
      ],
      beforeCancelCas: (row) => {
        row.status = 'succeeded';
        row.finishedAt = new Date('2026-07-17T00:00:00.000Z');
      },
    });

    const err = await service.cancel(CTX, 'r1').catch((e: unknown) => e);

    expect(errorContract(err)).toMatchObject({
      status: 409,
      code: 'BUILD_ALREADY_TERMINAL',
      details: { status: 'succeeded' },
    });
    expect(db.runs[0]).toMatchObject({ status: 'succeeded' });
    expect(cancelled).toEqual([]);
  });

  it('cancel：launcher 取消失败不影响状态落库（best-effort）', async () => {
    const { service, db } = makeService({
      existingRuns: [
        { id: 'r1', siteId: SITE_ID, kind: 'refurbish', status: 'queued', createdAt: new Date() },
      ],
      launcher: {
        cancelRefurbish: async () => {
          throw new Error('handle gone');
        },
      },
    });
    await service.cancel(CTX, 'r1');
    expect((db.runs[0] as Record<string, unknown>).status).toBe('cancelled');
  });
});

function errorContract(err: unknown): {
  status?: number;
  code?: string;
  details?: Record<string, unknown>;
} {
  if (!(err instanceof HttpException)) return {};
  const body = err.getResponse() as {
    error?: { code?: string; details?: Record<string, unknown> };
  };
  return {
    status: err.getStatus(),
    code: body.error?.code,
    ...(body.error?.details ? { details: body.error.details } : {}),
  };
}
