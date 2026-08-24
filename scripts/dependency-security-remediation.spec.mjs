import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SECURITY_OVERRIDES = Object.freeze({
  "nanoid@>=3.0.0 <4.0.0": "3.3.18",
  postcss: "8.5.26",
  "js-yaml": "4.3.1",
  "fast-uri": "3.1.5",
  "deepmerge-ts": "8.0.1",
});

const FORBIDDEN_LOCKFILE_SNAPSHOTS = Object.freeze([
  "extract-zip@2.0.1",
  "nanoid@3.3.15",
  "nanoid@3.3.16",
  "nanoid@3.3.17",
]);

const REQUIRED_RUNTIME_SECURITY_SNAPSHOTS = Object.freeze([
  "@nestjs/core@11.2.1",
  "express@5.2.1",
  "body-parser@2.3.0",
  "qs@6.15.3",
  "multer@2.2.0",
  "path-to-regexp@8.4.2",
  "file-type@21.3.4",
  "fast-xml-parser@5.11.0",
]);

const FORBIDDEN_RUNTIME_SECURITY_SNAPSHOTS = Object.freeze([
  "@nestjs/core@10.4.22",
  "express@4.22.1",
  "body-parser@1.20.4",
  "qs@6.14.2",
  "multer@2.0.2",
  "path-to-regexp@0.1.13",
  "path-to-regexp@0.2.5",
  "path-to-regexp@3.3.0",
  "file-type@20.4.1",
  "fast-xml-parser@4.5.7",
]);

function lockfileHasSnapshot(lockfile, snapshot) {
  const key = snapshot.startsWith("@")
    ? `  '${snapshot}':`
    : `  ${snapshot}:`;
  return lockfile.includes(key);
}

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

test("NestJS 11 runtime security floors replace every overdue vulnerable snapshot", async () => {
  const lockfile = await readFile("pnpm-lock.yaml", "utf8");

  for (const snapshot of REQUIRED_RUNTIME_SECURITY_SNAPSHOTS) {
    assert.equal(
      lockfileHasSnapshot(lockfile, snapshot),
      true,
      `${snapshot} must remain in the reviewed runtime dependency graph`,
    );
  }
  for (const snapshot of FORBIDDEN_RUNTIME_SECURITY_SNAPSHOTS) {
    assert.equal(
      lockfileHasSnapshot(lockfile, snapshot),
      false,
      `${snapshot} must not re-enter the dependency graph`,
    );
  }
});
