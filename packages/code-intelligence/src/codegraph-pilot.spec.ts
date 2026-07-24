import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  assertActiveSnapshotReady,
  assertNoUntrackedIndexInputs,
  calculatePathPrecision,
  CodeGraphEvaluationV1,
  CodeGraphIndexEvidenceV1,
  CodeGraphStatusV1,
  contractImpactPaths,
  contractSearchPaths,
  evaluateAdoptionGates,
  evaluateCodeGraphStatus,
  externalBoundaryControlPasses,
  extractGitArchive,
  extractTrackedWorktreeSnapshot,
  measureIncrementalUpdate,
} from "./codegraph-pilot";
import { ContractGraphV1, GraphNodeV1 } from "./schema";

const execFile = promisify(execFileCallback);

function evidence(): CodeGraphIndexEvidenceV1 {
  return {
    schemaVersion: "codegraph-index-evidence/v1",
    target: "active",
    codeGraphVersion: "1.5.0",
    telemetry: "DISABLED",
    accessMode: "READ_ONLY_QUERY",
    branch: "codex/codegraph-pilot",
    commit: "a".repeat(40),
    commitTime: "2026-07-25T00:00:00.000Z",
    dirty: false,
    sourceHash: "b".repeat(64),
    repositoryRoot: "/global/backend",
    logicalWorktreePath: "/global/backend/.codex/worktrees/codegraph-pilot",
    projectPath: "/global/backend/.codex/worktrees/codegraph-pilot",
    indexPath: "/global/backend/.codex/worktrees/codegraph-pilot/.codegraph",
    indexedAt: "2026-07-25T00:00:01.000Z",
    indexState: "complete",
    pendingRefs: 0,
    buildVersion: "1.5.0",
    extractionVersion: 13,
    stats: {
      files: 800,
      nodes: 12_000,
      edges: 40_000,
      databaseBytes: 1_000_000,
      fullBuildMs: 2_000,
    },
  };
}

function current(): CodeGraphStatusV1["current"] {
  const value = evidence();
  return {
    target: "active",
    branch: value.branch,
    commit: value.commit,
    dirty: false,
    sourceHash: value.sourceHash,
    repositoryRoot: value.repositoryRoot,
    logicalWorktreePath: value.logicalWorktreePath,
    projectPath: value.projectPath,
    indexPath: value.indexPath,
    indexState: "complete",
    pendingRefs: 0,
    pendingChanges: 0,
    buildVersion: "1.5.0",
    extractionVersion: 13,
    reindexRecommended: false,
  };
}

function metrics(): CodeGraphEvaluationV1["metrics"] {
  return {
    overallAccuracy: 0.9,
    overallRecall: 0.9,
    criticalDynamicRecall: 1,
    codeGraphPrecision: 0.8,
    codeGraphRecall: 0.8,
    codeGraphRoutedPrecision: 0.9,
    codeGraphRoutedRecall: 0.9,
    contractGraphPrecision: 0.9,
    contractGraphRecall: 0.9,
    rgBaselineRecall: 1,
    medianCodeGraphMs: 1,
    medianContractGraphMs: 1,
    medianRgAndReadMs: 4,
    medianUnifiedMs: 2,
    unifiedTimeReductionVsRg: 0.5,
    maxUnifiedQueryMs: 5,
    fullBuildMs: 2_000,
    incrementalUpdateMs: 20,
    worktreeCommitAccuracy: 1,
    sensitivePathLeaks: 0,
  };
}

test("fresh exact index passes every fail-closed status check", () => {
  const result = evaluateCodeGraphStatus(evidence(), current());
  assert.equal(result.ok, true);
  assert.deepEqual(result.diagnostics, []);
});

test("version, branch, commit, source and worktree drift are all visible", () => {
  const indexed = evidence();
  indexed.codeGraphVersion = "9.9.9";
  const now = current();
  now.branch = "main";
  now.commit = "c".repeat(40);
  now.sourceHash = "d".repeat(64);
  now.projectPath = "/global/backend";
  now.indexState = "partial";
  now.pendingRefs = 2;
  now.pendingChanges = 3;
  now.buildVersion = "9.9.9";
  now.reindexRecommended = true;

  const result = evaluateCodeGraphStatus(indexed, now);
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.diagnostics.map((item) => item.code),
    [
      "CODEGRAPH_VERSION_MISMATCH",
      "WRONG_COMMIT",
      "WRONG_BRANCH",
      "STALE_CODEGRAPH_INDEX",
      "WRONG_WORKTREE",
      "INCOMPLETE_CODEGRAPH_INDEX",
      "PENDING_CODEGRAPH_REFERENCES",
      "CODEGRAPH_STATE_EVIDENCE_MISMATCH",
      "UNSYNCED_CODEGRAPH_CHANGES",
      "CODEGRAPH_REINDEX_REQUIRED",
      "CODEGRAPH_BUILD_VERSION_MISMATCH",
      "CODEGRAPH_BUILD_EVIDENCE_MISMATCH",
    ],
  );
});

