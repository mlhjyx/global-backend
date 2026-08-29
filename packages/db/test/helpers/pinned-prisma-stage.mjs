import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { relative, resolve } from "node:path";

const COMMIT = /^[0-9a-f]{40}$/u;
const PREFIX = /^[a-z0-9][a-z0-9-]{0,63}-$/u;
const ARCHIVE_PATHS = Object.freeze([
  "packages/db/prisma/migrations",
  "packages/db/prisma/schema.prisma",
]);
const MAX_GIT_OUTPUT_BYTES = 128 * 1024 * 1024;

function gitEnvironment() {
  const environment = { ...process.env };
  for (const name of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_WORK_TREE",
  ]) {
    delete environment[name];
  }
  return environment;
}

function runGit(repositoryRoot, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: options.encoding ?? "utf8",
    env: gitEnvironment(),
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  if (result.status !== 0) {
    const stdout = Buffer.isBuffer(result.stdout)
      ? result.stdout.toString("utf8")
      : result.stdout;
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : result.stderr;
    throw new Error(
      `git ${args.join(" ")} failed (${result.status}):\n${stdout}\n${stderr}`,
    );
  }
  return result.stdout;
}

function hardenExtractedTree(path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`pinned Prisma stage contains a symlink: ${path}`);
  }
  if (metadata.isDirectory()) {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) {
      hardenExtractedTree(resolve(path, entry));
    }
    return;
  }
  if (!metadata.isFile()) {
    throw new Error(`pinned Prisma stage contains a non-regular path: ${path}`);
  }
  chmodSync(path, 0o600);
}

function listExtractedFiles(root, path = root) {
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryPath = resolve(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...listExtractedFiles(root, entryPath));
    } else if (entry.isFile()) {
      files.push(relative(root, entryPath));
    } else {
      throw new Error(
        `pinned Prisma stage contains an unsupported path: ${entryPath}`,
      );
    }
  }
  return files.sort();
}

function exactCommit(repositoryRoot, commit) {
  const resolvedCommit = runGit(repositoryRoot, [
    "rev-parse",
    "--verify",
    `${commit}^{commit}`,
  ]).trim();
  if (resolvedCommit !== commit) {
    throw new Error(
      `pinned Prisma stage commit mismatch: expected ${commit}, received ${resolvedCommit}`,
    );
  }
  return resolvedCommit;
}

export function materializePinnedPrismaStage({
  repositoryRoot,
  commit,
  prefix,
}) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) {
    throw new TypeError("repositoryRoot must be a non-empty string");
  }
  if (!COMMIT.test(commit)) {
    throw new TypeError("commit must be an exact lowercase 40-character SHA");
  }
  if (!PREFIX.test(prefix)) {
    throw new TypeError(
      "prefix must be a bounded lowercase task prefix ending in a hyphen",
    );
  }

  const exactRepositoryRoot = realpathSync(repositoryRoot);
  if (!lstatSync(exactRepositoryRoot).isDirectory()) {
    throw new TypeError("repositoryRoot must resolve to a directory");
  }
  const sourceCommit = exactCommit(exactRepositoryRoot, commit);
  const temporaryParent = resolve(exactRepositoryRoot, "packages/db");
  if (!lstatSync(temporaryParent).isDirectory()) {
    throw new Error("repositoryRoot is missing packages/db");
  }
  const root = mkdtempSync(resolve(temporaryParent, `.${prefix}`));
  chmodSync(root, 0o700);

  try {
    const archive = runGit(
      exactRepositoryRoot,
      ["archive", "--format=tar", sourceCommit, "--", ...ARCHIVE_PATHS],
      { encoding: null },
    );
    const extractResult = spawnSync(
      "tar",
      ["-x", "-f", "-", "-C", root, "--no-same-owner", "--no-same-permissions"],
      {
        encoding: "utf8",
        input: archive,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
      },
    );
    if (extractResult.status !== 0) {
      throw new Error(
        `tar extraction failed (${extractResult.status}):\n${extractResult.stdout}\n${extractResult.stderr}`,
      );
    }
    hardenExtractedTree(root);

    const prismaRoot = resolve(root, "packages/db/prisma");
    const migrationRoot = resolve(prismaRoot, "migrations");
    const schemaPath = resolve(prismaRoot, "schema.prisma");
    if (!lstatSync(prismaRoot).isDirectory()) {
      throw new Error("pinned Prisma stage is missing packages/db/prisma");
    }
    if (!lstatSync(migrationRoot).isDirectory()) {
      throw new Error("pinned Prisma stage is missing the migration tree");
    }
    if (!lstatSync(schemaPath).isFile()) {
      throw new Error("pinned Prisma stage is missing schema.prisma");
    }

    const trackedPaths = runGit(exactRepositoryRoot, [
      "ls-tree",
      "-r",
      "--name-only",
      sourceCommit,
      "--",
      ...ARCHIVE_PATHS,
    ])
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort();
    const extractedPaths = listExtractedFiles(root);
    if (JSON.stringify(extractedPaths) !== JSON.stringify(trackedPaths)) {
      throw new Error("pinned Prisma stage archive path inventory mismatch");
    }

    return Object.freeze({
      commit: sourceCommit,
      migrationRoot,
      prismaRoot,
      root,
      schemaPath,
      trackedPaths: Object.freeze(trackedPaths),
    });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
