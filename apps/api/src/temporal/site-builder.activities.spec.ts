import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import {
  createSiteBuilderActivities,
  buildCompensatedSteps,
  RefurbishActivityInput,
  RefurbishFinalizeInput,
} from './site-builder.activities';
import { budgetLedger, siteBuildBudgetCents } from '../tools/budget';
import type { ModelGateway } from '../model-gateway/model-gateway';

/**
 * M1-b fast-follow 改动 1（预算门接线）+ 改动 3（补偿路径 steps 回填）。
 * - 预算门：begin 认领成功后 close-then-open（清跨-retry 残留，镜像 discovery resetRunBudget）；
 *   finalize/compensate 各在末尾 force close。open/close 只能在活动里（worker 进程持有 ledger 单例）。
 * - steps 回填：compensate 转 failed 时按 brandProfile / siteVersion DB 探测补 brand_profile、
 *   assemble_build done/aborted，其余步骤 aborted（只报 DB 可核验的完成位）。
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

// FIX A/B 用最小 intake（buildDemoSpec/polishCopy 只取 company/products/targetMarkets）。
const INTAKE = {
  company: { nameZh: '安可', nameEn: 'Acme' },
  industry: 'pumps',
  products: ['pumps'],
  targetMarkets: ['DE'],
  hasWebsite: false,
  businessEmail: 'sales@acme.com',
};

/** gateway 桩：generateStructured 记录调用 ctx，返回合法 polish（供 sanitizePolish 透传）。 */
function fakeGateway() {
  const generateStructured = vi.fn(async (_input: unknown, _ctx: unknown) => ({
    data: { headline: 'H', subhead: 'S', aboutBody: 'A' },
    model: 'stub',
  }));
  return { gateway: { generateStructured } as unknown as ModelGateway, generateStructured };
}

/** assembleAndBuild 用 prisma 桩：首个 withWorkspace 返回站点（existing=null），
 *  第二个（写版本行）抛错——停在 runAstroBuild 之前，令用例只覆盖 polishCopy/入口逻辑。 */
function assembleStopAfterPolishPrisma(site: unknown): PrismaService {
  let call = 0;
  return {
    withWorkspace: vi.fn(async (_ws: string, fn: (t: unknown) => unknown) => {
      call += 1;
      if (call === 1) {
        return fn({
          siteBuildRun: { updateMany: vi.fn(async () => ({ count: 1 })) },
          site: { findUnique: vi.fn(async () => site) },
          siteVersion: { findFirst: vi.fn(async () => null) },
        });
      }
      throw new Error('stop-after-polish');
    }),
  } as unknown as PrismaService;
}

describe('polishCopy — 计入 run 预算账户（FIX A / Codex P2）', () => {
  it('assembleAndBuild 调 polishCopy → gateway ctx.runId=buildRunId（refurbish demo_copy 计账）', async () => {
    spyBudget(); // 隔离真实 ledger（本用例只验 gateway ctx）
    const { gateway, generateStructured } = fakeGateway();
    const site = { id: 'site-1', name: 'Acme', slug: 'acme', stylePreset: 'clean', intake: INTAKE };
    const acts = createSiteBuilderActivities({ prisma: assembleStopAfterPolishPrisma(site), gateway });
    await expect(acts.assembleAndBuild(INPUT)).rejects.toThrow('stop-after-polish');
    expect(generateStructured).toHaveBeenCalledTimes(1);
    const ctxArg = generateStructured.mock.calls[0][1] as { workspaceId: string; runId?: string };
    expect(ctxArg.runId).toBe('run-1'); // 归账键：refurbish demo_copy 计入 buildRunId 上限
    expect(ctxArg.workspaceId).toBe('ws-1');
  });
});

describe('入口幂等 open 预算账户（FIX B / Codex P2 · worker 重启鲁棒）', () => {
  // 用真实 budgetLedger 观测（不 mock open/close）：begin 只在 beginRefurbishRun 开账，
  // 换 worker/重启后的后续活动会发现无账户 → reserve 返回不限额 → 预算门被绕过。故每个耗费活动入口须幂等 open。
  it('assembleAndBuild 账户未预开 → 进入活动即立账（remaining=cap，非 Infinity）', async () => {
    expect(budgetLedger.remainingCents('run-1')).toBe(Infinity); // 前置：无账户
    const prisma = {
      withWorkspace: vi.fn(async () => {
        throw new Error('stop');
      }),
    } as unknown as PrismaService;
    const acts = createSiteBuilderActivities({ prisma });
    await expect(acts.assembleAndBuild(INPUT)).rejects.toThrow('stop');
    expect(budgetLedger.remainingCents('run-1')).toBe(siteBuildBudgetCents()); // 入口已 open
    budgetLedger.close('run-1', { force: true }); // 清理，避免跨用例泄漏
  });

  it('buildBrandProfile 账户未预开 → 入口立账（即便随后 gateway 缺席抛错）', async () => {
    expect(budgetLedger.remainingCents('run-1')).toBe(Infinity);
    const acts = createSiteBuilderActivities({ prisma: {} as PrismaService }); // 无 gateway
    await expect(acts.buildBrandProfile(INPUT)).rejects.toThrow(/gateway unavailable/);
    expect(budgetLedger.remainingCents('run-1')).toBe(siteBuildBudgetCents());
    budgetLedger.close('run-1', { force: true });
  });
});

