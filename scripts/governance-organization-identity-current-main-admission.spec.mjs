import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectCurrentMainAuditFacts,
  buildCopyCommandDescriptor,
  hasExactKeys,
  validateAuditReviewReceipt,
  validateCurrentMainAdmissionStructure,
  collectAdmissionObjectFacts,
  validateAdmissionObjectBindings,
  validateArtifactAMigrationBindings,
  validateAdmissionConflictBindings,
  resolveAdmissionOwner,
  collectThreeWayConflictFacts,
  generateCurrentMainAdmission,
  validateCurrentMainAdmissionDecision,
  validateCurrentMainAdmissionInput,
} from "./governance-organization-identity-current-main-admission.mjs";

const SHA = "a".repeat(64);
const COMMIT = "1".repeat(40);

test("owner resolution binds the last matching supported rule and fails on ambiguous syntax", () => {
  const source = Buffer.from("* @default\n/packages/ @team/db\n/packages/db/*.sql @sql\n");
  const result = resolveAdmissionOwner(source, COMMIT, "packages/db/test.sql");
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.owner, { source: "CODEOWNERS", codeownersBlobId: COMMIT,
    matchedRule: "/packages/db/*.sql", principals: ["@sql"], resolution: "EXACT" });
  assert.equal(resolveAdmissionOwner(Buffer.from("/docs/ @docs\n"), COMMIT, "src/a.ts").code, "CODEOWNERS_UNRESOLVED");
  assert.equal(resolveAdmissionOwner(Buffer.from("* @default\n/docs/\n"), COMMIT, "docs/a.md").code, "CODEOWNERS_UNRESOLVED");
  for (const pattern of ["[ab].ts", "!private/", "file\\ name", "/foo/**bar"]) {
    assert.equal(resolveAdmissionOwner(Buffer.from(`* @default\n${pattern} @x\n`), COMMIT, "src/a.ts").status, "HOLD");
  }
  for (const file of ["package.json", "packages/api/package.json"]) {
    assert.equal(resolveAdmissionOwner(Buffer.from("/**/package.json @pkg\n"), COMMIT, file).status, "PASS");
  }
});

function admission() {
  return {
    schemaVersion: "organization-identity-current-main-admission/v1", status: "ADMITTED",
    artifactACommit: "2400bac28796bae44294114edc99eaccb1bd65b3",
    branchPreRefreshCommit: COMMIT, liveMainCommit: "2".repeat(40), mergeBaseCommit: "3".repeat(40),
    refreshMergeCommit: "4".repeat(40), refreshParents: [COMMIT, "2".repeat(40)],
    mainOnlyRange: `${"3".repeat(40)}..${"2".repeat(40)}`, mainOnlyPathCount: 1,
    mainOnlyPathSetSha256: createHash("sha256").update("a.ts\0").digest("hex"),
    paths: [{ path: "a.ts", changeKind: "ADD", baseBlobId: null, branchBlobId: null,
      mainBlobId: COMMIT, resultBlobId: COMMIT, classifications: ["OTHER"],
      owner: { source: "CODEOWNERS", codeownersBlobId: COMMIT, matchedRule: "*", principals: ["@owner"], resolution: "EXACT" },
      evidenceSha256: [SHA], disposition: "ADMIT_IDENTITY_IRRELEVANT", generatedRebuild: null }],
    conflicts: [], migrations: [], rawDeltaSha256: SHA, buildDeltaSha256: SHA,
    schemaDeltaSha256: SHA, callerDeltaSha256: SHA,
    review: { auditPacketSha256: SHA, auditReviewReceiptSha256: SHA, reportSha256: SHA, verdict: "PASS" },
  };
}

test("planned admission structure rejects missing fields and path/parent/owner inconsistencies", () => {
  const good = admission();
  assert.deepEqual(validateCurrentMainAdmissionStructure(good), { status: "PASS", evidenceClass: "STRUCTURE_ONLY" });
  for (const key of Object.keys(good)) {
    const missing = structuredClone(good); delete missing[key];
    assert.equal(validateCurrentMainAdmissionStructure(missing).status, "HOLD", key);
  }
  const mutations = [
    x => x.status = "HOLD", x => x.refreshParents.reverse(), x => x.paths = [],
    x => x.paths[0].baseBlobId = COMMIT, x => x.paths[0].owner.resolution = "UNRESOLVED",
    x => x.paths[0].disposition = "HOLD", x => x.paths[0].extra = true,
    x => x.paths[0].path = "../escape", x => x.paths[0].classifications.push("OTHER"),
    x => x.conflicts.push({ path: "unknown" }), x => x.migrations.push({ name: "unknown" }),
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(good); mutate(changed);
    assert.equal(validateCurrentMainAdmissionStructure(changed).status, "HOLD");
  }
});

