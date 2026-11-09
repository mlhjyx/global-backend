#!/usr/bin/env node
// metrics-lint — validate the machine-readable metric dictionary (ch01 PR-01).
//
//   node scripts/metrics/metrics-lint.mjs            # summary + issues
//   node scripts/metrics/metrics-lint.mjs --json     # machine-readable
//   node scripts/metrics/metrics-lint.mjs --dir <dir>
//
// Rules (ch01 §3.1.1):
//   - metric-definition/v1 shape, unknown fields rejected (typo guard)
//   - unique IDs/names; tier matches the ID prefix and the file's tier
//   - numerator/denominator reference registered sources (docs/metrics/schemas/sources.v1.json);
//     ACTIVE metrics may only use existing sources (planned/SaaS -> must be DRAFT)
//   - ratio metrics need a denominator; window/strata/ci vocabularies are closed
//   - changelog runs 1..version without gaps and the last entry equals `version`
// Full EXPLAIN validation needs a database and is a follow-up; the source
// registry is the dependency-free substitute CI can run today.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseArgs } from "./lib/psql.mjs";

const DEFAULT_DIR = fileURLToPath(new URL("../../docs/metrics/dictionary", import.meta.url));
const DEFAULT_SOURCES = fileURLToPath(new URL("../../docs/metrics/schemas/sources.v1.json", import.meta.url));

const TIERS = new Set(["T0", "T1", "T2", "T3", "T4", "GUARDRAIL"]);
const UNITS = new Set([
  "ratio",
  "count",
  "count_per_1000",
  "usd",
  "usd_per_1000",
  "days",
  "hours",
  "seconds",
  "kappa",
  "index",
  "distribution",
  "status",
]);
const OWNERS = new Set(["data-eng", "backend", "gtm-ops", "product"]);
const STATUSES = new Set(["ACTIVE", "DRAFT", "DEPRECATED", "RETIRED"]);
const WINDOW_TYPES = new Set(["snapshot", "rolling", "cohort"]);
const CADENCES = new Set(["daily", "weekly", "monthly", "quarterly"]);
const STRATA = new Set([
  "country",
  "industry",
  "employee_band",
  "source_class",
  "provider_key",
  "channel",
  "verifier",
  "persona_role",
  "icp_id",
  "workspace_id",
  "week",
  "frame_key",
  "task",
  "field",
]);
const CI_METHODS = new Set(["wilson", "bootstrap", "none"]);
const METRIC_FIELDS = new Set([
  "schemaVersion",
  "id",
  "name",
  "tier",
  "unit",
  "owner",
  "status",
  "version",
  "effectiveFrom",
  "exprStatus",
  "definition",
  "numerator",
  "denominator",
  "exclusions",
  "window",
  "strata",
  "ci",
  "benchmark",
  "changelog",
]);
const ID_PATTERN = /^(T[0-4]|G)-[0-9]{3}$/;
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ch01 PR-05：告警规则（docs/metrics/alerts/rules.v1.json）与字典同门禁。
const DEFAULT_ALERTS = fileURLToPath(new URL("../../docs/metrics/alerts/rules.v1.json", import.meta.url));
const ALERT_SCHEMA = "measurement-alerts/v1";
const ALERT_ID_PATTERN = /^AL-[0-9]{3}$/;
const ALERT_SEVERITIES = new Set(["WARNING", "CRITICAL"]);
const ALERT_GRANULARITIES = new Set(["daily", "weekly"]);
const ALERT_AGGREGATIONS = new Set(["latest", "mean"]);
const ALERT_BASE_FIELDS = ["id", "metricId", "severity", "owner", "description", "kind"];
const ALERT_THRESHOLD_FIELDS = new Set([
  ...ALERT_BASE_FIELDS,
  "comparison",
  "bound",
  "granularity",
  "aggregation",
  "lookbackBuckets",
  "minSample",
  "stratumEquals",
]);
const ALERT_FRESHNESS_FIELDS = new Set([...ALERT_BASE_FIELDS, "source", "granularity", "maxAgeHours"]);

function issue(code, path, message) {
  return { code, path, message };
}

