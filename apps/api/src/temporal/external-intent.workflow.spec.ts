import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

/**
 * `externalIntentSweepWorkflow` 编排单测（收口⑤ fast-follow 的 CI 守）。
 * 用 hermetic proxyActivities-mock harness——无 Temporal 运行时/二进制/出网，跑在既有 vitest CI job。
 * 守：liveProviderState 每 sweep 恰一次并 thread 进每个投影（PR #70 缺口）；各 fail-safe try/catch 分支。
 * 设计见 docs/implementation-records/temporal-workflow-testing.md。
 */

// 工厂动态 import 与下方静态 import 解析到同一模块实例 → 同一 spy 注册表。
vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

import { acts, resetActivities, setPatched } from './testing/temporal-workflow.mock';
import { externalIntentSweepWorkflow } from './external-intent.workflow';

interface Target {
  workspaceId: string;
  icpId: string;
  targetMarkets: string[];
}

function target(workspaceId: string, icpId: string): Target {
  return { workspaceId, icpId, targetMarkets: ['DEU'] };
}

/** resolveExternalIntentTarget 的 happy 实现：回显入参 + 解析出的查询面（cpv/buyerCountries/fda）。 */
function resolvedEcho(t: Target): Record<string, unknown> {
  return { ...t, cpvCodes: ['42122000'], buyerCountries: ['DEU'], fdaProductCodes: ['LLZ'], naicsCodes: ['3339'] };
}

function ingestSummary(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { tedSpecs: 1, fdaSpecs: 1, samSpecs: 0, fetches: 2, ledgerHits: 0, signalsUpserted: 5, budgetExceeded: false, errors: [], ...over };
}

/** 为 happy path 配好全部活动；测试各自覆盖其所验的那一个（once 覆盖优先于此默认实现）。 */
function primeHappyPath(targets: Target[], live: { ted: boolean; openfda: boolean; samgov: boolean } = { ted: true, openfda: false, samgov: false }): { ted: boolean; openfda: boolean; samgov: boolean } {
  acts.listExternalIntentTargets.mockResolvedValue({ targets, tedEnabled: true, openfdaEnabled: true, samgovEnabled: false });
  acts.expireStaleSignals.mockResolvedValue({ expired: 3 });
  acts.resolveExternalIntentTarget.mockImplementation(async (t: Target) => resolvedEcho(t));
  acts.ingestExternalSignals.mockResolvedValue(ingestSummary());
  acts.recomputeExpiredIntent.mockResolvedValue({ workspacesRecomputed: 1, companiesRebuilt: 2, companiesCleared: 1, truncated: 0 });
  acts.liveProviderState.mockResolvedValue(live);
  acts.projectExternalIntentForIcp.mockImplementation(async (t: Record<string, unknown>) => ({
    workspaceId: t.workspaceId,
    icpId: t.icpId,
    cpvCodes: (t.cpvCodes as unknown[] | undefined)?.length ?? 0,
    fdaProductCodes: (t.fdaProductCodes as unknown[] | undefined)?.length ?? 0,
    tenders: { companiesTouched: 2, eventsProjected: 4 },
    clearances: { companiesTouched: 1, eventsProjected: 1 },
  }));
  return live;
}

const firstOrder = (m: Mock): number => m.mock.invocationCallOrder[0];

beforeEach(() => resetActivities());

