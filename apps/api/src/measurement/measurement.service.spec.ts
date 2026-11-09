import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../auth/request-context";
import { PrismaService } from "../prisma/prisma.service";
import {
  MeasurementService,
  decodeCursor,
  encodeCursor,
} from "./measurement.service";

const ctx: RequestContext = {
  userId: "u-1",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  roles: ["owner"],
  scopes: ["acquisition:read"],
};

function sqlText(query: unknown): string {
  if (typeof query === "string") return query;
  if (Array.isArray(query)) return (query as string[]).join("?");
  const sql = (query as { sql?: unknown }).sql;
  if (typeof sql === "string") return sql;
  if (Array.isArray(sql)) return (sql as string[]).join("?");
  return "";
}

function serviceWith(rows: unknown[]) {
  const captured: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      captured.push(sqlText(query));
      return rows;
    }),
  };
  const prisma = {
    $queryRaw: vi.fn(async (query: unknown) => {
      captured.push(sqlText(query));
      return rows;
    }),
    withWorkspace: vi.fn(
      async (_workspaceId: string, fn: (client: unknown) => Promise<unknown>) =>
        fn(tx),
    ),
  };
  return {
    service: new MeasurementService(prisma as unknown as PrismaService),
    captured,
  };
}

const OBSERVATION_ROW = {
  id: "22222222-2222-4222-8222-222222222222",
  metric_id: "T2-001",
  metric_version: 1,
  stratum: { workspace_id: ctx.workspaceId, country: "DE" },
  window_start: new Date("2026-11-08T00:00:00.000Z"),
  window_end: new Date("2026-11-08T23:59:59.999Z"),
  numerator: 43,
  denominator: 173,
  value: 0.2485,
  ci_low: 0.19,
  ci_high: 0.318,
  sample_n: 173,
  computed_at: new Date("2026-11-09T01:00:00.000Z"),
};

const ROLLUP_ROW = {
  bucket: new Date("2026-11-08T00:00:00.000Z"),
  metric_id: "T2-001",
  metric_version: 1,
  stratum: { workspace_id: ctx.workspaceId, country: "DE" },
  stratum_key: '{"country":"DE","workspace_id":"w"}',
  numerator: 43,
  denominator: 173,
  value: 0.2485,
  ci_low: 0.19,
  ci_high: 0.318,
  sample_n: 173,
  refreshed_at: new Date("2026-11-09T01:00:00.000Z"),
};

