#!/usr/bin/env node
// golden-run — replay-mode golden-set runner for discovery (ch01 PR-07,
// script side). Zero model calls: it compares a frozen prediction snapshot
// against adjudicated human labels and enforces the gates.
//
//   node scripts/metrics/golden-run.mjs --set evals/golden-discovery/fixtures/replay-demo
//   node scripts/metrics/golden-run.mjs --set <dir> --baseline previous-run.json --out run.json
//
// Set layout (all JSON):
//   manifest.json                 optional {goldenSet, version}
//   items/<id>.json               golden-item/v1
//   labels/<id>.labels.json       golden-label/v1 with adjudicated=true
//   predictions/<id>.json         {itemId, labels:{field:value,...}} — pipeline snapshot
//
// Gates (ch01 §3.2.7):
//   G1 absolute  fit precision >= 0.80 / recall >= 0.75 (in_icp)
//   G3 fields    domain_correct >= 0.95, is_company >= 0.95, email valid precision >= 0.95
//   G2 relative  any evaluated metric dropping > 2pp vs the --baseline run fails
// A gate whose field is absent from the set is recorded as skipped, not failed.
// The demo fixture also serves as a mutation test: break one prediction and G1
// must turn red (covered by the unit test suite).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parseArgs, utcStamp } from "./lib/psql.mjs";

const ITEM_ID = /^(acct|contact)-[0-9]{4}$/;

// Closed vocabulary of label fields (unknown fields are rejected).
export const LABEL_FIELDS = new Set([
  "is_company",
  "in_icp",
  "country",
  "industry",
  "employee_band",
  "domain_correct",
  "is_competitor",
  "person_exists",
  "is_decision_maker",
  "email_status_truth",
  "email_is_personal",
  "phone_status_truth",
  "source_correct",
  "lawful_basis_ok",
]);

const POSITIVE = {
  is_company: "yes",
  in_icp: "match",
  domain_correct: "yes",
  is_competitor: "yes",
  person_exists: "yes",
  is_decision_maker: "yes",
  email_status_truth: "valid",
  phone_status_truth: "valid",
  source_correct: "yes",
  lawful_basis_ok: "yes",
};

const GATES = [
  { name: "G1_fit_precision", field: "in_icp", metric: "precision", min: 0.8 },
  { name: "G1_fit_recall", field: "in_icp", metric: "recall", min: 0.75 },
  { name: "G3_domain_correct", field: "domain_correct", metric: "accuracy", min: 0.95 },
  { name: "G3_is_company", field: "is_company", metric: "accuracy", min: 0.95 },
  { name: "G3_email_valid_precision", field: "email_status_truth", metric: "precision", min: 0.95 },
];

