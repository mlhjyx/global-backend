import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { posix as pathPosix } from "node:path";

export const MAX_EVIDENCE_ARTIFACT_BYTES = 10 * 1024 * 1024;

function repositoryPathError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolveContainedPath(root, repoPath) {
  if (typeof repoPath !== "string" || repoPath.trim().length === 0) {
    throw repositoryPathError("REPO_PATH_INVALID", "repository path is empty");
  }
  const normalized = pathPosix.normalize(repoPath);
  if (
    repoPath.startsWith("/") ||
    repoPath.split("/").includes("..") ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw repositoryPathError(
      "REPO_PATH_INVALID",
      `path is not repository-relative: ${repoPath}`,
    );
  }
  const candidate = resolve(root, normalized);
  const fromRoot = relative(resolve(root), candidate);
  if (
    !fromRoot ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${pathPosix.sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw repositoryPathError(
      "REPO_PATH_INVALID",
      `path escapes repository root: ${repoPath}`,
    );
  }
  return candidate;
}

export async function resolveRepoOutputFile(root, repoPath) {
  const candidate = resolveContainedPath(root, repoPath);
  await assertNoSymlinkComponents(root, candidate, repoPath);
  const [realRoot, realParent] = await Promise.all([
    realpath(root),
    realpath(dirname(candidate)),
  ]);
  assertContainedRealPath(realRoot, realParent, repoPath);
  try {
    const metadata = await lstat(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw repositoryPathError(
        "REPO_FILE_NOT_REGULAR",
        `output path is not a regular repository file: ${repoPath}`,
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return candidate;
}

function assertContainedRealPath(realRoot, realCandidate, repoPath) {
  const fromRoot = relative(realRoot, realCandidate);
  if (
    !fromRoot ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${pathPosix.sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw repositoryPathError(
      "REPO_PATH_INVALID",
      `resolved path escapes repository root: ${repoPath}`,
    );
  }
}

async function assertNoSymlinkComponents(root, candidate, repoPath) {
  const components = relative(resolve(root), candidate)
    .split(pathPosix.sep)
    .filter(Boolean);
  let current = resolve(root);
  for (const component of components) {
    current = resolve(current, component);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw repositoryPathError(
          "REPO_FILE_NOT_REGULAR",
          `repository path contains a symbolic link: ${repoPath}`,
        );
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

export async function readRepoRegularFile(root, repoPath, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_EVIDENCE_ARTIFACT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw repositoryPathError("REPO_SIZE_LIMIT_INVALID", "maxBytes is invalid");
  }
  const candidate = resolveContainedPath(root, repoPath);
  await assertNoSymlinkComponents(root, candidate, repoPath);
  const [realRoot, realCandidate, metadata] = await Promise.all([
    realpath(root),
    realpath(candidate),
    lstat(candidate),
  ]);
  assertContainedRealPath(realRoot, realCandidate, repoPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw repositoryPathError(
      "REPO_FILE_NOT_REGULAR",
      `path is not a regular repository file: ${repoPath}`,
    );
  }
  if (metadata.size > maxBytes) {
    throw repositoryPathError(
      "REPO_FILE_TOO_LARGE",
      `repository file exceeds ${maxBytes} bytes: ${repoPath}`,
    );
  }

  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()) {
      throw repositoryPathError(
        "REPO_FILE_NOT_REGULAR",
        `opened path is not a regular repository file: ${repoPath}`,
      );
    }
    if (openedMetadata.size > maxBytes) {
      throw repositoryPathError(
        "REPO_FILE_TOO_LARGE",
        `opened repository file exceeds ${maxBytes} bytes: ${repoPath}`,
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
