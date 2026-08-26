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
      afterWorkspaceId: "ws-1",
      accumulated: { workspaces: 1, expired: 2, deferredForConflict: 0 },
    });
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
