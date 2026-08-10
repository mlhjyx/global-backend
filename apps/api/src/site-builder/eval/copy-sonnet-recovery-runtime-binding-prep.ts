import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  canonicalDigest,
  createCompiledRuntimeExpectation,
  validateCompiledRuntimeExpectation,
  type CompiledRuntimeExpectation,
} from "../../model-runtime";
import {
  COPY_SONNET_RECOVERY_ADMISSION_SOURCE,
  type CopySonnetRecoveryRuntimeManifest,
} from "./copy-sonnet-recovery-admission";
import {
  COPY_SONNET_RECOVERY_DUPLICATE_PREVENTION,
  COPY_SONNET_RECOVERY_PLAN_DIGEST,
  COPY_SONNET_RECOVERY_RUNTIME_BINDING_ARTIFACT_ID,
  COPY_SONNET_RECOVERY_RUNTIME_BINDING_OUTPUT_PATH,
  COPY_SONNET_RECOVERY_RUNTIME_MANIFEST_ID,
  COPY_SONNET_RECOVERY_SOURCE_MANIFEST_PATH,
} from "./copy-sonnet-recovery-contract";
import {
  validateCopySonnetRecoveryManifestArtifact,
  type CopySonnetRecoveryManifestArtifact,
} from "./copy-sonnet-recovery-manifest-prep";
import { COPY_PILOT_COMPILED_BUILD_COMMANDS } from "./copy-pilot-source-verifier";
import {
  COPY_REAL_CAPABILITY_MANIFEST_SOURCE_FILES,
  buildCopyRealCapabilitySourceFileSpecs,
  type CopyRealCapabilitySourceFile,
  type CopyRealCapabilitySourceFileSpec,
} from "./copy-real-capability-manifest-prep";
import { COPY_REAL_CAPABILITY_ARTIFACT_PATHS } from "./copy-real-capability-runner";

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const VERIFIED_PREPARATION_ARTIFACTS = new WeakSet<object>();

export {
  COPY_SONNET_RECOVERY_RUNTIME_BINDING_OUTPUT_PATH,
  COPY_SONNET_RECOVERY_SOURCE_MANIFEST_PATH,
};

const RECOVERY_SOURCE_FILE_SPECS = Object.freeze([
  Object.freeze({
    role: "shared_capability_admission",
    path: "apps/api/src/site-builder/eval/copy-capability-admission.ts",
  }),
  Object.freeze({
    role: "recovery_contract",
    path: "apps/api/src/site-builder/eval/copy-sonnet-recovery-contract.ts",
  }),
  Object.freeze({
    role: "recovery_admission",
    path: "apps/api/src/site-builder/eval/copy-sonnet-recovery-admission.ts",
  }),
  Object.freeze({
    role: "recovery_manifest_contract",
    path: "apps/api/src/site-builder/eval/copy-sonnet-recovery-manifest-prep.ts",
  }),
  Object.freeze({
    role: "recovery_source_manifest",
    path: COPY_SONNET_RECOVERY_SOURCE_MANIFEST_PATH,
  }),
] as const satisfies readonly CopyRealCapabilitySourceFileSpec[]);

export const COPY_SONNET_RECOVERY_RUNTIME_SOURCE_FILE_SPECS = Object.freeze(
  [...COPY_REAL_CAPABILITY_MANIFEST_SOURCE_FILES, ...RECOVERY_SOURCE_FILE_SPECS]
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    )
    .map((entry) => Object.freeze({ ...entry })),
);

export const COPY_SONNET_RECOVERY_RUNTIME_ARTIFACT_PATHS = Object.freeze(
  [
    ...COPY_REAL_CAPABILITY_ARTIFACT_PATHS,
    "apps/api/dist/site-builder/eval/copy-sonnet-recovery-admission.js",
    "apps/api/dist/site-builder/eval/copy-sonnet-recovery-contract.js",
    "apps/api/dist/site-builder/eval/copy-sonnet-recovery-manifest-prep.js",
  ]
    .filter((path, index, paths) => paths.indexOf(path) === index)
    .sort(),
);

