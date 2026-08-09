import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readRepoRegularFile,
  resolveRepoOutputFile,
} from "./governance-path-contracts.mjs";

test("repository artifact reader admits only bounded regular files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "governance-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "evidence"));
  await writeFile(join(root, "evidence", "receipt.json"), "receipt");

  assert.equal(
    (await readRepoRegularFile(root, "evidence/receipt.json")).toString(),
    "receipt",
  );
  await assert.rejects(
    readRepoRegularFile(root, "/etc/passwd"),
    (error) => error?.code === "REPO_PATH_INVALID",
  );
  await assert.rejects(
    readRepoRegularFile(root, "../outside"),
    (error) => error?.code === "REPO_PATH_INVALID",
  );
});

test("repository artifact reader rejects symlinks and oversized files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "governance-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "large.bin"), "12345");
  await symlink(join(root, "large.bin"), join(root, "link.bin"));
  await mkdir(join(root, "real-directory"));
  await writeFile(join(root, "real-directory", "nested.bin"), "nested");
  await symlink(
    join(root, "real-directory"),
    join(root, "linked-directory"),
  );

  await assert.rejects(
    readRepoRegularFile(root, "link.bin"),
    (error) => error?.code === "REPO_FILE_NOT_REGULAR",
  );
  await assert.rejects(
    readRepoRegularFile(root, "large.bin", { maxBytes: 4 }),
    (error) => error?.code === "REPO_FILE_TOO_LARGE",
  );
  await assert.rejects(
    readRepoRegularFile(root, "linked-directory/nested.bin"),
    (error) => error?.code === "REPO_FILE_NOT_REGULAR",
  );
});

test("repository output resolver rejects escaping and symlink destinations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "governance-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "releases"));
  await writeFile(join(root, "target.md"), "existing");
  await symlink(join(root, "target.md"), join(root, "releases", "link.md"));

  assert.equal(
    await resolveRepoOutputFile(root, "releases/new.md"),
    join(root, "releases", "new.md"),
  );
  await assert.rejects(
    resolveRepoOutputFile(root, "../outside.md"),
    (error) => error?.code === "REPO_PATH_INVALID",
  );
  await assert.rejects(
    resolveRepoOutputFile(root, "releases/link.md"),
    (error) => error?.code === "REPO_FILE_NOT_REGULAR",
  );
});
