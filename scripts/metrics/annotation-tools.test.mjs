// Unit + CLI smoke tests for the golden annotation worksheet generator and the
// import pre-checker (ch01 PR-08 tooling). node:test only, zero network/DB.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseCsv } from "./capture-recapture.mjs";
import {
  ANNOTATION_DATASETS,
  buildWorksheets,
  readSampleCsv,
  toCsv,
} from "./annotation-worksheet.mjs";
import { checkAnnotations, renderReport } from "./annotation-import.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GENERATOR = join(REPO_ROOT, "scripts", "metrics", "annotation-worksheet.mjs");
const IMPORTER = join(REPO_ROOT, "scripts", "metrics", "annotation-import.mjs");

const SAMPLE_ROWS = Array.from({ length: 8 }, (_, index) => ({
  ref: `co-${String(index + 1).padStart(4, "0")}`,
  layer: "rolling",
  stratum: "DE|28|51-200|registry",
}));

const ACCOUNT_BASE = {
  is_company: "yes",
  in_icp: "match",
  country: "DE",
  industry: "28",
  employee_band: "51-200",
  domain_correct: "yes",
  is_competitor: "no",
  evidence_url: "https://example.test/impressum",
  notes: "",
};

function sheetCsv(rows, dataset, overrides = new Map()) {
  const headers = ["ref", "layer", "stratum", ...ANNOTATION_DATASETS[dataset].fields.map((field) => field.key)];
  return toCsv(
    headers,
    rows.map((row) => {
      const values = { ...ACCOUNT_BASE, ...(overrides.get(row.ref) ?? {}) };
      return { ref: row.ref, layer: row.layer, stratum: row.stratum, ...values };
    }),
  );
}

function runCli(script, args) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("worksheets are deterministic, independently ordered and complete", () => {
  const first = buildWorksheets({ rows: SAMPLE_ROWS, dataset: "accounts", seed: "v1-demo" });
  const second = buildWorksheets({ rows: SAMPLE_ROWS, dataset: "accounts", seed: "v1-demo" });
  assert.equal(first.worksheets.length, 2);
  assert.equal(first.sampleSha256, second.sampleSha256);
  for (const [index, worksheet] of first.worksheets.entries()) {
    assert.equal(worksheet.orderSha256, second.worksheets[index].orderSha256);
    assert.deepEqual(
      worksheet.items.map((item) => item.ref).sort(),
      SAMPLE_ROWS.map((row) => row.ref).sort(),
    );
    assert.deepEqual(worksheet.fields, first.fields);
  }
  // Different annotators see different orderings (probability of collision ~0).
  assert.notEqual(first.worksheets[0].orderSha256, first.worksheets[1].orderSha256);
  // Changing the seed changes the ordering.
  const reseeded = buildWorksheets({ rows: SAMPLE_ROWS, dataset: "accounts", seed: "v1-other" });
  assert.notEqual(first.worksheets[0].orderSha256, reseeded.worksheets[0].orderSha256);
});

test("sample parsing rejects duplicates and missing columns", () => {
  assert.throws(() => readSampleCsv("ref,layer,stratum\nco-1,anchor,DE\nco-1,anchor,DE\n"), /duplicate ref/);
  assert.throws(() => readSampleCsv("ref,stratum\nco-1,DE\n"), /missing column "layer"/);
  assert.throws(() => readSampleCsv("ref,layer,stratum\n"), /no rows/);
  const rows = readSampleCsv("ref,layer,stratum\nco-0001,anchor,DE|28\n");
  assert.deepEqual(rows, [{ ref: "co-0001", layer: "anchor", stratum: "DE|28" }]);
});

test("csv writer round-trips through the shared parser", () => {
  const csv = toCsv(["ref", "notes"], [{ ref: "co-1", notes: 'has "quotes", a comma\nand a newline' }]);
  const { records } = parseCsv(csv);
  assert.equal(records[0].notes, 'has "quotes", a comma\nand a newline');
});

test("perfectly agreeing sheets pass with κ = 1", () => {
  const report = checkAnnotations({
    dataset: "accounts",
    sheets: [
      { annotator: "a", text: sheetCsv(SAMPLE_ROWS, "accounts") },
      { annotator: "b", text: sheetCsv(SAMPLE_ROWS, "accounts") },
    ],
    minDoubleAnnotated: 2,
  });
  assert.equal(report.passed, true);
  assert.equal(report.exitCode, 0);
  assert.equal(report.items.paired, 8);
  assert.equal(report.adjudication.count, 0);
  assert.equal(report.fields.is_company.kappa, null); // single category
  assert.equal(report.fields.is_company.pass, true);
});

