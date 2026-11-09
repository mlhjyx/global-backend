// Unit tests for the golden replay runner (node:test only, zero model calls).
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyGates,
  cohenKappa,
  diffAgainstBaseline,
  evaluateFields,
  loadSet,
  runGoldenSet,
} from "./golden-run.mjs";

const DEMO = new URL("../../evals/golden-discovery/fixtures/replay-demo/", import.meta.url).pathname;
const AS_OF = "2026-11-09T00:00:00Z";

function tempCopy() {
  const dir = mkdtempSync(join(tmpdir(), "golden-run-"));
  cpSync(DEMO, dir, { recursive: true });
  return dir;
}

test("the demo set loads and passes all gates in replay mode", () => {
  const run = runGoldenSet(DEMO, { asOf: AS_OF });
  assert.equal(run.passed, true);
  assert.equal(run.sampleN, 4);
  assert.match(run.sampleSha256, /^[0-9a-f]{64}$/);
  assert.equal(run.metrics.in_icp.precision, 1);
  assert.equal(run.metrics.in_icp.recall, 1);
  assert.ok(Math.abs(run.metrics.in_icp.kappa - 1 / 3) < 1e-12);
});

test("Cohen's kappa matches the textbook 2x2 example", () => {
  const pairs = [
    ...Array.from({ length: 20 }, () => ["yes", "yes"]),
    ...Array.from({ length: 5 }, () => ["yes", "no"]),
    ...Array.from({ length: 10 }, () => ["no", "yes"]),
    ...Array.from({ length: 15 }, () => ["no", "no"]),
  ];
  assert.ok(Math.abs(cohenKappa(pairs) - 0.4) < 1e-12);
  assert.equal(cohenKappa([["yes", "yes"]]), null); // single category
});

test("mutation test: breaking a gate-field prediction turns the run red", () => {
  const dir = tempCopy();
  try {
    const predictionPath = join(dir, "predictions", "acct-0001.json");
    const prediction = JSON.parse(readFileSync(predictionPath, "utf8"));
    prediction.labels.is_company = "no";
    writeFileSync(predictionPath, JSON.stringify(prediction));
    const run = runGoldenSet(dir, { asOf: AS_OF });
    assert.equal(run.passed, false);
    const gate = run.gates.find((entry) => entry.name === "G3_is_company");
    assert.equal(gate.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fit recall gate fails when a real match is predicted as mismatch", () => {
  const dir = tempCopy();
  try {
    const predictionPath = join(dir, "predictions", "acct-0001.json");
    const prediction = JSON.parse(readFileSync(predictionPath, "utf8"));
    prediction.labels.in_icp = "mismatch";
    writeFileSync(predictionPath, JSON.stringify(prediction));
    const run = runGoldenSet(dir, { asOf: AS_OF });
    assert.equal(run.passed, false);
    assert.equal(run.gates.find((entry) => entry.name === "G1_fit_recall").ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unadjudicated labels and unknown label fields are rejected", () => {
  const dir = tempCopy();
  try {
    const labelPath = join(dir, "labels", "acct-0001.labels.json");
    const label = JSON.parse(readFileSync(labelPath, "utf8"));
    writeFileSync(labelPath, JSON.stringify({ ...label, adjudicated: false }));
    assert.throws(() => runGoldenSet(dir), /ADJUDICATION_REQUIRED/);
    writeFileSync(
      labelPath,
      JSON.stringify({ ...label, adjudicatedValue: { ...label.adjudicatedValue, made_up_field: "x" } }),
    );
    assert.throws(() => runGoldenSet(dir), /UNKNOWN_LABEL_FIELD/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("relative gate G2 fails on a >2pp drop against the baseline", () => {
  const set = loadSet(DEMO);
  const metrics = evaluateFields(set);
  const baselineMetrics = {
    in_icp: { precision: metrics.in_icp.precision + 0.03, recall: metrics.in_icp.recall, accuracy: metrics.in_icp.accuracy },
  };
  const gates = applyGates({ metrics, baselineMetrics });
  const relative = gates.find((gate) => gate.name === "G2_in_icp_precision");
  assert.ok(relative, "expected a G2 precision gate");
  assert.equal(relative.ok, false);
});

test("diff reports changed fields against the baseline snapshot", () => {
  const set = loadSet(DEMO);
  const items = [{ id: "acct-0001", fields: { in_icp: "match", is_company: "yes" } }];
  const changes = diffAgainstBaseline(items, [{ id: "acct-0001", fields: { in_icp: "weak", is_company: "yes" } }]);
  assert.deepEqual(changes, [{ id: "acct-0001", field: "in_icp", from: "weak", to: "match" }]);
});

test("the run is deterministic for fixed asOf", () => {
  const first = runGoldenSet(DEMO, { asOf: AS_OF });
  const second = runGoldenSet(DEMO, { asOf: AS_OF });
  assert.deepEqual(first, second);
});
