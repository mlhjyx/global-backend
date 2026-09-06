import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = resolve(
  ROOT,
  "scripts/verify-platform-authority-policy-import.mjs",
);

test("reports a missing external authority as EXTERNAL_UNVERIFIED and exits non-zero", () => {
  const result = spawnSync(
    process.execPath,
    [CLI, "--authority-root", "/tmp/growthos-authority-does-not-exist"],
    {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: "platform-authority-policy-import-verification/v2",
    status: "EXTERNAL_UNVERIFIED",
    reason: "AUTHORITY_CHECKOUT_UNAVAILABLE",
  });
});

test("rejects unknown CLI arguments instead of silently choosing a checkout", () => {
  const result = spawnSync(process.execPath, [CLI, "--unknown"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: "platform-authority-policy-import-verification/v2",
    status: "FAILED",
    reason: "VERIFIER_INPUT_INVALID",
  });
});