test("audit review validates the planned schema and binds every field to independently supplied facts", () => {
  const receipt = {
    schemaVersion: "organization-identity-current-main-audit-review/v1",
    disposition: "PASS", auditPacketSha256: SHA, githubControllerContractSha256: SHA,
    githubControllerReviewReceiptSha256: SHA, protectedMainReadbackReceiptSha256: SHA,
    localBootstrapRunReceiptSetSha256: SHA, branchPreRefreshCommit: COMMIT,
    advertisedLiveMainCommit: "2".repeat(40), mergeBaseCommit: COMMIT,
    mainOnlyPathSetSha256: SHA, conflictSetSha256: SHA, migrationSetSha256: SHA,
    dispositionSetSha256: SHA, authorizationRequestSha256: SHA, fetchReceiptSha256: null,
    reportSha256: SHA, counterexampleSetSha256: "b".repeat(64),
    reviewerClass: "INDEPENDENT_ADMISSION_AUDIT_REVIEW", critical: 0, important: 0, verdict: "PASS",
  };
  assert.equal(validateAuditReviewReceipt(receipt, receipt).status, "PASS");
  assert.equal(validateAuditReviewReceipt(receipt).status, "HOLD");
  for (const key of Object.keys(receipt)) {
    const missing = { ...receipt }; delete missing[key];
    assert.equal(validateAuditReviewReceipt(missing, receipt).status, "HOLD", key);
  }
  for (const change of [{ migrationSetSha256: null }, { auditPacketSha256: "c".repeat(64) }, { important: 1 }, { extra: true }]) {
    assert.equal(validateAuditReviewReceipt({ ...receipt, ...change }, receipt).status, "HOLD");
  }
});

