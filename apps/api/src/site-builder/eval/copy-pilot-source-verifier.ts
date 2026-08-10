import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalDigest } from "../../model-runtime/context-engine";
import {
  createCompiledRuntimeGuard,
  validateCompiledRuntimeExpectation,
  type CompiledRuntimeExpectation,
} from "../../model-runtime/compiled-runtime-guard";
import { COPY_CAPABILITY_PILOT_PLAN } from "./copy-capability-pilot";
import { COPY_REAL_CAPABILITY_ADMISSION_SOURCE } from "./copy-real-capability-admission";
import { COPY_SONNET_RECOVERY_ADMISSION_SOURCE } from "./copy-sonnet-recovery-admission";
import {
  COPY_SONNET_RECOVERY_DUPLICATE_PREVENTION,
  COPY_SONNET_RECOVERY_RUNTIME_BINDING_ARTIFACT_ID,
  COPY_SONNET_RECOVERY_RUNTIME_BINDING_OUTPUT_PATH,
  COPY_SONNET_RECOVERY_RUNTIME_MANIFEST_ID,
  COPY_SONNET_RECOVERY_SOURCE_MANIFEST_PATH,
} from "./copy-sonnet-recovery-contract";

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const MAXIMUM_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAXIMUM_SOURCE_FILE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_SOURCE_TOTAL_BYTES = 128 * 1024 * 1024;
const MAXIMUM_SOURCE_FILES = 512;

export const COPY_PILOT_COMPILED_BUILD_COMMANDS = Object.freeze([
  "pnpm --filter @global/db generate",
  "pnpm --filter @global/contracts build",
  "pnpm --filter @global/api build",
] as const);

interface SourceFile {
  role: string;
  path: string;
  sha256: string;
}

interface ManifestArtifact {
  schemaVersion: string;
  artifactId: string;
  classification: string;
  fixedSourceCommit: string;
  preparationHeadCommit: string;
  createOnly: boolean;
  dispatchAuthorization: string;
  dispatchCapable: boolean;
  observedNetworkCalls: number;
  observedModelWireCalls: number;
  observedModelCost: { CNY: number; USD: number };
  manifest: {
    schemaVersion: string;
    manifestId: string;
    fixedSourceCommit: string;
    sourceBundleDigest: string;
    planDigest: string;
    dispatchAuthorization: string;
    taskId: string;
    plannedExecutions: number;
    maximumWireCalls: number;
    maximumRepairCallsPerExecution: number;
    executions: unknown;
  };
  sourceBundle: {
    schemaVersion: string;
    files: readonly SourceFile[];
    digest: string;
  };
  compiledRuntimeExpectation: CompiledRuntimeExpectation;
  duplicatePrevention?: unknown;
  recoveryManifestReference?: { path?: unknown };
  requiredMergeMethod?: unknown;
  artifactDigest: string;
  [key: string]: unknown;
}

export interface CopyPilotVerifiedSource {
  readonly __opaque?: never;
}

export interface CopyPilotVerifiedSourceBinding {
  repositoryRoot: string;
  manifestArtifactPath: string;
  fixedSourceCommit: string;
  preparationHeadCommit: string;
  sourceBundleDigest: string;
  manifestDigest: string;
  artifactDigest: string;
  compiledRuntimeExpectation: CompiledRuntimeExpectation;
}

const VERIFIED_SOURCES = new WeakMap<object, CopyPilotVerifiedSourceBinding>();

function fail(code: string): never {
  throw new Error(code);
}

