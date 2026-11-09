import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { RequestContext } from "../auth/request-context";
import { PrismaService } from "../prisma/prisma.service";

const METRIC_ID = /^[A-Za-z0-9-]{1,32}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export interface MetricCatalogItem {
  metricId: string;
  version: number;
  name: string;
  tier: string;
  unit: string;
  status: string;
  owner: string;
  effectiveFrom: Date;
  definition: string;
}

export interface MetricObservationItem {
  id: string;
  metricId: string;
  metricVersion: number;
  stratum: unknown;
  windowStart: Date;
  windowEnd: Date;
  numerator: number;
  denominator: number | null;
  value: number;
  ciLow: number | null;
  ciHigh: number | null;
  sampleN: number | null;
  computedAt: Date;
}

export interface MetricRollupItem {
  bucket: Date;
  metricId: string;
  metricVersion: number;
  stratum: unknown;
  stratumKey: string;
  numerator: number;
  denominator: number | null;
  value: number;
  ciLow: number | null;
  ciHigh: number | null;
  sampleN: number | null;
  refreshedAt: Date;
}

export interface PageResult<T> {
  items: T[];
  page: { nextCursor: string | null; hasMore: boolean };
}

/** Opaque keyset cursor (base64url JSON) — validated on decode. */
export function encodeCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(
  cursor: string | undefined,
): Record<string, string> | null {
  if (cursor === undefined || cursor === "") return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Object.values(parsed as Record<string, unknown>).some(
        (value) => typeof value !== "string",
      )
    ) {
      throw new Error("cursor shape");
    }
    return parsed as Record<string, string>;
  } catch {
    throw new BadRequestException({
      error: { code: "VALIDATION_ERROR", message: "cursor is not valid" },
    });
  }
}

function assertMetricId(metricId: string | undefined): string | undefined {
  if (metricId === undefined || metricId === "") return undefined;
  if (!METRIC_ID.test(metricId)) {
    throw new BadRequestException({
      error: {
        code: "VALIDATION_ERROR",
        message: "metricId must match [A-Za-z0-9-]{1,32}",
      },
    });
  }
  return metricId;
}

function assertDay(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new BadRequestException({
      error: { code: "VALIDATION_ERROR", message: `${label} must be YYYY-MM-DD` },
    });
  }
  return value;
}

function limitOf(limit: string | undefined): number {
  if (limit === undefined || limit === "") return DEFAULT_LIMIT;
  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestException({
      error: { code: "VALIDATION_ERROR", message: "limit must be a positive integer" },
    });
  }
  return Math.min(parsed, MAX_LIMIT);
}

function pageOf<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => Record<string, string>,
): PageResult<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items,
    page: {
      nextCursor: hasMore && items.length > 0 ? encodeCursor(cursorOf(items[items.length - 1]!)) : null,
      hasMore,
    },
  };
}

/**
 * ch01 PR-04：度量只读 API。
 *
 * - catalog 读平台工件 metric_definition（app_user 只读，无 RLS）；
 * - observations / rollups 走 withWorkspace：metric_observation 按 workspace_id 的 RLS、
 *   rollup 两表按 stratum->>'workspace_id' 的 RLS，租户只看到自己的行（PR-02 已验证）；
 *   平台级行（workspace NULL / 无 workspace 键）对租户不可见。
 * 分页统一 keyset cursor（base64url JSON），列表信封由控制器用 pageEnvelope 输出。
 */
@Injectable()
export class MeasurementService {
  constructor(private readonly prisma: PrismaService) {}

  async catalog(): Promise<MetricCatalogItem[]> {
    const rows = await this.prisma.$queryRaw<
      {
        metric_id: string;
        version: number;
        name: string;
        tier: string;
        unit: string;
        status: string;
        owner: string;
        effective_from: Date;
        definition: string;
      }[]
    >`
      SELECT metric_id, version, name, tier, unit, status, owner, effective_from, definition
      FROM metric_definition
      ORDER BY metric_id, version`;
    return rows.map((row) => ({
      metricId: row.metric_id,
      version: row.version,
      name: row.name,
      tier: row.tier,
      unit: row.unit,
      status: row.status,
      owner: row.owner,
      effectiveFrom: row.effective_from,
      definition: row.definition,
    }));
  }

