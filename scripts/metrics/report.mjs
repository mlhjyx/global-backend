#!/usr/bin/env node
// report — render the mandated weekly/monthly GainOS report from metric
// observations (ch01 §3.6.7 / PR-15, template side).
//
//   node scripts/metrics/metrics-snapshot.mjs --out snapshot.json
//   node scripts/metrics/report.mjs --kind weekly --snapshot snapshot.json [--period 2026-W45]
//   node scripts/metrics/report.mjs --kind monthly --snapshot a.json --snapshot b.json --out report.md --out-json report.json
//
// Reads metric-observation/v1 rows (the snapshot runner's output) and renders
// the fixed report template: north star → coverage → reachability → quality
// gates → sources → risks. Metrics that are not wired yet (recall, golden
// precision, PSI, cost) are rendered as explicit "未接线" placeholders with
// the planned data source — never as fake numbers. Sections beyond the
// snapshot data (risks, next actions) stay as "（人工填写）".
//
// Wiring the engine's weekly-report service to these metric implementations
// still depends on the measurement API (ch01 PR-03/04) and stays out of this
// script on purpose.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { parseArgs, utcStamp } from "./lib/psql.mjs";

const REPORT_VERSION = "report-template/v1";

function percent(value, digits = 1) {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(digits)}%`;
}

function interval(ci, formatter = percent) {
  if (!ci || ci.low === undefined) return "—";
  return `[${formatter(ci.low)}, ${formatter(ci.high)}]`;
}

function formatDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** ISO week label (e.g. 2026-W45) for a date. */
export function isoWeekLabel(date = new Date()) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target - yearStart) / 86400000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Load snapshot documents and index observations by metric id. */
export function indexObservations(snapshots) {
  const byMetric = new Map();
  for (const snapshot of snapshots) {
    for (const row of snapshot.observations ?? []) {
      const list = byMetric.get(row.metricId) ?? [];
      list.push(row);
      byMetric.set(row.metricId, list);
    }
  }
  return byMetric;
}

function stratumValue(row) {
  return Object.values(row.stratum ?? {})[0];
}

/** The ALL/aggregate row of a metric (dimension value "ALL"), else first row. */
export function aggregateRow(rows) {
  if (!rows || rows.length === 0) return null;
  return rows.find((row) => stratumValue(row) === "ALL") ?? rows[0];
}

function topBy(rows, pick, direction = "desc", count = 3) {
  return rows
    .filter((row) => stratumValue(row) !== "ALL" && row.value !== null)
    .sort((left, right) => (direction === "desc" ? pick(right) - pick(left) : pick(left) - pick(right)))
    .slice(0, count);
}

/**
 * Build the structured report (sections of lines). Pure function of the
 * inputs; the cron wrapper only adds timestamps.
 */
export function buildReport({ observations, skipped = [], kind = "weekly", period, generatedAt = null }) {
  const reportDate = generatedAt ? generatedAt.slice(0, 10) : formatDate();
  const index = observations instanceof Map ? observations : indexObservations(observations);
  const linesFor = (metricId) => index.get(metricId) ?? [];
  const sections = [];
  const missing = [];

  // 1. North star
  const strict = aggregateRow(linesFor("T0-001"));
  const plus = aggregateRow(linesFor("T0-002"));
  const northStar = [];
  if (strict) {
    northStar.push(
      `- VRIC_1000_STRICT = ${strict.value === null ? "未接线" : (strict.value * 1000).toFixed(1)}（95% CI [${strict.value === null ? "—" : (strict.ci?.low * 1000).toFixed(1)}, ${strict.value === null ? "—" : (strict.ci?.high * 1000).toFixed(1)}]；分子 ${strict.numerator} / 账户 ${strict.denominator}；metric v${strict.metricVersion}）`,
    );
  } else {
    missing.push("T0-001");
    northStar.push("- VRIC_1000_STRICT：未接线（缺少 T0-001 观测）");
  }
  if (plus) {
    northStar.push(
      `- VRIC_1000_PLUS = ${plus.value === null ? "未接线" : (plus.value * 1000).toFixed(1)}（分子 ${plus.numerator} / 账户 ${plus.denominator}；PLUS 为引擎侧上界，见字典 §1.3.1）`,
    );
  } else {
    missing.push("T0-002");
    northStar.push("- VRIC_1000_PLUS：未接线（缺少 T0-002 观测）");
  }
  sections.push({ title: "1. 北极星", lines: northStar });

  // 2. Coverage
  const coverage = [
    "- 召回率 company_recall_vs_frame：未测（frame 抽样依赖 PR-11/12 帧接入）",
    "- fit precision/recall（金标口径）：未接线（金标集待标注，见 evals/golden-discovery/）",
  ];
  sections.push({ title: "2. 覆盖", lines: coverage });

  // 3. Reachability
  const reachability = [];
  const skippedById = new Map(skipped.map((row) => [row.metricId, row]));
  const reach = (metricId, label, scale = percent) => {
    const skipEntry = skippedById.get(metricId);
    const row = aggregateRow(linesFor(metricId));
    if (skipEntry && !row) {
      reachability.push(`- ${label}：不可测（${skipEntry.reason}：${skipEntry.detail}）`);
      return null;
    }
    if (!row) {
      missing.push(metricId);
      reachability.push(`- ${label}：未接线（缺少 ${metricId} 观测）`);
      return null;
    }
    if (row.status === "SKIPPED" || row.value === null) {
      reachability.push(`- ${label}：不可测（${row.reason ?? "分母为空"}）`);
      return row;
    }
    const small = row.denominator < 30 ? "（样本不足 n<30）" : "";
    reachability.push(
      `- ${label} = ${scale(row.value)}（95% CI ${interval(row.ci, scale)}；${row.numerator}/${row.denominator}${small}；metric v${row.metricVersion}）`,
    );
    return row;
  };
  reach("T2-001", "email 覆盖率（match 账户，任意状态）");
  reach("T2-002", "email VALID 率（已尝试验证）");
  reach("T2-003", "catch-all 率");
  reach("T2-004", "UNKNOWN 率");
  reach("T2-005", "phone 覆盖率");
  reach("T2-008", "contacts / match 账户", (value) => value.toFixed(2));
  const reachedIds = new Set(["T2-001", "T2-002", "T2-003", "T2-004", "T2-005", "T2-008"]);
  for (const row of skipped) {
    if (!reachedIds.has(row.metricId)) {
      reachability.push(`- ${row.metricId}：不可测（${row.reason}：${row.detail}）`);
    }
  }
  const emailByCountry = topBy(linesFor("T2-001"), (row) => row.denominator, "desc", 4);
  if (emailByCountry.length > 0) {
    reachability.push(
      `- email 覆盖率按国家（Top ${emailByCountry.length}，按账户数）：${emailByCountry
        .map((row) => `${stratumValue(row)} ${percent(row.value)}（${row.denominator}）`)
        .join(" / ")}`,
    );
  }
  sections.push({ title: "3. 可触达", lines: reachability });

  // 4. Quality gates
  const gates = [
    "- 金标 gates（G1–G6）：未接线（golden_eval_run 待 PR-07/08）",
    "- PSI 漂移：未接线（PR-09）",
    "- 失败分类 Top5：未接线（P3 失败分类学）",
    "- event backlog / metric freshness：未接线（measurement API，PR-03/04）",
  ];
  sections.push({ title: "4. 质量门", lines: gates });

  // 5. Sources
  const sourceLines = [];
  const acceptRows = linesFor("T1-008").filter((row) => stratumValue(row) !== "ALL" && row.value !== null);
  if (acceptRows.length > 0) {
    const worst = topBy(linesFor("T1-008"), (row) => row.value, "asc", 3);
    const best = topBy(linesFor("T1-008"), (row) => row.value, "desc", 3);
    sourceLines.push(
      `- 源接受率最好：${best.map((row) => `${stratumValue(row)} ${percent(row.value)}`).join(" / ")}`,
    );
    sourceLines.push(
      `- 源接受率最差：${worst.map((row) => `${stratumValue(row)} ${percent(row.value)}`).join(" / ")}`,
    );
  } else {
    missing.push("T1-008");
    sourceLines.push("- 源接受率：未接线（缺少 T1-008 观测）");
  }
  const rejection = linesFor("T1-009").filter(
    (row) => stratumValue(row) !== "ALL" && row.value !== null,
  );
  if (rejection.length > 0) {
    const top = topBy(linesFor("T1-009"), (row) => row.value, "desc", 3);
    sourceLines.push(
      `- 拒收原因 Top3：${top.map((row) => `${stratumValue(row)} ${percent(row.value)}（${row.numerator}）`).join(" / ")}`,
    );
  } else {
    missing.push("T1-009");
    sourceLines.push("- 拒收原因：未接线（缺少 T1-009 观测）");
  }
  sections.push({ title: "5. 源", lines: sourceLines });

  // 6. Monthly-only sections
  if (kind === "monthly") {
    sections.push({
      title: "6. 召回与金标（月度）",
      lines: [
        "- 召回报告（frame 抽样 / CR）：未测（PR-11/12/13 试点）",
        "- 金标重标 30–50 条与 κ：未执行（PR-08）",
        "- 竞品对照复测：未执行（PR-14，需采购授权）",
      ],
    });
    sections.push({
      title: "7. 成本对账（月度）",
      lines: [
        "- 供应商账单 vs UsageLedger/CostLedger：未接线（差异 >5% 必须解释）",
        "- cost_per_valid_contact：无分母（VALID=0）",
      ],
    });
  }

  // Risks
  sections.push({
    title: `${kind === "monthly" ? "8" : "6"}. 风险与下期动作`,
    lines: ["- （人工填写：本周阻塞、下期动作、需要产品负责人决策的事项）"],
  });

  return {
    schemaVersion: REPORT_VERSION,
    kind,
    period: period ?? (kind === "monthly" ? reportDate.slice(0, 7) : isoWeekLabel(new Date(`${reportDate}T00:00:00Z`))),
    generatedAt: generatedAt ?? utcStamp(),
    dataDate: reportDate,
    dictionaryVersion: "v1.3",
    sections,
    missingMetrics: [...new Set(missing)],
  };
}

/** Render the structured report as the fixed markdown template. */
export function renderMarkdown(report) {
  const out = [];
  out.push(`# GainOS 周报 ${report.period}`);
  out.push("");
  out.push(
    `> 模板：\`${report.schemaVersion}\`；数据日期 ${report.dataDate}；口径：指标字典 ${report.dictionaryVersion}（docs/metrics/metric-dictionary.md）；生成：\`scripts/metrics/report.mjs\``,
  );
  out.push("> 纪律：所有数字由 metric-observation 快照生成，禁止手写；未接线指标显示为「未接线/不可测」，不得用 0 或估计值冒充。");
  out.push("");
  for (const section of report.sections) {
    out.push(`## ${section.title}`);
    out.push("");
    for (const line of section.lines) out.push(line);
    out.push("");
  }
  if (report.missingMetrics.length > 0) {
    out.push("## 附：缺失观测");
    out.push("");
    out.push(`本报告缺少以下指标的观测（运行 \`scripts/metrics/metrics-snapshot.mjs\` 补齐）：${report.missingMetrics.join("、")}。`);
    out.push("");
  }
  out.push("---");
  out.push("");
  out.push("口径与变更流程见 `docs/metrics/metric-dictionary.md`；报告节奏见 `docs/metrics/reporting.md`。");
  return out.join("\n");
}

