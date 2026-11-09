#!/usr/bin/env node
// annotation-import — validate filled annotation worksheets and run the κ pre-check
// (ch01 PR-08 tooling; the adjudication itself stays human).
//
//   node scripts/metrics/annotation-import.mjs \
//     --dataset accounts --a accounts.annotator-a.csv --b accounts.annotator-b.csv \
//     [--report check.json] [--adjudication adjudication.csv] [--json]
//
// Checks: sheet structure (required columns, unique refs, no unknown columns),
// closed vocabularies per rubric-v1.md, paired-item completeness between the two
// annotators, then per-field raw agreement and Cohen's κ with the rubric's
// κ ≥ 0.6 publication gate. Freeform fields (evidence_url/notes) are never scored.
//
// Exit codes: 0 pre-check passed; 1 structural problems (must fix the sheets);
// 2 quality gate failed (κ < threshold or fewer than --min-double-annotated
// paired items). Disagreements are listed for the human adjudication queue.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { parseCsv } from "./capture-recapture.mjs";
import { parseArgs } from "./lib/psql.mjs";
import { cohenKappa } from "./golden-run.mjs";
import { ANNOTATION_DATASETS, toCsv } from "./annotation-worksheet.mjs";

const DEFAULT_MIN_KAPPA = 0.6;
const DEFAULT_MIN_DOUBLE_ANNOTATED = 100;

function fail(message) {
  throw new Error(message);
}

/** Parse one worksheet CSV; returns {annotator, rows, issues, missingColumns}. */
export function parseWorksheet({ annotator, text, dataset }) {
  const config = ANNOTATION_DATASETS[dataset];
  if (!config) fail(`unknown dataset "${dataset}"`);
  const fieldKeys = config.fields.map((field) => field.key);
  const issues = [];
  const { headers, records } = parseCsv(text);
  for (const column of ["ref", ...fieldKeys]) {
    if (!headers.includes(column)) {
      issues.push({ code: "COLUMN_MISSING", annotator, message: `worksheet is missing column "${column}"` });
    }
  }
  const allowed = new Set(["ref", "layer", "stratum", ...fieldKeys]);
  for (const header of headers) {
    if (!allowed.has(header)) {
      issues.push({ code: "COLUMN_UNKNOWN", annotator, message: `worksheet has unknown column "${header}"` });
    }
  }
  const rows = new Map();
  records.forEach((record, index) => {
    const ref = String(record.ref ?? "").trim();
    if (!ref) {
      issues.push({ code: "REF_EMPTY", annotator, message: `line ${index + 2}: empty ref` });
      return;
    }
    if (rows.has(ref)) {
      issues.push({ code: "REF_DUPLICATE", annotator, message: `line ${index + 2}: duplicate ref ${ref}` });
      return;
    }
    const values = {};
    for (const key of fieldKeys) values[key] = String(record[key] ?? "").trim();
    rows.set(ref, { ref, layer: String(record.layer ?? "").trim(), stratum: String(record.stratum ?? "").trim(), values });
  });
  return { annotator, rows, issues, fieldKeys };
}

function normalizeFieldValue(config, key, value) {
  if (value === "") return { state: "missing" };
  const field = config.fields.find((entry) => entry.key === key);
  if (field.values) {
    return field.values.includes(value) ? { state: "ok", value } : { state: "invalid", allowed: field.values };
  }
  if (field.pattern) {
    return field.pattern.test(value) ? { state: "ok", value } : { state: "invalid", allowed: String(field.pattern) };
  }
  return { state: "freeform", value };
}

/**
 * Check two filled worksheets against the rubric's vocabularies and the κ gate.
 * `sheets` is exactly two {annotator, text} entries (A/B independent passes).
 */