test("hostile input is rejected without invoking proxy or accessor traps", () => {
  let traps = 0;
  const proxy = new Proxy({}, { getPrototypeOf() { traps++; throw Error("private"); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const accessor = Object.defineProperty({}, "secret", { get() { traps++; throw Error("private"); } });
  for (const value of [null, undefined, proxy, revoked.proxy, accessor]) {
    assert.equal(validateCurrentMainAdmissionInput(value).status, "HOLD");
    assert.equal(validateCurrentMainAdmissionDecision(value).status, "HOLD");
    assert.equal(buildCopyCommandDescriptor("COPY_WRITE_ELIGIBILITY_V1", value).status, "HOLD");
  }
  assert.equal(traps, 0);
  assert.equal(hasExactKeys(new Array(2), []), false);
});

test("Copy descriptors reject invalid digests and arbitrary target paths", () => {
  const valid = { auditPacketSha256: SHA, eligibilityPath: "docs/evidence/site-builder/copy-runtime-eligibility.json" };
  assert.equal(buildCopyCommandDescriptor("COPY_WRITE_ELIGIBILITY_V1", valid).status, "PASS");
  for (const change of [{ auditPacketSha256: "not-a-digest" }, { eligibilityPath: "../outside" }, { eligibilityPath: "docs/other.json" }]) {
    assert.equal(buildCopyCommandDescriptor("COPY_WRITE_ELIGIBILITY_V1", { ...valid, ...change }).status, "HOLD");
  }
});

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

test("object collector binds four trees, ordered parents and complete migration blobs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-object-facts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
  await mkdir(path.join(root, ".github"));
  await writeFile(path.join(root, ".github/CODEOWNERS"), "* @owner\n");
  await writeFile(path.join(root, "base.txt"), "base\n"); git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-qb", "feature");
  await writeFile(path.join(root, "branch.txt"), "feature\n"); git("add", "."); git("commit", "-qm", "feature");
  const branch = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  const migrationPath = "packages/db/prisma/migrations/20260908000000_example/migration.sql";
  await mkdir(path.dirname(path.join(root, migrationPath)), { recursive: true });
  await writeFile(path.join(root, migrationPath), "SELECT 1;\n");
  git("add", "."); git("commit", "-qm", "migration"); const main = git("rev-parse", "HEAD");
  git("checkout", "-q", "feature"); git("merge", "--no-ff", "-qm", "merge", main);
  const merged = git("rev-parse", "HEAD");
  const before = git("status", "--porcelain");
  const result = collectAdmissionObjectFacts({ repoRoot: root, branchPreRefreshCommit: branch, liveMainCommit: main, refreshMergeCommit: merged });
  assert.equal(result.status, "PASS", JSON.stringify(result));
  assert.equal(result.evidenceClass, "LOCAL_GIT_OBJECT_FACTS_ONLY");
  assert.equal(result.mergeBaseCommit, base);
  assert.deepEqual(result.refreshParents, [branch, main]);
  assert.deepEqual(result.mainOnlyPaths.map(x => x.path), [migrationPath]);
  assert.equal(result.migrations.length, 1);
  assert.equal(result.migrations[0].migrationSqlSha256, createHash("sha256").update("SELECT 1;\n").digest("hex"));
  assert.equal(result.migrations[0].lastChangeCommit, main);
  const document = admission();
  Object.assign(document, { branchPreRefreshCommit: branch, liveMainCommit: main,
    mergeBaseCommit: base, refreshMergeCommit: merged, refreshParents: [branch, main],
    mainOnlyRange: `${base}..${main}`, mainOnlyPathSetSha256: result.mainOnlyPathSetSha256 });
  document.paths = result.mainOnlyPaths.map((row, index) => ({ ...admission().paths[0], ...row, owner: result.owners[index].owner, classifications: ["MIGRATION"] }));
  document.migrations = result.migrations.map(row => ({ ...row, mainOnly: true,
    artifactARelationship: "POST_ARTIFACT_A_MAIN_ONLY", disposition: "IDENTITY_IRRELEVANT" }));
  assert.equal(validateAdmissionObjectBindings(document, result).status, "PASS");
  const artifactRelations = validateArtifactAMigrationBindings(document, {
    artifactACommit: document.artifactACommit,
    artifactAMigrationBlobs: [],
    mainOnlyMigrationPaths: [migrationPath],
  });
  assert.equal(artifactRelations.status, "PASS");
  const exactArtifact = structuredClone(document);
  exactArtifact.migrations[0].artifactARelationship = "EXACT_ARTIFACT_A_BLOB";
  assert.equal(validateArtifactAMigrationBindings(exactArtifact, {
    artifactACommit: document.artifactACommit,
    artifactAMigrationBlobs: [{ path: migrationPath, blobId: result.migrations[0].resultBlobId }],
    mainOnlyMigrationPaths: [migrationPath],
  }).status, "PASS");
  exactArtifact.migrations[0].artifactARelationship = "PREEXISTING_NON_IDENTITY";
  assert.equal(validateArtifactAMigrationBindings(exactArtifact, {
    artifactACommit: document.artifactACommit,
    artifactAMigrationBlobs: [], mainOnlyMigrationPaths: [migrationPath],
  }).code, "ARTIFACT_A_MIGRATION_RELATION_MISMATCH");
  const wrongOwner = structuredClone(document); wrongOwner.paths[0].owner.principals = ["@someone"];
  assert.equal(validateAdmissionObjectBindings(wrongOwner, result).code, "ADMISSION_OWNER_MISMATCH");
  assert.equal(validateAdmissionObjectBindings(document, JSON.parse(JSON.stringify(result))).code, "COLLECTED_OBJECT_FACTS_REQUIRED");
  const wrongBlob = structuredClone(document); wrongBlob.paths[0].resultBlobId = "a".repeat(40);
  assert.equal(validateAdmissionObjectBindings(wrongBlob, result).code, "ADMISSION_BLOB_MISMATCH");
  const omitted = structuredClone(document); omitted.migrations = [];
  assert.equal(validateAdmissionObjectBindings(omitted, result).code, "MIGRATION_SET_MISMATCH");
  const conflictDocument = admission();
  const copyConflictPath = "docs/evidence/site-builder/copy-runtime-eligibility.json";
  conflictDocument.conflicts = [{ path: copyConflictPath, hunkCount: 1, baseBlobId: COMMIT, branchBlobId: COMMIT,
    mainBlobId: COMMIT, resultBlobId: COMMIT, resolutionSource: "LIVE_MAIN_GIT_BLOB" }];
  const conflictFacts = { conflicts: [{ path: copyConflictPath, hunkCount: 1, baseBlobId: COMMIT, branchBlobId: COMMIT, mainBlobId: COMMIT }], conflictSetSha256: SHA };
  assert.equal(validateAdmissionConflictBindings(conflictDocument, conflictFacts).status, "PASS");
  conflictDocument.conflicts[0].resolutionSource = "SEMANTIC_UNION_PRESERVE_IDENTITY_LOCK_AND_CURRENT_POSTGRES_VOID_CAST";
  assert.equal(validateAdmissionConflictBindings(conflictDocument, conflictFacts).code, "ADMISSION_RECORD_INVALID");
  conflictDocument.conflicts[0].resolutionSource = "UNREVIEWED_FREEFORM_UNION";
  assert.equal(validateAdmissionConflictBindings(conflictDocument, conflictFacts).code, "ADMISSION_RECORD_INVALID");
  conflictDocument.conflicts[0].resolutionSource = "LIVE_MAIN_GIT_BLOB";
  conflictDocument.conflicts[0].hunkCount = 2;
  assert.equal(validateAdmissionConflictBindings(conflictDocument, conflictFacts).code, "ADMISSION_CONFLICT_BINDING_MISMATCH");
  assert.equal(git("status", "--porcelain"), before);
  assert.equal(git("rev-parse", "HEAD"), merged);
  assert.equal(collectAdmissionObjectFacts({ repoRoot: root, branchPreRefreshCommit: branch, liveMainCommit: main, refreshMergeCommit: main }).code, "REFRESH_PARENTS_MISMATCH");
});

test("three-way conflict collection hashes conflict facts without exposing source or writing Git", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-conflict-facts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
  await writeFile(path.join(root, "a.txt"), "base\n"); git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD"); git("checkout", "-qb", "feature");
  await writeFile(path.join(root, "a.txt"), "private-branch-content\n"); git("add", "."); git("commit", "-qm", "feature");
  const branch = git("rev-parse", "HEAD"); git("checkout", "-q", "main");
  await writeFile(path.join(root, "a.txt"), "private-main-content\n"); git("add", "."); git("commit", "-qm", "main");
  const main = git("rev-parse", "HEAD");
  const result = collectThreeWayConflictFacts({ repoRoot: root, mergeBaseCommit: base, branchPreRefreshCommit: branch, liveMainCommit: main });
  assert.equal(result.status, "PASS", JSON.stringify(result));
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].path, "a.txt");
  assert.equal(result.conflicts[0].hunkCount, 1);
  assert.equal(JSON.stringify(result).includes("private-"), false);
  assert.equal(git("rev-parse", "HEAD"), main);
  assert.equal(git("status", "--porcelain"), "");
  const clean = collectThreeWayConflictFacts({ repoRoot: root, mergeBaseCommit: base, branchPreRefreshCommit: base, liveMainCommit: main });
  assert.equal(clean.status, "PASS"); assert.deepEqual(clean.conflicts, []);
});

