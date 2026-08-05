import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

import { canonicalDigest } from "./context-engine";

export interface CompiledRuntimeGuard {
  readonly schemaVersion: "compiled-runtime-guard/2026-08-05-v1";
  readonly bindingDigest: string;
  readonly artifactTreeDigest: string;
  readonly artifactCount: number;
}

export interface CompiledRuntimeGuardAttestation extends CompiledRuntimeGuard {
  readonly artifacts: readonly {
    path: string;
    sha256: string;
  }[];
}

interface ArtifactIdentity {
  path: string;
  absolutePath: string;
  realPath: string;
  device: number;
  inode: number;
  size: number;
  sha256: string;
}

interface GuardState {
  repositoryRoot: string;
  artifacts: readonly ArtifactIdentity[];
  attestation: CompiledRuntimeGuardAttestation;
}

const GUARDS = new WeakMap<object, GuardState>();
const SHA256 = /^[0-9a-f]{64}$/u;

function fail(code: string): never {
  throw new Error(code);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.split("/").includes("..") &&
    posix.normalize(path) === path &&
    path !== "."
  );
}

function withinRoot(root: string, path: string): boolean {
  const location = relative(root, path);
  return (
    location !== ".." &&
    !location.startsWith(`..${sep}`) &&
    !isAbsolute(location)
  );
}

async function readArtifact(
  root: string,
  path: string,
): Promise<ArtifactIdentity> {
  if (!safeRelativePath(path)) fail("COMPILED_RUNTIME_ARTIFACT_INVALID");
  const absolutePath = resolve(root, path);
  if (!withinRoot(root, absolutePath))
    fail("COMPILED_RUNTIME_ARTIFACT_INVALID");
  const metadata = await lstat(absolutePath).catch(() =>
    fail("COMPILED_RUNTIME_ARTIFACT_INVALID"),
  );
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail("COMPILED_RUNTIME_ARTIFACT_INVALID");
  }
  const realPath = await realpath(absolutePath);
  if (!withinRoot(root, realPath)) fail("COMPILED_RUNTIME_ARTIFACT_INVALID");
  let handle;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch {
    fail("COMPILED_RUNTIME_ARTIFACT_INVALID");
  }
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino
    ) {
      fail("COMPILED_RUNTIME_ARTIFACT_INVALID");
    }
    const bytes = await handle.readFile();
    return Object.freeze({
      path,
      absolutePath,
      realPath,
      device: opened.dev,
      inode: opened.ino,
      size: opened.size,
      sha256: sha256(bytes),
    });
  } finally {
    await handle.close();
  }
}

export async function createCompiledRuntimeGuard(input: {
  repositoryRoot: string;
  artifactPaths: readonly string[];
  binding: unknown;
}): Promise<CompiledRuntimeGuard> {
  const requestedRoot = await lstat(input.repositoryRoot).catch(() =>
    fail("COMPILED_RUNTIME_ROOT_INVALID"),
  );
  if (!requestedRoot.isDirectory() || requestedRoot.isSymbolicLink()) {
    fail("COMPILED_RUNTIME_ROOT_INVALID");
  }
  const repositoryRoot = await realpath(input.repositoryRoot).catch(() =>
    fail("COMPILED_RUNTIME_ROOT_INVALID"),
  );
  const rootMetadata = await lstat(repositoryRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail("COMPILED_RUNTIME_ROOT_INVALID");
  }
  if (
    input.artifactPaths.length === 0 ||
    new Set(input.artifactPaths).size !== input.artifactPaths.length
  ) {
    fail("COMPILED_RUNTIME_ARTIFACT_INVALID");
  }
  const artifactPaths = [...input.artifactPaths].sort();
  const artifacts = Object.freeze(
    await Promise.all(
      artifactPaths.map((path) => readArtifact(repositoryRoot, path)),
    ),
  );
  if (
    new Set(artifacts.map(({ realPath }) => realPath)).size !==
      artifacts.length ||
    new Set(artifacts.map(({ device, inode }) => `${device}:${inode}`)).size !==
      artifacts.length
  ) {
    fail("COMPILED_RUNTIME_ARTIFACT_INVALID");
  }
  const bindingDigest = canonicalDigest(input.binding);
  if (!SHA256.test(bindingDigest)) fail("COMPILED_RUNTIME_BINDING_INVALID");
  const publicArtifacts = Object.freeze(
    artifacts.map(({ path, sha256: digest }) =>
      Object.freeze({ path, sha256: digest }),
    ),
  );
  const artifactTreeDigest = canonicalDigest(publicArtifacts);
  const attestation = Object.freeze({
    schemaVersion: "compiled-runtime-guard/2026-08-05-v1" as const,
    bindingDigest,
    artifactTreeDigest,
    artifactCount: artifacts.length,
    artifacts: publicArtifacts,
  });
  const guard = Object.freeze({
    schemaVersion: attestation.schemaVersion,
    bindingDigest,
    artifactTreeDigest,
    artifactCount: artifacts.length,
  });
  GUARDS.set(guard, { repositoryRoot, artifacts, attestation });
  return guard;
}

export async function assertCompiledRuntimeGuardCurrent(
  guard: CompiledRuntimeGuard,
): Promise<void> {
  const state = GUARDS.get(guard);
  if (!state) fail("COMPILED_RUNTIME_GUARD_UNTRUSTED");
  const currentRoot = await realpath(state.repositoryRoot).catch(() =>
    fail("COMPILED_RUNTIME_DRIFT"),
  );
  if (currentRoot !== state.repositoryRoot) {
    fail("COMPILED_RUNTIME_DRIFT");
  }
  let current: readonly ArtifactIdentity[];
  try {
    current = await Promise.all(
      state.artifacts.map(({ path }) =>
        readArtifact(state.repositoryRoot, path),
      ),
    );
  } catch {
    return fail("COMPILED_RUNTIME_DRIFT");
  }
  for (let index = 0; index < current.length; index += 1) {
    const expected = state.artifacts[index]!;
    const observed = current[index]!;
    if (
      observed.realPath !== expected.realPath ||
      observed.device !== expected.device ||
      observed.inode !== expected.inode ||
      observed.size !== expected.size ||
      observed.sha256 !== expected.sha256
    ) {
      fail("COMPILED_RUNTIME_DRIFT");
    }
  }
}

export function getCompiledRuntimeGuardAttestation(
  guard: CompiledRuntimeGuard,
): CompiledRuntimeGuardAttestation | undefined {
  return GUARDS.get(guard)?.attestation;
}
