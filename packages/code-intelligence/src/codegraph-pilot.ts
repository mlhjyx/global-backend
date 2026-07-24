import type { CodeGraph as CodeGraphInstance } from "@colbymchenry/codegraph";
import { execFile as execFileCallback } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  lstat,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import goldenQuestionDocument from "../golden-questions.json";
import { createImpactReport } from "./impact";
import {
  computeSourceHash,
  createEvidence,
  graphFreshnessDiagnostics,
  readGraph,
} from "./scan";
import { ContractGraphV1, GraphEdgeKind, GraphNodeV1 } from "./schema";
import { sha256, stableJson, uniqueSorted } from "./utils";

const execFile = promisify(execFileCallback);
export const PINNED_CODEGRAPH_VERSION = "1.5.0";

export type CodeGraphIndexTarget = "active" | "main";

interface CodeGraphIndexStatsV1 {
  files: number;
  nodes: number;
  edges: number;
  databaseBytes: number;
  fullBuildMs: number;
}

export interface CodeGraphIndexEvidenceV1 {
  schemaVersion: "codegraph-index-evidence/v1";
  target: CodeGraphIndexTarget;
  codeGraphVersion: string;
  telemetry: "DISABLED";
  accessMode: "READ_ONLY_QUERY";
  branch: string;
  commit: string;
  commitTime: string;
  dirty: boolean;
  sourceHash: string;
  repositoryRoot: string;
  logicalWorktreePath: string;
  projectPath: string;
  indexPath: string;
  indexedAt: string;
  indexState: string | null;
  pendingRefs: number;
  buildVersion: string | null;
  extractionVersion: number | null;
  stats: CodeGraphIndexStatsV1;
}

export interface CodeGraphStatusV1 {
  schemaVersion: "codegraph-status/v1";
  ok: boolean;
  evidence: CodeGraphIndexEvidenceV1;
  current: {
    target: CodeGraphIndexTarget;
    branch: string;
    commit: string;
    dirty: boolean;
    sourceHash: string;
    repositoryRoot: string;
    logicalWorktreePath: string;
    projectPath: string;
    indexPath: string;
    indexState: string | null;
    pendingRefs: number;
    pendingChanges: number;
    buildVersion: string | null;
    extractionVersion: number | null;
    reindexRecommended: boolean;
  };
  diagnostics: Array<{
    code: string;
    message: string;
  }>;
}

interface ExternalBoundaryContractV1 {
  ownerNode: string;
  boundaryNode: string;
  capabilityNode: string;
  contractNode: string;
  requiredBoundaryStatus: string;
  requiredCapabilityStatus: string;
}

interface GoldenQuestionV1 {
  id: string;
  category: string;
  kind?:
    "SEARCH" | "NO_CALLERS" | "EXTERNAL_OWNED_CONTROL" | "WRONG_BRANCH_CONTROL";
  question: string;
  query: string;
  baselinePattern: string;
  expectedPaths: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  unifiedSources?: Array<"codegraph" | "contractgraph">;
  expectedNodes?: string[];
  expectedEdges?: ExpectedEdgeV1[];
  externalBoundary?: ExternalBoundaryContractV1;
  expectedOutcome?: string;
  criticalDynamic?: boolean;
}

interface ExpectedEdgeV1 {
  from: string;
  to: string;
  kind: GraphEdgeKind;
  confidence: string | null;
}

interface GoldenQuestionDocumentV1 {
  schemaVersion: "code-intelligence-golden-questions/v1";
  questions: GoldenQuestionV1[];
}

interface EngineObservationV1 {
  paths: string[];
  elapsedMs: number;
}

interface GoldenQuestionResultV1 {
  id: string;
  category: string;
  question: string;
  expectedPaths: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  unifiedSources: Array<"codegraph" | "contractgraph">;
  codeGraph: EngineObservationV1;
  contractGraph: EngineObservationV1;
  rgAndRead: EngineObservationV1;
  unifiedElapsedMs: number;
  unifiedPaths: string[];
  foundExpectedPaths: string[];
  missingExpectedPaths: string[];
  falsePositivePaths: string[];
  returnedForbiddenPaths: string[];
  expectedNodes: string[];
  foundExpectedNodes: string[];
  missingExpectedNodes: string[];
  expectedEdges: ExpectedEdgeV1[];
  foundExpectedEdges: ExpectedEdgeV1[];
  missingExpectedEdges: ExpectedEdgeV1[];
  pathPrecision: number;
  sourceClassification:
    | "BOTH_STATIC_GRAPHS"
    | "CODEGRAPH_ONLY"
    | "CONTRACT_GRAPH_ONLY"
    | "RG_BASELINE_ONLY"
    | "NOT_FOUND"
    | "CONTROL";
  controlOutcome?: {
    expected: string;
    actual: string;
    passed: boolean;
  };
  passed: boolean;
  criticalDynamic: boolean;
}

export interface CodeGraphEvaluationV1 {
  schemaVersion: "codegraph-evaluation/v1";
  generatedAt: string;
  evidence: {
    active: CodeGraphIndexEvidenceV1;
    main: CodeGraphIndexEvidenceV1;
  };
  totals: {
    questions: number;
    expectedFacts: number;
    foundFacts: number;
    returnedPaths: number;
    relevantReturnedPaths: number;
    passedQuestions: number;
  };
  metrics: {
    overallAccuracy: number;
    overallRecall: number;
    criticalDynamicRecall: number;
    codeGraphPrecision: number;
    codeGraphRecall: number;
    codeGraphRoutedPrecision: number;
    codeGraphRoutedRecall: number;
    contractGraphPrecision: number;
    contractGraphRecall: number;
    rgBaselineRecall: number;
    medianCodeGraphMs: number;
    medianContractGraphMs: number;
    medianRgAndReadMs: number;
    medianUnifiedMs: number;
    unifiedTimeReductionVsRg: number;
    maxUnifiedQueryMs: number;
    fullBuildMs: number;
    incrementalUpdateMs: number;
    worktreeCommitAccuracy: number;
    sensitivePathLeaks: number;
  };
  gates: Record<
    string,
    {
      passed: boolean;
      actual: number | boolean;
      required: number | boolean | string;
    }
  >;
  adoption: "DEFAULT_READ_ONLY" | "PILOT_ONLY";
  results: GoldenQuestionResultV1[];
  notes: string[];
}

function disableTelemetry(): void {
  process.env.CODEGRAPH_TELEMETRY = "0";
  process.env.DO_NOT_TRACK = "1";
}

async function loadCodeGraph(): Promise<typeof CodeGraphInstance> {
  disableTelemetry();
  const module = await import("@colbymchenry/codegraph");
  return module.default;
}

async function git(repositoryRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

function evidenceDirectory(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".code-intelligence");
}

function activeEvidencePath(repositoryRoot: string): string {
  return path.join(
    evidenceDirectory(repositoryRoot),
    "codegraph-active-v1.json",
  );
}

function activeSnapshotRoot(repositoryRoot: string): string {
  return path.join(
    evidenceDirectory(repositoryRoot),
    "codegraph-active",
    "source",
  );
}

function mainSnapshotRoot(repositoryRoot: string, commit: string): string {
  return path.join(
    evidenceDirectory(repositoryRoot),
    "codegraph-main",
    commit,
    "source",
  );
}

function mainEvidencePath(repositoryRoot: string, commit: string): string {
  return path.join(
    evidenceDirectory(repositoryRoot),
    "codegraph-main",
    commit,
    "evidence-v1.json",
  );
}

