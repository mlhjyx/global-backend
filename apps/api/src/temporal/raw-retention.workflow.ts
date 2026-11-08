import { continueAsNew, patched, proxyActivities } from "@temporalio/workflow";
import type { RawSourceActivities } from "./raw-source.activities";

const activities = proxyActivities<RawSourceActivities>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 3 },
});
const PAGINATION_PATCH = "raw-retention-fair-pagination-v2";
const TRUTHFUL_LOCK_PATCH = "raw-retention-truthful-lock-conflicts-v3";
/** Q25（2026-11-04）：个人数据访问审计 180 天保留期清理并入本 sweep。 */
const PERSONAL_DATA_AUDIT_RETENTION_PATCH = "personal-data-access-audit-retention-v1";
/** 巡检（2026-11-04）：超时 RESERVED 的工具预算操作清收并入本 sweep。 */
const BUDGET_OPERATION_RECONCILE_PATCH = "budget-operation-reconcile-v1";
/**
 * B4（审计 F1）：预算清收迁到独立 sweep（tool-budget-reconciliation），本 sweep 不再调度。
 * patch 守卫保证旧历史（无本标记）照旧重放对账命令，新历史不再调度。
 */
const BUDGET_RECONCILE_MOVED_PATCH = "budget-operation-reconcile-moved-v1";
const BUDGET_RECONCILE_BATCH = 200;
/**
 * B1（L01，2026-11-08）：循环上界的冻结默认值——旧历史没有对应输入字段时重放用它们，
 * 一经发布**永不修改**。要调大/调小走 sweep 输入（maxBudgetReconcileBatches / maxBatchesPerWorkspace /
 * maxPagesPerRun / workspacePagesPerRun），新输入会随历史记录。
 */
const MAX_BUDGET_RECONCILE_BATCHES = 5;
const MAX_BATCHES_PER_WORKSPACE = 20;
const DEFAULT_PAGES_PER_RUN = 2;
const MAX_PAGES_PER_RUN = 5;
/** 每批删除的审计行数（活动上限 5000；20 批覆盖单个 workspace 一个 sweep 的 2 万行）。 */
const PERSONAL_DATA_AUDIT_BATCH = 1000;
/**
 * 输入旋钮的夹取上限：也属重放契约——调度参数或 continueAsNew 历史里录过越界值时，
 * 改这些值会改变重放调度次数（NDE）。正常历史（schedule args `[{}]` → 缺省）永远不触及它们。
 */
const PAGES_PER_RUN_CAP = 20;
const BATCHES_PER_WORKSPACE_CAP = 100;
const BUDGET_RECONCILE_BATCHES_CAP = 50;
/** 输入下限：同样属重放契约（<1 的录制值只可能来自手工启动的历史）。 */
const SWEEP_INPUT_FLOOR = 1;

export interface RawRetentionSweepInput {
  workspaceLimit?: number;
  batchSize?: number;
  afterWorkspaceId?: string;
  workspacePagesPerRun?: number;
  /** B1（L01）：循环上界随输入记录；缺省=冻结默认。 */
  maxPagesPerRun?: number;
  maxBatchesPerWorkspace?: number;
  maxBudgetReconcileBatches?: number;
  accumulated?: RawRetentionSweepResult;
}

/** 输入旋钮收敛：非有限数回落冻结默认，越界夹到边界（纯函数，重放确定）。 */
function clampedInput(value: unknown, fallback: number, min: number, max: number): number {
  const candidate =
    typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(Math.max(candidate, min), max);
}

export interface RawRetentionSweepResult {
  workspaces: number;
  expired: number;
  deferredForConflict: number;
}

async function expireWorkspace(
  workspaceId: string,
  batchSize: number,
  truthfulLocks: boolean,
  personalDataAuditRetention: boolean,
  budgetOperationReconcile: boolean,
  maxBatchesPerWorkspace: number,
  maxBudgetReconcileBatches: number,
): Promise<{ expired: number; deferredForConflict: number }> {
  let expired = 0;
  let deferredForConflict = 0;
  let complete = false;
  for (let batch = 0; batch < maxBatchesPerWorkspace; batch += 1) {
    const result = await activities.expireRawSourceRecords({
      workspaceId,
      limit: batchSize,
    });
    expired += result.expired;
    deferredForConflict = Math.max(
      deferredForConflict,
      result.deferredForConflict,
    );
    const completeBatch = truthfulLocks
      ? !(
          result.hasMore ??
          (result.deferredForConflict > 0 || result.expired >= batchSize)
        ) && result.deferredForConflict === 0
      : result.expired < batchSize;
    if (completeBatch) {
      complete = true;
      break;
    }
  }
  if (!complete) throw new Error("RAW_RETENTION_WORKSPACE_INCOMPLETE");
  // Q25：个人数据访问审计的 180 天保留期清理。patch 之前记录的旧历史没有这一步，
  // 重放时命令序列保持不变。
  if (personalDataAuditRetention) {
    for (let batch = 0; batch < maxBatchesPerWorkspace; batch += 1) {
      const receipt = await activities.expirePersonalDataAccessAudit({
        workspaceId,
        limit: PERSONAL_DATA_AUDIT_BATCH,
      });
      if (!receipt.hasMore) break;
    }
  }
  // 巡检（2026-11-04）：超时 RESERVED 工具预算操作清收（释放孤儿预留；patch 前旧历史不调度）。
  if (budgetOperationReconcile) {
    for (let batch = 0; batch < maxBudgetReconcileBatches; batch += 1) {
      const receipt = await activities.reconcileStaleToolBudgetOperations({
        workspaceId,
        limit: BUDGET_RECONCILE_BATCH,
      });
      if (!receipt?.hasMore) break;
    }
  }
  return { expired, deferredForConflict };
}

