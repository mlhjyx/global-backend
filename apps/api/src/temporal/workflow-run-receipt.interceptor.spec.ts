import { beforeEach, describe, expect, it, vi } from "vitest";

const temporal = vi.hoisted(() => ({
  patched: vi.fn(),
  workflowInfo: vi.fn(),
  record: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
  patched: temporal.patched,
  workflowInfo: temporal.workflowInfo,
  proxyLocalActivities: vi.fn(() => ({
    recordWorkflowRunReceipt: temporal.record,
  })),
}));

import { interceptors } from "./workflow-run-receipt.interceptor";

const INFO = {
  workflowId: "discovery-33333333-3333-4333-8333-333333333333",
  runId: "22222222-2222-4222-8222-222222222222",
  workflowType: "discoveryWorkflow",
  taskQueue: "acquisition",
  attempt: 2,
};

function executeInterceptor() {
  const execute = interceptors().inbound?.[0]?.execute;
  if (!execute) throw new Error("missing execute interceptor");
  return execute;
}

describe("workflow run receipt interceptor replay contract", () => {
  beforeEach(() => {
    temporal.patched.mockReset();
    temporal.workflowInfo.mockReset().mockReturnValue(INFO);
    temporal.record.mockReset().mockResolvedValue(undefined);
  });

  it("does not schedule new receipt activities while replaying pre-receipt workflow histories", async () => {
    temporal.patched.mockReturnValue(false);
    const next = vi.fn().mockResolvedValue({ done: true });

    await expect(
      executeInterceptor()(
        {
          args: [
            {
              workspaceId: "11111111-1111-4111-8111-111111111111",
              sensitiveValue: "must-not-leak",
            },
          ],
          headers: {},
        },
        next,
      ),
    ).resolves.toEqual({ done: true });

    expect(temporal.patched).toHaveBeenCalledWith("workflow-run-receipt-v1");
    expect(temporal.record).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("records STARTED and COMPLETED for new histories without copying workflow inputs or outputs", async () => {
    temporal.patched.mockReturnValue(true);
    const next = vi.fn().mockResolvedValue({ email: "output@example.com" });

    await executeInterceptor()(
      {
        args: [
          {
            workspaceId: "11111111-1111-4111-8111-111111111111",
            email: "input@example.com",
          },
        ],
        headers: {},
      },
      next,
    );

    expect(temporal.record).toHaveBeenCalledTimes(2);
    expect(temporal.record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        workflowId: INFO.workflowId,
        runId: INFO.runId,
        workflowType: INFO.workflowType,
        taskQueue: INFO.taskQueue,
        phase: "STARTED",
        stage: "started",
        stats: {},
        errorCode: null,
        budgetTruncated: false,
        retryAttempt: 2,
      }),
    );
    expect(temporal.record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        phase: "COMPLETED",
        stage: "completed",
        stats: {},
      }),
    );
    expect(JSON.stringify(temporal.record.mock.calls)).not.toMatch(
      /input@example|output@example|must-not-leak/,
    );
  });

  it("records a successful workflow's explicit budget truncation flag without retaining its result", async () => {
    temporal.patched.mockReturnValue(true);
    const result = {
      status: "PARTIAL",
      budgetTruncated: true,
      customerEmail: "output@example.com",
    };
    const next = vi.fn().mockResolvedValue(result);

    await expect(
      executeInterceptor()({ args: [{}], headers: {} }, next),
    ).resolves.toBe(result);

    expect(temporal.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: "COMPLETED",
        budgetTruncated: true,
        stats: {},
      }),
    );
    expect(JSON.stringify(temporal.record.mock.calls)).not.toContain(
      "output@example.com",
    );
  });

  it("records a bounded machine error code and budget truncation before preserving the workflow failure", async () => {
    temporal.patched.mockReturnValue(true);
    const failure = Object.assign(
      new Error("contains person@example.com and token"),
      {
        code: "BUDGET_EXHAUSTED",
      },
    );
    const next = vi.fn().mockRejectedValue(failure);

    await expect(
      executeInterceptor()({ args: [{}], headers: {} }, next),
    ).rejects.toBe(failure);

    expect(temporal.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceId: null,
        phase: "FAILED",
        stage: "failed",
        errorCode: "BUDGET_EXHAUSTED",
        budgetTruncated: true,
      }),
    );
    expect(JSON.stringify(temporal.record.mock.calls)).not.toMatch(
      /person@example|token/,
    );
  });
});
