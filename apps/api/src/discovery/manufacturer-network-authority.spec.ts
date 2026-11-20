import { describe, expect, it } from "vitest";
import { assertManufacturerNetworkAuthority } from "./manufacturer-network-authority";
import {
  manufacturerNetworkExecutionSnapshot,
  MANUFACTURER_NETWORK_REVISION,
} from "./manufacturer-network-execution";
import { workspaceExecutionBudgetRequestScope } from "../execution-budget/execution-budget-request-scope";
import type { ExecutionBudgetBinding } from "../execution-budget/execution-budget-binding";
import { resolveWorkspaceTechnicalBudgetEnvelope } from "../execution-budget/workspace-technical-budget-envelope";
const planId = "33333333-3333-4333-8333-333333333333";
const attemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const request = {
  operation: "POST /query-plans/:planId/execute" as const,
  planId,
  body: {
    attemptId,
    manufacturerNetworkRevision: MANUFACTURER_NETWORK_REVISION,
  },
};
const snapshot = manufacturerNetworkExecutionSnapshot(planId, request.body)!;
const scope = workspaceExecutionBudgetRequestScope(request);
const binding = {
  ...scope,
  authorityId: "11111111-1111-4111-8111-111111111111",
  scopeKey: "22222222-2222-4222-8222-222222222222",
  accountKey: `discovery.run:discovery_run:${scope.subjectId}:${scope.requestSha256}`,
  replay: false,
} as ExecutionBudgetBinding;
describe("manufacturer execution signed authority", () => {
  it("preserves absent legacy history", () =>
    expect(
      assertManufacturerNetworkAuthority(undefined, binding),
    ).toBeUndefined());
  it("accepts the exact frozen signed material", () =>
    expect(
      assertManufacturerNetworkAuthority(snapshot, binding, planId),
    ).toEqual(snapshot));
  it.each([
    { ...snapshot, planId: attemptId },
    { ...snapshot, body: { ...snapshot.body, attemptId: planId } },
    {
      ...snapshot,
      body: {
        ...snapshot.body,
        manufacturerNetworkRevision: "manufacturer-network/v2",
      },
    },
  ])("rejects changed snapshot", (value) =>
    expect(() => assertManufacturerNetworkAuthority(value, binding)).toThrow(
      "EXECUTION_BUDGET_REQUEST_INVALID",
    ),
  );
  it("rejects an old Grant", () => {
    const old = workspaceExecutionBudgetRequestScope({
      operation: request.operation,
      planId,
      body: { attemptId },
    });
    expect(() =>
      assertManufacturerNetworkAuthority(snapshot, { ...binding, ...old }),
    ).toThrow("EXECUTION_BUDGET_REQUEST_INVALID");
  });
  it("adds exactly 50 directed searches and 50 fetches only to the new quote", () => {
    const old = resolveWorkspaceTechnicalBudgetEnvelope({
      operation: request.operation,
      planId,
    });
    const next = resolveWorkspaceTechnicalBudgetEnvelope(request);
    for (const id of ["searxng.search", "crawl4ai.fetch"]) {
      expect(
        next.policy.tools.find((t) => t.toolId === id)!.maxPhysicalInvocations -
          old.policy.tools.find((t) => t.toolId === id)!.maxPhysicalInvocations,
      ).toBe(50);
    }
    expect(next.requiredCapMicrousd - old.requiredCapMicrousd).toBe(500000n);
    expect(next.policy.executionLimits.manufacturerNetworkCompanies).toBe(50);
    expect(old.policy.executionLimits).not.toHaveProperty(
      "manufacturerNetworkCompanies",
    );
  });
});
