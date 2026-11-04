import { describe, expect, it, vi } from "vitest";

import {
  PLATFORM_EGRESS_FENCE_UNAVAILABLE,
  PlatformEgressFence,
  PlatformEgressFenceError,
  type PlatformEgressFencePort,
  type PlatformEgressBinding,
} from "./platform-egress-fence";

const BINDING: PlatformEgressBinding = Object.freeze({
  authorityId: "11111111-1111-4111-8111-111111111111",
  scheduleId: "acq-sweep",
  workflowId: "platform-acquisition-acq-sweep",
  workflowRunId: "22222222-2222-4222-8222-222222222222",
  scheduleRequestSha256: "a".repeat(64),
  technicalPolicyRevision: "b".repeat(64),
  accountKey: `platform:${"a".repeat(64)}:22222222-2222-4222-8222-222222222222`,
  expiresAt: new Date("2099-01-01T00:00:00.000Z"),
});

function port(overrides: Partial<PlatformEgressFencePort> = {}) {
  const value: PlatformEgressFencePort = {
    authorize: vi.fn(async () => ({ attemptId: "33333333-3333-4333-8333-333333333333" })),
    claimSend: vi.fn(async () => ({
      attemptId: "33333333-3333-4333-8333-333333333333",
      dispatch: async <T>(execute: () => Promise<T>) => execute(),
    })),
    acknowledged: vi.fn(async () => undefined),
    unknown: vi.fn(async () => undefined),
    ...overrides,
  };
  return value;
}

const operation = (operationKey: string) => ({ operationKey,
  budgetOperationId: "44444444-4444-4444-8444-444444444444",
  budgetOperationKey: "c".repeat(64), reservedMicrousd: 0n,
  execution: { kind: "tool" as const, toolId: "test.tool", toolVersion: "1.0.0" },
});

