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
import { COPY_CAPABILITY_PILOT_PLAN } from "./copy-capability-pilot";
import { COPY_PILOT_COMPILED_BUILD_COMMANDS } from "./copy-pilot-source-verifier";
import {
  COPY_REAL_CAPABILITY_ADMISSION_SOURCE,
  type CopyRealCapabilityManifest,
} from "./copy-real-capability-admission";
import { COPY_REAL_CAPABILITY_ARTIFACT_PATHS } from "./copy-real-capability-runner";

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const VERIFIED_PREPARATION_ARTIFACTS = new WeakSet<object>();

/** Merge-bound source; dispatch remains blocked until this SHA is on origin/main. */
export const COPY_REAL_CAPABILITY_FIXED_SOURCE_COMMIT =
  "0c5213e6ef1a4d8b7ea527b7522021d487bc5934" as const;
export const COPY_REAL_CAPABILITY_MANIFEST_OUTPUT_PATH =
  "docs/evidence/site-builder/m1-g-copy-real-capability-manifest-v11.json" as const;

export interface CopyRealCapabilitySourceFileSpec {
  role: string;
  path: string;
}

export interface CopyRealCapabilitySourceFile extends CopyRealCapabilitySourceFileSpec {
  sha256: string;
}

const SOURCE_FILE_SPECS = [
  {
    role: "workspace_manifest",
    path: "package.json",
  },
  {
    role: "workspace_manifest",
    path: "pnpm-workspace.yaml",
  },
  {
    role: "compiler_config",
    path: "tsconfig.base.json",
  },
  {
    role: "api_manifest",
    path: "apps/api/package.json",
  },
  {
    role: "compiler_config",
    path: "apps/api/nest-cli.json",
  },
  {
    role: "compiler_config",
    path: "apps/api/tsconfig.build.json",
  },
  {
    role: "compiler_config",
    path: "apps/api/tsconfig.json",
  },
  {
    role: "gateway_settlement",
    path: "apps/api/src/model-gateway/new-api-request-bound-settlement.ts",
  },
  {
    role: "runtime_adapter",
    path: "apps/api/src/model-runtime/adapters/ai-sdk-adapter-result.ts",
  },
  {
    role: "runtime_adapter",
    path: "apps/api/src/model-runtime/adapters/ai-sdk-anthropic-messages.adapter.ts",
  },
  {
    role: "runtime_adapter_contract",
    path: "apps/api/src/model-runtime/adapters/ai-sdk-native-adapter.contract.ts",
  },
  {
    role: "runtime_adapter",
    path: "apps/api/src/model-runtime/adapters/ai-sdk-openai-chat-completions.adapter.ts",
  },
  {
    role: "runtime_adapter",
    path: "apps/api/src/model-runtime/adapters/ai-sdk-openai-responses.adapter.ts",
  },
  {
    role: "runtime_adapter_exports",
    path: "apps/api/src/model-runtime/adapters/index.ts",
  },
  {
    role: "runtime_context",
    path: "apps/api/src/model-runtime/context-engine.ts",
  },
  {
    role: "runtime_execution",
    path: "apps/api/src/model-runtime/durable-model-execution-runtime.ts",
  },
  {
    role: "git_reviewed_evidence_acceptance",
    path: "apps/api/src/model-runtime/git-reviewed-evidence-acceptance.ts",
  },
  {
    role: "runtime_immutable",
    path: "apps/api/src/model-runtime/immutable.ts",
  },
  {
    role: "runtime_exports",
    path: "apps/api/src/model-runtime/index.ts",
  },
  {
    role: "runtime_ledger",
    path: "apps/api/src/model-runtime/model-execution-ledger.ts",
  },
  {
    role: "runtime_execution",
    path: "apps/api/src/model-runtime/model-execution-runtime.ts",
  },
  {
    role: "runtime_types",
    path: "apps/api/src/model-runtime/types.ts",
  },
  {
    role: "task_contract",
    path: "apps/api/src/site-builder/agents/ai-task.ts",
  },
  {
    role: "candidate_baseline",
    path: "apps/api/src/site-builder/agents/model-candidate-baseline.json",
  },
  {
    role: "candidate_baseline",
    path: "apps/api/src/site-builder/agents/model-candidate-baseline.ts",
  },
  {
    role: "task_contract",
    path: "apps/api/src/site-builder/agents/copy.ts",
  },
  {
    role: "copy_context",
    path: "apps/api/src/site-builder/copy-bundle.service.ts",
  },
  {
    role: "copy_fixture",
    path: "apps/api/src/site-builder/eval/copy-assembly-eval.ts",
  },
  {
    role: "pilot_plan",
    path: "apps/api/src/site-builder/eval/copy-capability-pilot.ts",
  },
  {
    role: "test_only_runner_contract",
    path: "apps/api/src/site-builder/eval/copy-capability-pilot-runner.ts",
  },
  {
    role: "candidate_scope",
    path: "apps/api/src/site-builder/eval/copy-evaluation-v2-candidates.ts",
  },
  {
    role: "quality_contract",
    path: "apps/api/src/site-builder/eval/copy-quality-rubric.ts",
  },
  {
    role: "real_dispatch_ledger_identity",
    path: "apps/api/src/site-builder/eval/copy-pilot-ledger-identity.ts",
  },
  {
    role: "real_dispatch_source_verifier",
    path: "apps/api/src/site-builder/eval/copy-pilot-source-verifier.ts",
  },
  {
    role: "real_dispatch_gateway",
    path: "apps/api/src/site-builder/eval/copy-pilot-trusted-gateway.ts",
  },
  {
    role: "admission_contract",
    path: "apps/api/src/site-builder/eval/copy-real-capability-admission.ts",
  },
  {
    role: "real_dispatch_runner",
    path: "apps/api/src/site-builder/eval/copy-real-capability-runner.ts",
  },
  {
    role: "claim_contract",
    path: "apps/api/src/site-builder/publishable-claim-snapshot.ts",
  },
  {
    role: "contracts_manifest",
    path: "packages/contracts/package.json",
  },
  {
    role: "contracts_exports",
    path: "packages/contracts/src/index.ts",
  },
  {
    role: "contracts_source",
    path: "packages/contracts/src/site-builder/copy-bundle.ts",
  },
  {
    role: "contracts_build",
    path: "packages/contracts/tsconfig.json",
  },
  {
    role: "build_dependency_manifest",
    path: "packages/db/package.json",
  },
  {
    role: "build_dependency_schema",
    path: "packages/db/prisma/schema.prisma",
  },
  {
    role: "dependency_lock",
    path: "pnpm-lock.yaml",
  },
] as const satisfies readonly CopyRealCapabilitySourceFileSpec[];

