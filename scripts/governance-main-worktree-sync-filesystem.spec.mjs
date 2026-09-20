import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  chown,
  rename,
  lstat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectFilesystem } from "./governance-main-worktree-sync-filesystem.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "main-sync-proof-"));
  execFileSync("git", ["init", "-q", root]);
  await writeFile(path.join(root, ".gitignore"), ".superpowers/\n");
  await mkdir(path.join(root, ".superpowers"));
  await writeFile(path.join(root, ".superpowers", "local.json"), "original");
  const ignored = execFileSync(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  return { root, groups: { tracked: [], ignored, untracked: [] } };
}

test("exact ignored files permit an incoming sibling under an existing directory", async () => {
  const { root, groups } = await fixture();
  const result = await inspectFilesystem({
    root,
    incoming: [".superpowers/new.md"],
    groups,
    indexed: [],
  });
  assert.deepEqual(result.collisions, []);
  assert.match(result.preservationDigest, /^[a-f0-9]{64}$/);
});

test("same path and parent/child entity conflicts are held including empty directories", async () => {
  const { root, groups } = await fixture();
  await mkdir(path.join(root, "empty"));
  const result = await inspectFilesystem({
    root,
    incoming: [
      ".superpowers/local.json",
      ".superpowers/local.json/nested",
      ".superpowers",
      "empty",
    ],
    groups,
    indexed: [],
  });
  assert.deepEqual(
    new Set(result.collisions.map((x) => x.path)),
    new Set([
      ".superpowers/local.json",
      ".superpowers/local.json/nested",
      ".superpowers",
      "empty",
    ]),
  );
});

test("symlink ancestors are never followed even when Git does not enumerate their target", async () => {
  const { root, groups } = await fixture();
  await symlink(".superpowers", path.join(root, "link"));
  const result = await inspectFilesystem({
    root,
    incoming: ["link/new"],
    groups,
    indexed: [],
  });
  assert.equal(result.collisions[0].reason, "NON_DIRECTORY_ANCESTOR");
});

test("same-status bytes and mode changes alter preservation proof", async () => {
  const { root, groups } = await fixture();
  const inspect = () =>
    inspectFilesystem({ root, incoming: ["new.md"], groups, indexed: [] });
  const first = await inspect();
  await writeFile(path.join(root, ".superpowers/local.json"), "modified");
  const bytes = await inspect();
  assert.notEqual(first.preservationDigest, bytes.preservationDigest);
  await chmod(path.join(root, ".superpowers/local.json"), 0o600);
  assert.notEqual(
    bytes.preservationDigest,
    (await inspect()).preservationDigest,
  );
});

test("a new incoming destination changes the destination proof", async () => {
  const { root, groups } = await fixture();
  const first = await inspectFilesystem({
    root,
    incoming: ["new.md"],
    groups,
    indexed: [],
  });
  await writeFile(path.join(root, "new.md"), "concurrent");
  const second = await inspectFilesystem({
    root,
    incoming: ["new.md"],
    groups,
    indexed: [],
  });
  assert.notEqual(first.destinationDigest, second.destinationDigest);
  assert.equal(second.collisions[0].reason, "UNOWNED_DESTINATION");
});

test("indexed clean files may change, deleted local files retain absent-state evidence", async () => {
  const { root, groups } = await fixture();
  groups.tracked.push("deleted.md");
  await writeFile(path.join(root, "tracked.md"), "tracked");
  const result = await inspectFilesystem({
    root,
    incoming: ["tracked.md"],
    groups,
    indexed: ["tracked.md"],
  });
  assert.deepEqual(result.collisions, []);
});

test("path traversal and byte budgets fail closed", async () => {
  const { root, groups } = await fixture();
  await assert.rejects(
    inspectFilesystem({ root, incoming: ["../outside"], groups, indexed: [] }),
    /UNSAFE_PATH/,
  );
  await assert.rejects(
    inspectFilesystem({ root, incoming: [], groups, indexed: [], maxBytes: 1 }),
    /BYTE_LIMIT/,
  );
});

