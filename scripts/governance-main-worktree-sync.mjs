#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const EXPECTED_MAIN_WORKTREE = "/global/backend";
export const TRUSTED_GIT_EXECUTABLE = "/usr/bin/git";

const ISOLATED_HOME = "/var/empty/global-backend-main-sync";
const TRUSTED_GH_CONFIG_DIR = "/root/.config/gh";
const TRUSTED_GIT_CONFIG = Object.freeze([
  ["core.hooksPath", "/dev/null"],
  ["core.attributesFile", "/dev/null"],
  ["credential.interactive", "never"],
  ["credential.https://github.com.helper", ""],
  ["credential.https://github.com.helper", "!/usr/bin/gh auth git-credential"],
  ["protocol.file.allow", "never"],
  ["protocol.ext.allow", "never"],
]);

const MAIN_BRANCH = "refs/heads/main";
const REMOTE_MAIN = "refs/remotes/origin/main";
const REMOTE_MAIN_COMMIT = `${REMOTE_MAIN}^{commit}`;
const OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/u;
const STATUS_ARGS = [
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=all",
  "--ignored=matching",
];
const TRACKED_ARGS = ["diff", "--name-only", "-z", "HEAD", "--"];
const UNTRACKED_ARGS = [
  "ls-files",
  "--others",
  "--exclude-standard",
  "--directory",
  "--no-empty-directory",
  "-z",
];
const IGNORED_ARGS = [
  "ls-files",
  "--others",
  "--ignored",
  "--exclude-standard",
  "--directory",
  "--no-empty-directory",
  "-z",
];

const ALLOWED_GIT_COMMANDS = new Set(
  [
    ["worktree", "list", "--porcelain"],
    ["symbolic-ref", "--quiet", "HEAD"],
    ["fetch", "origin", "--prune"],
    ["rev-parse", "--verify", REMOTE_MAIN_COMMIT],
    ["rev-parse", "HEAD"],
    STATUS_ARGS,
    TRACKED_ARGS,
    UNTRACKED_ARGS,
    IGNORED_ARGS,
  ].map((args) => JSON.stringify(args)),
);

function isObjectId(value) {
  return typeof value === "string" && OBJECT_ID_PATTERN.test(value);
}

function isExactObjectCommand(args) {
  if (
    args.length === 4 &&
    args[0] === "rev-list" &&
    args[1] === "--left-right" &&
    args[2] === "--count"
  ) {
    const [left, right, extra] = args[3].split("...");
    return extra === undefined && isObjectId(left) && isObjectId(right);
  }
  if (
    args.length === 5 &&
    args[0] === "diff" &&
    args[1] === "--name-only" &&
    args[2] === "-z" &&
    args[4] === "--"
  ) {
    const [left, right, extra] = args[3].split("..");
    return extra === undefined && isObjectId(left) && isObjectId(right);
  }
  return (
    (args.length === 6 &&
      args[0] === "read-tree" &&
      args[1] === "-n" &&
      args[2] === "-m" &&
      args[3] === "-u" &&
      isObjectId(args[4]) &&
      isObjectId(args[5])) ||
    (args.length === 3 &&
      args[0] === "merge" &&
      args[1] === "--ff-only" &&
      isObjectId(args[2]))
  );
}

export function assertGitCommandAllowed(args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error("git command must be a non-empty argument array");
  }

  if (!args.every((arg) => typeof arg === "string")) {
    throw new Error("git command arguments must be strings");
  }

  if (
    !ALLOWED_GIT_COMMANDS.has(JSON.stringify(args)) &&
    !isExactObjectCommand(args)
  ) {
    throw new Error(`forbidden git command: git ${args.join(" ")}`);
  }
}

export function createSafeGitEnvironment() {
  const environment = {
    GH_CONFIG_DIR: TRUSTED_GH_CONFIG_DIR,
    GH_PROMPT_DISABLED: "1",
    GIT_CONFIG_COUNT: String(TRUSTED_GIT_CONFIG.length),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    HOME: ISOLATED_HOME,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "/usr/bin:/bin",
    XDG_CONFIG_HOME: `${ISOLATED_HOME}/xdg`,
  };
  for (const [index, [key, value]] of TRUSTED_GIT_CONFIG.entries()) {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  return Object.freeze(environment);
}

export function createGitExecutor({ execFileImpl = execFile } = {}) {
  return async function runGit(args, { cwd = EXPECTED_MAIN_WORKTREE } = {}) {
    assertGitCommandAllowed(args);
    return execFileImpl(TRUSTED_GIT_EXECUTABLE, args, {
      cwd,
      env: createSafeGitEnvironment(),
      maxBuffer: 16 * 1024 * 1024,
    });
  };
}

const defaultGit = createGitExecutor();

function outputBytes(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value ?? "", "utf8");
}

