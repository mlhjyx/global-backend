import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { PrismaPlatformEgressFencePort } from "./platform-egress-fence.prisma";
import { PlatformEgressFence } from "./platform-egress-fence.v1";

const operation = (operationKey: string) => ({ operationKey,
  budgetOperationId: "44444444-4444-4444-8444-444444444444",
  budgetOperationKey: "c".repeat(64), reservedMicrousd: 0n,
  execution: { kind: "tool" as const, toolId: "tradefair.algolia", toolVersion: "1.0.0" },
});
const vector = JSON.parse(readFileSync(new URL("../../../../packages/contracts/fixtures/platform-authority/platform-execution-technical-quote-v1.json", import.meta.url), "utf8")).vectors[0];
const validBinding = { authorityId: "22222222-2222-4222-8222-222222222222", scheduleId: vector.input.schedule_id,
  workflowId: vector.input.workflow_id, workflowRunId: vector.input.workflow_run_id,
  scheduleRequestSha256: vector.input.schedule_request_sha256, technicalPolicyRevision: vector.expected_quote.policy_revision,
  accountKey: `platform:${vector.input.schedule_request_sha256}:${vector.input.workflow_run_id}` };
const authority = { purpose: vector.input.purpose, schedule_id: validBinding.scheduleId, workflow_id: validBinding.workflowId,
  workflow_run_id: validBinding.workflowRunId, schedule_request_sha256: validBinding.scheduleRequestSha256,
  technical_policy_revision: validBinding.technicalPolicyRevision, cap_per_run_microusd: 1n };

describe("Prisma platform egress fence port", () => {
  it.each([
    { row: undefined },
    { row: { ...authority, workflow_id: "different" } },
    { row: { ...authority, technical_policy_revision: null } },
  ])("rejects an unresolved or mismatched immutable authority revision", async ({ row }) => {
    const queryRaw = vi.fn().mockResolvedValue(row ? [row] : []);
    const port = new PrismaPlatformEgressFencePort({ $queryRaw: queryRaw } as never);
    await expect(port.authorize(validBinding, operation("wire")))
      .rejects.toThrow("PLATFORM_EGRESS_BINDING_INVALID");
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("resolves the admitted revision before requesting authorization", async () => {
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([authority])
      .mockResolvedValueOnce([{ attempt_id: "11111111-1111-4111-8111-111111111111", generation: 0n, replay: false }]);
    const port = new PrismaPlatformEgressFencePort({ $queryRaw: queryRaw } as never);
    await expect(port.authorize({ ...validBinding, technicalPolicyRevision: undefined }, operation("wire")))
      .resolves.toEqual({ attemptId: "11111111-1111-4111-8111-111111111111" });
    expect(queryRaw.mock.calls[1]).toContain(authority.technical_policy_revision);
  });

  it("does not expose successful output when the durable ACK transition was refused", async () => {
    const attemptId = "11111111-1111-4111-8111-111111111111";
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([authority])
      .mockResolvedValueOnce([{ attempt_id: attemptId, generation: 0n, replay: false }])
      .mockResolvedValueOnce([authority])
      .mockResolvedValueOnce([{ attempt_id: attemptId, generation: 0n }])
      .mockResolvedValueOnce([{ acknowledge_platform_egress_v1: false }])
      .mockResolvedValueOnce([{ mark_unknown_platform_egress_v1: true }]);
    const fence = new PlatformEgressFence(new PrismaPlatformEgressFencePort({ $queryRaw: queryRaw } as never));
    const execute = vi.fn(async () => ({ output: "valid-output" }));
    await expect(fence.authorizeAndDispatchPlatformEgress(validBinding, operation("wire"), execute)).rejects.toThrow("PLATFORM_EGRESS_ACK_NOT_CONFIRMED");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(6);
    expect(String(queryRaw.mock.calls[5][0])).toContain("mark_unknown_platform_egress_v1");
  });

  it.each([false, null, "true", 1, undefined])(
    "rejects a non-successful durable outcome transition (%s)",
    async (result) => {
      const port = new PrismaPlatformEgressFencePort({
        $queryRaw: vi.fn().mockResolvedValue([
          { acknowledge_platform_egress_v1: result, mark_unknown_platform_egress_v1: result },
        ]),
      } as never);
      await expect(port.acknowledged("11111111-1111-4111-8111-111111111111", {}))
        .rejects.toThrow("PLATFORM_EGRESS_ACK_NOT_CONFIRMED");
      await expect(port.unknown("11111111-1111-4111-8111-111111111111", {}))
        .rejects.toThrow("PLATFORM_EGRESS_UNKNOWN_NOT_CONFIRMED");
    },
  );

  it.each([{ rows: [] }, { rows: [{ acknowledge_platform_egress_v1: true }, { acknowledge_platform_egress_v1: true }] }])(
    "rejects missing or ambiguous outcome receipts",
    async ({ rows }) => {
      const port = new PrismaPlatformEgressFencePort({ $queryRaw: vi.fn().mockResolvedValue(rows) } as never);
      await expect(port.acknowledged("11111111-1111-4111-8111-111111111111", {}))
        .rejects.toThrow("PLATFORM_EGRESS_ACK_NOT_CONFIRMED");
    },
  );

  it("uses migration-owned function calls instead of direct table writes", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([authority])
      .mockResolvedValueOnce([
        {
          attempt_id: "11111111-1111-4111-8111-111111111111",
          generation: 0n,
          replay: false,
        },
      ])
      .mockResolvedValueOnce([authority])
      .mockResolvedValueOnce([
        {
          attempt_id: "11111111-1111-4111-8111-111111111111",
          generation: 0n,
        },
      ])
      .mockResolvedValueOnce([{ acknowledge_platform_egress_v1: true }])
      .mockResolvedValueOnce([{ mark_unknown_platform_egress_v1: true }]);
    const port = new PrismaPlatformEgressFencePort({ $queryRaw: queryRaw } as never);
    const binding = validBinding;

    const authorization = await port.authorize(binding, operation("wire"));
    const capability = await port.claimSend(binding, authorization, operation("wire"));
    const execute = vi.fn(async () => "ok");
    await expect(capability.dispatch(execute)).resolves.toBe("ok");
    await expect(capability.dispatch(execute)).rejects.toThrow("PLATFORM_EGRESS_CAPABILITY_REUSED");
    await port.acknowledged(capability.attemptId, { state: "ACKNOWLEDGED" });
    await port.unknown(capability.attemptId, { reason: "PHYSICAL_CALL_OR_ACK_UNKNOWN" });

    expect(queryRaw).toHaveBeenCalledTimes(6);
    const sql = queryRaw.mock.calls.map(([query]) => String(query.text ?? query)).join(" ");
    expect(sql).toContain("authorize_platform_egress_v2");
    expect(sql).toContain("claim_platform_egress_send_v2");
    expect(sql).toContain("acknowledge_platform_egress_v1");
    expect(sql).toContain("mark_unknown_platform_egress_v1");
    expect(sql).not.toMatch(/INSERT\s+INTO\s+platform_egress_attempt/i);
  });

  it("fails closed when a durable transition returns no row", async () => {
    const port = new PrismaPlatformEgressFencePort({
      $queryRaw: vi.fn().mockResolvedValueOnce([authority]).mockResolvedValueOnce([]),
    } as never);
    const binding = validBinding;
    await expect(port.authorize(binding, operation("wire"))).rejects.toThrow(
      "PLATFORM_EGRESS_AUTHORIZATION_UNAVAILABLE",
    );
  });
});
