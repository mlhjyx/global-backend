import { describe, expect, it } from "vitest";
import type { PlatformEgressOperation } from "./platform-egress-operation";
import { createPlatformToolWireDispatcher } from "./platform-tool-wire-dispatcher";

function operation(toolId = "tradefair.algolia"): PlatformEgressOperation {
  return { operationKey: "parent", budgetOperationId: "11111111-1111-4111-8111-111111111111",
    budgetOperationKey: "a".repeat(64), reservedMicrousd: 0n,
    execution: { kind: "tool", toolId, toolVersion: "1.0.0" } };
}

describe("platform per-transport dispatcher", () => {
  it("gives each page its own stable fence identity without changing the parent reservation", async () => {
    const observed: PlatformEgressOperation[] = [];
    const dispatcher = { authorizeAndDispatch: async <T>(op: PlatformEgressOperation, run: () => Promise<T>) => {
      observed.push(op); return run();
    } };
    const run = createPlatformToolWireDispatcher(operation(), dispatcher);
    expect(await run("tradefair.algolia.page", async () => "first")).toBe("first");
    expect(await run("tradefair.algolia.page", async () => "second")).toBe("second");
    expect(observed[0].operationKey).not.toBe(observed[1].operationKey);
    expect(observed.every(op => op.budgetOperationId === operation().budgetOperationId
      && op.budgetOperationKey === operation().budgetOperationKey && op.reservedMicrousd === 0n)).toBe(true);
    await createPlatformToolWireDispatcher(operation(), dispatcher)("tradefair.algolia.page", async () => 1);
    expect(observed[2].operationKey).toBe(observed[0].operationKey);
  });

  it("enforces the official ten-page bound before an eleventh transport", async () => {
    let wires = 0;
    const run = createPlatformToolWireDispatcher(operation(), { authorizeAndDispatch: async (_op, execute) => execute() });
    for (let i = 0; i < 10; i++) await run("tradefair.algolia.page", async () => ++wires);
    await expect(run("tradefair.algolia.page", async () => ++wires)).rejects.toThrow("PLATFORM_EGRESS_PHYSICAL_WIRE_INVALID");
    expect(wires).toBe(10);
  });

  it("rejects another tool's wire before sending", async () => {
    let wires = 0;
    const run = createPlatformToolWireDispatcher(operation(), { authorizeAndDispatch: async (_op, execute) => execute() });
    await expect(run("mapyourshow.fetch", async () => ++wires)).rejects.toThrow("PLATFORM_EGRESS_PHYSICAL_WIRE_INVALID");
    expect(wires).toBe(0);
  });

  it("never sends again after transport or ACK uncertainty even when a caller catches it", async () => {
    let wires = 0;
    const run = createPlatformToolWireDispatcher(operation(), { authorizeAndDispatch: async (_op, execute) => {
      await execute(); throw new Error("ACK_UNKNOWN");
    } });
    await expect(run("tradefair.algolia.page", async () => ++wires)).rejects.toThrow("PLATFORM_EGRESS_PHYSICAL_WIRE_FAILED");
    await expect(run("tradefair.algolia.page", async () => ++wires)).rejects.toThrow("PLATFORM_EGRESS_PHYSICAL_WIRE_CLOSED");
    expect(wires).toBe(1);
  });

  it.each(["unknown", "google_patents.search"])("rejects unsupported or disabled tool %s", tool => {
    expect(() => createPlatformToolWireDispatcher(operation(tool), { authorizeAndDispatch: async (_op, run) => run() }))
      .toThrow("PLATFORM_EGRESS_PHYSICAL_WIRE_UNAVAILABLE");
  });

  it("rejects a wrong tool version and model instead of inventing a wire contract", () => {
    const dispatcher = { authorizeAndDispatch: async <T>(_op: PlatformEgressOperation, run: () => Promise<T>) => run() };
    expect(() => createPlatformToolWireDispatcher({ ...operation(), execution: {
      kind: "tool", toolId: "tradefair.algolia", toolVersion: "missing" } }, dispatcher)).toThrow("UNAVAILABLE");
    expect(() => createPlatformToolWireDispatcher({ ...operation(), execution: {
      kind: "model", modelOp: "generateText", taskId: "task", providerId: "provider" } }, dispatcher)).toThrow("UNAVAILABLE");
  });

  it("bounds robots redirects separately from the renderer dispatch", async () => {
    let wires = 0;
    const run = createPlatformToolWireDispatcher(operation("crawl4ai.render"), {
      authorizeAndDispatch: async (_op, execute) => execute() });
    for (let i = 0; i < 4; i++) await run("robots.public_http", async () => ++wires);
    await run("crawl4ai.render.dispatch", async () => ++wires);
    await expect(run("robots.public_http", async () => ++wires)).rejects.toThrow("INVALID");
    expect(wires).toBe(5);
  });

  it("rejects concurrent sends and keeps the invocation closed afterward", async () => {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let wires = 0;
    const run = createPlatformToolWireDispatcher(operation(), {
      authorizeAndDispatch: async (_op, execute) => execute() });
    const first = run("tradefair.algolia.page", async () => { wires++; await barrier; });
    await expect(run("tradefair.algolia.page", async () => ++wires)).rejects.toThrow("CLOSED");
    release(); await first;
    await expect(run("tradefair.algolia.page", async () => ++wires)).rejects.toThrow("CLOSED");
    expect(wires).toBe(1);
  });
});
