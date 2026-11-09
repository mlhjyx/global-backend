#!/usr/bin/env node
// annotation-worksheet — generate double-annotation worksheets for the golden set
// (ch01 PR-08 tooling; labels are produced by humans, this script never labels).
//
//   node scripts/metrics/annotation-worksheet.mjs \
//     --sample accounts-sample.csv --dataset accounts --out-dir <dir> --seed <seed>
//
// Input is the sampler's output (header: ref,layer,stratum; refs are company ids
// or blind contact dedupe keys — never plaintext emails/phones). For each
// annotator the rows are shuffled by a deterministic PRNG seeded with
// `${seed}:${dataset}:annotator-<id>`, so the two sheets have independent
// orderings but are exactly reproducible from the same sample and seed.
//
// Outputs per annotator: `<dataset>.annotator-<id>.csv` (to be filled in) and a
// matching `.json` with the same rows and the field list. A worksheet manifest
// records the sample/order hashes. Existing files are never overwritten unless
// --force is passed: a filled-in sheet must not be clobbered by a rerun.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parseCsv } from "./capture-recapture.mjs";
import { createRng, shuffle } from "./lib/prng.mjs";
import { parseArgs } from "./lib/psql.mjs";

/**
 * Field catalog per dataset (evals/golden-discovery/rubric-v1.md §1–§2).
 * `values` / `pattern` fields are the closed vocabularies the import checker
 * enforces and the fields Cohen's κ is computed over; `freeform` fields are
 * notes kept for adjudication and never scored.
 */
export const ANNOTATION_DATASETS = Object.freeze({
  accounts: {
    fields: [
      { key: "is_company", values: ["yes", "no", "ambiguous"] },
      { key: "in_icp", values: ["match", "weak", "mismatch", "unknown"] },
      { key: "country", pattern: /^(?:[A-Z]{2}|unknown)$/ },
      { key: "industry", pattern: /^(?:\d{2}|unknown)$/ },
      {
        key: "employee_band",
        values: ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5000+", "unknown"],
      },
      { key: "domain_correct", values: ["yes", "no", "not_applicable"] },
      { key: "is_competitor", values: ["yes", "no"] },
      { key: "evidence_url", freeform: true },
      { key: "notes", freeform: true },
    ],
  },
  contacts: {
    fields: [
      { key: "person_exists", values: ["yes", "no", "ambiguous"] },
      { key: "is_decision_maker", values: ["yes", "no", "unknown"] },
      { key: "email_status_truth", values: ["valid", "invalid", "catch_all", "unknown"] },
      { key: "email_is_personal", values: ["yes", "no"] },
      { key: "phone_status_truth", values: ["valid", "invalid", "unknown"] },
      { key: "source_correct", values: ["yes", "no"] },
      { key: "lawful_basis_ok", values: ["yes", "no"] },
      { key: "evidence_url", freeform: true },
      { key: "notes", freeform: true },
    ],
  },
});

export function fieldKeys(dataset) {
  const config = ANNOTATION_DATASETS[dataset];
  if (!config) {
    throw new Error(`unknown dataset "${dataset}" (expected one of: ${Object.keys(ANNOTATION_DATASETS).join(", ")})`);
  }
  return config.fields.map((field) => field.key);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function refsSha256(refs) {
  return sha256([...refs].sort().join("\n"));
}

function orderSha256(refs) {
  return sha256(refs.join("\n"));
}

export function csvEscape(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) lines.push(headers.map((header) => csvEscape(row[header])).join(","));
  return `${lines.join("\n")}\n`;
}

/** Parse the sampler's sample CSV into {ref, layer, stratum} rows. */
export function readSampleCsv(text) {
  const { headers, records } = parseCsv(text);
  for (const column of ["ref", "layer", "stratum"]) {
    if (!headers.includes(column)) {
      throw new Error(`sample CSV is missing column "${column}" (got: ${headers.join(", ") || "empty"})`);
    }
  }
  const rows = [];
  const seen = new Set();
  records.forEach((record, index) => {
    const ref = String(record.ref ?? "").trim();
    const layer = String(record.layer ?? "").trim();
    const stratum = String(record.stratum ?? "").trim();
    if (!ref) throw new Error(`sample line ${index + 2}: empty ref`);
    if (seen.has(ref)) throw new Error(`sample line ${index + 2}: duplicate ref ${ref}`);
    seen.add(ref);
    rows.push({ ref, layer, stratum });
  });
  if (rows.length === 0) throw new Error("sample CSV contains no rows");
  return rows;
}

