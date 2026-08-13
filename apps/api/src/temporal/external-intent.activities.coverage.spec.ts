import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { TaxonomyResolver } from '../discovery/taxonomy-resolver';
import { BudgetExceededError } from '../tools/budget';
import { createExternalIntentActivities } from './external-intent.activities';
import { SignalIngestService } from '../signals/signal-ingest.service';
import { TedIntentProjectionService } from '../intent/ted-intent-projection.service';
import { OpenFdaIntentProjectionService } from '../intent/openfda-intent-projection.service';
import { SamIntentProjectionService } from '../intent/sam-intent-projection.service';

const SENSITIVE_ERROR =
  'Dana Buyer <dana@example.com> https://private.example/import client_secret=hidden';

/**
 * 收口⑤ fast-follow（Codex #56 P1）：投影活动的 DataProvider **kill-switch live 重读**回归。
 * listExternalIntentTargets 在 sweep 头部捕获 tedEnabled/openfdaEnabled；摄取活动逐指纹 liveEnabled 重读，
 * 但投影此前只受**捕获的**标志门。若 provider 在捕获之后被 ops 置 DISABLED（一键停执行点），投影仍会把
 * 缓存 source_signal 投进租户 canonical 造新线索。此测证明投影同样 live 重读 DataProvider.status。
 * （注：source_policy SUSPENDED 是**停采不停用**的 egress-only 门，不在此路径——见 architecture §5 两级撤停语义。）
 */

const CAPTURED = { tedEnabled: true, openfdaEnabled: true, samgovEnabled: false }; // sweep 头部捕获的（可能已过时的）标志
const TARGET = {
  workspaceId: 'ws-1',
  icpId: 'icp-1',
  cpvCodes: ['42122000'],
  buyerCountries: ['DEU'],
  fdaProductCodes: ['LLZ'],
  naicsCodes: ['3339'],
};

/** 构造只喂投影路径所需依赖的活动集：sourceSignal.findMany 探针 + DataProvider live 状态（findProviders 探针=owner-DB 读计数）。 */
function makeActs(live: { ted: string; openfda: string }) {
  const findMany = vi.fn(async () => [] as unknown[]); // 无信号：projectTenders/Clearances 读后早返（不触 withWorkspace）
  const prisma = {
    sourceSignal: { findMany },
    withWorkspace: async <T>(_ws: string, fn: (tx: unknown) => Promise<T>) => fn({}),
  } as unknown as PrismaService;
  const findProviders = vi.fn(async () => [
    { key: 'ted', status: live.ted },
    { key: 'openfda', status: live.openfda },
  ]);
  const ownerDb = { dataProvider: { findMany: findProviders } } as unknown as PrismaClient;
  const acts = createExternalIntentActivities({ prisma, taxonomy: {} as TaxonomyResolver, ownerDb });
  return { acts, findMany, findProviders };
}

/** 从 sourceSignal.findMany 探针的调用里取出各 provider 是否真被投影（projectTenders→ted / projectClearances→openfda）。 */
function projectedProviders(findMany: ReturnType<typeof vi.fn>): string[] {
  return findMany.mock.calls
    .map((c) => (c[0] as { where?: { providerKey?: string } } | undefined)?.where?.providerKey)
    .filter((k): k is string => typeof k === 'string');
}

