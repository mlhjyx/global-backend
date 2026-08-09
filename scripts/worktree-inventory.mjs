#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = "git-worktree-inventory/v1";
const WORKTREE_LIST_ARGS = Object.freeze([
  "worktree",
  "list",
  "--porcelain",
  "-z",
]);
const BRANCH_FORMAT =
  "--format=%(refname)%00%(upstream)%00%(upstream:short)%00%(upstream:track,nobracket)%00";
const BRANCH_LIST_ARGS = Object.freeze([
  "for-each-ref",
  BRANCH_FORMAT,
  "refs/heads",
]);
const ORIGIN_MAIN_REF = "refs/remotes/origin/main";
const ORIGIN_MAIN_OBJECT = `${ORIGIN_MAIN_REF}^{commit}`;
const ORIGIN_MAIN_ARGS = Object.freeze([
  "rev-parse",
  "--verify",
  "--quiet",
  ORIGIN_MAIN_OBJECT,
]);
const STATUS_SUFFIX = Object.freeze([
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=all",
]);
const OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/u;

function arraysEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isObjectId(value) {
  return typeof value === "string" && OBJECT_ID_PATTERN.test(value);
}

function isStatusCommand(args) {
  return (
    args.length === 2 + STATUS_SUFFIX.length &&
    args[0] === "-C" &&
    typeof args[1] === "string" &&
    isAbsolute(args[1]) &&
    arraysEqual(args.slice(2), STATUS_SUFFIX)
  );
}

function isLastCommitCommand(args) {
  return (
    args.length === 4 &&
    args[0] === "show" &&
    args[1] === "-s" &&
    args[2] === "--format=%cI" &&
    isObjectId(args[3])
  );
}

function isMergeBaseCommand(args) {
  return (
    args.length === 3 &&
    args[0] === "merge-base" &&
    isObjectId(args[1]) &&
    isObjectId(args[2])
  );
}

function isRelativeCountCommand(args) {
  if (
    args.length !== 4 ||
    args[0] !== "rev-list" ||
    args[1] !== "--left-right" ||
    args[2] !== "--count"
  ) {
    return false;
  }
  const [left, right, extra] = args[3].split("...");
  return extra === undefined && isObjectId(left) && isObjectId(right);
}

export function assertReadOnlyGitArgs(args) {
  if (
    !Array.isArray(args) ||
    !args.every((value) => typeof value === "string") ||
    !(
      arraysEqual(args, WORKTREE_LIST_ARGS) ||
      arraysEqual(args, BRANCH_LIST_ARGS) ||
      arraysEqual(args, ORIGIN_MAIN_ARGS) ||
      isStatusCommand(args) ||
      isLastCommitCommand(args) ||
      isMergeBaseCommand(args) ||
      isRelativeCountCommand(args)
    )
  ) {
    throw new Error(
      "git arguments are not an allowed read-only inventory command",
    );
  }
}