function validDate(value) {
  if (!DATE_PATTERN.test(value ?? "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function checkSource(entry, path, registry, status, issues) {
  if (!entry || typeof entry !== "object") {
    issues.push(issue("EXPR_MISSING", path, "expected {expr, source}"));
    return;
  }
  if (typeof entry.expr !== "string" || entry.expr.trim() === "") {
    issues.push(issue("EXPR_MISSING", `${path}.expr`, "expr must be a non-empty string"));
  }
  const source = entry.source;
  const level = registry.all.has(source) ? registry.level.get(source) : null;
  if (!level) {
    issues.push(issue("SOURCE_UNKNOWN", `${path}.source`, `source "${source}" is not registered in sources.v1.json`));
    return;
  }
  if (status === "ACTIVE" && level !== "existing") {
    issues.push(
      issue("ACTIVE_SOURCE_NOT_EXISTING", `${path}.source`, `ACTIVE metrics may only use existing sources, "${source}" is ${level}`),
    );
  }
}

function validateChangelog(metric, issues, where) {
  const changelog = metric.changelog;
  if (!Array.isArray(changelog) || changelog.length === 0) {
    issues.push(issue("CHANGELOG_MISSING", `${where}.changelog`, "at least one changelog entry is required"));
    return;
  }
  const versions = [];
  changelog.forEach((entry, index) => {
    const path = `${where}.changelog[${index}]`;
    if (!Number.isInteger(entry?.version) || entry.version < 1) {
      issues.push(issue("CHANGELOG_VERSION_INVALID", `${path}.version`, "version must be a positive integer"));
      return;
    }
    versions.push(entry.version);
    if (!validDate(entry.at)) issues.push(issue("CHANGELOG_DATE_INVALID", `${path}.at`, "at must be a real YYYY-MM-DD"));
    if (typeof entry.breaking !== "boolean") {
      issues.push(issue("CHANGELOG_BREAKING_INVALID", `${path}.breaking`, "breaking must be boolean"));
    }
    if (typeof entry.note !== "string" || entry.note.trim() === "") {
      issues.push(issue("CHANGELOG_NOTE_MISSING", `${path}.note`, "note must be a non-empty string"));
    }
  });
  versions.forEach((value, index) => {
    if (value !== index + 1) {
      issues.push(issue("CHANGELOG_VERSION_GAP", `${where}.changelog`, `expected version ${index + 1}, got ${value}`));
    }
  });
  if (versions.length > 0 && versions[versions.length - 1] !== metric.version) {
    issues.push(
      issue("CHANGELOG_LATEST_MISMATCH", `${where}.changelog`, `latest changelog version ${versions[versions.length - 1]} != version ${metric.version}`),
    );
  }
}

/** Validate one metric definition. Returns issues. */
export function validateMetric(metric, { fileTier, registry }) {
  const issues = [];
  const where = `metric:${metric?.id ?? "?"}`;
  for (const field of Object.keys(metric ?? {})) {
    if (!METRIC_FIELDS.has(field)) {
      issues.push(issue("UNKNOWN_FIELD", `${where}.${field}`, `unknown field "${field}"`));
    }
  }
  if (metric?.schemaVersion !== "metric-definition/v1") {
    issues.push(issue("SCHEMA_VERSION", `${where}.schemaVersion`, "must be metric-definition/v1"));
  }
  if (!ID_PATTERN.test(metric?.id ?? "")) {
    issues.push(issue("ID_INVALID", `${where}.id`, `invalid id: ${metric?.id}`));
  } else {
    const prefix = metric.id.startsWith("G-") ? "GUARDRAIL" : metric.id.slice(0, 2);
    if (prefix !== metric.tier) {
      issues.push(issue("TIER_PREFIX_MISMATCH", `${where}.tier`, `id ${metric.id} implies tier ${prefix}, got ${metric.tier}`));
    }
  }
  if (fileTier && metric?.tier !== fileTier) {
    issues.push(issue("TIER_FILE_MISMATCH", `${where}.tier`, `file tier ${fileTier} != metric tier ${metric?.tier}`));
  }
  if (!TIERS.has(metric?.tier)) issues.push(issue("TIER_INVALID", `${where}.tier`, `unknown tier: ${metric?.tier}`));
  if (!NAME_PATTERN.test(metric?.name ?? "")) {
    issues.push(issue("NAME_INVALID", `${where}.name`, `name must be snake_case: ${metric?.name}`));
  }
  if (!UNITS.has(metric?.unit)) issues.push(issue("UNIT_INVALID", `${where}.unit`, `unknown unit: ${metric?.unit}`));
  if (!OWNERS.has(metric?.owner)) issues.push(issue("OWNER_INVALID", `${where}.owner`, `unknown owner: ${metric?.owner}`));
  if (!STATUSES.has(metric?.status)) issues.push(issue("STATUS_INVALID", `${where}.status`, `unknown status: ${metric?.status}`));
  if (!Number.isInteger(metric?.version) || metric.version < 1) {
    issues.push(issue("VERSION_INVALID", `${where}.version`, "version must be a positive integer"));
  }
  if (!validDate(metric?.effectiveFrom)) {
    issues.push(issue("EFFECTIVE_DATE_INVALID", `${where}.effectiveFrom`, "effectiveFrom must be a real YYYY-MM-DD"));
  }
  if (!new Set(["CHECKED", "PENDING"]).has(metric?.exprStatus)) {
    issues.push(
      issue("EXPR_STATUS_INVALID", `${where}.exprStatus`, "exprStatus must be CHECKED or PENDING (ch01 PR-01 acceptance)"),
    );
  }
  if (typeof metric?.definition !== "string" || metric.definition.trim().length < 10) {
    issues.push(issue("DEFINITION_MISSING", `${where}.definition`, "definition must be a non-trivial string"));
  }
  checkSource(metric?.numerator, `${where}.numerator`, registry, metric?.status, issues);
  if (metric?.unit === "ratio" || metric?.unit === "count_per_1000") {
    if (metric?.denominator === null || metric?.denominator === undefined) {
      issues.push(issue("DENOMINATOR_MISSING", `${where}.denominator`, `unit ${metric?.unit} requires a denominator`));
    } else {
      checkSource(metric.denominator, `${where}.denominator`, registry, metric?.status, issues);
    }
  } else if (metric?.denominator !== null && metric?.denominator !== undefined) {
    checkSource(metric.denominator, `${where}.denominator`, registry, metric?.status, issues);
  }
  if (!Array.isArray(metric?.exclusions)) {
    issues.push(issue("EXCLUSIONS_MISSING", `${where}.exclusions`, "exclusions must be an array"));
  } else if (metric.exclusions.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    issues.push(issue("EXCLUSION_INVALID", `${where}.exclusions`, "every exclusion must be a non-empty string"));
  }
  const window = metric?.window;
  if (!WINDOW_TYPES.has(window?.type)) {
    issues.push(issue("WINDOW_INVALID", `${where}.window.type`, `unknown window type: ${window?.type}`));
  } else if (window.type === "rolling" && !(Number.isInteger(window.days) && window.days > 0)) {
    issues.push(issue("WINDOW_INVALID", `${where}.window.days`, "rolling window requires days > 0"));
  } else if (window.type === "cohort" && !(Number.isInteger(window.days) && window.days > 0)) {
    issues.push(issue("WINDOW_INVALID", `${where}.window.days`, "cohort window requires days > 0"));
  } else if (window.type === "snapshot" && !CADENCES.has(window.cadence)) {
    issues.push(issue("WINDOW_INVALID", `${where}.window.cadence`, "snapshot window requires a cadence"));
  }
  if (!Array.isArray(metric?.strata) || metric.strata.length === 0) {
    issues.push(issue("STRATA_INVALID", `${where}.strata`, "strata must be a non-empty array"));
  } else {
    for (const stratum of metric.strata) {
      if (!STRATA.has(stratum)) issues.push(issue("STRATA_INVALID", `${where}.strata`, `unknown stratum: ${stratum}`));
    }
  }
  const method = metric?.ci?.method;
  if (!CI_METHODS.has(method)) {
    issues.push(issue("CI_INVALID", `${where}.ci.method`, `unknown ci method: ${method}`));
  } else if (metric.unit === "ratio" || metric.unit === "count_per_1000") {
    // Guardrail ratios like suppression_hit_rate are all-or-nothing checks, so
    // ci=none is allowed for GUARDRAIL tier only.
    if (method === "none" && metric.tier !== "GUARDRAIL") {
      issues.push(issue("CI_INVALID", `${where}.ci.method`, `${metric.unit} metrics need wilson or bootstrap`));
    }
  } else if (["index", "distribution", "status"].includes(metric.unit) && method !== "none") {
    issues.push(issue("CI_INVALID", `${where}.ci.method`, `${metric.unit} metrics must use ci=none`));
  }
  if (metric?.benchmark && metric.benchmark.url && !/^https:\/\//.test(metric.benchmark.url)) {
    issues.push(issue("BENCHMARK_URL_INVALID", `${where}.benchmark.url`, "benchmark url must be https://"));
  }
  validateChangelog(metric ?? {}, issues, where);
  return issues;
}

/** Validate a whole dictionary: wrapper files, cross-file uniqueness, registry. */
export function lintDictionary(files, { sources }) {
  const issues = [];
  const level = new Map();
  for (const [group, names] of Object.entries(sources.sources ?? {})) {
    for (const name of names) level.set(name, group);
  }
  const registry = { all: new Set(level.keys()), level };
  const seenIds = new Map();
  const seenNames = new Map();
  let total = 0;
  for (const { path, document } of files) {
    if (document?.schemaVersion !== "metric-dictionary/v1") {
      issues.push(issue("FILE_SCHEMA_VERSION", path, "dictionary files must declare metric-dictionary/v1"));
      continue;
    }
    if (!TIERS.has(document?.tier)) {
      issues.push(issue("FILE_TIER_INVALID", `${path}.tier`, `unknown file tier: ${document?.tier}`));
    }
    if (!Array.isArray(document?.metrics) || document.metrics.length === 0) {
      issues.push(issue("FILE_METRICS_EMPTY", `${path}.metrics`, "dictionary file must contain metrics"));
      continue;
    }
    for (const metric of document.metrics) {
      total += 1;
      issues.push(...validateMetric(metric, { fileTier: document.tier, registry }));
      if (seenIds.has(metric?.id)) {
        issues.push(issue("ID_DUPLICATE", `metric:${metric?.id}`, `also defined in ${seenIds.get(metric?.id)} and ${path}`));
      } else {
        seenIds.set(metric?.id, path);
      }
      if (seenNames.has(metric?.name)) {
        issues.push(issue("NAME_DUPLICATE", `metric:${metric?.name}`, `also defined in ${seenNames.get(metric?.name)} and ${path}`));
      } else {
        seenNames.set(metric?.name, path);
      }
    }
  }
  const summary = {
    files: files.length,
    metrics: total,
    byTier: {},
    byStatus: {},
    bySourceLevel: { existing: 0, planned: 0, saas: 0 },
  };
  for (const { document } of files) {
    for (const metric of document.metrics ?? []) {
      summary.byTier[metric.tier] = (summary.byTier[metric.tier] ?? 0) + 1;
      summary.byStatus[metric.status] = (summary.byStatus[metric.status] ?? 0) + 1;
      const sourceLevel = registry.level.get(metric.numerator?.source);
      if (sourceLevel) summary.bySourceLevel[sourceLevel] += 1;
    }
  }
  return { issues, summary };
}

/**
 * Validate the alert rules document (ch01 PR-05). `metricIds` is the set of
 * ids defined by the dictionary — a rule pointing at an undefined metric is
 * dead weight that would silently never fire.
 */
export function lintAlerts(document, { metricIds }) {
  const issues = [];
  if (document?.schemaVersion !== ALERT_SCHEMA) {
    issues.push(issue("ALERT_SCHEMA_VERSION", "alerts.schemaVersion", `must be ${ALERT_SCHEMA}`));
  }
  const rules = document?.rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    issues.push(issue("ALERT_RULES_MISSING", "alerts.rules", "rules must be a non-empty array"));
    return { issues, summary: { rules: 0, byKind: {}, bySeverity: {} } };
  }
  const seen = new Map();
  const summary = { rules: rules.length, byKind: {}, bySeverity: {} };
  rules.forEach((rule, index) => {
    const where = `alert:${rule?.id ?? `#${index}`}`;
    const kind = rule?.kind;
    if (!ALERT_ID_PATTERN.test(rule?.id ?? "")) {
      issues.push(issue("ALERT_ID_INVALID", `${where}.id`, `invalid id: ${rule?.id}`));
    } else if (seen.has(rule.id)) {
      issues.push(issue("ALERT_ID_DUPLICATE", where, `duplicate rule id ${rule.id}`));
    } else {
      seen.set(rule.id, index);
    }
    if (!metricIds.has(rule?.metricId)) {
      issues.push(issue("ALERT_METRIC_UNKNOWN", `${where}.metricId`, `metric "${rule?.metricId}" is not defined in the dictionary`));
    }
    if (!ALERT_SEVERITIES.has(rule?.severity)) {
      issues.push(issue("ALERT_SEVERITY_INVALID", `${where}.severity`, `unknown severity: ${rule?.severity}`));
    } else {
      summary.bySeverity[rule.severity] = (summary.bySeverity[rule.severity] ?? 0) + 1;
    }
    if (!OWNERS.has(rule?.owner)) {
      issues.push(issue("ALERT_OWNER_INVALID", `${where}.owner`, `unknown owner: ${rule?.owner}`));
    }
    if (typeof rule?.description !== "string" || rule.description.trim().length < 10) {
      issues.push(issue("ALERT_DESCRIPTION_MISSING", `${where}.description`, "description must be a non-trivial string"));
    }
    let allowed;
    if (kind === "threshold") {
      allowed = ALERT_THRESHOLD_FIELDS;
    } else if (kind === "freshness") {
      allowed = ALERT_FRESHNESS_FIELDS;
    } else {
      issues.push(issue("ALERT_KIND_INVALID", `${where}.kind`, `kind must be threshold or freshness: ${kind}`));
      allowed = new Set([...ALERT_THRESHOLD_FIELDS, ...ALERT_FRESHNESS_FIELDS]);
    }
    summary.byKind[kind] = (summary.byKind[kind] ?? 0) + 1;
    for (const field of Object.keys(rule ?? {})) {
      if (!allowed.has(field)) {
        issues.push(issue("ALERT_UNKNOWN_FIELD", `${where}.${field}`, `field "${field}" is not allowed for kind ${kind}`));
      }
    }
    if (kind === "threshold") {
      if (rule.comparison !== "below" && rule.comparison !== "above") {
        issues.push(issue("ALERT_COMPARISON_INVALID", `${where}.comparison`, "comparison must be below or above"));
      }
      if (typeof rule.bound !== "number" || !Number.isFinite(rule.bound)) {
        issues.push(issue("ALERT_BOUND_INVALID", `${where}.bound`, "bound must be a finite number"));
      }
      if (!ALERT_GRANULARITIES.has(rule.granularity)) {
        issues.push(issue("ALERT_GRANULARITY_INVALID", `${where}.granularity`, "granularity must be daily or weekly"));
      }
      if (rule.aggregation !== undefined && !ALERT_AGGREGATIONS.has(rule.aggregation)) {
        issues.push(issue("ALERT_AGGREGATION_INVALID", `${where}.aggregation`, "aggregation must be latest or mean"));
      }
      if (rule.aggregation === "mean" && rule.lookbackBuckets === undefined) {
        issues.push(issue("ALERT_LOOKBACK_INVALID", `${where}.lookbackBuckets`, "mean aggregation requires lookbackBuckets"));
      }
      if (
        rule.lookbackBuckets !== undefined &&
        (!Number.isInteger(rule.lookbackBuckets) || rule.lookbackBuckets < 1 || rule.lookbackBuckets > 90)
      ) {
        issues.push(issue("ALERT_LOOKBACK_INVALID", `${where}.lookbackBuckets`, "lookbackBuckets must be an integer in [1, 90]"));
      }
      if (rule.minSample !== undefined && (!Number.isInteger(rule.minSample) || rule.minSample < 1)) {
        issues.push(issue("ALERT_MINSAMPLE_INVALID", `${where}.minSample`, "minSample must be a positive integer"));
      }
      if (
        !rule.stratumEquals ||
        typeof rule.stratumEquals !== "object" ||
        Array.isArray(rule.stratumEquals) ||
        Object.keys(rule.stratumEquals).length === 0 ||
        Object.values(rule.stratumEquals).some((value) => typeof value !== "string")
      ) {
        issues.push(
          issue("ALERT_STRATUM_INVALID", `${where}.stratumEquals`, "threshold rules need a non-empty stratumEquals object of strings"),
        );
      }
    } else if (kind === "freshness") {
      if (rule.source !== "observation" && rule.source !== "rollup") {
        issues.push(issue("ALERT_SOURCE_INVALID", `${where}.source`, "source must be observation or rollup"));
      }
      if (rule.source === "rollup" && !ALERT_GRANULARITIES.has(rule.granularity)) {
        issues.push(issue("ALERT_GRANULARITY_INVALID", `${where}.granularity`, "rollup freshness rules require granularity daily or weekly"));
      }
      if (rule.source === "observation" && rule.granularity !== undefined) {
        issues.push(issue("ALERT_UNKNOWN_FIELD", `${where}.granularity`, "granularity is only meaningful for rollup freshness rules"));
      }
      if (!Number.isInteger(rule.maxAgeHours) || rule.maxAgeHours < 1 || rule.maxAgeHours > 8760) {
        issues.push(issue("ALERT_MAXAGE_INVALID", `${where}.maxAgeHours`, "maxAgeHours must be an integer in [1, 8760]"));
      }
    } else if (rule.granularity !== undefined && !ALERT_GRANULARITIES.has(rule.granularity)) {
      issues.push(issue("ALERT_GRANULARITY_INVALID", `${where}.granularity`, "granularity must be daily or weekly"));
    }
  });
  return { issues, summary };
}

export function loadAlertRulesFile(path = DEFAULT_ALERTS) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadDictionaryDirectory(dir = DEFAULT_DIR, sourcesPath = DEFAULT_SOURCES) {
  const sources = JSON.parse(readFileSync(sourcesPath, "utf8"));
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ path: join(dir, name), document: JSON.parse(readFileSync(join(dir, name), "utf8")) }));
  return { sources, files };
}

