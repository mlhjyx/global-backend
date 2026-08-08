import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { canonicalDigest } from "../../model-runtime";
import { COPY_CAPABILITY_PILOT_PLAN } from "./copy-capability-pilot";
import {
  COPY_SONNET_RECOVERY_DUPLICATE_PREVENTION,
  COPY_SONNET_RECOVERY_EXECUTION,
  COPY_SONNET_RECOVERY_PLAN_DIGEST,
} from "./copy-sonnet-recovery-contract";
import {
  COPY_REAL_CAPABILITY_MANIFEST_SOURCE_FILES,
  buildCopyRealCapabilitySourceFileSpecs,
  type CopyRealCapabilitySourceBundle,
  type CopyRealCapabilitySourceFile,
} from "./copy-real-capability-manifest-prep";

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const VERIFIED_PREPARATION_ARTIFACTS = new WeakSet<object>();

export const COPY_SONNET_RECOVERY_FIXED_SOURCE_COMMIT =
  "2db159ed46f7f7c2acbcf2bb53a8c06d573c8382" as const;
export const COPY_SONNET_RECOVERY_MANIFEST_OUTPUT_PATH =
  "docs/evidence/site-builder/m1-g-copy-sonnet-recovery-manifest-v12.json" as const;

const PROVENANCE_ARTIFACT_SPECS = Object.freeze([
  Object.freeze({
    path: "docs/evidence/site-builder/m1-g-copy-real-capability-manifest-v11.json",
    fileSha256:
      "f56ee0a7e565b3333e6781d4e2f9d2d0a49b769ffe0ae08f6b0ea2c41af72205",
    artifactDigest:
      "80f6a95979eb3c0fff880038d501043241f057f5fe4f35980409525ace1e8172",
  }),
  Object.freeze({
    path: "docs/evidence/site-builder/m1-g-copy-capability-pilot-v11-partial-evidence.json",
    fileSha256:
      "94e5160380a77c717ba419155bd04aac04f8124bf303ba5eadea229c9fd2e537",
    artifactDigest:
      "fe4f215a19ea22916dadf1a14b6fd34f7dc5bf74d0fcc49099200b8a96bff652",
  }),
  Object.freeze({
    path: "docs/evidence/site-builder/m1-g-copy-capability-v11-terra-acceptance.json",
    fileSha256:
      "5d0d0860a30889119e63bdda0b3f561756d928d0ed6e4c0f7927c8c85242a16b",
    artifactDigest:
      "91f06c42d5b314ed6f722e6cf3733d8394ee0ed0c95d11c6252fbbe56024b0df",
  }),
  Object.freeze({
    path: "docs/evidence/site-builder/m1-g-copy-capability-v11-sol-acceptance.json",
    fileSha256:
      "f3b3ff91fec28611c822cbcf8613af0d1e65882ee3ae5ee633e7483aff461d41",
    artifactDigest:
      "c4afda144365b6b802609cdafd327a6174fae307d90dc5c4dbbfabc20866c23c",
  }),
] as const);

export const COPY_SONNET_RECOVERY_PROVENANCE_PATHS = Object.freeze(
  PROVENANCE_ARTIFACT_SPECS.map(({ path }) => path),
);

const SOURCE_SONNET_EXECUTION = COPY_CAPABILITY_PILOT_PLAN.executions.find(
  ({ alias }) => alias === "claude-sonnet-5",
);
if (
  SOURCE_SONNET_EXECUTION?.protocol !== "anthropic_messages" ||
  SOURCE_SONNET_EXECUTION.reasoning !== "medium"
) {
  throw new Error("COPY_SONNET_RECOVERY_SOURCE_EXECUTION_INVALID");
}

const SOURCE_TASK_CONTRACT_VERSION: string = (() => {
  const value = COPY_CAPABILITY_PILOT_PLAN.source.taskContractVersion;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("COPY_SONNET_RECOVERY_SOURCE_CONTRACT_VERSION_INVALID");
  }
  return value;
})();

export interface CopySonnetRecoveryProvenanceArtifactRef {
  path: string;
  fileSha256: string;
  artifactDigest: string;
}

