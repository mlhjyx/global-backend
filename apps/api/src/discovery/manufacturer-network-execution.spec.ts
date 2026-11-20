import { describe, expect, it } from "vitest";
import { workspaceExecutionBudgetRequestScope } from "../execution-budget/execution-budget-request-scope";
import {
  MANUFACTURER_NETWORK_REVISION,
  manufacturerNetworkExecutionSnapshot,
  readManufacturerNetworkExecutionBody,
  readManufacturerNetworkExecutionSnapshot,
} from "./manufacturer-network-execution";

const planId = "33333333-3333-4333-8333-333333333333";
const attemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("explicit manufacturer network execution contract", () => {
  it("does not add a feature or snapshot to legacy requests", () => {
    expect(readManufacturerNetworkExecutionBody(undefined)).toBeUndefined();
    expect(readManufacturerNetworkExecutionBody({ attemptId })).toEqual({
      attemptId,
    });
    expect(
      manufacturerNetworkExecutionSnapshot(planId, undefined),
    ).toBeUndefined();
    expect(
      manufacturerNetworkExecutionSnapshot(planId, { attemptId }),
    ).toBeUndefined();
    expect(readManufacturerNetworkExecutionSnapshot(undefined)).toBeUndefined();
  });

  it("supports a first execution with the known feature revision and no attempt", () => {
    const body = readManufacturerNetworkExecutionBody({
      manufacturerNetworkRevision: MANUFACTURER_NETWORK_REVISION,
    });
    expect(body).toEqual({
      manufacturerNetworkRevision: "manufacturer-network/v1",
    });
    expect(Object.isFrozen(body)).toBe(true);
    const snapshot = manufacturerNetworkExecutionSnapshot(planId, body);
    expect(snapshot).toEqual({
      schemaVersion: "manufacturer-network-execution/v1",
      planId,
      body,
    });
    expect(
      readManufacturerNetworkExecutionSnapshot(
        JSON.parse(JSON.stringify(snapshot)),
      ),
    ).toEqual(snapshot);
  });

  it("freezes the same attempt and feature material that enters the grant request hash", () => {
    const body = readManufacturerNetworkExecutionBody({
      attemptId,
      manufacturerNetworkRevision: MANUFACTURER_NETWORK_REVISION,
    });
    const legacy = workspaceExecutionBudgetRequestScope({
      operation: "POST /query-plans/:planId/execute",
      planId,
      body: { attemptId },
    });
    const enabled = workspaceExecutionBudgetRequestScope({
      operation: "POST /query-plans/:planId/execute",
      planId,
      body: body as never,
    });
    expect(enabled.requestSha256).not.toBe(legacy.requestSha256);
    const snapshot = readManufacturerNetworkExecutionSnapshot(
      manufacturerNetworkExecutionSnapshot(planId, body),
    )!;
    expect(
      workspaceExecutionBudgetRequestScope({
        operation: "POST /query-plans/:planId/execute",
        planId: snapshot.planId,
        body: snapshot.body as never,
      }).requestSha256,
    ).toBe(enabled.requestSha256);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.body)).toBe(true);
  });

  it.each([
    null,
    [],
    {},
    { attemptId: "not-a-uuid" },
    { manufacturerNetworkRevision: "manufacturer-network/v3" },
    { manufacturerNetworkRevision: true },
    { manufacturerNetworkRevision: "" },
    {
      manufacturerNetworkRevision: MANUFACTURER_NETWORK_REVISION,
      sourceUrl: "https://unapproved.example/dealer",
    },
  ])("rejects malformed or overbroad execution options: %j", (value) => {
    expect(() => readManufacturerNetworkExecutionBody(value)).toThrow(
      "MANUFACTURER_NETWORK_EXECUTION_INVALID",
    );
  });

  it.each([
    {
      schemaVersion: "manufacturer-network-execution/v2",
      planId,
      body: { manufacturerNetworkRevision: MANUFACTURER_NETWORK_REVISION },
    },
    {
      schemaVersion: "manufacturer-network-execution/v1",
      planId: "unknown",
      body: { manufacturerNetworkRevision: MANUFACTURER_NETWORK_REVISION },
    },
    {
      schemaVersion: "manufacturer-network-execution/v1",
      planId,
      body: { attemptId },
    },
    {
      schemaVersion: "manufacturer-network-execution/v1",
      planId,
      body: { manufacturerNetworkRevision: MANUFACTURER_NETWORK_REVISION },
      trusted: true,
    },
  ])(
    "does not turn an unverified history marker into feature authorization: %j",
    (value) => {
      expect(() => readManufacturerNetworkExecutionSnapshot(value)).toThrow(
        "MANUFACTURER_NETWORK_EXECUTION_INVALID",
      );
    },
  );
});

it("freezes v2 as a distinct signed request without altering v1 or absent-marker hashes", () => {
  const scope = (revision?: string) =>
    workspaceExecutionBudgetRequestScope({
      operation: "POST /query-plans/:planId/execute",
      planId,
      body: revision
        ? ({ attemptId, manufacturerNetworkRevision: revision } as never)
        : { attemptId },
    });
  const body = {
    attemptId,
    manufacturerNetworkRevision: "manufacturer-network/v2",
  };
  expect(manufacturerNetworkExecutionSnapshot(planId, body)?.body).toEqual(
    body,
  );
  expect(scope("manufacturer-network/v2").requestSha256).not.toBe(
    scope("manufacturer-network/v1").requestSha256,
  );
  expect(scope("manufacturer-network/v1").requestSha256).not.toBe(
    scope().requestSha256,
  );
  expect(scope().requestSha256).toBe(
    "006dcbb2b7fc9eb615f2f1ed09277d39e3cea87b7966fed3e93246dbadfc4336",
  );
  expect(scope("manufacturer-network/v1").requestSha256).toBe(
    "bd1ede342860a1ea3f90772674fc2553e18ff18fce9d13986ff14c0466bce9d7",
  );
  expect(
    workspaceExecutionBudgetRequestScope({
      operation: "POST /query-plans/:planId/execute",
      planId,
    }).requestSha256,
  ).toBe("3358f06f16eb5fc6a1afe5aa048fe3fba46aaef9f06b04c5d943abde8574754b");
});