function renderMarkdown({ issues, summary }) {
  const out = [];
  out.push("# metrics:lint");
  out.push("");
  out.push("| 指标 | 值 |");
  out.push("| --- | --- |");
  out.push(`| 字典文件 | ${summary.files} |`);
  out.push(`| 指标总数 | ${summary.metrics} |`);
  out.push(
    `| 按 tier | ${Object.entries(summary.byTier)
      .map(([tier, count]) => `${tier} ${count}`)
      .join(" / ")} |`,
  );
  out.push(
    `| 按状态 | ${Object.entries(summary.byStatus)
      .map(([status, count]) => `${status} ${count}`)
      .join(" / ")} |`,
  );
  out.push(
    `| 分子来源级别 | existing ${summary.bySourceLevel.existing} / planned ${summary.bySourceLevel.planned} / saas ${summary.bySourceLevel.saas} |`,
  );
  if (summary.alerts) {
    out.push(`| 告警规则 | ${summary.alerts.rules}（${Object.entries(summary.alerts.bySeverity ?? {}).map(([severity, count]) => `${severity} ${count}`).join(" / ") || "—"}） |`);
  }
  out.push("");
  if (issues.length === 0) {
    out.push("校验通过：0 个问题。");
  } else {
    out.push(`校验失败：${issues.length} 个问题`);
    out.push("");
    out.push("| 代码 | 路径 | 说明 |");
    out.push("| --- | --- | --- |");
    for (const item of issues) out.push(`| ${item.code} | ${item.path} | ${item.message} |`);
  }
  return out.join("\n");
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log("usage: node scripts/metrics/metrics-lint.mjs [--json] [--dir <dictionary-dir>] [--alerts <rules-file>]");
    return;
  }
  const { sources, files } = loadDictionaryDirectory(flags.dir ?? DEFAULT_DIR, flags.sources ?? DEFAULT_SOURCES);
  const result = lintDictionary(files, { sources });
  const metricIds = new Set(files.flatMap((file) => (file.document.metrics ?? []).map((metric) => metric.id)));
  try {
    const alertResult = lintAlerts(loadAlertRulesFile(flags.alerts ?? DEFAULT_ALERTS), { metricIds });
    result.issues.push(...alertResult.issues);
    result.summary.alerts = alertResult.summary;
  } catch (error) {
    result.issues.push(
      issue("ALERTS_UNREADABLE", "alerts", `cannot load rules file: ${error instanceof Error ? error.message : error}`),
    );
    result.summary.alerts = { rules: 0, byKind: {}, bySeverity: {} };
  }
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderMarkdown(result));
  }
  if (result.issues.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
