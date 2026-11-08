#!/usr/bin/env node
// golden-sampling — deterministic stratified sampler for the golden set (ch01 §3.2 / PR-07/08).
//
//   node scripts/metrics/golden-sampling.mjs \
//     --manifest evals/golden-discovery/v1/manifest.template.json \
//     --dataset accounts --pool pool.csv --out sampled.csv [--report report.json] [--json]
//
// Pool CSV contract (header required): ref,layer,stratum
//   ref      entity reference exported from the database — company id or the
//            contact's blind dedupe_key (HMAC). Never a plaintext email/phone.
//   layer    anchor | rolling | challenge
//   stratum  pre-composed stratum key (country|industry|employee_band|source_class
//            or the dataset's own composition); the SQL export templates compose it.
//
// Sampling per layer: proportional allocation across strata (largest remainder),
// minimum 5 per stratum where the pool can supply it, deterministic Fisher–Yates
// with a seed from the manifest. Underfilled strata are reported, never silently
// backfilled from other strata. Output keeps (ref, layer, stratum) and a SHA-256
// over the sorted refs so anyone can reproduce and verify the same sample.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createRng, sampleWithoutReplacement } from "./lib/prng.mjs";
import { parseArgs } from "./lib/psql.mjs";
import { parseCsv } from "./capture-recapture.mjs";

const LAYERS = ["anchor", "rolling", "challenge"];

export function parsePoolCsv(text) {
  const { headers, records } = parseCsv(text);
  for (const column of ["ref", "layer", "stratum"]) {
    if (!headers.includes(column)) {
      throw new Error(`pool CSV is missing column "${column}" (got: ${headers.join(", ") || "empty"})`);
    }
  }
  const rows = [];
  let skipped = 0;
  records.forEach((record, index) => {
    const ref = String(record.ref ?? "").trim();
    const layer = String(record.layer ?? "").trim().toLowerCase();
    const stratum = String(record.stratum ?? "").trim();
    if (!ref || !LAYERS.includes(layer) || !stratum) {
      skipped += 1;
      return;
    }
    rows.push({ ref, layer, stratum, line: index + 2 });
  });
  return { rows, skipped };
}

/** Validate the manifest's dataset block and quota sums. */
export function validateDatasetConfig(manifest, datasetKey) {
  const issues = [];
  const dataset = (manifest?.datasets ?? []).find((entry) => entry.key === datasetKey);
  if (!dataset) {
    return { dataset: null, issues: [{ code: "DATASET_MISSING", message: `no dataset "${datasetKey}" in manifest` }] };
  }
  const quota = dataset.quota ?? {};
  for (const layer of LAYERS) {
    if (!Number.isInteger(quota[layer]) || quota[layer] < 0) {
      issues.push({ code: "QUOTA_INVALID", message: `${datasetKey}.quota.${layer} must be a non-negative integer` });
    }
  }
  const sum = LAYERS.reduce((total, layer) => total + (quota[layer] ?? 0), 0);
  if (dataset.totalQuota !== undefined && sum !== dataset.totalQuota) {
    issues.push({
      code: "QUOTA_SUM_MISMATCH",
      message: `${datasetKey}: quota sum ${sum} != totalQuota ${dataset.totalQuota}`,
    });
  }
  if (!manifest?.seed) {
    issues.push({ code: "SEED_MISSING", message: "manifest.seed is required for reproducible sampling" });
  }
  return { dataset, issues };
}

/** Largest-remainder proportional allocation across strata. */
export function allocateProportional(counts, total, minimum = 5) {
  const entries = [...counts.entries()].filter(([, available]) => available > 0);
  const poolSize = entries.reduce((sum, [, available]) => sum + available, 0);
  if (total >= poolSize) {
    return Object.fromEntries(entries.map(([stratum, available]) => [stratum, available]));
  }
  const allocation = {};
  const remainders = [];
  let assigned = 0;
  for (const [stratum, available] of entries) {
    const ideal = (total * available) / poolSize;
    const base = Math.min(Math.floor(ideal), available);
    allocation[stratum] = base;
    assigned += base;
    remainders.push({ stratum, remainder: ideal - Math.floor(ideal), available });
  }
  // Minimum per stratum where the pool can supply it, funded from the largest
  // current allocations (keeps the total exact).
  for (const [stratum, available] of entries) {
    const floor = Math.min(minimum, available);
    while (allocation[stratum] < floor) {
      const donor = Object.entries(allocation)
        .filter(([key, value]) => key !== stratum && value > Math.min(minimum, counts.get(key) ?? 0))
        .sort((left, right) => right[1] - left[1])[0];
      if (!donor) break;
      allocation[donor[0]] -= 1;
      allocation[stratum] += 1;
    }
  }
  assigned = Object.values(allocation).reduce((sum, value) => sum + value, 0);
  // Distribute the remaining slots by largest remainder (respecting availability).
  remainders.sort((left, right) => right.remainder - left.remainder || left.stratum.localeCompare(right.stratum));
  let progress = true;
  while (assigned < total && progress) {
    progress = false;
    for (const candidate of remainders) {
      if (assigned >= total) break;
      if (allocation[candidate.stratum] < candidate.available) {
        allocation[candidate.stratum] += 1;
        assigned += 1;
        progress = true;
      }
    }
  }
  return allocation;
}

