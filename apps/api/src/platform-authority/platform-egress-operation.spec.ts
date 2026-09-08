import { describe, expect, it } from "vitest";
import { assertPlatformEgressPaidContext, createPlatformEgressOperation, snapshotPlatformEgressOperation } from "./platform-egress-operation";

const reservation = { workspaceId: "platform", accountKey: "account", operationId: "11111111-1111-4111-8111-111111111111",
  estimatedMicrousd: 0n, replay: false };
const input = { operationKey: "wire", budgetOperationKey: "a".repeat(64), reservation,
  workspaceId: "platform", accountKey: "account",
  execution: { kind: "tool" as const, toolId: "test.tool", toolVersion: "1.0.0" } };

describe("Platform egress existing-budget operation binding", () => {
  it("preserves a real zero-priced reservation and freezes its selected identity", () => {
    const operation = createPlatformEgressOperation(input);
    expect(operation).toEqual({ operationKey: "wire", budgetOperationKey: "a".repeat(64),
      budgetOperationId: reservation.operationId, reservedMicrousd: 0n, execution: input.execution });
    expect(Object.isFrozen(operation)).toBe(true);
    expect(Object.isFrozen(operation.execution)).toBe(true);
    expect(operation.execution).not.toBe(input.execution);
  });
  it.each([undefined, null, { ...reservation, operationId: undefined }, { ...reservation, operationId: "fake" },
    { ...reservation, workspaceId: "other" }, { ...reservation, accountKey: "other" },
    { ...reservation, estimatedMicrousd: 0 }, { ...reservation, estimatedMicrousd: -1n },
    { ...reservation, estimatedMicrousd: 9223372036854775808n }, { ...reservation, replay: undefined },
    { ...reservation, replay: true },
  ])("rejects missing, mismatched, replayed or invalid reservation facts %#", bad => {
    expect(() => createPlatformEgressOperation({ ...input, reservation: bad as never }))
      .toThrow("PLATFORM_EGRESS_RESERVATION_INVALID");
  });
  it.each([null, { operationKey: "" }, { operationKey: 1 }, { operationKey: "bad\nkey" },
    { budgetOperationId: undefined }, { budgetOperationId: "not-a-uuid" },
    { budgetOperationKey: undefined }, { budgetOperationKey: "short" }, { reservedMicrousd: -1n },
    { execution: null }, { execution: { kind: "unknown" } },
    { execution: { kind: "tool", toolId: "", toolVersion: "1" } },
    { execution: { kind: "tool", toolId: "tool", toolVersion: "bad\nversion" } },
    { execution: { kind: "tool", toolId: "a".repeat(201), toolVersion: "1" } },
    { execution: { kind: "tool", toolId: " tool", toolVersion: "1" } },
    { execution: { kind: "model", modelOp: "unknown", taskId: "task", providerId: "provider" } },
    { execution: { kind: "model", modelOp: "embed", taskId: "", providerId: "provider" } },
    { execution: { kind: "model", modelOp: "embed", taskId: "task", providerId: "" } },
    { execution: { kind: "model", modelOp: "embed", taskId: "task", providerId: "provider", requestedModel: "" } },
  ])("rejects incomplete or malformed consumer-side identity %#", mutation => {
    const valid = createPlatformEgressOperation(input);
    expect(() => snapshotPlatformEgressOperation(mutation === null ? null as never : { ...valid, ...mutation } as never))
      .toThrow("PLATFORM_EGRESS_RESERVATION_INVALID");
  });
  it.each(["generateText", "generateStructured", "reviewVision", "embed"] as const)("carries actual %s model identity without inventing provider version", modelOp => {
    const operation = createPlatformEgressOperation({ ...input, execution: { kind: "model", modelOp,
      taskId: "task", providerId: "provider", requestedModel: "explicit-alias" } });
    expect(operation.execution).toEqual({ kind: "model", modelOp, taskId: "task", providerId: "provider", requestedModel: "explicit-alias" });
  });
  it("permits ordinary workspace paid contexts, but never mixes paidCost with Platform", () => {
    expect(() => assertPlatformEgressPaidContext({ workspaceId: "workspace", paidCost: {} })).not.toThrow();
    expect(() => assertPlatformEgressPaidContext({ workspaceId: "platform" })).not.toThrow();
    for (const context of [{ workspaceId: "platform", paidCost: {} }, { workspaceId: "workspace", platformEgress: {}, paidCost: {} }]) {
      expect(() => assertPlatformEgressPaidContext(context)).toThrow("PLATFORM_EGRESS_PAID_CONTEXT_INVALID");
    }
  });
});
