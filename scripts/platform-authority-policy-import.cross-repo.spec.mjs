import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const BACKEND_ROOT = resolve(import.meta.dirname, "..");
const AUTHORITY_ROOT = resolve(
  process.env.GROWTHOS_AUTHORITY_ROOT ?? "/global/frontend/growthos-source",
);
const EXPECTED = Object.freeze({
  reviewedHeadCommit: "17e68953ff2e26ac8433db5aa49689e5f9283659",
  reviewedHeadTree: "46832215fc8189b4c2c71dc56b653d2eac401d7c",
  artifactCommit: "cb572a149d44ab402d5cfcdaaa0aeb21c053ad9e",
  artifactCommitTree: "953a4345900b8aeabc64ee582e02a86873d1be52",
  patchBlobSha: "ba5ffc2642cca2d95167c22574d76be425f5d1b4",
  patchSha256:
    "2a6943a17bc6c31d76b9266b98834fb0dd5e2cf2abf67f5f74d0ea358bf37fd9",
  archiveSha256:
    "5906e7a287843c7bafd8d7bb20aa930d1ae97eb6cf2946110d27ecc3a5dfc75a",
  artifactCommitPatchStackSha256:
    "a660488367c5197f84469c39524ae322cdb50973493ba9c3066e8346156143ce",
  artifactSha256:
    "f9e9591731772f974b087307b5d0365c58c86b501232804c77a20fd3592db01b",
});

function git(args, input) {
  return execFileSync("git", args, {
    cwd: AUTHORITY_ROOT,
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("clean reviewed GrowthOS authority independently materializes the exact Backend successor import", async (t) => {
  assert.equal(
    git(["rev-parse", `${EXPECTED.reviewedHeadCommit}^{tree}`]),
    EXPECTED.reviewedHeadTree,
  );
  execFileSync(
    "git",
    ["merge-base", "--is-ancestor", EXPECTED.reviewedHeadCommit, "HEAD"],
    { cwd: AUTHORITY_ROOT, stdio: "ignore" },
  );
  assert.equal(git(["status", "--porcelain=v1"]), "");

  const [archiveBytes, artifactCommitStackBytes, patchBytes] = await Promise.all([
    readFile(resolve(AUTHORITY_ROOT, "source.tar.gz")),
    Promise.resolve(
      Buffer.from(
        git(["show", `${EXPECTED.artifactCommit}:PATCH_STACK.json`]),
        "utf8",
      ),
    ),
    readFile(resolve(AUTHORITY_ROOT, "patches/0057-platform-authority-policy-successor.patch")),
  ]);
  assert.equal(sha256(archiveBytes), EXPECTED.archiveSha256);
  assert.equal(
    sha256(Buffer.concat([artifactCommitStackBytes, Buffer.from("\n")])),
    EXPECTED.artifactCommitPatchStackSha256,
  );
  assert.equal(
    git(["hash-object", "--stdin"], patchBytes),
    EXPECTED.patchBlobSha,
  );
  assert.equal(sha256(patchBytes), EXPECTED.patchSha256);
  assert.equal(
    git(["rev-parse", `${EXPECTED.artifactCommit}^{tree}`]),
    EXPECTED.artifactCommitTree,
  );

  const temporary = await mkdtemp(
    resolve(tmpdir(), "backend-growthos-policy-import-"),
  );
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const target = resolve(temporary, "source");
  const materializer = await import(
    pathToFileURL(resolve(AUTHORITY_ROOT, "scripts/materialize-source.mjs"))
      .href
  );
  await materializer.materializeGrowthosSource({
    authorityRoot: AUTHORITY_ROOT,
    target,
  });

  const [materializedBytes, importedBytes, importedProvenanceBytes] =
    await Promise.all([
      readFile(
        resolve(target, "ops/policy/platform-authority-policy-matrix-v2.json"),
      ),
      readFile(
        resolve(
          BACKEND_ROOT,
          "apps/api/src/platform-authority/platform-authority-policy-matrix-v2.json",
        ),
      ),
      readFile(
        resolve(
          BACKEND_ROOT,
          "apps/api/src/platform-authority/platform-authority-policy-provenance-v2.json",
        ),
      ),
    ]);
  assert.equal(materializedBytes.byteLength, 15_583);
  assert.equal(sha256(materializedBytes), EXPECTED.artifactSha256);
  assert.deepEqual(importedBytes, materializedBytes);
  assert.deepEqual(JSON.parse(importedProvenanceBytes.toString("utf8")), {
    schema_version: "growthos-platform-authority-policy-provenance/v2",
    artifact: {
      materialized_path: "ops/policy/platform-authority-policy-matrix-v2.json",
      byte_length: 15_583,
      sha256: EXPECTED.artifactSha256,
    },
    growthos_authority: {
      reviewed_head_commit: EXPECTED.reviewedHeadCommit,
      reviewed_head_tree: EXPECTED.reviewedHeadTree,
      artifact_commit: EXPECTED.artifactCommit,
      artifact_commit_tree: EXPECTED.artifactCommitTree,
      patch_path: "patches/0057-platform-authority-policy-successor.patch",
      patch_blob_sha1: EXPECTED.patchBlobSha,
      patch_sha256: EXPECTED.patchSha256,
      artifact_commit_patch_stack_sha256:
        EXPECTED.artifactCommitPatchStackSha256,
      source_archive_sha256: EXPECTED.archiveSha256,
    },
  });
});
