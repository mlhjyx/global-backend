import { CancellationScope, isCancellation, patched, proxyActivities } from '@temporalio/workflow';
import type { createSiteBuilderActivities, RefurbishActivityInput } from './site-builder.activities';

type SiteBuilderActivities = ReturnType<typeof createSiteBuilderActivities>;
const MAX_IMAGE_BATCHES_PER_BUILD = 256;

const activities = proxyActivities<SiteBuilderActivities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 2 },
});

const kbActivities = proxyActivities<SiteBuilderActivities>({
  startToCloseTimeout: '10 minutes',
  heartbeatTimeout: '20 seconds',
  retry: { maximumAttempts: 2 },
});

/**
 * 精装修管线（M1-a 骨架 + M1-b P1 brandProfile，09 §2.3）：
 * P1 理解（KB 摄入 → brandProfile，fail-safe 降级）→
 * P3 组装构建（M1-e 换 agent 组装；M1-c/d/f 逐步填 P2/P4）→ P5 收尾。
 * P1 两步刻意**顺序**执行（偏离 09 §2.3 的 ‖ 示意）：brandProfile 的 KB digest
 * 必须看到本次刚摄入的文档，并行会静默漏掉 build 前才上传的资料。
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
      const r = await kbActivities.ingestPendingKb(input);
      kb = { ...r, degraded: false };
    } catch (err) {
      // 🔴 取消必须穿透（Codex P2 / 复审 C1）：吞掉=取消窗口内照样发布
      if (isCancellation(err)) throw err;
      // 其余失败 fail-safe：摄入失败不阻断构建（文档留 queued，可重触发）
    }

    // P1 brandProfile（M1-b）：失败不阻断构建（M1-d 前无下游硬依赖；copy 落地后走模板兜底）。
    // web 研究失败是活动内的独立降级位（researchDegraded），到这里的异常=模型全链失败。
    let profile: { status: 'done' | 'degraded' | 'failed'; gaps: number } = {
      status: 'failed',
      gaps: 0,
    };
    try {
      const p = await activities.buildBrandProfile(input);
      profile = { status: p.researchDegraded ? 'degraded' : 'done', gaps: p.gapsCount };
    } catch (err) {
      if (isCancellation(err)) throw err;
    }

    let images: {
      status: 'done' | 'degraded';
      processed: number;
      failed: number;
      variants: number;
    } = { status: 'degraded', processed: 0, failed: 0, variants: 0 };
    if (patched('site-builder-m1c-image-pipeline-v1')) {
      try {
        if (patched('site-builder-m1c-image-batches-v1')) {
          if (patched('site-builder-m1c-image-workset-v1')) {
            const workset = await kbActivities.listImages(input);
            if (workset.truncated || workset.assetIds.length > MAX_IMAGE_BATCHES_PER_BUILD * 2) {
              throw new Error('image workset exceeds the per-build limit');
            }
            images = { status: 'done', processed: 0, failed: 0, variants: 0 };
            for (let offset = 0; offset < workset.assetIds.length; offset += 2) {
              const assetIds = workset.assetIds.slice(offset, offset + 2);
              const summary: {
                status: 'done' | 'degraded';
                processed: number;
                failed: number;
                variants: number;
                nextCursor?: string | null;
                upperBound?: string | null;
              } = await kbActivities.processImages({
                ...input,
                imageAssetIds: assetIds,
                imageBatchLimit: 2,
              });
              if (summary.processed + summary.failed !== assetIds.length) {
                throw new Error('image batch summary does not cover its frozen workset slice');
              }
              images = {
                status: images.status === 'degraded' || summary.status === 'degraded' ? 'degraded' : 'done',
                processed: images.processed + summary.processed,
                failed: images.failed + summary.failed,
                variants: images.variants + summary.variants,
              };
            }
          } else {
            // Replay-only path for histories that recorded the original cursor batching patch.
            let cursor: string | null = null;
            let upperBound: string | null = null;
            let accumulatedStatus: 'done' | 'degraded' = 'done';
            images = { status: 'done', processed: 0, failed: 0, variants: 0 };
            do {
              const summary: {
                status: 'done' | 'degraded';
                processed: number;
                failed: number;
                variants: number;
                nextCursor?: string | null;
                upperBound?: string | null;
              } = await kbActivities.processImages({
                ...input,
                imageCursor: cursor,
                imageUpperBound: upperBound,
                imageBatchLimit: 2,
              });
              if (summary.status === 'degraded') accumulatedStatus = 'degraded';
              images = {
                status: accumulatedStatus,
                processed: images.processed + summary.processed,
                failed: images.failed + summary.failed,
                variants: images.variants + summary.variants,
              };
              upperBound = summary.upperBound ?? upperBound;
              const nextCursor: string | null = summary.nextCursor ?? null;
              if (nextCursor !== null && cursor !== null && nextCursor <= cursor) {
                throw new Error('image batch cursor did not advance');
              }
              cursor = nextCursor;
            } while (cursor !== null);
          }
        } else {
          const summary = await kbActivities.processImages(input);
          images = {
            status: summary.status,
            processed: summary.processed,
            failed: summary.failed,
            variants: summary.variants,
          };
        }
      } catch (err) {
        if (isCancellation(err)) throw err;
        images = { ...images, status: 'degraded' };
      }
    }

    const build = await activities.assembleAndBuild(input);
    return await activities.finalizeRefurbish({ ...input, kb, profile, images, build });
  } catch (err) {
    // 🔴 nonCancellable（复审 C1）：workflow 已被取消时，根作用域再调度 activity 会立即
    // 抛 CancelledFailure。补偿失败必须传播，防止 API 把未持久化的取消误作成功。
    await CancellationScope.nonCancellable(() =>
      activities.compensateRefurbish({
        ...input,
        terminalStatus: isCancellation(err) ? 'cancelled' : 'failed',
      }),
    );
    throw err;
  }
}