test("real Git status integrates exact ignored inventory without writing the checkout", async () => {
  const {
    getMainWorktreeSyncStatus,
    EXPECTED_MAIN_WORKTREE,
    assertGitCommandAllowed,
  } = await import("./governance-main-worktree-sync.mjs");
  const { root } = await fixture();
  const run = (args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" });
  run(["config", "user.name", "Local test"]);
  run(["config", "user.email", "local-test@example.invalid"]);
  run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  run(["add", ".gitignore"]);
  run(["commit", "-qm", "base"]);
  const before = run(["rev-parse", "HEAD"]).trim();
  run(["checkout", "-qb", "incoming"]);
  await writeFile(path.join(root, ".superpowers/new.md"), "incoming");
  run(["add", "-f", ".superpowers/new.md"]);
  run(["commit", "-qm", "incoming"]);
  run([
    "update-ref",
    "refs/remotes/origin/main",
    run(["rev-parse", "HEAD"]).trim(),
  ]);
  run(["checkout", "-q", "main"]);
  const git = async (args) => {
    assertGitCommandAllowed(args);
    assert.ok(!["fetch", "merge"].includes(args[0]));
    const stdout = run(args);
    return {
      stdout:
        args[0] === "worktree"
          ? stdout.replace(root, EXPECTED_MAIN_WORKTREE)
          : stdout,
    };
  };
  const inspect = () =>
    getMainWorktreeSyncStatus({
      git,
      resolveRealpath: async (value) => value,
      observeFilesystem: (options) => inspectFilesystem({ ...options, root }),
    });
  const status = await inspect();
  assert.equal(status.state, "FAST_FORWARD_READY");
  assert.equal(status.canApply, true);
  assert.equal(status.localPathCounts.ignored, 1);
  assert.equal(run(["rev-parse", "HEAD"]).trim(), before);
  await writeFile(path.join(root, ".superpowers/new.md"), "local");
  assert.equal((await inspect()).state, "FILESYSTEM_COLLISION_HOLD");
});

test("symlink leaf preserves target identity without reading the target bytes", async () => {
  const { root } = await fixture();
  await symlink("missing-target", path.join(root, "link"));
  const groups = { tracked: [], ignored: [], untracked: ["link"] };
  const result = await inspectFilesystem({
    root,
    incoming: ["link"],
    groups,
    indexed: [],
    maxBytes: 0,
  });
  assert.equal(result.observedBytes, 0);
  assert.equal(result.collisions[0].reason, "UNOWNED_DESTINATION");
});

test("directory-folded inventory and excessive paths fail closed", async () => {
  const { root, groups } = await fixture();
  await assert.rejects(
    inspectFilesystem({ root, incoming: [], groups, indexed: [], maxPaths: 0 }),
    /PATH_LIMIT/,
  );
  await assert.rejects(
    inspectFilesystem({
      root,
      incoming: [],
      groups: { untracked: [".superpowers"] },
      indexed: [],
    }),
    /INVENTORY_NOT_EXACT/,
  );
  await symlink(root, path.join(root, "root-alias"));
  await assert.rejects(
    inspectFilesystem({
      root: path.join(root, "root-alias"),
      incoming: [],
      groups,
      indexed: [],
    }),
    /ROOT_NOT_DIRECTORY/,
  );
});

test("Git nested-repository directory markers preserve the opaque directory and permit siblings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "main-sync-nested-repo-"));
  await mkdir(path.join(root, ".codex/worktrees/nested"), { recursive: true });
  await writeFile(path.join(root, ".codex/worktrees/nested/.git"), "gitdir");

  const result = await inspectFilesystem({
    root,
    incoming: [".codex/worktrees/sibling/new.md"],
    groups: {
      tracked: [],
      ignored: [".codex/worktrees/nested/"],
      untracked: [],
    },
    indexed: [],
  });

  assert.deepEqual(result.collisions, []);
  assert.equal(result.observedLocalPathCount, 1);
  assert.equal(result.observedBytes, 0);
  assert.match(result.preservationDigest, /^[a-f0-9]{64}$/u);
});

test("a Git directory marker fails closed unless its visible leaf is a real directory", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "main-sync-directory-marker-"),
  );
  await writeFile(path.join(root, "not-a-directory"), "bytes");

  await assert.rejects(
    inspectFilesystem({
      root,
      incoming: [],
      groups: {
        tracked: [],
        ignored: ["not-a-directory/"],
        untracked: [],
      },
      indexed: [],
    }),
    /FILESYSTEM_DIRECTORY_MARKER_NOT_DIRECTORY/u,
  );
});

