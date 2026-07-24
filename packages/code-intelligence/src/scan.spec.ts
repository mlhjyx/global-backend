import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  computeSourceHash,
  createEvidence,
  graphFreshnessDiagnostics,
} from "./scan";
import { ContractGraphV1 } from "./schema";

test("source hashing excludes secrets while binding relevant source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "contract-hash-test-"));
  try {
    await mkdir(path.join(root, "apps", "api"), { recursive: true });
    await writeFile(
      path.join(root, "apps", "api", "source.ts"),
      "export const value = 1;\n",
    );
    await writeFile(path.join(root, "apps", "api", ".env"), "SECRET=first\n");
    const first = await computeSourceHash(root);
    await writeFile(path.join(root, "apps", "api", ".env"), "SECRET=second\n");
    assert.equal(await computeSourceHash(root), first);
    await writeFile(
      path.join(root, "apps", "api", "source.ts"),
      "export const value = 2;\n",
    );
    assert.notEqual(await computeSourceHash(root), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("freshness rejects a wrong worktree and stale source hash", async () => {
  const repositoryRoot = path.resolve(__dirname, "../../..");
  const evidence = await createEvidence(repositoryRoot);
  const graph: ContractGraphV1 = {
    schemaVersion: "contract-graph/v1",
    evidence: {
      ...evidence,
      worktreePath: `${evidence.worktreePath}-other`,
      sourceHash: "0".repeat(64),
    },
    nodes: [],
    edges: [],
    diagnostics: [],
  };
  const diagnostics = await graphFreshnessDiagnostics(repositoryRoot, graph);
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.code === "WRONG_WORKTREE"),
    true,
  );
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.code === "STALE_GRAPH"),
    true,
  );
});
