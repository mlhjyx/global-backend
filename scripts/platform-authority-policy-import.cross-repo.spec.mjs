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
  commitSha: "290c6f9f6a41c7c39dfe071683252982536937d8",
  treeSha: "3d04b799ed8f87fa5d9b71ff003f2cd2eb822289",
  patchBlobSha: "40dc2fe631470827fdf9ea5ddc9d6fdbcaf144d2",
  archiveSha256:
    "5906e7a287843c7bafd8d7bb20aa930d1ae97eb6cf2946110d27ecc3a5dfc75a",
  patchStackSha256:
    "ced29b101ad1ff88b875f41a726fc988160eccc6d36526034be271f77f500fff",
  artifactSha256:
    "248a416e72a8c2590a5c6c8adb941f4105c6ac3e722bc85ced3a77f404784fa1",
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

test("clean GrowthOS 4A0 independently materializes the exact Backend policy import", async (t) => {
  assert.equal(git(["rev-parse", "HEAD"]), EXPECTED.commitSha);
  assert.equal(git(["rev-parse", "HEAD^{tree}"]), EXPECTED.treeSha);
  assert.equal(git(["status", "--porcelain=v1"]), "");

  const [archiveBytes, stackBytes, patchBytes] = await Promise.all([
    readFile(resolve(AUTHORITY_ROOT, "source.tar.gz")),
    readFile(resolve(AUTHORITY_ROOT, "PATCH_STACK.json")),
    readFile(
      resolve(
        AUTHORITY_ROOT,
        "patches/0054-platform-authority-policy-candidate.patch",
      ),
    ),
  ]);
  assert.equal(sha256(archiveBytes), EXPECTED.archiveSha256);
  assert.equal(sha256(stackBytes), EXPECTED.patchStackSha256);
  assert.equal(
    git(["hash-object", "--stdin"], patchBytes),
    EXPECTED.patchBlobSha,
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
        resolve(target, "ops/policy/platform-authority-policy-matrix-v1.json"),
      ),
      readFile(
        resolve(
          BACKEND_ROOT,
          "apps/api/src/platform-authority/platform-authority-policy-matrix-v1.json",
        ),
      ),
      readFile(
        resolve(
          BACKEND_ROOT,
          "apps/api/src/platform-authority/platform-authority-policy-provenance-v1.json",
        ),
      ),
    ]);
  assert.equal(materializedBytes.byteLength, 3121);
  assert.equal(sha256(materializedBytes), EXPECTED.artifactSha256);
  assert.deepEqual(importedBytes, materializedBytes);
  assert.deepEqual(JSON.parse(importedProvenanceBytes.toString("utf8")), {
    schema_version: "growthos-platform-authority-policy-provenance/v1",
    artifact: {
      path: "ops/policy/platform-authority-policy-matrix-v1.json",
      sha256: EXPECTED.artifactSha256,
    },
    authority: {
      commit_sha: EXPECTED.commitSha,
      tree_sha: EXPECTED.treeSha,
      patch_blob_sha: EXPECTED.patchBlobSha,
    },
    source: {
      archive_sha256: EXPECTED.archiveSha256,
      patch_stack_sha256: EXPECTED.patchStackSha256,
    },
  });
});