describe('compensateRefurbish — 末尾 force close + steps 回填（改动 1+3）', () => {
  function compensateTx(over: {
    runStatus?: string;
    startedAt?: Date | null;
    brandProfile?: unknown;
    siteVersion?: unknown;
    steps?: unknown;
  }) {
    const runUpdate = vi.fn(async () => ({}));
    const findFirst = vi.fn(async () => over.brandProfile ?? null);
    const svFindFirst = vi.fn(async () => over.siteVersion ?? null);
    const tx = {
      siteVersion: { updateMany: vi.fn(async () => ({ count: 0 })), findFirst: svFindFirst },
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
    return { tx, runUpdate, findFirst, svFindFirst };
  }

  it('转 failed 时 always force close', async () => {
    const { close } = spyBudget();
    const { tx } = compensateTx({});
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish(INPUT);
    expect(close).toHaveBeenCalledWith('run-1', { force: true });
  });

  it('brandProfile 存在 + siteVersion succeeded 存在 → brand_profile+assemble_build 均 done，其余 aborted，保留 6 步键序', async () => {
    spyBudget();
    const { tx, runUpdate, findFirst, svFindFirst } = compensateTx({
      brandProfile: { id: 'bp-1' },
      siteVersion: { id: 'sv-1' },
    });
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish(INPUT);
    expect(findFirst).toHaveBeenCalledWith({
      where: { siteId: 'site-1', createdAt: { gte: new Date('2026-07-14T00:00:00.000Z') } },
    });
    // assemble_build 完成靠 siteVersion 行核验（buildRunId 唯一定位，无需 startedAt）
    expect(svFindFirst).toHaveBeenCalledWith({
      where: { buildRunId: 'run-1', buildStatus: 'succeeded' },
    });
    const data = runUpdate.mock.calls[0][0].data as {
      status: string;
      steps: { key: string; status: string }[];
    };
    expect(data.status).toBe('failed');
    expect(data.steps.map((s) => s.key)).toEqual(REFURBISH_KEYS);
    expect(data.steps.find((s) => s.key === 'brand_profile')?.status).toBe('done');
    expect(data.steps.find((s) => s.key === 'assemble_build')?.status).toBe('done');
    expect(
      data.steps
        .filter((s) => s.key !== 'brand_profile' && s.key !== 'assemble_build')
        .every((s) => s.status === 'aborted'),
    ).toBe(true);
  });

  it('brandProfile 存在 + 无 succeeded siteVersion → brand_profile done、assemble_build aborted（其余 aborted）', async () => {
    spyBudget();
    const { tx, runUpdate } = compensateTx({ brandProfile: { id: 'bp-1' }, siteVersion: null });
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish(INPUT);
    const data = runUpdate.mock.calls[0][0].data as { steps: { key: string; status: string }[] };
    expect(data.steps.find((s) => s.key === 'brand_profile')?.status).toBe('done');
    expect(data.steps.find((s) => s.key === 'assemble_build')?.status).toBe('aborted');
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

  it('run 已 succeeded → 不改状态、不写 steps、不查 brandProfile/siteVersion（守卫），但仍 force close', async () => {
    const { close } = spyBudget();
    const { tx, runUpdate, findFirst, svFindFirst } = compensateTx({ runStatus: 'succeeded' });
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish(INPUT);
    expect(runUpdate).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
    expect(svFindFirst).not.toHaveBeenCalled();
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

describe('buildCompensatedSteps — 纯函数（两个 DB 可核验完成位）', () => {
  it('(true,true) → brand_profile+assemble_build done，其余 aborted，键序不变', () => {
    const steps = buildCompensatedSteps(true, true);
    expect(steps.map((s) => s.key)).toEqual(REFURBISH_KEYS);
    expect(steps.find((s) => s.key === 'brand_profile')?.status).toBe('done');
    expect(steps.find((s) => s.key === 'assemble_build')?.status).toBe('done');
    expect(
      steps
        .filter((s) => s.key !== 'brand_profile' && s.key !== 'assemble_build')
        .every((s) => s.status === 'aborted'),
    ).toBe(true);
  });

  it('(true,false) → brand_profile done、assemble_build aborted，其余 aborted', () => {
    const steps = buildCompensatedSteps(true, false);
    expect(steps.find((s) => s.key === 'brand_profile')?.status).toBe('done');
    expect(steps.find((s) => s.key === 'assemble_build')?.status).toBe('aborted');
    expect(steps.filter((s) => s.key !== 'brand_profile').every((s) => s.status === 'aborted')).toBe(true);
  });

  it('(false,true) → assemble_build done、brand_profile aborted，其余 aborted', () => {
    const steps = buildCompensatedSteps(false, true);
    expect(steps.find((s) => s.key === 'assemble_build')?.status).toBe('done');
    expect(steps.find((s) => s.key === 'brand_profile')?.status).toBe('aborted');
    expect(steps.filter((s) => s.key !== 'assemble_build').every((s) => s.status === 'aborted')).toBe(true);
  });

  it('(false,false) → 6 步全 aborted，键序不变', () => {
    const steps = buildCompensatedSteps(false, false);
    expect(steps.map((s) => s.key)).toEqual(REFURBISH_KEYS);
    expect(steps.every((s) => s.status === 'aborted')).toBe(true);
  });
});
