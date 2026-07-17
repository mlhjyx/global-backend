import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context as ActivityContext } from '@temporalio/activity';
import type { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  createSiteBuilderActivities,
  buildCompensatedSteps,
  intakeToMarkdown,
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

const INPUT: RefurbishActivityInput = {
  workspaceId: 'ws-1',
  siteId: 'site-1',
  buildRunId: 'run-1',
};

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
  const client = { $executeRaw: vi.fn(async () => 0), ...tx };
  return {
    withWorkspace: vi.fn(async (_ws: string, fn: (t: unknown) => unknown) =>
      fn(client),
    ),
  } as unknown as PrismaService;
}

function spyBudget() {
  const open = vi.spyOn(budgetLedger, 'open').mockImplementation(() => {});
  const close = vi.spyOn(budgetLedger, 'close').mockImplementation(() => {});
  return { open, close };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('processKbAsset — Temporal heartbeat/cancellation', () => {
  it('worker Activity context 的取消信号与阶段 heartbeat 会传入单素材处理器', async () => {
    const controller = new AbortController();
    const heartbeat = vi.fn();
    vi.spyOn(ActivityContext, 'current').mockReturnValue({
      heartbeat,
      cancellationSignal: controller.signal,
    } as never);
    const processAsset = vi.fn(async (...args: unknown[]) => {
      const options = args[3] as {
        signal?: AbortSignal;
        heartbeat?: (stage: string) => void;
      };
      expect(options.signal).toBe(controller.signal);
      options.heartbeat?.('parsed');
      return { assetId: 'asset-1', outcome: 'ready' as const };
    });
    const acts = createSiteBuilderActivities({
      prisma: {} as PrismaService,
      kb: {
        ingestText: vi.fn() as never,
        processQueued: vi.fn() as never,
        processAsset: processAsset as never,
      },
    });

    await expect(
      acts.processKbAsset({
        workspaceId: 'ws-1',
        siteId: 'site-1',
        assetId: 'asset-1',
      }),
    ).resolves.toMatchObject({ outcome: 'ready' });

    expect(heartbeat).toHaveBeenCalledWith({
      assetId: 'asset-1',
      stage: 'claim',
    });
    expect(heartbeat).toHaveBeenCalledWith({
      assetId: 'asset-1',
      stage: 'parsed',
    });
  });

  it('refurbish ingestPendingKb 同样把 Activity 取消信号传给站点队列处理器', async () => {
    const controller = new AbortController();
    const heartbeat = vi.fn();
    vi.spyOn(ActivityContext, 'current').mockReturnValue({
      heartbeat,
      cancellationSignal: controller.signal,
    } as never);
    const processQueued = vi.fn(async (...args: unknown[]) => {
      const options = args[2] as {
        signal?: AbortSignal;
        heartbeat?: (stage: string) => void;
      };
      expect(options.signal).toBe(controller.signal);
      options.heartbeat?.('queued:asset-1');
      return { processed: 1, failed: 0 };
    });
    const acts = createSiteBuilderActivities({
      prisma: {} as PrismaService,
      kb: {
        ingestText: vi.fn() as never,
        processQueued: processQueued as never,
        processAsset: vi.fn() as never,
      },
    });

    await expect(acts.ingestPendingKb(INPUT)).resolves.toEqual({
      processed: 1,
      failed: 0,
    });
    expect(heartbeat).toHaveBeenCalledWith({
      siteId: 'site-1',
      stage: 'list-queued',
    });
    expect(heartbeat).toHaveBeenCalledWith({
      siteId: 'site-1',
      stage: 'queued:asset-1',
    });
  });
});

describe('listKbRecoveryCandidates — expired lease fairness', () => {
  it('sorts expired processing leases ahead of queued backlog before applying the batch limit', async () => {
    const findMany = vi.fn(async () => []);
    const acts = createSiteBuilderActivities({
      prisma: {} as PrismaService,
      ownerDb: { asset: { findMany } } as unknown as PrismaClient,
    });

    await acts.listKbRecoveryCandidates({ limit: 10 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 10,
        orderBy: expect.arrayContaining([
          { processingStatus: 'asc' },
          { leaseUntil: { sort: 'asc', nulls: 'last' } },
        ]),
      }),
    );
  });
});