test("derived evidence cannot redirect a query to another target or path", () => {
  const indexed = evidence();
  indexed.target = "main";
  indexed.telemetry = "DISABLED";
  indexed.accessMode = "READ_ONLY_QUERY";
  indexed.repositoryRoot = "/other/repository";
  indexed.logicalWorktreePath = "/other/worktree";
  indexed.indexPath = "/other/worktree/.codegraph";

  const result = evaluateCodeGraphStatus(indexed, current());
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.diagnostics.map((item) => item.code),
    [
      "WRONG_INDEX_TARGET",
      "WRONG_REPOSITORY_ROOT",
      "WRONG_LOGICAL_WORKTREE",
      "WRONG_INDEX_PATH",
    ],
  );
});

test("status rejects evidence that does not prove the safe query mode", () => {
  const indexed = evidence();
  (
    indexed as CodeGraphIndexEvidenceV1 & {
      telemetry: string;
    }
  ).telemetry = "ENABLED";

  const result = evaluateCodeGraphStatus(indexed, current());
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.diagnostics.map((item) => item.code),
    ["UNSAFE_CODEGRAPH_MODE"],
  );
});

test("default adoption requires every gate without exceptions", () => {
  const passing = evaluateAdoptionGates(metrics());
  assert.equal(
    Object.values(passing).every((gate) => gate.passed),
    true,
  );

  const failingMetrics = metrics();
  failingMetrics.criticalDynamicRecall = 0.99;
  const failing = evaluateAdoptionGates(failingMetrics);
  assert.equal(failing.criticalDynamicRecall.passed, false);
  assert.equal(
    Object.values(failing).every((gate) => gate.passed),
    false,
  );

  const routedFailureMetrics = metrics();
  routedFailureMetrics.codeGraphRoutedRecall = 0.899;
  const routedFailure = evaluateAdoptionGates(routedFailureMetrics);
  assert.equal(routedFailure.codeGraphRoutedRecall.passed, false);
});

test("ContractGraph search freezes initial matches before one-hop expansion", () => {
  const node = (
    id: string,
    file: string,
    kind: GraphNodeV1["kind"] = "code_symbol",
  ): GraphNodeV1 => ({
    id,
    kind,
    label: kind === "source_file" ? file : id,
    attributes: {},
    locations: [{ path: file, line: 1 }],
  });
  const graph: ContractGraphV1 = {
    schemaVersion: "contract-graph/v1",
    evidence: {
      schemaVersion: "evidence-ref/v1",
      repositoryRoot: "/repo",
      worktreePath: "/repo",
      branch: "main",
      commit: "a".repeat(40),
      commitTime: "2026-07-25T00:00:00.000Z",
      dirty: false,
      sourceHash: "b".repeat(64),
    },
    nodes: [
      node("A", "a.ts"),
      node("B", "b.ts", "source_file"),
      node("C", "c.ts", "source_file"),
    ],
    edges: [
      {
        id: "edge:A:B",
        kind: "calls",
        from: "A",
        to: "B",
        attributes: {},
        locations: [],
      },
      {
        id: "edge:B:C",
        kind: "calls",
        from: "B",
        to: "C",
        attributes: {},
        locations: [],
      },
    ],
    diagnostics: [],
  };

  assert.deepEqual(contractSearchPaths(graph, "A"), ["a.ts", "b.ts"]);
});