export const COPY_REAL_CAPABILITY_MANIFEST_SOURCE_FILES = Object.freeze(
  [...SOURCE_FILE_SPECS]
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    )
    .map((entry) => Object.freeze({ ...entry })),
);

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

export function buildCopyRealCapabilitySourceFileSpecs(
  trackedPaths: readonly string[],
): readonly CopyRealCapabilitySourceFileSpec[] {
  const byPath = new Map<string, CopyRealCapabilitySourceFileSpec>(
    COPY_REAL_CAPABILITY_MANIFEST_SOURCE_FILES.map((entry) => [
      entry.path,
      entry,
    ]),
  );
  for (const path of trackedPaths) {
    const role = transitiveRole(path);
    if (role && !byPath.has(path)) {
      byPath.set(path, Object.freeze({ role, path }));
    }
  }
  return Object.freeze(
    [...byPath.values()]
      .sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      )
      .map((entry) => Object.freeze({ ...entry })),
  );
}

export interface CopyRealCapabilitySourceBundle {
  schemaVersion: "site-builder-copy-real-capability-source-bundle/2026-08-05-v1";
  files: readonly CopyRealCapabilitySourceFile[];
  digest: string;
}

export interface CopyRealCapabilityContractSnapshot {
  schemaVersion: "site-builder-copy-real-capability-contract-snapshot/2026-08-05-v1";
  taskId: "site_builder.copy";
  taskContractVersion: string;
  planId: string;
  planDigest: string;
  fixtureId: string;
  inputDigest: string;
  outputSchemaDigest: string;
  promptDigest: string;
  executionScopeDigest: string;
  admissionSourceDigest: string;
}

