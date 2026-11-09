// CI smoke gate (PR-09 precursor): run the golden replay runner as a real
// subprocess on the demo set and on a deliberately mutated copy. This exercises
// the CLI path and exit codes (the unit tests cover the library functions).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNNER = join(REPO_ROOT, "scripts", "metrics", "golden-run.mjs");
const DEMO = join(REPO_ROOT, "evals", "golden-discovery", "fixtures", "replay-demo");

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [RUNNER, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? "" };
  }
}

test("CI smoke: demo golden set passes through the real CLI", () => {
  const result = runCli(["--set", DEMO, "--as-of", "2026-11-09T00:00:00Z", "--json"]);
  assert.equal(result.status, 0, result.stdout);
  const run = JSON.parse(result.stdout);
  assert.equal(run.schemaVersion, "golden-run/v1");
  assert.equal(run.passed, true);
  assert.ok(run.gates.every((gate) => gate.ok));
});

test("CI smoke: a mutated copy fails the CLI with a red gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "golden-smoke-"));
  try {
    cpSync(DEMO, dir, { recursive: true });
    const predictionPath = join(dir, "predictions", "acct-0001.json");
    const prediction = JSON.parse(readFileSync(predictionPath, "utf8"));
    prediction.labels.is_company = "no";
    writeFileSync(predictionPath, JSON.stringify(prediction));
    const result = runCli(["--set", dir, "--as-of", "2026-11-09T00:00:00Z", "--json"]);
    assert.equal(result.status, 1);
    const run = JSON.parse(result.stdout);
    assert.equal(run.passed, false);
    assert.equal(run.gates.find((gate) => gate.name === "G3_is_company").ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CI smoke: --out writes the golden-run artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "golden-smoke-out-"));
  try {
    const out = join(dir, "run.json");
    const result = runCli(["--set", DEMO, "--as-of", "2026-11-09T00:00:00Z", "--out", out, "--json"]);
    assert.equal(result.status, 0, result.stdout);
    const artifact = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(artifact.schemaVersion, "golden-run/v1");
    assert.equal(artifact.passed, true);
    assert.match(artifact.sampleSha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