test("ContractGraph impact resolves dynamic and data nodes back to source paths", () => {
  const graph: ContractGraphV1 = {
    schemaVersion: "contract-graph/v1",
    evidence: {
      schemaVersion: "evidence-ref/v1",
      repositoryRoot: "/repo",
      worktreePath: "/repo",
      branch: "main",
      commit: "a".repeat(40),
      commitTime: "2026-07-25T00:00:00.000Z",
      dirty: false,
      sourceHash: "b".repeat(64),
    },
    nodes: [
      {
        id: "activity:temporal:buildSite",
        kind: "activity",
        label: "buildSite",
        attributes: {},
        locations: [
          {
            path: "apps/api/src/temporal/site-builder.activities.ts",
            line: 10,
          },
          {
            path: "apps/api/src/temporal/site-builder.activities.spec.ts",
            line: 20,
          },
          {
            path: "apps/api/scripts/verify-site-builder.mts",
            line: 30,
          },
        ],
      },
      {
        id: "data-model:prisma:SiteRelease",
        kind: "data_model",
        label: "SiteRelease",
        attributes: {},
        locations: [{ path: "packages/db/prisma/schema.prisma", line: 1327 }],
      },
      {
        id: "file:apps/api/src/site-builder/builds.service.ts",
        kind: "source_file",
        label: "apps/api/src/site-builder/builds.service.ts",
        attributes: {},
        locations: [],
      },
    ],
    edges: [],
    diagnostics: [],
  };

  assert.deepEqual(
    contractImpactPaths(graph, [
      "activity:temporal:buildSite",
      "data-model:prisma:SiteRelease",
      "file:apps/api/src/site-builder/builds.service.ts",
    ]),
    [
      "apps/api/src/site-builder/builds.service.ts",
      "apps/api/src/temporal/site-builder.activities.ts",
      "packages/db/prisma/schema.prisma",
    ],
  );
});

test("external ownership control binds canonical blocker/status and rejects a proven local frontend consumer", () => {
  const graph: ContractGraphV1 = {
    schemaVersion: "contract-graph/v1",
    evidence: {
      schemaVersion: "evidence-ref/v1",
      repositoryRoot: "/repo",
      worktreePath: "/repo",
      branch: "main",
      commit: "a".repeat(40),
      commitTime: "2026-07-25T00:00:00.000Z",
      dirty: false,
      sourceHash: "b".repeat(64),
    },
    nodes: [
      {
        id: "governance:OWN-SAAS-FE",
        kind: "owner",
        label: "OWN-SAAS-FE",
        attributes: { assignee: "UNASSIGNED" },
        locations: [],
      },
      {
        id: "governance:OBJ-BLK-001",
        kind: "business_object",
        label: "OBJ-BLK-001",
        attributes: {
          boundaryStatus: "OPEN_EXTERNAL_OWNERSHIP_BLOCKER",
        },
        locations: [],
      },
      {
        id: "governance:CAP-SITE-RELEASE-001",
        kind: "capability",
        label: "CAP-SITE-RELEASE-001",
        attributes: { productStatus: "APPROVED_NOT_BUILT" },
        locations: [],
      },
      {
        id: "data-model:prisma:SiteRelease",
        kind: "data_model",
        label: "SiteRelease",
        attributes: {},
        locations: [],
      },
    ],
    edges: [],
    diagnostics: [],
  };
  const boundary = {
    ownerNode: "governance:OWN-SAAS-FE",
    boundaryNode: "governance:OBJ-BLK-001",
    capabilityNode: "governance:CAP-SITE-RELEASE-001",
    contractNode: "data-model:prisma:SiteRelease",
    requiredBoundaryStatus: "OPEN_EXTERNAL_OWNERSHIP_BLOCKER",
    requiredCapabilityStatus: "APPROVED_NOT_BUILT",
  };
  assert.equal(externalBoundaryControlPasses(graph, boundary), true);

  graph.nodes.push({
    id: "symbol:apps/frontend/src/releases.ts#consumeRelease",
    kind: "code_symbol",
    label: "consumeRelease",
    attributes: {},
    locations: [{ path: "apps/frontend/src/releases.ts", line: 1 }],
  });
  graph.edges.push({
    id: "edge:frontend-consumer",
    kind: "consumes",
    from: "symbol:apps/frontend/src/releases.ts#consumeRelease",
    to: "data-model:prisma:SiteRelease",
    attributes: { confidence: "PROVEN_RUNTIME" },
    locations: [{ path: "apps/frontend/src/releases.ts", line: 1 }],
  });
  assert.equal(externalBoundaryControlPasses(graph, boundary), false);
});

test("path precision counts extra returned paths as false positives", () => {
  assert.equal(
    calculatePathPrecision(
      ["expected.ts", "unrelated.ts"],
      ["expected.ts"],
      true,
    ),
    0.5,
  );
  assert.equal(calculatePathPrecision([], ["expected.ts"], true), 0);
});