export interface CopySonnetRecoveryRuntimeBindingArtifact {
  schemaVersion: "site-builder-copy-sonnet-recovery-runtime-binding-prep/2026-08-08-v1";
  artifactId: typeof COPY_SONNET_RECOVERY_RUNTIME_BINDING_ARTIFACT_ID;
  classification: "FIXED_SOURCE_CREATE_ONLY_SONNET_RECOVERY_RUNTIME";
  fixedSourceCommit: string;
  preparationHeadCommit: string;
  requiredMergeMethod: "merge_commit";
  createOnly: true;
  dispatchAuthorization: "NOT_AUTHORIZED";
  dispatchCapable: false;
  observedNetworkCalls: 0;
  observedModelWireCalls: 0;
  observedModelCost: { CNY: 0; USD: 0 };
  recoveryManifestReference: {
    path: typeof COPY_SONNET_RECOVERY_SOURCE_MANIFEST_PATH;
    fileSha256: string;
    artifactDigest: string;
    manifestDigest: string;
  };
  duplicatePrevention: typeof COPY_SONNET_RECOVERY_DUPLICATE_PREVENTION;
  manifest: CopySonnetRecoveryRuntimeManifest;
  sourceBundle: {
    schemaVersion: "site-builder-copy-sonnet-recovery-runtime-source-bundle/2026-08-08-v1";
    files: readonly CopyRealCapabilitySourceFile[];
    digest: string;
  };
  compiledRuntimeExpectation: CompiledRuntimeExpectation;
  preparationVerification: {
    fixedCommitReachableFromPreparationHead: true;
    fixedCommitReachableFromOriginMainAtPreparation: boolean;
    preparationHeadMustRemainReachableFromOriginMainBeforeDispatch: true;
    trackedSourceBytesMatch: true;
    sourceManifestBytesMatch: true;
    compiledRuntimeBuiltFromFixedSource: true;
    futureExecutionMustReverify: true;
  };
  requiredFollowup: readonly [
    "PURPOSE_SPECIFIC_SONNET_ONLY_FINITE_CREDENTIAL_ATTESTATION",
    "TRUSTED_SETTLEMENT_OBSERVER_AND_LEDGER_BINDING",
    "SEPARATE_SONNET_RECOVERY_DISPATCH_AUTHORIZATION",
    "GIT_REVIEWED_RECOVERY_RUNTIME_EVIDENCE",
    "KNOWN_SETTLEMENT_PER_PHYSICAL_CALL",
    "NEVER_REPEAT_TERRA_OR_SOL_V11_WIRES",
    "NEVER_REUSE_V11_V12_V13_V14_OR_V15_AUTHORIZATION_OR_WIRE",
  ];
  artifactDigest: string;
}

