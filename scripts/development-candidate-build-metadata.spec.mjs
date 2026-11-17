import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installCandidateBuildMetadata } from "./development-candidate-build-metadata.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "candidate-metadata-"));
  const source = join(root, "input.json"),
    output = join(root, "runtime-candidate.json");
  const value = {
    schemaVersion: "development-candidate-marker/v1",
    candidateCommit: "a".repeat(40),
    trustedWorkflowCommit: "b".repeat(40),
    authorizationSha256: "c".repeat(64),
    instanceManifestSha256: "d".repeat(64),
    instanceId: "pump-ab",
    workspaceIds: [
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
    ],
    validUntil: "2099-01-01T00:00:00.000Z",
  };
  return { source, output, value, buildSha: value.candidateCommit };
}
test("normal release builds never silently consume candidate metadata", () => {
  const f = fixture();
  installCandidateBuildMetadata({ ...f, candidateMode: "" });
  assert.equal(existsSync(f.output), false);
  writeFileSync(f.source, JSON.stringify(f.value));
  assert.throws(() =>
    installCandidateBuildMetadata({ ...f, candidateMode: "" }),
  );
});
test("candidate metadata is included before artifact hashing, bound to source and not overwritten", () => {
  const f = fixture();
  writeFileSync(f.source, JSON.stringify(f.value));
  installCandidateBuildMetadata({ ...f, candidateMode: "1" });
  assert.deepEqual(JSON.parse(readFileSync(f.output)), f.value);
  assert.throws(() =>
    installCandidateBuildMetadata({ ...f, candidateMode: "1" }),
  );
});
test("missing, unknown, mismatched or oversized candidate build input is refused", () => {
  const f = fixture();
  assert.throws(() =>
    installCandidateBuildMetadata({ ...f, candidateMode: "1" }),
  );
  for (const patch of [
    { candidateCommit: "b".repeat(40) },
    { workspaceIds: [] },
    { schemaVersion: "release" },
    { verified: true },
  ]) {
    writeFileSync(f.source, JSON.stringify({ ...f.value, ...patch }));
    assert.throws(() =>
      installCandidateBuildMetadata({ ...f, candidateMode: "1" }),
    );
  }
  writeFileSync(f.source, " ".repeat(16_385));
  assert.throws(() =>
    installCandidateBuildMetadata({ ...f, candidateMode: "1" }),
  );
  assert.throws(() =>
    installCandidateBuildMetadata({ ...f, candidateMode: "yes" }),
  );
});
