import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_MAIN_WORKTREE,
  applyMainWorktreeSync as applyMainWorktreeSyncImplementation,
  assertGitCommandAllowed,
  createSafeGitEnvironment,
  getCliExitCode,
  getMainWorktreeSyncStatus,
} from "./governance-main-worktree-sync.mjs";

const MAIN_HEAD = "1111111111111111111111111111111111111111";
const REMOTE_HEAD = "2222222222222222222222222222222222222222";

function applyMainWorktreeSync(options = {}) {
  return applyMainWorktreeSyncImplementation({
    invocationCwd: EXPECTED_MAIN_WORKTREE,
    ...options,
  });
}

function nul(paths) {
  return paths.length === 0 ? "" : `${paths.join("\0")}\0`;
}

function createFakeExecutor(options = {}) {
  const calls = [];
  const state = {
    applied: false,
    localHeadReads: 0,
    readTreeReads: 0,
    remoteHeadReads: 0,
    statusReadsBeforeApply: 0,
    statusReadsAfterApply: 0,
  };
  const config = {
    ahead: 0,
    behind: 0,
    branch: "refs/heads/main",
    fetchError: undefined,
    ignored: [],
    incoming: [],
    locked: false,
    mainPath: EXPECTED_MAIN_WORKTREE,
    preMergeLocalHead: undefined,
    preMergeReadTreeError: undefined,
    preMergeRemoteHead: undefined,
    preMergeStatus: undefined,
    postApplyRemoteHead: undefined,
    postApplyStatus: undefined,
    prunable: false,
    readTreeError: undefined,
    remoteExists: true,
    status: "",
    tracked: [],
    untracked: [],
    ...options,
  };

  const run = async (args, executionOptions = {}) => {
    calls.push({ args: [...args], cwd: executionOptions.cwd });
    const command = args.join(" ");

    if (command === "worktree list --porcelain") {
      const availability = [
        config.locked ? "locked test lock" : "",
        config.prunable ? "prunable test metadata" : "",
      ]
        .filter(Boolean)
        .join("\n");
      return {
        stdout: `worktree ${config.mainPath}\nHEAD ${MAIN_HEAD}\nbranch ${config.branch}\n${availability}${availability ? "\n" : ""}\n`,
        stderr: "",
      };
    }
    if (command === "symbolic-ref --quiet HEAD") {
      return { stdout: `${config.branch}\n`, stderr: "" };
    }
    if (command === "fetch origin --prune") {
      if (config.fetchError) throw config.fetchError;
      return { stdout: "", stderr: "" };
    }
    if (command === "rev-parse --verify refs/remotes/origin/main^{commit}") {
      if (!config.remoteExists) throw new Error("missing origin/main");
      state.remoteHeadReads += 1;
      const head =
        state.applied && config.postApplyRemoteHead
          ? config.postApplyRemoteHead
          : !state.applied && state.remoteHeadReads > 1
            ? (config.preMergeRemoteHead ?? REMOTE_HEAD)
            : REMOTE_HEAD;
      return { stdout: `${head}\n`, stderr: "" };
    }
    if (command === "rev-parse HEAD") {
      state.localHeadReads += 1;
      const head = state.applied
        ? REMOTE_HEAD
        : state.localHeadReads > 1
          ? (config.preMergeLocalHead ?? MAIN_HEAD)
          : MAIN_HEAD;
      return { stdout: `${head}\n`, stderr: "" };
    }
    if (
      args[0] === "rev-list" &&
      args[1] === "--left-right" &&
      args[2] === "--count"
    ) {
      return {
        stdout: state.applied
          ? "0\t0\n"
          : `${config.ahead}\t${config.behind}\n`,
        stderr: "",
      };
    }
    if (
      command ===
      "status --porcelain=v1 -z --untracked-files=all --ignored=matching"
    ) {
      state.statusReadsBeforeApply += 1;
      if (!state.applied) {
        return {
          stdout:
            state.statusReadsBeforeApply > 1
              ? (config.preMergeStatus ?? config.status)
              : config.status,
          stderr: "",
        };
      }
      state.statusReadsAfterApply += 1;
      return {
        stdout: config.postApplyStatus ?? config.status,
        stderr: "",
      };
    }
    if (command === "diff --name-only -z HEAD --") {
      return { stdout: nul(config.tracked), stderr: "" };
    }
    if (
      command ===
      "ls-files --others --exclude-standard --directory --no-empty-directory -z"
    ) {
      return { stdout: nul(config.untracked), stderr: "" };
    }
    if (
      command ===
      "ls-files --others --ignored --exclude-standard --directory --no-empty-directory -z"
    ) {
      return { stdout: nul(config.ignored), stderr: "" };
    }
    if (command === `diff --name-only -z ${MAIN_HEAD}..${REMOTE_HEAD} --`) {
      return { stdout: nul(config.incoming), stderr: "" };
    }
    if (command === `read-tree -n -m -u ${MAIN_HEAD} ${REMOTE_HEAD}`) {
      state.readTreeReads += 1;
      if (state.readTreeReads > 1 && config.preMergeReadTreeError) {
        throw config.preMergeReadTreeError;
      }
      if (config.readTreeError) throw config.readTreeError;
      return { stdout: "", stderr: "" };
    }
    if (command === `merge --ff-only ${REMOTE_HEAD}`) {
      state.applied = true;
      return { stdout: "Updating\n", stderr: "" };
    }

    throw new Error(`unexpected fake git command: ${command}`);
  };

  return { calls, run, state };
}

