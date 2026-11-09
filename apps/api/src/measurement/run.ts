/**
 * ch01 PR-03：度量聚合运行器——按目标日计算首批核心指标，写 metric_observation
 * （append-only，computation_hash 幂等）并刷新日/周 rollup。
 *
 * 由 measurementRollupWorkflow 的活动调用；`apps/api/scripts/measurement-rollup.mts`
 * 可直接调用做本地运行与回填（两者共用同一实现，回填与实时一致）。
 *
 * 连接：使用 owner（DATABASE_URL）。度量作业是平台级服务写者（ch01 §3.6.9）：
 * 平台行 workspace_id IS NULL 只有 owner 能写；租户行带 workspace_id 但仍由
 * 该受信系统扫描器写入，租户侧只读（RLS 只放行自己的行）。
 */
import { PrismaClient } from "@prisma/client";
import { METRIC_QUERIES, MetricQueryRow } from "./metric-queries";
import {
  MetricObservationInput,
  bootstrapRatioInterval,
  buildObservation,
  wilsonInterval,
} from "./rollup";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface MeasurementRunInput {
  day: string;
}

export interface MeasurementRunResult {
  day: string;
  observationsBuilt: number;
  observationsInserted: number;
  rollupDailyRows: number;
  rollupWeeklyRows: number;
  skipped: { metricId: string; reason: string }[];
  computedAt: string;
}

/** Parse `YYYY-MM-DD` into the UTC day window used by every snapshot/rolling query. */
export function parseMeasurementDay(day: string): { dayStart: Date; dayEnd: Date } {
  if (!DAY_PATTERN.test(day)) {
    throw new Error(`MEASUREMENT_DAY_INVALID: expected YYYY-MM-DD, got ${day}`);
  }
  const dayStart = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(dayStart.getTime()) || !dayStart.toISOString().startsWith(day)) {
    throw new Error(`MEASUREMENT_DAY_INVALID: ${day}`);
  }
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { dayStart, dayEnd };
}

function stratumWorkspaceId(stratum: Record<string, unknown>): string | null {
  const value = stratum.workspace_id;
  return typeof value === "string" && value !== "ALL" ? value : null;
}

/** Build observations for one metric from its raw count rows. */
export function buildMetricObservations(
  metric: { metricId: string; metricVersion: number; ciMethod: "wilson" | "bootstrap" },
  rows: MetricQueryRow[],
  window: { start: Date; end: Date },
  seed: string,
): MetricObservationInput[] {
  return rows.map((row) => {
    const denominator = typeof row.denominator === "number" ? row.denominator : null;
    const numerator = typeof row.numerator === "number" ? row.numerator : 0;
    const ci =
      metric.ciMethod === "bootstrap"
        ? bootstrapRatioInterval(numerator, denominator ?? 0, seed)
        : denominator !== null
          ? wilsonInterval(numerator, denominator)
          : null;
    return buildObservation({
      metricId: metric.metricId,
      metricVersion: metric.metricVersion,
      workspaceId: stratumWorkspaceId(row.stratum),
      stratum: row.stratum,
      windowStart: window.start,
      windowEnd: window.end,
      numerator,
      denominator,
      ci,
    });
  });
}

async function insertObservation(
  db: PrismaClient,
  observation: MetricObservationInput,
): Promise<number> {
  return db.$executeRaw`
    INSERT INTO "metric_observation"
      ("workspace_id", "metric_id", "metric_version", "stratum", "stratum_key",
       "window_start", "window_end", "numerator", "denominator", "value",
       "ci_low", "ci_high", "sample_n", "computation_hash")
    VALUES (
      ${observation.workspaceId}::uuid, ${observation.metricId}, ${observation.metricVersion},
      ${JSON.stringify(observation.stratum)}::jsonb, ${observation.stratumKey},
      ${observation.windowStart}::timestamptz, ${observation.windowEnd}::timestamptz,
      ${observation.numerator}, ${observation.denominator}, ${observation.value},
      ${observation.ciLow}, ${observation.ciHigh}, ${observation.sampleN},
      ${observation.computationHash}
    )
    ON CONFLICT ON CONSTRAINT "metric_observation_identity_key" DO NOTHING`;
}

/**
 * Refresh the daily or weekly rollup from the latest observation per stratum
 * that ends inside the target bucket. Idempotent (upsert on the primary key).
 */