function comparePaths(left, right) {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function parseRecord(record) {
  const fields = record.split("\0").filter((field) => field.length > 0);
  const [worktreeField, ...attributes] = fields;

  if (!worktreeField?.startsWith("worktree ")) {
    throw new Error("worktree inventory record must start with worktree");
  }

  const path = worktreeField.slice("worktree ".length);
  if (path.length === 0) {
    throw new Error("worktree inventory record has an empty path");
  }

  const parsed = attributes.reduce(
    (entry, attribute) => {
      if (attribute.startsWith("HEAD ")) {
        const head = attribute.slice("HEAD ".length);
        if (!isObjectId(head)) {
          throw new Error(`worktree inventory has invalid HEAD for ${path}`);
        }
        return { ...entry, head };
      }
      if (attribute.startsWith("branch ")) {
        const branch = attribute.slice("branch ".length);
        if (!branch.startsWith("refs/heads/")) {
          throw new Error(`worktree inventory has invalid branch for ${path}`);
        }
        return { ...entry, branch };
      }
      if (attribute === "detached") {
        return { ...entry, detached: true };
      }
      if (attribute === "bare") {
        return { ...entry, bare: true };
      }
      if (attribute === "locked" || attribute.startsWith("locked ")) {
        const lockReason =
          attribute === "locked" ? null : attribute.slice("locked ".length);
        return { ...entry, locked: true, lockReason };
      }
      if (attribute === "prunable" || attribute.startsWith("prunable ")) {
        const pruneReason =
          attribute === "prunable" ? null : attribute.slice("prunable ".length);
        return { ...entry, prunable: true, pruneReason };
      }
      throw new Error(
        `worktree inventory has an unknown field for ${path}: ${attribute}`,
      );
    },
    {
      path,
      head: null,
      branch: null,
      detached: false,
      bare: false,
      locked: false,
      lockReason: null,
      prunable: false,
      pruneReason: null,
    },
  );

  if (parsed.head === null && !parsed.bare) {
    throw new Error(`worktree inventory record for ${path} is missing HEAD`);
  }
  if (parsed.branch !== null && parsed.detached) {
    throw new Error(
      `worktree inventory record for ${path} is both branched and detached`,
    );
  }

  return parsed;
}

export function parseWorktreePorcelain(porcelain) {
  if (typeof porcelain !== "string") {
    throw new TypeError("worktree porcelain output must be a string");
  }

  return porcelain
    .split("\0\0")
    .filter((record) => record.length > 0)
    .map(parseRecord)
    .toSorted(comparePaths);
}

function runGitReadOnly(args) {
  assertReadOnlyGitArgs(args);
  const result = spawnSync("git", args, {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
    },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: Number.isInteger(result.status) ? result.status : null,
  };
}

function invokeGit(runGit, args) {
  assertReadOnlyGitArgs(args);
  try {
    const result = runGit([...args]);
    if (
      result === null ||
      typeof result !== "object" ||
      typeof result.stdout !== "string" ||
      !(Number.isInteger(result.exitCode) || result.exitCode === null)
    ) {
      return { stdout: "", stderr: "", exitCode: null };
    }
    return {
      stdout: result.stdout,
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      exitCode: result.exitCode,
    };
  } catch {
    return { stdout: "", stderr: "", exitCode: null };
  }
}

function unavailable(reason, exitCode) {
  return Number.isInteger(exitCode)
    ? { status: "UNAVAILABLE", reason, exitCode }
    : { status: "UNAVAILABLE", reason };
}

function unknown(reason) {
  return { status: "UNKNOWN", reason };
}

function unknownProvenance() {
  return unknown("NO_LOCAL_PROVENANCE_REGISTRY");
}

function parseBranchMetadata(output) {
  const entries = output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const fields = line.split("\0");
      if (fields.at(-1) === "") fields.pop();
      if (fields.length !== 4 || !fields[0].startsWith("refs/heads/")) {
        throw new Error("branch metadata output is malformed");
      }
      return {
        branch: fields[0],
        upstreamRef: fields[1],
        upstreamShort: fields[2],
        tracking: fields[3],
      };
    });
  return new Map(entries.map((entry) => [entry.branch, entry]));
}

function collectBranchMetadata(runGit, hasBranches) {
  if (!hasBranches) {
    return { status: "AVAILABLE", branches: new Map() };
  }
  const result = invokeGit(runGit, BRANCH_LIST_ARGS);
  if (result.exitCode !== 0) {
    return {
      status: "UNAVAILABLE",
      value: unavailable("BRANCH_METADATA_COMMAND_FAILED", result.exitCode),
    };
  }
  try {
    return {
      status: "AVAILABLE",
      branches: parseBranchMetadata(result.stdout),
    };
  } catch {
    return {
      status: "UNAVAILABLE",
      value: unavailable("BRANCH_METADATA_PARSE_FAILED"),
    };
  }
}

