import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertReadOnlyGitArgs,
  collectWorktreeInventory,
  parseWorktreePorcelain,
} from "./worktree-inventory.mjs";

const MAIN_HEAD = "1111111111111111111111111111111111111111";
const FEATURE_HEAD = "2222222222222222222222222222222222222222";
const DETACHED_HEAD = "3333333333333333333333333333333333333333";
const MERGE_BASE = "4444444444444444444444444444444444444444";
const ORIGIN_MAIN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BRANCH_FORMAT =
  "--format=%(refname)%00%(upstream)%00%(upstream:short)%00%(upstream:track,nobracket)%00";
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function gitResult(stdout = "", exitCode = 0) {
  return { stdout, stderr: "", exitCode };
}

function commandKey(args) {
  return JSON.stringify(args);
}

test("parseWorktreePorcelain returns stable path-sorted base records", () => {
  const porcelain = [
    "worktree /repo/z-feature",
    `HEAD ${FEATURE_HEAD}`,
    "detached",
    "locked held by another process",
    "",
    "worktree /repo/main",
    `HEAD ${MAIN_HEAD}`,
    "branch refs/heads/main",
    "prunable gitdir file points to a missing location",
    "",
  ].join("\0");

  assert.deepEqual(parseWorktreePorcelain(porcelain), [
    {
      path: "/repo/main",
      head: MAIN_HEAD,
      branch: "refs/heads/main",
      detached: false,
      bare: false,
      locked: false,
      lockReason: null,
      prunable: true,
      pruneReason: "gitdir file points to a missing location",
    },
    {
      path: "/repo/z-feature",
      head: FEATURE_HEAD,
      branch: null,
      detached: true,
      bare: false,
      locked: true,
      lockReason: "held by another process",
      prunable: false,
      pruneReason: null,
    },
  ]);
});

