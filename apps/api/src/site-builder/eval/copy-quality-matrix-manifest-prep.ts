import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { canonicalDigest } from "../../model-runtime";
import { COPY_QUALITY_MATRIX_ADMISSION_SOURCE } from "./copy-quality-matrix-admission";
import {
  COPY_QUALITY_MATRIX_PLAN,
  validateCopyQualityMatrixPlan,
  type CopyQualityMatrixExecution,
} from "./copy-quality-matrix-runner";

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const VERIFIED_PREPARATION_ARTIFACTS = new WeakSet<object>();

export const COPY_QUALITY_MATRIX_MANIFEST_OUTPUT_PATH =
  "docs/evidence/site-builder/m1-g-copy-quality-matrix-manifest-v3.json" as const;

export interface CopyQualityMatrixSourceFileSpec {
  role: string;
  path: string;
}

export interface CopyQualityMatrixSourceFile extends CopyQualityMatrixSourceFileSpec {
  sha256: string;
}

const SOURCE_FILE_SPECS = [
  { role: "api_manifest", path: "apps/api/package.json" },
  {
    role: "gateway_settlement",
    path: "apps/api/src/model-gateway/new-api-request-bound-settlement.ts",
  },
  {
    role: "runtime_adapter",
    path: "apps/api/src/model-runtime/adapters/ai-sdk-openai-chat-completions.adapter.ts",
  },
  {
    role: "runtime_capability",
    path: "apps/api/src/model-runtime/capability-registry.ts",
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
    role: "runtime_exports",
    path: "apps/api/src/model-runtime/index.ts",
  },
  {
    role: "runtime_execution",
    path: "apps/api/src/model-runtime/model-execution-runtime.ts",
  },
  {
    role: "runtime_ledger",
    path: "apps/api/src/model-runtime/real-model-execution-ledger-storage.ts",
  },
  {
    role: "runtime_ledger",
    path: "apps/api/src/model-runtime/real-model-execution-ledger.ts",
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
    role: "quality_fixture",
    path: "apps/api/src/site-builder/eval/copy-assembly-eval.ts",
  },
  {
    role: "candidate_scope",
    path: "apps/api/src/site-builder/eval/copy-evaluation-v2-candidates.ts",
  },
  {
    role: "quality_plan",
    path: "apps/api/src/site-builder/eval/copy-evaluation-v2.ts",
  },
  {
    role: "real_dispatch_ledger_identity",
    path: "apps/api/src/site-builder/eval/copy-pilot-ledger-identity.ts",
  },
  {
    role: "real_dispatch_gateway",
    path: "apps/api/src/site-builder/eval/copy-pilot-trusted-gateway.ts",
  },
  {
    role: "quality_evaluator",
    path: "apps/api/src/site-builder/eval/copy-quality-evaluator.ts",
  },
  {
    role: "quality_replay",
    path: "apps/api/src/site-builder/eval/copy-quality-accepted-replay.ts",
  },
  {
    role: "quality_replay",
    path: "apps/api/src/site-builder/eval/copy-quality-candidate-receipt.ts",
  },
  {
    role: "quality_matrix_admission",
    path: "apps/api/src/site-builder/eval/copy-quality-matrix-admission.ts",
  },
  {
    role: "manifest_prep",
    path: "apps/api/src/site-builder/eval/copy-quality-matrix-manifest-prep.ts",
  },
  {
    role: "quality_matrix_runner",
    path: "apps/api/src/site-builder/eval/copy-quality-matrix-runner.ts",
  },
  {
    role: "quality_rubric",
    path: "apps/api/src/site-builder/eval/copy-quality-rubric.ts",
  },
  {
    role: "manifest_script",
    path: "apps/api/scripts/prepare-site-builder-copy-quality-matrix-manifest.mts",
  },
  {
    role: "claim_contract",
    path: "apps/api/src/site-builder/publishable-claim-snapshot.ts",
  },
  { role: "contracts_manifest", path: "packages/contracts/package.json" },
  {
    role: "contracts_exports",
    path: "packages/contracts/src/index.ts",
  },
  {
    role: "contracts_source",
    path: "packages/contracts/src/site-builder/copy-bundle.ts",
  },
  { role: "contracts_build", path: "packages/contracts/tsconfig.json" },
  { role: "dependency_lock", path: "pnpm-lock.yaml" },
] as const satisfies readonly CopyQualityMatrixSourceFileSpec[];