const fakeRealpath = async (path) => path;

test("status reports an up-to-date canonical main without fetching", async () => {
  const git = createFakeExecutor();

  const result = await getMainWorktreeSyncStatus({
    git: git.run,
    resolveRealpath: fakeRealpath,
  });

  assert.equal(result.state, "UP_TO_DATE");
  assert.equal(result.canApply, false);
  assert.equal(result.mainWorktree, EXPECTED_MAIN_WORKTREE);
  assert.equal(result.remoteFreshness, "CACHED_LOCAL_REF");
  assert.equal(
    git.calls.some(({ args }) => args[0] === "fetch"),
    false,
  );
});

test("status reports a clean fast-forward as ready but does not mutate it", async () => {
  const git = createFakeExecutor({ behind: 3, incoming: ["README.md"] });

  const result = await getMainWorktreeSyncStatus({
    git: git.run,
    resolveRealpath: fakeRealpath,
  });

  assert.equal(result.state, "FAST_FORWARD_READY");
  assert.equal(result.canApply, true);
  assert.equal(result.behind, 3);
  assert.deepEqual(result.collisions, []);
  assert.equal(
    git.calls.some(({ args }) => args[0] === "merge"),
    false,
  );
});

test("apply fetches and preserves non-colliding tracked dirt byte-for-byte", async () => {
  const dirtyStatus = " D docs/local-only.md\0";
  const git = createFakeExecutor({
    behind: 2,
    incoming: ["src/remote-change.ts"],
    status: dirtyStatus,
    tracked: ["docs/local-only.md"],
  });

  const result = await applyMainWorktreeSync({
    git: git.run,
    resolveRealpath: fakeRealpath,
  });

  assert.equal(result.state, "APPLIED");
  assert.equal(result.localHead, REMOTE_HEAD);
  assert.equal(result.remoteHead, REMOTE_HEAD);
  assert.equal(result.statusPreserved, true);
  assert.equal(result.remoteFreshness, "FETCHED_AT_RUNTIME");
  assert.equal(
    git.calls.findIndex(({ args }) => args[0] === "fetch") <
      git.calls.findIndex(({ args }) => args[0] === "merge"),
    true,
  );
});

test("apply refuses a noncanonical invocation directory before any Git command", async () => {
  const git = createFakeExecutor({ behind: 1, incoming: ["src/new.ts"] });

  const result = await applyMainWorktreeSync({
    git: git.run,
    invocationCwd: "/global/backend/.codex/worktrees/topic",
    resolveRealpath: fakeRealpath,
  });

  assert.equal(result.state, "WRONG_CLI_CWD_HOLD");
  assert.equal(result.canApply, false);
  assert.equal(result.invokedFrom, "/global/backend/.codex/worktrees/topic");
  assert.deepEqual(git.calls, []);
});