describe('beginRefurbishRun — 预算门接线（改动 1）', () => {
  it('认领成功 → close(force) 后 open(buildRunId, siteBuildBudgetCents())', async () => {
    const { open, close } = spyBudget();
    const tx = {
      site: {
        findUnique: vi.fn(async () => ({ id: 'site-1' })),
        update: vi.fn(async () => ({})),
      },
      siteBuildRun: {
        findUnique: vi.fn(async () => ({ status: 'queued' })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.beginRefurbishRun(INPUT);
    expect(close).toHaveBeenCalledWith('run-1', { force: true });
    expect(open).toHaveBeenCalledWith('run-1', siteBuildBudgetCents());
    // close 在 open 之前（清残留再开新账）
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(
      open.mock.invocationCallOrder[0],
    );
  });

  it('认领失败（count=0）→ 抛错且 open 不被调用（失败 claim 先抛）', async () => {
    const { open } = spyBudget();
    const tx = {
      site: {
        findUnique: vi.fn(async () => ({ id: 'site-1' })),
        update: vi.fn(),
      },
      siteBuildRun: {
        findUnique: vi.fn(async () => ({ status: 'failed' })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    };
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await expect(acts.beginRefurbishRun(INPUT)).rejects.toThrow(
      /not claimable/,
    );
    expect(open).not.toHaveBeenCalled();
  });

  it('running activity retry does not reset startedAt, phase, progress or steps', async () => {
    const { open } = spyBudget();
    const updateMany = vi.fn();
    const tx = {
      site: {
        findUnique: vi.fn(async () => ({ id: 'site-1' })),
        update: vi.fn(async () => ({})),
      },
      siteBuildRun: {
        findUnique: vi.fn(async () => ({ status: 'running' })),
        updateMany,
      },
    };
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.beginRefurbishRun(INPUT);
    expect(updateMany).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalled();
  });
});

describe('finalizeRefurbish — 末尾 force close（改动 1）', () => {
  it('发布成功 → close(buildRunId, {force:true})', async () => {
    const { close } = spyBudget();
    const tx = {
      siteBuildRun: { updateMany: vi.fn(async () => ({ count: 1 })) },
      site: { update: vi.fn(async () => ({})) },
      siteVersion: {
        findFirst: vi.fn(async () => ({
          spec: { specVersion: '1.0.0', assets: {}, pages: [] },
        })),
      },
    };
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    const input: RefurbishFinalizeInput = {
      ...INPUT,
      kb: { processed: 1, failed: 0, degraded: false },
      profile: { status: 'done', gaps: 0 },
      images: { status: 'done', processed: 2, failed: 0, variants: 30 },
      build: { previewSlug: 'acme', versionId: 'v-1' },
    };
    await acts.finalizeRefurbish(input);
    expect(close).toHaveBeenCalledWith('run-1', { force: true });
  });

  it('兼容升级前已调度且没有 images 字段的 activity payload', async () => {
    const { close } = spyBudget();
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      siteBuildRun: { updateMany },
      site: { update: vi.fn(async () => ({})) },
      siteVersion: {
        findFirst: vi.fn(async () => ({
          spec: { specVersion: '1.0.0', assets: {}, pages: [] },
        })),
      },
    };
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await expect(
      acts.finalizeRefurbish({
        ...INPUT,
        kb: { processed: 1, failed: 0, degraded: false },
        profile: { status: 'done', gaps: 0 },
        build: { previewSlug: 'acme', versionId: 'v-legacy' },
      }),
    ).resolves.toEqual({ previewSlug: 'acme' });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({
              key: 'image_pipeline',
              status: 'skipped_m1c',
            }),
          ]),
        }),
      }),
    );
    expect(close).toHaveBeenCalledWith('run-1', { force: true });
  });

  it('局部构建发布时 active pointer 已变化则 CAS 失败且不覆盖新版本', async () => {
    spyBudget();
    const root = await mkdtemp(path.join(tmpdir(), 'r3b2-cas-preview-'));
    vi.stubEnv('PREVIEW_DIR', root);
    const live = path.join(root, 'acme');
    const staging = path.join(root, '.staging', 'run-1');
    await Promise.all([
      mkdir(live, { recursive: true }),
      mkdir(staging, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(live, 'index.html'), 'active-preview'),
      writeFile(path.join(staging, 'index.html'), 'candidate-preview'),
    ]);
    const update = vi.fn(async () => ({}));
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const tx = {
      siteBuildRun: { updateMany: vi.fn(async () => ({ count: 1 })) },
      site: { update, updateMany },
      siteVersion: {
        findFirst: vi.fn(async () => ({
          spec: { specVersion: '1.0.0', assets: {}, pages: [] },
          artifactKey: `local:${staging}`,
        })),
      },
    };
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    try {
      await expect(
        acts.finalizeRefurbish({
          ...INPUT,
          progressV1: true,
          scope: {
            scope: 'page',
            targetId: 'products',
            baseVersionId: 'base-version',
          },
          kb: { processed: 0, failed: 0, degraded: false },
          profile: { status: 'done', gaps: 0 },
          build: { previewSlug: 'acme', versionId: 'candidate-version' },
        }),
      ).rejects.toThrow('active SiteVersion changed');
      expect(updateMany).toHaveBeenCalledWith({
        where: {
          id: 'site-1',
          activeVersionId: {
            in: ['base-version', 'candidate-version'],
          },
        },
        data: { activeVersionId: 'candidate-version', status: 'ready' },
      });
      expect(update).not.toHaveBeenCalled();
      expect(await readFile(path.join(live, 'index.html'), 'utf8')).toBe(
        'active-preview',
      );
      expect(await readFile(path.join(staging, 'index.html'), 'utf8')).toBe(
        'candidate-preview',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('预览提升后的事务写入失败会恢复原 live 目录', async () => {
    spyBudget();
    const root = await mkdtemp(path.join(tmpdir(), 'r3b2-tx-preview-'));
    vi.stubEnv('PREVIEW_DIR', root);
    const live = path.join(root, 'acme');
    const staging = path.join(root, '.staging', 'run-1');
    await Promise.all([
      mkdir(live, { recursive: true }),
      mkdir(staging, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(live, 'index.html'), 'active-preview'),
      writeFile(path.join(staging, 'index.html'), 'candidate-preview'),
    ]);
    const tx = {
      siteBuildRun: { updateMany: vi.fn(async () => ({ count: 1 })) },
      site: { update: vi.fn(async () => ({})) },
      siteVersion: {
        findFirst: vi.fn(async () => ({
          spec: { specVersion: '1.0.0', assets: {}, pages: [] },
          artifactKey: `local:${staging}`,
        })),
        update: vi.fn(async () => {
          throw new Error('artifact DB write failed');
        }),
      },
    };
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    try {
      await expect(
        acts.finalizeRefurbish({
          ...INPUT,
          progressV1: true,
          kb: { processed: 0, failed: 0, degraded: false },
          profile: { status: 'done', gaps: 0 },
          build: { previewSlug: 'acme', versionId: 'candidate-version' },
        }),
      ).rejects.toThrow('artifact DB write failed');
      expect(await readFile(path.join(live, 'index.html'), 'utf8')).toBe(
        'active-preview',
      );
      await expect(
        readFile(path.join(root, '.rollback', 'run-1', 'index.html')),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
  return {
    gateway: { generateStructured } as unknown as ModelGateway,
    generateStructured,
  };
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
    const site = {
      id: 'site-1',
      name: 'Acme',
      slug: 'acme',
      stylePreset: 'clean',
      intake: INTAKE,
    };
    const acts = createSiteBuilderActivities({
      prisma: assembleStopAfterPolishPrisma(site),
      gateway,
    });
    await expect(acts.assembleAndBuild(INPUT)).rejects.toThrow(
      'stop-after-polish',
    );
    expect(generateStructured).toHaveBeenCalledTimes(1);
    const ctxArg = generateStructured.mock.calls[0][1] as {
      workspaceId: string;
      runId?: string;
    };
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

  it('R3-B2 assemble 入口不把已记录的 0.65 进度写回旧 0.5', async () => {
    spyBudget();
    const updateMany = vi.fn(async () => ({ count: 1 }));
    let call = 0;
    const prisma = {
      withWorkspace: vi.fn(
        async (_workspaceId: string, fn: (tx: unknown) => unknown) => {
          call += 1;
          if (call > 1) throw new Error('stop-after-read');
          return fn({
            siteBuildRun: { updateMany },
            site: {
              findUnique: vi.fn(async () => ({
                id: 'site-1',
                name: 'Acme',
                slug: 'acme',
                intake: INTAKE,
                stylePreset: 'modern-industrial',
                activeVersionId: null,
              })),
            },
            siteVersion: { findFirst: vi.fn(async () => null) },
          });
        },
      ),
    } as unknown as PrismaService;
    const acts = createSiteBuilderActivities({ prisma });
    await expect(
      acts.assembleAndBuild({ ...INPUT, progressV1: true }),
    ).rejects.toThrow('stop-after-read');
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'run-1', status: 'running' },
      data: { phase: 'P3_assembly', progress: 0.65 },
    });
  });

  it('renderer 期间取消后不把迟到候选写 succeeded，并清理 run staging', async () => {
    spyBudget();
    const root = await mkdtemp(path.join(tmpdir(), 'r3b2-render-cancel-'));
    vi.stubEnv('PREVIEW_DIR', root);
    let runStatus = 'running';
    const versionUpdateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      siteBuildRun: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi.fn(async () => ({ status: runStatus })),
      },
      site: {
        findUnique: vi.fn(async () => ({
          id: 'site-1',
          name: 'Acme',
          slug: 'acme',
          intake: INTAKE,
          stylePreset: 'modern-industrial',
          activeVersionId: null,
        })),
      },
      siteVersion: {
        findFirst: vi.fn(async () => null),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        aggregate: vi.fn(async () => ({ _max: { version: null } })),
        create: vi.fn(async () => ({ id: 'version-1' })),
        updateMany: versionUpdateMany,
      },
    };
    const renderSiteSpec = vi.fn(
      async (_spec: unknown, output: { outDir: string; basePath: string }) => {
        await writeFile(path.join(output.outDir, 'index.html'), 'candidate');
        runStatus = 'cancelled';
      },
    );
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(tx),
      renderSiteSpec,
    });
    try {
      await expect(
        acts.assembleAndBuild({ ...INPUT, progressV1: true }),
      ).rejects.toThrow('rendered candidate discarded');
      expect(versionUpdateMany).toHaveBeenCalledWith({
        where: { id: 'version-1', buildStatus: 'building' },
        data: { buildStatus: 'failed' },
      });
      await expect(
        readFile(path.join(root, '.staging', 'run-1', 'index.html')),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('buildBrandProfile 账户未预开 → 入口立账（即便随后 gateway 缺席抛错）', async () => {
    expect(budgetLedger.remainingCents('run-1')).toBe(Infinity);
    const acts = createSiteBuilderActivities({ prisma: {} as PrismaService }); // 无 gateway
    await expect(acts.buildBrandProfile(INPUT)).rejects.toThrow(
      /gateway unavailable/,
    );
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
    transitionCount?: number;
  }) {
    const runUpdate = vi.fn(async () => ({ count: over.transitionCount ?? 1 }));
    const siteUpdate = vi.fn(async () => ({}));
    const findFirst = vi.fn(async () => over.brandProfile ?? null);
    const svFindFirst = vi.fn(async () => over.siteVersion ?? null);
    const tx = {
      siteVersion: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        findFirst: svFindFirst,
      },
      site: {
        findUnique: vi.fn(async () => ({
          id: 'site-1',
          activeVersionId: null,
        })),
        update: siteUpdate,
      },
      siteBuildRun: {
        findUnique: vi.fn(async () => ({
          status: over.runStatus ?? 'running',
          startedAt:
            over.startedAt === undefined
              ? new Date('2026-07-14T00:00:00.000Z')
              : over.startedAt,
          error: null,
          finishedAt: null,
          steps: over.steps ?? PENDING_STEPS,
        })),
        updateMany: runUpdate,
      },
      brandProfile: { findFirst },
    };
    return { tx, runUpdate, siteUpdate, findFirst, svFindFirst };
  }

  it('转 failed 时 always force close', async () => {
    const { close } = spyBudget();
    const { tx } = compensateTx({});
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish(INPUT);
    expect(close).toHaveBeenCalledWith('run-1', { force: true });
  });

  it('DB 补偿失败会传播，交给 Temporal 重试且绝不伪装成功', async () => {
    const { close } = spyBudget();
    const failure = new Error('database unavailable');
    const acts = createSiteBuilderActivities({
      prisma: {
        withWorkspace: vi.fn().mockRejectedValue(failure),
      } as unknown as PrismaService,
    });
    await expect(acts.compensateRefurbish(INPUT)).rejects.toBe(failure);
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
      where: {
        siteId: 'site-1',
        createdAt: { gte: new Date('2026-07-14T00:00:00.000Z') },
      },
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
    expect(data.steps.find((s) => s.key === 'brand_profile')?.status).toBe(
      'done',
    );
    expect(data.steps.find((s) => s.key === 'assemble_build')?.status).toBe(
      'done',
    );
    expect(
      data.steps
        .filter((s) => s.key !== 'brand_profile' && s.key !== 'assemble_build')
        .every((s) => s.status === 'aborted'),
    ).toBe(true);
  });

  it('brandProfile 存在 + 无 succeeded siteVersion → brand_profile done、assemble_build aborted（其余 aborted）', async () => {
    spyBudget();
    const { tx, runUpdate } = compensateTx({
      brandProfile: { id: 'bp-1' },
      siteVersion: null,
    });
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish(INPUT);
    const data = runUpdate.mock.calls[0][0].data as {
      steps: { key: string; status: string }[];
    };
    expect(data.steps.find((s) => s.key === 'brand_profile')?.status).toBe(
      'done',
    );
    expect(data.steps.find((s) => s.key === 'assemble_build')?.status).toBe(
      'aborted',
    );
    expect(
      data.steps
        .filter((s) => s.key !== 'brand_profile')
        .every((s) => s.status === 'aborted'),
    ).toBe(true);
  });

  it('brandProfile 缺席 → brand_profile:aborted（全部 aborted）', async () => {
    spyBudget();
    const { tx, runUpdate } = compensateTx({ brandProfile: null });
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish(INPUT);
    const data = runUpdate.mock.calls[0][0].data as {
      steps: { key: string; status: string }[];
    };
    expect(data.steps.find((s) => s.key === 'brand_profile')?.status).toBe(
      'aborted',
    );
    expect(data.steps.every((s) => s.status === 'aborted')).toBe(true);
  });

  it('run 已 succeeded → 不改状态、不写 steps、不查 brandProfile/siteVersion（守卫），但仍 force close', async () => {
    const { close } = spyBudget();
    const { tx, runUpdate, findFirst, svFindFirst } = compensateTx({
      runStatus: 'succeeded',
    });
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish(INPUT);
    expect(runUpdate).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
    expect(svFindFirst).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith('run-1', { force: true });
  });

  it('取消补偿 CAS 为 cancelled，且不记录 failure error', async () => {
    spyBudget();
    const { tx, runUpdate, siteUpdate } = compensateTx({});
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish({ ...INPUT, terminalStatus: 'cancelled' });
    expect(runUpdate.mock.calls[0][0].data).toMatchObject({
      status: 'cancelled',
      error: null,
    });
    expect(siteUpdate).toHaveBeenCalledOnce();
  });

  it('terminal CAS 丢失时不回写 Site，防止旧补偿覆盖新 run', async () => {
    spyBudget();
    const { tx, runUpdate, siteUpdate } = compensateTx({ transitionCount: 0 });
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish(INPUT);
    expect(runUpdate).toHaveBeenCalledOnce();
    expect(siteUpdate).not.toHaveBeenCalled();
  });

  it('terminal CAS 赢时把本 run 的 building/succeeded 未发布候选统一标 failed', async () => {
    spyBudget();
    const { tx } = compensateTx({ siteVersion: { id: 'candidate' } });
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish(INPUT);
    expect(tx.siteVersion.updateMany).toHaveBeenCalledWith({
      where: {
        buildRunId: 'run-1',
        buildStatus: { in: ['building', 'succeeded'] },
      },
      data: { buildStatus: 'failed' },
    });
  });

  it('startedAt 为 null（无从归属）→ brand_profile:aborted，不发探测查询', async () => {
    spyBudget();
    const { tx, runUpdate, findFirst } = compensateTx({
      startedAt: null,
      brandProfile: { id: 'stale' },
    });
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish(INPUT);
    expect(findFirst).not.toHaveBeenCalled(); // startedAt 缺失不查（不误认领旧版本）
    const data = runUpdate.mock.calls[0][0].data as {
      steps: { key: string; status: string }[];
    };
    expect(data.steps.find((s) => s.key === 'brand_profile')?.status).toBe(
      'aborted',
    );
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
    expect(steps.find((s) => s.key === 'assemble_build')?.status).toBe(
      'aborted',
    );
    expect(
      steps
        .filter((s) => s.key !== 'brand_profile')
        .every((s) => s.status === 'aborted'),
    ).toBe(true);
  });

  it('(false,true) → assemble_build done、brand_profile aborted，其余 aborted', () => {
    const steps = buildCompensatedSteps(false, true);
    expect(steps.find((s) => s.key === 'assemble_build')?.status).toBe('done');
    expect(steps.find((s) => s.key === 'brand_profile')?.status).toBe(
      'aborted',
    );
    expect(
      steps
        .filter((s) => s.key !== 'assemble_build')
        .every((s) => s.status === 'aborted'),
    ).toBe(true);
  });

  it('(false,false) → 6 步全 aborted，键序不变', () => {
    const steps = buildCompensatedSteps(false, false);
    expect(steps.map((s) => s.key)).toEqual(REFURBISH_KEYS);
    expect(steps.every((s) => s.status === 'aborted')).toBe(true);
  });
});

describe('R0-4 intakeToMarkdown — businessEmail 不进 KB（隐私红线，与 ADR-010 存储侧同源）', () => {
  const intake = {
    company: { nameZh: '安可', nameEn: 'Acme' },
    industry: 'pumps',
    products: ['pumps'],
    targetMarkets: ['DE'],
    hasWebsite: false,
    websiteUrl: null,
    businessEmail: 'sales@acme.com',
  };
  it('KB markdown 不含 businessEmail / email 字样，但保留公司名/产品/市场事实', () => {
    const md = intakeToMarkdown(intake as never);
    expect(md).not.toContain('sales@acme.com');
    expect(md.toLowerCase()).not.toContain('email');
    // 去联系信息 ≠ 去事实
    expect(md).toContain('Acme');
    expect(md).toContain('pumps');
    expect(md).toContain('DE');
  });
});

describe('R0-5 polishCopy — 传真 AbortSignal（超时即 abort 底层 fetch，不留后台烧钱）', () => {
  it('generateStructured 调用带 input.signal:AbortSignal（透传网关→fetch）', async () => {
    spyBudget();
    const { gateway, generateStructured } = fakeGateway();
    const site = {
      id: 'site-1',
      name: 'Acme',
      slug: 'acme',
      stylePreset: 'clean',
      intake: INTAKE,
    };
    const acts = createSiteBuilderActivities({
      prisma: assembleStopAfterPolishPrisma(site),
      gateway,
    });
    await expect(acts.assembleAndBuild(INPUT)).rejects.toThrow(
      'stop-after-polish',
    );
    const inputArg = generateStructured.mock.calls[0][0] as {
      signal?: unknown;
    };
    expect(inputArg.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('cleanupFailedDemo — R0-6 不删站、置 setup_failed（保留用户数据、可原地重试）', () => {
  it('本 run 仍最新 → 保留 site 置 setup_failed + 清本 run building 孤儿版本，绝不 site.delete', async () => {
    const del = vi.fn(async () => ({}));
    const update = vi.fn(async () => ({}));
    const versionUpdateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      siteBuildRun: { findFirst: async () => ({ id: 'run-1' }) }, // 最新 demo_v0 run = 本 run
      siteVersion: { updateMany: versionUpdateMany },
      site: { delete: del, update },
    };
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.cleanupFailedDemo(INPUT);
    expect(del).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: 'site-1' },
      data: { status: 'setup_failed' },
    });
    expect(versionUpdateMany).toHaveBeenCalledWith({
      where: { buildRunId: 'run-1', buildStatus: 'building' },
      data: { buildStatus: 'failed' },
    });
  });

  it('P1 迟到重试守卫：有更新的 demo_v0 run 已接管（re-intake 后）→ cleanup 作废，不 clobber 成功站', async () => {
    const update = vi.fn(async () => ({}));
    const versionUpdateMany = vi.fn(async () => ({ count: 0 }));
    const tx = {
      siteBuildRun: { findFirst: async () => ({ id: 'run-2' }) }, // 更新的 run 已接管（run-2 ≠ run-1）
      siteVersion: { updateMany: versionUpdateMany },
      site: { update, delete: vi.fn() },
    };
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.cleanupFailedDemo(INPUT); // INPUT.buildRunId = 'run-1'
    expect(update).not.toHaveBeenCalled(); // 不动 site
    expect(versionUpdateMany).not.toHaveBeenCalled(); // 也不动版本
  });
});
