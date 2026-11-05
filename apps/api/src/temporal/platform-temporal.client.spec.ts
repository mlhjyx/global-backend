import { describe, expect, it, vi } from "vitest";
import { PlatformTemporalClient } from "./platform-temporal.client";

function wired(start = vi.fn(async () => ({ workflowId: "wf-1", firstExecutionRunId: "run-1" }))) {
  const client = new PlatformTemporalClient();
  Object.assign(client as object, {
    connection: { close: vi.fn(async () => undefined) },
    client: { workflow: { start } },
  });
  return { client, start };
}

describe("PlatformTemporalClient (P4-P4b)", () => {
  it("starts platform workflows on the platform-automation understanding queue", async () => {
    const { client, start } = wired();
    await expect(
      client.startWorkflow({
        workflowType: "channelCrawlWorkflow",
        workflowId: "channel-crawl-66666666-6666-4666-8666-666666666666",
        args: [{ channelId: "c" }],
      }),
    ).resolves.toEqual({ workflowId: "wf-1", runId: "run-1" });
    expect(start).toHaveBeenCalledWith("channelCrawlWorkflow", {
      taskQueue: "understanding",
      workflowId: "channel-crawl-66666666-6666-4666-8666-666666666666",
      args: [{ channelId: "c" }],
    });
  });

  it.each([
    { workflowType: "bad workflow", workflowId: "ok-id" },
    { workflowType: "channelCrawlWorkflow", workflowId: "bad id\nnewline" },
  ])("rejects invalid workflow start identifiers %#", async (options) => {
    const { client, start } = wired();
    await expect(client.startWorkflow({ ...options, args: [] })).rejects.toThrow(
      "PLATFORM_WORKFLOW_START_INVALID",
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("reconnects on demand and reports a bounded code when unavailable", async () => {
    const start = vi.fn(async () => ({ workflowId: "wf-1", firstExecutionRunId: "run-1" }));
    const client = new PlatformTemporalClient();
    const connect = vi.fn(async () => {
      throw new Error("no credential");
    });
    Object.assign(client as object, { connect, client: { workflow: { start } } });
    await expect(
      client.startWorkflow({ workflowType: "channelCrawlWorkflow", workflowId: "ok-id", args: [] }),
    ).rejects.toThrow("PLATFORM_TEMPORAL_UNAVAILABLE");
    expect(connect).toHaveBeenCalled();
  });

  it("drops the connection after a start failure and reports a bounded code", async () => {
    const close = vi.fn(async () => undefined);
    const client = new PlatformTemporalClient();
    Object.assign(client as object, {
      connection: { close },
      client: {
        workflow: {
          start: vi.fn(async () => {
            throw new Error("temporal.internal.example:7233 credential");
          }),
        },
      },
    });
    const error = await client
      .startWorkflow({ workflowType: "channelCrawlWorkflow", workflowId: "ok-id", args: [] })
      .catch((err: unknown) => err);
    expect(String(error)).toContain("PLATFORM_TEMPORAL_UNAVAILABLE");
    expect(String(error)).not.toContain("credential");
    expect(close).toHaveBeenCalled();
  });
});