async function pruneOldMainSnapshots(
  repositoryRoot: string,
  keepCommit: string,
): Promise<void> {
  const root = path.join(evidenceDirectory(repositoryRoot), "codegraph-main");
  if (!(await pathExists(root))) return;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.name === keepCommit ||
      !/^[0-9a-f]{40}$/.test(entry.name)
    ) {
      continue;
    }
    await rm(path.join(root, entry.name), { recursive: true, force: true });
  }
}

async function atomicWrite(file: string, body: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await stat(value);
    return true;
  } catch {
    return false;
  }
}

async function assertNoSymlinkComponents(
  repositoryRoot: string,
  target: string,
): Promise<void> {
  const relative = path.relative(repositoryRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`snapshot path escapes repository root: ${target}`);
  }
  let current = repositoryRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`snapshot path contains symlink: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function assertArchiveHasNoSymlinks(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`git archive contains unsupported symlink: ${absolute}`);
    }
    if (entry.isDirectory()) await assertArchiveHasNoSymlinks(absolute);
  }
}

export async function extractGitArchive(
  repositoryRoot: string,
  commit: string,
  destination: string,
): Promise<void> {
  const parent = path.dirname(destination);
  await assertNoSymlinkComponents(repositoryRoot, parent);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(repositoryRoot, destination);
  const temporaryRoot = await mkdtemp(path.join(parent, ".source-tmp-"));
  const temporary = path.join(temporaryRoot, "source");
  const archivePath = path.join(temporaryRoot, "archive.tar");
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  const backup = path.join(parent, `.source-old-${process.pid}-${Date.now()}`);
  let movedExisting = false;
  try {
    await execFile(
      "git",
      [
        "-C",
        repositoryRoot,
        "archive",
        "--format=tar",
        `--output=${archivePath}`,
        commit,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    await execFile("tar", ["-xf", archivePath, "-C", temporary], {
      maxBuffer: 16 * 1024 * 1024,
    });
    await rm(archivePath, { force: true });
    await assertArchiveHasNoSymlinks(temporary);
    if (await pathExists(destination)) {
      await rename(destination, backup);
      movedExisting = true;
    }
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (movedExisting) await rename(backup, destination);
      throw error;
    }
    if (movedExisting) {
      await rm(backup, { recursive: true, force: true });
      movedExisting = false;
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
    if (movedExisting && !(await pathExists(destination))) {
      await rename(backup, destination);
      movedExisting = false;
    }
    if (!movedExisting) {
      await rm(backup, { recursive: true, force: true });
    }
  }
}

function sensitivePath(relative: string): boolean {
  const normalized = relative.toLowerCase();
  return (
    /(?:^|\/)\.env(?:\.|$)/.test(normalized) ||
    /(?:^|\/)(?:\.secrets|secrets|credentials)(?:\/|$)/.test(normalized) ||
    /(?:^|\/)(?:id_rsa|id_ed25519)(?:\.pub)?$/.test(normalized) ||
    /(?:credentials?|service-account|service_account|secrets?)(?:[._-].*)?\.json$/.test(
      normalized,
    ) ||
    /\.(?:pem|key|p12|pfx|crt|cer|der)$/.test(normalized)
  );
}

export async function assertNoUntrackedIndexInputs(
  repositoryRoot: string,
): Promise<void> {
  const output = await git(repositoryRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const untracked = output
    .split("\u0000")
    .filter(Boolean)
    .map((value) => value.replaceAll("\\", "/"))
    .sort();
  if (untracked.length === 0) return;
  throw new Error(
    `refusing active CodeGraph index with non-ignored untracked files: ${untracked.slice(0, 20).join(", ")}${untracked.length > 20 ? ` (+${untracked.length - 20} more)` : ""}`,
  );
}

async function trackedInputPaths(repositoryRoot: string): Promise<string[]> {
  const output = await git(repositoryRoot, ["ls-files", "--cached", "-z"]);
  return uniqueSorted(
    output
      .split("\u0000")
      .filter(Boolean)
      .map((value) => {
        if (value.includes("\\")) {
          throw new Error(
            `tracked CodeGraph path contains unsupported backslash: ${value}`,
          );
        }
        return value;
      })
      .filter((value) => {
        if (
          value.length === 0 ||
          path.posix.isAbsolute(value) ||
          value.startsWith("../") ||
          value.includes("/../")
        ) {
          throw new Error(
            `unsafe tracked path for CodeGraph snapshot: ${value}`,
          );
        }
        return !sensitivePath(value);
      }),
  );
}

async function trackedInputHash(
  root: string,
  trackedPaths: string[],
): Promise<string> {
  const entries: string[] = [];
  for (const relative of trackedPaths) {
    const absolute = path.join(root, relative);
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new Error(
          `tracked CodeGraph input is a symlink and cannot be indexed: ${relative}`,
        );
      }
      if (!info.isFile()) {
        throw new Error(
          `tracked CodeGraph input is not a regular file: ${relative}`,
        );
      }
      entries.push(`${relative}\u0000${sha256(await readFile(absolute))}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        entries.push(`${relative}\u0000DELETED`);
        continue;
      }
      throw error;
    }
  }
  return sha256(entries.join("\n"));
}

export async function extractTrackedWorktreeSnapshot(
  repositoryRoot: string,
  destination: string,
): Promise<string[]> {
  const resolved = path.resolve(repositoryRoot);
  const parent = path.dirname(destination);
  await assertNoSymlinkComponents(resolved, parent);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(resolved, destination);
  const trackedPaths = await trackedInputPaths(resolved);
  const temporaryRoot = await mkdtemp(path.join(parent, ".source-tmp-"));
  const temporary = path.join(temporaryRoot, "source");
  const backup = path.join(parent, `.source-old-${process.pid}-${Date.now()}`);
  let movedExisting = false;
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    for (const relative of trackedPaths) {
      const source = path.join(resolved, relative);
      let info;
      try {
        info = await lstat(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (info.isSymbolicLink()) {
        throw new Error(
          `tracked CodeGraph input is a symlink and cannot be indexed: ${relative}`,
        );
      }
      if (!info.isFile()) {
        throw new Error(
          `tracked CodeGraph input is not a regular file: ${relative}`,
        );
      }
      const target = path.join(temporary, relative);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target);
    }
    if (await pathExists(destination)) {
      await rename(destination, backup);
      movedExisting = true;
    }
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (movedExisting) await rename(backup, destination);
      throw error;
    }
    if (movedExisting) {
      await rm(backup, { recursive: true, force: true });
      movedExisting = false;
    }
    return trackedPaths;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
    if (movedExisting && !(await pathExists(destination))) {
      await rename(backup, destination);
      movedExisting = false;
    }
    if (!movedExisting) {
      await rm(backup, { recursive: true, force: true });
    }
  }
}

export async function assertActiveSnapshotReady(
  repositoryRoot: string,
  snapshotRoot: string,
): Promise<string> {
  await assertNoUntrackedIndexInputs(repositoryRoot);
  const trackedPaths = await trackedInputPaths(repositoryRoot);
  const [worktreeHash, snapshotHash] = await Promise.all([
    trackedInputHash(repositoryRoot, trackedPaths),
    trackedInputHash(snapshotRoot, trackedPaths),
  ]);
  if (worktreeHash !== snapshotHash) {
    throw new Error(
      "refusing active CodeGraph evidence because the tracked worktree changed while its immutable snapshot was built",
    );
  }
  return worktreeHash;
}

