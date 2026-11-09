/**
 * 召回审计编排（ch03 §3.17，批次 3b 骨架）。
 *
 * 输入 = 一个 frame 快照 + 一次 run 的产出池；workflow 依次导出两侧输入、跑
 * Wilson 95% CI 估计，返回可复算的 manifest 指纹 + 分层结果。抽样 seed 与两侧
 * sha256 一起构成报告指纹（口径与 recall-audit.mjs 一致）。
 *
 * 灰度默认关：`RECALL_AUDIT_WORKFLOW_ENABLED` 未开时活动一律抛 RECALL_AUDIT_DISABLED；
 * 本 workflow 不注册任何 schedule。
 */
import { proxyActivities } from '@temporalio/workflow';
import type { RecallAuditActivities } from './recall-audit.activities';
import type { RecallAuditResult } from '../registry/recall-audit';
import type { RecallFrameExportManifest } from '../registry/recall-frame-export';
import type { RecallPoolExportManifest } from '../registry/recall-pool-export';

const { exportRecallFrameForAudit, exportRecallPoolForAudit, runRecallAuditEstimate } =
  proxyActivities<RecallAuditActivities>({
    // 导出是只读全量扫描；大 frame 在活动内按载荷护栏拒绝，不会到此超时。
    startToCloseTimeout: '10 minutes',
    retry: { maximumAttempts: 2 },
  });

export interface RecallAuditWorkflowInput {
  frameKey: string;
  /** 缺省 = 最近一个 PARSED 快照（与帧导出 CLI 同口径）。 */
  snapshotId?: string;
  workspaceId: string;
  runId: string;
  /** 每层抽样量；缺省 = census（层内全查）。 */
  sampleSize?: number | null;
  seed?: string | null;
}

export interface RecallAuditWorkflowResult {
  frame: RecallFrameExportManifest;
  pool: RecallPoolExportManifest;
  audit: RecallAuditResult;
}

export async function recallAuditWorkflow(
  input: RecallAuditWorkflowInput,
): Promise<RecallAuditWorkflowResult> {
  if (!input.frameKey?.trim()) throw new Error('frameKey 不能为空');
  if (!input.workspaceId?.trim() || !input.runId?.trim()) {
    throw new Error('workspaceId 与 runId 不能为空');
  }
  if (
    input.sampleSize !== undefined &&
    input.sampleSize !== null &&
    (!Number.isInteger(input.sampleSize) || input.sampleSize <= 0)
  ) {
    throw new Error(`sampleSize 必须是正整数：${input.sampleSize}`);
  }

  const frame = await exportRecallFrameForAudit({
    frameKey: input.frameKey,
    snapshotId: input.snapshotId ?? null,
  });
  const pool = await exportRecallPoolForAudit({
    workspaceId: input.workspaceId,
    runId: input.runId,
  });
  const audit = await runRecallAuditEstimate({
    frame: frame.entities,
    pool: pool.pool,
    sampleSize: input.sampleSize ?? null,
    seed: input.seed ?? null,
  });

  return { frame: frame.manifest, pool: pool.manifest, audit };
}
