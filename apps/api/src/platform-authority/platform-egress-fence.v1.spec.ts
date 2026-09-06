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

describe("Platform egress fence v1", () => {
  it("fails closed without a durable fence port", async () => {
    const execute = vi.fn(async () => "must-not-run");
    const fence = new PlatformEgressFence();

    await expect(
      fence.authorizeAndDispatchPlatformEgress(BINDING, "wire-1", execute),
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
      "wire-1",
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
        "wire-1",
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
        "wire-1",
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
        "wire-1",
        execute,
      ),
    ).rejects.toEqual(new PlatformEgressFenceError("PLATFORM_EGRESS_BINDING_INVALID"));
    await expect(
      fence.authorizeAndDispatchPlatformEgress(BINDING, "", execute),
    ).rejects.toEqual(new PlatformEgressFenceError("PLATFORM_EGRESS_OPERATION_KEY_INVALID"));
    expect(durable.authorize).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