  async observations(
    ctx: RequestContext,
    query: {
      metricId?: string;
      from?: string;
      to?: string;
      cursor?: string;
      limit?: string;
    },
  ): Promise<PageResult<MetricObservationItem>> {
    const metricId = assertMetricId(query.metricId);
    const from = assertDay(query.from, "from");
    const to = assertDay(query.to, "to");
    const cursor = decodeCursor(query.cursor);
    const limit = limitOf(query.limit);
    if (cursor && (!cursor.w || !cursor.id)) {
      throw new BadRequestException({
        error: { code: "VALIDATION_ERROR", message: "cursor is not valid" },
      });
    }
    // Each fragment is a const so the raw-SQL parameter-type gate can resolve
    // every statement statically (no Prisma.join over runtime arrays).
    const metricFilter = metricId
      ? Prisma.sql`AND metric_id = ${metricId}`
      : Prisma.empty;
    const fromFilter = from
      ? Prisma.sql`AND window_end >= ${from}::date`
      : Prisma.empty;
    const toFilter = to
      ? Prisma.sql`AND window_end < (${to}::date + interval '1 day')`
      : Prisma.empty;
    const cursorFilter = cursor
      ? Prisma.sql`AND (window_end, id) < (${cursor.w}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.empty;
    const where = Prisma.sql`WHERE true ${metricFilter} ${fromFilter} ${toFilter} ${cursorFilter}`;
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          metric_id: string;
          metric_version: number;
          stratum: unknown;
          window_start: Date;
          window_end: Date;
          numerator: number;
          denominator: number | null;
          value: number;
          ci_low: number | null;
          ci_high: number | null;
          sample_n: number | null;
          computed_at: Date;
        }[]
      >(Prisma.sql`
        SELECT id::text AS id, metric_id, metric_version, stratum,
               window_start, window_end,
               numerator::float8 AS numerator, denominator::float8 AS denominator,
               value::float8 AS value, ci_low::float8 AS ci_low,
               ci_high::float8 AS ci_high, sample_n, computed_at
        FROM metric_observation
        ${where}
        ORDER BY window_end DESC, id DESC
        LIMIT ${limit + 1}`);
      const items = rows.map((row) => ({
        id: row.id,
        metricId: row.metric_id,
        metricVersion: row.metric_version,
        stratum: row.stratum,
        windowStart: row.window_start,
        windowEnd: row.window_end,
        numerator: row.numerator,
        denominator: row.denominator,
        value: row.value,
        ciLow: row.ci_low,
        ciHigh: row.ci_high,
        sampleN: row.sample_n,
        computedAt: row.computed_at,
      }));
      return pageOf(items, limit, (item) => ({
        w: item.windowEnd.toISOString(),
        id: item.id,
      }));
    });
  }

  async rollups(
    ctx: RequestContext,
    query: {
      granularity?: string;
      metricId?: string;
      from?: string;
      to?: string;
      cursor?: string;
      limit?: string;
    },
  ): Promise<PageResult<MetricRollupItem>> {
    const granularity = query.granularity ?? "daily";
    if (granularity !== "daily" && granularity !== "weekly") {
      throw new BadRequestException({
        error: {
          code: "VALIDATION_ERROR",
          message: "granularity must be daily or weekly",
        },
      });
    }
    const metricId = assertMetricId(query.metricId);
    const from = assertDay(query.from, "from");
    const to = assertDay(query.to, "to");
    const cursor = decodeCursor(query.cursor);
    const limit = limitOf(query.limit);
    if (cursor && (!cursor.b || !cursor.m || !cursor.v || cursor.k === undefined)) {
      throw new BadRequestException({
        error: { code: "VALIDATION_ERROR", message: "cursor is not valid" },
      });
    }
    const weekly = granularity === "weekly";
    // Column names are written out per granularity (identifiers are not
    // parameterizable). Each granularity keeps its own fragments and its own
    // WHERE: the raw-SQL gate expands conditional fragments independently, so
    // a shared WHERE would pair daily tables with weekly column names.
    const metricFilter = metricId
      ? Prisma.sql`AND metric_id = ${metricId}`
      : Prisma.empty;
    const fromFilterDaily = from
      ? Prisma.sql`AND day >= ${from}::date`
      : Prisma.empty;
    const toFilterDaily = to
      ? Prisma.sql`AND day <= ${to}::date`
      : Prisma.empty;
    const cursorFilterDaily = cursor
      ? Prisma.sql`AND (
          day < ${cursor.b}::date
          OR (day = ${cursor.b}::date AND metric_id > ${cursor.m})
          OR (day = ${cursor.b}::date AND metric_id = ${cursor.m} AND metric_version > ${cursor.v}::int)
          OR (day = ${cursor.b}::date AND metric_id = ${cursor.m} AND metric_version = ${cursor.v}::int AND stratum_key > ${cursor.k}))`
      : Prisma.empty;
    const fromFilterWeekly = from
      ? Prisma.sql`AND week >= ${from}::date`
      : Prisma.empty;
    const toFilterWeekly = to
      ? Prisma.sql`AND week <= ${to}::date`
      : Prisma.empty;
    const cursorFilterWeekly = cursor
      ? Prisma.sql`AND (
          week < ${cursor.b}::date
          OR (week = ${cursor.b}::date AND metric_id > ${cursor.m})
          OR (week = ${cursor.b}::date AND metric_id = ${cursor.m} AND metric_version > ${cursor.v}::int)
          OR (week = ${cursor.b}::date AND metric_id = ${cursor.m} AND metric_version = ${cursor.v}::int AND stratum_key > ${cursor.k}))`
      : Prisma.empty;
    const whereDaily = Prisma.sql`WHERE true ${metricFilter} ${fromFilterDaily} ${toFilterDaily} ${cursorFilterDaily}`;
    const whereWeekly = Prisma.sql`WHERE true ${metricFilter} ${fromFilterWeekly} ${toFilterWeekly} ${cursorFilterWeekly}`;
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          bucket: Date;
          metric_id: string;
          metric_version: number;
          stratum: unknown;
          stratum_key: string;
          numerator: number;
          denominator: number | null;
          value: number;
          ci_low: number | null;
          ci_high: number | null;
          sample_n: number | null;
          refreshed_at: Date;
        }[]
      >(weekly
        ? Prisma.sql`
            SELECT week AS bucket, metric_id, metric_version, stratum, stratum_key,
                   numerator::float8 AS numerator, denominator::float8 AS denominator,
                   value::float8 AS value, ci_low::float8 AS ci_low,
                   ci_high::float8 AS ci_high, sample_n, refreshed_at
            FROM metric_rollup_weekly
            ${whereWeekly}
            ORDER BY week DESC, metric_id, metric_version, stratum_key
            LIMIT ${limit + 1}`
        : Prisma.sql`
            SELECT day AS bucket, metric_id, metric_version, stratum, stratum_key,
                   numerator::float8 AS numerator, denominator::float8 AS denominator,
                   value::float8 AS value, ci_low::float8 AS ci_low,
                   ci_high::float8 AS ci_high, sample_n, refreshed_at
            FROM metric_rollup_daily
            ${whereDaily}
            ORDER BY day DESC, metric_id, metric_version, stratum_key
            LIMIT ${limit + 1}`);
      const items = rows.map((row) => ({
        bucket: row.bucket,
        metricId: row.metric_id,
        metricVersion: row.metric_version,
        stratum: row.stratum,
        stratumKey: row.stratum_key,
        numerator: row.numerator,
        denominator: row.denominator,
        value: row.value,
        ciLow: row.ci_low,
        ciHigh: row.ci_high,
        sampleN: row.sample_n,
        refreshedAt: row.refreshed_at,
      }));
      return pageOf(items, limit, (item) => ({
        b: item.bucket.toISOString().slice(0, 10),
        m: item.metricId,
        v: String(item.metricVersion),
        k: item.stratumKey,
      }));
    });
  }
}
