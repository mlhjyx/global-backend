import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectCurrentMainAuditFacts,
  generateCurrentMainAdmission,
  validateCurrentMainAdmissionDecision,
  validateCurrentMainAdmissionInput,
} from "./governance-organization-identity-current-main-admission.mjs";

const SHA = "a".repeat(64);
const COMMIT = "1".repeat(40);

function input(overrides = {}) {
  return {
    schema_version: "current-main-admission-input/v1",
    purpose: "trusted_approval_current_main",
    repository: { host: "github.com", owner: "mlhjyx", name: "global-backend", full_name: "mlhjyx/global-backend" },
    base_commit: COMMIT,
    candidate_commit: "2".repeat(40),
    current_main: { ref: "refs/heads/main", commit: "3".repeat(40), observed_at: "2026-09-07T00:00:00.000Z" },
    proposal: { path: "docs/governance/example.json", byte_sha256: SHA, semantic_sha256: "b".repeat(64), revision: "v1" },
    required_files: [{ path: "docs/governance/example.json", byte_sha256: SHA, role: "schema" }],
    copy_impact: {
      schema_version: "site-builder-copy-runtime-eligibility/v1",
      status: "CURRENT",
      active_binding_path: "docs/evidence/site-builder/m1-g-copy-sonnet-recovery-runtime-binding-v22.json",
      active_binding_artifact_id: "binding-v22",
      active_binding_source_bundle_digest: SHA,
      current_source_fingerprint: "c".repeat(64),
      dispatch_authorization: "NOT_AUTHORIZED",
      pilot_eligibility: "BLOCKED",
      drifted_paths: [],
      required_followup: "SEPARATE_DISPATCH_AUTHORIZATION",
      stale_scope: "NONE",
    },
    external_provenance: { status: "EXTERNAL_UNVERIFIED", verifier_id: "none", readback_id: "none", source: "github", observed_at: "2026-09-07T00:00:00.000Z" },
    ...overrides,
  };
}

test("admission input is exact-key and rejects unknown fields", () => {
  assert.equal(validateCurrentMainAdmissionInput(input()).status, "PASS");
  assert.deepEqual(validateCurrentMainAdmissionInput({ ...input(), extra: true }), { status: "HOLD", code: "SCHEMA_UNKNOWN_KEY" });
});

test("admission keeps external provenance unverified and Copy dispatch blocked", () => {
  const result = generateCurrentMainAdmission(input());
  assert.equal(result.status, "PASS");
  assert.equal(result.decision.outcome, "HOLD");
  assert.equal(result.decision.blocking_code, "EXTERNAL_PROVENANCE_UNVERIFIED");
  assert.equal(validateCurrentMainAdmissionDecision(result.decision).status, "PASS");
});

test("stale Copy impact cannot become an admission", () => {
  const result = validateCurrentMainAdmissionInput(input({ copy_impact: { ...input().copy_impact, status: "STALE_HOLD", drifted_paths: ["packages/db/prisma/schema.prisma"], stale_scope: "PRISMA_SCHEMA_EVOLUTION", required_followup: "REBASE_FIXED_SOURCE_BEFORE_DISPATCH" } }));
  assert.equal(result.status, "PASS");
  const decision = generateCurrentMainAdmission(input({ copy_impact: { ...input().copy_impact, status: "STALE_HOLD", drifted_paths: ["packages/db/prisma/schema.prisma"], stale_scope: "PRISMA_SCHEMA_EVOLUTION", required_followup: "REBASE_FIXED_SOURCE_BEFORE_DISPATCH" } }));
  assert.equal(decision.decision.blocking_code, "EXTERNAL_PROVENANCE_UNVERIFIED");
  assert.equal(decision.decision.copy_impact_status, "STALE_HOLD");
});

test("Copy CURRENT cannot carry drift and stale drift is allowlisted", () => {
  const current = input({ copy_impact: { ...input().copy_impact, drifted_paths: ["packages/db/prisma/schema.prisma"] } });
  assert.deepEqual(validateCurrentMainAdmissionInput(current), { status: "HOLD", code: "COPY_FIXED_SOURCE_DRIFT_PATHS_MISMATCH" });
  const arbitrary = input({ copy_impact: { ...input().copy_impact, status: "STALE_HOLD", drifted_paths: ["apps/api/src/main.ts"], stale_scope: "PRISMA_SCHEMA_EVOLUTION", required_followup: "REBASE_FIXED_SOURCE_BEFORE_DISPATCH" } });
  assert.deepEqual(validateCurrentMainAdmissionInput(arbitrary), { status: "HOLD", code: "COPY_FIXED_SOURCE_DRIFT_PATHS_MISMATCH" });
});

test("command descriptors reject secret-like parameters", async () => {
  const { buildCopyCommandDescriptor } = await import("./governance-organization-identity-current-main-admission.mjs");
  assert.deepEqual(buildCopyCommandDescriptor("COPY_WRITE_ELIGIBILITY_V1", { token: "secret" }), { status: "HOLD", code: "COMMAND_DESCRIPTOR_INVALID" });
});

test("collector rejects a caller-supplied main commit that is not origin/main", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-current-main-mismatch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  await writeFile(path.join(root, "base.txt"), "base\n");
  execFileSync("git", ["-C", root, "add", "base.txt"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
  const live = execFileSync("git", ["-C", root, "rev-parse", "HEAD"]).toString().trim();
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/fixture/repo.git"]);
  execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", live]);
  assert.deepEqual(collectCurrentMainAuditFacts({ repositoryRoot: root, branch: "HEAD", liveMain: "f".repeat(40), expectedRepository: { host: "github.com", owner: "fixture", name: "repo", full_name: "fixture/repo" } }), { status: "HOLD", code: "CURRENT_MAIN_READBACK_NOT_PROVEN" });
});

test("collector computes a NUL-safe main-only path set without mutating Git", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-current-main-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  await writeFile(path.join(root, "base.txt"), "base\n");
  execFileSync("git", ["-C", root, "add", "base.txt"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
  await writeFile(path.join(root, "main-only.txt"), "main\n");
  execFileSync("git", ["-C", root, "add", "main-only.txt"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "main-only"]);
  const liveMain = execFileSync("git", ["-C", root, "rev-parse", "HEAD"]).toString().trim();
  const base = execFileSync("git", ["-C", root, "rev-list", "--max-parents=0", "HEAD"]).toString().trim();
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/fixture/repo.git"]);
  execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", liveMain]);
  const result = collectCurrentMainAuditFacts({ repositoryRoot: root, branch: base, expectedRepository: { host: "github.com", owner: "fixture", name: "repo", full_name: "fixture/repo" } });
  assert.equal(result.status, "PASS");
  assert.equal(result.mainOnlyPaths.length, 1);
  assert.equal(result.mainOnlyPaths[0].path, "main-only.txt");
  assert.match(result.mainOnlyPathSetSha256, /^[0-9a-f]{64}$/);
});

test("collector binds repository root origin identity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-repository-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  await writeFile(path.join(root, "base.txt"), "base\n");
  execFileSync("git", ["-C", root, "add", "base.txt"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
  const live = execFileSync("git", ["-C", root, "rev-parse", "HEAD"]).toString().trim();
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/repo-a/main.git"]);
  execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", live]);
  assert.deepEqual(collectCurrentMainAuditFacts({ repositoryRoot: root, expectedRepository: { host: "github.com", owner: "repo-b", name: "main", full_name: "repo-b/main" } }), { status: "HOLD", code: "REPOSITORY_IDENTITY_INVALID" });
});
