import { describe, expect, it } from "vitest";
import { validateCandidateBudgetAllocation } from "./development-candidate-budget";

const NOW = Date.parse("2026-11-15T14:00:00.000Z");
const A = "10000000-0000-4000-8000-000000000001",
  B = "10000000-0000-4000-8000-000000000002";
const context = {
  instanceId: "pump-ab",
  workspaceIds: [A, B],
  authorizationSha256: "a".repeat(64),
  validUntil: "2026-11-16T14:00:00.000Z",
};
const grant = {
  workspaceId: A,
  purpose: "icp.design",
  requestSha256: "b".repeat(64),
  tokenSha256: "c".repeat(64),
  capMicrousd: 1_000_000n,
};
const allocation = {
  id: "d".repeat(64),
  requestKey: grant.requestSha256,
  arm: "A",
  workspaceId: A,
  purpose: "icp.design",
  quoteSha256: "e".repeat(64),
  capMicrousd: 1_000_000,
  state: "BOUND",
  accountKey: "icp.design:company:request",
  grantSha256: grant.tokenSha256,
};
function snapshot() {
  return {
    schemaVersion: "development-candidate-budget-allocations/v1",
    authorizationSha256: context.authorizationSha256,
    campaignId: context.instanceId,
    expiresAt: context.validUntil,
    capMicrousd: 5_000_000,
    arms: {
      A: { workspaceId: A, capMicrousd: 2_500_000 },
      B: { workspaceId: B, capMicrousd: 2_500_000 },
    },
    allocations: [structuredClone(allocation)],
  };
}
describe("all candidate Grants must have occupied a conservative campaign slice", () => {
  it("accepts exactly the registered Grant and later account reserve, not an extra valid SaaS Grant", () => {
    expect(() =>
      validateCandidateBudgetAllocation(snapshot(), context, { grant }, NOW),
    ).not.toThrow();
    expect(() =>
      validateCandidateBudgetAllocation(
        snapshot(),
        context,
        { workspaceId: A, accountKey: allocation.accountKey },
        NOW,
      ),
    ).not.toThrow();
    for (const change of [
      { workspaceId: B },
      { purpose: "discovery.run" },
      { requestSha256: "f".repeat(64) },
      { tokenSha256: "f".repeat(64) },
      { capMicrousd: 1_000_001n },
    ]) {
      expect(() =>
        validateCandidateBudgetAllocation(
          snapshot(),
          context,
          { grant: { ...grant, ...change } },
          NOW,
        ),
      ).toThrow();
    }
    expect(() =>
      validateCandidateBudgetAllocation(
        snapshot(),
        context,
        { workspaceId: A, accountKey: "unregistered" },
        NOW,
      ),
    ).toThrow();
  });
  it("rejects wrong campaign/approval, expired caches, unbound or UNKNOWN Grants, and excessive group exposure", () => {
    for (const change of [
      (value: ReturnType<typeof snapshot>) => {
        value.authorizationSha256 = "f".repeat(64);
      },
      (value: ReturnType<typeof snapshot>) => {
        value.campaignId = "other";
      },
      (value: ReturnType<typeof snapshot>) => {
        value.expiresAt = new Date(NOW).toISOString();
      },
      (value: ReturnType<typeof snapshot>) => {
        value.allocations[0]!.state = "ISSUING";
      },
      (value: ReturnType<typeof snapshot>) => {
        value.allocations[0]!.state = "UNKNOWN";
      },
      (value: ReturnType<typeof snapshot>) => {
        value.allocations[0]!.capMicrousd = 2_500_001;
      },
      (value: ReturnType<typeof snapshot>) => {
        value.capMicrousd = 5_000_001;
      },
      (value: ReturnType<typeof snapshot>) => {
        value.allocations.push({
          ...allocation,
          id: "f".repeat(64),
          requestKey: "f".repeat(64),
          grantSha256: "f".repeat(64),
          accountKey: "other",
          capMicrousd: 1_500_001,
        });
      },
      (value: ReturnType<typeof snapshot>) => {
        value.allocations.push({ ...allocation });
      },
    ]) {
      const value = snapshot();
      change(value);
      expect(() =>
        validateCandidateBudgetAllocation(value, context, { grant }, NOW),
      ).toThrow();
    }
  });
  it("pending/unknown slices remain in total exposure even though only BOUND identities can run", () => {
    const value = snapshot();
    value.allocations.push({
      ...allocation,
      id: "f".repeat(64),
      requestKey: "f".repeat(64),
      grantSha256: "f".repeat(64),
      accountKey: "unknown",
      state: "UNKNOWN",
      capMicrousd: 1_500_000,
    });
    expect(() =>
      validateCandidateBudgetAllocation(value, context, { grant }, NOW),
    ).not.toThrow();
    value.allocations[1]!.capMicrousd += 1;
    expect(() =>
      validateCandidateBudgetAllocation(value, context, { grant }, NOW),
    ).toThrow();
  });
});
