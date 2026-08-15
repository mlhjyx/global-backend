import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SECURITY_OVERRIDES = Object.freeze({
  "nanoid@>=3.0.0 <4.0.0": "3.3.18",
});

const FORBIDDEN_LOCKFILE_SNAPSHOTS = Object.freeze([
  "extract-zip@2.0.1",
  "nanoid@3.3.15",
  "nanoid@3.3.16",
  "nanoid@3.3.17",
]);

test("production security remediation removes the unpatched extract-zip path", async () => {
  const apiManifest = JSON.parse(
    await readFile("apps/api/package.json", "utf8"),
  );
  const lockfile = await readFile("pnpm-lock.yaml", "utf8");

  assert.equal(apiManifest.dependencies?.lighthouse, "13.4.1");
  for (const snapshot of FORBIDDEN_LOCKFILE_SNAPSHOTS) {
    assert.equal(
      new RegExp(`^  ${snapshot.replaceAll(".", "\\.")}:`, "mu").test(lockfile),
      false,
      `${snapshot} must not remain in the production dependency graph`,
    );
  }
});

test("nanoid v3 is pinned to the current patched security floor", async () => {
  const rootManifest = JSON.parse(await readFile("package.json", "utf8"));

  assert.deepEqual(rootManifest.pnpm?.overrides, SECURITY_OVERRIDES);
});

test("extract-zip is remediated by removal, not a baseline exception", async () => {
  const baseline = await readFile(
    "docs/security/production-dependency-audit-baseline.json",
    "utf8",
  );

  assert.doesNotMatch(baseline, /GHSA-jmr9-qjv8-65gv|extract-zip/u);
});