async function activeWorktreeSourceHash(
  repositoryRoot: string,
): Promise<string> {
  try {
    await assertNoUntrackedIndexInputs(repositoryRoot);
  } catch {
    return "UNTRACKED_INPUTS_PRESENT";
  }
  return trackedInputHash(
    repositoryRoot,
    await trackedInputPaths(repositoryRoot),
  );
}

async function indexProject(projectPath: string): Promise<{
  graph: CodeGraphInstance;
  fullBuildMs: number;
}> {
  const CodeGraph = await loadCodeGraph();
  const graph = CodeGraph.isInitialized(projectPath)
    ? await CodeGraph.recreate(projectPath)
    : await CodeGraph.init(projectPath, { index: false });
  const started = performance.now();
  const result = await graph.indexAll();
  const fullBuildMs = performance.now() - started;
  const errors = result.errors.filter(
    (error) => error.severity === "error" || error.code === "index_partial",
  );
  if (errors.length > 0 || graph.getIndexState() !== "complete") {
    graph.close();
    throw new Error(
      `CodeGraph index is incomplete: ${errors.map((error) => error.message).join("; ")}`,
    );
  }
  return { graph, fullBuildMs };
}

async function buildIndexEvidence(
  repositoryRoot: string,
  target: CodeGraphIndexTarget,
  projectPath: string,
  graph: CodeGraphInstance,
  fullBuildMs: number,
  sourceHash?: string,
): Promise<CodeGraphIndexEvidenceV1> {
  const stats = graph.getStats();
  const build = graph.getIndexBuildInfo();
  const repositoryEvidence = await createEvidence(repositoryRoot);
  const commit =
    target === "main"
      ? await git(repositoryRoot, ["rev-parse", "origin/main"])
      : await git(repositoryRoot, ["rev-parse", "HEAD"]);
  const branch =
    target === "main"
      ? "main"
      : (await git(repositoryRoot, ["branch", "--show-current"])) || "DETACHED";
  const commitTime = await git(repositoryRoot, [
    "show",
    "-s",
    "--format=%cI",
    commit,
  ]);
  const dirty =
    target === "main"
      ? false
      : (
          await git(repositoryRoot, [
            "status",
            "--porcelain=v1",
            "--untracked-files=normal",
          ])
        ).length > 0;
  return {
    schemaVersion: "codegraph-index-evidence/v1",
    target,
    codeGraphVersion: PINNED_CODEGRAPH_VERSION,
    telemetry: "DISABLED",
    accessMode: "READ_ONLY_QUERY",
    branch,
    commit,
    commitTime,
    dirty,
    sourceHash: sourceHash ?? (await computeSourceHash(projectPath)),
    repositoryRoot: repositoryEvidence.repositoryRoot,
    logicalWorktreePath:
      target === "main" ? repositoryEvidence.repositoryRoot : repositoryRoot,
    projectPath,
    indexPath: path.join(projectPath, ".codegraph"),
    indexedAt: new Date(graph.getLastIndexedAt() ?? Date.now()).toISOString(),
    indexState: graph.getIndexState(),
    pendingRefs: graph.getPendingReferenceCount(),
    buildVersion: build.version,
    extractionVersion: build.extractionVersion,
    stats: {
      files: stats.fileCount,
      nodes: stats.nodeCount,
      edges: stats.edgeCount,
      databaseBytes: stats.dbSizeBytes,
      fullBuildMs,
    },
  };
}

export async function buildCodeGraphIndex(
  repositoryRoot: string,
  target: CodeGraphIndexTarget,
): Promise<CodeGraphIndexEvidenceV1> {
  const resolved = path.resolve(repositoryRoot);
  if (target === "active") {
    await assertNoUntrackedIndexInputs(resolved);
  }
  const mainCommit = await git(resolved, ["rev-parse", "origin/main"]);
  const projectPath =
    target === "active"
      ? activeSnapshotRoot(resolved)
      : mainSnapshotRoot(resolved, mainCommit);
  if (target === "main") {
    await extractGitArchive(resolved, mainCommit, projectPath);
  } else {
    await extractTrackedWorktreeSnapshot(resolved, projectPath);
  }
  try {
    const { graph, fullBuildMs } = await indexProject(projectPath);
    try {
      const activeSourceHash =
        target === "active"
          ? await assertActiveSnapshotReady(resolved, projectPath)
          : undefined;
      const evidence = await buildIndexEvidence(
        resolved,
        target,
        projectPath,
        graph,
        fullBuildMs,
        activeSourceHash,
      );
      const file =
        target === "active"
          ? activeEvidencePath(resolved)
          : mainEvidencePath(resolved, mainCommit);
      await atomicWrite(file, stableJson(evidence));
      if (target === "main") {
        await pruneOldMainSnapshots(resolved, mainCommit);
      }
      return evidence;
    } finally {
      graph.close();
    }
  } catch (error) {
    if (target === "active") {
      await rm(projectPath, { recursive: true, force: true });
      await rm(activeEvidencePath(resolved), { force: true });
    }
    throw error;
  }
}

async function readIndexEvidence(
  repositoryRoot: string,
  target: CodeGraphIndexTarget,
): Promise<CodeGraphIndexEvidenceV1> {
  const commit =
    target === "main"
      ? await git(repositoryRoot, ["rev-parse", "origin/main"])
      : "";
  const file =
    target === "active"
      ? activeEvidencePath(repositoryRoot)
      : mainEvidencePath(repositoryRoot, commit);
  return JSON.parse(await readFile(file, "utf8")) as CodeGraphIndexEvidenceV1;
}

export function evaluateCodeGraphStatus(
  evidence: CodeGraphIndexEvidenceV1,
  current: CodeGraphStatusV1["current"],
): CodeGraphStatusV1 {
  const diagnostics: CodeGraphStatusV1["diagnostics"] = [];
  const mismatch = (code: string, message: string): void => {
    diagnostics.push({ code, message });
  };
  if (evidence.codeGraphVersion !== PINNED_CODEGRAPH_VERSION) {
    mismatch(
      "CODEGRAPH_VERSION_MISMATCH",
      `expected ${PINNED_CODEGRAPH_VERSION}, found ${evidence.codeGraphVersion}`,
    );
  }
  if (evidence.target !== current.target) {
    mismatch(
      "WRONG_INDEX_TARGET",
      `index target ${evidence.target} does not match ${current.target}`,
    );
  }
  if (
    evidence.telemetry !== "DISABLED" ||
    evidence.accessMode !== "READ_ONLY_QUERY"
  ) {
    mismatch(
      "UNSAFE_CODEGRAPH_MODE",
      "index evidence does not prove telemetry-disabled read-only operation",
    );
  }
  if (evidence.commit !== current.commit) {
    mismatch(
      "WRONG_COMMIT",
      "index commit does not match the requested target",
    );
  }
  if (evidence.branch !== current.branch) {
    mismatch(
      "WRONG_BRANCH",
      `index branch ${evidence.branch} does not match ${current.branch}`,
    );
  }
  if (evidence.sourceHash !== current.sourceHash) {
    mismatch("STALE_CODEGRAPH_INDEX", "source hash changed after indexing");
  }
  if (
    path.resolve(evidence.projectPath) !== path.resolve(current.projectPath)
  ) {
    mismatch(
      "WRONG_WORKTREE",
      "index project path does not match the requested target",
    );
  }
  if (
    path.resolve(evidence.repositoryRoot) !==
    path.resolve(current.repositoryRoot)
  ) {
    mismatch(
      "WRONG_REPOSITORY_ROOT",
      "index repository root does not match the canonical main worktree",
    );
  }
  if (
    path.resolve(evidence.logicalWorktreePath) !==
    path.resolve(current.logicalWorktreePath)
  ) {
    mismatch(
      "WRONG_LOGICAL_WORKTREE",
      "index logical worktree does not match the requested target",
    );
  }
  if (path.resolve(evidence.indexPath) !== path.resolve(current.indexPath)) {
    mismatch(
      "WRONG_INDEX_PATH",
      "index database path does not match the requested project",
    );
  }
  if (current.indexState !== "complete") {
    mismatch("INCOMPLETE_CODEGRAPH_INDEX", "index state is not complete");
  }
  if (current.pendingRefs !== 0) {
    mismatch(
      "PENDING_CODEGRAPH_REFERENCES",
      "reference resolution did not finish",
    );
  }
  if (
    evidence.indexState !== current.indexState ||
    evidence.pendingRefs !== current.pendingRefs
  ) {
    mismatch(
      "CODEGRAPH_STATE_EVIDENCE_MISMATCH",
      "recorded index state does not match the read-only database",
    );
  }
  if (current.pendingChanges !== 0) {
    mismatch(
      "UNSYNCED_CODEGRAPH_CHANGES",
      "files changed after the last index",
    );
  }
  if (current.reindexRecommended) {
    mismatch("CODEGRAPH_REINDEX_REQUIRED", "index extraction version is stale");
  }
  if (current.buildVersion !== PINNED_CODEGRAPH_VERSION) {
    mismatch(
      "CODEGRAPH_BUILD_VERSION_MISMATCH",
      "index was built by a different CodeGraph version",
    );
  }
  if (
    evidence.buildVersion !== current.buildVersion ||
    evidence.extractionVersion !== current.extractionVersion
  ) {
    mismatch(
      "CODEGRAPH_BUILD_EVIDENCE_MISMATCH",
      "recorded build metadata does not match the read-only database",
    );
  }
  return {
    schemaVersion: "codegraph-status/v1",
    ok: diagnostics.length === 0,
    evidence,
    current,
    diagnostics,
  };
}