describe('externalIntentSweepWorkflow — 单次 live 重读 + 穿线（PR #70 缺口守）', () => {
  it('happy path：liveProviderState 恰调一次，其快照 thread 进每个投影（同引用），调用顺序 live 在 ingest 后、投影前', async () => {
    const t1 = target('ws-1', 'icp-1');
    const t2 = target('ws-2', 'icp-2');
    const live = primeHappyPath([t1, t2]);

    const out = await externalIntentSweepWorkflow({});

    // 核心性能守：每 sweep 只一次 owner-DB live 读。
    expect(acts.liveProviderState).toHaveBeenCalledTimes(1);

    // 反回归守：同一 live 快照被 thread 进**每个**投影调用（同引用，非逐调用重读）。
    const calls = acts.projectExternalIntentForIcp.mock.calls;
    expect(calls).toHaveLength(2);
    for (const [arg] of calls) {
      expect((arg as { live: unknown }).live).toBe(live);
      expect(arg).toMatchObject({ tedEnabled: true, openfdaEnabled: true });
    }

    // 顺序守：list → expire → resolve → ingest → live → project（live 读在 ingest 之后、所有投影之前）。
    expect(firstOrder(acts.listExternalIntentTargets)).toBeLessThan(firstOrder(acts.expireStaleSignals));
    expect(firstOrder(acts.expireStaleSignals)).toBeLessThan(firstOrder(acts.resolveExternalIntentTarget));
    expect(firstOrder(acts.resolveExternalIntentTarget)).toBeLessThan(firstOrder(acts.ingestExternalSignals));
    expect(firstOrder(acts.ingestExternalSignals)).toBeLessThan(firstOrder(acts.liveProviderState));
    expect(firstOrder(acts.liveProviderState)).toBeLessThan(Math.min(...acts.projectExternalIntentForIcp.mock.invocationCallOrder));

    // 聚合正确（含 expiredSignals 状态机翻转数穿线）。
    expect(out.swept).toBe(2);
    expect(out.expiredSignals).toBe(3);
    expect(out.tenderCompaniesTouched).toBe(4);
    expect(out.tenderEvents).toBe(8);
    expect(out.clearanceCompaniesTouched).toBe(2);
    expect(out.clearanceEvents).toBe(2);
  });

  it('liveProviderState 抛错 → 每个投影拿到 live: undefined（try/catch→undefined 兜底），workflow 仍完成', async () => {
    primeHappyPath([target('ws-1', 'icp-1'), target('ws-2', 'icp-2')]);
    acts.liveProviderState.mockRejectedValue(new Error('owner-db down'));

    const out = await externalIntentSweepWorkflow({});

    const calls = acts.projectExternalIntentForIcp.mock.calls;
    expect(calls).toHaveLength(2);
    for (const [arg] of calls) {
      // 'live' 键必须**存在**（穿线为 undefined）——区分「threaded-as-undefined」与「根本没穿线」（后者亦由 test#1 抓，此处独立加固）。
      expect('live' in (arg as object)).toBe(true);
      expect((arg as { live: unknown }).live).toBeUndefined();
    }
    expect(out.swept).toBe(2); // 单次读故障不放大成整轮不投（活动层自读兜底）
  });
});

