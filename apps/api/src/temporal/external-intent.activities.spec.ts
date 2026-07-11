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

/** 构造只喂投影路径所需依赖的活动集：sourceSignal.findMany 探针 + DataProvider live 状态。 */
function makeActs(live: { ted: string; openfda: string }) {
  const findMany = vi.fn(async () => [] as unknown[]); // 无信号：projectTenders/Clearances 读后早返（不触 withWorkspace）
  const prisma = {
    sourceSignal: { findMany },
    withWorkspace: async <T>(_ws: string, fn: (tx: unknown) => Promise<T>) => fn({}),
  } as unknown as PrismaService;
  const ownerDb = {
    dataProvider: {
      findMany: async () => [
        { key: 'ted', status: live.ted },
        { key: 'openfda', status: live.openfda },
      ],
    },
  } as unknown as PrismaClient;
  const acts = createExternalIntentActivities({ prisma, taxonomy: {} as TaxonomyResolver, ownerDb });
  return { acts, findMany };
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
});
