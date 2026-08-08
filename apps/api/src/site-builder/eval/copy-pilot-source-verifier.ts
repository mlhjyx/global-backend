import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalDigest } from "../../model-runtime/context-engine";
import {
  createCompiledRuntimeGuard,
  validateCompiledRuntimeExpectation,
  type CompiledRuntimeExpectation,
} from "../../model-runtime/compiled-runtime-guard";
import { COPY_CAPABILITY_PILOT_PLAN } from "./copy-capability-pilot";
import { COPY_REAL_CAPABILITY_ADMISSION_SOURCE } from "./copy-real-capability-admission";

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const MAXIMUM_MANIFEST_BYTES = 2 * 1024 * 1024;

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

async function secureRead(path: string, maximumBytes: number): Promise<Buffer> {
  const metadata = await lstat(path).catch(() =>
    fail("COPY_PILOT_SOURCE_FILE_INVALID"),
  );
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail("COPY_PILOT_SOURCE_FILE_INVALID");
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return fail("COPY_PILOT_SOURCE_FILE_INVALID");
  }
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.size > maximumBytes
    ) {
      fail("COPY_PILOT_SOURCE_FILE_INVALID");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
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
  if (
    artifact.schemaVersion !==
      "site-builder-copy-real-capability-manifest-prep/2026-08-05-v1" ||
    artifact.classification !== "FIXED_SOURCE_CREATE_ONLY" ||
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
    artifact.manifest?.schemaVersion !==
      "site-builder-copy-real-capability-manifest/2026-08-05-v1" ||
    artifact.manifest.fixedSourceCommit !== artifact.fixedSourceCommit ||
    artifact.manifest.planDigest !==
      canonicalDigest(COPY_CAPABILITY_PILOT_PLAN) ||
    artifact.manifest.dispatchAuthorization !== "NOT_AUTHORIZED" ||
    artifact.manifest.taskId !== "site_builder.copy" ||
    artifact.manifest.plannedExecutions !== 3 ||
    artifact.manifest.maximumWireCalls !== 6 ||
    artifact.manifest.maximumRepairCallsPerExecution !== 1 ||
    canonicalDigest(artifact.manifest.executions) !==
      canonicalDigest(COPY_REAL_CAPABILITY_ADMISSION_SOURCE.executions) ||
    artifact.sourceBundle?.schemaVersion !==
      "site-builder-copy-real-capability-source-bundle/2026-08-05-v1" ||
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
      canonicalDigest(COPY_PILOT_COMPILED_BUILD_COMMANDS)
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
  const manifestPath = await realpath(input.manifestArtifactPath).catch(() =>
    fail("COPY_PILOT_MANIFEST_INVALID"),
  );
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
  const manifestBytes = await secureRead(manifestPath, MAXIMUM_MANIFEST_BYTES);
  const trackedManifestBytes = gitBytes(root, [
    "show",
    `HEAD:${manifestRelativePath}`,
  ]);
  if (!manifestBytes.equals(trackedManifestBytes)) {
    fail("COPY_PILOT_MANIFEST_BYTES_MISMATCH");
  }
  const artifact = parseArtifact(manifestBytes);
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
    const absolutePath = resolve(root, file.path);
    if (!withinRoot(root, absolutePath)) {
      fail("COPY_PILOT_SOURCE_BUNDLE_INVALID");
    }
    const fixedBytes = gitBytes(root, [
      "show",
      `${artifact.fixedSourceCommit}:${file.path}`,
    ]);
    const digest = createHash("sha256").update(fixedBytes).digest("hex");
    if (digest !== file.sha256) fail("COPY_PILOT_SOURCE_DIGEST_MISMATCH");
    const workingBytes = await secureRead(absolutePath, 16 * 1024 * 1024);
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
