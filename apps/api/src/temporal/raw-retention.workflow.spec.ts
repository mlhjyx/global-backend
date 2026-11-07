// Test intent source-mined from tugjvnh@70885cdb; rewritten for current main.
import { beforeEach, describe, expect, it, vi } from "vitest";

const temporal = vi.hoisted(() => ({ continueAsNew: vi.fn() }));
vi.mock("@temporalio/workflow", async () => ({
  ...(await import("./testing/temporal-workflow.mock")),
  continueAsNew: temporal.continueAsNew,
}));

import {
  acts,
  resetActivities,
  setPatched,
} from "./testing/temporal-workflow.mock";
import { rawRetentionSweepWorkflow } from "./raw-retention.workflow";

beforeEach(() => {
  resetActivities();
  temporal.continueAsNew.mockReset();
  // Q25：访问审计保留期清理的默认回执（无更多到期行）。
  acts.expirePersonalDataAccessAudit.mockResolvedValue({ expired: 0, hasMore: false });
  // 巡检（2026-11-04）：超时 RESERVED 工具预算操作清收的默认回执（无更多孤儿预留）。
  acts.reconcileStaleToolBudgetOperations.mockResolvedValue({ released: 0, hasMore: false });
});

describe("rawRetentionSweepWorkflow deterministic orchestration", () => {
  it("expires due workspaces in bounded activity batches and aggregates immutable receipts", async () => {
    acts.listRawRetentionWorkspaces.mockResolvedValue({
      workspaceIds: ["ws-1", "ws-2"],
      nextCursor: null,
    });
    acts.expireRawSourceRecords
      .mockResolvedValueOnce({ expired: 2, deferredForConflict: 0 })
      .mockResolvedValueOnce({ expired: 1, deferredForConflict: 0 });

    await expect(
      rawRetentionSweepWorkflow({ workspaceLimit: 20, batchSize: 10 }),
    ).resolves.toEqual({
      workspaces: 2,
      expired: 3,
      deferredForConflict: 0,
    });
    expect(acts.expireRawSourceRecords).toHaveBeenCalledTimes(2);
  });

  it("continues remaining workspaces but reports terminal failure truthfully", async () => {
    acts.listRawRetentionWorkspaces.mockResolvedValue({
      workspaceIds: ["ws-1", "ws-2"],
      nextCursor: null,
    });
    acts.expireRawSourceRecords
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce({ expired: 1, deferredForConflict: 0 });

    await expect(rawRetentionSweepWorkflow()).rejects.toThrow(
      "RAW_RETENTION_WORKSPACE_FAILURE:1",
    );
    expect(acts.expireRawSourceRecords).toHaveBeenCalledTimes(2);
  });

  it("never reports success while every due row remains deferred by a real lock conflict", async () => {
    acts.listRawRetentionWorkspaces.mockResolvedValue({
      workspaceIds: ["ws-locked"],
      nextCursor: null,
    });
    acts.expireRawSourceRecords.mockResolvedValue({
      expired: 0,
      deferredForConflict: 1,
    });

    await expect(rawRetentionSweepWorkflow({ batchSize: 1 })).rejects.toThrow(
      "RAW_RETENTION_WORKSPACE_FAILURE:1",
    );
    expect(acts.expireRawSourceRecords).toHaveBeenCalledTimes(20);
  });

  it("continues as new with a stable cursor and aggregate when the page bound is reached", async () => {
    acts.listRawRetentionWorkspaces.mockResolvedValue({
      workspaceIds: ["ws-1"],
      nextCursor: "ws-1",
    });
    acts.expireRawSourceRecords.mockResolvedValue({
      expired: 2,
      deferredForConflict: 0,
    });
    temporal.continueAsNew.mockResolvedValue(undefined);

    await rawRetentionSweepWorkflow({
      workspaceLimit: 1,
      batchSize: 10,
      workspacePagesPerRun: 1,
    });

    expect(temporal.continueAsNew).toHaveBeenCalledWith({
      workspaceLimit: 1,
      batchSize: 10,
      workspacePagesPerRun: 1,
      // B1（L01）：循环上界随输入继续传递（旧历史缺字段 → 冻结默认）。
      maxPagesPerRun: 5,
      maxBatchesPerWorkspace: 20,
      maxBudgetReconcileBatches: 5,
      afterWorkspaceId: "ws-1",
      accumulated: { workspaces: 1, expired: 2, deferredForConflict: 0 },
    });
  });

  it("bounds the per-workspace batches by the recorded input instead of the constant (B1/L01)", async () => {
    acts.listRawRetentionWorkspaces.mockResolvedValue({
      workspaceIds: ["ws-locked"],
      nextCursor: null,
    });
    acts.expireRawSourceRecords.mockResolvedValue({
      expired: 0,
      deferredForConflict: 1,
    });

    await expect(
      rawRetentionSweepWorkflow({ batchSize: 1, maxBatchesPerWorkspace: 2 }),
    ).rejects.toThrow("RAW_RETENTION_WORKSPACE_FAILURE:1");
    expect(acts.expireRawSourceRecords).toHaveBeenCalledTimes(2);
  });

  it("bounds the budget reconcile loop by its own recorded input (B1/L01)", async () => {
    acts.listRawRetentionWorkspaces.mockResolvedValue({
      workspaceIds: ["ws-1"],
      nextCursor: null,
    });
    acts.expireRawSourceRecords.mockResolvedValue({ expired: 0, deferredForConflict: 0 });
    acts.reconcileStaleToolBudgetOperations.mockResolvedValue({ released: 1, hasMore: true });

    await rawRetentionSweepWorkflow({ batchSize: 10, maxBudgetReconcileBatches: 2 });

    // 上限来自 maxBudgetReconcileBatches（2），不是 maxBatchesPerWorkspace 或常量 5。
    expect(acts.reconcileStaleToolBudgetOperations).toHaveBeenCalledTimes(2);
  });

  it("bounds the pages loop by maxPagesPerRun and marks the sweep incomplete for continueAsNew (B1/L01)", async () => {
    acts.listRawRetentionWorkspaces.mockResolvedValue({
      workspaceIds: ["ws-1"],
      nextCursor: "ws-1",
    });
    acts.expireRawSourceRecords.mockResolvedValue({ expired: 1, deferredForConflict: 0 });
    temporal.continueAsNew.mockResolvedValue(undefined);

    await rawRetentionSweepWorkflow({
      workspaceLimit: 1,
      batchSize: 10,
      workspacePagesPerRun: 5,
      maxPagesPerRun: 3,
    });

    expect(acts.listRawRetentionWorkspaces).toHaveBeenCalledTimes(3);
    expect(temporal.continueAsNew).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePagesPerRun: 3,
        maxPagesPerRun: 3,
      }),
    );
  });

  it("carries non-default caps into the next generation (B1/L01)", async () => {
    acts.listRawRetentionWorkspaces.mockResolvedValue({
      workspaceIds: ["ws-1"],
      nextCursor: "ws-1",
    });
    acts.expireRawSourceRecords.mockResolvedValue({ expired: 1, deferredForConflict: 0 });
    temporal.continueAsNew.mockResolvedValue(undefined);

    await rawRetentionSweepWorkflow({
      workspaceLimit: 1,
      batchSize: 10,
      workspacePagesPerRun: 1,
      maxPagesPerRun: 4,
      maxBatchesPerWorkspace: 7,
      maxBudgetReconcileBatches: 3,
    });

    expect(temporal.continueAsNew).toHaveBeenCalledWith(
      expect.objectContaining({
        maxPagesPerRun: 4,
        maxBatchesPerWorkspace: 7,
        maxBudgetReconcileBatches: 3,
      }),
    );
  });

  it("expires the personal-data access audit per workspace until no due row remains", async () => {
    acts.listRawRetentionWorkspaces.mockResolvedValue({
      workspaceIds: ["ws-1"],
      nextCursor: null,
    });
    acts.expireRawSourceRecords.mockResolvedValue({
      expired: 1,
      deferredForConflict: 0,
    });
    acts.expirePersonalDataAccessAudit
      .mockResolvedValueOnce({ expired: 1000, hasMore: true })
      .mockResolvedValueOnce({ expired: 2, hasMore: false });

    await expect(
      rawRetentionSweepWorkflow({ batchSize: 10 }),
    ).resolves.toEqual({ workspaces: 1, expired: 1, deferredForConflict: 0 });
    expect(acts.expirePersonalDataAccessAudit).toHaveBeenCalledTimes(2);
    expect(acts.expirePersonalDataAccessAudit).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      limit: 1000,
    });
  });

  it("releases stale tool-budget reservations per workspace until no stale row remains", async () => {
    acts.listRawRetentionWorkspaces.mockResolvedValue({
      workspaceIds: ["ws-1"],
      nextCursor: null,
    });
    acts.expireRawSourceRecords.mockResolvedValue({ expired: 0, deferredForConflict: 0 });
    acts.reconcileStaleToolBudgetOperations
      .mockResolvedValueOnce({ released: 200, hasMore: true })
      .mockResolvedValueOnce({ released: 3, hasMore: false });

    await rawRetentionSweepWorkflow({ batchSize: 10 });

    expect(acts.reconcileStaleToolBudgetOperations).toHaveBeenCalledTimes(2);
    expect(acts.reconcileStaleToolBudgetOperations).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      limit: 200,
    });
  });

  it("never schedules the budget reconcile on a history recorded before the patch", async () => {
    setPatched((patchId) => patchId !== "budget-operation-reconcile-v1");
    acts.listRawRetentionWorkspaces.mockResolvedValue({
      workspaceIds: ["legacy-ws"],
      nextCursor: null,
    });
    acts.expireRawSourceRecords.mockResolvedValue({ expired: 1, deferredForConflict: 0 });

    await rawRetentionSweepWorkflow({ workspaceLimit: 10, batchSize: 10 });

    expect(acts.reconcileStaleToolBudgetOperations).not.toHaveBeenCalled();
  });

  it("never schedules the audit-retention activity on a history recorded before the patch", async () => {
    setPatched(() => false);
    acts.listRawRetentionWorkspaces.mockResolvedValue({
      workspaceIds: ["legacy-ws"],
      nextCursor: "ignored",
    });
    acts.expireRawSourceRecords.mockResolvedValue({
      expired: 1,
      deferredForConflict: 0,
    });

    await rawRetentionSweepWorkflow({ workspaceLimit: 10, batchSize: 10 });
    expect(acts.expirePersonalDataAccessAudit).not.toHaveBeenCalled();
  });

  it("preserves the pre-pagination activity command sequence on replay", async () => {
    setPatched(() => false);
    acts.listRawRetentionWorkspaces.mockResolvedValue({
      workspaceIds: ["legacy-ws"],
      nextCursor: "ignored",
    });
    acts.expireRawSourceRecords.mockResolvedValue({
      expired: 1,
      deferredForConflict: 0,
    });

    await expect(
      rawRetentionSweepWorkflow({ workspaceLimit: 10, batchSize: 10 }),
    ).resolves.toEqual({
      workspaces: 1,
      expired: 1,
      deferredForConflict: 0,
    });
    expect(acts.listRawRetentionWorkspaces).toHaveBeenCalledWith({ limit: 10 });
    expect(temporal.continueAsNew).not.toHaveBeenCalled();
  });
});