function fail(code: string): never {
  throw new Error(code);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function transitiveRole(path: string): string | undefined {
  if (
    path.startsWith("apps/api/src/model-runtime/") &&
    path.endsWith(".ts") &&
    !path.endsWith(".spec.ts")
  ) {
    return "runtime_transitive_source";
  }
  if (
    path.startsWith("packages/contracts/src/") &&
    path.endsWith(".ts") &&
    !path.endsWith(".spec.ts")
  ) {
    return "contracts_transitive_source";
  }
  return undefined;
}

function validSourceFiles(
  value: readonly CopyRealCapabilitySourceFile[],
): boolean {
  const requiredByPath = new Map<string, string>(
    COPY_SONNET_RECOVERY_RUNTIME_SOURCE_FILE_SPECS.map((entry) => [
      entry.path,
      entry.role,
    ]),
  );
  return (
    value.length >= COPY_SONNET_RECOVERY_RUNTIME_SOURCE_FILE_SPECS.length &&
    new Set(value.map(({ path }) => path)).size === value.length &&
    COPY_SONNET_RECOVERY_RUNTIME_SOURCE_FILE_SPECS.every(({ path, role }) =>
      value.some((entry) => entry.path === path && entry.role === role),
    ) &&
    value.every(
      (entry, index) =>
        SHA256.test(entry.sha256) &&
        entry.role ===
          (requiredByPath.get(entry.path) ?? transitiveRole(entry.path)) &&
        (index === 0 || value[index - 1]!.path < entry.path) &&
        !entry.path.startsWith("/") &&
        !entry.path.includes("\\") &&
        !entry.path.split("/").includes(".."),
    )
  );
}

function parseRecoveryManifest(
  bytes: Uint8Array,
): CopySonnetRecoveryManifestArtifact {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
    validateCopySonnetRecoveryManifestArtifact(value);
  } catch {
    return fail("COPY_SONNET_RECOVERY_SOURCE_MANIFEST_INVALID");
  }
  const artifact = value;
  if (
    artifact.manifest.recoveryPlanDigest !== COPY_SONNET_RECOVERY_PLAN_DIGEST ||
    canonicalDigest(artifact.manifest.executions) !==
      canonicalDigest(COPY_SONNET_RECOVERY_ADMISSION_SOURCE.executions) ||
    canonicalDigest(artifact.duplicatePrevention) !==
      canonicalDigest(COPY_SONNET_RECOVERY_DUPLICATE_PREVENTION) ||
    artifact.dispatchAuthorization !== "NOT_AUTHORIZED" ||
    artifact.dispatchCapable !== false ||
    artifact.observedModelWireCalls !== 0
  ) {
    fail("COPY_SONNET_RECOVERY_SOURCE_MANIFEST_INVALID");
  }
  return artifact;
}