function resolveUpstream(entry, branchMetadata) {
  if (entry.detached) {
    return { status: "NOT_APPLICABLE", reason: "DETACHED_HEAD" };
  }
  if (entry.branch === null) {
    return { status: "NOT_APPLICABLE", reason: "NO_LOCAL_BRANCH" };
  }
  if (branchMetadata.status !== "AVAILABLE") {
    return { ...branchMetadata.value };
  }
  const metadata = branchMetadata.branches.get(entry.branch);
  if (!metadata) {
    return unavailable("LOCAL_BRANCH_METADATA_NOT_FOUND");
  }
  if (metadata.upstreamRef.length === 0) {
    return { status: "NOT_CONFIGURED", reason: "NO_CONFIGURED_UPSTREAM" };
  }
  if (metadata.tracking.trim() === "gone") {
    return {
      status: "GONE",
      ref: metadata.upstreamRef,
      short: metadata.upstreamShort || null,
      reason: "CONFIGURED_UPSTREAM_NOT_FOUND",
    };
  }
  return {
    status: "AVAILABLE",
    ref: metadata.upstreamRef,
    short: metadata.upstreamShort || null,
    tracking: metadata.tracking.trim() || null,
  };
}

function collectOriginMain(runGit) {
  const result = invokeGit(runGit, ORIGIN_MAIN_ARGS);
  if (result.exitCode === 1) return unknown("ORIGIN_MAIN_NOT_FOUND");
  if (result.exitCode !== 0) {
    return unavailable("ORIGIN_MAIN_COMMAND_FAILED", result.exitCode);
  }
  const commit = result.stdout.trim();
  return isObjectId(commit)
    ? { status: "AVAILABLE", commit }
    : unavailable("ORIGIN_MAIN_INVALID_OUTPUT");
}

function relationship(ahead, behind) {
  if (ahead === 0 && behind === 0) return "EQUAL";
  if (ahead > 0 && behind === 0) return "AHEAD";
  if (ahead === 0 && behind > 0) return "BEHIND";
  return "DIVERGED";
}

function collectRelativeToOriginMain(runGit, head, originMain) {
  if (originMain.status !== "AVAILABLE") return { ...originMain };

  const mergeBaseResult = invokeGit(runGit, [
    "merge-base",
    head,
    originMain.commit,
  ]);
  if (mergeBaseResult.exitCode === 1) {
    return unknown("NO_COMMON_ANCESTOR_WITH_ORIGIN_MAIN");
  }
  if (mergeBaseResult.exitCode !== 0) {
    return unavailable("MERGE_BASE_COMMAND_FAILED", mergeBaseResult.exitCode);
  }
  const mergeBase = mergeBaseResult.stdout.trim();
  if (!isObjectId(mergeBase)) {
    return unavailable("MERGE_BASE_INVALID_OUTPUT");
  }

  const countResult = invokeGit(runGit, [
    "rev-list",
    "--left-right",
    "--count",
    `${originMain.commit}...${head}`,
  ]);
  if (countResult.exitCode !== 0) {
    return unavailable("RELATIVE_COUNT_COMMAND_FAILED", countResult.exitCode);
  }
  const match = /^(\d+)\s+(\d+)$/u.exec(countResult.stdout.trim());
  if (!match) return unavailable("RELATIVE_COUNT_INVALID_OUTPUT");

  const behind = Number.parseInt(match[1], 10);
  const ahead = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
    return unavailable("RELATIVE_COUNT_INVALID_OUTPUT");
  }
  return {
    status: "AVAILABLE",
    ref: ORIGIN_MAIN_REF,
    commit: originMain.commit,
    ahead,
    behind,
    relationship: relationship(ahead, behind),
    mergeBase,
  };
}

function collectLastCommitAt(runGit, head) {
  const result = invokeGit(runGit, ["show", "-s", "--format=%cI", head]);
  if (result.exitCode !== 0) {
    return unavailable("LAST_COMMIT_COMMAND_FAILED", result.exitCode);
  }
  const value = result.stdout.trim();
  if (value.length === 0 || Number.isNaN(Date.parse(value))) {
    return unavailable("LAST_COMMIT_INVALID_OUTPUT");
  }
  return { status: "AVAILABLE", value };
}

function unavailableWorkingTreeState(reason, exitCode) {
  return {
    dirty: unavailable(reason, exitCode),
    untrackedCount: unavailable(reason, exitCode),
  };
}