describe("cursor helpers", () => {
  it("round-trips keyset cursors and rejects garbage", () => {
    const cursor = { w: "2026-11-08T23:59:59.999Z", id: "abc" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(decodeCursor(undefined)).toBeNull();
    expect(() => decodeCursor("not-a-cursor")).toThrow(BadRequestException);
  });
});

describe("MeasurementService.catalog", () => {
  it("maps metric_definition rows to camelCase catalog items", async () => {
    const { service, captured } = serviceWith([
      {
        metric_id: "T2-001",
        version: 1,
        name: "email_coverage_rate",
        tier: "T2",
        unit: "ratio",
        status: "ACTIVE",
        owner: "data-eng",
        effective_from: new Date("2026-11-09T00:00:00.000Z"),
        definition: "share of matched accounts with an email",
      },
    ]);
    const items = await service.catalog();
    expect(items).toHaveLength(1);
    expect(items[0]?.metricId).toBe("T2-001");
    expect(items[0]?.owner).toBe("data-eng");
    expect(captured[0]).toContain("FROM metric_definition");
  });
});

describe("MeasurementService.observations", () => {
  it("validates inputs, pages with keyset cursor and maps rows", async () => {
    const { service, captured } = serviceWith([
      OBSERVATION_ROW,
      { ...OBSERVATION_ROW, id: "33333333-3333-4333-8333-333333333333" },
    ]);
    const page = await service.observations(ctx, {
      metricId: "T2-001",
      from: "2026-11-01",
      to: "2026-11-08",
      limit: "1",
    });
    expect(page.items).toHaveLength(1);
    expect(page.page.hasMore).toBe(true);
    expect(page.page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.page.nextCursor ?? undefined)).toEqual({
      w: OBSERVATION_ROW.window_end.toISOString(),
      id: OBSERVATION_ROW.id,
    });
    const sql = captured[0] ?? "";
    expect(sql).toContain("FROM metric_observation");
    expect(sql).toContain("ORDER BY window_end DESC, id DESC");
  });

  it("rejects bad metric ids, days, limits and cursors", async () => {
    const { service } = serviceWith([]);
    await expect(
      service.observations(ctx, { metricId: "bad id!" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.observations(ctx, { from: "11/08/2026" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.observations(ctx, { limit: "0" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.observations(ctx, { cursor: "%%%" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("MeasurementService.rollups", () => {
  it("selects the weekly table and paginates by bucket tuple", async () => {
    const { service, captured } = serviceWith([ROLLUP_ROW]);
    const page = await service.rollups(ctx, {
      granularity: "weekly",
      metricId: "T2-001",
      limit: "10",
    });
    expect(page.items[0]?.metricId).toBe("T2-001");
    expect(page.items[0]?.stratumKey).toBe(ROLLUP_ROW.stratum_key);
    expect(captured[0]).toContain("FROM metric_rollup_weekly");
    expect(captured[0]).toContain("ORDER BY week DESC");
  });

  it("rejects an unknown granularity", async () => {
    const { service } = serviceWith([]);
    await expect(
      service.rollups(ctx, { granularity: "monthly" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

function vricRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    bucket: "2026-11-08",
    metric_id: "T0-001",
    metric_version: 1,
    stratum_key: `{"workspace_id":"${ctx.workspaceId}"}`,
    numerator: 0,
    denominator: 128,
    value: 0,
    ci_low: 0,
    ci_high: 0.014,
    sample_n: 128,
    refreshed_at: new Date("2026-11-09T01:00:00.000Z"),
    ...overrides,
  };
}

describe("MeasurementService.vric", () => {
  it("pairs STRICT and PLUS per bucket, keeps the highest version and the latest limit buckets", async () => {
    const { service, captured } = serviceWith([
      vricRow({ bucket: "2026-11-06", value: 0.1 }),
      vricRow({ bucket: "2026-11-06", metric_id: "T0-002", value: 0.2 }),
      vricRow({ bucket: "2026-11-07", value: 0.3 }),
      vricRow({ bucket: "2026-11-08", value: 0.35 }),
      vricRow({ bucket: "2026-11-08", metric_version: 2, value: 0.4 }),
      vricRow({ bucket: "2026-11-08", metric_id: "T0-002", value: 0.5 }),
    ]);
    const page = await service.vric(ctx, { limit: "2" });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.bucket).toBe("2026-11-07");
    expect(page.items[0]?.strict?.value).toBe(0.3);
    expect(page.items[0]?.plus).toBeNull();
    expect(page.items[1]?.bucket).toBe("2026-11-08");
    expect(page.items[1]?.strict?.metricVersion).toBe(2);
    expect(page.items[1]?.strict?.value).toBe(0.4);
    expect(page.items[1]?.plus?.value).toBe(0.5);
    expect(page.page.hasMore).toBe(true);
    expect(page.page.nextCursor).toBeNull();
    expect((captured[0] ?? "").toLocaleLowerCase()).toContain("from metric_rollup_daily");
    expect(captured[0] ?? "").toContain("IN ('T0-001', 'T0-002')");
  });

  it("selects the weekly table and validates inputs", async () => {
    const { service, captured } = serviceWith([vricRow({ bucket: "2026-11-03" })]);
    const page = await service.vric(ctx, { granularity: "weekly", limit: "10" });
    expect(page.items[0]?.bucket).toBe("2026-11-03");
    expect(captured[0]).toContain("FROM metric_rollup_weekly");
    expect(captured[0]).toContain("week >=");

    await expect(
      service.vric(ctx, { granularity: "monthly" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.vric(ctx, { from: "2026-11-09", to: "2026-11-01" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.vric(ctx, { limit: "0" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.vric(ctx, { from: "11/01/2026" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
