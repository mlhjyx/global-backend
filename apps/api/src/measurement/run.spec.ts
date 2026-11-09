import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { MetricQueryRow } from "./metric-queries";
import {
  buildMetricObservations,
  parseMeasurementDay,
  runMeasurementRollup,
} from "./run";

const WS = "11111111-1111-4111-8111-111111111111";

/** Prisma passes either a Sql object ($queryRaw(sql)) or a tagged template (strings + values). */
function sqlText(query: unknown): string {
  if (typeof query === "string") return query;
  if (Array.isArray(query)) return (query as string[]).join("?");
  const sql = (query as { sql?: unknown }).sql;
  if (typeof sql === "string") return sql;
  if (Array.isArray(sql)) return (sql as string[]).join("?");
  return "";
}

function fakeDb(rowsByMarker: Record<string, MetricQueryRow[]>) {
  const queriedMarkers: string[] = [];
  const executedSql: string[] = [];
  const db = {
    $queryRaw: vi.fn(async (query: unknown) => {
      const text = sqlText(query);
      const marker = /metric:(T\d-\d{3})/.exec(text)?.[1];
      if (marker) queriedMarkers.push(marker);
      return marker ? (rowsByMarker[marker] ?? []) : [];
    }),
    $executeRaw: vi.fn(async (query: unknown) => {
      executedSql.push(sqlText(query));
      return 1;
    }),
  };
  return { db: db as unknown as PrismaClient, queriedMarkers, executedSql };
}

describe("parseMeasurementDay", () => {
  it("builds the UTC day window and rejects invalid days", () => {
    const { dayStart, dayEnd } = parseMeasurementDay("2026-11-08");
    expect(dayStart.toISOString()).toBe("2026-11-08T00:00:00.000Z");
    expect(dayEnd.toISOString()).toBe("2026-11-08T23:59:59.999Z");
    expect(() => parseMeasurementDay("2026-13-01")).toThrow(
      /MEASUREMENT_DAY_INVALID/,
    );
    expect(() => parseMeasurementDay("08.11.2026")).toThrow(
      /MEASUREMENT_DAY_INVALID/,
    );
  });
});

describe("buildMetricObservations", () => {
  const window = {
    start: new Date("2026-11-08T00:00:00.000Z"),
    end: new Date("2026-11-08T23:59:59.999Z"),
  };

  it("maps workspace rows and computes Wilson intervals", () => {
    const rows: MetricQueryRow[] = [
      { stratum: { workspace_id: WS, country: "DE" }, numerator: 43, denominator: 173 },
      { stratum: { workspace_id: "ALL", country: "ALL" }, numerator: 73, denominator: 403 },
    ];
    const observations = buildMetricObservations(
      { metricId: "T2-001", metricVersion: 1, ciMethod: "wilson" },
      rows,
      window,
      "seed",
    );
    expect(observations).toHaveLength(2);
    expect(observations[0]?.workspaceId).toBe(WS);
    expect(observations[1]?.workspaceId).toBeNull();
    expect(observations[0]?.ciLow).toBeGreaterThan(0);
    expect(observations[0]?.ciHigh).toBeLessThan(1);
    expect(observations[0]?.stratumKey).toBe(
      `{"country":"DE","workspace_id":"${WS}"}`,
    );
  });

  it("keeps T0-002 channel strata as distinct observation rows", () => {
    const rows: MetricQueryRow[] = [
      { stratum: { workspace_id: "ALL" }, numerator: 9, denominator: 300 },
      { stratum: { workspace_id: "ALL", channel: "email_only" }, numerator: 4, denominator: 300 },
      { stratum: { workspace_id: "ALL", channel: "phone_only" }, numerator: 3, denominator: 300 },
      { stratum: { workspace_id: "ALL", channel: "both" }, numerator: 2, denominator: 300 },
    ];
    const observations = buildMetricObservations(
      { metricId: "T0-002", metricVersion: 1, ciMethod: "wilson" },
      rows,
      window,
      "seed",
    );
    expect(observations).toHaveLength(4);
    expect(observations.map((observation) => observation.stratumKey)).toEqual(
      expect.arrayContaining([
        '{"channel":"both","workspace_id":"ALL"}',
        '{"channel":"email_only","workspace_id":"ALL"}',
        '{"channel":"phone_only","workspace_id":"ALL"}',
      ]),
    );
    const emailOnly = observations.find((observation) =>
      observation.stratumKey.includes("email_only"),
    );
    expect(emailOnly?.numerator).toBe(4);
    expect(emailOnly?.workspaceId).toBeNull();
  });

  it("uses the bootstrap interval for ratio-of-counts metrics", () => {
    const rows: MetricQueryRow[] = [
      { stratum: { workspace_id: WS, country: "DE" }, numerator: 200, denominator: 173 },
    ];
    const [observation] = buildMetricObservations(
      { metricId: "T2-008", metricVersion: 1, ciMethod: "bootstrap" },
      rows,
      window,
      "2026-11-08:T2-008",
    );
    expect(observation?.ciHigh).toBeGreaterThan(200 / 173);
  });
});

describe("runMeasurementRollup", () => {
  it("collects metrics, skips uncomputable ones, and refreshes both rollups", async () => {
    const { db, queriedMarkers, executedSql } = fakeDb({
      "T0-001": [
        { stratum: { workspace_id: WS }, numerator: 0, denominator: 128 },
        { stratum: { workspace_id: "ALL" }, numerator: 0, denominator: 403 },
      ],
      "T1-008": [
        { stratum: { provider_key: "public_web" }, numerator: 3015, denominator: 3306 },
      ],
    });
    const result = await runMeasurementRollup(db, { day: "2026-11-08" });
    expect(result.observationsBuilt).toBe(3);
    expect(result.observationsInserted).toBe(3);
    expect(result.rollupDailyRows).toBe(1);
    expect(result.rollupWeeklyRows).toBe(1);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { metricId: "T2-002", reason: "NO_ADJUDICATED_VERDICTS" },
        { metricId: "T2-009", reason: "EMPTY_VALID_DENOMINATOR" },
      ]),
    );
    expect(queriedMarkers).not.toContain("T2-002");
    expect(queriedMarkers).not.toContain("T2-009");
    expect(queriedMarkers).toHaveLength(8);
    // 3 observation inserts + 2 rollup refreshes.
    expect(executedSql).toHaveLength(5);
    expect(executedSql.filter((sql) => sql.includes("rollup:daily"))).toHaveLength(1);
    expect(executedSql.filter((sql) => sql.includes("rollup:weekly"))).toHaveLength(1);
    expect(result.day).toBe("2026-11-08");
  });

  it("rejects an invalid day before touching the database", async () => {
    const { db, queriedMarkers } = fakeDb({});
    await expect(runMeasurementRollup(db, { day: "not-a-day" })).rejects.toThrow(
      /MEASUREMENT_DAY_INVALID/,
    );
    expect(queriedMarkers).toHaveLength(0);
  });
});
