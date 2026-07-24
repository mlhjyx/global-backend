import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  computeSourceHash,
  createEvidence,
  graphFreshnessDiagnostics,
  readGraph,
  writeDerivedArtifacts,
} from "./scan";
import { ContractGraphV1, CoverageReportV1, EvidenceRefV1 } from "./schema";

test("source hashing excludes secrets while binding relevant source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "contract-hash-test-"));
  try {
    await mkdir(path.join(root, "apps", "api"), { recursive: true });
    await writeFile(path.join(root, ".gitleaks.toml"), "[allowlist]\n");
    await writeFile(
      path.join(root, "apps", "api", "source.ts"),
      "export const value = 1;\n",
    );
    await writeFile(
      path.join(root, "apps", "api", "page.astro"),
      "<h1>first</h1>\n",
    );
    await writeFile(
      path.join(root, "apps", "api", "Dockerfile"),
      "FROM scratch\n",
    );
    await writeFile(
      path.join(root, "apps", "api", "global.css"),
      "body { color: black; }\n",
    );
    await writeFile(
      path.join(root, "apps", "api", "egress.py"),
      "def allow_public_only(): return True\n",
    );
    await writeFile(
      path.join(root, "apps", "api", "runtime.toml"),
      'mode = "safe"\n',
    );
    await writeFile(path.join(root, "apps", "api", ".env"), "SECRET=first\n");
    await writeFile(
      path.join(root, "apps", "api", "credentials-prod.json"),
      '{"private_key":"first"}\n',
    );
    const first = await computeSourceHash(root);
    await writeFile(path.join(root, "apps", "api", ".env"), "SECRET=second\n");
    await writeFile(
      path.join(root, "apps", "api", "credentials-prod.json"),
      '{"private_key":"second"}\n',
    );
    assert.equal(await computeSourceHash(root), first);
    await writeFile(
      path.join(root, "apps", "api", "page.astro"),
      "<h1>second</h1>\n",
    );
    const afterAstro = await computeSourceHash(root);
    assert.notEqual(afterAstro, first);
    await writeFile(
      path.join(root, "apps", "api", "Dockerfile"),
      "FROM node:22\n",
    );
    const afterDockerfile = await computeSourceHash(root);
    assert.notEqual(afterDockerfile, afterAstro);
    await writeFile(
      path.join(root, "apps", "api", "global.css"),
      "body { color: white; }\n",
    );
    const afterCss = await computeSourceHash(root);
    assert.notEqual(afterCss, afterDockerfile);
    await writeFile(
      path.join(root, "apps", "api", "egress.py"),
      "def allow_public_only(): return False\n",
    );
    const afterPython = await computeSourceHash(root);
    assert.notEqual(afterPython, afterCss);
    await writeFile(
      path.join(root, "apps", "api", "runtime.toml"),
      'mode = "blocked"\n',
    );
    const afterToml = await computeSourceHash(root);
    assert.notEqual(afterToml, afterPython);
    await writeFile(
      path.join(root, ".gitleaks.toml"),
      "[allowlist]\npaths=[]\n",
    );
    const afterRootConfig = await computeSourceHash(root);
    assert.notEqual(afterRootConfig, afterToml);
    await writeFile(
      path.join(root, "apps", "api", "logo.png"),
      Buffer.from([0, 1, 2, 3]),
    );
    assert.equal(await computeSourceHash(root), afterRootConfig);
    await writeFile(
      path.join(root, "apps", "api", "source.ts"),
      "export const value = 2;\n",
    );
    assert.notEqual(await computeSourceHash(root), afterRootConfig);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("derived graph manifest rejects artifact tampering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "contract-artifact-test-"));
  const evidence: EvidenceRefV1 = {
    schemaVersion: "evidence-ref/v1",
    repositoryRoot: root,
    worktreePath: root,
    branch: "codex/test",
    commit: "a".repeat(40),
    commitTime: "2026-07-25T00:00:00Z",
    dirty: false,
    sourceHash: "b".repeat(64),
  };
  const graph: ContractGraphV1 = {
    schemaVersion: "contract-graph/v1",
    evidence,
    nodes: [],
    edges: [],
    diagnostics: [],
  };
  const coverage: CoverageReportV1 = {
    schemaVersion: "contract-graph-coverage/v1",
    evidence,
    totals: { nodes: 0, edges: 0, files: 0, errors: 0, warnings: 0 },
    mechanisms: [],
    unknownMechanisms: [],
  };
  try {
    await writeDerivedArtifacts(root, { graph, coverage });
    assert.equal((await readGraph(root)).schemaVersion, "contract-graph/v1");
    await writeFile(
      path.join(root, ".code-intelligence", "graph-v1.json"),
      '{"schemaVersion":"contract-graph/v1","nodes":[],"edges":[],"diagnostics":[]}\n',
    );
    await assert.rejects(readGraph(root), /artifact integrity check failed/);
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