function gitBytes(root: string, args: readonly string[]): Buffer {
  try {
    return execFileSync("git", [...args], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return fail("COPY_PILOT_GIT_VERIFICATION_FAILED");
  }
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.split("/").includes("..")
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

function sameOpenedNode(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

async function openNoFollow(
  path: string,
  flags: number,
  errorCode: string,
): Promise<FileHandle> {
  try {
    return await open(
      path,
      flags | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return fail(errorCode);
  }
}

async function openStableDirectory(
  path: string,
  errorCode: string,
): Promise<{ handle: FileHandle; stat: BigIntStats }> {
  const handle = await openNoFollow(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY,
    errorCode,
  );
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory()) fail(errorCode);
    return { handle, stat };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function descriptorPath(handle: FileHandle, name: string): string {
  return `/proc/self/fd/${handle.fd}/${name}`;
}

async function readStableRegularHandle(
  handle: FileHandle,
  maximumBytes: number,
  errorCode: string,
): Promise<Buffer> {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile() || before.size > BigInt(maximumBytes)) {
    fail(errorCode);
  }
  const expectedSize = Number(before.size);
  const bytes = Buffer.alloc(expectedSize + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  if (!sameOpenedNode(before, after) || offset !== expectedSize) {
    fail(errorCode);
  }
  return bytes.subarray(0, offset);
}

async function secureRead(
  root: string,
  repositoryPath: string,
  maximumBytes: number,
  errorCode: string,
): Promise<Buffer> {
  if (!safeRelativePath(repositoryPath)) fail(errorCode);
  const openedDirectories: Array<{
    handle: FileHandle;
    stat: BigIntStats;
  }> = [];
  let fileHandle: FileHandle | undefined;
  try {
    openedDirectories.push(await openStableDirectory(root, errorCode));
    const components = repositoryPath.split("/");
    for (let index = 0; index < components.length; index += 1) {
      const parent = openedDirectories.at(-1);
      if (parent == null) fail(errorCode);
      const parentBefore = await parent.handle.stat({ bigint: true });
      if (!sameOpenedNode(parent.stat, parentBefore)) fail(errorCode);
      const finalComponent = index === components.length - 1;
      const child = await openNoFollow(
        descriptorPath(parent.handle, components[index]),
        constants.O_RDONLY |
          (finalComponent ? 0 : constants.O_DIRECTORY),
        errorCode,
      );
      const parentAfter = await parent.handle.stat({ bigint: true });
      if (!sameOpenedNode(parentBefore, parentAfter)) {
        await child.close().catch(() => undefined);
        fail(errorCode);
      }
      if (finalComponent) {
        fileHandle = child;
      } else {
        try {
          const childStat = await child.stat({ bigint: true });
          if (!childStat.isDirectory()) fail(errorCode);
          openedDirectories.push({ handle: child, stat: childStat });
        } catch (error) {
          await child.close().catch(() => undefined);
          throw error;
        }
      }
    }
    if (fileHandle == null) fail(errorCode);
    const bytes = await readStableRegularHandle(
      fileHandle,
      maximumBytes,
      errorCode,
    );
    for (const directory of openedDirectories) {
      const after = await directory.handle.stat({ bigint: true });
      if (!sameOpenedNode(directory.stat, after)) fail(errorCode);
    }
    return bytes;
  } finally {
    await fileHandle?.close().catch(() => undefined);
    for (const directory of openedDirectories.reverse()) {
      await directory.handle.close().catch(() => undefined);
    }
  }
}

function parseArtifact(bytes: Buffer): ManifestArtifact {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return fail("COPY_PILOT_MANIFEST_INVALID");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("COPY_PILOT_MANIFEST_INVALID");
  }
  const artifact = value as ManifestArtifact;
  const { artifactDigest, ...withoutDigest } = artifact;
  try {
    validateCompiledRuntimeExpectation(artifact.compiledRuntimeExpectation);
  } catch {
    return fail("COPY_PILOT_MANIFEST_INVALID");
  }
  const sharedInvalid =
    artifact.createOnly !== true ||
    artifact.dispatchAuthorization !== "NOT_AUTHORIZED" ||
    artifact.dispatchCapable !== false ||
    artifact.observedNetworkCalls !== 0 ||
    artifact.observedModelWireCalls !== 0 ||
    artifact.observedModelCost?.CNY !== 0 ||
    artifact.observedModelCost?.USD !== 0 ||
    !SHA256.test(artifactDigest) ||
    artifactDigest !== canonicalDigest(withoutDigest) ||
    !GIT_COMMIT.test(artifact.fixedSourceCommit) ||
    !GIT_COMMIT.test(artifact.preparationHeadCommit) ||
    !artifact.manifest ||
    artifact.manifest.fixedSourceCommit !== artifact.fixedSourceCommit ||
    artifact.manifest.dispatchAuthorization !== "NOT_AUTHORIZED" ||
    artifact.manifest.taskId !== "site_builder.copy" ||
    !Array.isArray(artifact.sourceBundle.files) ||
    artifact.sourceBundle.files.length === 0 ||
    artifact.sourceBundle.digest !==
      canonicalDigest(artifact.sourceBundle.files) ||
    artifact.manifest.sourceBundleDigest !== artifact.sourceBundle.digest ||
    artifact.compiledRuntimeExpectation.buildSourceCommit !==
      artifact.fixedSourceCommit ||
    artifact.compiledRuntimeExpectation.sourceBundleDigest !==
      artifact.sourceBundle.digest ||
    canonicalDigest(artifact.compiledRuntimeExpectation.buildCommands) !==
      canonicalDigest(COPY_PILOT_COMPILED_BUILD_COMMANDS);
  const legacyInvalid =
    artifact.schemaVersion ===
    "site-builder-copy-real-capability-manifest-prep/2026-08-05-v1"
      ? artifact.classification !== "FIXED_SOURCE_CREATE_ONLY" ||
        artifact.manifest.schemaVersion !==
          "site-builder-copy-real-capability-manifest/2026-08-05-v1" ||
        artifact.manifest.planDigest !==
          canonicalDigest(COPY_CAPABILITY_PILOT_PLAN) ||
        artifact.manifest.plannedExecutions !== 3 ||
        artifact.manifest.maximumWireCalls !== 6 ||
        artifact.manifest.maximumRepairCallsPerExecution !== 1 ||
        canonicalDigest(artifact.manifest.executions) !==
          canonicalDigest(COPY_REAL_CAPABILITY_ADMISSION_SOURCE.executions) ||
        artifact.sourceBundle.schemaVersion !==
          "site-builder-copy-real-capability-source-bundle/2026-08-05-v1"
      : null;
  const recoveryInvalid =
    artifact.schemaVersion ===
    "site-builder-copy-sonnet-recovery-runtime-binding-prep/2026-08-08-v1"
      ? artifact.classification !==
          "FIXED_SOURCE_CREATE_ONLY_SONNET_RECOVERY_RUNTIME" ||
        artifact.artifactId !==
          COPY_SONNET_RECOVERY_RUNTIME_BINDING_ARTIFACT_ID ||
        artifact.requiredMergeMethod !== "merge_commit" ||
        artifact.manifest.schemaVersion !==
          "site-builder-copy-sonnet-recovery-runtime-manifest/2026-08-08-v1" ||
        artifact.manifest.manifestId !==
          COPY_SONNET_RECOVERY_RUNTIME_MANIFEST_ID ||
        artifact.recoveryManifestReference?.path !==
          COPY_SONNET_RECOVERY_SOURCE_MANIFEST_PATH ||
        artifact.manifest.planDigest !==
          COPY_SONNET_RECOVERY_ADMISSION_SOURCE.planDigest ||
        artifact.manifest.plannedExecutions !== 1 ||
        artifact.manifest.maximumWireCalls !== 2 ||
        artifact.manifest.maximumRepairCallsPerExecution !== 1 ||
        canonicalDigest(artifact.manifest.executions) !==
          canonicalDigest(COPY_SONNET_RECOVERY_ADMISSION_SOURCE.executions) ||
        artifact.sourceBundle.schemaVersion !==
          "site-builder-copy-sonnet-recovery-runtime-source-bundle/2026-08-08-v1" ||
        canonicalDigest(artifact.duplicatePrevention) !==
          canonicalDigest(COPY_SONNET_RECOVERY_DUPLICATE_PREVENTION)
      : null;
  if (
    sharedInvalid ||
    (legacyInvalid == null && recoveryInvalid == null) ||
    legacyInvalid === true ||
    recoveryInvalid === true
  ) {
    fail("COPY_PILOT_MANIFEST_INVALID");
  }
  return artifact;
}

export async function createCopyPilotVerifiedSource(input: {
  repositoryRoot: string;
  manifestArtifactPath: string;
}): Promise<CopyPilotVerifiedSource> {
  const root = await realpath(input.repositoryRoot).catch(() =>
    fail("COPY_PILOT_REPOSITORY_ROOT_INVALID"),
  );
  const manifestPath = resolve(root, input.manifestArtifactPath);
  if (!withinRoot(root, manifestPath)) {
    fail("COPY_PILOT_MANIFEST_INVALID");
  }
  const manifestRelativePath = relative(root, manifestPath).replaceAll(
    sep,
    "/",
  );
  if (!safeRelativePath(manifestRelativePath)) {
    fail("COPY_PILOT_MANIFEST_INVALID");
  }
  if (
    spawnSync(
      "git",
      ["ls-files", "--error-unmatch", "--", manifestRelativePath],
      { cwd: root, stdio: "ignore" },
    ).status !== 0
  ) {
    fail("COPY_PILOT_MANIFEST_NOT_TRACKED");
  }
  const manifestBytes = await secureRead(
    root,
    manifestRelativePath,
    MAXIMUM_MANIFEST_BYTES,
    "COPY_PILOT_MANIFEST_INVALID",
  );
  const trackedManifestBytes = gitBytes(root, [
    "show",
    `HEAD:${manifestRelativePath}`,
  ]);
  if (!manifestBytes.equals(trackedManifestBytes)) {
    fail("COPY_PILOT_MANIFEST_BYTES_MISMATCH");
  }
  const artifact = parseArtifact(manifestBytes);
  if (
    artifact.schemaVersion ===
      "site-builder-copy-sonnet-recovery-runtime-binding-prep/2026-08-08-v1" &&
    manifestRelativePath !== COPY_SONNET_RECOVERY_RUNTIME_BINDING_OUTPUT_PATH
  ) {
    fail("COPY_PILOT_MANIFEST_INVALID");
  }
  if (
    spawnSync(
      "git",
      ["merge-base", "--is-ancestor", artifact.fixedSourceCommit, "HEAD"],
      { cwd: root, stdio: "ignore" },
    ).status !== 0
  ) {
    fail("COPY_PILOT_FIXED_SOURCE_UNREACHABLE");
  }
  if (
    spawnSync(
      "git",
      [
        "merge-base",
        "--is-ancestor",
        artifact.fixedSourceCommit,
        "origin/main",
      ],
      { cwd: root, stdio: "ignore" },
    ).status !== 0
  ) {
    fail("COPY_PILOT_FIXED_SOURCE_NOT_ON_MAIN");
  }
  for (const reference of ["HEAD", "origin/main"] as const) {
    if (
      spawnSync(
        "git",
        [
          "merge-base",
          "--is-ancestor",
          artifact.preparationHeadCommit,
          reference,
        ],
        { cwd: root, stdio: "ignore" },
      ).status !== 0
    ) {
      fail("COPY_PILOT_PREPARATION_SOURCE_UNREACHABLE");
    }
  }

  const seen = new Set<string>();
  let sourceBytes = 0;
  if (artifact.sourceBundle.files.length > MAXIMUM_SOURCE_FILES) {
    fail("COPY_PILOT_SOURCE_BUNDLE_INVALID");
  }
  for (const file of artifact.sourceBundle.files) {
    if (
      !file ||
      typeof file.role !== "string" ||
      file.role.length === 0 ||
      !safeRelativePath(file.path) ||
      !SHA256.test(file.sha256) ||
      seen.has(file.path)
    ) {
      fail("COPY_PILOT_SOURCE_BUNDLE_INVALID");
    }
    seen.add(file.path);
    const fixedBytes = gitBytes(root, [
      "show",
      `${artifact.fixedSourceCommit}:${file.path}`,
    ]);
    const digest = createHash("sha256").update(fixedBytes).digest("hex");
    if (digest !== file.sha256) fail("COPY_PILOT_SOURCE_DIGEST_MISMATCH");
    const workingBytes = await secureRead(
      root,
      file.path,
      MAXIMUM_SOURCE_FILE_BYTES,
      "COPY_PILOT_SOURCE_FILE_INVALID",
    );
    sourceBytes += workingBytes.length;
    if (sourceBytes > MAXIMUM_SOURCE_TOTAL_BYTES) {
      fail("COPY_PILOT_SOURCE_BUNDLE_INVALID");
    }
    if (!workingBytes.equals(fixedBytes)) {
      fail("COPY_PILOT_SOURCE_BYTES_MISMATCH");
    }
  }

  try {
    await createCompiledRuntimeGuard({
      repositoryRoot: root,
      artifactPaths: artifact.compiledRuntimeExpectation.artifacts.map(
        ({ path }) => path,
      ),
      binding: {
        artifactDigest: artifact.artifactDigest,
        fixedSourceCommit: artifact.fixedSourceCommit,
        sourceBundleDigest: artifact.sourceBundle.digest,
      },
      expectation: artifact.compiledRuntimeExpectation,
    });
  } catch {
    fail("COPY_PILOT_COMPILED_RUNTIME_MISMATCH");
  }

  const compiledRuntimeExpectation = Object.freeze({
    ...artifact.compiledRuntimeExpectation,
    buildCommands: Object.freeze([
      ...artifact.compiledRuntimeExpectation.buildCommands,
    ]),
    artifacts: Object.freeze(
      artifact.compiledRuntimeExpectation.artifacts.map((entry) =>
        Object.freeze({ ...entry }),
      ),
    ),
  });

  const binding = Object.freeze({
    repositoryRoot: root,
    manifestArtifactPath: manifestPath,
    fixedSourceCommit: artifact.fixedSourceCommit,
    preparationHeadCommit: artifact.preparationHeadCommit,
    sourceBundleDigest: artifact.sourceBundle.digest,
    manifestDigest: canonicalDigest(artifact.manifest),
    artifactDigest: artifact.artifactDigest,
    compiledRuntimeExpectation,
  });
  const handle = Object.freeze({}) as CopyPilotVerifiedSource;
  VERIFIED_SOURCES.set(handle, binding);
  return handle;
}

export function getCopyPilotVerifiedSourceBinding(
  source: CopyPilotVerifiedSource,
): CopyPilotVerifiedSourceBinding | undefined {
  return VERIFIED_SOURCES.get(source);
}

export function requireCopyPilotVerifiedSourceBinding(
  source: CopyPilotVerifiedSource,
): CopyPilotVerifiedSourceBinding {
  return (
    VERIFIED_SOURCES.get(source) ?? fail("COPY_PILOT_VERIFIED_SOURCE_REQUIRED")
  );
}

export async function assertCopyPilotVerifiedSourceCurrent(
  source: CopyPilotVerifiedSource,
): Promise<void> {
  const expected = requireCopyPilotVerifiedSourceBinding(source);
  const current = await createCopyPilotVerifiedSource({
    repositoryRoot: expected.repositoryRoot,
    manifestArtifactPath: expected.manifestArtifactPath,
  });
  const observed = requireCopyPilotVerifiedSourceBinding(current);
  if (canonicalDigest(observed) !== canonicalDigest(expected)) {
    fail("COPY_PILOT_SOURCE_BINDING_DRIFT");
  }
}