function outputText(value) {
  return outputBytes(value).toString("utf8");
}

function errorText(error) {
  if (error?.stderr !== undefined) {
    const stderr = outputText(error.stderr).trim();
    if (stderr !== "") return stderr;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function parseWorktrees(text) {
  return outputText(text)
    .split(/\n\n+/u)
    .map((record) => {
      const fields = Object.fromEntries(
        record
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const separator = line.indexOf(" ");
            return separator === -1
              ? [line, true]
              : [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
      return fields;
    })
    .filter((fields) => typeof fields.worktree === "string");
}

function parseNulPaths(text) {
  return outputText(text).split("\0").filter(Boolean);
}

function normalizeLocalPath(path) {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function pathsOverlap(left, right) {
  const normalizedLeft = normalizeLocalPath(left);
  const normalizedRight = normalizeLocalPath(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  );
}

function findCollisions(incoming, localPathGroups) {
  const collisions = [];
  for (const incomingPath of incoming) {
    for (const [kind, localPaths] of Object.entries(localPathGroups)) {
      if (
        localPaths.some((localPath) => pathsOverlap(incomingPath, localPath))
      ) {
        collisions.push({ kind, path: incomingPath });
      }
    }
  }
  return collisions.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.kind.localeCompare(right.kind),
  );
}

function findGitignoreScopeCollisions(incoming, localPathGroups) {
  const rulePaths = incoming.filter(
    (path) => path === ".gitignore" || path.endsWith("/.gitignore"),
  );
  const collisions = [];
  for (const rulePath of rulePaths) {
    const separator = rulePath.lastIndexOf("/");
    const scope = separator === -1 ? "" : rulePath.slice(0, separator + 1);
    for (const kind of ["ignored", "untracked"]) {
      for (const localPath of localPathGroups[kind]) {
        if (scope === "" || normalizeLocalPath(localPath).startsWith(scope)) {
          collisions.push({ kind, path: localPath, rulePath });
        }
      }
    }
  }
  return collisions.sort(
    (left, right) =>
      left.rulePath.localeCompare(right.rulePath) ||
      left.path.localeCompare(right.path) ||
      left.kind.localeCompare(right.kind),
  );
}

function statusDigest(status) {
  return createHash("sha256").update(outputBytes(status)).digest("hex");
}

function baseResult(overrides = {}) {
  return {
    schemaVersion: "main-worktree-sync/2026-08-12-v1",
    expectedMainWorktree: EXPECTED_MAIN_WORKTREE,
    remoteRef: REMOTE_MAIN,
    canApply: false,
    ...overrides,
  };
}

async function locateCanonicalMain(git, resolveRealpath) {
  let expectedRealpath;
  try {
    expectedRealpath = await resolveRealpath(EXPECTED_MAIN_WORKTREE);
  } catch (error) {
    return baseResult({
      state: "EXPECTED_ROOT_MISSING_HOLD",
      error: errorText(error),
    });
  }

  let worktrees;
  try {
    const { stdout } = await git(["worktree", "list", "--porcelain"], {
      cwd: EXPECTED_MAIN_WORKTREE,
    });
    worktrees = parseWorktrees(stdout);
  } catch (error) {
    return baseResult({
      state: "WORKTREE_INVENTORY_FAILED_HOLD",
      error: errorText(error),
    });
  }

  const mainWorktrees = worktrees.filter(
    ({ branch }) => branch === MAIN_BRANCH,
  );
  if (mainWorktrees.length !== 1) {
    return baseResult({
      state: "MAIN_WORKTREE_CARDINALITY_HOLD",
      mainWorktreeCount: mainWorktrees.length,
    });
  }

  if (mainWorktrees[0].worktree !== EXPECTED_MAIN_WORKTREE) {
    return baseResult({
      state: "WRONG_MAIN_WORKTREE_HOLD",
      mainWorktree: mainWorktrees[0].worktree,
    });
  }

  if (mainWorktrees[0].locked || mainWorktrees[0].prunable) {
    return baseResult({
      state: "MAIN_WORKTREE_UNUSABLE_HOLD",
      mainWorktree: mainWorktrees[0].worktree,
      locked: mainWorktrees[0].locked ?? false,
      prunable: mainWorktrees[0].prunable ?? false,
    });
  }

  let actualRealpath;
  try {
    actualRealpath = await resolveRealpath(mainWorktrees[0].worktree);
  } catch (error) {
    return baseResult({
      state: "MAIN_WORKTREE_PATH_FAILED_HOLD",
      mainWorktree: mainWorktrees[0].worktree,
      error: errorText(error),
    });
  }

  if (actualRealpath !== expectedRealpath) {
    return baseResult({
      state: "WRONG_MAIN_WORKTREE_HOLD",
      mainWorktree: mainWorktrees[0].worktree,
    });
  }

  try {
    const { stdout } = await git(["symbolic-ref", "--quiet", "HEAD"], {
      cwd: EXPECTED_MAIN_WORKTREE,
    });
    if (outputText(stdout).trim() !== MAIN_BRANCH) {
      return baseResult({
        state: "WRONG_MAIN_BRANCH_HOLD",
        mainWorktree: EXPECTED_MAIN_WORKTREE,
        branch: outputText(stdout).trim(),
      });
    }
  } catch (error) {
    return baseResult({
      state: "WRONG_MAIN_BRANCH_HOLD",
      mainWorktree: EXPECTED_MAIN_WORKTREE,
      error: errorText(error),
    });
  }

  return undefined;
}

async function locateCanonicalInvocation(invocationCwd, resolveRealpath) {
  let expectedRealpath;
  let invokedRealpath;
  try {
    [expectedRealpath, invokedRealpath] = await Promise.all([
      resolveRealpath(EXPECTED_MAIN_WORKTREE),
      resolveRealpath(invocationCwd),
    ]);
  } catch (error) {
    return baseResult({
      state: "CLI_CWD_UNAVAILABLE_HOLD",
      invokedFrom: invocationCwd,
      error: errorText(error),
    });
  }

  if (invokedRealpath !== expectedRealpath) {
    return baseResult({
      state: "WRONG_CLI_CWD_HOLD",
      invokedFrom: invocationCwd,
    });
  }

  return undefined;
}

async function inspectStatus(git, { remoteFreshness, resolveRealpath }) {
  const locationHold = await locateCanonicalMain(git, resolveRealpath);
  if (locationHold) return locationHold;

  let remoteHead;
  let localHead;
  let ahead;
  let behind;
  let rawStatus;
  try {
    const [remoteResult, localResult, statusResult] = await Promise.all([
      git(["rev-parse", "--verify", REMOTE_MAIN_COMMIT], {
        cwd: EXPECTED_MAIN_WORKTREE,
      }),
      git(["rev-parse", "HEAD"], { cwd: EXPECTED_MAIN_WORKTREE }),
      git(STATUS_ARGS, { cwd: EXPECTED_MAIN_WORKTREE }),
    ]);
    remoteHead = outputText(remoteResult.stdout).trim();
    localHead = outputText(localResult.stdout).trim();
    if (!isObjectId(remoteHead) || !isObjectId(localHead)) {
      throw new Error("local or remote HEAD is not a full object ID");
    }
    const countResult = await git(
      ["rev-list", "--left-right", "--count", `${localHead}...${remoteHead}`],
      { cwd: EXPECTED_MAIN_WORKTREE },
    );
    [ahead, behind] = outputText(countResult.stdout)
      .trim()
      .split(/\s+/u)
      .map((value) => Number.parseInt(value, 10));
    rawStatus = outputBytes(statusResult.stdout);
    if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
      throw new Error(
        `invalid ahead/behind count: ${outputText(countResult.stdout).trim()}`,
      );
    }
  } catch (error) {
    return baseResult({
      state: "REMOTE_OR_STATUS_UNAVAILABLE_HOLD",
      mainWorktree: EXPECTED_MAIN_WORKTREE,
      error: errorText(error),
    });
  }

  const common = {
    mainWorktree: EXPECTED_MAIN_WORKTREE,
    localHead,
    remoteHead,
    ahead,
    behind,
    localStatusDigest: statusDigest(rawStatus),
    localStatusDirty: rawStatus.length > 0,
    remoteFreshness,
  };

  if (ahead > 0 && behind > 0) {
    return baseResult({ ...common, state: "DIVERGED_HOLD" });
  }
  if (ahead > 0) {
    return baseResult({ ...common, state: "AHEAD_HOLD" });
  }
  if (behind === 0) {
    return baseResult({ ...common, state: "UP_TO_DATE" });
  }

  let incoming;
  let localPathGroups;
  try {
    const [incomingResult, trackedResult, untrackedResult, ignoredResult] =
      await Promise.all([
        git(
          ["diff", "--name-only", "-z", `${localHead}..${remoteHead}`, "--"],
          { cwd: EXPECTED_MAIN_WORKTREE },
        ),
        git(TRACKED_ARGS, { cwd: EXPECTED_MAIN_WORKTREE }),
        git(UNTRACKED_ARGS, { cwd: EXPECTED_MAIN_WORKTREE }),
        git(IGNORED_ARGS, { cwd: EXPECTED_MAIN_WORKTREE }),
      ]);
    incoming = parseNulPaths(incomingResult.stdout);
    localPathGroups = {
      ignored: parseNulPaths(ignoredResult.stdout),
      tracked: parseNulPaths(trackedResult.stdout),
      untracked: parseNulPaths(untrackedResult.stdout),
    };
  } catch (error) {
    return baseResult({
      ...common,
      state: "LOCAL_INVENTORY_FAILED_HOLD",
      error: errorText(error),
    });
  }

  const collisions = findCollisions(incoming, localPathGroups);
  const gitignoreScopeCollisions = findGitignoreScopeCollisions(
    incoming,
    localPathGroups,
  );
  const withPaths = {
    ...common,
    incomingPathCount: incoming.length,
    localPathCounts: Object.fromEntries(
      Object.entries(localPathGroups).map(([kind, paths]) => [
        kind,
        paths.length,
      ]),
    ),
    collisions,
    gitignoreScopeCollisions,
  };
  if (collisions.length > 0) {
    return baseResult({ ...withPaths, state: "LOCAL_COLLISION_HOLD" });
  }
  if (gitignoreScopeCollisions.length > 0) {
    return baseResult({ ...withPaths, state: "GITIGNORE_SCOPE_HOLD" });
  }

  try {
    await git(["read-tree", "-n", "-m", "-u", localHead, remoteHead], {
      cwd: EXPECTED_MAIN_WORKTREE,
    });
  } catch (error) {
    return baseResult({
      ...withPaths,
      state: "READ_TREE_HOLD",
      error: errorText(error),
    });
  }

  return baseResult({
    ...withPaths,
    state: "FAST_FORWARD_READY",
    canApply: true,
    rawStatus,
  });
}

function publicResult(result) {
  const { rawStatus: _rawStatus, ...safe } = result;
  return safe;
}

export async function getMainWorktreeSyncStatus({
  git = defaultGit,
  resolveRealpath = realpath,
} = {}) {
  try {
    const result = await inspectStatus(git, {
      remoteFreshness: "CACHED_LOCAL_REF",
      resolveRealpath,
    });
    return publicResult({
      remoteFreshness: result.remoteFreshness ?? "CACHED_LOCAL_REF",
      ...result,
    });
  } catch (error) {
    return baseResult({
      state: "INTERNAL_ERROR_HOLD",
      error: errorText(error),
    });
  }
}

export async function applyMainWorktreeSync({
  git = defaultGit,
  invocationCwd = process.cwd(),
  resolveRealpath = realpath,
} = {}) {
  try {
    const invocationHold = await locateCanonicalInvocation(
      invocationCwd,
      resolveRealpath,
    );
    if (invocationHold) {
      return publicResult({
        remoteFreshness: "NOT_FETCHED_INVOCATION_HOLD",
        ...invocationHold,
      });
    }

    const locationHold = await locateCanonicalMain(git, resolveRealpath);
    if (locationHold) {
      return publicResult({
        remoteFreshness: "NOT_FETCHED_LOCATION_HOLD",
        ...locationHold,
      });
    }

    try {
      await git(["fetch", "origin", "--prune"], {
        cwd: EXPECTED_MAIN_WORKTREE,
      });
    } catch (error) {
      return baseResult({
        state: "FETCH_FAILED",
        mainWorktree: EXPECTED_MAIN_WORKTREE,
        remoteFreshness: "FETCH_FAILED_AT_RUNTIME",
        error: errorText(error),
      });
    }

    const inspectedPreflight = await inspectStatus(git, {
      remoteFreshness: "FETCHED_AT_RUNTIME",
      resolveRealpath,
    });
    const preflight = {
      remoteFreshness: "FETCHED_AT_RUNTIME",
      ...inspectedPreflight,
    };
    if (preflight.state !== "FAST_FORWARD_READY") {
      return publicResult(preflight);
    }

    try {
      const [localResult, remoteResult, statusResult] = await Promise.all([
        git(["rev-parse", "HEAD"], { cwd: EXPECTED_MAIN_WORKTREE }),
        git(["rev-parse", "--verify", REMOTE_MAIN_COMMIT], {
          cwd: EXPECTED_MAIN_WORKTREE,
        }),
        git(STATUS_ARGS, { cwd: EXPECTED_MAIN_WORKTREE }),
      ]);
      const observedLocalHead = outputText(localResult.stdout).trim();
      const observedRemoteHead = outputText(remoteResult.stdout).trim();
      const observedStatus = outputBytes(statusResult.stdout);
      if (
        observedLocalHead !== preflight.localHead ||
        observedRemoteHead !== preflight.remoteHead ||
        !observedStatus.equals(preflight.rawStatus)
      ) {
        return publicResult({
          ...preflight,
          state: "PRE_MERGE_DRIFT_HOLD",
          canApply: false,
          observedLocalHead,
          observedRemoteHead,
          observedStatusDigest: statusDigest(observedStatus),
        });
      }
      await git(
        [
          "read-tree",
          "-n",
          "-m",
          "-u",
          preflight.localHead,
          preflight.remoteHead,
        ],
        { cwd: EXPECTED_MAIN_WORKTREE },
      );
    } catch (error) {
      return publicResult({
        ...preflight,
        state: "PRE_MERGE_RECHECK_HOLD",
        canApply: false,
        error: errorText(error),
      });
    }

    try {
      await git(["merge", "--ff-only", preflight.remoteHead], {
        cwd: EXPECTED_MAIN_WORKTREE,
      });
    } catch (error) {
      return publicResult({
        ...preflight,
        state: "MERGE_FAILED_HOLD",
        canApply: false,
        error: errorText(error),
      });
    }

    let postStatus;
    let localHead;
    let remoteHead;
    let ahead;
    let behind;
    try {
      const [statusResult, localResult, remoteResult] = await Promise.all([
        git(STATUS_ARGS, { cwd: EXPECTED_MAIN_WORKTREE }),
        git(["rev-parse", "HEAD"], { cwd: EXPECTED_MAIN_WORKTREE }),
        git(["rev-parse", "--verify", REMOTE_MAIN_COMMIT], {
          cwd: EXPECTED_MAIN_WORKTREE,
        }),
      ]);
      postStatus = outputBytes(statusResult.stdout);
      localHead = outputText(localResult.stdout).trim();
      remoteHead = outputText(remoteResult.stdout).trim();
      if (!isObjectId(remoteHead) || !isObjectId(localHead)) {
        throw new Error(
          "post-apply local or remote HEAD is not a full object ID",
        );
      }
      const countResult = await git(
        ["rev-list", "--left-right", "--count", `${localHead}...${remoteHead}`],
        { cwd: EXPECTED_MAIN_WORKTREE },
      );
      [ahead, behind] = outputText(countResult.stdout)
        .trim()
        .split(/\s+/u)
        .map((value) => Number.parseInt(value, 10));
    } catch (error) {
      return publicResult({
        ...preflight,
        state: "POST_APPLY_VERIFY_FAILED_HOLD",
        canApply: false,
        error: errorText(error),
      });
    }

    const statusPreserved = postStatus.equals(preflight.rawStatus);
    const verification = {
      ...preflight,
      canApply: false,
      localHead,
      remoteHead,
      ahead,
      behind,
      statusPreserved,
      postStatusDigest: statusDigest(postStatus),
    };
    if (!statusPreserved) {
      return publicResult({ ...verification, state: "POST_APPLY_DRIFT_HOLD" });
    }
    if (
      localHead !== preflight.remoteHead ||
      remoteHead !== preflight.remoteHead ||
      ahead !== 0 ||
      behind !== 0
    ) {
      return publicResult({ ...verification, state: "POST_APPLY_HEAD_HOLD" });
    }

    return publicResult({ ...verification, state: "APPLIED" });
  } catch (error) {
    return baseResult({
      state: "INTERNAL_ERROR_HOLD",
      error: errorText(error),
    });
  }
}

export function getCliExitCode(action, state) {
  if (action === "status") {
    return state === "UP_TO_DATE" || state === "FAST_FORWARD_READY" ? 0 : 2;
  }
  if (action === "apply") {
    return state === "UP_TO_DATE" || state === "APPLIED" ? 0 : 2;
  }
  return 2;
}

async function runCli() {
  const action = process.argv[2] ?? "status";
  let result;
  if (action === "status") {
    result = await getMainWorktreeSyncStatus();
  } else if (action === "apply") {
    result = await applyMainWorktreeSync({ invocationCwd: process.cwd() });
  } else {
    result = baseResult({
      state: "INVALID_ACTION_HOLD",
      error:
        "usage: node scripts/governance-main-worktree-sync.mjs [status|apply]",
    });
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = getCliExitCode(action, result.state);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runCli();
}