test("three-way conflict collection admits exact whitespace-only attributes and rejects merge drivers", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-conflict-attributes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
  await writeFile(path.join(root, "a.txt"), "base\n"); git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD"); git("checkout", "-qb", "feature");
  await mkdir(path.join(root, "packages/db/test/fixtures"), { recursive: true });
  await writeFile(path.join(root, ".gitattributes"),
    "packages/db/test/fixtures/organization-identity-v2-contract-prisma-residual.sql whitespace=-blank-at-eof\n");
  await writeFile(path.join(root, "a.txt"), "feature\n"); git("add", "."); git("commit", "-qm", "feature");
  const branch = git("rev-parse", "HEAD"); git("checkout", "-q", "main");
  await writeFile(path.join(root, "a.txt"), "main\n"); git("add", "."); git("commit", "-qm", "main");
  const main = git("rev-parse", "HEAD");
  const safe = collectThreeWayConflictFacts({ repoRoot: root, mergeBaseCommit: base,
    branchPreRefreshCommit: branch, liveMainCommit: main });
  assert.equal(safe.status, "PASS", JSON.stringify(safe));
  assert.deepEqual(safe.conflicts.map((row) => row.path), ["a.txt"]);

  git("checkout", "-q", "feature");
  await writeFile(path.join(root, ".gitattributes"), "a.txt merge=ours\n");
  git("add", ".gitattributes"); git("commit", "-qm", "unsafe attributes");
  const unsafeBranch = git("rev-parse", "HEAD");
  assert.equal(collectThreeWayConflictFacts({ repoRoot: root, mergeBaseCommit: base,
    branchPreRefreshCommit: unsafeBranch, liveMainCommit: main }).code, "MERGE_ATTRIBUTES_UNSUPPORTED");
});

