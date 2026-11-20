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
    { manufacturerNetworkRevision: "manufacturer-network/v2" },
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