describe('projectExternalIntentForIcp — DataProvider kill-switch live 重读', () => {
  it('provider 捕获后被 DISABLED → 投影跳过该 provider（即便捕获标志=true）', async () => {
    const { acts, findMany } = makeActs({ ted: 'DISABLED', openfda: 'ENABLED' });

    await acts.projectExternalIntentForIcp({ ...TARGET, ...CAPTURED });

    const projected = projectedProviders(findMany);
    expect(projected).not.toContain('ted'); // 中途 DISABLE → 不投缓存 TED 信号
    expect(projected).toContain('openfda'); // 仍启用者不受影响
  });

  it('两 provider live ENABLED → 均正常投影', async () => {
    const { acts, findMany } = makeActs({ ted: 'ENABLED', openfda: 'ENABLED' });

    await acts.projectExternalIntentForIcp({ ...TARGET, ...CAPTURED });

    const projected = projectedProviders(findMany);
    expect(projected).toContain('ted');
    expect(projected).toContain('openfda');
  });

  it('两 provider live DISABLED → 全跳过（无任何投影读取）', async () => {
    const { acts, findMany } = makeActs({ ted: 'DISABLED', openfda: 'DISABLED' });

    const out = await acts.projectExternalIntentForIcp({ ...TARGET, ...CAPTURED });

    expect(projectedProviders(findMany)).toHaveLength(0);
    expect(out.tenders).toBeUndefined();
    expect(out.clearances).toBeUndefined();
  });

  it('未注入 live 快照 → 活动自读 DataProvider（防御纵深：直连调用者不被信任）', async () => {
    const { acts, findProviders } = makeActs({ ted: 'ENABLED', openfda: 'ENABLED' });

    await acts.projectExternalIntentForIcp({ ...TARGET, ...CAPTURED });

    expect(findProviders).toHaveBeenCalledTimes(1); // 缺省路径必自读一次
  });
});

/**
 * fast-follow 优化（保严格性）：workflow 摄取后**单次** liveProviderState() 重读，把 live 快照 thread 给逐 ICP
 * 投影，省每-ICP owner-DB 读。注入快照优先于自读；投影仍逐 ICP AND 捕获标志。缺省仍自读（上一 describe 覆盖）。
 */
describe('projectExternalIntentForIcp — 注入 live 快照（单次重读优化）', () => {
  it('注入 live 快照 → 用快照门控且**不**再自读 owner-DB', async () => {
    // owner-DB 若被自读会返回全 ENABLED；用它做反证：注入 ted=false，若跳过 TED 即证明用的是注入值而非自读值。
    const { acts, findMany, findProviders } = makeActs({ ted: 'ENABLED', openfda: 'ENABLED' });

    await acts.projectExternalIntentForIcp({ ...TARGET, ...CAPTURED, live: { ted: false, openfda: true } });

    const projected = projectedProviders(findMany);
    expect(projected).not.toContain('ted'); // 注入 ted=false 生效（非自读的 ENABLED）
    expect(projected).toContain('openfda');
    expect(findProviders).not.toHaveBeenCalled(); // 优化核心：注入快照 → 零 owner-DB 读
  });

  it('注入快照两 provider 均 on → 均投影，仍零自读', async () => {
    const { acts, findMany, findProviders } = makeActs({ ted: 'DISABLED', openfda: 'DISABLED' });

    // 自读会返回全 DISABLED；注入全 on 覆盖它 → 证明注入优先。
    await acts.projectExternalIntentForIcp({ ...TARGET, ...CAPTURED, live: { ted: true, openfda: true } });

    const projected = projectedProviders(findMany);
    expect(projected).toContain('ted');
    expect(projected).toContain('openfda');
    expect(findProviders).not.toHaveBeenCalled();
  });

  it('注入快照 on 但捕获标志=false → 仍跳过（逐 ICP AND 捕获标志不被绕过）', async () => {
    const { acts, findMany } = makeActs({ ted: 'ENABLED', openfda: 'ENABLED' });

    await acts.projectExternalIntentForIcp({
      ...TARGET,
      tedEnabled: false,
      openfdaEnabled: true,
      live: { ted: true, openfda: true },
    });

    const projected = projectedProviders(findMany);
    expect(projected).not.toContain('ted'); // 捕获 tedEnabled=false → 无论 live 都不投
    expect(projected).toContain('openfda');
  });

  it('samgov 注入 live on + 捕获 samgovEnabled → 投影 SAM Sources Sought（NAICS 面，无国别）', async () => {
    const { acts, findMany } = makeActs({ ted: 'DISABLED', openfda: 'DISABLED' });

    await acts.projectExternalIntentForIcp({
      ...TARGET,
      tedEnabled: false,
      openfdaEnabled: false,
      samgovEnabled: true,
      live: { ted: false, openfda: false, samgov: true },
    });

    const projected = projectedProviders(findMany);
    expect(projected).toContain('samgov'); // samOn=捕获&&live → 读 source_signal(samgov)
    expect(projected).not.toContain('ted');
  });

  it('samgov 捕获 enabled 但 live off → 跳过（逐 ICP AND live 不被绕过）', async () => {
    const { acts, findMany } = makeActs({ ted: 'DISABLED', openfda: 'DISABLED' });

    await acts.projectExternalIntentForIcp({
      ...TARGET,
      tedEnabled: false,
      openfdaEnabled: false,
      samgovEnabled: true,
      live: { ted: false, openfda: false, samgov: false },
    });

    expect(projectedProviders(findMany)).not.toContain('samgov');
  });
});