test("apply fails closed when fetch fails", async () => {
  const git = createFakeExecutor({ fetchError: new Error("network down") });

  const result = await applyMainWorktreeSync({
    git: git.run,
    resolveRealpath: fakeRealpath,
  });

  assert.equal(result.state, "FETCH_FAILED");
  assert.equal(result.canApply, false);
  assert.match(result.error, /network down/);
  assert.equal(result.remoteFreshness, "FETCH_FAILED_AT_RUNTIME");
  assert.equal(
    git.calls.some(({ args }) => args[0] === "merge"),
    false,
  );
});

test("tracked paths touched by incoming commits block apply", async () => {
  const git = createFakeExecutor({
    behind: 1,
    incoming: ["docs/current.md"],
    status: " M docs/current.md\0",
    tracked: ["docs/current.md"],
  });

  const result = await applyMainWorktreeSync({
    git: git.run,
    resolveRealpath: fakeRealpath,
  });

  assert.equal(result.state, "LOCAL_COLLISION_HOLD");
  assert.deepEqual(result.collisions, [
    { kind: "tracked", path: "docs/current.md" },
  ]);
  assert.equal(
    git.calls.some(({ args }) => args[0] === "merge"),
    false,
  );
});

test("untracked and ignored paths that incoming commits overwrite block apply", async () => {
  const git = createFakeExecutor({
    behind: 1,
    ignored: ["generated/result.json"],
    incoming: ["generated/result.json", "notes/local.txt"],
    status: "?? notes/local.txt\0!! generated/\0",
    untracked: ["notes/local.txt"],
  });

  const result = await applyMainWorktreeSync({
    git: git.run,
    resolveRealpath: fakeRealpath,
  });

  assert.equal(result.state, "LOCAL_COLLISION_HOLD");
  assert.deepEqual(result.collisions, [
    { kind: "ignored", path: "generated/result.json" },
    { kind: "untracked", path: "notes/local.txt" },
  ]);
});

test("compressed local directory inventory permits a sibling incoming path", async () => {
  const git = createFakeExecutor({
    behind: 1,
    ignored: ["generated/cache/"],
    incoming: ["generated/result.json"],
    status: "!! generated/cache/\0",
  });

  const result = await getMainWorktreeSyncStatus({
    git: git.run,
    resolveRealpath: fakeRealpath,
  });

  assert.equal(result.state, "FAST_FORWARD_READY");
  assert.deepEqual(result.collisions, []);
});

test("an incoming gitignore change holds when its scope contains local untracked or ignored paths", async () => {
  const git = createFakeExecutor({
    behind: 1,
    ignored: ["generated/cache/"],
    incoming: ["generated/.gitignore"],
    status: "!! generated/cache/\0?? unrelated.txt\0",
    untracked: ["unrelated.txt"],
  });

  const result = await applyMainWorktreeSync({
    git: git.run,
    resolveRealpath: fakeRealpath,
  });

  assert.equal(result.state, "GITIGNORE_SCOPE_HOLD");
  assert.deepEqual(result.gitignoreScopeCollisions, [
    {
      kind: "ignored",
      path: "generated/cache/",
      rulePath: "generated/.gitignore",
    },
  ]);
  assert.equal(
    git.calls.some(({ args }) => args[0] === "merge"),
    false,
  );
});

test("an ahead-only main is held", async () => {
  const git = createFakeExecutor({ ahead: 2 });

  const result = await applyMainWorktreeSync({
    git: git.run,
    resolveRealpath: fakeRealpath,
  });

  assert.equal(result.state, "AHEAD_HOLD");
  assert.equal(result.ahead, 2);
});

test("a diverged main is held", async () => {
  const git = createFakeExecutor({ ahead: 1, behind: 4 });

  const result = await applyMainWorktreeSync({
    git: git.run,
    resolveRealpath: fakeRealpath,
  });

  assert.equal(result.state, "DIVERGED_HOLD");
});