export function checkAnnotations({
  dataset,
  sheets,
  minKappa = DEFAULT_MIN_KAPPA,
  minDoubleAnnotated = DEFAULT_MIN_DOUBLE_ANNOTATED,
}) {
  const config = ANNOTATION_DATASETS[dataset];
  if (!config) fail(`unknown dataset "${dataset}"`);
  if (!Array.isArray(sheets) || sheets.length !== 2) fail("exactly two annotator sheets are required (double annotation)");
  if (sheets[0].annotator === sheets[1].annotator) fail("the two sheets must come from different annotators");
  if (!Number.isFinite(minKappa)) fail("--min-kappa must be a number");
  const issues = [];
  const parsed = sheets.map((sheet) => parseWorksheet({ annotator: sheet.annotator, text: sheet.text, dataset }));
  for (const sheet of parsed) issues.push(...sheet.issues);
  const [left, right] = parsed;
  const fieldKeys = left.fieldKeys;
  const vocabularyKeys = config.fields.filter((field) => field.values || field.pattern).map((field) => field.key);
  const freeformKeys = fieldKeys.filter((key) => !vocabularyKeys.includes(key));

  // Vocabulary violations are structural: a typo would silently distort κ.
  for (const sheet of parsed) {
    for (const row of sheet.rows.values()) {
      for (const key of vocabularyKeys) {
        const normalized = normalizeFieldValue(config, key, row.values[key]);
        if (normalized.state === "invalid") {
          issues.push({
            code: "VALUE_INVALID",
            annotator: sheet.annotator,
            ref: row.ref,
            field: key,
            message: `invalid value "${row.values[key]}" (allowed: ${normalized.allowed})`,
          });
        }
      }
    }
  }

  const allRefs = new Set([...left.rows.keys(), ...right.rows.keys()]);
  const missingLeft = [...allRefs].filter((ref) => !left.rows.has(ref)).sort();
  const missingRight = [...allRefs].filter((ref) => !right.rows.has(ref)).sort();
  for (const ref of missingRight) {
    issues.push({ code: "REF_UNPAIRED", annotator: left.annotator, ref, message: `ref ${ref} missing from annotator ${right.annotator}` });
  }
  for (const ref of missingLeft) {
    issues.push({ code: "REF_UNPAIRED", annotator: right.annotator, ref, message: `ref ${ref} missing from annotator ${left.annotator}` });
  }
  const pairedRefs = [...allRefs].filter((ref) => left.rows.has(ref) && right.rows.has(ref)).sort();

  const missingCells = new Map(vocabularyKeys.map((key) => [key, 0]));
  const fields = {};
  const adjudication = [];
  for (const key of vocabularyKeys) {
    const pairs = [];
    for (const ref of pairedRefs) {
      const a = normalizeFieldValue(config, key, left.rows.get(ref).values[key]);
      const b = normalizeFieldValue(config, key, right.rows.get(ref).values[key]);
      if (a.state === "missing") missingCells.set(key, missingCells.get(key) + 1);
      if (b.state === "missing") missingCells.set(key, missingCells.get(key) + 1);
      if (a.state !== "ok" || b.state !== "ok") continue;
      pairs.push([a.value, b.value]);
      if (a.value !== b.value) {
        adjudication.push({
          ref,
          layer: left.rows.get(ref).layer || right.rows.get(ref).layer,
          stratum: left.rows.get(ref).stratum || right.rows.get(ref).stratum,
          field: key,
          [left.annotator]: a.value,
          [right.annotator]: b.value,
        });
      }
    }
    const kappa = cohenKappa(pairs);
    const agreement = pairs.length === 0 ? null : pairs.filter(([a, b]) => a === b).length / pairs.length;
    fields[key] = {
      pairs: pairs.length,
      agreement,
      kappa,
      // κ is undefined for single-category pairs (everyone said the same thing).
      pass: kappa === null ? pairs.length > 0 : kappa >= minKappa,
      missing: missingCells.get(key),
    };
  }

  const qualityFailures = [];
  if (pairedRefs.length < minDoubleAnnotated) {
    qualityFailures.push(
      `only ${pairedRefs.length} paired items, rubric requires at least ${minDoubleAnnotated} double-annotated items before publishing a field`,
    );
  }
  for (const [key, value] of Object.entries(fields)) {
    if (value.pairs === 0) {
      qualityFailures.push(`${key}: no paired values (every pair is missing or invalid)`);
    } else if (value.kappa !== null && value.kappa < minKappa) {
      qualityFailures.push(`${key}: κ ${value.kappa.toFixed(3)} < ${minKappa}`);
    }
  }
  const passed = issues.length === 0 && qualityFailures.length === 0;
  return {
    schemaVersion: "golden-annotation-check/v1",
    dataset,
    annotators: [left.annotator, right.annotator],
    minKappa,
    minDoubleAnnotated,
    items: {
      [left.annotator]: left.rows.size,
      [right.annotator]: right.rows.size,
      paired: pairedRefs.length,
      unpaired: missingLeft.length + missingRight.length,
    },
    fields,
    freeformFields: freeformKeys,
    adjudication: { count: adjudication.length, items: adjudication },
    issues,
    qualityFailures,
    passed,
    exitCode: issues.length > 0 ? 1 : qualityFailures.length > 0 ? 2 : 0,
  };
}