const RELATIVE_TOLERANCE = 0.02;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function listJson(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

/** Load a golden set directory into {items, labels, predictions} keyed by id. */
export function loadSet(setDir) {
  const manifest = (() => {
    try {
      return readJson(join(setDir, "manifest.json"));
    } catch {
      return {};
    }
  })();
  const items = new Map();
  for (const name of listJson(join(setDir, "items"))) {
    const item = readJson(join(setDir, "items", name));
    if (item.schemaVersion !== "golden-item/v1") throw new Error(`ITEM_SCHEMA ${name}: not golden-item/v1`);
    if (!ITEM_ID.test(item.id ?? "")) throw new Error(`ITEM_ID ${name}: invalid id ${item.id}`);
    items.set(item.id, item);
  }
  const labels = new Map();
  for (const name of listJson(join(setDir, "labels"))) {
    const label = readJson(join(setDir, "labels", name));
    if (label.schemaVersion !== "golden-label/v1") throw new Error(`LABEL_SCHEMA ${name}: not golden-label/v1`);
    if (label.adjudicated !== true) throw new Error(`ADJUDICATION_REQUIRED ${name}: evaluation needs adjudicated labels`);
    const value = label.adjudicatedValue ?? label.labels;
    for (const field of Object.keys(value ?? {})) {
      if (!LABEL_FIELDS.has(field)) throw new Error(`UNKNOWN_LABEL_FIELD ${name}: ${field}`);
    }
    labels.set(label.itemId, value);
  }
  const predictions = new Map();
  for (const name of listJson(join(setDir, "predictions"))) {
    const prediction = readJson(join(setDir, "predictions", name));
    predictions.set(prediction.itemId, prediction.labels ?? {});
  }
  return { manifest, items, labels, predictions };
}

/** Cohen's kappa for a confusion matrix built from paired labels. */
export function cohenKappa(pairs) {
  if (pairs.length === 0) return null;
  const categories = [...new Set(pairs.flat())];
  if (categories.length < 2) return null;
  const counts = new Map();
  const left = new Map();
  const right = new Map();
  for (const [a, b] of pairs) {
    counts.set(`${a}::${b}`, (counts.get(`${a}::${b}`) ?? 0) + 1);
    left.set(a, (left.get(a) ?? 0) + 1);
    right.set(b, (right.get(b) ?? 0) + 1);
  }
  const n = pairs.length;
  let observed = 0;
  for (const value of counts.values()) observed += value;
  if (observed !== n) return null;
  let agreement = 0;
  for (const [a, b] of pairs) if (a === b) agreement += 1;
  const po = agreement / n;
  let pe = 0;
  for (const category of categories) {
    pe += ((left.get(category) ?? 0) / n) * ((right.get(category) ?? 0) / n);
  }
  if (pe >= 1) return 0;
  return (po - pe) / (1 - pe);
}

/** Per-field metrics from adjudicated labels vs predictions. */
export function evaluateFields({ items, labels, predictions }) {
  const fieldPairs = new Map();
  for (const itemId of [...labels.keys()].sort()) {
    const truth = labels.get(itemId) ?? {};
    const prediction = predictions.get(itemId) ?? {};
    for (const field of Object.keys(truth)) {
      const pairs = fieldPairs.get(field) ?? [];
      pairs.push([truth[field], prediction[field] ?? "MISSING"]);
      fieldPairs.set(field, pairs);
    }
  }
  const metrics = {};
  for (const [field, pairs] of [...fieldPairs.entries()].sort()) {
    const total = pairs.length;
    const correct = pairs.filter(([truth, predicted]) => truth === predicted).length;
    const positive = POSITIVE[field];
    let precision = null;
    let recall = null;
    if (positive) {
      const tp = pairs.filter(([truth, predicted]) => truth === positive && predicted === positive).length;
      const fp = pairs.filter(([truth, predicted]) => truth !== positive && predicted === positive).length;
      const fn = pairs.filter(([truth, predicted]) => truth === positive && predicted !== positive).length;
      precision = tp + fp > 0 ? tp / (tp + fp) : null;
      recall = tp + fn > 0 ? tp / (tp + fn) : null;
    }
    metrics[field] = {
      total,
      correct,
      accuracy: total > 0 ? correct / total : null,
      precision,
      recall,
      kappa: cohenKappa(pairs),
      confusion: buildConfusion(pairs),
    };
  }
  return metrics;
}

function buildConfusion(pairs) {
  const confusion = {};
  for (const [truth, predicted] of pairs) {
    confusion[truth] = confusion[truth] ?? {};
    confusion[truth][predicted] = (confusion[truth][predicted] ?? 0) + 1;
  }
  return confusion;
}

/** Apply absolute (G1/G3) and relative (G2) gates. */
export function applyGates({ metrics, baselineMetrics = null }) {
  const gates = [];
  for (const gate of GATES) {
    const field = metrics[gate.field];
    if (!field) {
      gates.push({ name: gate.name, ok: true, skipped: true, detail: `field ${gate.field} absent in set` });
      continue;
    }
    const value = field[gate.metric];
    if (value === null) {
      gates.push({ name: gate.name, ok: true, skipped: true, detail: `no positive samples for ${gate.metric}` });
      continue;
    }
    const ok = value >= gate.min;
    gates.push({
      name: gate.name,
      ok,
      skipped: false,
      detail: `${gate.field} ${gate.metric} = ${value.toFixed(3)} (min ${gate.min})`,
    });
  }
  if (baselineMetrics) {
    for (const [field, current] of Object.entries(metrics)) {
      const previous = baselineMetrics[field];
      if (!previous) continue;
      for (const metric of ["precision", "recall", "accuracy"]) {
        const before = previous[metric];
        const after = current[metric];
        if (before === null || before === undefined || after === null || after === undefined) continue;
        if (before - after > RELATIVE_TOLERANCE) {
          gates.push({
            name: `G2_${field}_${metric}`,
            ok: false,
            skipped: false,
            detail: `${field} ${metric} dropped ${(before * 100).toFixed(1)}% -> ${(after * 100).toFixed(1)}% (>2pp)`,
          });
        }
      }
    }
  }
  return gates;
}

/** Per-item field values for diffing against a baseline run. */
export function snapshotItems({ labels, predictions }) {
  return [...labels.keys()].sort().map((itemId) => {
    const truth = labels.get(itemId) ?? {};
    const prediction = predictions.get(itemId) ?? {};
    const fields = {};
    for (const field of Object.keys(truth)) fields[field] = prediction[field] ?? "MISSING";
    return { id: itemId, fields };
  });
}

/** Field-level diff between two item snapshots. */
export function diffAgainstBaseline(currentItems, baselineItems) {
  const baselineById = new Map((baselineItems ?? []).map((item) => [item.id, item]));
  const changes = [];
  for (const item of currentItems) {
    const previous = baselineById.get(item.id);
    if (!previous) continue;
    for (const [field, value] of Object.entries(item.fields)) {
      const before = previous.fields?.[field];
      if (before !== undefined && before !== value) {
        changes.push({ id: item.id, field, from: before, to: value });
      }
    }
  }
  return changes;
}

export function sampleHash({ items, labels, predictions }) {
  const payload = [...labels.keys()].sort().map((itemId) => ({
    id: itemId,
    labels: labels.get(itemId) ?? {},
    prediction: predictions.get(itemId) ?? {},
  }));
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Run the full replay evaluation. */
export function runGoldenSet(setDir, { baseline = null, asOf = null } = {}) {
  const set = loadSet(setDir);
  if (set.labels.size === 0) throw new Error(`EMPTY_SET ${setDir}: no adjudicated labels`);
  const metrics = evaluateFields(set);
  const gates = applyGates({ metrics, baselineMetrics: baseline?.metrics ?? null });
  const items = snapshotItems(set);
  const diff = baseline ? diffAgainstBaseline(items, baseline.items) : [];
  return {
    schemaVersion: "golden-run/v1",
    kind: "evaluation",
    goldenSet: set.manifest.goldenSet ?? "golden-discovery/unknown",
    version: set.manifest.version ?? 1,
    asOf: asOf ?? utcStamp(),
    sampleN: set.labels.size,
    sampleSha256: sampleHash(set),
    metrics,
    gates,
    passed: gates.every((gate) => gate.ok),
    diff,
    items,
  };
}

function renderMarkdown(run) {
  const out = [];
  out.push(`# Golden run · ${run.goldenSet} v${run.version}`);
  out.push("");
  out.push(
    `> 样本 ${run.sampleN}；sampleSha256 \`${run.sampleSha256}\`；asOf ${run.asOf}；结论：${run.passed ? "PASS" : "FAIL"}`,
  );
  out.push("");
  out.push("## 字段指标");
  out.push("");
  out.push("| 字段 | n | accuracy | precision | recall | κ |");
  out.push("| --- | --- | --- | --- | --- | --- |");
  for (const [field, value] of Object.entries(run.metrics)) {
    const format = (number) => (number === null ? "—" : number.toFixed(3));
    out.push(
      `| ${field} | ${value.total} | ${format(value.accuracy)} | ${format(value.precision)} | ${format(value.recall)} | ${format(value.kappa)} |`,
    );
  }
  out.push("");
  out.push("## 门");
  out.push("");
  out.push("| 门 | 结果 | 说明 |");
  out.push("| --- | --- | --- |");
  for (const gate of run.gates) {
    out.push(`| ${gate.name} | ${gate.skipped ? "SKIP" : gate.ok ? "PASS" : "FAIL"} | ${gate.detail} |`);
  }
  out.push("");
  if (run.diff.length > 0) {
    out.push("## 与 baseline 的字段差异");
    out.push("");
    out.push("| 条目 | 字段 | baseline | 本次 |");
    out.push("| --- | --- | --- | --- |");
    for (const change of run.diff) {
      out.push(`| ${change.id} | ${change.field} | ${change.from} | ${change.to} |`);
    }
    out.push("");
  }
  out.push("## 说明");
  out.push("");
  out.push("replay 模式零模型调用：预测来自冻结快照；label 必须 adjudicated=true；未登记标签字段直接拒绝。");
  return out.join("\n");
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || !flags.set) {
    console.error(
      "usage: node scripts/metrics/golden-run.mjs --set <dir> [--baseline <run.json>] [--out <run.json>] [--json] [--as-of <iso>]",
    );
    process.exit(flags.help ? 0 : 2);
  }
  const baseline = flags.baseline ? readJson(flags.baseline) : null;
  const run = runGoldenSet(flags.set, { baseline, asOf: flags["as-of"] });
  if (flags.out) writeFileSync(flags.out, `${JSON.stringify(run, null, 2)}\n`);
  console.log(flags.json ? JSON.stringify(run, null, 2) : renderMarkdown(run));
  if (!run.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