export async function refreshRollup(
  db: PrismaClient,
  granularity: "day" | "week",
  dayStart: Date,
  dayEnd: Date,
): Promise<number> {
  if (granularity === "day") {
    return db.$executeRaw`
      /* rollup:daily */
      INSERT INTO "metric_rollup_daily"
        ("day", "metric_id", "metric_version", "stratum", "stratum_key",
         "numerator", "denominator", "value", "ci_low", "ci_high", "sample_n")
      SELECT date_trunc('day', latest."window_end")::date, latest."metric_id",
             latest."metric_version", latest."stratum", latest."stratum_key",
             latest."numerator", latest."denominator", latest."value",
             latest."ci_low", latest."ci_high", latest."sample_n"
      FROM (
        SELECT DISTINCT ON ("metric_id", "metric_version", "stratum_key")
          "window_end", "metric_id", "metric_version", "stratum", "stratum_key",
          "numerator", "denominator", "value", "ci_low", "ci_high", "sample_n"
        FROM "metric_observation"
        WHERE "window_end" <= ${dayEnd}::timestamptz
        ORDER BY "metric_id", "metric_version", "stratum_key", "window_end" DESC,
                 "computed_at" DESC
      ) latest
      WHERE date_trunc('day', latest."window_end")::date = ${dayStart}::date
      ON CONFLICT ("day", "metric_id", "metric_version", "stratum_key") DO UPDATE SET
        "numerator" = EXCLUDED."numerator",
        "denominator" = EXCLUDED."denominator",
        "value" = EXCLUDED."value",
        "ci_low" = EXCLUDED."ci_low",
        "ci_high" = EXCLUDED."ci_high",
        "sample_n" = EXCLUDED."sample_n",
        "refreshed_at" = now()`;
  }
  return db.$executeRaw`
    /* rollup:weekly */
    INSERT INTO "metric_rollup_weekly"
      ("week", "metric_id", "metric_version", "stratum", "stratum_key",
       "numerator", "denominator", "value", "ci_low", "ci_high", "sample_n")
    SELECT date_trunc('week', latest."window_end")::date, latest."metric_id",
           latest."metric_version", latest."stratum", latest."stratum_key",
           latest."numerator", latest."denominator", latest."value",
           latest."ci_low", latest."ci_high", latest."sample_n"
    FROM (
      SELECT DISTINCT ON ("metric_id", "metric_version", "stratum_key")
        "window_end", "metric_id", "metric_version", "stratum", "stratum_key",
        "numerator", "denominator", "value", "ci_low", "ci_high", "sample_n"
      FROM "metric_observation"
      WHERE "window_end" <= ${dayEnd}::timestamptz
      ORDER BY "metric_id", "metric_version", "stratum_key", "window_end" DESC,
               "computed_at" DESC
    ) latest
    WHERE date_trunc('week', latest."window_end")::date = date_trunc('week', ${dayStart}::timestamptz)::date
    ON CONFLICT ("week", "metric_id", "metric_version", "stratum_key") DO UPDATE SET
      "numerator" = EXCLUDED."numerator",
      "denominator" = EXCLUDED."denominator",
      "value" = EXCLUDED."value",
      "ci_low" = EXCLUDED."ci_low",
      "ci_high" = EXCLUDED."ci_high",
      "sample_n" = EXCLUDED."sample_n",
      "refreshed_at" = now()`;
}

/** Run the daily measurement rollup for one UTC day. */
export async function runMeasurementRollup(
  db: PrismaClient,
  input: MeasurementRunInput,
): Promise<MeasurementRunResult> {
  const { dayStart, dayEnd } = parseMeasurementDay(input.day);
  const skipped: { metricId: string; reason: string }[] = [];
  const observations: MetricObservationInput[] = [];
  for (const metric of METRIC_QUERIES) {
    if (metric.skipReason) {
      skipped.push({ metricId: metric.metricId, reason: metric.skipReason });
      continue;
    }
    const window =
      metric.windowMode === "rolling"
        ? {
            start: new Date(
              dayStart.getTime() - ((metric.rollingDays ?? 7) - 1) * 24 * 60 * 60 * 1000,
            ),
            end: dayEnd,
          }
        : { start: dayStart, end: dayEnd };
    const rows = await db.$queryRaw<MetricQueryRow[]>(
      metric.buildSql(dayStart, dayEnd),
    );
    observations.push(
      ...buildMetricObservations(
        metric,
        rows,
        window,
        `${input.day}:${metric.metricId}`,
      ),
    );
  }
  let observationsInserted = 0;
  for (const observation of observations) {
    observationsInserted += await insertObservation(db, observation);
  }
  const rollupDailyRows = await refreshRollup(db, "day", dayStart, dayEnd);
  const rollupWeeklyRows = await refreshRollup(db, "week", dayStart, dayEnd);
  return {
    day: input.day,
    observationsBuilt: observations.length,
    observationsInserted,
    rollupDailyRows,
    rollupWeeklyRows,
    skipped,
    computedAt: new Date().toISOString(),
  };
}
