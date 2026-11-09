/**
 * ch01 PR-04：把机器可读指标字典（docs/metrics/dictionary/*.json）同步到
 * metric_definition 表（平台工件；owner 连接写入）。
 *
 * 运行：
 *   node --import tsx apps/api/scripts/measurement-sync-definitions.mts [--dry-run]
 *
 * 幂等：按 (metric_id, version) upsert；改名/改口径会更新同一行并刷新 content_hash。
 * 只做加法与更新，不删除行——退役指标由字典 status=RETIRED 表达。
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

interface MetricDefinitionFile {
  metrics: {
    id: string;
    version: number;
    name: string;
    tier: string;
    unit: string;
    definition: string;
    numerator: { expr: string };
    denominator: { expr: string } | null;
    exclusions: unknown[];
    window: unknown;
    strata: unknown[];
    owner: string;
    status: string;
    effectiveFrom: string;
    changelog: unknown[];
  }[];
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(",")}}`;
}

const dictionaryDir = new URL("../../../docs/metrics/dictionary/", import.meta.url);
const metrics = readdirSync(dictionaryDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .flatMap((name) => {
    const document = JSON.parse(
      readFileSync(new URL(name, dictionaryDir), "utf8"),
    ) as MetricDefinitionFile;
    return document.metrics;
  });

const dryRun = process.argv.includes("--dry-run");
const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
let synced = 0;
try {
  for (const metric of metrics) {
    const contentHash = createHash("sha256")
      .update(stableStringify(metric))
      .digest("hex");
    if (dryRun) {
      console.log(`[dry-run] ${metric.id} v${metric.version} ${metric.name}`);
      continue;
    }
    await db.$executeRaw`
      INSERT INTO "metric_definition"
        ("metric_id", "version", "name", "tier", "unit", "definition",
         "numerator_expr", "denominator_expr", "exclusions", "window_spec",
         "strata", "owner", "status", "effective_from", "changelog", "content_hash")
      VALUES (
        ${metric.id}, ${metric.version}, ${metric.name}, ${metric.tier}, ${metric.unit},
        ${metric.definition}, ${metric.numerator.expr},
        ${metric.denominator?.expr ?? null},
        ${JSON.stringify(metric.exclusions)}::jsonb,
        ${JSON.stringify(metric.window)}::jsonb,
        ${JSON.stringify(metric.strata)}::jsonb,
        ${metric.owner}, ${metric.status}, ${metric.effectiveFrom}::timestamptz,
        ${JSON.stringify(metric.changelog)}::jsonb, ${contentHash}
      )
      ON CONFLICT ("metric_id", "version") DO UPDATE SET
        "name" = EXCLUDED."name",
        "tier" = EXCLUDED."tier",
        "unit" = EXCLUDED."unit",
        "definition" = EXCLUDED."definition",
        "numerator_expr" = EXCLUDED."numerator_expr",
        "denominator_expr" = EXCLUDED."denominator_expr",
        "exclusions" = EXCLUDED."exclusions",
        "window_spec" = EXCLUDED."window_spec",
        "strata" = EXCLUDED."strata",
        "owner" = EXCLUDED."owner",
        "status" = EXCLUDED."status",
        "effective_from" = EXCLUDED."effective_from",
        "changelog" = EXCLUDED."changelog",
        "content_hash" = EXCLUDED."content_hash"`;
    synced += 1;
  }
  console.log(
    dryRun
      ? `[dry-run] ${metrics.length} metric definitions parsed`
      : `synced ${synced} metric definitions`,
  );
} finally {
  await db.$disconnect();
}
