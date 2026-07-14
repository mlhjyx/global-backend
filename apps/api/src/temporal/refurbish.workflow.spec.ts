import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

/**
 * `refurbishWorkflow` 编排单测（M1-a 骨架，09 §2.3）。
 * 复用 PR #73 hermetic proxyActivities-mock harness（两行接线先例）。
 * 守：P1→P3→P5 顺序、KB 摄入 fail-safe 降级、失败补偿走 compensateRefurbish
 * （🔴 绝不 cleanupFailedDemo——那个补偿会删整站，只属于 demo_v0）。
 */

vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

import { acts, resetActivities } from './testing/temporal-workflow.mock';
import { refurbishWorkflow } from './refurbish.workflow';

const INPUT = { workspaceId: 'ws-1', siteId: 'site-1', buildRunId: 'run-1' };

function primeHappyPath() {
  acts.beginRefurbishRun.mockResolvedValue(undefined);
  acts.ingestPendingKb.mockResolvedValue({ processed: 2, failed: 0 });
  acts.buildBrandProfile.mockResolvedValue({
    version: 1,
    factCount: 5,
    gapsCount: 2,
    researchDegraded: false,
    model: 'deepseek-v4-pro',
  });
  acts.assembleAndBuild.mockResolvedValue({ previewSlug: 'acme-abc123', versionId: 'ver-1' });
  acts.finalizeRefurbish.mockImplementation(async (arg: Record<string, unknown>) => ({
    previewSlug: (arg.build as { previewSlug: string }).previewSlug,
  }));
  acts.compensateRefurbish.mockResolvedValue(undefined);
}

const firstOrder = (m: Mock): number => m.mock.invocationCallOrder[0];

beforeEach(() => resetActivities());

describe('refurbishWorkflow — happy path（P1 → P3 → P5）', () => {
  it('顺序 begin < ingest < brandProfile < assemble < finalize（🔴 digest 必须看到刚摄入的文档=顺序非并行）；不触发补偿', async () => {
    primeHappyPath();

    const out = await refurbishWorkflow(INPUT);

    expect(firstOrder(acts.beginRefurbishRun)).toBeLessThan(firstOrder(acts.ingestPendingKb));
    expect(firstOrder(acts.ingestPendingKb)).toBeLessThan(firstOrder(acts.buildBrandProfile));
    expect(firstOrder(acts.buildBrandProfile)).toBeLessThan(firstOrder(acts.assembleAndBuild));
    expect(firstOrder(acts.assembleAndBuild)).toBeLessThan(firstOrder(acts.finalizeRefurbish));
    expect(acts.compensateRefurbish).not.toHaveBeenCalled();
    expect(out).toEqual({ previewSlug: 'acme-abc123' });
  });

  it('finalize 收到 kb 摘要（degraded=false）、profile 摘要（done+gaps）与 build 产物', async () => {
    primeHappyPath();
    await refurbishWorkflow(INPUT);
    expect(acts.finalizeRefurbish).toHaveBeenCalledWith(
      expect.objectContaining({
        ...INPUT,
        kb: { processed: 2, failed: 0, degraded: false },
        profile: { status: 'done', gaps: 2 },
        build: { previewSlug: 'acme-abc123', versionId: 'ver-1' },
      }),
    );
  });

  it('研究降级（researchDegraded=true）→ profile.status=degraded（仅凭 KB 出 Brief 的诚实标记）', async () => {
    primeHappyPath();
    acts.buildBrandProfile.mockResolvedValue({
      version: 1,
      factCount: 3,
      gapsCount: 4,
      researchDegraded: true,
      model: 'deepseek-v4-pro',
    });
    await refurbishWorkflow(INPUT);
    expect(acts.finalizeRefurbish).toHaveBeenCalledWith(
      expect.objectContaining({ profile: { status: 'degraded', gaps: 4 } }),
    );
  });

  it('scope 透传给 begin 与 assemble（增量重跑的入口参数）', async () => {
    primeHappyPath();
    const scoped = { ...INPUT, scope: { scope: 'site' as const } };
    await refurbishWorkflow(scoped);
    expect(acts.beginRefurbishRun).toHaveBeenCalledWith(expect.objectContaining(scoped));
    expect(acts.assembleAndBuild).toHaveBeenCalledWith(expect.objectContaining(scoped));
  });
});