describe("Platform egress fence v1", () => {
  it("carries the same frozen reservation snapshot across both admission stages", async () => {
    const original = operation("wire-1");
    const durable = port({ authorize: vi.fn(async () => {
      original.reservedMicrousd = 99n;
      original.execution.toolVersion = "changed-after-authorize";
      return { attemptId: "33333333-3333-4333-8333-333333333333" };
    }) });
    await new PlatformEgressFence(durable).authorizeAndDispatchPlatformEgress(BINDING, original, async () => "ok");
    const first = durable.authorize.mock.calls[0][1];
    expect(durable.claimSend.mock.calls[0][2]).toBe(first);
    expect(first.reservedMicrousd).toBe(0n);
    expect(first.execution).toEqual({ kind: "tool", toolId: "test.tool", toolVersion: "1.0.0" });
    expect(Object.isFrozen(first)).toBe(true);
  });
  it("fails closed without a durable fence port", async () => {
    const execute = vi.fn(async () => "must-not-run");
    const fence = new PlatformEgressFence();

    await expect(
      fence.authorizeAndDispatchPlatformEgress(BINDING, operation("wire-1"), execute),
    ).rejects.toEqual(new PlatformEgressFenceError(PLATFORM_EGRESS_FENCE_UNAVAILABLE));
    expect(execute).not.toHaveBeenCalled();
  });

  it("performs the send cut only after the final claim and acknowledges one winner", async () => {
    const calls: string[] = [];
    const execute = vi.fn(async () => {
      calls.push("wire");
      return { ok: true };
    });
    const durable = port({
      authorize: vi.fn(async () => {
        calls.push("authorize");
        return { attemptId: "33333333-3333-4333-8333-333333333333" };
      }),
      claimSend: vi.fn(async () => {
        calls.push("claim");
        return {
          attemptId: "33333333-3333-4333-8333-333333333333",
          dispatch: async <T>(send: () => Promise<T>) => send(),
        };
      }),
      acknowledged: vi.fn(async () => calls.push("ack")),
    });
    const result = await new PlatformEgressFence(durable).authorizeAndDispatchPlatformEgress(
      BINDING,
      operation("wire-1"),
      execute,
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["authorize", "claim", "wire", "ack"]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when revocation or policy drift wins the final CAS", async () => {
    const execute = vi.fn(async () => "must-not-run");
    const durable = port({
      claimSend: vi.fn(async () => {
        throw new PlatformEgressFenceError("PLATFORM_EGRESS_REVOKED");
      }),
    });

    await expect(
      new PlatformEgressFence(durable).authorizeAndDispatchPlatformEgress(
        BINDING,
        operation("wire-1"),
        execute,
      ),
    ).rejects.toEqual(new PlatformEgressFenceError("PLATFORM_EGRESS_REVOKED"));
    expect(execute).not.toHaveBeenCalled();
    expect(durable.acknowledged).not.toHaveBeenCalled();
    expect(durable.unknown).not.toHaveBeenCalled();
  });

  it("records UNKNOWN after the send cut and never invokes a fallback", async () => {
    const execute = vi.fn(async () => {
      throw new Error("transport ack lost");
    });
    const durable = port();

    await expect(
      new PlatformEgressFence(durable).authorizeAndDispatchPlatformEgress(
        BINDING,
        operation("wire-1"),
        execute,
      ),
    ).rejects.toThrow("transport ack lost");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(durable.unknown).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      expect.objectContaining({ reason: "PHYSICAL_CALL_OR_ACK_UNKNOWN" }),
    );
    expect(durable.acknowledged).not.toHaveBeenCalled();
  });

  it("rejects malformed binding and operation keys before touching the port", async () => {
    const durable = port();
    const execute = vi.fn(async () => "must-not-run");
    const fence = new PlatformEgressFence(durable);

    await expect(
      fence.authorizeAndDispatchPlatformEgress(
        { ...BINDING, accountKey: "wrong" },
        operation("wire-1"),
        execute,
      ),
    ).rejects.toEqual(new PlatformEgressFenceError("PLATFORM_EGRESS_BINDING_INVALID"));
    await expect(
      fence.authorizeAndDispatchPlatformEgress(BINDING, operation(""), execute),
    ).rejects.toEqual(new PlatformEgressFenceError("PLATFORM_EGRESS_OPERATION_KEY_INVALID"));
    expect(durable.authorize).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("channel-crawl egress binding (P4-P4)", () => {
  const CRAWL: PlatformEgressBinding = Object.freeze({
    subjectKind: "source_channel",
    authorityId: "11111111-1111-4111-8111-111111111111",
    channelId: "55555555-5555-4555-8555-555555555555",
    crawlRunId: "66666666-6666-4666-8666-666666666666",
    requestSha256: "a".repeat(64),
    technicalPolicyRevision: "b".repeat(64),
    accountKey: `platform:${"a".repeat(64)}:66666666-6666-4666-8666-666666666666`,
  });

  it("dispatches crawl attempts through the crawl ACK transitions", async () => {
    const acknowledgedChannelCrawl = vi.fn(async () => undefined);
    const unknownChannelCrawl = vi.fn(async () => undefined);
    const acknowledged = vi.fn(async () => undefined);
    const fence = new PlatformEgressFence(
      port({ acknowledged, acknowledgedChannelCrawl, unknownChannelCrawl }),
    );
    await expect(
      fence.authorizeAndDispatchPlatformEgress(CRAWL, operation("crawl-wire"), async () => "ok"),
    ).resolves.toBe("ok");
    expect(acknowledgedChannelCrawl).toHaveBeenCalledTimes(1);
    expect(acknowledged).not.toHaveBeenCalled();
  });

  it.each([
    { accountKey: `platform:${"a".repeat(64)}:11111111-1111-4111-8111-111111111111` },
    { channelId: "not-a-uuid" },
    { crawlRunId: "not-a-uuid" },
    { requestSha256: "short" },
    { technicalPolicyRevision: "short" },
  ])("rejects an invalid crawl binding case %#", async (override) => {
    const durable = port();
    await expect(
      new PlatformEgressFence(durable).authorizeAndDispatchPlatformEgress(
        { ...CRAWL, ...override } as PlatformEgressBinding,
        operation("crawl-wire"),
        async () => "must-not-run",
      ),
    ).rejects.toMatchObject({ code: "PLATFORM_EGRESS_BINDING_INVALID" });
    expect(durable.authorize).not.toHaveBeenCalled();
  });

  it("fails closed when the durable port has no crawl ACK transitions", async () => {
    await expect(
      new PlatformEgressFence(port()).authorizeAndDispatchPlatformEgress(
        CRAWL,
        operation("crawl-wire"),
        async () => "must-not-run",
      ),
    ).rejects.toMatchObject({ code: PLATFORM_EGRESS_FENCE_UNAVAILABLE });
  });
});