describe('externalIntentSweepWorkflow — fail-safe 分支', () => {
  it('两 provider 全 disabled → 早返，不触任何下游活动，结果为零 agg', async () => {
    acts.listExternalIntentTargets.mockResolvedValue({ targets: [target('ws-1', 'icp-1')], tedEnabled: false, openfdaEnabled: false, samgovEnabled: false });

    const out = await externalIntentSweepWorkflow({});

    expect(acts.expireStaleSignals).not.toHaveBeenCalled();
    expect(acts.resolveExternalIntentTarget).not.toHaveBeenCalled();
    expect(acts.ingestExternalSignals).not.toHaveBeenCalled();
    expect(acts.liveProviderState).not.toHaveBeenCalled();
    expect(acts.projectExternalIntentForIcp).not.toHaveBeenCalled();
    expect(out).toEqual({
      swept: 0, expiredSignals: 0, tenderCompaniesTouched: 0, tenderEvents: 0, clearanceCompaniesTouched: 0, clearanceEvents: 0, samCompaniesTouched: 0, samEvents: 0, results: [],
    });
  });

  it('一个投影 reject → 该目标记 fail-safe error 结果，另一目标仍处理，聚合只计成功者', async () => {
    primeHappyPath([target('ws-1', 'icp-1'), target('ws-2', 'icp-2')]);
    // call1 reject（→ 编排 fail-safe error 结果）；call2 落回 happy 默认（tenders 4）。
    acts.projectExternalIntentForIcp.mockRejectedValueOnce(new Error('project boom'));

    const out = await externalIntentSweepWorkflow({});

    expect(out.swept).toBe(2);
    expect(out.results).toHaveLength(2);
    expect(out.results[0].error).toContain('project boom');
    expect(out.results[1].error).toBeUndefined();
    expect(out.tenderEvents).toBe(4); // 仅成功目标计入
  });

  it('resolveExternalIntentTarget reject 一次 → fail-safe 桩（空码 + error）仍进 ingest.targets，workflow 完成', async () => {
    const t1 = target('ws-1', 'icp-1');
    const t2 = target('ws-2', 'icp-2');
    primeHappyPath([t1, t2]);
    acts.resolveExternalIntentTarget.mockRejectedValueOnce(new Error('resolve boom')); // t1 fail；t2 落回 echo 默认

    await externalIntentSweepWorkflow({});

    const ingestArg = acts.ingestExternalSignals.mock.calls[0][0] as { targets: Array<Record<string, unknown>> };
    expect(ingestArg.targets).toHaveLength(2);
    expect(ingestArg.targets[0]).toMatchObject({ workspaceId: 'ws-1', cpvCodes: [], buyerCountries: [], fdaProductCodes: [] });
    expect(ingestArg.targets[0].error).toContain('resolve boom');
    expect(acts.projectExternalIntentForIcp).toHaveBeenCalledTimes(2); // 两个 resolved 条目仍投影
  });

  it('ingestExternalSignals reject → fail-safe ingest 汇总（errors 非空），投影仍跑（吃前窗已落库信号）', async () => {
    primeHappyPath([target('ws-1', 'icp-1'), target('ws-2', 'icp-2')]);
    acts.ingestExternalSignals.mockRejectedValue(new Error('ingest boom'));

    const out = await externalIntentSweepWorkflow({});

    expect(out.ingest?.errors?.[0]).toContain('ingest boom');
    expect(out.ingest).toMatchObject({ tedSpecs: 0, fdaSpecs: 0, signalsUpserted: 0, budgetExceeded: false });
    expect(acts.liveProviderState).toHaveBeenCalledTimes(1);
    expect(acts.projectExternalIntentForIcp).toHaveBeenCalledTimes(2);
  });
});

describe('externalIntentSweepWorkflow — 过期后 intent 复算 + patched 版本化守卫（#56/#70 P2）', () => {
  it('patched=true（新执行）→ recomputeExpiredIntent 在 ingest 后、所有投影前调一次，收 resolved targets，聚合进 out.recompute', async () => {
    primeHappyPath([target('ws-1', 'icp-1'), target('ws-2', 'icp-2')]);

    const out = await externalIntentSweepWorkflow({});

    expect(acts.recomputeExpiredIntent).toHaveBeenCalledTimes(1);
    const arg = acts.recomputeExpiredIntent.mock.calls[0][0] as { targets: Array<Record<string, unknown>> };
    expect(arg.targets).toHaveLength(2);
    expect(arg.targets[0]).toMatchObject({ workspaceId: 'ws-1', cpvCodes: ['42122000'], buyerCountries: ['DEU'], fdaProductCodes: ['LLZ'] });
    // 顺序：ingest 后、所有投影之前（过期事件先清出，投影再按 ACTIVE 信号加）。
    expect(firstOrder(acts.ingestExternalSignals)).toBeLessThan(firstOrder(acts.recomputeExpiredIntent));
    expect(firstOrder(acts.recomputeExpiredIntent)).toBeLessThan(Math.min(...acts.projectExternalIntentForIcp.mock.invocationCallOrder));
    expect(out.recompute).toEqual({ workspacesRecomputed: 1, companiesRebuilt: 2, companiesCleared: 1, truncated: 0 });
  });

  it('patched=false（飞行中旧历史 replay）→ recomputeExpiredIntent **不**被调（命令序列与旧历史一致），投影仍跑', async () => {
    primeHappyPath([target('ws-1', 'icp-1'), target('ws-2', 'icp-2')]);
    setPatched(() => false);

    const out = await externalIntentSweepWorkflow({});

    expect(acts.recomputeExpiredIntent).not.toHaveBeenCalled();
    expect(out.recompute).toBeUndefined();
    expect(acts.projectExternalIntentForIcp).toHaveBeenCalledTimes(2); // 旧路径投影不受影响
    expect(out.swept).toBe(2);
  });

  it('recomputeExpiredIntent reject → fail-safe（out.recompute 记 error），workflow 仍完成投影', async () => {
    primeHappyPath([target('ws-1', 'icp-1')]);
    acts.recomputeExpiredIntent.mockRejectedValue(new Error('recompute boom'));

    const out = await externalIntentSweepWorkflow({});

    expect(out.recompute?.error).toContain('recompute boom');
    expect(acts.projectExternalIntentForIcp).toHaveBeenCalledTimes(1); // 复算失败不阻断投影
    expect(out.swept).toBe(1);
  });
});