/**
 * 过期后 intent 复算活动（Codex #56 P2）：按 workspace 聚合投影面 + 分页复算，轮上限防单轮 grind。
 * 内存假体：canonicalCompany.findMany 每页恒返回 `take` 家（→ recomputeWorkspace 恒有 nextCursor → 逼近轮上限）；
 * 各家无域名/无信号 → recomputeCompany 'unchanged'（不写）。此处只验分组 + 分页轮上限（重建内容在 intent-recompute.service.spec）。
 */
function recomputeActs() {
  const tx = {
    $queryRaw: async () => [{ locked: true }],
    canonicalCompany: {
      findMany: async ({ take, where }: { take: number; where?: { id?: { gt?: string } } }) =>
        Array.from({ length: take }, (_, i) => ({ id: `${where?.id?.gt ?? 'c'}-${i}` })),
      findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, domain: null, dedupeKey: `dk-${where.id}`, attributes: {}, status: 'NEW' }),
      update: async () => ({}),
    },
    suppressionRecord: { findMany: async () => [] },
  };
  const prisma = {
    sourceSignal: { findMany: async () => [] as unknown[] },
    monitoredSource: { findUnique: async () => null },
    withWorkspace: async <T>(_ws: string, fn: (t: typeof tx) => Promise<T>) => fn(tx),
  } as unknown as PrismaService;
  return createExternalIntentActivities({ prisma, taxonomy: {} as TaxonomyResolver });
}

