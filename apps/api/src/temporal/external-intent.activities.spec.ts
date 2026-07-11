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

const CAPTURED = { tedEnabled: true, openfdaEnabled: true }; // sweep 头部捕获的（可能已过时的）标志
const TARGET = {
  workspaceId: 'ws-1',
  icpId: 'icp-1',
  cpvCodes: ['42122000'],
  buyerCountries: ['DEU'],
  fdaProductCodes: ['LLZ'],
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
});
