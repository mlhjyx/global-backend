#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positional = args.filter((arg) => arg !== "--dry-run");

function fail(message) {
  console.error(`worktree:new: ${message}`);
  process.exit(1);
}

if (positional.length !== 1) {
  fail("usage: pnpm worktree:new <topic> [--dry-run]");
}

const topic = positional[0];
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topic)) {
  fail(
    "topic must use lowercase letters or digits separated by single hyphens",
  );
}

function git(args, options = {}) {
  const output = execFileSync("git", args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  return typeof output === "string" ? output.trim() : "";
}

function gitSucceeds(args, options = {}) {
  return (
    spawnSync("git", args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: "ignore",
    }).status === 0
  );
}

function pathEntryExists(candidate) {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function parseWorktrees(output) {
  return output
    .split(/\n\n+/)
    .map((block) => {
      const fields = new Map();
      for (const line of block.split("\n")) {
        const separator = line.indexOf(" ");
        if (separator === -1) fields.set(line, true);
        else fields.set(line.slice(0, separator), line.slice(separator + 1));
      }
      return fields;
    })
    .filter((fields) => fields.has("worktree"));
}

let worktrees;
try {
  worktrees = parseWorktrees(git(["worktree", "list", "--porcelain"]));
} catch (error) {
  fail(`cannot inspect Git worktrees: ${error.message}`);
}

const mainWorktrees = worktrees.filter(
  (fields) => fields.get("branch") === "refs/heads/main",
);
if (mainWorktrees.length !== 1) {
  fail(`expected exactly one main worktree, found ${mainWorktrees.length}`);
}

const mainRoot = mainWorktrees[0].get("worktree");
const worktreeRoot = path.join(mainRoot, ".codex", "worktrees");
const destination = path.join(worktreeRoot, topic);
const relativeDestination = path.relative(worktreeRoot, destination);
const branch = `codex/${topic}`;

if (
  relativeDestination.startsWith("..") ||
  path.isAbsolute(relativeDestination) ||
  relativeDestination === ""
) {
  fail("resolved destination escaped the worktree root");
}
if (pathEntryExists(destination)) {
  fail(`destination already exists: ${destination}`);
}
if (
  worktrees.some(
    (fields) =>
      path.resolve(fields.get("worktree")) === path.resolve(destination),
  )
) {
  fail(`destination is already registered as a worktree: ${destination}`);
}
if (
  !gitSucceeds(["check-ignore", "--quiet", ".codex/worktrees/.probe"], {
    cwd: mainRoot,
  })
) {
  fail(`${worktreeRoot} is not ignored by the main worktree`);
}

try {
  git(["fetch", "origin", "--prune"], { cwd: mainRoot, stdio: "inherit" });
} catch (error) {
  fail(`fetch failed: ${error.message}`);
}

const base = git(["rev-parse", "origin/main"], { cwd: mainRoot });
if (
  gitSucceeds(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: mainRoot,
  })
) {
  fail(`local branch already exists: ${branch}`);
}
if (
  gitSucceeds(
    ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
    { cwd: mainRoot },
  )
) {
  fail(`remote branch already exists: origin/${branch}`);
}

if (dryRun) {
  console.log(
    `dry-run ok\nbranch=${branch}\nbase=${base}\ndestination=${destination}`,
  );
  process.exit(0);
}

mkdirSync(worktreeRoot, { recursive: true });

try {
  git(["worktree", "add", "-b", branch, destination, "origin/main"], {
    cwd: mainRoot,
    stdio: "inherit",
  });
} catch (error) {
  fail(`git worktree add failed: ${error.message}`);
}

const createdHead = git(["rev-parse", "HEAD"], { cwd: destination });
const createdBranch = git(["branch", "--show-current"], { cwd: destination });
const createdStatus = git(["status", "--porcelain"], { cwd: destination });
if (createdHead !== base || createdBranch !== branch || createdStatus !== "") {
  fail(
    "post-create verification failed; preserve the new path and audit it before retrying",
  );
}

console.log(
  `created\nbranch=${branch}\nbase=${base}\ndestination=${destination}`,
);