describe('recomputeExpiredIntent — 按 workspace 聚合投影面 + 分页轮上限', () => {
  it('同 workspace 多 ICP → 归一为一次 workspace 复算；分页恒有 nextCursor → 触 maxRounds 记 truncated', async () => {
    const acts = recomputeActs();
    const r = await acts.recomputeExpiredIntent({
      targets: [
        { workspaceId: 'ws-1', icpId: 'icp-1', cpvCodes: ['42122000'], buyerCountries: ['DEU'], fdaProductCodes: [] },
        { workspaceId: 'ws-1', icpId: 'icp-2', cpvCodes: [], buyerCountries: [], fdaProductCodes: ['LLZ'] },
        { workspaceId: 'ws-2', icpId: 'icp-3', cpvCodes: ['33000000'], buyerCountries: ['FRA'], fdaProductCodes: [] },
      ] as never,
      maxRounds: 2,
    });
    expect(r.workspacesRecomputed).toBe(2); // ws-1（两 ICP 合并为一）+ ws-2
    expect(r.truncated).toBe(2); // 两 workspace 分页恒有 nextCursor → 各触 maxRounds=2 轮上限
    expect(r.companiesRebuilt).toBe(0); // 无信号/无域名 → 全 unchanged，不写
  });

  it('无 targets → 空汇总（不触任何复算）', async () => {
    const acts = recomputeActs();
    expect(await acts.recomputeExpiredIntent({ targets: [] })).toEqual({
      workspacesRecomputed: 0, companiesRebuilt: 0, companiesCleared: 0, truncated: 0,
    });
  });

  it('naicsCodes-only 面 → SAM **不进 recompute**（Codex P2 #2/#5）→ 跳过复算（投影为唯一 SAM 写入者）', async () => {
    const acts = recomputeActs();
    const r = await acts.recomputeExpiredIntent({
      targets: [{ workspaceId: 'ws-sam', icpId: 'icp-s', cpvCodes: [], buyerCountries: [], fdaProductCodes: [], naicsCodes: ['3339'] }] as never,
      maxRounds: 1,
    });
    // SAM 不建 recompute 面：避免绕过 samgovEnabled kill-switch + 抢先 projectSourcesSought 漏写 disclaimer/marker。
    expect(r.workspacesRecomputed).toBe(0);
  });

  it('解析失败(error) 或空投影面的 workspace → 跳过复算，绝不据空面误清 TED/FDA intent（复审 HIGH）', async () => {
    const acts = recomputeActs();
    const r = await acts.recomputeExpiredIntent({
      targets: [
        // 解析失败：空码 + error → 该 workspace 完全不复算（否则空面会把其 TED/FDA intent 当"无匹配"清掉）。
        { workspaceId: 'ws-fail', icpId: 'icp-1', cpvCodes: [], buyerCountries: [], fdaProductCodes: [], error: 'cpv: boom' },
        // 真无 TED/FDA 面（解析成功但该 ICP 不映射任何码）→ 也跳过（无收敛面可算）。
        { workspaceId: 'ws-empty', icpId: 'icp-2', cpvCodes: [], buyerCountries: [], fdaProductCodes: [] },
        // 有面 → 正常复算。
        { workspaceId: 'ws-ok', icpId: 'icp-3', cpvCodes: ['42122000'], buyerCountries: ['DEU'], fdaProductCodes: [] },
      ] as never,
      maxRounds: 1,
    });
    expect(r.workspacesRecomputed).toBe(1); // 只 ws-ok；ws-fail(error) 与 ws-empty(空面) 均跳过
  });

  it('同 workspace 一 ICP 失败 + 一 ICP 有面 → 仍以成功 ICP 的面复算（失败 ICP 不塌成空面）', async () => {
    const acts = recomputeActs();
    const r = await acts.recomputeExpiredIntent({
      targets: [
        { workspaceId: 'ws-1', icpId: 'icp-fail', cpvCodes: [], buyerCountries: [], fdaProductCodes: [], error: 'boom' },
        { workspaceId: 'ws-1', icpId: 'icp-ok', cpvCodes: ['42122000'], buyerCountries: ['DEU'], fdaProductCodes: [] },
      ] as never,
      maxRounds: 1,
    });
    expect(r.workspacesRecomputed).toBe(1); // ws-1 用 icp-ok 的面复算（失败 ICP 被跳过、不清空聚合面）
  });
});