function formatNumber(value, digits = 3) {
  return value === null || value === undefined ? "—" : Number(value).toFixed(digits);
}

export function renderReport(report) {
  const out = [];
  out.push(`# annotation-import pre-check (${report.dataset})`);
  out.push("");
  out.push(`- annotators: ${report.annotators.join(" / ")}`);
  out.push(`- paired items: ${report.items.paired}（要求 ≥ ${report.minDoubleAnnotated}）; unpaired: ${report.items.unpaired}`);
  out.push(`- disagreements: ${report.adjudication.count}`);
  out.push("");
  out.push("| 字段 | pairs | agreement | κ | κ≥" + report.minKappa + " | missing |");
  out.push("| --- | --- | --- | --- | --- | --- |");
  for (const [key, value] of Object.entries(report.fields)) {
    out.push(
      `| ${key} | ${value.pairs} | ${formatNumber(value.agreement)} | ${formatNumber(value.kappa)} | ${value.pass ? "PASS" : "FAIL"} | ${value.missing} |`,
    );
  }
  out.push("");
  if (report.issues.length === 0 && report.qualityFailures.length === 0) {
    out.push("预检通过：结构 0 问题，逐字段 κ 达标。分歧进裁决后按 golden-label/v1 落盘。");
  } else {
    if (report.issues.length > 0) {
      out.push(`结构问题 ${report.issues.length} 个（必须先修表）：`);
      for (const item of report.issues.slice(0, 20)) {
        out.push(`- [${item.code}] ${item.annotator}${item.ref ? ` ${item.ref}` : ""}${item.field ? `.${item.field}` : ""}: ${item.message}`);
      }
      if (report.issues.length > 20) out.push(`- … 另 ${report.issues.length - 20} 条`);
    }
    if (report.qualityFailures.length > 0) {
      out.push(`质量门失败 ${report.qualityFailures.length} 条：`);
      for (const failure of report.qualityFailures) out.push(`- ${failure}`);
    }
  }
  return out.join("\n");
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(
      "usage: node scripts/metrics/annotation-import.mjs --dataset <accounts|contacts> --a <csv> --b <csv> [--annotator-a a] [--annotator-b b] [--min-kappa 0.6] [--min-double-annotated 100] [--report <json>] [--adjudication <csv>] [--json]",
    );
    return;
  }
  const dataset = argumentValue("--dataset");
  const aPath = argumentValue("--a");
  const bPath = argumentValue("--b");
  if (!dataset || !aPath || !bPath) fail("--dataset, --a and --b are required (--help for usage)");
  const report = checkAnnotations({
    dataset,
    sheets: [
      { annotator: argumentValue("--annotator-a") ?? "a", text: readFileSync(aPath, "utf8") },
      { annotator: argumentValue("--annotator-b") ?? "b", text: readFileSync(bPath, "utf8") },
    ],
    minKappa: argumentValue("--min-kappa") ? Number(argumentValue("--min-kappa")) : DEFAULT_MIN_KAPPA,
    minDoubleAnnotated: argumentValue("--min-double-annotated")
      ? Number(argumentValue("--min-double-annotated"))
      : DEFAULT_MIN_DOUBLE_ANNOTATED,
  });
  const reportPath = argumentValue("--report");
  if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const adjudicationPath = argumentValue("--adjudication");
  if (adjudicationPath) {
    const headers = ["ref", "layer", "stratum", "field", report.annotators[0], report.annotators[1]];
    writeFileSync(adjudicationPath, toCsv(headers, report.adjudication.items));
  }
  console.log(flags.json ? JSON.stringify(report, null, 2) : renderReport(report));
  process.exitCode = report.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