test("a main branch outside the exact canonical root is held", async () => {
  const git = createFakeExecutor({ mainPath: "/tmp/not-the-root" });

  const result = await getMainWorktreeSyncStatus({
    git: git.run,
    resolveRealpath: fakeRealpath,
  });

  assert.equal(result.state, "WRONG_MAIN_WORKTREE_HOLD");
  assert.equal(result.canApply, false);
});

test("a locked or prunable canonical main worktree is held", async () => {
  for (const availability of [{ locked: true }, { prunable: true }]) {
    const git = createFakeExecutor(availability);

    const result = await getMainWorktreeSyncStatus({
      git: git.run,
      resolveRealpath: fakeRealpath,
    });

    assert.equal(result.state, "MAIN_WORKTREE_UNUSABLE_HOLD");
    assert.equal(result.canApply, false);
  }
});

test("read-tree rejection blocks merge", async () => {
  const git = createFakeExecutor({
    behind: 1,
    incoming: ["src/new.ts"],
    readTreeError: new Error("would overwrite"),
  });

  const result = await applyMainWorktreeSync({
    git: git.run,
    resolveRealpath: fakeRealpath,
  });

  assert.equal(result.state, "READ_TREE_HOLD");
  assert.match(result.error, /would overwrite/);
  assert.equal(
    git.calls.some(({ args }) => args[0] === "merge"),
    false,
  );
});

test("post-apply status drift is reported as a fail-closed partial application", async () => {
  const git = createFakeExecutor({
    behind: 1,
    incoming: ["src/new.ts"],
    postApplyStatus: "?? hook-created.txt\0",
  });

  const result = await applyMainWorktreeSync({
    git: git.run,
    resolveRealpath: fakeRealpath,
  });

  assert.equal(result.state, "POST_APPLY_DRIFT_HOLD");
  assert.equal(result.statusPreserved, false);
  assert.equal(result.localHead, REMOTE_HEAD);
});

test("post-apply remote ref advancement is held after merging only the preflight target", async () => {
  const advancedRemote = "3333333333333333333333333333333333333333";
  const git = createFakeExecutor({
    behind: 1,
    incoming: ["src/new.ts"],
    postApplyRemoteHead: advancedRemote,
  });

  const result = await applyMainWorktreeSync({
    git: git.run,
    resolveRealpath: fakeRealpath,
  });

  assert.equal(result.state, "POST_APPLY_HEAD_HOLD");
  assert.equal(result.localHead, REMOTE_HEAD);
  assert.equal(result.remoteHead, advancedRemote);
  assert.deepEqual(
    git.calls.filter(({ args }) => args[0] === "merge").map(({ args }) => args),
    [["merge", "--ff-only", REMOTE_HEAD]],
  );
});

test("pre-merge local status drift blocks before any merge", async () => {
  const git = createFakeExecutor({
    behind: 1,
    incoming: ["src/new.ts"],
    preMergeStatus: "?? concurrent.txt\0",
  });

  const result = await applyMainWorktreeSync({
    git: git.run,
    resolveRealpath: fakeRealpath,
  });

  assert.equal(result.state, "PRE_MERGE_DRIFT_HOLD");
  assert.equal(
    git.calls.some(({ args }) => args[0] === "merge"),
    false,
  );
});

test("pre-merge local HEAD or fetched remote ref drift blocks before merge", async () => {
  const driftCases = [
    { preMergeLocalHead: "3333333333333333333333333333333333333333" },
    { preMergeRemoteHead: "4444444444444444444444444444444444444444" },
  ];

  for (const drift of driftCases) {
    const git = createFakeExecutor({
      behind: 1,
      incoming: ["src/new.ts"],
      ...drift,
    });

    const result = await applyMainWorktreeSync({
      git: git.run,
      resolveRealpath: fakeRealpath,
    });

    assert.equal(result.state, "PRE_MERGE_DRIFT_HOLD");
    assert.equal(
      git.calls.some(({ args }) => args[0] === "merge"),
      false,
    );
  }
});