describe('external intent activity result — 闭合错误码边界', () => {
  it('ICP taxonomy 三路失败只返回固定 stage codes，不复制异常 message', async () => {
    const ownerDb = {
      icpDefinition: {
        findUnique: vi.fn().mockResolvedValue({
          companyAttributes: { industry: 'industrial pumps', product: 'pump' },
          targetMarkets: ['USA', 'Germany'],
        }),
      },
      discoveryQueryPlan: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const taxonomy = {
      resolveMany: vi.fn().mockRejectedValue(new Error(SENSITIVE_ERROR)),
      resolve: vi.fn().mockRejectedValue(new Error(SENSITIVE_ERROR)),
      resolveCpvForProduct: vi.fn().mockRejectedValue(new Error(SENSITIVE_ERROR)),
      resolveFdaProductCode: vi.fn().mockRejectedValue(new Error(SENSITIVE_ERROR)),
      listFdaProductCodes: vi.fn().mockRejectedValue(new Error(SENSITIVE_ERROR)),
      resolveNaicsForProduct: vi.fn().mockRejectedValue(new Error(SENSITIVE_ERROR)),
    } as unknown as TaxonomyResolver;
    const acts = createExternalIntentActivities({
      prisma: {} as PrismaService,
      taxonomy,
      ownerDb,
    });

    const out = await acts.resolveExternalIntentTarget({ workspaceId: 'ws-1', icpId: 'icp-1' });

    expect(out.error).toBe(
      'CPV_RESOLUTION_FAILED;FDA_RESOLUTION_FAILED;NAICS_RESOLUTION_FAILED',
    );
    expect(JSON.stringify(out)).not.toContain(SENSITIVE_ERROR);
  });

  it('投影 activity 清洗上游 raw error，并用固定 provider codes 代替内部异常', async () => {
    const findMany = vi.fn().mockRejectedValue(new Error(SENSITIVE_ERROR));
    const prisma = {
      sourceSignal: { findMany },
      withWorkspace: async <T>(_ws: string, fn: (tx: unknown) => Promise<T>) => fn({}),
    } as unknown as PrismaService;
    const acts = createExternalIntentActivities({
      prisma,
      taxonomy: {} as TaxonomyResolver,
    });

    const out = await acts.projectExternalIntentForIcp({
      ...TARGET,
      ...CAPTURED,
      error: SENSITIVE_ERROR,
      samgovEnabled: true,
      live: { ted: true, openfda: true, samgov: true },
    });

    expect(out.error).toBe(
      'EXTERNAL_TARGET_RESOLUTION_FAILED;TED_PROJECTION_FAILED;OPENFDA_PROJECTION_FAILED;SAMGOV_PROJECTION_FAILED',
    );
    expect(JSON.stringify(out)).not.toContain(SENSITIVE_ERROR);
  });

  it.each([
    [new Error(SENSITIVE_ERROR), false, 'TED_SIGNAL_INGEST_FAILED'],
    [
      new BudgetExceededError('sweep:external-intent', 1, 0),
      true,
      'BUDGET_EXCEEDED',
    ],
  ])(
    '摄取异常 %s 只返回闭合 code，BudgetExceeded=%s',
    async (failure, budgetExceeded, expectedCode) => {
      const prisma = {
        signalIngest: { findUnique: vi.fn().mockRejectedValue(failure) },
      } as unknown as PrismaService;
      const ownerDb = {
        dataProvider: {
          findMany: vi.fn().mockResolvedValue([
            { key: 'ted', status: 'ENABLED' },
          ]),
        },
      } as unknown as PrismaClient;
      const acts = createExternalIntentActivities({
        prisma,
        taxonomy: {} as TaxonomyResolver,
        ownerDb,
        broker: {} as never,
      });

      const out = await acts.ingestExternalSignals({
        targets: [TARGET],
        tedEnabled: true,
        openfdaEnabled: false,
        samgovEnabled: false,
      });

      expect(out.budgetExceeded).toBe(budgetExceeded);
      expect(out.errors).toEqual([expectedCode]);
      expect(JSON.stringify(out)).not.toContain(SENSITIVE_ERROR);
    },
  );
});

describe('external intent target discovery — disabled, empty, and error boundaries', () => {
  it('missing owner connection fails closed across list, live state, and resolution', async () => {
    const acts = createExternalIntentActivities({
      prisma: {} as PrismaService,
      taxonomy: {} as TaxonomyResolver,
    });

    await expect(acts.listExternalIntentTargets()).resolves.toEqual({
      targets: [],
      tedEnabled: false,
      openfdaEnabled: false,
      samgovEnabled: false,
    });
    await expect(acts.liveProviderState()).resolves.toEqual({ ted: false, openfda: false, samgov: false });
    await expect(acts.resolveExternalIntentTarget({ workspaceId: 'ws-1', icpId: 'icp-1' })).resolves.toEqual({
      workspaceId: 'ws-1',
      icpId: 'icp-1',
      cpvCodes: [],
      buyerCountries: [],
      fdaProductCodes: [],
      naicsCodes: [],
    });
  });

  it('all providers disabled returns no targets without scanning ICPs', async () => {
    const findIcps = vi.fn();
    const ownerDb = {
      dataProvider: {
        findMany: vi.fn().mockResolvedValue([
          { key: 'ted', status: 'DISABLED' },
          { key: 'openfda', status: 'SUSPENDED' },
          { key: 'samgov', status: 'DISABLED' },
        ]),
      },
      icpDefinition: { findMany: findIcps },
    } as unknown as PrismaClient;
    const acts = createExternalIntentActivities({
      prisma: {} as PrismaService,
      taxonomy: {} as TaxonomyResolver,
      ownerDb,
    });

    await expect(acts.listExternalIntentTargets()).resolves.toEqual({
      targets: [],
      tedEnabled: false,
      openfdaEnabled: false,
      samgovEnabled: false,
    });
    expect(findIcps).not.toHaveBeenCalled();
  });

  it('enumerates ACTIVE ICPs in stable order and applies an explicit test limit', async () => {
    const findIcps = vi.fn().mockResolvedValue([
      { id: 'icp-1', workspaceId: 'ws-1' },
      { id: 'icp-2', workspaceId: 'ws-2' },
    ]);
    const ownerDb = {
      dataProvider: {
        findMany: vi.fn().mockResolvedValue([
          { key: 'ted', status: 'ENABLED' },
          { key: 'openfda', status: 'DISABLED' },
          { key: 'samgov', status: 'ENABLED' },
        ]),
      },
      icpDefinition: { findMany: findIcps },
    } as unknown as PrismaClient;
    const acts = createExternalIntentActivities({
      prisma: {} as PrismaService,
      taxonomy: {} as TaxonomyResolver,
      ownerDb,
    });

    await expect(acts.listExternalIntentTargets({ limit: 2 })).resolves.toEqual({
      targets: [
        { workspaceId: 'ws-1', icpId: 'icp-1' },
        { workspaceId: 'ws-2', icpId: 'icp-2' },
      ],
      tedEnabled: true,
      openfdaEnabled: false,
      samgovEnabled: true,
    });
    expect(findIcps).toHaveBeenCalledWith({
      where: { status: 'ACTIVE' },
      select: { id: true, workspaceId: true },
      orderBy: { id: 'asc' },
      take: 2,
    });
  });

  it('propagates owner-DB discovery errors instead of reporting a false empty success', async () => {
    const ownerDb = {
      dataProvider: { findMany: vi.fn().mockRejectedValue(new Error('owner db unavailable')) },
    } as unknown as PrismaClient;
    const acts = createExternalIntentActivities({
      prisma: {} as PrismaService,
      taxonomy: {} as TaxonomyResolver,
      ownerDb,
    });

    await expect(acts.listExternalIntentTargets()).rejects.toThrow('owner db unavailable');
  });

  it('missing ICP produces an empty deterministic query surface without touching its query plan', async () => {
    const findPlan = vi.fn();
    const ownerDb = {
      icpDefinition: { findUnique: vi.fn().mockResolvedValue(null) },
      discoveryQueryPlan: { findFirst: findPlan },
    } as unknown as PrismaClient;
    const acts = createExternalIntentActivities({
      prisma: {} as PrismaService,
      taxonomy: {} as TaxonomyResolver,
      ownerDb,
    });

    await expect(acts.resolveExternalIntentTarget({ workspaceId: 'ws-1', icpId: 'missing' })).resolves.toEqual({
      workspaceId: 'ws-1',
      icpId: 'missing',
      cpvCodes: [],
      buyerCountries: [],
      fdaProductCodes: [],
      naicsCodes: [],
    });
    expect(findPlan).not.toHaveBeenCalled();
  });
});

describe('external intent ingestion — empty and expiry boundaries', () => {
  it('returns an exact zero summary when no enabled provider has a usable query surface', async () => {
    const acts = createExternalIntentActivities({
      prisma: {} as PrismaService,
      taxonomy: {} as TaxonomyResolver,
    });

    await expect(
      acts.ingestExternalSignals({
        targets: [TARGET],
        tedEnabled: false,
        openfdaEnabled: false,
        samgovEnabled: false,
      }),
    ).resolves.toEqual({
      tedSpecs: 0,
      fdaSpecs: 0,
      samSpecs: 0,
      fetches: 0,
      ledgerHits: 0,
      signalsUpserted: 0,
      budgetExceeded: false,
      errors: [],
    });
  });

  it('deduplicates query surfaces, counts ledger hits and fetch attempts, and preserves provider error codes', async () => {
    const ingestTed = vi.spyOn(SignalIngestService.prototype, 'ingestTed').mockResolvedValue({
      provider: 'ted',
      queryFingerprint: 'ted-fp',
      ledgerHit: true,
      signalsUpserted: 0,
    });
    const ingestFda = vi.spyOn(SignalIngestService.prototype, 'ingestFda').mockResolvedValue({
      provider: 'openfda',
      queryFingerprint: 'fda-fp',
      ledgerHit: false,
      signalsUpserted: 2,
      error: 'provider_failed',
    });
    const ingestSam = vi.spyOn(SignalIngestService.prototype, 'ingestSam').mockResolvedValue({
      provider: 'samgov',
      queryFingerprint: 'sam-fp',
      ledgerHit: false,
      signalsUpserted: 3,
    });
    const ownerDb = {
      dataProvider: {
        findMany: vi.fn().mockResolvedValue([
          { key: 'ted', status: 'ENABLED' },
          { key: 'openfda', status: 'ENABLED' },
          { key: 'samgov', status: 'ENABLED' },
        ]),
      },
    } as unknown as PrismaClient;
    const acts = createExternalIntentActivities({
      prisma: {} as PrismaService,
      taxonomy: {} as TaxonomyResolver,
      ownerDb,
    });

    const result = await acts.ingestExternalSignals({
      targets: [TARGET, { ...TARGET, workspaceId: 'ws-2', icpId: 'icp-2' }],
      tedEnabled: true,
      openfdaEnabled: true,
      samgovEnabled: true,
      maxNotices: 7,
      maxRecords: 8,
    });

    expect(result).toEqual({
      tedSpecs: 1,
      fdaSpecs: 1,
      samSpecs: 1,
      fetches: 2,
      ledgerHits: 1,
      signalsUpserted: 5,
      budgetExceeded: false,
      errors: ['OPENFDA_SIGNAL_INGEST_FAILED'],
    });
    expect(ingestTed).toHaveBeenCalledOnce();
    expect(ingestFda).toHaveBeenCalledOnce();
    expect(ingestSam).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  it.each([
    ['broker_unavailable', 'OPENFDA_BROKER_UNAVAILABLE', 0],
    ['empty_query', 'OPENFDA_EMPTY_QUERY', 0],
    ['lease_busy', 'OPENFDA_LEASE_BUSY', 1],
    ['lease_lost', 'OPENFDA_LEASE_LOST', 1],
    ['signal_fetch_failed', 'OPENFDA_SIGNAL_FETCH_FAILED', 1],
    ['unexpected_provider_code', 'OPENFDA_SIGNAL_INGEST_FAILED', 1],
  ])('maps provider outcome %s to a closed error code', async (error, expected, fetches) => {
    vi.spyOn(SignalIngestService.prototype, 'ingestFda').mockResolvedValue({
      provider: 'openfda',
      queryFingerprint: 'fda-fp',
      ledgerHit: false,
      signalsUpserted: 0,
      error,
    });
    const ownerDb = {
      dataProvider: {
        findMany: vi.fn().mockResolvedValue([{ key: 'openfda', status: 'ENABLED' }]),
      },
    } as unknown as PrismaClient;
    const acts = createExternalIntentActivities({
      prisma: {} as PrismaService,
      taxonomy: {} as TaxonomyResolver,
      ownerDb,
    });
    await expect(
      acts.ingestExternalSignals({
        targets: [TARGET],
        tedEnabled: false,
        openfdaEnabled: true,
        samgovEnabled: false,
      }),
    ).resolves.toMatchObject({ errors: [expected], fetches });
    vi.restoreAllMocks();
  });

  it('stops each provider loop when its live kill-switch changes before the fetch', async () => {
    const ingestTed = vi.spyOn(SignalIngestService.prototype, 'ingestTed');
    const ingestFda = vi.spyOn(SignalIngestService.prototype, 'ingestFda');
    const ingestSam = vi.spyOn(SignalIngestService.prototype, 'ingestSam');
    const ownerDb = {
      dataProvider: {
        findMany: vi.fn().mockResolvedValue([
          { key: 'ted', status: 'DISABLED' },
          { key: 'openfda', status: 'DISABLED' },
          { key: 'samgov', status: 'DISABLED' },
        ]),
      },
    } as unknown as PrismaClient;
    const acts = createExternalIntentActivities({ prisma: {} as PrismaService, taxonomy: {} as TaxonomyResolver, ownerDb });

    const result = await acts.ingestExternalSignals({
      targets: [TARGET],
      tedEnabled: true,
      openfdaEnabled: true,
      samgovEnabled: true,
    });

    expect(result).toMatchObject({ tedSpecs: 1, fdaSpecs: 1, samSpecs: 1, fetches: 0 });
    expect(ingestTed).not.toHaveBeenCalled();
    expect(ingestFda).not.toHaveBeenCalled();
    expect(ingestSam).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('expires only stale ACTIVE signals through the state-machine update', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 3 });
    const acts = createExternalIntentActivities({
      prisma: { sourceSignal: { updateMany } } as unknown as PrismaService,
      taxonomy: {} as TaxonomyResolver,
    });

    await expect(acts.expireStaleSignals()).resolves.toEqual({ expired: 3 });
    expect(updateMany).toHaveBeenCalledWith({
      where: { status: 'ACTIVE', expiresAt: { lt: expect.any(Date) } },
      data: { status: 'EXPIRED' },
    });
  });
});

describe('external intent projection — provider result aggregation', () => {
  it('returns all enabled projection summaries while disabled providers remain absent', async () => {
    const ted = vi.spyOn(TedIntentProjectionService.prototype, 'projectTenders').mockResolvedValue({
      companiesUpserted: 2,
      tendersProjected: 3,
    });
    const fda = vi.spyOn(OpenFdaIntentProjectionService.prototype, 'projectClearances').mockResolvedValue({
      companiesUpserted: 1,
      clearancesProjected: 4,
    });
    const sam = vi.spyOn(SamIntentProjectionService.prototype, 'projectSourcesSought').mockResolvedValue({
      companiesUpserted: 5,
      sourcesProjected: 6,
    });
    const acts = createExternalIntentActivities({ prisma: {} as PrismaService, taxonomy: {} as TaxonomyResolver });

    const all = await acts.projectExternalIntentForIcp({
      ...TARGET,
      tedEnabled: true,
      openfdaEnabled: true,
      samgovEnabled: true,
      live: { ted: true, openfda: true, samgov: true },
    });
    expect(all).toMatchObject({
      cpvCodes: 1,
      fdaProductCodes: 1,
      naicsCodes: 1,
      tenders: { companiesUpserted: 2, tendersProjected: 3 },
      clearances: { companiesUpserted: 1, clearancesProjected: 4 },
      sourcesSought: { companiesUpserted: 5, sourcesProjected: 6 },
    });
    expect(ted).toHaveBeenCalledOnce();
    expect(fda).toHaveBeenCalledOnce();
    expect(sam).toHaveBeenCalledOnce();

    ted.mockClear();
    fda.mockClear();
    sam.mockClear();
    const none = await acts.projectExternalIntentForIcp({
      ...TARGET,
      tedEnabled: true,
      openfdaEnabled: true,
      samgovEnabled: true,
      live: { ted: false, openfda: false, samgov: false },
    });
    expect(none.tenders).toBeUndefined();
    expect(none.clearances).toBeUndefined();
    expect(none.sourcesSought).toBeUndefined();
    expect(ted).not.toHaveBeenCalled();
    expect(fda).not.toHaveBeenCalled();
    expect(sam).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