test("three-way conflict collection ignores non-conflicting binary deltas while counting text conflicts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-conflict-binary-delta-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
  await writeFile(path.join(root, "a.txt"), "base\n");
  await writeFile(path.join(root, "binary.png"), Buffer.from([0xff, 1, 2]));
  git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD"); git("checkout", "-qb", "feature");
  await writeFile(path.join(root, "a.txt"), "feature\n"); git("add", "."); git("commit", "-qm", "feature");
  const branch = git("rev-parse", "HEAD"); git("checkout", "-q", "main");
  await writeFile(path.join(root, "a.txt"), "main\n");
  await writeFile(path.join(root, "binary.png"), Buffer.from([0xfe, 3, 4]));
  git("add", "."); git("commit", "-qm", "main");
  const main = git("rev-parse", "HEAD");
  const result = collectThreeWayConflictFacts({ repoRoot: root, mergeBaseCommit: base,
    branchPreRefreshCommit: branch, liveMainCommit: main });
  assert.equal(result.status, "PASS", JSON.stringify(result));
  assert.deepEqual(result.conflicts.map((row) => row.path), ["a.txt"]);
  assert.equal(result.conflicts[0].hunkCount, 1);
});

async function isolatedConflictFixture(t, file = "a.txt", nestedAttributes = null) {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-conflict-boundaries-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), "base\n");
  if (nestedAttributes) {
    await mkdir(path.join(root, "nested"), { recursive: true });
    await writeFile(path.join(root, "nested/.gitattributes"), nestedAttributes);
  }
  git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD"); git("checkout", "-qb", "feature");
  await writeFile(path.join(root, file), "feature\n"); git("add", "."); git("commit", "-qm", "feature");
  const branch = git("rev-parse", "HEAD"); git("checkout", "-q", "main");
  await writeFile(path.join(root, file), "main\n"); git("add", "."); git("commit", "-qm", "main");
  const main = git("rev-parse", "HEAD");
  return { root, git, options: { repoRoot: root, mergeBaseCommit: base,
    branchPreRefreshCommit: branch, liveMainCommit: main } };
}

test("conflict collector rejects nested merge attributes before a repository driver can run", async (t) => {
  const f = await isolatedConflictFixture(t, "nested/a.txt", "a.txt merge=hostile\n");
  const marker = path.join(f.root, "driver-ran");
  f.git("config", "merge.hostile.driver", `touch '${marker}'; exit 0`);
  const result = collectThreeWayConflictFacts(f.options);
  assert.equal(result.code, "MERGE_ATTRIBUTES_UNSUPPORTED");
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(marker), false);
});

test("conflict collector does not consume a repository merge.default executable", async (t) => {
  const f = await isolatedConflictFixture(t);
  const marker = path.join(f.root, "driver-ran");
  f.git("config", "merge.hostile.driver", `touch '${marker}'; exit 0`);
  f.git("config", "merge.default", "hostile");
  const result = collectThreeWayConflictFacts(f.options);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(marker), false);
  assert.equal(result.status, "PASS", JSON.stringify(result));
  assert.deepEqual(result.conflicts.map(row => row.path), ["a.txt"]);
});

test("conflict collector preserves a tab in a NUL-delimited conflict path", async (t) => {
  const file = "tab\tname.txt";
  const f = await isolatedConflictFixture(t, file);
  const result = collectThreeWayConflictFacts(f.options);
  assert.equal(result.status, "PASS", JSON.stringify(result));
  assert.deepEqual(result.conflicts.map(row => row.path), [file]);
});

test("conflict collector rejects a supplied base different from the unique merge base", async (t) => {
  const f = await isolatedConflictFixture(t);
  assert.equal(collectThreeWayConflictFacts({ ...f.options,
    mergeBaseCommit: f.options.branchPreRefreshCommit }).code, "MERGE_BASE_MISMATCH");
});

test("admission refuses non-Copy conflicts and mislabeled Copy resolutions", () => {
  const d = admission();
  const eligibility = "docs/evidence/site-builder/copy-runtime-eligibility.json";
  const conflict = { path: eligibility, hunkCount: 1, baseBlobId: COMMIT,
    branchBlobId: COMMIT, mainBlobId: COMMIT, resultBlobId: COMMIT,
    resolutionSource: "LIVE_MAIN_GIT_BLOB" };
  d.conflicts = [conflict];
  assert.equal(validateCurrentMainAdmissionStructure(d).status, "PASS");
  for (const delta of [
    { path: "apps/api/src/discovery/suppression-policy-lock.ts" },
    { resultBlobId: "f".repeat(40) },
    { resolutionSource: "COPY_FIXED_SOURCE_SYNC_HUMAN_CITATIONS_V1" },
  ]) {
    assert.equal(validateCurrentMainAdmissionStructure({ ...d, conflicts: [{ ...conflict, ...delta }] }).status,
      "HOLD", JSON.stringify(delta));
  }
});