test("active indexing rejects every non-ignored untracked file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codegraph-untracked-"));
  try {
    await execFile("git", ["init", "--quiet"], { cwd: root });
    await execFile("git", ["config", "user.email", "test@example.invalid"], {
      cwd: root,
    });
    await execFile("git", ["config", "user.name", "ContractGraph Test"], {
      cwd: root,
    });
    await writeFile(
      path.join(root, ".gitignore"),
      ".codegraph/\n.code-intelligence/\n",
    );
    await writeFile(path.join(root, "tracked.ts"), "export const safe = 1;\n");
    await writeFile(
      path.join(root, "credentials.json"),
      '{"token":"must-never-enter-snapshot"}\n',
    );
    await execFile(
      "git",
      ["add", ".gitignore", "tracked.ts", "credentials.json"],
      { cwd: root },
    );
    await execFile("git", ["commit", "--quiet", "-m", "fixture"], {
      cwd: root,
    });
    await assertNoUntrackedIndexInputs(root);

    await writeFile(
      path.join(root, "recovery.ts"),
      "export const secret = 'must-not-index';\n",
    );
    await assert.rejects(assertNoUntrackedIndexInputs(root), /recovery\.ts/);
    await execFile("git", ["add", "recovery.ts"], { cwd: root });
    await assertNoUntrackedIndexInputs(root);

    const snapshot = path.join(
      root,
      ".code-intelligence",
      "codegraph-active",
      "source",
    );
    await writeFile(
      path.join(root, "concurrent-recovery.ts"),
      "export const lateSecret = 'must-never-enter-snapshot';\n",
    );
    const initialTrackedPaths = await extractTrackedWorktreeSnapshot(
      root,
      snapshot,
    );
    await assert.rejects(
      readFile(path.join(snapshot, "concurrent-recovery.ts"), "utf8"),
    );
    await assert.rejects(
      readFile(path.join(snapshot, "credentials.json"), "utf8"),
    );
    await assert.rejects(
      assertActiveSnapshotReady(root, snapshot, initialTrackedPaths),
      /untracked files/,
    );
    await rm(path.join(root, "concurrent-recovery.ts"));
    assert.match(
      await assertActiveSnapshotReady(root, snapshot, initialTrackedPaths),
      /^[a-f0-9]{64}$/,
    );
    await execFile("git", ["rm", "--quiet", "tracked.ts"], { cwd: root });
    await assert.rejects(
      assertActiveSnapshotReady(root, snapshot, initialTrackedPaths),
      /tracked path set changed/,
    );
    assert.equal(
      await readFile(path.join(snapshot, "tracked.ts"), "utf8"),
      "export const safe = 1;\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("incremental benchmark proves old symbol removal and new symbol indexing", async () => {
  const elapsedMs = await measureIncrementalUpdate();
  assert.equal(Number.isFinite(elapsedMs), true);
  assert.equal(elapsedMs >= 0, true);
});

test("main archive extraction replaces a pre-existing wrong snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codegraph-archive-"));
  try {
    await execFile("git", ["init", "--quiet"], { cwd: root });
    await execFile("git", ["config", "user.email", "test@example.invalid"], {
      cwd: root,
    });
    await execFile("git", ["config", "user.name", "ContractGraph Test"], {
      cwd: root,
    });
    await writeFile(path.join(root, "truth.txt"), "from git\n");
    await execFile("git", ["add", "truth.txt"], { cwd: root });
    await execFile("git", ["commit", "--quiet", "-m", "fixture"], {
      cwd: root,
    });
    const { stdout } = await execFile("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    });
    const destination = path.join(
      root,
      ".code-intelligence",
      "codegraph-main",
      stdout.trim(),
      "source",
    );
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "wrong.txt"), "not from git\n");

    await extractGitArchive(root, stdout.trim(), destination);

    assert.equal(
      await readFile(path.join(destination, "truth.txt"), "utf8"),
      "from git\n",
    );
    await assert.rejects(readFile(path.join(destination, "wrong.txt"), "utf8"));

    await rm(destination, { recursive: true, force: true });
    await symlink(path.join(root, "truth.txt"), destination);
    await assert.rejects(
      extractGitArchive(root, stdout.trim(), destination),
      /symlink/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