test("disagreements go to adjudication and low κ fails the quality gate", () => {
  const overrides = new Map([
    ["co-0001", { is_company: "no" }],
    ["co-0002", { is_company: "no" }],
    ["co-0003", { is_company: "no" }],
    ["co-0004", { is_company: "no" }],
    ["co-0005", { is_company: "no" }],
  ]);
  const report = checkAnnotations({
    dataset: "accounts",
    sheets: [
      { annotator: "a", text: sheetCsv(SAMPLE_ROWS, "accounts") },
      { annotator: "b", text: sheetCsv(SAMPLE_ROWS, "accounts", overrides) },
    ],
    minDoubleAnnotated: 2,
  });
  assert.equal(report.adjudication.count, 5);
  assert.equal(report.fields.is_company.agreement, 3 / 8);
  assert.ok(report.fields.is_company.kappa < 0.6);
  assert.equal(report.passed, false);
  assert.equal(report.exitCode, 2);
  assert.ok(report.qualityFailures.some((failure) => failure.includes("is_company")));
  assert.match(renderReport(report), /PASS|FAIL/);
});

test("unpaired refs and invalid vocabulary values are structural errors", () => {
  const shortSheet = sheetCsv(SAMPLE_ROWS.slice(0, 7), "accounts");
  const unpaired = checkAnnotations({
    dataset: "accounts",
    sheets: [
      { annotator: "a", text: sheetCsv(SAMPLE_ROWS, "accounts") },
      { annotator: "b", text: shortSheet },
    ],
    minDoubleAnnotated: 2,
  });
  assert.equal(unpaired.exitCode, 1);
  assert.ok(unpaired.issues.some((issue) => issue.code === "REF_UNPAIRED"));

  const badValue = sheetCsv(SAMPLE_ROWS, "accounts", new Map([["co-0001", { is_company: "maybe" }]]));
  const invalid = checkAnnotations({
    dataset: "accounts",
    sheets: [
      { annotator: "a", text: sheetCsv(SAMPLE_ROWS, "accounts") },
      { annotator: "b", text: badValue },
    ],
    minDoubleAnnotated: 2,
  });
  assert.equal(invalid.exitCode, 1);
  assert.ok(invalid.issues.some((issue) => issue.code === "VALUE_INVALID"));
});

test("missing cells are reported without failing the structural check", () => {
  const rows = SAMPLE_ROWS.slice(0, 4);
  const partial = sheetCsv(rows, "accounts", new Map([["co-0001", { domain_correct: "" }]]));
  const report = checkAnnotations({
    dataset: "accounts",
    sheets: [
      { annotator: "a", text: sheetCsv(rows, "accounts") },
      { annotator: "b", text: partial },
    ],
    minDoubleAnnotated: 2,
  });
  assert.equal(report.fields.domain_correct.missing, 1);
  assert.equal(report.passed, true);
});

test("the rubric's 100-item publication gate is enforced", () => {
  const report = checkAnnotations({
    dataset: "accounts",
    sheets: [
      { annotator: "a", text: sheetCsv(SAMPLE_ROWS, "accounts") },
      { annotator: "b", text: sheetCsv(SAMPLE_ROWS, "accounts") },
    ],
  });
  assert.equal(report.exitCode, 2);
  assert.ok(report.qualityFailures.some((failure) => failure.includes("paired items")));
});

test("CLI smoke: generate worksheets, fill them, import passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "annotation-tools-"));
  try {
    const samplePath = join(dir, "sample.csv");
    writeFileSync(samplePath, toCsv(["ref", "layer", "stratum"], SAMPLE_ROWS));
    const generate = runCli(GENERATOR, [
      "--sample", samplePath,
      "--dataset", "accounts",
      "--out-dir", dir,
      "--seed", "v1-cli",
      "--json",
    ]);
    assert.equal(generate.status, 0, generate.stderr);
    const manifest = JSON.parse(generate.stdout);
    assert.equal(manifest.itemCount, SAMPLE_ROWS.length);
    assert.equal(manifest.sampleSha256.length, 64);

    const aPath = join(dir, "accounts.annotator-a.csv");
    const bPath = join(dir, "accounts.annotator-b.csv");
    for (const path of [aPath, bPath]) {
      const { headers, records } = parseCsv(readFileSync(path, "utf8"));
      assert.ok(headers.includes("is_company"));
      const filled = toCsv(
        headers,
        records.map((record) => ({ ...record, ...ACCOUNT_BASE })),
      );
      writeFileSync(path, filled);
    }
    const check = runCli(IMPORTER, [
      "--dataset", "accounts",
      "--a", aPath,
      "--b", bPath,
      "--min-double-annotated", "2",
      "--json",
    ]);
    assert.equal(check.status, 0, check.stderr);
    const report = JSON.parse(check.stdout);
    assert.equal(report.schemaVersion, "golden-annotation-check/v1");
    assert.equal(report.passed, true);

    // Rerunning the generator must refuse to clobber filled sheets.
    const rerun = runCli(GENERATOR, [
      "--sample", samplePath,
      "--dataset", "accounts",
      "--out-dir", dir,
      "--seed", "v1-cli",
    ]);
    assert.equal(rerun.status, 1);
    assert.match(rerun.stderr, /refusing to overwrite/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