/** Draw the sample for one dataset. Returns rows + diagnostics (deterministic). */
export function sampleDataset({ rows, manifest, dataset, rng }) {
  const quota = dataset.quota;
  const sampled = [];
  const underfill = [];
  const strataReport = [];
  for (const layer of LAYERS) {
    const layerRows = rows.filter((row) => row.layer === layer);
    const byStratum = new Map();
    for (const row of layerRows) {
      const bucket = byStratum.get(row.stratum) ?? [];
      bucket.push(row);
      byStratum.set(row.stratum, bucket);
    }
    const counts = new Map([...byStratum.entries()].map(([stratum, bucket]) => [stratum, bucket.length]));
    const wanted = quota[layer] ?? 0;
    const available = layerRows.length;
    const allocation = allocateProportional(counts, Math.min(wanted, available));
    let layerSampled = 0;
    for (const stratum of [...byStratum.keys()].sort()) {
      const bucket = byStratum.get(stratum);
      const take = allocation[stratum] ?? 0;
      const chosen = sampleWithoutReplacement(bucket, take, rng);
      layerSampled += chosen.length;
      strataReport.push({ layer, stratum, available: bucket.length, sampled: chosen.length });
      for (const row of chosen) sampled.push({ ref: row.ref, layer, stratum });
    }
    if (layerSampled < wanted) {
      underfill.push({ layer, requested: wanted, sampled: layerSampled, available });
    }
  }
  const refs = sampled.map((row) => row.ref).sort();
  const sha256 = createHash("sha256").update(refs.join("\n")).digest("hex");
  return { sampled, underfill, strataReport, sha256 };
}

function renderMarkdown(report) {
  const out = [];
  out.push("# 金标抽样运行报告");
  out.push("");
  out.push(`> 数据集：${report.dataset}；seed：${report.seed}；pool：${report.pool} 行（跳过 ${report.skippedRows} 行无效）`);
  out.push(`> 抽样：${report.sampledRows} 行；refs SHA-256：\`${report.sha256}\``);
  out.push("");
  out.push("## 分层实现");
  out.push("");
  out.push("| layer | stratum | 池内可用 | 抽中 |");
  out.push("| --- | --- | --- | --- |");
  for (const row of report.strataReport) {
    out.push(`| ${row.layer} | ${row.stratum} | ${row.available} | ${row.sampled} |`);
  }
  out.push("");
  if (report.underfill.length > 0) {
    out.push("## 欠采样层（不自动回填）");
    out.push("");
    out.push("| layer | 配额 | 实抽 | 池内可用 |");
    out.push("| --- | --- | --- | --- |");
    for (const row of report.underfill) {
      out.push(`| ${row.layer} | ${row.requested} | ${row.sampled} | ${row.available} |`);
    }
    out.push("");
    out.push("欠采样必须在基线报告中披露（ch01 §1.7：n<30 只报区间与原始计数）。PLUS 层因 phone 联系点极稀（2026-11-09：全库 30 条、VALID 0）预期欠采样。");
  } else {
    out.push("无欠采样层。");
  }
  return out.join("\n");
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || !flags.manifest || !flags.dataset || !flags.pool) {
    console.error(
      "usage: node scripts/metrics/golden-sampling.mjs --manifest <manifest.json> --dataset <key> --pool <pool.csv> [--out sampled.csv] [--report report.json] [--json]",
    );
    process.exit(flags.help ? 0 : 2);
  }
  const manifest = JSON.parse(readFileSync(flags.manifest, "utf8"));
  const { dataset, issues } = validateDatasetConfig(manifest, flags.dataset);
  if (issues.length > 0) {
    for (const item of issues) console.error(`${item.code}: ${item.message}`);
    process.exit(1);
  }
  const { rows, skipped } = parsePoolCsv(readFileSync(flags.pool, "utf8"));
  const rng = createRng(manifest.seed, flags.dataset);
  const result = sampleDataset({ rows, manifest, dataset, rng });
  const report = {
    dataset: flags.dataset,
    seed: manifest.seed,
    pool: flags.pool,
    poolRows: rows.length,
    skippedRows: skipped,
    quota: dataset.quota,
    sampledRows: result.sampled.length,
    sha256: result.sha256,
    strataReport: result.strataReport,
    underfill: result.underfill,
  };
  if (flags.out) {
    const lines = ["ref,layer,stratum", ...result.sampled.map((row) => `${row.ref},${row.layer},${row.stratum}`)];
    writeFileSync(flags.out, `${lines.join("\n")}\n`);
  }
  if (flags.report) {
    writeFileSync(flags.report, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(flags.json ? JSON.stringify(report, null, 2) : renderMarkdown(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