test("a Git directory marker rejects an ordinary ignored directory without a repository boundary", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "main-sync-ordinary-directory-"),
  );
  await mkdir(path.join(root, "ordinary"));

  await assert.rejects(
    inspectFilesystem({
      root,
      incoming: [],
      groups: { tracked: [], ignored: ["ordinary/"], untracked: [] },
      indexed: [],
    }),
    /FILESYSTEM_DIRECTORY_MARKER_NOT_NESTED_REPOSITORY/u,
  );
});

test("a nested-repository marker rejects leaf replacement after its directory fd is opened", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "main-sync-nested-swap-"));
  const nested = path.join(root, "nested");
  await mkdir(nested);
  await writeFile(path.join(nested, ".git"), "gitdir");

  await duringOpen(
    (filename) =>
      filename.startsWith("/proc/self/fd/") && filename.endsWith("/nested"),
    async () => {
      await rename(nested, path.join(root, "retired"));
      await mkdir(nested);
      await writeFile(path.join(nested, ".git"), "replacement");
    },
    () =>
      assert.rejects(
        inspectFilesystem({
          root,
          incoming: [],
          groups: { tracked: [], ignored: ["nested/"], untracked: [] },
          indexed: [],
        }),
        /FILESYSTEM_OBSERVATION_DRIFT/u,
      ),
  );
});

// Interpose only in this test process, after the real open pinned an inode.
// The replacement is a real rename/new directory, not a synthetic proof value.
async function duringOpen(matches, replace, inspect) {
  const original = fs.promises.open;
  let replaced = false;
  fs.promises.open = async function (filename, ...args) {
    const handle = await original.call(this, filename, ...args);
    if (!replaced && matches(String(filename))) {
      replaced = true;
      await replace();
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    await inspect();
    assert.equal(replaced, true);
  } finally {
    fs.promises.open = original;
    syncBuiltinESMExports();
  }
}

test("rejects a renamed ancestor even though its open descriptor still reads the old file", async () => {
  const { root, groups } = await fixture();
  await duringOpen(
    (filename) =>
      filename.startsWith("/proc/self/fd/") &&
      filename.endsWith("/.superpowers"),
    async () => {
      await rename(path.join(root, ".superpowers"), path.join(root, "retired"));
      await mkdir(path.join(root, ".superpowers"));
      await writeFile(
        path.join(root, ".superpowers/local.json"),
        "replacement",
      );
    },
    () =>
      assert.rejects(
        inspectFilesystem({ root, groups, indexed: [], incoming: [] }),
        /FILESYSTEM_OBSERVATION_DRIFT/,
      ),
  );
});

test("rejects a renamed root while the original root descriptor remains valid", async () => {
  const { root, groups } = await fixture();
  await duringOpen(
    (filename) => filename === root,
    async () => {
      await rename(root, `${root}-retired`);
      await mkdir(root);
      await mkdir(path.join(root, ".superpowers"));
      await writeFile(
        path.join(root, ".superpowers/local.json"),
        "replacement",
      );
    },
    () =>
      assert.rejects(
        inspectFilesystem({ root, groups, indexed: [], incoming: [] }),
        /FILESYSTEM_OBSERVATION_DRIFT/,
      ),
  );
});

test("preservation binds file inode and numeric ownership independently of unchanged content", async () => {
  const { root, groups } = await fixture();
  const local = path.join(root, ".superpowers/local.json");
  const inspect = () =>
    inspectFilesystem({ root, groups, indexed: [], incoming: [] });
  const first = await inspect();
  await rename(local, path.join(root, "retired-file"));
  await writeFile(local, "original");
  const replaced = await inspect();
  assert.notEqual(replaced.preservationDigest, first.preservationDigest);
  if (process.getuid?.() === 0) {
    const originalOwner = await lstat(local);
    try {
      await chown(local, 65534, originalOwner.gid);
      const uidChanged = await inspect();
      assert.notEqual(
        uidChanged.preservationDigest,
        replaced.preservationDigest,
      );
      await chown(local, 65534, 65534);
      assert.notEqual(
        (await inspect()).preservationDigest,
        uidChanged.preservationDigest,
      );
    } finally {
      await chown(local, originalOwner.uid, originalOwner.gid);
    }
  }
});

test("non-UTF8 symlink targets fail closed instead of producing a lossy content proof", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "main-sync-link-bytes-"));
  await symlink(Buffer.from([0xff]), path.join(root, "link"));
  await assert.rejects(
    inspectFilesystem({
      root,
      incoming: [],
      groups: { untracked: ["link"] },
      indexed: [],
    }),
    /FILESYSTEM_SYMLINK_TARGET_ENCODING/,
  );
});
