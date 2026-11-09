/**
 * ch01 PR-05：度量告警评估命令（只读，owner 连接；不写表、不发通知）。
 *
 *   node --import tsx apps/api/scripts/measurement-alerts.mts
 *   node --import tsx apps/api/scripts/measurement-alerts.mts --json
 *   node --import tsx apps/api/scripts/measurement-alerts.mts --as-of 2026-11-09T02:00:00Z
 *   node --import tsx apps/api/scripts/measurement-alerts.mts --rules docs/metrics/alerts/rules.v1.json
 *
 * 规则定义见 docs/metrics/alerts.md；提交期由 scripts/metrics/metrics-lint.mjs
 * 校验规则文件（结构、指标存在性）。退出码：0 无告警；10 有 WARNING；
 * 20 有 CRITICAL；1 运行错误（规则文件/连接）。NO_DATA / INSUFFICIENT_DATA
 * 不算告警，但会在输出里列出来——数据缺失不能被当成健康。
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  AlertSample,
  RollupGranularity,
  assertAlertRules,
  evaluateAlerts,
  summarizeAlertEvaluations,
} from "../src/measurement/alerts";

const DEFAULT_RULES = fileURLToPath(
  new URL("../../../docs/metrics/alerts/rules.v1.json", import.meta.url),
);

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function parseAsOf(raw: string | undefined): Date {
  if (raw === undefined) return new Date();
  const asOf = new Date(raw);
  if (Number.isNaN(asOf.getTime())) {
    throw new Error(`--as-of is not a valid ISO timestamp: ${raw}`);
  }
  return asOf;
}

interface ThresholdRow {
  metric_id: string;
  metric_version: number;
  stratum: Record<string, unknown>;
  bucket: string;
  value: number;
  denominator: number | null;
}

interface LatestRow {
  metric_id: string;
  latest: string | Date | null;
}

function bucketEnd(bucket: string, granularity: RollupGranularity): Date {
  const start = new Date(`${bucket}T00:00:00.000Z`);
  const days = granularity === "weekly" ? 7 : 1;
  return new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
}

function rollupKey(granularity: RollupGranularity, metricId: string): string {
  return `${granularity}:${metricId}`;
}

async function main(): Promise<number> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      [
        "usage: node --import tsx apps/api/scripts/measurement-alerts.mts [--json] [--as-of <iso>] [--rules <path>]",
        "",
        "exit codes: 0 no firing alerts; 10 WARNING firing; 20 CRITICAL firing; 1 runtime error",
      ].join("\n"),
    );
    return 0;
  }
  const rulesPath = argumentValue("--rules") ?? DEFAULT_RULES;
  const asOf = parseAsOf(argumentValue("--as-of"));
  const json = process.argv.includes("--json");
  const rules = assertAlertRules(JSON.parse(readFileSync(rulesPath, "utf8")));

  const thresholdMetricIds = [...new Set(
    rules.filter((rule) => rule.kind === "threshold").map((rule) => rule.metricId),
  )];
  const dailyThresholdMetrics = [...new Set(
    rules
      .filter((rule) => rule.kind === "threshold" && rule.granularity === "daily")
      .map((rule) => rule.metricId),
  )];
  const weeklyThresholdMetrics = [...new Set(
    rules
      .filter((rule) => rule.kind === "threshold" && rule.granularity === "weekly")
      .map((rule) => rule.metricId),
  )];
  const observationFreshnessMetrics = [...new Set(
    rules
      .filter((rule) => rule.kind === "freshness" && rule.source === "observation")
      .map((rule) => rule.metricId),
  )];
  const rollupFreshnessKeys = [...new Set(
    rules
      .filter((rule) => rule.kind === "freshness" && rule.source === "rollup")
      .map((rule) => `${rule.granularity}:${rule.metricId}`),
  )];
  const rollupFreshnessDaily = rollupFreshnessKeys
    .filter((key) => key.startsWith("daily:"))
    .map((key) => key.slice("daily:".length));
  const rollupFreshnessWeekly = rollupFreshnessKeys
    .filter((key) => key.startsWith("weekly:"))
    .map((key) => key.slice("weekly:".length));

  const asOfDay = asOf.toISOString().slice(0, 10);
  // 92 天覆盖 90 桶上限并留两天余量；桶按日/周日期过滤，不做全表扫描。
  const sinceDay = new Date(asOf.getTime() - 92 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const prisma = new PrismaClient();
  try {
    const samples: AlertSample[] = [];
    if (dailyThresholdMetrics.length > 0) {
      const rows = await prisma.$queryRaw<ThresholdRow[]>`
        SELECT metric_id, metric_version, stratum, day::text AS bucket,
               value::float8 AS value, denominator::float8 AS denominator
        FROM metric_rollup_daily
        WHERE metric_id = ANY(${dailyThresholdMetrics}::text[])
          AND day >= ${sinceDay}::date AND day <= ${asOfDay}::date`;
      for (const row of rows) {
        samples.push({
          metricId: row.metric_id,
          metricVersion: row.metric_version,
          stratum: row.stratum,
          bucket: row.bucket,
          value: row.value,
          denominator: row.denominator,
          granularity: "daily",
        });
      }
    }
    if (weeklyThresholdMetrics.length > 0) {
      const rows = await prisma.$queryRaw<ThresholdRow[]>`
        SELECT metric_id, metric_version, stratum, week::text AS bucket,
               value::float8 AS value, denominator::float8 AS denominator
        FROM metric_rollup_weekly
        WHERE metric_id = ANY(${weeklyThresholdMetrics}::text[])
          AND week >= ${sinceDay}::date AND week <= ${asOfDay}::date`;
      for (const row of rows) {
        samples.push({
          metricId: row.metric_id,
          metricVersion: row.metric_version,
          stratum: row.stratum,
          bucket: row.bucket,
          value: row.value,
          denominator: row.denominator,
          granularity: "weekly",
        });
      }
    }
    const observationLatest = new Map<string, Date | null>();
    for (const metricId of [...thresholdMetricIds, ...observationFreshnessMetrics]) {
      observationLatest.set(metricId, null);
    }
    if (observationFreshnessMetrics.length > 0) {
      const rows = await prisma.$queryRaw<LatestRow[]>`
        SELECT metric_id, max(window_end) AS latest
        FROM metric_observation
        WHERE metric_id = ANY(${observationFreshnessMetrics}::text[])
        GROUP BY metric_id`;
      for (const row of rows) {
        if (row.latest !== null) observationLatest.set(row.metric_id, new Date(row.latest));
      }
    }
    const rollupLatest = new Map<string, Date | null>();
    if (rollupFreshnessDaily.length > 0) {
      const rows = await prisma.$queryRaw<LatestRow[]>`
        SELECT metric_id, max(day)::text AS latest
        FROM metric_rollup_daily
        WHERE metric_id = ANY(${rollupFreshnessDaily}::text[])
        GROUP BY metric_id`;
      for (const row of rows) {
        if (row.latest !== null) {
          const bucket = String(row.latest).slice(0, 10);
          rollupLatest.set(rollupKey("daily", row.metric_id), bucketEnd(bucket, "daily"));
        }
      }
    }
    if (rollupFreshnessWeekly.length > 0) {
      const rows = await prisma.$queryRaw<LatestRow[]>`
        SELECT metric_id, max(week)::text AS latest
        FROM metric_rollup_weekly
        WHERE metric_id = ANY(${rollupFreshnessWeekly}::text[])
        GROUP BY metric_id`;
      for (const row of rows) {
        if (row.latest !== null) {
          const bucket = String(row.latest).slice(0, 10);
          rollupLatest.set(rollupKey("weekly", row.metric_id), bucketEnd(bucket, "weekly"));
        }
      }
    }

    const evaluations = evaluateAlerts(
      rules,
      { thresholdSamples: samples, observationLatest, rollupLatest },
      asOf,
    );
    const summary = summarizeAlertEvaluations(evaluations);
    if (json) {
      console.log(JSON.stringify({ asOf: asOf.toISOString(), rules: rules.length, summary, evaluations }, null, 2));
    } else {
      console.log(`measurement-alerts asOf=${asOf.toISOString()} rules=${rules.length}`);
      for (const evaluation of evaluations) {
        const detail =
          evaluation.kind === "threshold"
            ? `value=${evaluation.observedValue ?? "-"} bound ${evaluation.comparison}=${evaluation.bound} bucket=${evaluation.bucket ?? "-"}`
            : `latest=${evaluation.latestDataAt ?? "-"} ageHours=${evaluation.ageHours ?? "-"} max=${evaluation.maxAgeHours}`;
        console.log(
          `${evaluation.ruleId} ${evaluation.severity} ${evaluation.status} ${evaluation.metricId} kind=${evaluation.kind} ${detail} — ${evaluation.message}`,
        );
      }
      console.log(
        `summary: firing=${summary.firing} ok=${summary.ok} no_data=${summary.noData} insufficient_data=${summary.insufficientData} exit=${summary.exitCode}`,
      );
    }
    return summary.exitCode;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
