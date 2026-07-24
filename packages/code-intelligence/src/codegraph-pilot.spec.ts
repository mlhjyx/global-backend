import assert from "node:assert/strict";
import test from "node:test";
import {
  CodeGraphEvaluationV1,
  CodeGraphIndexEvidenceV1,
  CodeGraphStatusV1,
  evaluateAdoptionGates,
  evaluateCodeGraphStatus,
} from "./codegraph-pilot";

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
    codeGraphRecall: 0.8,
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
});
