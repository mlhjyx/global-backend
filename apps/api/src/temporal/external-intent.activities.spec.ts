import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { TaxonomyResolver } from '../discovery/taxonomy-resolver';
import { createExternalIntentActivities } from './external-intent.activities';

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
    canonicalCompany: {
      findMany: async ({ take, where }: { take: number; where?: { id?: { gt?: string } } }) =>
        Array.from({ length: take }, (_, i) => ({ id: `${where?.id?.gt ?? 'c'}-${i}` })),
      findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, domain: null, dedupeKey: `dk-${where.id}`, attributes: {}, status: 'NEW' }),
      update: async () => ({}),
    },
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