/** Extract repeated --snapshot flags; parseArgs keeps only the last one. */
function extractSnapshots(argv) {
  const snapshots = [];
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--snapshot") {
      if (argv[index + 1] === undefined) throw new Error("--snapshot requires a path");
      snapshots.push(argv[index + 1]);
      index += 1;
    } else if (token.startsWith("--snapshot=")) {
      snapshots.push(token.slice("--snapshot=".length));
    } else {
      rest.push(token);
    }
  }
  return { snapshots, rest };
}

function main() {
  const { snapshots: snapshotPaths, rest } = extractSnapshots(process.argv.slice(2));
  const flags = parseArgs(rest);
  if (flags.help || snapshotPaths.length === 0) {
    console.error(
      "usage: node scripts/metrics/report.mjs --kind weekly|monthly --snapshot <file> [--snapshot <file2>] [--period <label>] [--out <md>] [--out-json <json>] [--json]",
    );
    process.exit(flags.help ? 0 : 2);
  }
  const snapshots = snapshotPaths.map((path) => JSON.parse(readFileSync(path, "utf8")));
  const observations = indexObservations(snapshots);
  const skipped = snapshots.flatMap((snapshot) => snapshot.skipped ?? []);
  const report = buildReport({
    observations,
    skipped,
    kind: flags.kind === "monthly" ? "monthly" : "weekly",
    period: flags.period,
  });
  const markdown = renderMarkdown(report);
  if (flags.out) writeFileSync(flags.out, `${markdown}\n`);
  if (flags["out-json"]) writeFileSync(flags["out-json"], `${JSON.stringify(report, null, 2)}\n`);
  console.log(flags.json ? JSON.stringify(report, null, 2) : markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