export const COPY_QUALITY_MATRIX_MANIFEST_SOURCE_FILES = Object.freeze(
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

export function buildCopyQualityMatrixSourceFileSpecs(
  trackedPaths: readonly string[],
): readonly CopyQualityMatrixSourceFileSpec[] {
  const byPath = new Map<string, CopyQualityMatrixSourceFileSpec>(
    COPY_QUALITY_MATRIX_MANIFEST_SOURCE_FILES.map((entry) => [
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

export interface CopyQualityMatrixSourceBundle {
  schemaVersion: "site-builder-copy-quality-matrix-source-bundle/2026-08-07-v3";
  files: readonly CopyQualityMatrixSourceFile[];
  digest: string;
}

export interface CopyQualityMatrixSourceDigests {
  runner: string;
  evaluator: string;
  fixtures: string;
  runtime: string;
}

export interface CopyQualityMatrixManifest {
  schemaVersion: "site-builder-copy-quality-matrix-manifest/2026-08-07-v3";
  manifestId: "site-builder-copy-quality-matrix/2026-08-07-v3";
  purpose: "site_builder_copy_quality_matrix";
  fixedSourceCommit: string;
  sourceBundleDigest: string;
  planDigest: string;
  dispatchAuthorization: "NOT_AUTHORIZED";
  taskId: "site_builder.copy";
  plannedExecutions: 36;
  maximumWireCalls: 72;
  maximumRepairCallsPerExecution: 1;
  ledgerTopology: "shared_campaign_ledger";
  acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted";
  evidenceKind: "quality_matrix";
  outputReplayPolicy: "git_reviewed_canonical_output_bytes_consume_once";
  executions: readonly CopyQualityMatrixExecution[];
}

export interface CopyQualityMatrixManifestArtifact {
  schemaVersion: "site-builder-copy-quality-matrix-manifest-prep/2026-08-07-v3";
  artifactId: "site-builder-copy-quality-matrix-manifest-prep/2026-08-07-v3";
  classification: "FIXED_SOURCE_CREATE_ONLY";
  fixedSourceCommit: string;
  preparationHeadCommit: string;
  createOnly: true;
  dispatchAuthorization: "NOT_AUTHORIZED";
  dispatchCapable: false;
  observedNetworkCalls: 0;
  observedModelWireCalls: 0;
  manifest: CopyQualityMatrixManifest;
  sourceBundle: CopyQualityMatrixSourceBundle;
  admissionSourceDigest: string;
  sourceDigests: CopyQualityMatrixSourceDigests;
  preparationVerification: {
    fixedCommitEqualsPreparationHead: boolean;
    preparationHeadEqualsOriginMain: true;
    trackedSourceBytesMatch: true;
    futureExecutionMustReverify: true;
  };
  requiredFollowup: readonly [
    "SUCCESSFUL_CAPABILITY_PILOT_EVIDENCE",
    "SEPARATE_TASK_MATRIX_DISPATCH_AUTHORIZATION",
    "PURPOSE_SPECIFIC_FINITE_CREDENTIAL_ATTESTATION",
    "SEPARATE_MATRIX_LEDGER_IDENTITY",
    "KNOWN_PER_PHYSICAL_CALL_SETTLEMENT",
    "BLIND_OR_PROVIDER_SEPARATED_REVIEWS",
    "SEPARATE_PROMOTION_PR_AND_AUTHORIZATION",
    "SEPARATE_RUNTIME_ROUTE_ADOPTION_PR_AND_AUTHORIZATION",
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

function validSourceFiles(
  value: readonly CopyQualityMatrixSourceFile[],
): boolean {
  const requiredByPath = new Map<string, string>(
    COPY_QUALITY_MATRIX_MANIFEST_SOURCE_FILES.map((entry) => [
      entry.path,
      entry.role,
    ]),
  );
  return (
    value.length >= COPY_QUALITY_MATRIX_MANIFEST_SOURCE_FILES.length &&
    new Set(value.map(({ path }) => path)).size === value.length &&
    COPY_QUALITY_MATRIX_MANIFEST_SOURCE_FILES.every(({ path, role }) =>
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

function digestFilesByRoles(
  files: readonly CopyQualityMatrixSourceFile[],
  roles: ReadonlySet<string>,
): string {
  const selected = files.filter((file) => roles.has(file.role));
  if (selected.length === 0) fail("COPY_QUALITY_MATRIX_SOURCE_ROLE_MISSING");
  return canonicalDigest(selected);
}

function buildSourceDigests(
  files: readonly CopyQualityMatrixSourceFile[],
): CopyQualityMatrixSourceDigests {
  const runtimeRoles = new Set([
    "gateway_settlement",
    "real_dispatch_gateway",
    "real_dispatch_ledger_identity",
    "runtime_adapter",
    "runtime_capability",
    "runtime_context",
    "runtime_execution",
    "runtime_exports",
    "runtime_ledger",
    "runtime_types",
    "runtime_transitive_source",
  ]);
  return Object.freeze({
    runner: digestFilesByRoles(files, new Set(["quality_matrix_runner"])),
    evaluator: digestFilesByRoles(
      files,
      new Set(["quality_evaluator", "quality_replay", "quality_rubric"]),
    ),
    fixtures: digestFilesByRoles(files, new Set(["quality_fixture"])),
    runtime: digestFilesByRoles(files, runtimeRoles),
  });
}

function assertMatrixContracts(): void {
  validateCopyQualityMatrixPlan(COPY_QUALITY_MATRIX_PLAN);
  if (
    COPY_QUALITY_MATRIX_PLAN.taskId !== "site_builder.copy" ||
    COPY_QUALITY_MATRIX_PLAN.plannedExecutions !== 36 ||
    COPY_QUALITY_MATRIX_PLAN.maximumWireCalls !== 72 ||
    COPY_QUALITY_MATRIX_PLAN.maximumRepairCallsPerExecution !== 1 ||
    COPY_QUALITY_MATRIX_PLAN.executions.length !== 36 ||
    new Set(
      COPY_QUALITY_MATRIX_PLAN.executions.map(
        ({ executionKey }) => executionKey,
      ),
    ).size !== 36 ||
    COPY_QUALITY_MATRIX_ADMISSION_SOURCE.purpose !==
      "site_builder_copy_quality_matrix" ||
    COPY_QUALITY_MATRIX_ADMISSION_SOURCE.plannedExecutions !== 36 ||
    COPY_QUALITY_MATRIX_ADMISSION_SOURCE.maximumWireCalls !== 72 ||
    COPY_QUALITY_MATRIX_ADMISSION_SOURCE.maximumRepairCallsPerExecution !== 1 ||
    COPY_QUALITY_MATRIX_ADMISSION_SOURCE.ledgerTopology !==
      "shared_campaign_ledger" ||
    COPY_QUALITY_MATRIX_ADMISSION_SOURCE.acceptedEvidenceClass !==
      "git_reviewed_gateway_settlement_accepted" ||
    COPY_QUALITY_MATRIX_ADMISSION_SOURCE.evidenceKind !== "quality_matrix" ||
    COPY_QUALITY_MATRIX_ADMISSION_SOURCE.outputReplayPolicy !==
      "git_reviewed_canonical_output_bytes_consume_once"
  ) {
    fail("COPY_QUALITY_MATRIX_CONTRACT_INVALID");
  }
}

export function buildCopyQualityMatrixManifestArtifact(input: {
  fixedSourceCommit: string;
  preparationHeadCommit: string;
  sourceFiles: readonly CopyQualityMatrixSourceFile[];
}): CopyQualityMatrixManifestArtifact {
  if (!GIT_COMMIT.test(input.fixedSourceCommit)) {
    fail("COPY_QUALITY_MATRIX_FIXED_SOURCE_COMMIT_INVALID");
  }
  if (!GIT_COMMIT.test(input.preparationHeadCommit)) {
    fail("COPY_QUALITY_MATRIX_PREPARATION_HEAD_INVALID");
  }
  if (!validSourceFiles(input.sourceFiles)) {
    fail("COPY_QUALITY_MATRIX_SOURCE_BUNDLE_INVALID");
  }
  assertMatrixContracts();

  const files = Object.freeze(
    input.sourceFiles.map((entry) => Object.freeze({ ...entry })),
  );
  const sourceBundle = Object.freeze({
    schemaVersion:
      "site-builder-copy-quality-matrix-source-bundle/2026-08-07-v3" as const,
    files,
    digest: canonicalDigest(files),
  });
  const sourceDigests = buildSourceDigests(files);
  const executions = Object.freeze(
    COPY_QUALITY_MATRIX_PLAN.executions.map((execution) =>
      Object.freeze({ ...execution }),
    ),
  );
  const manifest = Object.freeze({
    schemaVersion:
      "site-builder-copy-quality-matrix-manifest/2026-08-07-v3" as const,
    manifestId: "site-builder-copy-quality-matrix/2026-08-07-v3" as const,
    purpose: "site_builder_copy_quality_matrix" as const,
    fixedSourceCommit: input.fixedSourceCommit,
    sourceBundleDigest: sourceBundle.digest,
    planDigest: canonicalDigest(COPY_QUALITY_MATRIX_PLAN),
    dispatchAuthorization: "NOT_AUTHORIZED" as const,
    taskId: "site_builder.copy" as const,
    plannedExecutions: 36 as const,
    maximumWireCalls: 72 as const,
    maximumRepairCallsPerExecution: 1 as const,
    ledgerTopology: "shared_campaign_ledger" as const,
    acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted" as const,
    evidenceKind: "quality_matrix" as const,
    outputReplayPolicy:
      "git_reviewed_canonical_output_bytes_consume_once" as const,
    executions,
  });
  const withoutDigest = {
    schemaVersion:
      "site-builder-copy-quality-matrix-manifest-prep/2026-08-07-v3" as const,
    artifactId:
      "site-builder-copy-quality-matrix-manifest-prep/2026-08-07-v3" as const,
    classification: "FIXED_SOURCE_CREATE_ONLY" as const,
    fixedSourceCommit: input.fixedSourceCommit,
    preparationHeadCommit: input.preparationHeadCommit,
    createOnly: true as const,
    dispatchAuthorization: "NOT_AUTHORIZED" as const,
    dispatchCapable: false as const,
    observedNetworkCalls: 0 as const,
    observedModelWireCalls: 0 as const,
    manifest,
    sourceBundle,
    admissionSourceDigest: canonicalDigest(
      COPY_QUALITY_MATRIX_ADMISSION_SOURCE,
    ),
    sourceDigests,
    preparationVerification: Object.freeze({
      fixedCommitEqualsPreparationHead:
        input.fixedSourceCommit === input.preparationHeadCommit,
      preparationHeadEqualsOriginMain: true as const,
      trackedSourceBytesMatch: true as const,
      futureExecutionMustReverify: true as const,
    }),
    requiredFollowup: Object.freeze([
      "SUCCESSFUL_CAPABILITY_PILOT_EVIDENCE",
      "SEPARATE_TASK_MATRIX_DISPATCH_AUTHORIZATION",
      "PURPOSE_SPECIFIC_FINITE_CREDENTIAL_ATTESTATION",
      "SEPARATE_MATRIX_LEDGER_IDENTITY",
      "KNOWN_PER_PHYSICAL_CALL_SETTLEMENT",
      "BLIND_OR_PROVIDER_SEPARATED_REVIEWS",
      "SEPARATE_PROMOTION_PR_AND_AUTHORIZATION",
      "SEPARATE_RUNTIME_ROUTE_ADOPTION_PR_AND_AUTHORIZATION",
    ] as const),
  };
  return deepFreeze({
    ...withoutDigest,
    artifactDigest: canonicalDigest(withoutDigest),
  });
}

export function validateCopyQualityMatrixManifestArtifact(
  value: unknown,
): asserts value is CopyQualityMatrixManifestArtifact {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error();
    }
    const artifact = value as CopyQualityMatrixManifestArtifact;
    const rebuilt = buildCopyQualityMatrixManifestArtifact({
      fixedSourceCommit: artifact.fixedSourceCommit,
      preparationHeadCommit: artifact.preparationHeadCommit,
      sourceFiles: artifact.sourceBundle.files,
    });
    if (canonicalDigest(rebuilt) !== canonicalDigest(artifact)) {
      throw new Error();
    }
    const { artifactDigest, ...withoutDigest } = artifact;
    if (artifactDigest !== canonicalDigest(withoutDigest)) {
      throw new Error();
    }
  } catch {
    fail("COPY_QUALITY_MATRIX_MANIFEST_ARTIFACT_INVALID");
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

export function prepareCopyQualityMatrixManifestFromRepository(
  repositoryRoot: string,
): CopyQualityMatrixManifestArtifact {
  const root = realpathSync(repositoryRoot);
  if (
    gitText(root, ["status", "--porcelain", "--untracked-files=all"]) !== ""
  ) {
    fail("COPY_QUALITY_MATRIX_PREPARATION_WORKTREE_DIRTY");
  }
  const preparationHeadCommit = gitText(root, ["rev-parse", "HEAD"]);
  const originMainCommit = gitText(root, ["rev-parse", "origin/main"]);
  if (
    !GIT_COMMIT.test(preparationHeadCommit) ||
    originMainCommit !== preparationHeadCommit
  ) {
    fail("COPY_QUALITY_MATRIX_PREPARATION_HEAD_NOT_ORIGIN_MAIN");
  }
  const fixedSourceCommit = preparationHeadCommit;
  const trackedTransitivePaths = gitText(root, [
    "ls-tree",
    "-r",
    "--name-only",
    fixedSourceCommit,
    "--",
    "apps/api/src/model-runtime",
    "packages/contracts/src",
  ]).split("\n");
  const specs = buildCopyQualityMatrixSourceFileSpecs(trackedTransitivePaths);
  const sourceFiles = specs.map(({ role, path }) => {
    const workingPath = resolve(root, path);
    const metadata = lstatSync(workingPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      fail("COPY_QUALITY_MATRIX_SOURCE_BUNDLE_INVALID");
    }
    const fixedBytes = gitOutput(root, [
      "show",
      `${fixedSourceCommit}:${path}`,
    ]);
    const workingBytes = readFileSync(workingPath);
    if (!fixedBytes.equals(workingBytes)) {
      fail("COPY_QUALITY_MATRIX_SOURCE_BYTES_MISMATCH");
    }
    return Object.freeze({ role, path, sha256: sha256(fixedBytes) });
  });
  const artifact = buildCopyQualityMatrixManifestArtifact({
    fixedSourceCommit,
    preparationHeadCommit,
    sourceFiles,
  });
  VERIFIED_PREPARATION_ARTIFACTS.add(artifact);
  return artifact;
}

export async function writeCopyQualityMatrixManifestCreateOnly(
  repositoryRoot: string,
  artifact: CopyQualityMatrixManifestArtifact,
): Promise<void> {
  if (!VERIFIED_PREPARATION_ARTIFACTS.has(artifact)) {
    fail("COPY_QUALITY_MATRIX_PREPARATION_NOT_VERIFIED");
  }
  validateCopyQualityMatrixManifestArtifact(artifact);
  const root = await realpath(repositoryRoot);
  const parent = resolve(
    root,
    dirname(COPY_QUALITY_MATRIX_MANIFEST_OUTPUT_PATH),
  );
  const parentMetadata = await lstat(parent);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    fail("COPY_QUALITY_MATRIX_OUTPUT_PARENT_INVALID");
  }
  const realParent = await realpath(parent);
  const parentRelative = relative(root, realParent);
  if (
    parentRelative === ".." ||
    parentRelative.startsWith(`..${sep}`) ||
    resolve(root, parentRelative) !== realParent
  ) {
    fail("COPY_QUALITY_MATRIX_OUTPUT_PARENT_INVALID");
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
      fail("COPY_QUALITY_MATRIX_OUTPUT_PARENT_INVALID");
    }
    output = await open(
      join(descriptorPath, basename(COPY_QUALITY_MATRIX_MANIFEST_OUTPUT_PATH)),
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
