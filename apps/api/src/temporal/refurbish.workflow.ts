import { CancellationScope, isCancellation, proxyActivities } from '@temporalio/workflow';
import type { createSiteBuilderActivities, RefurbishActivityInput } from './site-builder.activities';

type SiteBuilderActivities = ReturnType<typeof createSiteBuilderActivities>;

const activities = proxyActivities<SiteBuilderActivities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 2 },
});

/**
 * 精装修管线骨架（M1-a，09 §2.3）：P1 理解（KB 摄入，fail-safe 降级）→
 * P3 组装构建（M1-e 换 agent 组装；M1-c/d/f 逐步填 P2/P4）→ P5 收尾。
 * 🔴 失败补偿走 compensateRefurbish（run 落 failed + 回滚版本行，**绝不删用户站点**）——
 * cleanupFailedDemo 的删站语义只属于 demo_v0（站点因本次注册而生）。
 */
export async function refurbishWorkflow(
  input: RefurbishActivityInput,
): Promise<{ previewSlug: string }> {
  try {
    await activities.beginRefurbishRun(input);

    let kb = { processed: 0, failed: 0, degraded: true };
    try {
      const r = await activities.ingestPendingKb(input);
      kb = { ...r, degraded: false };
    } catch (err) {
      // 🔴 取消必须穿透（Codex P2 / 复审 C1）：吞掉=取消窗口内照样发布
      if (isCancellation(err)) throw err;
      // 其余失败 fail-safe：摄入失败不阻断构建（文档留 queued，可重触发）
    }

    const build = await activities.assembleAndBuild(input);
    return await activities.finalizeRefurbish({ ...input, kb, build });
  } catch (err) {
    try {
      // 🔴 nonCancellable（复审 C1）：workflow 已被取消时，根作用域再调度 activity 会立即
      // 抛 CancelledFailure——补偿必须在不可取消作用域里跑，否则站点永久卡 building。
      await CancellationScope.nonCancellable(() => activities.compensateRefurbish(input));
    } catch {
      // 补偿 best-effort：绝不吞换原始错误
    }
    throw err;
  }
}