test("pre-merge re-runs read-tree and holds when the second dry run rejects", async () => {
  const git = createFakeExecutor({
    behind: 1,
    incoming: ["src/new.ts"],
    preMergeReadTreeError: new Error("concurrent index change"),
  });

  const result = await applyMainWorktreeSync({
    git: git.run,
    resolveRealpath: fakeRealpath,
  });

  assert.equal(result.state, "PRE_MERGE_RECHECK_HOLD");
  assert.equal(git.state.readTreeReads, 2);
  assert.equal(
    git.calls.some(({ args }) => args[0] === "merge"),
    false,
  );
});

test("the exact command allowlist rejects unneeded reads and every other mutation", () => {
  const prohibited = [
    ["stash"],
    ["reset", "--hard"],
    ["clean", "-fdx"],
    ["rebase", "origin/main"],
    ["push", "origin", "main"],
    ["branch", "-D", "topic"],
    ["worktree", "prune"],
    ["worktree", "add", "/tmp/topic"],
    ["checkout", "-f", "main"],
    ["commit", "-m", "unexpected"],
    ["merge", "--no-ff", "refs/remotes/origin/main"],
    ["merge", "--ff-only", "refs/remotes/origin/main"],
    ["fetch", "evil", "--prune"],
    ["log", "-1"],
  ];

  for (const args of prohibited) {
    assert.throws(
      () => assertGitCommandAllowed(args),
      /forbidden git command/i,
    );
  }
  assert.doesNotThrow(() =>
    assertGitCommandAllowed(["merge", "--ff-only", REMOTE_HEAD]),
  );
});

test("Git execution strips inherited repository and transport overrides", () => {
  const safe = createSafeGitEnvironment({
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "/tmp/objects",
    GIT_ASKPASS: "/tmp/askpass",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.sshCommand",
    GIT_CONFIG_VALUE_0: "/tmp/ssh",
    GIT_DIR: "/tmp/repository.git",
    GIT_INDEX_FILE: "/tmp/index",
    GIT_OBJECT_DIRECTORY: "/tmp/object-directory",
    GIT_SSH_COMMAND: "/tmp/ssh-command",
    GIT_TERMINAL_PROMPT: "1",
    GIT_WORK_TREE: "/tmp/worktree",
    HOME: "/safe/home",
    PATH: "/safe/bin",
    PRESERVED: "yes",
  });

  assert.equal(safe.HOME, "/safe/home");
  assert.equal(safe.PATH, "/safe/bin");
  assert.equal(safe.PRESERVED, "yes");
  assert.equal(safe.GIT_TERMINAL_PROMPT, "0");
  assert.deepEqual(
    Object.keys(safe).filter(
      (key) => key.startsWith("GIT_") && key !== "GIT_TERMINAL_PROMPT",
    ),
    [],
  );
});

test("CLI exits zero only for the explicitly safe states of each action", () => {
  assert.equal(getCliExitCode("status", "UP_TO_DATE"), 0);
  assert.equal(getCliExitCode("status", "FAST_FORWARD_READY"), 0);
  assert.equal(getCliExitCode("apply", "UP_TO_DATE"), 0);
  assert.equal(getCliExitCode("apply", "APPLIED"), 0);

  for (const [action, state] of [
    ["status", "AHEAD_HOLD"],
    ["status", "WRONG_MAIN_WORKTREE_HOLD"],
    ["status", "INTERNAL_ERROR_HOLD"],
    ["apply", "FAST_FORWARD_READY"],
    ["apply", "FETCH_FAILED"],
    ["invalid", "INVALID_ACTION_HOLD"],
  ]) {
    assert.equal(getCliExitCode(action, state), 2, `${action}:${state}`);
  }
});

test("CLI invalid action exits non-zero and emits a machine-readable hold", () => {
  const scriptPath = fileURLToPath(
    new URL("./governance-main-worktree-sync.mjs", import.meta.url),
  );
  const result = spawnSync(process.execPath, [scriptPath, "invalid"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).state, "INVALID_ACTION_HOLD");
});
