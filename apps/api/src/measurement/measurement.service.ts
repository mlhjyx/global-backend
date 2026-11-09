import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { RequestContext } from "../auth/request-context";
import { PrismaService } from "../prisma/prisma.service";

const METRIC_ID = /^[A-Za-z0-9-]{1,32}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
/** /metrics/vric：VRIC STRICT(T0-001)+PLUS(T0-002) 成对序列的默认/最大桶数。 */
const VRIC_DEFAULT_BUCKETS = 30;
const VRIC_MAX_BUCKETS = 180;

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

/** 一桶一侧的口径值（STRICT 或 PLUS）。 */
export interface VricValue {
  metricVersion: number;
  numerator: number;
  denominator: number | null;
  value: number;
  ciLow: number | null;
  ciHigh: number | null;
  sampleN: number | null;
  refreshedAt: Date;
}

/** VRIC 成对桶：同一 bucket + stratum 下 STRICT/PLUS 并排；缺哪侧哪侧为 null。 */
export interface VricBucketItem {
  bucket: string;
  stratumKey: string;
  strict: VricValue | null;
  plus: VricValue | null;
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

function vricBucketLimitOf(limit: string | undefined): number {
  if (limit === undefined || limit === "") return VRIC_DEFAULT_BUCKETS;
  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestException({
      error: { code: "VALIDATION_ERROR", message: "limit must be a positive integer" },
    });
  }
  return Math.min(parsed, VRIC_MAX_BUCKETS);
}

/** 缺省窗口：to=今日（UTC），from=按粒度回看 buckets 个桶；显式 from/to 时只校验先后。 */
function vricRange(
  granularity: "daily" | "weekly",
  buckets: number,
  from: string | undefined,
  to: string | undefined,
): { fromDay: string; toDay: string } {
  const toDay = to ?? new Date().toISOString().slice(0, 10);
  const unitDays = granularity === "weekly" ? 7 : 1;
  const fromDay =
    from ??
    new Date(new Date(`${toDay}T00:00:00.000Z`).getTime() - (buckets - 1) * unitDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
  if (fromDay > toDay) {
    throw new BadRequestException({
      error: { code: "VALIDATION_ERROR", message: "from must be on or before to" },
    });
  }
  return { fromDay, toDay };
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

  /**
   * VRIC 成对序列（T0-001 STRICT + T0-002 PLUS）。
   *
   * 与 rollups 的差别：桶按时间升序返回（看板直接画趋势），不分游标页而是
   * 「最近 limit 个桶」的有界窗口；from/to 显式给出时窗口以最后 limit 个桶为准，
   * 更早的桶不返回（has_more 标记窗口被截断）。两侧口径缺一侧时该侧为 null——
   * 不得用 0 冒充缺失。行仍走 withWorkspace，只含本 workspace 可见行；平台级
   * ALL 行（workspace_id=ALL / NULL）对租户不可见。
   */
  async vric(
    ctx: RequestContext,
    query: {
      granularity?: string;
      from?: string;
      to?: string;
      limit?: string;
    },
  ): Promise<PageResult<VricBucketItem>> {
    const granularity = query.granularity ?? "daily";
    if (granularity !== "daily" && granularity !== "weekly") {
      throw new BadRequestException({
        error: {
          code: "VALIDATION_ERROR",
          message: "granularity must be daily or weekly",
        },
      });
    }
    const from = assertDay(query.from, "from");
    const to = assertDay(query.to, "to");
    const buckets = vricBucketLimitOf(query.limit);
    const { fromDay, toDay } = vricRange(granularity, buckets, from, to);
    const weekly = granularity === "weekly";
    interface VricRow {
      bucket: string;
      metric_id: string;
      metric_version: number;
      stratum_key: string;
      numerator: number;
      denominator: number | null;
      value: number;
      ci_low: number | null;
      ci_high: number | null;
      sample_n: number | null;
      refreshed_at: Date;
    }
    const columns = Prisma.sql`metric_id, metric_version, stratum_key,
             numerator::float8 AS numerator, denominator::float8 AS denominator,
             value::float8 AS value, ci_low::float8 AS ci_low,
             ci_high::float8 AS ci_high, sample_n, refreshed_at`;
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const rows: VricRow[] = weekly
        ? await tx.$queryRaw<VricRow[]>(Prisma.sql`
            SELECT week::text AS bucket, ${columns}
            FROM metric_rollup_weekly
            WHERE metric_id IN ('T0-001', 'T0-002')
              AND week >= ${fromDay}::date AND week <= ${toDay}::date
            ORDER BY week, metric_version, stratum_key`)
        : await tx.$queryRaw<VricRow[]>(Prisma.sql`
            SELECT day::text AS bucket, ${columns}
            FROM metric_rollup_daily
            WHERE metric_id IN ('T0-001', 'T0-002')
              AND day >= ${fromDay}::date AND day <= ${toDay}::date
            ORDER BY day, metric_version, stratum_key`);
      const byKey = new Map<string, VricBucketItem>();
      for (const row of rows) {
        const key = `${row.bucket}\u0000${row.stratum_key}`;
        let entry = byKey.get(key);
        if (!entry) {
          entry = { bucket: row.bucket, stratumKey: row.stratum_key, strict: null, plus: null };
          byKey.set(key, entry);
        }
        const value: VricValue = {
          metricVersion: row.metric_version,
          numerator: row.numerator,
          denominator: row.denominator,
          value: row.value,
          ciLow: row.ci_low,
          ciHigh: row.ci_high,
          sampleN: row.sample_n,
          refreshedAt: row.refreshed_at,
        };
        if (row.metric_id === "T0-001") {
          if (!entry.strict || value.metricVersion >= entry.strict.metricVersion) entry.strict = value;
        } else if (row.metric_id === "T0-002") {
          if (!entry.plus || value.metricVersion >= entry.plus.metricVersion) entry.plus = value;
        }
      }
      const items = [...byKey.values()].sort(
        (left, right) =>
          left.bucket.localeCompare(right.bucket) || left.stratumKey.localeCompare(right.stratumKey),
      );
      const bucketList = [...new Set(items.map((item) => item.bucket))].sort();
      const keep = new Set(bucketList.slice(-buckets));
      return {
        items: items.filter((item) => keep.has(item.bucket)),
        page: { nextCursor: null, hasMore: bucketList.length > buckets },
      };
    });
  }
}