export function buildCopySonnetRecoveryRuntimeBindingArtifact(input: {
  fixedSourceCommit: string;
  preparationHeadCommit: string;
  sourceFiles: readonly CopyRealCapabilitySourceFile[];
  recoveryManifestBytes: Uint8Array;
  compiledRuntimeExpectation: CompiledRuntimeExpectation;
  fixedCommitReachableFromOriginMainAtPreparation: boolean;
}): CopySonnetRecoveryRuntimeBindingArtifact {
  if (
    !GIT_COMMIT.test(input.fixedSourceCommit) ||
    !GIT_COMMIT.test(input.preparationHeadCommit) ||
    typeof input.fixedCommitReachableFromOriginMainAtPreparation !== "boolean"
  ) {
    fail("COPY_SONNET_RECOVERY_FIXED_SOURCE_INVALID");
  }
  if (!validSourceFiles(input.sourceFiles)) {
    fail("COPY_SONNET_RECOVERY_SOURCE_BUNDLE_INVALID");
  }
  const recoveryArtifact = parseRecoveryManifest(input.recoveryManifestBytes);
  const sourceManifestFile = input.sourceFiles.find(
    ({ path }) => path === COPY_SONNET_RECOVERY_SOURCE_MANIFEST_PATH,
  );
  const sourceManifestFileSha256 = sha256(input.recoveryManifestBytes);
  if (sourceManifestFile?.sha256 !== sourceManifestFileSha256) {
    fail("COPY_SONNET_RECOVERY_SOURCE_MANIFEST_INVALID");
  }
  const files = input.sourceFiles.map((entry) => Object.freeze({ ...entry }));
  const sourceBundle = Object.freeze({
    schemaVersion:
      "site-builder-copy-sonnet-recovery-runtime-source-bundle/2026-08-08-v1" as const,
    files: Object.freeze(files),
    digest: canonicalDigest(files),
  });
  try {
    validateCompiledRuntimeExpectation(input.compiledRuntimeExpectation);
  } catch {
    fail("COPY_SONNET_RECOVERY_COMPILED_RUNTIME_EXPECTATION_INVALID");
  }
  if (
    input.compiledRuntimeExpectation.buildSourceCommit !==
      input.fixedSourceCommit ||
    input.compiledRuntimeExpectation.sourceBundleDigest !==
      sourceBundle.digest ||
    canonicalDigest(input.compiledRuntimeExpectation.buildCommands) !==
      canonicalDigest(COPY_PILOT_COMPILED_BUILD_COMMANDS) ||
    canonicalDigest(
      input.compiledRuntimeExpectation.artifacts.map(({ path }) => path),
    ) !== canonicalDigest(COPY_SONNET_RECOVERY_RUNTIME_ARTIFACT_PATHS)
  ) {
    fail("COPY_SONNET_RECOVERY_COMPILED_RUNTIME_EXPECTATION_INVALID");
  }
  const compiledRuntimeExpectation = Object.freeze({
    ...input.compiledRuntimeExpectation,
    buildCommands: Object.freeze([
      ...input.compiledRuntimeExpectation.buildCommands,
    ]),
    artifacts: Object.freeze(
      input.compiledRuntimeExpectation.artifacts.map((entry) =>
        Object.freeze({ ...entry }),
      ),
    ),
  });
  const recoveryManifestReference = Object.freeze({
    path: COPY_SONNET_RECOVERY_SOURCE_MANIFEST_PATH,
    fileSha256: sourceManifestFileSha256,
    artifactDigest: recoveryArtifact.artifactDigest,
    manifestDigest: canonicalDigest(recoveryArtifact.manifest),
  });
  const manifest = Object.freeze({
    schemaVersion:
      "site-builder-copy-sonnet-recovery-runtime-manifest/2026-08-08-v1" as const,
    manifestId: COPY_SONNET_RECOVERY_RUNTIME_MANIFEST_ID,
    recoveryManifestArtifactDigest: recoveryArtifact.artifactDigest,
    recoveryManifestDigest: recoveryManifestReference.manifestDigest,
    fixedSourceCommit: input.fixedSourceCommit,
    sourceBundleDigest: sourceBundle.digest,
    planDigest: COPY_SONNET_RECOVERY_ADMISSION_SOURCE.planDigest,
    dispatchAuthorization: "NOT_AUTHORIZED" as const,
    taskId: "site_builder.copy" as const,
    plannedExecutions: 1 as const,
    maximumWireCalls: 2 as const,
    maximumRepairCallsPerExecution: 1 as const,
    executions: COPY_SONNET_RECOVERY_ADMISSION_SOURCE.executions,
  });
  const withoutDigest = {
    schemaVersion:
      "site-builder-copy-sonnet-recovery-runtime-binding-prep/2026-08-08-v1" as const,
    artifactId: COPY_SONNET_RECOVERY_RUNTIME_BINDING_ARTIFACT_ID,
    classification: "FIXED_SOURCE_CREATE_ONLY_SONNET_RECOVERY_RUNTIME" as const,
    fixedSourceCommit: input.fixedSourceCommit,
    preparationHeadCommit: input.preparationHeadCommit,
    requiredMergeMethod: "merge_commit" as const,
    createOnly: true as const,
    dispatchAuthorization: "NOT_AUTHORIZED" as const,
    dispatchCapable: false as const,
    observedNetworkCalls: 0 as const,
    observedModelWireCalls: 0 as const,
    observedModelCost: Object.freeze({ CNY: 0 as const, USD: 0 as const }),
    recoveryManifestReference,
    duplicatePrevention: COPY_SONNET_RECOVERY_DUPLICATE_PREVENTION,
    manifest,
    sourceBundle,
    compiledRuntimeExpectation,
    preparationVerification: Object.freeze({
      fixedCommitReachableFromPreparationHead: true as const,
      fixedCommitReachableFromOriginMainAtPreparation:
        input.fixedCommitReachableFromOriginMainAtPreparation,
      preparationHeadMustRemainReachableFromOriginMainBeforeDispatch:
        true as const,
      trackedSourceBytesMatch: true as const,
      sourceManifestBytesMatch: true as const,
      compiledRuntimeBuiltFromFixedSource: true as const,
      futureExecutionMustReverify: true as const,
    }),
    requiredFollowup: Object.freeze([
      "PURPOSE_SPECIFIC_SONNET_ONLY_FINITE_CREDENTIAL_ATTESTATION",
      "TRUSTED_SETTLEMENT_OBSERVER_AND_LEDGER_BINDING",
      "SEPARATE_SONNET_RECOVERY_DISPATCH_AUTHORIZATION",
      "GIT_REVIEWED_RECOVERY_RUNTIME_EVIDENCE",
      "KNOWN_SETTLEMENT_PER_PHYSICAL_CALL",
      "NEVER_REPEAT_TERRA_OR_SOL_V11_WIRES",
      "NEVER_REUSE_V11_V12_V13_V14_OR_V15_AUTHORIZATION_OR_WIRE",
    ] as const),
  };
  return deepFreeze({
    ...withoutDigest,
    artifactDigest: canonicalDigest(withoutDigest),
  });
}