export interface CopySonnetRecoveryManifest {
  schemaVersion: "site-builder-copy-sonnet-recovery-manifest/2026-08-08-v1";
  manifestId: "site-builder-copy-sonnet-recovery/2026-08-08-v12";
  fixedSourceCommit: string;
  sourceBundleDigest: string;
  recoveryPlanDigest: string;
  dispatchAuthorization: "NOT_AUTHORIZED";
  taskId: "site_builder.copy";
  plannedExecutions: 1;
  maximumWireCalls: 2;
  maximumRepairCallsPerExecution: 1;
  executions: readonly [typeof COPY_SONNET_RECOVERY_EXECUTION];
}

export interface CopySonnetRecoveryManifestArtifact {
  schemaVersion: "site-builder-copy-sonnet-recovery-manifest-prep/2026-08-08-v1";
  artifactId: "site-builder-copy-sonnet-recovery-manifest-prep/2026-08-08-v12";
  classification: "FIXED_SOURCE_CREATE_ONLY_SONNET_RECOVERY";
  fixedSourceCommit: string;
  preparationHeadCommit: string;
  requiredMergeMethod: "merge_commit";
  createOnly: true;
  dispatchAuthorization: "NOT_AUTHORIZED";
  dispatchCapable: false;
  observedNetworkCalls: 0;
  observedModelWireCalls: 0;
  observedModelCost: { CNY: 0; USD: 0 };
  manifest: CopySonnetRecoveryManifest;
  sourceBundle: CopyRealCapabilitySourceBundle;
  recoveryProvenance: {
    artifacts: readonly CopySonnetRecoveryProvenanceArtifactRef[];
    v11Outcome: "TERRA_SOL_ACCEPTED_SONNET_FROZEN_UNKNOWN_SETTLEMENT";
    settlementFixMergeCommit: string;
    settlementImplementationPath: "apps/api/src/model-gateway/new-api-request-bound-settlement.ts";
    settlementImplementationSha256: string;
  };
  duplicatePrevention: typeof COPY_SONNET_RECOVERY_DUPLICATE_PREVENTION;
  contractSnapshot: {
    schemaVersion: "site-builder-copy-sonnet-recovery-contract-snapshot/2026-08-08-v1";
    taskId: "site_builder.copy";
    sourcePilotPlanId: string;
    sourcePilotPlanDigest: string;
    recoveryPlanDigest: string;
    fixtureId: string;
    taskContractVersion: string;
    inputDigest: string;
    outputSchemaDigest: string;
    promptDigest: string;
    provenanceDigest: string;
  };
  preparationVerification: {
    fixedCommitReachableFromPreparationHead: true;
    fixedCommitReachableFromOriginMainAtPreparation: boolean;
    preparationHeadMustRemainReachableFromOriginMainBeforeDispatch: true;
    trackedSourceBytesMatch: true;
    trackedProvenanceBytesMatch: true;
    compiledRuntimeBindingDeferred: true;
    futureExecutionMustReverify: true;
  };
  requiredFollowup: readonly [
    "RECOVERY_ADMISSION_AND_RUNNER_BINDING",
    "FIXED_SOURCE_COMPILED_RUNTIME_EXPECTATION",
    "PURPOSE_SPECIFIC_SONNET_ONLY_FINITE_CREDENTIAL_ATTESTATION",
    "TRUSTED_SETTLEMENT_OBSERVER_AND_LEDGER_BINDING",
    "SEPARATE_SONNET_RECOVERY_DISPATCH_AUTHORIZATION",
    "GIT_REVIEWED_RECOVERY_RUNTIME_EVIDENCE",
    "KNOWN_SETTLEMENT_PER_PHYSICAL_CALL",
    "NEVER_REPEAT_TERRA_OR_SOL_V11_WIRES",
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
    COPY_REAL_CAPABILITY_MANIFEST_SOURCE_FILES.map((entry) => [
      entry.path,
      entry.role,
    ]),
  );
  return (
    value.length >= COPY_REAL_CAPABILITY_MANIFEST_SOURCE_FILES.length &&
    new Set(value.map(({ path }) => path)).size === value.length &&
    COPY_REAL_CAPABILITY_MANIFEST_SOURCE_FILES.every(({ path, role }) =>
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

function validProvenance(
  value: readonly CopySonnetRecoveryProvenanceArtifactRef[],
): boolean {
  return (
    value.length === PROVENANCE_ARTIFACT_SPECS.length &&
    value.every(
      (entry, index) =>
        entry.path === PROVENANCE_ARTIFACT_SPECS[index]!.path &&
        entry.fileSha256 === PROVENANCE_ARTIFACT_SPECS[index]!.fileSha256 &&
        entry.artifactDigest ===
          PROVENANCE_ARTIFACT_SPECS[index]!.artifactDigest &&
        SHA256.test(entry.fileSha256),
    )
  );
}

export function buildCopySonnetRecoveryManifestArtifact(input: {
  preparationHeadCommit: string;
  sourceFiles: readonly CopyRealCapabilitySourceFile[];
  provenanceArtifacts: readonly CopySonnetRecoveryProvenanceArtifactRef[];
  fixedCommitReachableFromOriginMainAtPreparation: boolean;
}): CopySonnetRecoveryManifestArtifact {
  if (!GIT_COMMIT.test(input.preparationHeadCommit)) {
    fail("COPY_SONNET_RECOVERY_PREPARATION_HEAD_INVALID");
  }
  if (
    typeof input.fixedCommitReachableFromOriginMainAtPreparation !== "boolean"
  ) {
    fail("COPY_SONNET_RECOVERY_ORIGIN_MAIN_REACHABILITY_INVALID");
  }
  if (!validSourceFiles(input.sourceFiles)) {
    fail("COPY_SONNET_RECOVERY_SOURCE_BUNDLE_INVALID");
  }
  if (!validProvenance(input.provenanceArtifacts)) {
    fail("COPY_SONNET_RECOVERY_PROVENANCE_INVALID");
  }
  const files = input.sourceFiles.map((entry) => Object.freeze({ ...entry }));
  const sourceBundle = Object.freeze({
    schemaVersion:
      "site-builder-copy-real-capability-source-bundle/2026-08-05-v1" as const,
    files: Object.freeze(files),
    digest: canonicalDigest(files),
  });
  const settlementImplementation = files.find(
    ({ path }) =>
      path === "apps/api/src/model-gateway/new-api-request-bound-settlement.ts",
  );
  if (!settlementImplementation) {
    fail("COPY_SONNET_RECOVERY_SETTLEMENT_SOURCE_REQUIRED");
  }
  const provenanceArtifacts = input.provenanceArtifacts.map((entry) =>
    Object.freeze({ ...entry }),
  );
  const planDigest = COPY_SONNET_RECOVERY_PLAN_DIGEST;
  const manifest = Object.freeze({
    schemaVersion:
      "site-builder-copy-sonnet-recovery-manifest/2026-08-08-v1" as const,
    manifestId: "site-builder-copy-sonnet-recovery/2026-08-08-v12" as const,
    fixedSourceCommit: COPY_SONNET_RECOVERY_FIXED_SOURCE_COMMIT,
    sourceBundleDigest: sourceBundle.digest,
    recoveryPlanDigest: planDigest,
    dispatchAuthorization: "NOT_AUTHORIZED" as const,
    taskId: "site_builder.copy" as const,
    plannedExecutions: 1 as const,
    maximumWireCalls: 2 as const,
    maximumRepairCallsPerExecution: 1 as const,
    executions: Object.freeze([COPY_SONNET_RECOVERY_EXECUTION] as const),
  });
  const recoveryProvenance = Object.freeze({
    artifacts: Object.freeze(provenanceArtifacts),
    v11Outcome: "TERRA_SOL_ACCEPTED_SONNET_FROZEN_UNKNOWN_SETTLEMENT" as const,
    settlementFixMergeCommit: COPY_SONNET_RECOVERY_FIXED_SOURCE_COMMIT,
    settlementImplementationPath:
      "apps/api/src/model-gateway/new-api-request-bound-settlement.ts" as const,
    settlementImplementationSha256: settlementImplementation.sha256,
  });
  const withoutDigest = {
    schemaVersion:
      "site-builder-copy-sonnet-recovery-manifest-prep/2026-08-08-v1" as const,
    artifactId:
      "site-builder-copy-sonnet-recovery-manifest-prep/2026-08-08-v12" as const,
    classification: "FIXED_SOURCE_CREATE_ONLY_SONNET_RECOVERY" as const,
    fixedSourceCommit: COPY_SONNET_RECOVERY_FIXED_SOURCE_COMMIT,
    preparationHeadCommit: input.preparationHeadCommit,
    requiredMergeMethod: "merge_commit" as const,
    createOnly: true as const,
    dispatchAuthorization: "NOT_AUTHORIZED" as const,
    dispatchCapable: false as const,
    observedNetworkCalls: 0 as const,
    observedModelWireCalls: 0 as const,
    observedModelCost: Object.freeze({ CNY: 0 as const, USD: 0 as const }),
    manifest,
    sourceBundle,
    recoveryProvenance,
    duplicatePrevention: COPY_SONNET_RECOVERY_DUPLICATE_PREVENTION,
    contractSnapshot: Object.freeze({
      schemaVersion:
        "site-builder-copy-sonnet-recovery-contract-snapshot/2026-08-08-v1" as const,
      taskId: "site_builder.copy" as const,
      sourcePilotPlanId: COPY_CAPABILITY_PILOT_PLAN.planId,
      sourcePilotPlanDigest: canonicalDigest(COPY_CAPABILITY_PILOT_PLAN),
      recoveryPlanDigest: planDigest,
      fixtureId: COPY_CAPABILITY_PILOT_PLAN.source.fixtureId,
      taskContractVersion: SOURCE_TASK_CONTRACT_VERSION,
      inputDigest: COPY_CAPABILITY_PILOT_PLAN.source.inputDigest,
      outputSchemaDigest: COPY_CAPABILITY_PILOT_PLAN.source.outputSchemaDigest,
      promptDigest: COPY_CAPABILITY_PILOT_PLAN.source.promptDigest,
      provenanceDigest: canonicalDigest(provenanceArtifacts),
    }),
    preparationVerification: Object.freeze({
      fixedCommitReachableFromPreparationHead: true as const,
      fixedCommitReachableFromOriginMainAtPreparation:
        input.fixedCommitReachableFromOriginMainAtPreparation,
      preparationHeadMustRemainReachableFromOriginMainBeforeDispatch:
        true as const,
      trackedSourceBytesMatch: true as const,
      trackedProvenanceBytesMatch: true as const,
      compiledRuntimeBindingDeferred: true as const,
      futureExecutionMustReverify: true as const,
    }),
    requiredFollowup: Object.freeze([
      "RECOVERY_ADMISSION_AND_RUNNER_BINDING",
      "FIXED_SOURCE_COMPILED_RUNTIME_EXPECTATION",
      "PURPOSE_SPECIFIC_SONNET_ONLY_FINITE_CREDENTIAL_ATTESTATION",
      "TRUSTED_SETTLEMENT_OBSERVER_AND_LEDGER_BINDING",
      "SEPARATE_SONNET_RECOVERY_DISPATCH_AUTHORIZATION",
      "GIT_REVIEWED_RECOVERY_RUNTIME_EVIDENCE",
      "KNOWN_SETTLEMENT_PER_PHYSICAL_CALL",
      "NEVER_REPEAT_TERRA_OR_SOL_V11_WIRES",
    ] as const),
  };
  return deepFreeze({
    ...withoutDigest,
    artifactDigest: canonicalDigest(withoutDigest),
  });
}

export function validateCopySonnetRecoveryManifestArtifact(
  value: unknown,
): asserts value is CopySonnetRecoveryManifestArtifact {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error();
    }
    const artifact = value as CopySonnetRecoveryManifestArtifact;
    const rebuilt = buildCopySonnetRecoveryManifestArtifact({
      preparationHeadCommit: artifact.preparationHeadCommit,
      sourceFiles: artifact.sourceBundle.files,
      provenanceArtifacts: artifact.recoveryProvenance.artifacts,
      fixedCommitReachableFromOriginMainAtPreparation:
        artifact.preparationVerification
          .fixedCommitReachableFromOriginMainAtPreparation,
    });
    if (canonicalDigest(rebuilt) !== canonicalDigest(artifact)) {
      throw new Error();
    }
    const { artifactDigest, ...withoutDigest } = artifact;
    if (artifactDigest !== canonicalDigest(withoutDigest)) {
      throw new Error();
    }
  } catch {
    fail("COPY_SONNET_RECOVERY_MANIFEST_ARTIFACT_INVALID");
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

export function readCopySonnetRecoveryFixedTrackedFile(input: {
  repositoryRoot: string;
  fixedCommit: string;
  path: string;
  expectedFileSha256?: string;
}): Buffer {
  let root: string;
  try {
    root = realpathSync(input.repositoryRoot);
  } catch {
    return fail("COPY_SONNET_RECOVERY_REPOSITORY_ROOT_INVALID");
  }
  if (
    !GIT_COMMIT.test(input.fixedCommit) ||
    input.path.length === 0 ||
    isAbsolute(input.path) ||
    input.path.includes("\\") ||
    input.path.split("/").includes("..") ||
    (input.expectedFileSha256 !== undefined &&
      !SHA256.test(input.expectedFileSha256))
  ) {
    fail("COPY_SONNET_RECOVERY_TRACKED_FILE_INVALID");
  }
  const location = resolve(root, input.path);
  const relativeLocation = relative(root, location);
  if (
    relativeLocation === ".." ||
    relativeLocation.startsWith(`..${sep}`) ||
    isAbsolute(relativeLocation)
  ) {
    fail("COPY_SONNET_RECOVERY_TRACKED_FILE_INVALID");
  }
  let metadata;
  try {
    if (realpathSync(dirname(location)) !== dirname(location)) {
      fail("COPY_SONNET_RECOVERY_TRACKED_FILE_INVALID");
    }
    metadata = lstatSync(location);
  } catch {
    return fail("COPY_SONNET_RECOVERY_TRACKED_FILE_INVALID");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail("COPY_SONNET_RECOVERY_TRACKED_FILE_INVALID");
  }

  let descriptor: number | undefined;
  let workingBytes: Buffer;
  try {
    descriptor = openSync(location, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino
    ) {
      fail("COPY_SONNET_RECOVERY_TRACKED_FILE_INVALID");
    }
    workingBytes = readFileSync(descriptor);
    const afterRead = fstatSync(descriptor);
    const current = lstatSync(location);
    if (
      afterRead.dev !== opened.dev ||
      afterRead.ino !== opened.ino ||
      afterRead.size !== workingBytes.length ||
      current.isSymbolicLink() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    ) {
      fail("COPY_SONNET_RECOVERY_TRACKED_FILE_INVALID");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("COPY_SONNET_RECOVERY_")
    ) {
      throw error;
    }
    return fail("COPY_SONNET_RECOVERY_TRACKED_FILE_INVALID");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  const fixedBytes = gitOutput(root, [
    "show",
    `${input.fixedCommit}:${input.path}`,
  ]);
  if (!fixedBytes.equals(workingBytes)) {
    fail("COPY_SONNET_RECOVERY_TRACKED_BYTES_MISMATCH");
  }
  if (
    input.expectedFileSha256 !== undefined &&
    sha256(fixedBytes) !== input.expectedFileSha256
  ) {
    fail("COPY_SONNET_RECOVERY_TRACKED_FILE_DIGEST_MISMATCH");
  }
  return workingBytes;
}

function provenanceFromFixedSource(
  root: string,
): readonly CopySonnetRecoveryProvenanceArtifactRef[] {
  return Object.freeze(
    PROVENANCE_ARTIFACT_SPECS.map((spec) => {
      const fixedBytes = gitOutput(root, [
        "show",
        `${COPY_SONNET_RECOVERY_FIXED_SOURCE_COMMIT}:${spec.path}`,
      ]);
      readCopySonnetRecoveryFixedTrackedFile({
        repositoryRoot: root,
        fixedCommit: COPY_SONNET_RECOVERY_FIXED_SOURCE_COMMIT,
        path: spec.path,
        expectedFileSha256: spec.fileSha256,
      });
      let value: unknown;
      try {
        value = JSON.parse(fixedBytes.toString("utf8"));
      } catch {
        fail("COPY_SONNET_RECOVERY_PROVENANCE_INVALID");
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("COPY_SONNET_RECOVERY_PROVENANCE_INVALID");
      }
      const { artifactDigest, ...withoutDigest } = value as Record<
        string,
        unknown
      >;
      if (
        artifactDigest !== spec.artifactDigest ||
        artifactDigest !== canonicalDigest(withoutDigest)
      ) {
        fail("COPY_SONNET_RECOVERY_PROVENANCE_INVALID");
      }
      return Object.freeze({
        path: spec.path,
        fileSha256: spec.fileSha256,
        artifactDigest: spec.artifactDigest,
      });
    }),
  );
}

export async function prepareCopySonnetRecoveryManifestFromRepository(
  repositoryRoot: string,
): Promise<CopySonnetRecoveryManifestArtifact> {
  const root = realpathSync(repositoryRoot);
  if (
    gitText(root, ["status", "--porcelain", "--untracked-files=all"]) !== ""
  ) {
    fail("COPY_SONNET_RECOVERY_PREPARATION_WORKTREE_DIRTY");
  }
  const preparationHeadCommit = gitText(root, ["rev-parse", "HEAD"]);
  if (
    !GIT_COMMIT.test(preparationHeadCommit) ||
    !gitAncestor(
      root,
      COPY_SONNET_RECOVERY_FIXED_SOURCE_COMMIT,
      preparationHeadCommit,
    )
  ) {
    fail("COPY_SONNET_RECOVERY_FIXED_SOURCE_UNREACHABLE");
  }

  const trackedTransitivePaths = gitText(root, [
    "ls-tree",
    "-r",
    "--name-only",
    COPY_SONNET_RECOVERY_FIXED_SOURCE_COMMIT,
    "--",
    "apps/api/src/model-runtime",
    "packages/contracts/src",
  ]).split("\n");
  const sourceFileSpecs = buildCopyRealCapabilitySourceFileSpecs(
    trackedTransitivePaths,
  );
  const sourceFiles = sourceFileSpecs.map(({ role, path }) => {
    const fixedBytes = readCopySonnetRecoveryFixedTrackedFile({
      repositoryRoot: root,
      fixedCommit: COPY_SONNET_RECOVERY_FIXED_SOURCE_COMMIT,
      path,
    });
    return Object.freeze({ role, path, sha256: sha256(fixedBytes) });
  });
  const provenanceArtifacts = provenanceFromFixedSource(root);

  if (
    gitText(root, ["rev-parse", "HEAD"]) !== preparationHeadCommit ||
    gitText(root, ["status", "--porcelain", "--untracked-files=all"]) !== ""
  ) {
    fail("COPY_SONNET_RECOVERY_PREPARATION_SNAPSHOT_DRIFT");
  }
  const artifact = buildCopySonnetRecoveryManifestArtifact({
    preparationHeadCommit,
    sourceFiles,
    provenanceArtifacts,
    fixedCommitReachableFromOriginMainAtPreparation: gitAncestor(
      root,
      COPY_SONNET_RECOVERY_FIXED_SOURCE_COMMIT,
      "origin/main",
    ),
  });
  VERIFIED_PREPARATION_ARTIFACTS.add(artifact);
  return artifact;
}

export async function writeCopySonnetRecoveryManifestCreateOnly(
  repositoryRoot: string,
  artifact: CopySonnetRecoveryManifestArtifact,
): Promise<void> {
  if (!VERIFIED_PREPARATION_ARTIFACTS.has(artifact)) {
    fail("COPY_SONNET_RECOVERY_PREPARATION_NOT_VERIFIED");
  }
  validateCopySonnetRecoveryManifestArtifact(artifact);
  const root = await realpath(repositoryRoot);
  const parent = resolve(
    root,
    dirname(COPY_SONNET_RECOVERY_MANIFEST_OUTPUT_PATH),
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
      join(descriptorPath, basename(COPY_SONNET_RECOVERY_MANIFEST_OUTPUT_PATH)),
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
