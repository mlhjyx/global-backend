import { describe, expect, it } from "vitest";
import {
  bootstrapRatioInterval,
  buildObservation,
  buildRollupRows,
  computationHashOf,
  latestPerStratum,
  observationValue,
  stableStringify,
  stratumKeyOf,
  weekStartOf,
  wilsonInterval,
  type MetricObservationInput,
} from "./rollup";

function observation(
  overrides: Partial<MetricObservationInput> = {},
): MetricObservationInput {
  return {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    metricId: "T2-001",
    metricVersion: 1,
    stratum: { workspace_id: "11111111-1111-4111-8111-111111111111" },
    stratumKey: '{"workspace_id":"11111111-1111-4111-8111-111111111111"}',
    windowStart: new Date("2026-11-08T00:00:00.000Z"),
    windowEnd: new Date("2026-11-08T23:59:59.999Z"),
    numerator: 73,
    denominator: 403,
    value: 73 / 403,
    ciLow: 0.147,
    ciHigh: 0.222,
    sampleN: 403,
    computationHash: "a".repeat(64),
    ...overrides,
  };
}

describe("stableStringify", () => {
  it("sorts object keys recursively so stratum keys are canonical", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
    expect(stratumKeyOf({ country: "DE", workspace_id: "w" })).toBe(
      stratumKeyOf({ workspace_id: "w", country: "DE" }),
    );
  });
});

describe("computationHashOf", () => {
  it("is stable and sensitive to counts and window", () => {
    const base = {
      metricId: "T2-001",
      metricVersion: 1,
      stratumKey: "k",
      windowStart: new Date("2026-11-08T00:00:00.000Z"),
      windowEnd: new Date("2026-11-08T23:59:59.999Z"),
      numerator: 73,
      denominator: 403,
    };
    expect(computationHashOf(base)).toBe(computationHashOf({ ...base }));
    expect(computationHashOf(base)).not.toBe(
      computationHashOf({ ...base, numerator: 74 }),
    );
    expect(computationHashOf(base)).not.toBe(
      computationHashOf({ ...base, denominator: null }),
    );
    expect(computationHashOf(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("wilsonInterval", () => {
  it("matches the textbook interval", () => {
    const interval = wilsonInterval(50, 100);
    expect(interval?.low).toBeCloseTo(0.404, 2);
    expect(interval?.high).toBeCloseTo(0.596, 2);
    expect(wilsonInterval(0, 274)?.high).toBeCloseTo(0.0139, 3);
    expect(wilsonInterval(1, 0)).toBeNull();
  });
});

describe("observationValue", () => {
  it("returns null for missing or zero denominators", () => {
    expect(observationValue(1, 4)).toBe(0.25);
    expect(observationValue(1, null)).toBeNull();
    expect(observationValue(0, 0)).toBeNull();
  });
});

describe("weekStartOf", () => {
  it("returns the Monday of the ISO week in UTC", () => {
    expect(weekStartOf(new Date("2026-11-09T00:00:00Z")).toISOString()).toBe(
      "2026-11-09T00:00:00.000Z",
    );
    expect(weekStartOf(new Date("2026-11-13T23:00:00Z")).toISOString()).toBe(
      "2026-11-09T00:00:00.000Z",
    );
  });
});

describe("latestPerStratum", () => {
  it("keeps the observation with the newest windowEnd per stratum", () => {
    const older = observation({
      numerator: 1,
      windowEnd: new Date("2026-11-07T23:59:59.999Z"),
    });
    const newer = observation({ numerator: 2 });
    const other = observation({
      metricId: "T2-005",
      stratumKey: "other",
      numerator: 9,
    });
    const latest = latestPerStratum([older, newer, other]);
    expect(latest).toHaveLength(2);
    expect(latest.find((row) => row.metricId === "T2-001")?.numerator).toBe(2);
  });
});

describe("buildRollupRows", () => {
  it("buckets day and week rows from windowEnd", () => {
    const daily = buildRollupRows([observation()], "day");
    expect(daily[0]?.bucket.toISOString()).toBe("2026-11-08T00:00:00.000Z");
    const weekly = buildRollupRows([observation()], "week");
    expect(weekly[0]?.bucket.toISOString()).toBe("2026-11-02T00:00:00.000Z");
  });
});

describe("bootstrapRatioInterval", () => {
  it("is deterministic per seed and brackets the ratio-of-counts", () => {
    const first = bootstrapRatioInterval(200, 173, "T2-008:seed");
    const second = bootstrapRatioInterval(200, 173, "T2-008:seed");
    expect(first).toEqual(second);
    expect(first?.low).toBeLessThan(200 / 173);
    expect(first?.high).toBeGreaterThan(200 / 173);
    expect(bootstrapRatioInterval(1, 0, "x")).toBeNull();
  });
});

describe("buildObservation", () => {
  it("derives stratumKey, value and hash from the inputs", () => {
    const row = buildObservation({
      metricId: "T2-001",
      metricVersion: 1,
      workspaceId: null,
      stratum: { workspace_id: "ALL", country: "ALL" },
      windowStart: new Date("2026-11-08T00:00:00.000Z"),
      windowEnd: new Date("2026-11-08T23:59:59.999Z"),
      numerator: 73,
      denominator: 403,
      ci: { low: 0.147, high: 0.222 },
    });
    expect(row.stratumKey).toBe('{"country":"ALL","workspace_id":"ALL"}');
    expect(row.value).toBeCloseTo(73 / 403, 10);
    expect(row.sampleN).toBe(403);
    expect(row.computationHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