async function processPage(
  workspaceIds: readonly string[],
  batchSize: number,
  aggregate: RawRetentionSweepResult,
  truthfulLocks: boolean,
  personalDataAuditRetention: boolean,
  budgetOperationReconcile: boolean,
  maxBatchesPerWorkspace: number,
  maxBudgetReconcileBatches: number,
): Promise<{ aggregate: RawRetentionSweepResult; failures: number }> {
  let current = { ...aggregate };
  let failures = 0;
  for (const workspaceId of workspaceIds) {
    current = { ...current, workspaces: current.workspaces + 1 };
    try {
      const result = await expireWorkspace(
        workspaceId,
        batchSize,
        truthfulLocks,
        personalDataAuditRetention,
        budgetOperationReconcile,
        maxBatchesPerWorkspace,
        maxBudgetReconcileBatches,
      );
      current = {
        ...current,
        expired: current.expired + result.expired,
        deferredForConflict:
          current.deferredForConflict + result.deferredForConflict,
      };
    } catch {
      failures += 1;
    }
  }
  return { aggregate: current, failures };
}

/** Deterministic orchestration only; all database work stays in activities. */
export async function rawRetentionSweepWorkflow(
  input: RawRetentionSweepInput = {},
): Promise<RawRetentionSweepResult> {
  const workspaceLimit = Math.max(
    1,
    Math.min(input.workspaceLimit ?? 100, 500),
  );
  const batchSize = Math.max(1, Math.min(input.batchSize ?? 500, 500));
  const usesPagination = patched(PAGINATION_PATCH);
  const truthfulLocks = patched(TRUTHFUL_LOCK_PATCH);
  const personalDataAuditRetention = patched(
    PERSONAL_DATA_AUDIT_RETENTION_PATCH,
  );
  const budgetOperationReconcile =
    patched(BUDGET_OPERATION_RECONCILE_PATCH) && !patched(BUDGET_RECONCILE_MOVED_PATCH);
  // B1（L01）：循环上界来自输入（旧历史缺字段 → 冻结默认），改常量不再是调参手段。
  const maxPagesPerRun = clampedInput(
    input.maxPagesPerRun,
    MAX_PAGES_PER_RUN,
    SWEEP_INPUT_FLOOR,
    PAGES_PER_RUN_CAP,
  );
  const maxBatchesPerWorkspace = clampedInput(
    input.maxBatchesPerWorkspace,
    MAX_BATCHES_PER_WORKSPACE,
    SWEEP_INPUT_FLOOR,
    BATCHES_PER_WORKSPACE_CAP,
  );
  const maxBudgetReconcileBatches = clampedInput(
    input.maxBudgetReconcileBatches,
    MAX_BUDGET_RECONCILE_BATCHES,
    SWEEP_INPUT_FLOOR,
    BUDGET_RECONCILE_BATCHES_CAP,
  );

  if (!usesPagination) {
    const page = await activities.listRawRetentionWorkspaces({
      limit: workspaceLimit,
    });
    const result = await processPage(
      page.workspaceIds,
      batchSize,
      {
        workspaces: 0,
        expired: 0,
        deferredForConflict: 0,
      },
      truthfulLocks,
      personalDataAuditRetention,
      budgetOperationReconcile,
      maxBatchesPerWorkspace,
      maxBudgetReconcileBatches,
    );
    if (result.failures) {
      throw new Error(`RAW_RETENTION_WORKSPACE_FAILURE:${result.failures}`);
    }
    return result.aggregate;
  }

  const pagesPerRun = Math.max(
    1,
    Math.min(
      input.workspacePagesPerRun ?? DEFAULT_PAGES_PER_RUN,
      maxPagesPerRun,
    ),
  );
  let cursor = input.afterWorkspaceId;
  let aggregate = input.accumulated ?? {
    workspaces: 0,
    expired: 0,
    deferredForConflict: 0,
  };
  for (let pageNumber = 0; pageNumber < pagesPerRun; pageNumber += 1) {
    const page = await activities.listRawRetentionWorkspaces({
      limit: workspaceLimit,
      ...(cursor ? { afterWorkspaceId: cursor } : {}),
    });
    const result = await processPage(
      page.workspaceIds,
      batchSize,
      aggregate,
      truthfulLocks,
      personalDataAuditRetention,
      budgetOperationReconcile,
      maxBatchesPerWorkspace,
      maxBudgetReconcileBatches,
    );
    aggregate = result.aggregate;
    if (result.failures) {
      throw new Error(`RAW_RETENTION_WORKSPACE_FAILURE:${result.failures}`);
    }
    if (!page.nextCursor) return aggregate;
    cursor = page.nextCursor;
  }
  return continueAsNew<typeof rawRetentionSweepWorkflow>({
    workspaceLimit,
    batchSize,
    workspacePagesPerRun: pagesPerRun,
    maxPagesPerRun,
    maxBatchesPerWorkspace,
    maxBudgetReconcileBatches,
    afterWorkspaceId: cursor,
    accumulated: aggregate,
  });
}
