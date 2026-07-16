import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
} from "@temporalio/client";
import { describe, expect, it, vi } from "vitest";
import type { TemporalClient } from "../temporal/temporal.client";
import { UNDERSTANDING_TASK_QUEUE } from "../temporal/understanding.constants";
import { TemporalDemoV0Launcher } from "./temporal-demo-launcher";

const INPUT = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  siteId: "22222222-2222-4222-8222-222222222222",
  buildRunId: "33333333-3333-4333-8333-333333333333",
};
const WORKFLOW_ID = `site-demo-${INPUT.buildRunId}`;

function makeLauncher() {
  const start = vi.fn();
  const describe = vi.fn();
  const getHandle = vi.fn().mockReturnValue({ describe });
  const temporal = {
    client: { workflow: { start, getHandle } },
  } as unknown as TemporalClient;
  return {
    launcher: new TemporalDemoV0Launcher(temporal),
    start,
    describe,
    getHandle,
  };
}

describe("TemporalDemoV0Launcher exactly-once ACK contract", () => {
  it("首次启动返回 firstExecutionRunId，并同时设置 closed/running 两类幂等 policy", async () => {
    const { launcher, start, getHandle } = makeLauncher();
    start.mockResolvedValue({ firstExecutionRunId: "temporal-run-1" });

    await expect(launcher.launchDemoV0(INPUT)).resolves.toEqual({
      firstExecutionRunId: "temporal-run-1",
    });
    expect(start).toHaveBeenCalledWith("demoV0Workflow", {
      taskQueue: UNDERSTANDING_TASK_QUEUE,
      workflowId: WORKFLOW_ID,
      args: [INPUT],
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    });
    expect(getHandle).not.toHaveBeenCalled();
  });

  it("running conflict 由 USE_EXISTING 返回既有 handle，直接复用其 firstExecutionRunId", async () => {
    const { launcher, start, getHandle } = makeLauncher();
    start.mockResolvedValue({ firstExecutionRunId: "already-running" });

    await expect(launcher.launchDemoV0(INPUT)).resolves.toEqual({
      firstExecutionRunId: "already-running",
    });
    expect(getHandle).not.toHaveBeenCalled();
  });

  it("closed duplicate（ACK 丢失窗口）经 describe 修复，优先取 execution chain 的 firstRunId", async () => {
    const { launcher, start, describe, getHandle } = makeLauncher();
    start.mockRejectedValue(
      new WorkflowExecutionAlreadyStartedError(
        "already started",
        WORKFLOW_ID,
        "demoV0Workflow",
      ),
    );
    describe.mockResolvedValue({
      runId: "latest-run",
      raw: { workflowExecutionInfo: { firstRunId: "first-run" } },
    });

    await expect(launcher.launchDemoV0(INPUT)).resolves.toEqual({
      firstExecutionRunId: "first-run",
    });
    expect(getHandle).toHaveBeenCalledWith(WORKFLOW_ID);
  });

  it("describe 缺 firstRunId 时回退 runId；普通启动错误不伪装成成功", async () => {
    const recovered = makeLauncher();
    recovered.start.mockRejectedValue(
      new WorkflowExecutionAlreadyStartedError(
        "already started",
        WORKFLOW_ID,
        "demoV0Workflow",
      ),
    );
    recovered.describe.mockResolvedValue({ runId: "fallback-run", raw: {} });
    await expect(recovered.launcher.launchDemoV0(INPUT)).resolves.toEqual({
      firstExecutionRunId: "fallback-run",
    });

    const emptyFirst = makeLauncher();
    emptyFirst.start.mockRejectedValue(
      new WorkflowExecutionAlreadyStartedError(
        "already started",
        WORKFLOW_ID,
        "demoV0Workflow",
      ),
    );
    emptyFirst.describe.mockResolvedValue({
      runId: "fallback-from-empty",
      raw: { workflowExecutionInfo: { firstRunId: "" } },
    });
    await expect(emptyFirst.launcher.launchDemoV0(INPUT)).resolves.toEqual({
      firstExecutionRunId: "fallback-from-empty",
    });

    const failed = makeLauncher();
    const original = new Error("connection refused");
    failed.start.mockRejectedValue(original);
    await expect(failed.launcher.launchDemoV0(INPUT)).rejects.toBe(original);
    expect(failed.getHandle).not.toHaveBeenCalled();
  });

  it("Temporal 返回空 execution id 时失败，不生成伪 ACK", async () => {
    const started = makeLauncher();
    started.start.mockResolvedValue({ firstExecutionRunId: "" });
    await expect(started.launcher.launchDemoV0(INPUT)).rejects.toThrow(
      /execution run id/i,
    );

    const described = makeLauncher();
    described.start.mockRejectedValue(
      new WorkflowExecutionAlreadyStartedError(
        "already started",
        WORKFLOW_ID,
        "demoV0Workflow",
      ),
    );
    described.describe.mockResolvedValue({
      runId: "",
      raw: { workflowExecutionInfo: { firstRunId: "" } },
    });
    await expect(described.launcher.launchDemoV0(INPUT)).rejects.toThrow(
      /execution run id/i,
    );
  });

  it("只读恢复既有 workflow 的 firstExecutionRunId，绝不调用 start", async () => {
    const { launcher, start, describe, getHandle } = makeLauncher();
    describe.mockResolvedValue({
      runId: "latest-run",
      raw: { workflowExecutionInfo: { firstRunId: "recovered-first-run" } },
    });

    await expect(launcher.recoverDemoV0(INPUT)).resolves.toEqual({
      firstExecutionRunId: "recovered-first-run",
    });
    expect(getHandle).toHaveBeenCalledWith(WORKFLOW_ID);
    expect(start).not.toHaveBeenCalled();
  });
});