describe('externalIntentSweepWorkflow — limit 透传', () => {
  it('传 limit → listExternalIntentTargets 收 { limit }', async () => {
    primeHappyPath([]);
    await externalIntentSweepWorkflow({ limit: 5 });
    expect(acts.listExternalIntentTargets).toHaveBeenCalledWith({ limit: 5 });
  });

  it('缺省 → listExternalIntentTargets 收 {}（无静默截断/不饿死旧 ICP）', async () => {
    primeHappyPath([]);
    await externalIntentSweepWorkflow({});
    expect(acts.listExternalIntentTargets).toHaveBeenCalledWith({});
  });
});

// Codex P1 on PR #70 折中(c)：单次读 + 每 K 个 ICP 在批次头重读——把「sweep 执行途中翻 kill-switch」的
// stale 窗口封到 ≤K 个投影，同时把 owner-DB 读从 N 降到 ⌈N/K⌉（保住 #70 单次读优化绝大部分）。
describe('externalIntentSweepWorkflow — 每 K 个 ICP 重读 kill-switch（#70 折中）', () => {
  const targets = (n: number) => Array.from({ length: n }, (_, i) => target(`ws-${i}`, `icp-${i}`));

  it('N ≤ K（默认 K=25）→ 仍只读一次（保住 #70 单次读，等价旧行为）', async () => {
    primeHappyPath(targets(3));
    await externalIntentSweepWorkflow({});
    expect(acts.liveProviderState).toHaveBeenCalledTimes(1);
  });

  it('N=5, K=2 → 读 ⌈N/K⌉=3 次（i=0/2/4 批次头）', async () => {
    primeHappyPath(targets(5));
    await externalIntentSweepWorkflow({ liveRefreshEvery: 2 });
    expect(acts.liveProviderState).toHaveBeenCalledTimes(3);
  });

  it('批中途 disable → 后续批次投影用新（停用）快照，前面批次不受影响（stale 窗口封到 ≤K）', async () => {
    primeHappyPath(targets(4));
    // 首批读到全启用；运维随后翻闸 → 第二批读到全停用。
    acts.liveProviderState.mockReset();
    acts.liveProviderState
      .mockResolvedValueOnce({ ted: true, openfda: true })
      .mockResolvedValueOnce({ ted: false, openfda: false });

    await externalIntentSweepWorkflow({ liveRefreshEvery: 2 });

    const calls = acts.projectExternalIntentForIcp.mock.calls;
    expect(calls).toHaveLength(4);
    // 批 0（ICP 0,1）用首读快照；批 1（ICP 2,3）用重读到的停用快照 → 翻闸在 ≤K 个投影内生效。
    expect((calls[0][0] as { live: unknown }).live).toEqual({ ted: true, openfda: true });
    expect((calls[1][0] as { live: unknown }).live).toEqual({ ted: true, openfda: true });
    expect((calls[2][0] as { live: unknown }).live).toEqual({ ted: false, openfda: false });
    expect((calls[3][0] as { live: unknown }).live).toEqual({ ted: false, openfda: false });
    expect(acts.liveProviderState).toHaveBeenCalledTimes(2);
  });
});
