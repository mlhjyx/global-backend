import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import {
  createSiteBuilderActivities,
  buildCompensatedSteps,
  RefurbishActivityInput,
  RefurbishFinalizeInput,
} from './site-builder.activities';
import { budgetLedger, siteBuildBudgetCents } from '../tools/budget';

/**
 * M1-b fast-follow 改动 1（预算门接线）+ 改动 3（补偿路径 steps 回填）。
 * - 预算门：begin 认领成功后 close-then-open（清跨-retry 残留，镜像 discovery resetRunBudget）；
 *   finalize/compensate 各在末尾 force close。open/close 只能在活动里（worker 进程持有 ledger 单例）。
 * - steps 回填：compensate 转 failed 时按 brandProfile DB 探测补 brand_profile done/aborted，其余 aborted。
 */

const INPUT: RefurbishActivityInput = { workspaceId: 'ws-1', siteId: 'site-1', buildRunId: 'run-1' };

const REFURBISH_KEYS = [
  'kb_ingest',
  'brand_profile',
  'image_pipeline',
  'copy',
  'assemble_build',
  'quality_loop',
];

const PENDING_STEPS = [
  { key: 'kb_ingest', status: 'pending' },
  { key: 'brand_profile', status: 'pending' },
  { key: 'image_pipeline', status: 'pending_m1c' },
  { key: 'copy', status: 'pending_m1d' },
  { key: 'assemble_build', status: 'pending' },
  { key: 'quality_loop', status: 'pending_m1f' },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakePrisma(tx: any): PrismaService {
  return {
    withWorkspace: vi.fn(async (_ws: string, fn: (t: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;
}

function spyBudget() {
  const open = vi.spyOn(budgetLedger, 'open').mockImplementation(() => {});
  const close = vi.spyOn(budgetLedger, 'close').mockImplementation(() => {});
  return { open, close };
}

afterEach(() => vi.restoreAllMocks());

describe('beginRefurbishRun — 预算门接线（改动 1）', () => {
  it('认领成功 → close(force) 后 open(buildRunId, siteBuildBudgetCents())', async () => {
    const { open, close } = spyBudget();
    const tx = {
      site: { findUnique: vi.fn(async () => ({ id: 'site-1' })), update: vi.fn(async () => ({})) },
      siteBuildRun: { updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.beginRefurbishRun(INPUT);
    expect(close).toHaveBeenCalledWith('run-1', { force: true });
    expect(open).toHaveBeenCalledWith('run-1', siteBuildBudgetCents());
    // close 在 open 之前（清残留再开新账）
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]);
  });

  it('认领失败（count=0）→ 抛错且 open 不被调用（失败 claim 先抛）', async () => {
    const { open } = spyBudget();
    const tx = {
      site: { findUnique: vi.fn(async () => ({ id: 'site-1' })), update: vi.fn() },
      siteBuildRun: { updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await expect(acts.beginRefurbishRun(INPUT)).rejects.toThrow(/not claimable/);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('finalizeRefurbish — 末尾 force close（改动 1）', () => {
  it('发布成功 → close(buildRunId, {force:true})', async () => {
    const { close } = spyBudget();
    const tx = {
      siteBuildRun: { updateMany: vi.fn(async () => ({ count: 1 })) },
      site: { update: vi.fn(async () => ({})) },
    };
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    const input: RefurbishFinalizeInput = {
      ...INPUT,
      kb: { processed: 1, failed: 0, degraded: false },
      profile: { status: 'done', gaps: 0 },
      build: { previewSlug: 'acme', versionId: 'v-1' },
    };
    await acts.finalizeRefurbish(input);
    expect(close).toHaveBeenCalledWith('run-1', { force: true });
  });
});

describe('compensateRefurbish — 末尾 force close + steps 回填（改动 1+3）', () => {
  function compensateTx(over: {
    runStatus?: string;
    startedAt?: Date | null;
    brandProfile?: unknown;
    steps?: unknown;
  }) {
    const runUpdate = vi.fn(async () => ({}));
    const findFirst = vi.fn(async () => over.brandProfile ?? null);
    const tx = {
      siteVersion: { updateMany: vi.fn(async () => ({ count: 0 })) },
      site: {
        findUnique: vi.fn(async () => ({ id: 'site-1', activeVersionId: null })),
        update: vi.fn(async () => ({})),
      },
      siteBuildRun: {
        findUnique: vi.fn(async () => ({
          status: over.runStatus ?? 'running',
          startedAt: over.startedAt === undefined ? new Date('2026-07-14T00:00:00.000Z') : over.startedAt,
          error: null,
          finishedAt: null,
          steps: over.steps ?? PENDING_STEPS,
        })),
        update: runUpdate,
      },
      brandProfile: { findFirst },
    };
    return { tx, runUpdate, findFirst };
  }

  it('转 failed 时 always force close', async () => {
    const { close } = spyBudget();
    const { tx } = compensateTx({});
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish(INPUT);
    expect(close).toHaveBeenCalledWith('run-1', { force: true });
  });

  it('brandProfile 存在（createdAt>=startedAt）→ brand_profile:done，其余 aborted，保留 6 步键序', async () => {
    spyBudget();
    const { tx, runUpdate, findFirst } = compensateTx({ brandProfile: { id: 'bp-1' } });
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish(INPUT);
    expect(findFirst).toHaveBeenCalledWith({
      where: { siteId: 'site-1', createdAt: { gte: new Date('2026-07-14T00:00:00.000Z') } },
    });
    const data = runUpdate.mock.calls[0][0].data as {
      status: string;
      steps: { key: string; status: string }[];
    };
    expect(data.status).toBe('failed');
    expect(data.steps.map((s) => s.key)).toEqual(REFURBISH_KEYS);
    expect(data.steps.find((s) => s.key === 'brand_profile')?.status).toBe('done');
    expect(
      data.steps.filter((s) => s.key !== 'brand_profile').every((s) => s.status === 'aborted'),
    ).toBe(true);
  });

  it('brandProfile 缺席 → brand_profile:aborted（全部 aborted）', async () => {
    spyBudget();
    const { tx, runUpdate } = compensateTx({ brandProfile: null });
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish(INPUT);
    const data = runUpdate.mock.calls[0][0].data as { steps: { key: string; status: string }[] };
    expect(data.steps.find((s) => s.key === 'brand_profile')?.status).toBe('aborted');
    expect(data.steps.every((s) => s.status === 'aborted')).toBe(true);
  });

  it('run 已 succeeded → 不改状态、不写 steps、不查 brandProfile（守卫），但仍 force close', async () => {
    const { close } = spyBudget();
    const { tx, runUpdate, findFirst } = compensateTx({ runStatus: 'succeeded' });
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish(INPUT);
    expect(runUpdate).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith('run-1', { force: true });
  });

  it('startedAt 为 null（无从归属）→ brand_profile:aborted，不发探测查询', async () => {
    spyBudget();
    const { tx, runUpdate, findFirst } = compensateTx({ startedAt: null, brandProfile: { id: 'stale' } });
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish(INPUT);
    expect(findFirst).not.toHaveBeenCalled(); // startedAt 缺失不查（不误认领旧版本）
    const data = runUpdate.mock.calls[0][0].data as { steps: { key: string; status: string }[] };
    expect(data.steps.find((s) => s.key === 'brand_profile')?.status).toBe('aborted');
  });
});

describe('buildCompensatedSteps — 纯函数两分支', () => {
  it('brandProfileDone=true → brand_profile:done，其余 aborted，键序不变', () => {
    const steps = buildCompensatedSteps(PENDING_STEPS, true);
    expect(steps.map((s) => s.key)).toEqual(REFURBISH_KEYS);
    expect(steps.find((s) => s.key === 'brand_profile')?.status).toBe('done');
    expect(steps.filter((s) => s.key !== 'brand_profile').every((s) => s.status === 'aborted')).toBe(true);
  });

  it('brandProfileDone=false → 全部 aborted', () => {
    const steps = buildCompensatedSteps(PENDING_STEPS, false);
    expect(steps.every((s) => s.status === 'aborted')).toBe(true);
  });

  it('已完成（done/degraded）的非 brand_profile 步骤原样保留（不误抹为 aborted）', () => {
    const prior = [
      { key: 'kb_ingest', status: 'done' },
      { key: 'brand_profile', status: 'pending' },
      { key: 'assemble_build', status: 'degraded' },
    ];
    const steps = buildCompensatedSteps(prior, false);
    expect(steps.find((s) => s.key === 'kb_ingest')?.status).toBe('done');
    expect(steps.find((s) => s.key === 'assemble_build')?.status).toBe('degraded');
    expect(steps.find((s) => s.key === 'brand_profile')?.status).toBe('aborted');
  });

  it('非数组 steps（null）→ 6 步全 aborted（brand_profile 按入参）', () => {
    const steps = buildCompensatedSteps(null, false);
    expect(steps.map((s) => s.key)).toEqual(REFURBISH_KEYS);
    expect(steps.every((s) => s.status === 'aborted')).toBe(true);
  });
});