test("inventory reports dirty state, untracked files, gone upstream, detached locks, and UNKNOWN provenance", () => {
  const porcelain = [
    "worktree /repo/feature",
    `HEAD ${FEATURE_HEAD}`,
    "branch refs/heads/feature",
    "locked controlled pilot",
    "",
    "worktree /repo/detached",
    `HEAD ${DETACHED_HEAD}`,
    "detached",
    "",
    "worktree /repo/main",
    `HEAD ${MAIN_HEAD}`,
    "branch refs/heads/main",
    "",
  ].join("\0");
  const branchMetadata = [
    [
      "refs/heads/feature",
      "refs/remotes/origin/feature",
      "origin/feature",
      "gone",
      "",
    ].join("\0"),
    ["refs/heads/main", "refs/remotes/origin/main", "origin/main", "", ""].join(
      "\0",
    ),
    "",
  ].join("\n");
  const responses = new Map([
    [
      commandKey(["worktree", "list", "--porcelain", "-z"]),
      gitResult(porcelain),
    ],
    [
      commandKey(["for-each-ref", BRANCH_FORMAT, "refs/heads"]),
      gitResult(branchMetadata),
    ],
    [
      commandKey([
        "rev-parse",
        "--verify",
        "--quiet",
        "refs/remotes/origin/main^{commit}",
      ]),
      gitResult(`${ORIGIN_MAIN}\n`),
    ],
    [
      commandKey(["show", "-s", "--format=%cI", MAIN_HEAD]),
      gitResult("2026-08-07T10:00:00+08:00\n"),
    ],
    [
      commandKey(["show", "-s", "--format=%cI", FEATURE_HEAD]),
      gitResult("2026-08-07T11:00:00+08:00\n"),
    ],
    [
      commandKey(["show", "-s", "--format=%cI", DETACHED_HEAD]),
      gitResult("2026-08-07T12:00:00+08:00\n"),
    ],
    [
      commandKey(["merge-base", MAIN_HEAD, ORIGIN_MAIN]),
      gitResult(`${ORIGIN_MAIN}\n`),
    ],
    [
      commandKey([
        "rev-list",
        "--left-right",
        "--count",
        `${ORIGIN_MAIN}...${MAIN_HEAD}`,
      ]),
      gitResult("0\t0\n"),
    ],
    [
      commandKey(["merge-base", FEATURE_HEAD, ORIGIN_MAIN]),
      gitResult(`${MERGE_BASE}\n`),
    ],
    [
      commandKey([
        "rev-list",
        "--left-right",
        "--count",
        `${ORIGIN_MAIN}...${FEATURE_HEAD}`,
      ]),
      gitResult("2\t3\n"),
    ],
    [
      commandKey(["merge-base", DETACHED_HEAD, ORIGIN_MAIN]),
      gitResult(`${MERGE_BASE}\n`),
    ],
    [
      commandKey([
        "rev-list",
        "--left-right",
        "--count",
        `${ORIGIN_MAIN}...${DETACHED_HEAD}`,
      ]),
      gitResult("0\t1\n"),
    ],
    [
      commandKey([
        "-C",
        "/repo/feature",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
      gitResult(
        " M tracked.ts\0R  renamed.ts\0?? old-name.ts\0?? new-one.ts\0?? nested/new-two.ts\0",
      ),
    ],
    [
      commandKey([
        "-C",
        "/repo/detached",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
      gitResult(""),
    ],
    [
      commandKey([
        "-C",
        "/repo/main",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
      gitResult(""),
    ],
  ]);
  const calls = [];
  const runGit = (args) => {
    calls.push([...args]);
    return responses.get(commandKey(args)) ?? gitResult("", 128);
  };

  const inventory = collectWorktreeInventory({
    runGit,
    pathExists: () => true,
  });
  const feature = inventory.worktrees.find(
    (entry) => entry.path === "/repo/feature",
  );
  const detached = inventory.worktrees.find(
    (entry) => entry.path === "/repo/detached",
  );

  assert.deepEqual(inventory.collection, { status: "AVAILABLE" });
  assert.deepEqual(feature?.dirty, { status: "AVAILABLE", value: true });
  assert.deepEqual(feature?.untrackedCount, {
    status: "AVAILABLE",
    value: 2,
  });
  assert.deepEqual(feature?.upstream, {
    status: "GONE",
    ref: "refs/remotes/origin/feature",
    short: "origin/feature",
    reason: "CONFIGURED_UPSTREAM_NOT_FOUND",
  });
  assert.deepEqual(feature?.relativeToOriginMain, {
    status: "AVAILABLE",
    ref: "refs/remotes/origin/main",
    commit: ORIGIN_MAIN,
    ahead: 3,
    behind: 2,
    relationship: "DIVERGED",
    mergeBase: MERGE_BASE,
  });
  assert.equal(detached?.detached, true);
  assert.deepEqual(detached?.upstream, {
    status: "NOT_APPLICABLE",
    reason: "DETACHED_HEAD",
  });
  assert.deepEqual(detached?.relativeToOriginMain, {
    status: "AVAILABLE",
    ref: "refs/remotes/origin/main",
    commit: ORIGIN_MAIN,
    ahead: 1,
    behind: 0,
    relationship: "AHEAD",
    mergeBase: MERGE_BASE,
  });
  assert.equal(feature?.locked, true);
  assert.equal(feature?.lockReason, "controlled pilot");
  for (const field of ["owner", "activeTask", "pullRequest"]) {
    assert.deepEqual(feature?.[field], {
      status: "UNKNOWN",
      reason: "NO_LOCAL_PROVENANCE_REGISTRY",
    });
  }
  assert.ok(calls.length > 1);
  for (const args of calls)
    assert.doesNotThrow(() => assertReadOnlyGitArgs(args));
});

test("missing paths and command failures remain typed UNAVAILABLE without pruning", () => {
  const porcelain = [
    "worktree /repo/missing",
    `HEAD ${FEATURE_HEAD}`,
    "branch refs/heads/feature",
    "prunable gitdir file points to a missing location",
    "",
  ].join("\0");
  const calls = [];
  const runGit = (args) => {
    calls.push([...args]);
    if (args[0] === "worktree") return gitResult(porcelain);
    if (args[0] === "for-each-ref") return gitResult("", 127);
    if (args[0] === "rev-parse") return gitResult("", 1);
    if (args[0] === "show") return gitResult("", 128);
    return gitResult("", 128);
  };

  const inventory = collectWorktreeInventory({
    runGit,
    pathExists: () => false,
  });
  const [entry] = inventory.worktrees;

  assert.deepEqual(entry.dirty, {
    status: "UNAVAILABLE",
    reason: "WORKTREE_PATH_NOT_FOUND",
  });
  assert.deepEqual(entry.untrackedCount, {
    status: "UNAVAILABLE",
    reason: "WORKTREE_PATH_NOT_FOUND",
  });
  assert.deepEqual(entry.upstream, {
    status: "UNAVAILABLE",
    reason: "BRANCH_METADATA_COMMAND_FAILED",
    exitCode: 127,
  });
  assert.deepEqual(entry.relativeToOriginMain, {
    status: "UNKNOWN",
    reason: "ORIGIN_MAIN_NOT_FOUND",
  });
  assert.deepEqual(entry.lastCommitAt, {
    status: "UNAVAILABLE",
    reason: "LAST_COMMIT_COMMAND_FAILED",
    exitCode: 128,
  });
  assert.equal(entry.prunable, true);
  assert.equal(
    calls.some((args) => args.includes("prune") || args.includes("remove")),
    false,
  );
  assert.equal(
    calls.some((args) => args[0] === "-C"),
    false,
  );
});

test("bare entries without HEAD remain typed instead of invoking path commands", () => {
  const porcelain = ["worktree /repo/bare", "bare", ""].join("\0");
  const calls = [];
  const runGit = (args) => {
    calls.push([...args]);
    if (args[0] === "worktree") return gitResult(porcelain);
    if (args[0] === "rev-parse") return gitResult("", 1);
    return gitResult("", 128);
  };

  const inventory = collectWorktreeInventory({
    runGit,
    pathExists: () => true,
  });
  const [entry] = inventory.worktrees;

  assert.deepEqual(entry.relativeToOriginMain, {
    status: "UNKNOWN",
    reason: "HEAD_NOT_AVAILABLE",
  });
  assert.deepEqual(entry.lastCommitAt, {
    status: "NOT_APPLICABLE",
    reason: "HEAD_NOT_AVAILABLE",
  });
  assert.deepEqual(entry.dirty, {
    status: "NOT_APPLICABLE",
    reason: "BARE_REPOSITORY",
  });
  assert.equal(
    calls.some((args) => args[0] === "show"),
    false,
  );
  assert.equal(
    calls.some((args) => args[0] === "merge-base"),
    false,
  );
  assert.equal(
    calls.some((args) => args[0] === "-C"),
    false,
  );
});

test("worktree-list failure is emitted as typed UNAVAILABLE JSON state", () => {
  assert.deepEqual(
    collectWorktreeInventory({
      runGit: () => gitResult("", 129),
      pathExists: () => true,
    }),
    {
      schemaVersion: "git-worktree-inventory/v1",
      collection: {
        status: "UNAVAILABLE",
        reason: "WORKTREE_LIST_COMMAND_FAILED",
        exitCode: 129,
      },
      worktrees: [],
    },
  );
});

test("git command guard rejects mutating and network operations", () => {
  for (const args of [
    ["fetch", "origin"],
    ["worktree", "prune"],
    ["clean", "-fd"],
    ["reset", "--hard"],
    ["push", "origin", "main"],
    ["-C", "/repo/main", "status", "--short"],
  ]) {
    assert.throws(
      () => assertReadOnlyGitArgs(args),
      /not an allowed read-only/,
    );
  }
});

test("parseWorktreePorcelain rejects malformed records", () => {
  assert.throws(
    () => parseWorktreePorcelain(`HEAD ${MAIN_HEAD}\0\0`),
    /record must start with worktree/,
  );
  assert.throws(
    () =>
      parseWorktreePorcelain("worktree /repo/main\0branch refs/heads/main\0\0"),
    /missing HEAD/,
  );
});

test("CLI writes one parseable, path-sorted JSON document to stdout", () => {
  const stdout = execFileSync(
    process.execPath,
    [resolve(REPOSITORY_ROOT, "scripts/worktree-inventory.mjs")],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const inventory = JSON.parse(stdout);
  const paths = inventory.worktrees.map((entry) => entry.path);
  const current = inventory.worktrees.find(
    (entry) => entry.path === REPOSITORY_ROOT,
  );

  assert.equal(inventory.schemaVersion, "git-worktree-inventory/v1");
  assert.deepEqual(inventory.collection, { status: "AVAILABLE" });
  assert.deepEqual(paths, [...paths].sort());
  assert.equal(current?.dirty.status, "AVAILABLE");
  assert.equal(current?.untrackedCount.status, "AVAILABLE");
  assert.ok("upstream" in current);
  assert.ok("relativeToOriginMain" in current);
  assert.ok("lastCommitAt" in current);
  assert.deepEqual(current?.owner, {
    status: "UNKNOWN",
    reason: "NO_LOCAL_PROVENANCE_REGISTRY",
  });
});