function parseWorkingTreeStatus(porcelain) {
  const records = porcelain.split("\0").filter((record) => record.length > 0);
  let entries = 0;
  let untrackedCount = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (
      record.length < 4 ||
      record[2] !== " " ||
      !/^[ MADRCUT?!]{2}$/u.test(record.slice(0, 2))
    ) {
      throw new Error("worktree status output is malformed");
    }
    entries += 1;
    if (record.startsWith("?? ")) untrackedCount += 1;
    if (
      [record[0], record[1]].some((status) => status === "R" || status === "C")
    ) {
      index += 1;
      if (index >= records.length) {
        throw new Error("worktree rename status is missing its source path");
      }
    }
  }
  return { dirty: entries > 0, untrackedCount };
}

function collectWorkingTreeState(runGit, pathExists, entry) {
  if (entry.bare) {
    return {
      dirty: { status: "NOT_APPLICABLE", reason: "BARE_REPOSITORY" },
      untrackedCount: {
        status: "NOT_APPLICABLE",
        reason: "BARE_REPOSITORY",
      },
    };
  }
  if (!pathExists(entry.path)) {
    return unavailableWorkingTreeState("WORKTREE_PATH_NOT_FOUND");
  }
  const result = invokeGit(runGit, ["-C", entry.path, ...STATUS_SUFFIX]);
  if (result.exitCode !== 0) {
    return unavailableWorkingTreeState(
      "WORKTREE_STATUS_COMMAND_FAILED",
      result.exitCode,
    );
  }
  let parsed;
  try {
    parsed = parseWorkingTreeStatus(result.stdout);
  } catch {
    return unavailableWorkingTreeState("WORKTREE_STATUS_PARSE_FAILED");
  }
  return {
    dirty: { status: "AVAILABLE", value: parsed.dirty },
    untrackedCount: {
      status: "AVAILABLE",
      value: parsed.untrackedCount,
    },
  };
}

export function collectWorktreeInventory(options = {}) {
  const runGit = options.runGit ?? runGitReadOnly;
  const pathExists = options.pathExists ?? existsSync;
  const listResult = invokeGit(runGit, WORKTREE_LIST_ARGS);
  if (listResult.exitCode !== 0) {
    return {
      schemaVersion: SCHEMA_VERSION,
      collection: unavailable(
        "WORKTREE_LIST_COMMAND_FAILED",
        listResult.exitCode,
      ),
      worktrees: [],
    };
  }

  let baseEntries;
  try {
    baseEntries = parseWorktreePorcelain(listResult.stdout);
  } catch {
    return {
      schemaVersion: SCHEMA_VERSION,
      collection: unavailable("WORKTREE_LIST_PARSE_FAILED"),
      worktrees: [],
    };
  }

  const branchMetadata = collectBranchMetadata(
    runGit,
    baseEntries.some((entry) => entry.branch !== null),
  );
  const originMain = collectOriginMain(runGit);
  const lastCommitCache = new Map();
  const relativeCache = new Map();
  const worktrees = baseEntries.map((entry) => {
    const hasHead = isObjectId(entry.head);
    if (hasHead && !lastCommitCache.has(entry.head)) {
      lastCommitCache.set(entry.head, collectLastCommitAt(runGit, entry.head));
    }
    if (hasHead && !relativeCache.has(entry.head)) {
      relativeCache.set(
        entry.head,
        collectRelativeToOriginMain(runGit, entry.head, originMain),
      );
    }
    const relativeToOriginMain = hasHead
      ? { ...relativeCache.get(entry.head) }
      : unknown("HEAD_NOT_AVAILABLE");
    const lastCommitAt = hasHead
      ? { ...lastCommitCache.get(entry.head) }
      : { status: "NOT_APPLICABLE", reason: "HEAD_NOT_AVAILABLE" };
    return {
      ...entry,
      upstream: resolveUpstream(entry, branchMetadata),
      relativeToOriginMain,
      ...collectWorkingTreeState(runGit, pathExists, entry),
      lastCommitAt,
      owner: unknownProvenance(),
      activeTask: unknownProvenance(),
      pullRequest: unknownProvenance(),
    };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    collection: { status: "AVAILABLE" },
    worktrees,
  };
}

function main() {
  const inventory = collectWorktreeInventory();
  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
  if (inventory.collection.status === "UNAVAILABLE") process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