/**
 * Build one worksheet per annotator from the same sample.
 * Deterministic: same rows + seed + annotators → identical orderings.
 */
export function buildWorksheets({ rows, dataset, seed, annotators = ["a", "b"], round = 1 }) {
  if (typeof seed !== "string" || seed.trim() === "") throw new Error("seed is required for reproducible worksheets");
  if (!Number.isInteger(round) || round < 1) throw new Error("round must be a positive integer");
  if (annotators.length < 1) throw new Error("at least one annotator is required");
  const fields = fieldKeys(dataset);
  const sampleSha256 = refsSha256(rows.map((row) => row.ref));
  const worksheets = annotators.map((annotator) => {
    const rng = createRng(seed, `${dataset}:annotator-${annotator}`);
    const items = shuffle(rows, rng);
    return {
      schemaVersion: "golden-annotation-worksheet/v1",
      dataset,
      annotator,
      round,
      seed,
      fields,
      sampleSha256,
      orderSha256: orderSha256(items.map((item) => item.ref)),
      items,
    };
  });
  return { fields, sampleSha256, worksheets };
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
      "usage: node scripts/metrics/annotation-worksheet.mjs --sample <csv> --dataset <accounts|contacts> --out-dir <dir> --seed <seed> [--annotators a,b] [--round 1] [--force] [--json]",
    );
    return;
  }
  const samplePath = argumentValue("--sample");
  const dataset = argumentValue("--dataset");
  const outDir = argumentValue("--out-dir");
  const seed = argumentValue("--seed");
  const annotators = (argumentValue("--annotators") ?? "a,b").split(",").map((name) => name.trim()).filter(Boolean);
  const round = Number(argumentValue("--round") ?? 1);
  if (!samplePath || !dataset || !outDir || !seed) {
    throw new Error("--sample, --dataset, --out-dir and --seed are required (--help for usage)");
  }
  const rows = readSampleCsv(readFileSync(samplePath, "utf8"));
  const { fields, sampleSha256, worksheets } = buildWorksheets({ rows, dataset, seed, annotators, round });
  const headers = ["ref", "layer", "stratum", ...fields];
  const outputs = worksheets.flatMap((worksheet) => [
    join(outDir, `${dataset}.annotator-${worksheet.annotator}.csv`),
    join(outDir, `${dataset}.annotator-${worksheet.annotator}.json`),
  ]);
  const manifestPath = join(outDir, `${dataset}.worksheet-manifest.json`);
  if (!flags.force) {
    const existing = [...outputs, manifestPath].filter((path) => existsSync(path));
    if (existing.length > 0) {
      throw new Error(`refusing to overwrite existing worksheet files (use --force): ${existing.join(", ")}`);
    }
  }
  mkdirSync(outDir, { recursive: true });
  for (const worksheet of worksheets) {
    writeFileSync(join(outDir, `${dataset}.annotator-${worksheet.annotator}.csv`), toCsv(headers, worksheet.items));
    writeFileSync(
      join(outDir, `${dataset}.annotator-${worksheet.annotator}.json`),
      `${JSON.stringify(worksheet, null, 2)}\n`,
    );
  }
  const manifest = {
    schemaVersion: "golden-annotation-worksheet-manifest/v1",
    dataset,
    round,
    seed,
    sampleSha256,
    itemCount: rows.length,
    fields,
    annotators: Object.fromEntries(worksheets.map((worksheet) => [worksheet.annotator, { orderSha256: worksheet.orderSha256 }])),
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (flags.json) {
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    console.log(`annotation worksheets: dataset=${dataset} items=${rows.length} seed=${seed} out=${outDir}`);
    for (const worksheet of worksheets) {
      console.log(
        `  annotator ${worksheet.annotator}: ${dataset}.annotator-${worksheet.annotator}.csv (order ${worksheet.orderSha256.slice(0, 12)})`,
      );
    }
    console.log(`  manifest: ${dataset}.worksheet-manifest.json (sample ${sampleSha256.slice(0, 12)})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
