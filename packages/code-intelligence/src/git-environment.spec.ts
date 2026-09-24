import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  assertNoUntrackedIndexInputs,
  extractGitArchive,
} from "./codegraph-pilot";
import { createEvidence } from "./scan";
import { createSafeGitEnvironment } from "./utils";

const execFile = promisify(execFileCallback);

async function repository(prefix: string): Promise<{
  root: string;
  git: (...args: string[]) => Promise<string>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const git = async (...args: string[]) =>
    (
      await execFile("git", args, {
        cwd: root,
        encoding: "utf8",
        env: createSafeGitEnvironment(),
      })
    ).stdout.trim();
  await git("init", "--quiet", "-b", "main");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "user.name", "Git Environment Test");
  return { root, git };
}

async function withInheritedEnvironment<T>(
  overrides: Record<string, string>,
  action: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, overrides);
  try {
    return await action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("createSafeGitEnvironment strips inherited GIT_* overrides", () => {
  const safe = createSafeGitEnvironment({
    GIT_CONFIG_PARAMETERS: "'core.bare=true'",
    GIT_DIR: "/tmp/repository.git",
    GIT_INDEX_FILE: "/tmp/index",
    GIT_PREFIX: "",
    GIT_TERMINAL_PROMPT: "1",
    GIT_WORK_TREE: "/tmp/worktree",
    HOME: "/safe/home",
    PATH: "/safe/bin",
  });

  assert.deepEqual(safe, {
    GIT_TERMINAL_PROMPT: "0",
    HOME: "/safe/home",
    PATH: "/safe/bin",
  });
});

test("git reads target the explicit repository and leave an inherited GIT_DIR untouched", async () => {
  const outside = await repository("code-intelligence-outside-");
  const fixture = await repository("code-intelligence-fixture-");
  try {
    await writeFile(path.join(outside.root, "outside.txt"), "outside\n");
    await outside.git("add", "outside.txt");
    await outside.git("commit", "--quiet", "-m", "outside");
    const outsideGitDirectory = path.join(outside.root, ".git");
    const snapshot = async () => ({
      config: await readFile(path.join(outsideGitDirectory, "config")),
      index: await readFile(path.join(outsideGitDirectory, "index")),
      refs: await outside.git("for-each-ref"),
    });
    const before = await snapshot();

    await writeFile(
      path.join(fixture.root, ".gitignore"),
      ".code-intelligence/\n",
    );
    await writeFile(path.join(fixture.root, "truth.txt"), "from fixture\n");
    await fixture.git("add", ".gitignore", "truth.txt");
    await fixture.git("commit", "--quiet", "-m", "fixture");
    const commit = await fixture.git("rev-parse", "HEAD");
    await writeFile(path.join(fixture.root, "stray.ts"), "export {};\n");
    const destination = path.join(
      fixture.root,
      ".code-intelligence",
      "archive",
    );

    await withInheritedEnvironment(
      { GIT_DIR: outsideGitDirectory, GIT_PREFIX: "" },
      async () => {
        await assert.rejects(
          assertNoUntrackedIndexInputs(fixture.root),
          /stray\.ts/,
        );
        await extractGitArchive(fixture.root, commit, destination);
        await createEvidence(fixture.root);
      },
    );

    assert.equal(
      await readFile(path.join(destination, "truth.txt"), "utf8"),
      "from fixture\n",
    );
    assert.deepEqual(await snapshot(), before);
  } finally {
    await rm(outside.root, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
  }
});
