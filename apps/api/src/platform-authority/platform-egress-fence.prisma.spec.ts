import { describe, expect, it, vi } from "vitest";

import { PrismaPlatformEgressFencePort } from "./platform-egress-fence.prisma";

describe("Prisma platform egress fence port", () => {
  it("uses migration-owned function calls instead of direct table writes", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([
        {
          attempt_id: "11111111-1111-4111-8111-111111111111",
          generation: 0n,
          replay: false,
        },
      ])
      .mockResolvedValueOnce([
        {
          attempt_id: "11111111-1111-4111-8111-111111111111",
          generation: 0n,
        },
      ])
      .mockResolvedValue([]);
    const port = new PrismaPlatformEgressFencePort({ $queryRaw: queryRaw } as never);
    const binding = {
      authorityId: "22222222-2222-4222-8222-222222222222",
      scheduleId: "acq-sweep",
      workflowId: "workflow",
      workflowRunId: "33333333-3333-4333-8333-333333333333",
      scheduleRequestSha256: "a".repeat(64),
      technicalPolicyRevision: "b".repeat(64),
      accountKey: `platform:${"a".repeat(64)}:33333333-3333-4333-8333-333333333333`,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    } as const;

    const authorization = await port.authorize(binding, "wire");
    const capability = await port.claimSend(binding, authorization, "wire");
    const execute = vi.fn(async () => "ok");
    await expect(capability.dispatch(execute)).resolves.toBe("ok");
    await expect(capability.dispatch(execute)).rejects.toThrow("PLATFORM_EGRESS_CAPABILITY_REUSED");
    await port.acknowledged(capability.attemptId, { state: "ACKNOWLEDGED" });
    await port.unknown(capability.attemptId, { reason: "PHYSICAL_CALL_OR_ACK_UNKNOWN" });

    expect(queryRaw).toHaveBeenCalledTimes(4);
    const sql = queryRaw.mock.calls.map(([query]) => String(query.text ?? query)).join(" ");
    expect(sql).toContain("authorize_platform_egress_v1");
    expect(sql).toContain("claim_platform_egress_send_v1");
    expect(sql).toContain("acknowledge_platform_egress_v1");
    expect(sql).toContain("mark_unknown_platform_egress_v1");
    expect(sql).not.toMatch(/INSERT\s+INTO\s+platform_egress_attempt/i);
  });

  it("fails closed when a durable transition returns no row", async () => {
    const port = new PrismaPlatformEgressFencePort({
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as never);
    const binding = {
      authorityId: "22222222-2222-4222-8222-222222222222",
      scheduleId: "acq-sweep",
      workflowId: "workflow",
      workflowRunId: "33333333-3333-4333-8333-333333333333",
      scheduleRequestSha256: "a".repeat(64),
      technicalPolicyRevision: "b".repeat(64),
      accountKey: `platform:${"a".repeat(64)}:33333333-3333-4333-8333-333333333333`,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    } as const;
    await expect(port.authorize(binding, "wire")).rejects.toThrow(
      "PLATFORM_EGRESS_AUTHORIZATION_UNAVAILABLE",
    );
  });
});
