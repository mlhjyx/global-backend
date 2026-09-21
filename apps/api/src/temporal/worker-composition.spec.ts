import { describe, expect, it, vi } from "vitest";
import { workerComposition, workerIdentity } from "./worker-composition";
vi.mock(
  "@temporalio/workflow",
  () => import("./testing/temporal-workflow.mock"),
);
import * as platformWorkflows from "./platform-workflows";
import * as customerWorkflows from "./customer-workflows";

describe("closed runtime workload composition", () => {
  it("separates same-named queues by fixed namespace and refuses arbitrary entrypoints", () => {
    expect(workerComposition("customer-worker")).toMatchObject({
      namespace: "default",
      role: "WORKER",
      taskQueue: "understanding",
    });
    expect(workerComposition("platform-worker")).toMatchObject({
      namespace: "platform-automation",
      role: "PLATFORM_WORKER",
      taskQueue: "understanding",
    });
    expect(() => workerComposition("worker")).toThrow();
  });
  it("does not expose platform handlers to customer workers or customer handlers to platform workers", () => {
    expect(Object.keys(platformWorkflows).sort()).toEqual([
      "acquisitionSweepWorkflow",
      "intentSweepWorkflow",
      "patentsCacheRefreshWorkflow",
      "sanctionsRefreshWorkflow",
    ]);
    for (const name of Object.keys(platformWorkflows))
      expect(Object.keys(customerWorkflows)).not.toContain(name);
    expect(Object.keys(customerWorkflows)).toContain("demoV0Workflow");
    expect(Object.keys(customerWorkflows)).toContain("understandingWorkflow");
  });
  it("binds poller identity to fixed subject and runtime UUID", () => {
    expect(
      workerIdentity(
        "backend-customer",
        "ca372fcc-3bd3-4c58-88a4-8f2b6f10b948",
      ),
    ).toBe("backend-customer:ca372fcc-3bd3-4c58-88a4-8f2b6f10b948");
    expect(() => workerIdentity("backend-customer", "host-name")).toThrow();
  });
});