describe('refurbishWorkflow — fail-safe 与补偿', () => {
  it('ingestPendingKb 抛错 → kb 降级标记继续（degraded=true），assemble/finalize 照跑', async () => {
    primeHappyPath();
    acts.ingestPendingKb.mockRejectedValue(new Error('docling down'));

    const out = await refurbishWorkflow(INPUT);

    expect(acts.assembleAndBuild).toHaveBeenCalledTimes(1);
    expect(acts.finalizeRefurbish).toHaveBeenCalledWith(
      expect.objectContaining({ kb: { processed: 0, failed: 0, degraded: true } }),
    );
    expect(out).toEqual({ previewSlug: 'acme-abc123' });
  });

  it('buildBrandProfile 抛错（模型全链失败）→ fail-safe：profile.status=failed，构建照常完成', async () => {
    primeHappyPath();
    acts.buildBrandProfile.mockRejectedValue(new Error('all models down'));

    const out = await refurbishWorkflow(INPUT);

    expect(acts.assembleAndBuild).toHaveBeenCalledTimes(1);
    expect(acts.finalizeRefurbish).toHaveBeenCalledWith(
      expect.objectContaining({ profile: { status: 'failed', gaps: 0 } }),
    );
    expect(acts.compensateRefurbish).not.toHaveBeenCalled();
    expect(out).toEqual({ previewSlug: 'acme-abc123' });
  });

  it('brandProfile 期间收到取消（CancelledFailure）→ 穿透不降级：assemble/finalize 不跑，补偿仍执行', async () => {
    primeHappyPath();
    acts.buildBrandProfile.mockRejectedValue(
      Object.assign(new Error('workflow cancelled'), { name: 'CancelledFailure' }),
    );

    await expect(refurbishWorkflow(INPUT)).rejects.toThrow('workflow cancelled');

    expect(acts.assembleAndBuild).not.toHaveBeenCalled();
    expect(acts.finalizeRefurbish).not.toHaveBeenCalled();
    expect(acts.compensateRefurbish).toHaveBeenCalledTimes(1);
  });

  it('assembleAndBuild 抛错 → compensateRefurbish 恰一次 + 原错误上抛；finalize 不调', async () => {
    primeHappyPath();
    acts.assembleAndBuild.mockRejectedValue(new Error('astro boom'));

    await expect(refurbishWorkflow(INPUT)).rejects.toThrow('astro boom');

    expect(acts.compensateRefurbish).toHaveBeenCalledTimes(1);
    expect(acts.compensateRefurbish).toHaveBeenCalledWith(expect.objectContaining(INPUT));
    expect(acts.finalizeRefurbish).not.toHaveBeenCalled();
    // 🔴 雷区守：refurbish 失败绝不走 demo 的删站补偿
    expect(acts.cleanupFailedDemo).not.toHaveBeenCalled();
  });

  it('补偿自身失败 → 仍上抛原始错误（补偿 best-effort 不吞不换错误）', async () => {
    primeHappyPath();
    acts.assembleAndBuild.mockRejectedValue(new Error('astro boom'));
    acts.compensateRefurbish.mockRejectedValue(new Error('compensate boom'));

    await expect(refurbishWorkflow(INPUT)).rejects.toThrow('astro boom');
  });

  it('KB 摄入期间收到取消（CancelledFailure）→ 穿透不降级：assemble/finalize 不跑，补偿仍执行', async () => {
    primeHappyPath();
    acts.ingestPendingKb.mockRejectedValue(
      Object.assign(new Error('workflow cancelled'), { name: 'CancelledFailure' }),
    );

    await expect(refurbishWorkflow(INPUT)).rejects.toThrow('workflow cancelled');

    expect(acts.assembleAndBuild).not.toHaveBeenCalled();
    expect(acts.finalizeRefurbish).not.toHaveBeenCalled();
    expect(acts.compensateRefurbish).toHaveBeenCalledTimes(1); // nonCancellable 作用域内
  });

  it('beginRefurbishRun 抛错 → 直接补偿+上抛（run 落 failed 由补偿兜底）', async () => {
    primeHappyPath();
    acts.beginRefurbishRun.mockRejectedValue(new Error('run row missing'));

    await expect(refurbishWorkflow(INPUT)).rejects.toThrow('run row missing');
    expect(acts.ingestPendingKb).not.toHaveBeenCalled();
    expect(acts.compensateRefurbish).toHaveBeenCalledTimes(1);
  });
});