export async function getCodeGraphStatus(
  repositoryRoot: string,
  target: CodeGraphIndexTarget,
): Promise<CodeGraphStatusV1> {
  const resolved = path.resolve(repositoryRoot);
  const evidence = await readIndexEvidence(resolved, target);
  const repositoryEvidence = await createEvidence(resolved);
  const commit =
    target === "main"
      ? await git(resolved, ["rev-parse", "origin/main"])
      : repositoryEvidence.commit;
  const projectPath =
    target === "main"
      ? mainSnapshotRoot(resolved, commit)
      : activeSnapshotRoot(resolved);
  const CodeGraph = await loadCodeGraph();
  const graph = await CodeGraph.open(projectPath, {
    readOnly: true,
    sync: false,
  });
  try {
    const changes = graph.getChangedFiles();
    const build = graph.getIndexBuildInfo();
    const current: CodeGraphStatusV1["current"] = {
      target,
      branch: target === "main" ? "main" : repositoryEvidence.branch,
      commit,
      dirty: target === "main" ? false : repositoryEvidence.dirty,
      sourceHash:
        target === "main"
          ? await computeSourceHash(projectPath)
          : await activeWorktreeSourceHash(resolved),
      repositoryRoot: repositoryEvidence.repositoryRoot,
      logicalWorktreePath:
        target === "main" ? repositoryEvidence.repositoryRoot : resolved,
      projectPath,
      indexPath: path.join(projectPath, ".codegraph"),
      indexState: graph.getIndexState(),
      pendingRefs: graph.getPendingReferenceCount(),
      pendingChanges:
        changes.added.length + changes.modified.length + changes.removed.length,
      buildVersion: build.version,
      extractionVersion: build.extractionVersion,
      reindexRecommended: graph.isIndexStale(),
    };
    return evaluateCodeGraphStatus(evidence, current);
  } finally {
    graph.close();
  }
}

async function requireHealthyCodeGraph(
  repositoryRoot: string,
  target: CodeGraphIndexTarget,
): Promise<{
  graph: CodeGraphInstance;
  evidence: CodeGraphIndexEvidenceV1;
}> {
  const status = await getCodeGraphStatus(repositoryRoot, target);
  if (!status.ok) {
    throw new Error(
      `refusing CodeGraph query: ${status.diagnostics.map((item) => item.code).join(", ")}`,
    );
  }
  const CodeGraph = await loadCodeGraph();
  const graph = await CodeGraph.open(status.evidence.projectPath, {
    readOnly: true,
    sync: false,
  });
  return { graph, evidence: status.evidence };
}

export function contractSearchPaths(
  graph: ContractGraphV1,
  query: string,
): string[] {
  const normalized = query.toLowerCase();
  const searchValues = (node: GraphNodeV1): string[] =>
    [
      node.id,
      node.label,
      ...Object.values(node.attributes).flatMap((value) =>
        Array.isArray(value) ? value : value == null ? [] : [String(value)],
      ),
    ].map((value) => value.toLowerCase());
  const exact = graph.nodes.filter((node) => {
    const values = searchValues(node);
    return (
      values.includes(normalized) ||
      node.label.toLowerCase().endsWith(`/${normalized}`)
    );
  });
  const concreteExact = exact.filter(
    (node) => !node.id.startsWith("symbol-ref:"),
  );
  const matched = (
    concreteExact.length > 0
      ? concreteExact
      : exact.length > 0
        ? exact
        : graph.nodes.filter((node) =>
            searchValues(node).some((value) => value.includes(normalized)),
          )
  ).slice(0, 20);
  const initialIds = new Set(matched.map((node) => node.id));
  const ids = new Set(initialIds);
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const edge of graph.edges) {
    const neighbor = initialIds.has(edge.from)
      ? nodesById.get(edge.to)
      : initialIds.has(edge.to)
        ? nodesById.get(edge.from)
        : undefined;
    if (neighbor?.kind === "source_file") {
      ids.add(neighbor.id);
    }
    if (ids.size >= 100) break;
  }
  return uniqueSorted(
    graph.nodes
      .filter((node) => ids.has(node.id))
      .flatMap((node) =>
        node.kind === "source_file" || node.kind === "test"
          ? [node.label]
          : node.locations.map((location) => location.path),
      )
      .filter((value) => !value.startsWith("docs/archive/")),
  );
}

