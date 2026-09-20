import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PrismaPlatformEgressFencePort } from "./platform-egress-fence.prisma";
import { CurrentPlatformExecutionPolicy } from "./platform-current-policy";

const vector = JSON.parse(readFileSync(new URL("../../../../packages/contracts/fixtures/platform-authority/platform-execution-technical-quote-v1.json", import.meta.url), "utf8")).vectors[0];
const binding = { authorityId: "11111111-1111-4111-8111-111111111111", scheduleId: vector.input.schedule_id,
  workflowId: vector.input.workflow_id, workflowRunId: vector.input.workflow_run_id,
  scheduleRequestSha256: vector.input.schedule_request_sha256, technicalPolicyRevision: vector.expected_quote.policy_revision,
  accountKey: `platform:${vector.input.schedule_request_sha256}:${vector.input.workflow_run_id}` };
const authority = { purpose: vector.input.purpose, schedule_id: binding.scheduleId, workflow_id: binding.workflowId,
  workflow_run_id: binding.workflowRunId, schedule_request_sha256: binding.scheduleRequestSha256,
  technical_policy_revision: binding.technicalPolicyRevision, cap_per_run_microusd: 1n };
const operation = { operationKey: "wire-key", budgetOperationId: "22222222-2222-4222-8222-222222222222",
  budgetOperationKey: "original-reserve-key", reservedMicrousd: 0n,
  execution: { kind: "tool" as const, toolId: "tradefair.algolia", toolVersion: "1.0.0" } };
describe("two-stage current policy and persisted budget SQL binding", () => {
  it("reloads authority and recomputes real policy at both v2 transitions", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const query = vi.fn().mockResolvedValueOnce([authority]).mockResolvedValueOnce([{ attempt_id: id, generation: 1n, replay: false }])
      .mockResolvedValueOnce([authority]).mockResolvedValueOnce([{ attempt_id: id, generation: 1n }]);
    const policy = new CurrentPlatformExecutionPolicy(); const attest = vi.spyOn(policy, "attest");
    const port = new PrismaPlatformEgressFencePort({ $queryRaw: query } as never, policy);
    const authorized = await port.authorize(binding, operation);
    const capability = await port.claimSend(binding, authorized, operation);
    expect(capability.attemptId).toBe(id);
    expect(attest).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[1][0])).toContain("authorize_platform_egress_v2");
    expect(String(query.mock.calls[3][0])).toContain("claim_platform_egress_send_v2");
    for (const call of [query.mock.calls[1], query.mock.calls[3]]) {
      expect(call).toContain(operation.budgetOperationId);
      expect(call).toContain(operation.budgetOperationKey);
      expect(call).toContain(binding.accountKey);
      expect(call).toContain(0n);
      expect(call).toContain(1n);
    }
  });
  it("does not use a caller-supplied revision to skip durable authority or quote checks", async () => {
    const query = vi.fn().mockResolvedValue([{ ...authority, technical_policy_revision: "f".repeat(64) }]);
    const port = new PrismaPlatformEgressFencePort({ $queryRaw: query } as never);
    await expect(port.authorize(binding, operation)).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("refuses the send cut when the second persisted policy projection no longer matches", async () => {
    const query = vi.fn().mockResolvedValueOnce([authority]).mockResolvedValueOnce([{ attempt_id: "33333333-3333-4333-8333-333333333333", generation: 1n, replay: false }])
      .mockResolvedValueOnce([{ ...authority, cap_per_run_microusd: 2n }]);
    const port = new PrismaPlatformEgressFencePort({ $queryRaw: query } as never);
    const authorized = await port.authorize(binding, operation);
    await expect(port.claimSend(binding, authorized, operation)).rejects.toThrow("PLATFORM_EGRESS_CURRENT_POLICY_UNAVAILABLE");
    expect(query).toHaveBeenCalledTimes(3);
  });
});
