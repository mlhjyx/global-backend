import { describe, expect, it } from "vitest";
import { validateCapabilityRows } from "./platform-capability-rows";
const NOW = 1_800_000_000_000;
const expected = [
  {
    scheduleId: "acq-sweep",
    workflowType: "acquisitionSweepWorkflow",
    taskQueue: "understanding",
    mode: "ENABLED",
  },
  {
    scheduleId: "patents-cache-refresh",
    workflowType: "patentsCacheRefreshWorkflow",
    taskQueue: "understanding",
    mode: "INTENTIONALLY_DISABLED_NO_EGRESS",
  },
] as const;
const fact = () => ({
  status: "ok",
  observedAt: NOW,
  validUntil: NOW + 30_000,
});
const rows = () =>
  expected.map((row) => ({
    ...row,
    temporalPermission: fact(),
    issuer: fact(),
    revocationConsumer: fact(),
    undeliveredCount: 0,
    oldestUndeliveredCreatedAt: null,
  }));
describe("schedule capability row binding", () => {
  it("binds exact identities and returns primitive deadlines only", () => {
    const result = validateCapabilityRows(
      rows(),
      expected,
      NOW,
      NOW + 30_000,
      NOW,
    );
    expect(result).toEqual([
      { scheduleId: "acq-sweep", mode: "ENABLED", validUntil: NOW + 30_000 },
      {
        scheduleId: "patents-cache-refresh",
        mode: "INTENTIONALLY_DISABLED_NO_EGRESS",
        validUntil: NOW + 30_000,
      },
    ]);
  });
  it.each(["scheduleId", "workflowType", "taskQueue", "mode"])(
    "rejects altered %s",
    (field) => {
      const value = rows();
      Object.assign(value[0], { [field]: "wrong" });
      expect(() =>
        validateCapabilityRows(value, expected, NOW, NOW + 30_000, NOW),
      ).toThrow("PLATFORM_CAPABILITY_INVALID");
    },
  );
  it.each(["temporalPermission", "issuer", "revocationConsumer"])(
    "rejects failed %s",
    (field) => {
      const value = rows();
      Object.assign(value[0], { [field]: { ...fact(), status: "failed" } });
      expect(() =>
        validateCapabilityRows(value, expected, NOW, NOW + 30_000, NOW),
      ).toThrow("PLATFORM_CAPABILITY_INVALID");
    },
  );
  it("rejects missing and repeated rows", () => {
    for (const value of [rows().slice(0, 1), [rows()[0], rows()[0]]])
      expect(() =>
        validateCapabilityRows(value, expected, NOW, NOW + 30_000, NOW),
      ).toThrow("PLATFORM_CAPABILITY_INVALID");
  });
  it("rejects observations after the envelope issuance and at expiry", () => {
    const value = rows();
    value[0].issuer.observedAt = NOW + 1000;
    expect(() =>
      validateCapabilityRows(value, expected, NOW, NOW + 30_000, NOW + 1001),
    ).toThrow("PLATFORM_CAPABILITY_INVALID");
    expect(() =>
      validateCapabilityRows(rows(), expected, NOW, NOW + 30_000, NOW + 30_000),
    ).toThrow("PLATFORM_CAPABILITY_INVALID");
  });
});

it("accepts millisecond observations inside the signed iat second without accepting future observations", () => {
  const value = rows();
  for (const field of [
    "temporalPermission",
    "issuer",
    "revocationConsumer",
  ] as const) {
    value[0][field].observedAt = NOW + 500;
    value[0][field].validUntil = NOW + 20_000;
  }
  expect(
    validateCapabilityRows(value, expected, NOW, NOW + 30_000, NOW + 500)[0]
      .validUntil,
  ).toBe(NOW + 20_000);
  expect(() =>
    validateCapabilityRows(value, expected, NOW, NOW + 30_000, NOW + 499),
  ).toThrow("PLATFORM_CAPABILITY_INVALID");
});