export interface CopyRealCapabilityManifestArtifact {
  schemaVersion: "site-builder-copy-real-capability-manifest-prep/2026-08-05-v1";
  artifactId: "site-builder-copy-real-capability-manifest-prep/2026-08-07-v11";
  classification: "FIXED_SOURCE_CREATE_ONLY";
  fixedSourceCommit: string;
  preparationHeadCommit: string;
  requiredMergeMethod: "merge_commit";
  createOnly: true;
  dispatchAuthorization: "NOT_AUTHORIZED";
  dispatchCapable: false;
  observedNetworkCalls: 0;
  observedModelWireCalls: 0;
  observedModelCost: { CNY: 0; USD: 0 };
  manifest: CopyRealCapabilityManifest;
  sourceBundle: CopyRealCapabilitySourceBundle;
  compiledRuntimeExpectation: CompiledRuntimeExpectation;
  contractSnapshot: CopyRealCapabilityContractSnapshot;
  preparationVerification: {
    fixedCommitReachableFromPreparationHead: true;
    fixedCommitReachableFromOriginMainAtPreparation: boolean;
    preparationHeadMustRemainReachableFromOriginMainBeforeDispatch: true;
    trackedSourceBytesMatch: true;
    compiledRuntimeBuiltFromFixedSource: true;
    futureExecutionMustReverify: true;
  };
  compiledRuntimeAttestation: "REQUIRED_BEFORE_DISPATCH";
  requiredFollowup: readonly [
    "PURPOSE_SPECIFIC_FINITE_CREDENTIAL_ATTESTATION",
    "TRUSTED_SETTLEMENT_OBSERVER_AND_LEDGER_BINDING",
    "GIT_REVIEWED_RUNTIME_SETTLEMENT_EVIDENCE",
    "SEPARATE_DISPATCH_AUTHORIZATION",
    "TRUSTED_OPERATIONAL_PROOF_FACTORIES_AND_BRANDED_RECEIPT",
    "REAL_GATEWAY_POST_WIRE_FREEZE",
    "REAL_GATEWAY_REPAIR_PAYLOAD_BINDING",
    "FIXED_SOURCE_COMPILED_RUNTIME_EXPECTATION",
  ];
  artifactDigest: string;
}

function fail(code: string): never {
  throw new Error(code);
}