export function validateCopySonnetRecoveryRuntimeBindingArtifact(
  value: unknown,
  recoveryManifestBytes: Uint8Array,
): asserts value is CopySonnetRecoveryRuntimeBindingArtifact {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error();
    }
    const artifact = value as CopySonnetRecoveryRuntimeBindingArtifact;
    const rebuilt = buildCopySonnetRecoveryRuntimeBindingArtifact({
      fixedSourceCommit: artifact.fixedSourceCommit,
      preparationHeadCommit: artifact.preparationHeadCommit,
      sourceFiles: artifact.sourceBundle.files,
      recoveryManifestBytes,
      compiledRuntimeExpectation: artifact.compiledRuntimeExpectation,
      fixedCommitReachableFromOriginMainAtPreparation:
        artifact.preparationVerification
          .fixedCommitReachableFromOriginMainAtPreparation,
    });
    if (canonicalDigest(rebuilt) !== canonicalDigest(artifact)) {
      throw new Error();
    }
  } catch {
    fail("COPY_SONNET_RECOVERY_RUNTIME_BINDING_ARTIFACT_INVALID");
  }
}

function gitOutput(repositoryRoot: string, args: readonly string[]): Buffer {
  return execFileSync("git", [...args], {
    cwd: repositoryRoot,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function gitText(repositoryRoot: string, args: readonly string[]): string {
  return gitOutput(repositoryRoot, args).toString("utf8").trim();
}

function gitAncestor(
  repositoryRoot: string,
  ancestor: string,
  descendant: string,
): boolean {
  return (
    spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: repositoryRoot,
      stdio: "ignore",
    }).status === 0
  );
}

export async function prepareCopySonnetRecoveryRuntimeBindingFromRepository(
  repositoryRoot: string,
): Promise<CopySonnetRecoveryRuntimeBindingArtifact> {
  const root = realpathSync(repositoryRoot);
  if (
    gitText(root, ["status", "--porcelain", "--untracked-files=all"]) !== ""
  ) {
    fail("COPY_SONNET_RECOVERY_PREPARATION_WORKTREE_DIRTY");
  }
  const fixedSourceCommit = gitText(root, ["rev-parse", "HEAD"]);
  if (!GIT_COMMIT.test(fixedSourceCommit)) {
    fail("COPY_SONNET_RECOVERY_FIXED_SOURCE_INVALID");
  }
  const trackedTransitivePaths = gitText(root, [
    "ls-tree",
    "-r",
    "--name-only",
    fixedSourceCommit,
    "--",
    "apps/api/src/model-runtime",
    "packages/contracts/src",
  ]).split("\n");
  const sourceFileSpecsByPath = new Map(
    buildCopyRealCapabilitySourceFileSpecs(trackedTransitivePaths).map(
      (entry) => [entry.path, entry],
    ),
  );
  for (const entry of RECOVERY_SOURCE_FILE_SPECS) {
    sourceFileSpecsByPath.set(entry.path, entry);
  }
  const sourceFileSpecs = [...sourceFileSpecsByPath.values()].sort(
    (left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const sourceFiles = sourceFileSpecs.map(({ role, path }) => {
    const metadata = lstatSync(resolve(root, path));
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      fail("COPY_SONNET_RECOVERY_SOURCE_BUNDLE_INVALID");
    }
    const fixedBytes = gitOutput(root, [
      "show",
      `${fixedSourceCommit}:${path}`,
    ]);
    const workingBytes = readFileSync(resolve(root, path));
    if (!fixedBytes.equals(workingBytes)) {
      fail("COPY_SONNET_RECOVERY_SOURCE_BYTES_MISMATCH");
    }
    return Object.freeze({ role, path, sha256: sha256(fixedBytes) });
  });
  const recoveryManifestBytes = readFileSync(
    resolve(root, COPY_SONNET_RECOVERY_SOURCE_MANIFEST_PATH),
  );
  for (const command of [
    ["--filter", "@global/db", "generate"],
    ["--filter", "@global/contracts", "build"],
    ["--filter", "@global/api", "build"],
  ] as const) {
    execFileSync("pnpm", [...command], { cwd: root, stdio: "inherit" });
  }
  const sourceBundleDigest = canonicalDigest(sourceFiles);
  const compiledRuntimeExpectation = await createCompiledRuntimeExpectation({
    repositoryRoot: root,
    artifactPaths: COPY_SONNET_RECOVERY_RUNTIME_ARTIFACT_PATHS,
    buildSourceCommit: fixedSourceCommit,
    sourceBundleDigest,
    buildCommands: COPY_PILOT_COMPILED_BUILD_COMMANDS,
  });
  if (
    gitText(root, ["rev-parse", "HEAD"]) !== fixedSourceCommit ||
    gitText(root, ["status", "--porcelain", "--untracked-files=all"]) !== ""
  ) {
    fail("COPY_SONNET_RECOVERY_PREPARATION_SNAPSHOT_DRIFT");
  }
  const artifact = buildCopySonnetRecoveryRuntimeBindingArtifact({
    fixedSourceCommit,
    preparationHeadCommit: fixedSourceCommit,
    sourceFiles,
    recoveryManifestBytes,
    compiledRuntimeExpectation,
    fixedCommitReachableFromOriginMainAtPreparation: gitAncestor(
      root,
      fixedSourceCommit,
      "origin/main",
    ),
  });
  VERIFIED_PREPARATION_ARTIFACTS.add(artifact);
  return artifact;
}

export async function writeCopySonnetRecoveryRuntimeBindingCreateOnly(
  repositoryRoot: string,
  artifact: CopySonnetRecoveryRuntimeBindingArtifact,
): Promise<void> {
  if (!VERIFIED_PREPARATION_ARTIFACTS.has(artifact)) {
    fail("COPY_SONNET_RECOVERY_PREPARATION_NOT_VERIFIED");
  }
  const root = await realpath(repositoryRoot);
  const parent = resolve(
    root,
    dirname(COPY_SONNET_RECOVERY_RUNTIME_BINDING_OUTPUT_PATH),
  );
  const parentMetadata = await lstat(parent);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    fail("COPY_SONNET_RECOVERY_OUTPUT_PARENT_INVALID");
  }
  const realParent = await realpath(parent);
  const parentRelative = relative(root, realParent);
  if (
    parentRelative === ".." ||
    parentRelative.startsWith(`..${sep}`) ||
    resolve(root, parentRelative) !== realParent
  ) {
    fail("COPY_SONNET_RECOVERY_OUTPUT_PARENT_INVALID");
  }
  const directory = await open(
    realParent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let output;
  try {
    const descriptorPath = `/proc/self/fd/${directory.fd}`;
    const [openedMetadata, descriptorTarget] = await Promise.all([
      directory.stat(),
      realpath(descriptorPath),
    ]);
    const expectedMetadata = await lstat(realParent);
    if (
      !openedMetadata.isDirectory() ||
      openedMetadata.dev !== expectedMetadata.dev ||
      openedMetadata.ino !== expectedMetadata.ino ||
      descriptorTarget !== realParent
    ) {
      fail("COPY_SONNET_RECOVERY_OUTPUT_PARENT_INVALID");
    }
    output = await open(
      join(
        descriptorPath,
        basename(COPY_SONNET_RECOVERY_RUNTIME_BINDING_OUTPUT_PATH),
      ),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await output.writeFile(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    await output.sync();
    await directory.sync();
  } finally {
    await output?.close();
    await directory.close();
  }
}
