import {
  CancellationScope,
  isCancellation,
  patched,
  proxyActivities,
} from "@temporalio/workflow";
import type {
  createSiteBuilderActivities,
  RefurbishActivityInput,
} from "./site-builder.activities";

type SiteBuilderActivities = ReturnType<typeof createSiteBuilderActivities>;
const MAX_IMAGE_BATCHES_PER_BUILD = 256;

const activities = proxyActivities<SiteBuilderActivities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 2 },
});

const kbActivities = proxyActivities<SiteBuilderActivities>({
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "20 seconds",
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
    const progressV1 = patched("site-builder-r3b2-progress-v1");
    const progress = async (
      event: Parameters<SiteBuilderActivities["recordRefurbishProgress"]>[0],
    ): Promise<void> => {
      if (progressV1) await activities.recordRefurbishProgress(event);
    };

    let kb = { processed: 0, failed: 0, degraded: true };
    await progress({
      ...input,
      key: "kb_ingest",
      status: "running",
      phase: "P1_understanding",
      progress: 0.08,
    });
    try {
      const r = await kbActivities.ingestPendingKb(input);
      kb = { ...r, degraded: false };
      await progress({
        ...input,
        key: "kb_ingest",
        status: r.failed ? "degraded" : "done",
        phase: "P1_understanding",
        progress: 0.18,
      });
    } catch (err) {
      // 🔴 取消必须穿透（Codex P2 / 复审 C1）：吞掉=取消窗口内照样发布
      if (isCancellation(err)) throw err;
      // 其余失败 fail-safe：摄入失败不阻断构建（文档留 queued，可重触发）
      await progress({
        ...input,
        key: "kb_ingest",
        status: "degraded",
        phase: "P1_understanding",
        progress: 0.18,
        errorCode: "KB_INGEST_DEGRADED",
      });
    }

    // P1 brandProfile（M1-b）：失败不阻断构建（M1-d 前无下游硬依赖；copy 落地后走模板兜底）。
    // web 研究失败是活动内的独立降级位（researchDegraded），到这里的异常=模型全链失败。
    let profile: { status: "done" | "degraded" | "failed"; gaps: number } = {
      status: "failed",
      gaps: 0,
    };
    await progress({
      ...input,
      key: "brand_profile",
      status: "running",
      phase: "P1_understanding",
      progress: 0.2,
    });
    try {
      const p = await activities.buildBrandProfile(input);
      profile = {
        status: p.researchDegraded ? "degraded" : "done",
        gaps: p.gapsCount,
      };
      await progress({
        ...input,
        key: "brand_profile",
        status: p.researchDegraded ? "degraded" : "done",
        phase: "P1_understanding",
        progress: 0.32,
      });
    } catch (err) {
      if (isCancellation(err)) throw err;
      await progress({
        ...input,
        key: "brand_profile",
        status: "failed",
        phase: "P1_understanding",
        progress: 0.32,
        errorCode: "BRAND_PROFILE_FAILED",
      });
    }

    let images: {
      status: "done" | "degraded";
      processed: number;
      failed: number;
      variants: number;
    } = { status: "degraded", processed: 0, failed: 0, variants: 0 };
    await progress({
      ...input,
      key: "image_pipeline",
      status: "running",
      phase: "P2_assets",
      progress: 0.35,
    });
    if (patched("site-builder-m1c-image-pipeline-v1")) {
      try {
        if (patched("site-builder-m1c-image-batches-v1")) {
          if (patched("site-builder-m1c-image-workset-v1")) {
            const workset = await kbActivities.listImages(input);
            if (
              workset.truncated ||
              workset.assetIds.length > MAX_IMAGE_BATCHES_PER_BUILD * 2
            ) {
              throw new Error("image workset exceeds the per-build limit");
            }
            images = { status: "done", processed: 0, failed: 0, variants: 0 };
            for (
              let offset = 0;
              offset < workset.assetIds.length;
              offset += 2
            ) {
              const assetIds = workset.assetIds.slice(offset, offset + 2);
              const summary: {
                status: "done" | "degraded";
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
                throw new Error(
                  "image batch summary does not cover its frozen workset slice",
                );
              }
              images = {
                status:
                  images.status === "degraded" || summary.status === "degraded"
                    ? "degraded"
                    : "done",
                processed: images.processed + summary.processed,
                failed: images.failed + summary.failed,
                variants: images.variants + summary.variants,
              };
              await progress({
                ...input,
                key: "image_pipeline",
                itemKey: assetIds.join(","),
                status: summary.status === "degraded" ? "degraded" : "done",
                phase: "P2_assets",
                progress:
                  0.35 +
                  0.2 *
                    ((offset + assetIds.length) /
                      Math.max(1, workset.assetIds.length)),
              });
            }
          } else {
            // Replay-only path for histories that recorded the original cursor batching patch.
            let cursor: string | null = null;
            let upperBound: string | null = null;
            let accumulatedStatus: "done" | "degraded" = "done";
            images = { status: "done", processed: 0, failed: 0, variants: 0 };
            do {
              const summary: {
                status: "done" | "degraded";
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
              if (summary.status === "degraded") accumulatedStatus = "degraded";
              images = {
                status: accumulatedStatus,
                processed: images.processed + summary.processed,
                failed: images.failed + summary.failed,
                variants: images.variants + summary.variants,
              };
              upperBound = summary.upperBound ?? upperBound;
              const nextCursor: string | null = summary.nextCursor ?? null;
              if (
                nextCursor !== null &&
                cursor !== null &&
                nextCursor <= cursor
              ) {
                throw new Error("image batch cursor did not advance");
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
        images = { ...images, status: "degraded" };
      }
    }

    await progress({
      ...input,
      key: "image_pipeline",
      status: images.status === "degraded" ? "degraded" : "done",
      phase: "P2_assets",
      progress: 0.55,
      ...(images.status === "degraded"
        ? { errorCode: "IMAGE_PIPELINE_DEGRADED" }
        : {}),
    });
    const controlledAssemblyV1 = patched(
      "site-builder-m1eb-controlled-assembly-v1",
    );
    let designBrief:
      | Awaited<ReturnType<SiteBuilderActivities["generateDesignBrief"]>>
      | undefined;
    if (controlledAssemblyV1) {
      await progress({
        ...input,
        key: "design_spec",
        status: "running",
        phase: "P3_assembly",
        progress: 0.56,
      });
      designBrief = await activities.generateDesignBrief(input);
      await progress({
        ...input,
        key: "design_spec",
        status: "done",
        phase: "P3_assembly",
        progress: 0.64,
      });
    }
    let copy:
      | Awaited<ReturnType<SiteBuilderActivities["generateCopyBundles"]>>
      | undefined;
    if (patched("site-builder-m1d-copy-v1")) {
      await progress({
        ...input,
        key: "copy",
        status: "running",
        phase: "P3_assembly",
        progress: controlledAssemblyV1 ? 0.65 : 0.58,
      });
      copy = await activities.generateCopyBundles({
        ...input,
        ...(designBrief ? { designBrief } : {}),
      });
      await progress({
        ...input,
        key: "copy",
        status: copy.degradedLocales.length > 0 ? "degraded" : "done",
        phase: "P3_assembly",
        progress: controlledAssemblyV1 ? 0.72 : 0.62,
        ...(copy.degradedLocales.length > 0
          ? { errorCode: "COPY_OPTIONAL_LOCALE_DEGRADED" }
          : {}),
      });
    } else {
      await progress({
        ...input,
        key: "copy",
        status: "skipped",
        phase: "P3_assembly",
        progress: 0.6,
      });
    }

    await progress({
      ...input,
      key: "assemble_build",
      status: "running",
      phase: "P3_assembly",
      progress: controlledAssemblyV1 ? 0.74 : 0.65,
    });
    const build = await activities.assembleAndBuild({
      ...input,
      ...(designBrief ? { designBrief } : {}),
      ...(copy ? { copy } : {}),
      ...(progressV1 ? { progressV1: true } : {}),
    });
    await progress({
      ...input,
      key: "assemble_build",
      status: "done",
      phase: "P3_assembly",
      progress: 0.9,
    });
    await progress({
      ...input,
      key: "quality_loop",
      status: "skipped",
      phase: "P5_publish",
      progress: 0.95,
    });
    return await activities.finalizeRefurbish({
      ...input,
      ...(designBrief ? { designBrief } : {}),
      ...(copy ? { copy } : {}),
      kb,
      profile,
      images,
      build,
      ...(progressV1 ? { progressV1: true } : {}),
    });
  } catch (err) {
    // 🔴 nonCancellable（复审 C1）：workflow 已被取消时，根作用域再调度 activity 会立即
    // 抛 CancelledFailure。补偿失败必须传播，防止 API 把未持久化的取消误作成功。
    await CancellationScope.nonCancellable(() => {
      const progressV1 = patched("site-builder-r3b2-progress-v1");
      return activities.compensateRefurbish({
        ...input,
        terminalStatus: isCancellation(err) ? "cancelled" : "failed",
        ...(progressV1 ? { progressV1: true } : {}),
      });
    });
    throw err;
  }
}