function fixedSourceCommit(): string {
  if (
    COPY_REAL_CAPABILITY_FIXED_SOURCE_COMMIT == null ||
    !GIT_COMMIT.test(COPY_REAL_CAPABILITY_FIXED_SOURCE_COMMIT)
  ) {
    fail("COPY_REAL_CAPABILITY_V11_FIXED_SOURCE_REQUIRED");
  }
  return COPY_REAL_CAPABILITY_FIXED_SOURCE_COMMIT;
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

function contractSnapshot(): CopyRealCapabilityContractSnapshot {
  const taskContractVersion =
    COPY_CAPABILITY_PILOT_PLAN.source.taskContractVersion;
  if (!taskContractVersion) {
    fail("COPY_REAL_CAPABILITY_CONTRACT_SNAPSHOT_INVALID");
  }
  return {
    schemaVersion:
      "site-builder-copy-real-capability-contract-snapshot/2026-08-05-v1",
    taskId: "site_builder.copy",
    taskContractVersion,
    planId: COPY_CAPABILITY_PILOT_PLAN.planId,
    planDigest: COPY_REAL_CAPABILITY_ADMISSION_SOURCE.planDigest,
    fixtureId: COPY_CAPABILITY_PILOT_PLAN.source.fixtureId,
    inputDigest: COPY_CAPABILITY_PILOT_PLAN.source.inputDigest,
    outputSchemaDigest: COPY_CAPABILITY_PILOT_PLAN.source.outputSchemaDigest,
    promptDigest: COPY_CAPABILITY_PILOT_PLAN.source.promptDigest,
    executionScopeDigest: canonicalDigest(
      COPY_REAL_CAPABILITY_ADMISSION_SOURCE.executions,
    ),
    admissionSourceDigest: canonicalDigest(
      COPY_REAL_CAPABILITY_ADMISSION_SOURCE,
    ),
  };
}

export function buildCopyRealCapabilityManifestArtifact(input: {
  preparationHeadCommit: string;
  sourceFiles: readonly CopyRealCapabilitySourceFile[];
  compiledRuntimeExpectation: CompiledRuntimeExpectation;
  fixedCommitReachableFromOriginMainAtPreparation?: boolean;
}): CopyRealCapabilityManifestArtifact {
  const sourceCommit = fixedSourceCommit();
  if (!GIT_COMMIT.test(input.preparationHeadCommit)) {
    fail("COPY_REAL_CAPABILITY_PREPARATION_HEAD_INVALID");
  }
  if (!validSourceFiles(input.sourceFiles)) {
    fail("COPY_REAL_CAPABILITY_SOURCE_BUNDLE_INVALID");
  }
  const files = input.sourceFiles.map((entry) => Object.freeze({ ...entry }));
  const sourceBundle = Object.freeze({
    schemaVersion:
      "site-builder-copy-real-capability-source-bundle/2026-08-05-v1" as const,
    files: Object.freeze(files),
    digest: canonicalDigest(files),
  });
  try {
    validateCompiledRuntimeExpectation(input.compiledRuntimeExpectation);
  } catch {
    fail("COPY_REAL_CAPABILITY_COMPILED_RUNTIME_EXPECTATION_INVALID");
  }
  if (
    input.compiledRuntimeExpectation.buildSourceCommit !== sourceCommit ||
    input.compiledRuntimeExpectation.sourceBundleDigest !==
      sourceBundle.digest ||
    canonicalDigest(input.compiledRuntimeExpectation.buildCommands) !==
      canonicalDigest(COPY_PILOT_COMPILED_BUILD_COMMANDS) ||
    canonicalDigest(
      input.compiledRuntimeExpectation.artifacts.map(({ path }) => path),
    ) !== canonicalDigest([...COPY_REAL_CAPABILITY_ARTIFACT_PATHS].sort())
  ) {
    fail("COPY_REAL_CAPABILITY_COMPILED_RUNTIME_EXPECTATION_INVALID");
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
  const manifest = Object.freeze({
    schemaVersion:
      "site-builder-copy-real-capability-manifest/2026-08-05-v1" as const,
    manifestId: "site-builder-copy-real-capability/2026-08-07-v11",
    fixedSourceCommit: sourceCommit,
    sourceBundleDigest: sourceBundle.digest,
    planDigest: COPY_REAL_CAPABILITY_ADMISSION_SOURCE.planDigest,
    dispatchAuthorization: "NOT_AUTHORIZED" as const,
    taskId: "site_builder.copy" as const,
    plannedExecutions: 3 as const,
    maximumWireCalls: 6 as const,
    maximumRepairCallsPerExecution: 1 as const,
    executions: COPY_REAL_CAPABILITY_ADMISSION_SOURCE.executions,
  });
  const withoutDigest = {
    schemaVersion:
      "site-builder-copy-real-capability-manifest-prep/2026-08-05-v1" as const,
    artifactId:
      "site-builder-copy-real-capability-manifest-prep/2026-08-07-v11" as const,
    classification: "FIXED_SOURCE_CREATE_ONLY" as const,
    fixedSourceCommit: sourceCommit,
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
    compiledRuntimeExpectation,
    contractSnapshot: Object.freeze(contractSnapshot()),
    preparationVerification: Object.freeze({
      fixedCommitReachableFromPreparationHead: true as const,
      fixedCommitReachableFromOriginMainAtPreparation:
        input.fixedCommitReachableFromOriginMainAtPreparation ?? true,
      preparationHeadMustRemainReachableFromOriginMainBeforeDispatch:
        true as const,
      trackedSourceBytesMatch: true as const,
      compiledRuntimeBuiltFromFixedSource: true as const,
      futureExecutionMustReverify: true as const,
    }),
    compiledRuntimeAttestation: "REQUIRED_BEFORE_DISPATCH" as const,
    requiredFollowup: Object.freeze([
      "PURPOSE_SPECIFIC_FINITE_CREDENTIAL_ATTESTATION",
      "TRUSTED_SETTLEMENT_OBSERVER_AND_LEDGER_BINDING",
      "GIT_REVIEWED_RUNTIME_SETTLEMENT_EVIDENCE",
      "SEPARATE_DISPATCH_AUTHORIZATION",
      "TRUSTED_OPERATIONAL_PROOF_FACTORIES_AND_BRANDED_RECEIPT",
      "REAL_GATEWAY_POST_WIRE_FREEZE",
      "REAL_GATEWAY_REPAIR_PAYLOAD_BINDING",
      "FIXED_SOURCE_COMPILED_RUNTIME_EXPECTATION",
    ] as const),
  };
  return deepFreeze({
    ...withoutDigest,
    artifactDigest: canonicalDigest(withoutDigest),
  });
}

export function validateCopyRealCapabilityManifestArtifact(
  value: unknown,
): asserts value is CopyRealCapabilityManifestArtifact {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error();
    }
    const artifact = value as CopyRealCapabilityManifestArtifact;
    const rebuilt = buildCopyRealCapabilityManifestArtifact({
      preparationHeadCommit: artifact.preparationHeadCommit,
      sourceFiles: artifact.sourceBundle.files,
      compiledRuntimeExpectation: artifact.compiledRuntimeExpectation,
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
    fail("COPY_REAL_CAPABILITY_MANIFEST_ARTIFACT_INVALID");
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

export async function prepareCopyRealCapabilityManifestFromRepository(
  repositoryRoot: string,
): Promise<CopyRealCapabilityManifestArtifact> {
  const sourceCommit = fixedSourceCommit();
  const root = realpathSync(repositoryRoot);
  if (
    gitText(root, ["status", "--porcelain", "--untracked-files=all"]) !== ""
  ) {
    fail("COPY_REAL_CAPABILITY_PREPARATION_WORKTREE_DIRTY");
  }
  const preparationHeadCommit = gitText(root, ["rev-parse", "HEAD"]);
  if (
    !GIT_COMMIT.test(preparationHeadCommit) ||
    !gitAncestor(root, sourceCommit, preparationHeadCommit)
  ) {
    fail("COPY_REAL_CAPABILITY_FIXED_SOURCE_UNREACHABLE");
  }

  const trackedTransitivePaths = gitText(root, [
    "ls-tree",
    "-r",
    "--name-only",
    sourceCommit,
    "--",
    "apps/api/src/model-runtime",
    "packages/contracts/src",
  ]).split("\n");
  const sourceFileSpecs = buildCopyRealCapabilitySourceFileSpecs(
    trackedTransitivePaths,
  );
  const sourceFiles = sourceFileSpecs.map(({ role, path }) => {
    const metadata = lstatSync(resolve(root, path));
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      fail("COPY_REAL_CAPABILITY_SOURCE_BUNDLE_INVALID");
    }
    const fixedBytes = gitOutput(root, ["show", `${sourceCommit}:${path}`]);
    const workingBytes = readFileSync(resolve(root, path));
    if (!fixedBytes.equals(workingBytes)) {
      fail("COPY_REAL_CAPABILITY_SOURCE_BYTES_MISMATCH");
    }
    return Object.freeze({ role, path, sha256: sha256(fixedBytes) });
  });

  for (const command of [
    ["--filter", "@global/db", "generate"],
    ["--filter", "@global/contracts", "build"],
    ["--filter", "@global/api", "build"],
  ] as const) {
    execFileSync("pnpm", [...command], {
      cwd: root,
      stdio: "inherit",
    });
  }
  const sourceBundleDigest = canonicalDigest(sourceFiles);
  const compiledRuntimeExpectation = await createCompiledRuntimeExpectation({
    repositoryRoot: root,
    artifactPaths: COPY_REAL_CAPABILITY_ARTIFACT_PATHS,
    buildSourceCommit: sourceCommit,
    sourceBundleDigest,
    buildCommands: COPY_PILOT_COMPILED_BUILD_COMMANDS,
  });

  const artifact = buildCopyRealCapabilityManifestArtifact({
    preparationHeadCommit,
    sourceFiles,
    compiledRuntimeExpectation,
    fixedCommitReachableFromOriginMainAtPreparation: gitAncestor(
      root,
      sourceCommit,
      "origin/main",
    ),
  });
  VERIFIED_PREPARATION_ARTIFACTS.add(artifact);
  return artifact;
}

export async function writeCopyRealCapabilityManifestCreateOnly(
  repositoryRoot: string,
  artifact: CopyRealCapabilityManifestArtifact,
): Promise<void> {
  if (!VERIFIED_PREPARATION_ARTIFACTS.has(artifact)) {
    fail("COPY_REAL_CAPABILITY_PREPARATION_NOT_VERIFIED");
  }
  validateCopyRealCapabilityManifestArtifact(artifact);
  const root = await realpath(repositoryRoot);
  const parent = resolve(
    root,
    dirname(COPY_REAL_CAPABILITY_MANIFEST_OUTPUT_PATH),
  );
  const parentMetadata = await lstat(parent);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    fail("COPY_REAL_CAPABILITY_OUTPUT_PARENT_INVALID");
  }
  const realParent = await realpath(parent);
  const parentRelative = relative(root, realParent);
  if (
    parentRelative === ".." ||
    parentRelative.startsWith(`..${sep}`) ||
    resolve(root, parentRelative) !== realParent
  ) {
    fail("COPY_REAL_CAPABILITY_OUTPUT_PARENT_INVALID");
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
      fail("COPY_REAL_CAPABILITY_OUTPUT_PARENT_INVALID");
    }
    output = await open(
      join(descriptorPath, basename(COPY_REAL_CAPABILITY_MANIFEST_OUTPUT_PATH)),
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