export function contractImpactPaths(
  graph: ContractGraphV1,
  impactedNodeIds: string[],
): string[] {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const isTestEvidence = (value: string): boolean =>
    /\.(?:spec|test)\.(?:ts|tsx|mts)$/.test(value) ||
    /(?:^|\/)scripts\/verify-/.test(value);
  return uniqueSorted(
    impactedNodeIds.flatMap((id) => {
      const node = nodes.get(id);
      const candidates = id.startsWith("file:")
        ? [id.slice(5)]
        : (node?.locations.map((location) => location.path) ?? []);
      const normalized = candidates
        .map((value) => value.replaceAll("\\", "/").replace(/^\.\//, ""))
        .filter(
          (value) =>
            value.length > 0 &&
            !path.posix.isAbsolute(value) &&
            !value.startsWith("../") &&
            !value.startsWith("docs/archive/") &&
            !sensitivePath(value),
        );
      const implementationLocations = normalized.filter(
        (value) => !isTestEvidence(value),
      );
      return implementationLocations.length > 0
        ? implementationLocations
        : normalized;
    }),
  );
}

function edgeMatchesExpectation(
  graph: ContractGraphV1,
  expected: ExpectedEdgeV1,
): boolean {
  return graph.edges.some(
    (edge) =>
      edge.from === expected.from &&
      edge.to === expected.to &&
      edge.kind === expected.kind &&
      (typeof edge.attributes.confidence === "string"
        ? edge.attributes.confidence
        : null) === expected.confidence,
  );
}

export function externalBoundaryControlPasses(
  graph: ContractGraphV1,
  boundary: ExternalBoundaryContractV1,
): boolean {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const owner = nodes.get(boundary.ownerNode);
  const blocker = nodes.get(boundary.boundaryNode);
  const capability = nodes.get(boundary.capabilityNode);
  const contract = nodes.get(boundary.contractNode);
  const exactRegistryBoundary =
    owner?.kind === "owner" &&
    owner.attributes.assignee === "UNASSIGNED" &&
    blocker?.kind === "business_object" &&
    blocker.attributes.boundaryStatus === boundary.requiredBoundaryStatus &&
    capability?.kind === "capability" &&
    capability.attributes.productStatus === boundary.requiredCapabilityStatus &&
    contract?.kind === "data_model";

  const localFrontendNodes = new Set(
    graph.nodes
      .filter(
        (node) =>
          /(?:^|:)(?:apps|packages)\/frontend\//.test(node.id) ||
          node.locations.some((location) =>
            /^(?:apps|packages)\/frontend\//.test(location.path),
          ),
      )
      .map((node) => node.id),
  );
  const contractSurfaces = new Set(
    graph.nodes
      .filter(
        (node) =>
          node.id === boundary.contractNode ||
          (["api", "event", "service", "data_model"].includes(node.kind) &&
            /site.?release/i.test(`${node.id}\n${node.label}`)),
      )
      .map((node) => node.id),
  );
  const provenLocalConsumer = graph.edges.some(
    (edge) =>
      localFrontendNodes.has(edge.from) &&
      contractSurfaces.has(edge.to) &&
      ["calls", "consumes", "reads", "references", "routes_to"].includes(
        edge.kind,
      ) &&
      edge.attributes.confidence === "PROVEN_RUNTIME",
  );
  return exactRegistryBoundary && !provenLocalConsumer;
}

export function calculatePathPrecision(
  returnedPaths: string[],
  allowedPaths: string[],
  hasExpectedPaths: boolean,
): number {
  if (returnedPaths.length === 0) return hasExpectedPaths ? 0 : 1;
  return (
    returnedPaths.filter((value) => allowedPaths.includes(value)).length /
    returnedPaths.length
  );
}

async function requireFreshContractGraph(
  repositoryRoot: string,
): Promise<ContractGraphV1> {
  const graph = await readGraph(repositoryRoot);
  const diagnostics = await graphFreshnessDiagnostics(repositoryRoot, graph);
  if (diagnostics.length > 0) {
    throw new Error(
      `refusing ContractGraph query: ${diagnostics.map((item) => item.code).join(", ")}`,
    );
  }
  return graph;
}

export async function createUnifiedImpactReport(
  repositoryRoot: string,
  changedPaths: string[],
): Promise<unknown> {
  const resolved = path.resolve(repositoryRoot);
  const normalized = uniqueSorted(
    changedPaths.map((value) =>
      value.replaceAll("\\", "/").replace(/^\.\//, ""),
    ),
  );
  const contractGraph = await requireFreshContractGraph(resolved);
  const contract = createImpactReport(contractGraph, normalized);
  const { graph: codeGraph, evidence } = await requireHealthyCodeGraph(
    resolved,
    "active",
  );
  try {
    const affected = new Map<
      string,
      { path: string; symbols: string[]; reasons: string[] }
    >();
    const blindSpots: string[] = [];
    for (const changedPath of normalized) {
      const nodes = codeGraph.getNodesInFile(changedPath);
      const dependents = codeGraph.getFileDependents(changedPath);
      if (nodes.length === 0) blindSpots.push(changedPath);
      for (const dependent of dependents) {
        affected.set(dependent, {
          path: dependent,
          symbols: [],
          reasons: [`depends on ${changedPath}`],
        });
      }
      for (const node of nodes.slice(0, 50)) {
        const impact = codeGraph.getImpactRadius(node.id, 2);
        for (const candidate of impact.nodes.values()) {
          if (candidate.filePath === changedPath) continue;
          const current = affected.get(candidate.filePath) ?? {
            path: candidate.filePath,
            symbols: [],
            reasons: [],
          };
          current.symbols.push(candidate.qualifiedName || candidate.name);
          current.reasons.push(
            `impact from ${node.qualifiedName || node.name}`,
          );
          affected.set(candidate.filePath, current);
        }
      }
    }
    const codeGraphPaths = uniqueSorted(affected.keys());
    const contractPaths = contractImpactPaths(
      contractGraph,
      contract.codeImpact,
    );
    const gitDiff = (
      await git(resolved, [
        "diff",
        "--name-only",
        "--diff-filter=ACDMRTUXB",
        "origin/main...HEAD",
      ])
    )
      .split("\n")
      .filter(Boolean);
    return {
      schemaVersion: "unified-impact-report/v1",
      generatedAt: new Date().toISOString(),
      evidence: {
        contractGraph: contract.evidence,
        codeGraph: evidence,
        git: {
          base: await git(resolved, ["rev-parse", "origin/main"]),
          head: await git(resolved, ["rev-parse", "HEAD"]),
          changedPaths: gitDiff,
        },
      },
      changedPaths: normalized,
      businessImpact: contract.businessImpact,
      codeImpact: {
        contractGraph: contract.codeImpact,
        codeGraph: [...affected.values()]
          .map((item) => ({
            ...item,
            symbols: uniqueSorted(item.symbols).slice(0, 50),
            reasons: uniqueSorted(item.reasons).slice(0, 20),
          }))
          .sort((left, right) => left.path.localeCompare(right.path)),
        combinedPaths: uniqueSorted([...contractPaths, ...codeGraphPaths]),
      },
      tests: contract.recommendedTests,
      disagreements: {
        contractGraphOnly: contractPaths.filter(
          (value) => !codeGraphPaths.includes(value),
        ),
        codeGraphOnly: codeGraphPaths.filter(
          (value) => !contractPaths.includes(value),
        ),
        interpretation:
          "A disagreement is a review queue, not proof that either static tool is correct.",
      },
      knownBlindSpots: blindSpots.map((value) => ({
        path: value,
        status: "NOT_INDEXED_BY_CODEGRAPH",
        fallback: "ContractGraph + source + tests",
      })),
      risks: contract.risks,
      unknowns: contract.unknowns,
      rollback: contract.rollback,
    };
  } finally {
    codeGraph.close();
  }
}

async function readReturnedSources(
  repositoryRoot: string,
  paths: string[],
): Promise<void> {
  await Promise.all(
    paths.slice(0, 10).map(async (relative) => {
      const absolute = path.join(repositoryRoot, relative);
      if (await pathExists(absolute)) await readFile(absolute);
    }),
  );
}

async function observeCodeGraph(
  graph: CodeGraphInstance,
  question: GoldenQuestionV1,
): Promise<EngineObservationV1> {
  const started = performance.now();
  const results = graph.searchNodes(question.query, { limit: 50 });
  const normalized = question.query.toLowerCase();
  const exact = results.filter((result) => {
    const name = result.node.name.toLowerCase();
    const qualified = result.node.qualifiedName.toLowerCase();
    return (
      name === normalized ||
      qualified === normalized ||
      qualified.endsWith(`.${normalized}`)
    );
  });
  const selected = exact.length > 0 ? exact : results.slice(0, 5);
  const paths = uniqueSorted(selected.map((result) => result.node.filePath));
  await Promise.all(
    selected.slice(0, 10).map((result) => graph.getCode(result.node.id)),
  );
  return { paths, elapsedMs: performance.now() - started };
}

async function observeContractGraph(
  graph: ContractGraphV1,
  repositoryRoot: string,
  question: GoldenQuestionV1,
): Promise<EngineObservationV1> {
  const started = performance.now();
  const paths = contractSearchPaths(graph, question.query);
  await readReturnedSources(repositoryRoot, paths);
  return { paths, elapsedMs: performance.now() - started };
}

async function observeRgAndRead(
  repositoryRoot: string,
  question: GoldenQuestionV1,
): Promise<EngineObservationV1> {
  const started = performance.now();
  let paths: string[] = [];
  try {
    const { stdout } = await execFile(
      "rg",
      [
        "-l",
        "--fixed-strings",
        "--glob",
        "!node_modules/**",
        "--glob",
        "!dist/**",
        "--glob",
        "!docs/archive/**",
        "--glob",
        "!packages/code-intelligence/golden-questions.json",
        question.baselinePattern,
        ".",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    paths = uniqueSorted(
      stdout
        .split("\n")
        .map((value) => value.replace(/^\.\//, ""))
        .filter(Boolean),
    );
  } catch (error) {
    const exitCode = (error as NodeJS.ErrnoException & { code?: number }).code;
    if (exitCode !== 1) throw error;
  }
  await readReturnedSources(repositoryRoot, paths);
  return { paths, elapsedMs: performance.now() - started };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function recall(results: GoldenQuestionResultV1[], engine: string): number {
  const expected = results.flatMap((result) => result.expectedPaths);
  if (expected.length === 0) return 1;
  let found = 0;
  for (const result of results) {
    const paths =
      engine === "codegraph"
        ? result.codeGraph.paths
        : engine === "contractgraph"
          ? result.contractGraph.paths
          : result.rgAndRead.paths;
    found += result.expectedPaths.filter((value) =>
      paths.includes(value),
    ).length;
  }
  return found / expected.length;
}

function precision(results: GoldenQuestionResultV1[], engine: string): number {
  let returned = 0;
  let relevant = 0;
  for (const result of results) {
    const paths =
      engine === "codegraph"
        ? result.codeGraph.paths
        : result.contractGraph.paths;
    returned += paths.length;
    relevant += paths.filter((value) =>
      result.allowedPaths.includes(value),
    ).length;
  }
  return returned === 0 ? 1 : relevant / returned;
}

function routedResults(
  results: GoldenQuestionResultV1[],
  engine: "codegraph" | "contractgraph",
): GoldenQuestionResultV1[] {
  return results.filter((result) => result.unifiedSources.includes(engine));
}

export async function measureIncrementalUpdate(): Promise<number> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codegraph-incremental-"));
  try {
    await writeFile(
      path.join(root, "entry.ts"),
      "export function before(): number { return 1; }\n",
    );
    const CodeGraph = await loadCodeGraph();
    const graph = await CodeGraph.init(root, { index: true });
    try {
      await writeFile(
        path.join(root, "entry.ts"),
        "export function after(): number { return 2; }\n",
      );
      const started = performance.now();
      await graph.sync();
      const elapsedMs = performance.now() - started;
      const before = graph
        .searchNodes("before", { limit: 20 })
        .map((result) => result.node)
        .find((node) => node.name === "before");
      const after = graph
        .searchNodes("after", { limit: 20 })
        .map((result) => result.node)
        .find((node) => node.name === "after");
      const afterCode = after ? await graph.getCode(after.id) : null;
      const changes = graph.getChangedFiles();
      const pendingChanges =
        changes.added.length + changes.modified.length + changes.removed.length;
      if (
        before !== undefined ||
        after === undefined ||
        !afterCode?.includes("function after") ||
        graph.getIndexState() !== "complete" ||
        graph.getPendingReferenceCount() !== 0 ||
        pendingChanges !== 0 ||
        graph.isIndexStale()
      ) {
        throw new Error(
          `incremental CodeGraph sync did not prove updated graph state: before=${before?.id ?? "absent"} after=${after?.id ?? "absent"} state=${graph.getIndexState()} refs=${graph.getPendingReferenceCount()} changes=${pendingChanges} stale=${graph.isIndexStale()}`,
        );
      }
      return elapsedMs;
    } finally {
      graph.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function evaluateAdoptionGates(
  metrics: CodeGraphEvaluationV1["metrics"],
): CodeGraphEvaluationV1["gates"] {
  return {
    overallAccuracy: {
      passed: metrics.overallAccuracy >= 0.9,
      actual: metrics.overallAccuracy,
      required: ">=0.90",
    },
    overallRecall: {
      passed: metrics.overallRecall >= 0.9,
      actual: metrics.overallRecall,
      required: ">=0.90",
    },
    criticalDynamicRecall: {
      passed: metrics.criticalDynamicRecall === 1,
      actual: metrics.criticalDynamicRecall,
      required: "1.00",
    },
    codeGraphRoutedPrecision: {
      passed: metrics.codeGraphRoutedPrecision >= 0.9,
      actual: metrics.codeGraphRoutedPrecision,
      required: ">=0.90",
    },
    codeGraphRoutedRecall: {
      passed: metrics.codeGraphRoutedRecall >= 0.9,
      actual: metrics.codeGraphRoutedRecall,
      required: ">=0.90",
    },
    worktreeCommitAccuracy: {
      passed: metrics.worktreeCommitAccuracy === 1,
      actual: metrics.worktreeCommitAccuracy,
      required: "1.00",
    },
    sensitivePathLeaks: {
      passed: metrics.sensitivePathLeaks === 0,
      actual: metrics.sensitivePathLeaks,
      required: 0,
    },
    fullBuildMs: {
      passed: metrics.fullBuildMs <= 300_000,
      actual: metrics.fullBuildMs,
      required: "<=300000",
    },
    incrementalUpdateMs: {
      passed: metrics.incrementalUpdateMs <= 30_000,
      actual: metrics.incrementalUpdateMs,
      required: "<=30000",
    },
    commonQueryMs: {
      passed: metrics.maxUnifiedQueryMs <= 10_000,
      actual: metrics.maxUnifiedQueryMs,
      required: "<=10000",
    },
    analysisTimeReduction: {
      passed: metrics.unifiedTimeReductionVsRg >= 0.3,
      actual: metrics.unifiedTimeReductionVsRg,
      required: ">=0.30",
    },
  };
}

export async function evaluateCodeGraphPilot(
  repositoryRoot: string,
): Promise<CodeGraphEvaluationV1> {
  const resolved = path.resolve(repositoryRoot);
  const questions = (goldenQuestionDocument as GoldenQuestionDocumentV1)
    .questions;
  if (questions.length !== 30) {
    throw new Error(`expected 30 golden questions, found ${questions.length}`);
  }
  for (const question of questions) {
    const allowed = question.allowedPaths ?? question.expectedPaths;
    const forbidden = question.forbiddenPaths ?? [];
    const unifiedSources = question.unifiedSources ?? [
      "codegraph",
      "contractgraph",
    ];
    const missingAllowed = question.expectedPaths.filter(
      (value) => !allowed.includes(value),
    );
    const contradictory = allowed.filter((value) => forbidden.includes(value));
    if (
      missingAllowed.length > 0 ||
      contradictory.length > 0 ||
      unifiedSources.length === 0
    ) {
      throw new Error(
        `invalid golden path contract for ${question.id}: missingAllowed=${missingAllowed.join(",")} contradictory=${contradictory.join(",")} unifiedSources=${unifiedSources.join(",")}`,
      );
    }
    if (
      question.criticalDynamic === true &&
      ((question.expectedNodes?.length ?? 0) === 0 ||
        (question.expectedEdges?.length ?? 0) === 0)
    ) {
      throw new Error(
        `critical dynamic question ${question.id} requires exact nodes and edges`,
      );
    }
  }
  const activeStatus = await getCodeGraphStatus(resolved, "active");
  const mainStatus = await getCodeGraphStatus(resolved, "main");
  if (!activeStatus.ok || !mainStatus.ok) {
    throw new Error("both main and active CodeGraph indexes must be fresh");
  }
  const contractGraph = await requireFreshContractGraph(resolved);
  const { graph: codeGraph } = await requireHealthyCodeGraph(
    resolved,
    "active",
  );
  const results: GoldenQuestionResultV1[] = [];
  try {
    for (const question of questions) {
      if (question.kind === "WRONG_BRANCH_CONTROL") {
        const simulatedCurrent = {
          ...activeStatus.current,
          branch: `${activeStatus.current.branch}-wrong`,
        };
        const simulated = evaluateCodeGraphStatus(
          activeStatus.evidence,
          simulatedCurrent,
        );
        const passed = simulated.diagnostics.some(
          (item) => item.code === "WRONG_BRANCH",
        );
        results.push({
          id: question.id,
          category: question.category,
          question: question.question,
          expectedPaths: [],
          allowedPaths: [],
          forbiddenPaths: [],
          unifiedSources: [],
          codeGraph: { paths: [], elapsedMs: 0 },
          contractGraph: { paths: [], elapsedMs: 0 },
          rgAndRead: { paths: [], elapsedMs: 0 },
          unifiedElapsedMs: 0,
          unifiedPaths: [],
          foundExpectedPaths: [],
          missingExpectedPaths: [],
          falsePositivePaths: [],
          returnedForbiddenPaths: [],
          expectedNodes: [],
          foundExpectedNodes: [],
          missingExpectedNodes: [],
          expectedEdges: [],
          foundExpectedEdges: [],
          missingExpectedEdges: [],
          pathPrecision: 1,
          sourceClassification: "CONTROL",
          controlOutcome: {
            expected: question.expectedOutcome ?? "WRONG_BRANCH_REJECTED",
            actual: passed ? "WRONG_BRANCH_REJECTED" : "NOT_REJECTED",
            passed,
          },
          passed,
          criticalDynamic: false,
        });
        continue;
      }
      if (question.kind === "EXTERNAL_OWNED_CONTROL") {
        const started = performance.now();
        const boundary = question.externalBoundary;
        if (!boundary) {
          throw new Error(
            `external-owned control ${question.id} requires an exact externalBoundary contract`,
          );
        }
        const expectedNodes = question.expectedNodes ?? [];
        const foundExpectedNodes = expectedNodes.filter((value) =>
          contractGraph.nodes.some((node) => node.id === value),
        );
        const expectedEdges = question.expectedEdges ?? [];
        const foundExpectedEdges = expectedEdges.filter((value) =>
          edgeMatchesExpectation(contractGraph, value),
        );
        const passed =
          externalBoundaryControlPasses(contractGraph, boundary) &&
          foundExpectedNodes.length === expectedNodes.length &&
          foundExpectedEdges.length === expectedEdges.length;
        const elapsedMs = performance.now() - started;
        results.push({
          id: question.id,
          category: question.category,
          question: question.question,
          expectedPaths: [],
          allowedPaths: [],
          forbiddenPaths: [],
          unifiedSources: [],
          codeGraph: { paths: [], elapsedMs: 0 },
          contractGraph: { paths: [], elapsedMs },
          rgAndRead: { paths: [], elapsedMs: 0 },
          unifiedElapsedMs: elapsedMs,
          unifiedPaths: [],
          foundExpectedPaths: [],
          missingExpectedPaths: [],
          falsePositivePaths: [],
          returnedForbiddenPaths: [],
          expectedNodes,
          foundExpectedNodes,
          missingExpectedNodes: expectedNodes.filter(
            (value) => !foundExpectedNodes.includes(value),
          ),
          expectedEdges,
          foundExpectedEdges,
          missingExpectedEdges: expectedEdges.filter(
            (value) => !foundExpectedEdges.includes(value),
          ),
          pathPrecision: 1,
          sourceClassification: "CONTROL",
          controlOutcome: {
            expected: question.expectedOutcome ?? "EXTERNAL_OWNED",
            actual: passed ? "EXTERNAL_OWNED" : "FALSELY_PROVEN",
            passed,
          },
          passed,
          criticalDynamic: false,
        });
        continue;
      }
      const unifiedStarted = performance.now();
      const [codeObservation, contractObservation] = await Promise.all([
        observeCodeGraph(codeGraph, question),
        observeContractGraph(contractGraph, resolved, question),
      ]);
      const unifiedElapsedMs = performance.now() - unifiedStarted;
      const rgObservation = await observeRgAndRead(resolved, question);
      const unifiedSources = question.unifiedSources ?? [
        "codegraph",
        "contractgraph",
      ];
      const unifiedPaths = uniqueSorted([
        ...(unifiedSources.includes("codegraph") ? codeObservation.paths : []),
        ...(unifiedSources.includes("contractgraph")
          ? contractObservation.paths
          : []),
      ]);
      const allowedPaths = uniqueSorted(
        question.allowedPaths ?? question.expectedPaths,
      );
      const forbiddenPaths = uniqueSorted(question.forbiddenPaths ?? []);
      const foundExpectedPaths = question.expectedPaths.filter((value) =>
        unifiedPaths.includes(value),
      );
      const falsePositivePaths = unifiedPaths.filter(
        (value) => !allowedPaths.includes(value),
      );
      const returnedForbiddenPaths = unifiedPaths.filter((value) =>
        forbiddenPaths.includes(value),
      );
      const expectedNodes = question.expectedNodes ?? [];
      const foundExpectedNodes = expectedNodes.filter((value) =>
        contractGraph.nodes.some((node) => node.id === value),
      );
      const expectedEdges = question.expectedEdges ?? [];
      const foundExpectedEdges = expectedEdges.filter((value) =>
        edgeMatchesExpectation(contractGraph, value),
      );
      const relevantReturnedPaths = unifiedPaths.filter((value) =>
        allowedPaths.includes(value),
      );
      const pathPrecision = calculatePathPrecision(
        unifiedPaths,
        allowedPaths,
        question.expectedPaths.length > 0,
      );
      const codeFound = question.expectedPaths.some((value) =>
        codeObservation.paths.includes(value),
      );
      const contractFound = question.expectedPaths.some((value) =>
        contractObservation.paths.includes(value),
      );
      const rgFound = question.expectedPaths.some((value) =>
        rgObservation.paths.includes(value),
      );
      let controlOutcome: GoldenQuestionResultV1["controlOutcome"];
      if (question.kind === "NO_CALLERS") {
        const candidate = codeGraph
          .searchNodes(question.query, { limit: 50 })
          .map((result) => result.node)
          .find(
            (node) =>
              node.name === question.query &&
              question.expectedPaths.includes(node.filePath),
          );
        const noCallers =
          candidate !== undefined &&
          codeGraph.getCallers(candidate.id).length === 0 &&
          rgObservation.paths.length === 1 &&
          question.expectedPaths.includes(rgObservation.paths[0]);
        controlOutcome = {
          expected: question.expectedOutcome ?? "NO_CALLERS",
          actual: noCallers ? "NO_CALLERS" : "CALLER_OR_AMBIGUITY_FOUND",
          passed: noCallers,
        };
      }
      const allPathsFound =
        foundExpectedPaths.length === question.expectedPaths.length;
      const allNodesFound = foundExpectedNodes.length === expectedNodes.length;
      const allEdgesFound = foundExpectedEdges.length === expectedEdges.length;
      const passed =
        allPathsFound &&
        allNodesFound &&
        allEdgesFound &&
        falsePositivePaths.length === 0 &&
        returnedForbiddenPaths.length === 0 &&
        (controlOutcome === undefined || controlOutcome.passed);
      results.push({
        id: question.id,
        category: question.category,
        question: question.question,
        expectedPaths: question.expectedPaths,
        allowedPaths,
        forbiddenPaths,
        unifiedSources,
        codeGraph: codeObservation,
        contractGraph: contractObservation,
        rgAndRead: rgObservation,
        unifiedElapsedMs,
        unifiedPaths,
        foundExpectedPaths,
        missingExpectedPaths: question.expectedPaths.filter(
          (value) => !foundExpectedPaths.includes(value),
        ),
        falsePositivePaths,
        returnedForbiddenPaths,
        expectedNodes,
        foundExpectedNodes,
        missingExpectedNodes: expectedNodes.filter(
          (value) => !foundExpectedNodes.includes(value),
        ),
        expectedEdges,
        foundExpectedEdges,
        missingExpectedEdges: expectedEdges.filter(
          (value) => !foundExpectedEdges.includes(value),
        ),
        pathPrecision,
        sourceClassification:
          codeFound && contractFound
            ? "BOTH_STATIC_GRAPHS"
            : codeFound
              ? "CODEGRAPH_ONLY"
              : contractFound
                ? "CONTRACT_GRAPH_ONLY"
                : rgFound
                  ? "RG_BASELINE_ONLY"
                  : "NOT_FOUND",
        controlOutcome,
        passed,
        criticalDynamic: question.criticalDynamic === true,
      });
    }
  } finally {
    codeGraph.close();
  }
  const expectedFacts = results.reduce(
    (sum, result) =>
      sum +
      result.expectedPaths.length +
      result.expectedNodes.length +
      result.expectedEdges.length,
    0,
  );
  const foundFacts = results.reduce(
    (sum, result) =>
      sum +
      result.foundExpectedPaths.length +
      result.foundExpectedNodes.length +
      result.foundExpectedEdges.length,
    0,
  );
  const returnedPaths = results.reduce(
    (sum, result) => sum + result.unifiedPaths.length,
    0,
  );
  const relevantReturnedPaths = results.reduce(
    (sum, result) =>
      sum +
      result.unifiedPaths.filter((value) => result.allowedPaths.includes(value))
        .length,
    0,
  );
  const critical = results.filter((result) => result.criticalDynamic);
  const criticalExpectedEdges = critical.reduce(
    (sum, result) => sum + result.expectedEdges.length,
    0,
  );
  const criticalFoundEdges = critical.reduce(
    (sum, result) => sum + result.foundExpectedEdges.length,
    0,
  );
  const sensitivePathLeaks = (
    await (async () => {
      const { graph } = await requireHealthyCodeGraph(resolved, "active");
      try {
        return graph
          .getFiles()
          .map((file) => file.path)
          .filter(sensitivePath);
      } finally {
        graph.close();
      }
    })()
  ).length;
  const medianCodeGraphMs = median(
    results.map((result) => result.codeGraph.elapsedMs),
  );
  const medianContractGraphMs = median(
    results.map((result) => result.contractGraph.elapsedMs),
  );
  const medianRgAndReadMs = median(
    results.map((result) => result.rgAndRead.elapsedMs),
  );
  const unifiedTimes = results.map((result) => result.unifiedElapsedMs);
  const medianUnifiedMs = median(unifiedTimes);
  const metrics: CodeGraphEvaluationV1["metrics"] = {
    overallAccuracy:
      returnedPaths === 0 ? 1 : relevantReturnedPaths / returnedPaths,
    overallRecall: expectedFacts === 0 ? 1 : foundFacts / expectedFacts,
    criticalDynamicRecall:
      criticalExpectedEdges === 0
        ? 1
        : criticalFoundEdges / criticalExpectedEdges,
    codeGraphPrecision: precision(results, "codegraph"),
    codeGraphRecall: recall(results, "codegraph"),
    codeGraphRoutedPrecision: precision(
      routedResults(results, "codegraph"),
      "codegraph",
    ),
    codeGraphRoutedRecall: recall(
      routedResults(results, "codegraph"),
      "codegraph",
    ),
    contractGraphPrecision: precision(results, "contractgraph"),
    contractGraphRecall: recall(results, "contractgraph"),
    rgBaselineRecall: recall(results, "rg"),
    medianCodeGraphMs,
    medianContractGraphMs,
    medianRgAndReadMs,
    medianUnifiedMs,
    unifiedTimeReductionVsRg:
      medianRgAndReadMs === 0
        ? 0
        : (medianRgAndReadMs - medianUnifiedMs) / medianRgAndReadMs,
    maxUnifiedQueryMs: Math.max(...unifiedTimes),
    fullBuildMs: activeStatus.evidence.stats.fullBuildMs,
    incrementalUpdateMs: await measureIncrementalUpdate(),
    worktreeCommitAccuracy:
      activeStatus.ok &&
      mainStatus.ok &&
      activeStatus.evidence.projectPath !== mainStatus.evidence.projectPath
        ? 1
        : 0,
    sensitivePathLeaks,
  };
  const gates = evaluateAdoptionGates(metrics);
  const adoption = Object.values(gates).every((gate) => gate.passed)
    ? "DEFAULT_READ_ONLY"
    : "PILOT_ONLY";
  const report: CodeGraphEvaluationV1 = {
    schemaVersion: "codegraph-evaluation/v1",
    generatedAt: new Date().toISOString(),
    evidence: {
      active: activeStatus.evidence,
      main: mainStatus.evidence,
    },
    totals: {
      questions: results.length,
      expectedFacts,
      foundFacts,
      returnedPaths,
      relevantReturnedPaths,
      passedQuestions: results.filter((result) => result.passed).length,
    },
    metrics,
    gates,
    adoption,
    results,
    notes: [
      "overallAccuracy is micro path precision: every returned path outside the question allowlist is a false positive. overallRecall counts exact expected paths, nodes, and edges.",
      "Unified paths obey the declared tool responsibility for each golden question. Raw CodeGraph and ContractGraph precision/recall remain separately visible, so routing cannot hide an individual tool's false positives.",
      "CodeGraph can become a default contributor only if precision and recall are both at least 90% on the questions whose routed unified answer includes CodeGraph.",
      "criticalDynamicRecall is computed only from exact ContractGraph from/to/kind/confidence edge assertions; a matching file path alone cannot pass it.",
      "Latency compares in-process CodeGraph/ContractGraph source retrieval with rg plus reading up to ten matching files; it is not an LLM wall-clock benchmark.",
      "CodeGraph-only misses remain visible. CONTRACT_GRAPH_ONLY is an expected complement, never proof that CodeGraph found a dynamic or non-language edge.",
      "No static result proves runtime execution; PR 4 adds runtime evidence.",
    ],
  };
  await atomicWrite(
    path.join(evidenceDirectory(resolved), "codegraph-evaluation-v1.json"),
    stableJson(report),
  );
  return report;
}

export function digestEvaluation(report: CodeGraphEvaluationV1): string {
  return sha256(stableJson(report));
}
