import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildClosedCommandRequest,
  computeLauncherContractDigests,
} from "./governance-organization-identity-launcher.mjs";

export const SHA = "a".repeat(64);
export const SHA_B = "b".repeat(64);
export const SHA_C = "c".repeat(64);
export const COMMIT = "1".repeat(40);
export const REQUEST_ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/requests";
export const OUTPUT_ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/outputs";
export const TOOL_ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root";
export const RUNTIME_ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime";
export const EXPECTED_COMMAND_IDS = Object.freeze([
  "BOOTSTRAP_AUTHORITY_RUN_V1",
  "SCOPED_REVIEW_VERIFY_V1",
  "CURRENT_MAIN_AUDIT_LOCAL_V1",
  "CURRENT_MAIN_VALIDATE_V1",
  "CURRENT_MAIN_GENERATE_V1",
  "COPY_WRITE_ELIGIBILITY_V1",
  "COPY_SYNC_CITATIONS_V1",
  "GIT_REFRESH_START_V1",
  "GIT_REFRESH_COMMIT_V1",
  "GIT_ADMISSION_COMMIT_V1",
  "GIT_ACCEPTANCE_COMMIT_V1",
  "REFRESH_VERIFY_V1",
  "MIGRATION_STATIC_VERIFY_V1",
  "PRISMA_GENERATE_V1",
  "SCANNER_TEST_V1",
  "SCANNER_BASELINE_V1",
  "SCANNER_STAGE_V1",
  "SCANNER_ZERO_V1",
  "SCANNER_ACCEPTANCE_V1",
  "GOVERNANCE_VERIFY_V1",
  "DOCS_VERIFY_V1",
  "API_VERIFY_V1",
  "RUNTIME_ARTIFACT_VERIFY_V1",
  "CONTRACT_GRAPH_VERIFY_V1",
  "V3_WORKTREE_CREATE_V1",
]);
export const EXPECTED_ENVIRONMENT_NAMES = Object.freeze([
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "COREPACK_HOME",
  "PNPM_HOME",
  "TMPDIR",
  "NPM_CONFIG_USERCONFIG",
  "CI",
  "LANG",
  "LC_ALL",
]);
export const PLAN_ARTIFACT = Object.freeze({
  path: "docs/superpowers/plans/2026-09-01-organization-identity-writer-ban-at-source.md",
  commit: "0a6d0a3362dd927bc3c4893b2228488328cbcf95",
  blobId: "bc27bcd728bffa8ddfedf8a264b4687a0dc128b7",
  sha256: "6a1712d635f028b406ff00d84b88ea4ad749d004a4d946478a8b0d508df7bfcd",
});
export const SPEC_ARTIFACT = Object.freeze({
  path: "docs/superpowers/specs/2026-09-01-organization-identity-writer-ban-at-source-design.md",
  commit: "b060c5dd4afef9fe42dfe510b02f930f56cdf7fe",
  blobId: "98891bcab636b852e71919b7de77343647917017",
  sha256: "536e376a40d9ef4f49a65bc0224b74d58eb8a2d743fa766aa020397e67279dd4",
});
export const HEX = Object.freeze([
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "a",
  "b",
  "c",
]);

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function canonicalJsonBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

export function sha256Of(value) {
  const bytes = Buffer.isBuffer(value) ? value : canonicalJsonBytes(value);
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildClosure(baseDir = "/controlled/bin") {
  return [
    "ENV",
    "NODE",
    "GIT",
    "COREPACK_SHIM",
    "COREPACK_LIB_COREPACK_CJS",
    "PNPM_SHIM",
    "PNPM_ENTRYPOINT",
  ].map((role, index) => ({
    role,
    logicalIdentity: `${role.toLowerCase()}@test`,
    executablePath: path.join(baseDir, role.toLowerCase()),
    realpathSha256: String(index + 1).repeat(64),
    sha256: String(index + 2).repeat(64),
    size: 100 + index,
    mode: 0o500,
  }));
}

export function buildValidRequest(overrides = {}) {
  return buildClosedCommandRequest({
    taskId: "2",
    commandId: "SCANNER_TEST_V1",
    mode: "TEST",
    subjectCommit: COMMIT,
    bootstrapContractSha256: SHA,
    launcherMaterializationReceiptSha256: SHA_B,
    launcherMaterializationReviewReceiptSha256: SHA_C,
    authorizationReceiptSha256: null,
    externalControllerReceiptSha256: null,
    anchorReceiptSha256: null,
    parameters: {
      baselineSubjectCommit: COMMIT,
      currentMainAdmissionCommit: "2".repeat(40),
      b0mMigrationCommit: "3".repeat(40),
      suiteId: "B0_SCANNER",
    },
    requestRoot: REQUEST_ROOT,
    outputRoot: OUTPUT_ROOT,
    ...overrides,
  });
}

export function buildBootstrapReceipt(
  request = buildValidRequest(),
  overrides = {},
) {
  return {
    schemaVersion: "organization-identity-bootstrap-run/v2",
    receiptCardinality: "ONE_COMMAND_ONE_RECEIPT",
    bootstrapContractSha256: request.bootstrapContractSha256,
    launcherMaterializationReceiptSha256:
      request.launcherMaterializationReceiptSha256,
    launcherMaterializationReviewReceiptSha256:
      request.launcherMaterializationReviewReceiptSha256,
    requestId: request.requestId,
    taskId: request.taskId,
    commandId: request.commandId,
    mode: request.mode,
    closedCommandRequestSha256: sha256Of(canonicalJsonBytes(request)),
    inputRecordPath: request.input.inputRecordPath,
    inputRecordUri: request.input.inputRecordUri,
    inputRecordSha256: request.input.inputRecordSha256,
    payloadSchemaSha256: request.input.payloadSchemaSha256,
    payloadSha256: request.input.payloadSha256,
    outputRecordPath: request.input.outputRecordPath,
    outputRecordSha256: SHA,
    authorizationReceiptSha256: request.authorizationReceiptSha256,
    externalControllerReceiptSha256: request.externalControllerReceiptSha256,
    anchorReceiptSha256: request.anchorReceiptSha256,
    externalLaunchReceiptSha256: SHA,
    acceptedSubjectCommit: request.subjectCommit,
    subjectConfigurationSetSha256: SHA,
    subjectAbsenceSentinelSetSha256: SHA,
    subjectGitClosureSha256: SHA,
    environmentValueSetSha256: SHA,
    taskRoot: "/controlled/task-root",
    taskRootDevice: "1",
    taskRootInode: "2",
    fixedRootSetSha256: SHA,
    postInstallBootstrapRehashSha256: SHA,
    dependencyDeclarationRoots: [],
    toolExecutionRoots: [],
    prismaSchemaSha256: SHA,
    generatedClientSetSha256: SHA,
    generatedDmmfSha256: SHA,
    generatedDelegateSetSha256: SHA,
    generatedOutputSetSha256: SHA,
    typescriptDynamicImportSha256: SHA,
    hostileMarkerSetSha256: SHA,
    hostileMarkerExecutionCount: 0,
    prePostToctouSha256: SHA,
    startedAt: "2026-09-03T00:00:00.000Z",
    finishedAt: "2026-09-03T00:00:01.000Z",
    result: "PASS",
    ...overrides,
  };
}

export function buildExactEnvironment(fixtureValue = "/tmp/fixture") {
  return Object.fromEntries(
    EXPECTED_ENVIRONMENT_NAMES.map((name) => [
      name,
      name === "NPM_CONFIG_USERCONFIG"
        ? "/dev/null"
        : name === "CI"
          ? "1"
          : name === "LANG" || name === "LC_ALL"
            ? "C.UTF-8"
            : fixtureValue,
    ]),
  );
}

function toolLayouts() {
  return [
    ["ENV", "bin/env", 0o500],
    ["NODE", "bin/node", 0o500],
    ["GIT", "bin/git", 0o500],
    ["COREPACK_SHIM", "lib/corepack/dist/corepack.js", 0o400],
    ["COREPACK_LIB_COREPACK_CJS", "lib/corepack/dist/lib/corepack.cjs", 0o400],
    ["PNPM_SHIM", "lib/pnpm/9.15.9/bin/pnpm.cjs", 0o400],
    ["PNPM_ENTRYPOINT", "lib/pnpm/9.15.9/dist/pnpm.cjs", 0o400],
  ];
}

export function buildLauncherRuntimeEnvironment() {
  return {
    PATH: `${TOOL_ROOT}/bin`,
    HOME: `${RUNTIME_ROOT}/home`,
    XDG_CONFIG_HOME: `${RUNTIME_ROOT}/xdg-config`,
    XDG_CACHE_HOME: `${RUNTIME_ROOT}/xdg-cache`,
    COREPACK_HOME: `${RUNTIME_ROOT}/corepack-home`,
    PNPM_HOME: `${RUNTIME_ROOT}/pnpm-home`,
    TMPDIR: `${RUNTIME_ROOT}/tmp`,
    NPM_CONFIG_USERCONFIG: "/dev/null",
    CI: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
}

export function buildToolRootFiles(executableClosure = buildClosure()) {
  const closureByRole = Object.fromEntries(
    executableClosure.map((entry) => [entry.role, entry]),
  );
  return toolLayouts().map(([role, relativePath, mode]) => {
    const source = closureByRole[role];
    const destinationExecutablePath = `${TOOL_ROOT}/${relativePath}`;
    return {
      role,
      logicalIdentity: source.logicalIdentity,
      destinationExecutablePath,
      destinationExecutablePathSha256: sha256Of(
        Buffer.from(destinationExecutablePath, "utf8"),
      ),
      mode,
      sha256: source.sha256,
      size: source.size,
      destinationRoot: "TOOL_ROOT",
      destinationPathKind: "REGULAR_FILE",
    };
  });
}

export function buildObservedToolRootFiles(executableClosure = buildClosure()) {
  return buildToolRootFiles(executableClosure).map((file, index) => ({
    ...file,
    device: "2",
    inode: String(index + 21),
    realpathSha256: HEX[index + 3].repeat(64),
  }));
}

export function buildRuntimeRootNames() {
  return [
    "runtime",
    "home",
    "xdg-config",
    "xdg-cache",
    "corepack-home",
    "pnpm-home",
    "tmp",
  ];
}

export function buildRuntimeRootObservations() {
  return buildRuntimeRootNames().map((basename, index) => ({
    basename,
    mode: 0o700,
    device: "3",
    inode: String(index + 31),
    realpathSha256: HEX[index + 4].repeat(64),
  }));
}

export function buildRuntimeRootPlan() {
  return buildRuntimeRootNames().map((basename) => {
    const absolutePath =
      basename === "runtime" ? RUNTIME_ROOT : `${RUNTIME_ROOT}/${basename}`;
    return {
      basename,
      absolutePath,
      mode: 0o700,
      realpathPathSha256: sha256Of(Buffer.from(absolutePath, "utf8")),
    };
  });
}

export function buildLauncherFilePlan() {
  return ["identity-writer-launch", "identity-writer-launch.mjs"].map(
    (basename) => ({
      basename,
      relativePath: basename,
      mode: 0o500,
      realpathPathSha256: sha256Of(
        Buffer.from(`${REQUEST_ROOT}/../launcher/${basename}`, "utf8"),
      ),
      sha256: SHA,
      size: 1,
    }),
  );
}

export async function createLauncherTrustFixture() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "identity-trust-"));
  const launcherRoot = path.join(fixtureRoot, "launcher");
  const toolRoot = path.join(fixtureRoot, "tool-root");
  await Promise.all([
    mkdir(launcherRoot, { mode: 0o700 }),
    mkdir(toolRoot, { recursive: true, mode: 0o700 }),
  ]);
  const runtimeEnvironment = {
    PATH: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/bin",
    HOME: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime/home",
    XDG_CONFIG_HOME:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime/xdg-config",
    XDG_CACHE_HOME:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime/xdg-cache",
    COREPACK_HOME:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime/corepack-home",
    PNPM_HOME:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime/pnpm-home",
    TMPDIR:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime/tmp",
    NPM_CONFIG_USERCONFIG: "/dev/null",
    CI: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
  const runtimeRoots = [
    "runtime",
    "home",
    "xdg-config",
    "xdg-cache",
    "corepack-home",
    "pnpm-home",
    "tmp",
  ].map((basename, index) => ({
    basename,
    mode: 0o700,
    device: "3",
    inode: String(index + 31),
    realpathSha256: HEX[index].repeat(64),
  }));
  const executableClosure = buildClosure(toolRoot).map((entry, index) => {
    const [, relativePath, mode] = toolLayouts()[index];
    const executablePath = path.join(toolRoot, relativePath);
    const bytes = Buffer.from(`file-${index}\n`, "utf8");
    return {
      ...entry,
      executablePath,
      mode,
      sha256: sha256Of(bytes),
      realpathSha256: sha256Of(Buffer.from(executablePath, "utf8")),
    };
  });
  const materializedExecutableClosure = executableClosure.map(
    (entry, index) => {
      const [, relativePath, mode] = toolLayouts()[index];
      const destinationExecutablePath =
        "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/" +
        relativePath;
      return {
        role: entry.role,
        logicalIdentity: entry.logicalIdentity,
        destinationExecutablePath,
        destinationExecutablePathSha256: sha256Of(
          Buffer.from(destinationExecutablePath, "utf8"),
        ),
        mode,
        sha256: entry.sha256,
        size: entry.size,
        destinationRoot: "TOOL_ROOT",
        destinationPathKind: "REGULAR_FILE",
      };
    },
  );
  const toolRootFiles = materializedExecutableClosure.map((entry, index) => ({
    ...entry,
    device: "2",
    inode: String(index + 21),
    realpathSha256: HEX[index + 3].repeat(64),
  }));
  const launcherBytes = canonicalJsonBytes({ source: "launcher" });
  const bootstrapBytes = canonicalJsonBytes({ source: "bootstrap" });
  await Promise.all([
    writeFile(
      path.join(launcherRoot, "identity-writer-launch.mjs"),
      launcherBytes,
      { mode: 0o500 },
    ),
    writeFile(
      path.join(launcherRoot, "identity-writer-bootstrap.mjs"),
      bootstrapBytes,
      { mode: 0o500 },
    ),
    ...executableClosure.map(async (entry, index) => {
      await mkdir(path.dirname(entry.executablePath), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        entry.executablePath,
        Buffer.from(`file-${index}\n`, "utf8"),
        {
          mode: entry.mode,
        },
      );
    }),
  ]);
  const contract = {
    schemaVersion: "organization-identity-launcher-contract/v3",
    rootDirectory:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher",
    requestRoot: REQUEST_ROOT,
    outputRoot: OUTPUT_ROOT,
    toolRoot:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root",
    runtimeRoot:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime",
    rootPolicy: {
      ownerUid: 0,
      ownerGid: 0,
      launcherDirectoryMode: 0o700,
      requestRootMode: 0o700,
      outputRootMode: 0o700,
      runtimeRootMode: 0o700,
      requestRecordMode: 0o600,
      outputRecordMode: 0o600,
      createExclusive: true,
      rejectSymlink: true,
    },
    toolRootPolicy: {
      ownerUid: 0,
      ownerGid: 0,
      directoryMode: 0o700,
      binaryMode: 0o500,
      javascriptMode: 0o400,
      createExclusive: true,
      rejectSymlink: true,
      rejectHardlink: true,
      copyResolvedRegularFilesOnly: true,
    },
    runtimeRootPolicy: {
      ownerUid: 0,
      ownerGid: 0,
      directoryMode: 0o700,
      createExclusive: true,
      rejectSymlink: true,
      rejectHardlink: true,
    },
    approvedPlan: PLAN_ARTIFACT,
    approvedSpec: SPEC_ARTIFACT,
    approvedLauncher: {
      path: "scripts/governance-organization-identity-launcher.mjs",
      commit: COMMIT,
      blobId: "4".repeat(40),
      sha256: sha256Of(launcherBytes),
    },
    launcherFilePlan: [
      "identity-writer-launch",
      "identity-writer-launch.mjs",
    ].map((basename) => ({
      basename,
      relativePath: basename,
      mode: 0o500,
      realpathPathSha256: sha256Of(
        Buffer.from(path.join(launcherRoot, basename), "utf8"),
      ),
      sha256: sha256Of(launcherBytes),
      size: launcherBytes.byteLength,
    })),
    contractFilePlan: {
      basename: "launcher-contract.json",
      relativePath: "launcher-contract.json",
      mode: 0o600,
      realpathPathSha256: sha256Of(
        Buffer.from(path.join(launcherRoot, "launcher-contract.json"), "utf8"),
      ),
      selfDigestExcluded: true,
    },
    materializedExecutableClosure,
    runtimeEnvironment,
    runtimeRootPlan: runtimeRoots.map((entry) => {
      const absolutePath =
        entry.basename === "runtime"
          ? "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime"
          : `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime/${entry.basename}`;
      return {
        basename: entry.basename,
        absolutePath,
        mode: 0o700,
        realpathPathSha256: sha256Of(Buffer.from(absolutePath, "utf8")),
      };
    }),
    commandIds: EXPECTED_COMMAND_IDS,
    ...computeLauncherContractDigests(),
  };
  const contractBytes = canonicalJsonBytes(contract);
  const readback = {
    schemaVersion: "organization-identity-launcher-readback/v2",
    launcherContractSha256: sha256Of(contractBytes),
    launcherMaterializationPacketSha256: SHA_B,
    sourceToolClosureSha256: SHA,
    materializedExecutableClosureSha256: SHA_C,
    launcherFileObservationSetSha256: SHA,
    toolRootObservationSetSha256: SHA_B,
    runtimeRootObservationSetSha256: SHA_C,
    requestRootObservationSha256: SHA,
    outputRootObservationSha256: SHA,
    environmentValueSetSha256: sha256Of(canonicalJsonBytes(runtimeEnvironment)),
    hostileCounterexampleSetSha256: SHA,
    reviewerClass: "INDEPENDENT_ROOT_LAUNCHER_READBACK",
    observedAt: "2026-09-03T00:00:00.000Z",
  };
  const materialization = {
    schemaVersion: "organization-identity-launcher-materialization/v3",
    launcherContractSha256: sha256Of(contractBytes),
    launcherMaterializationPacketSha256:
      readback.launcherMaterializationPacketSha256,
    rootMaterializationRequestSha256: SHA_C,
    authorizationReceiptSha256: "d".repeat(64),
    sourceToolClosureSha256: readback.sourceToolClosureSha256,
    materializedExecutableClosureSha256:
      readback.materializedExecutableClosureSha256,
    ownerUid: 0,
    ownerGid: 0,
    directoryMode: 0o700,
    files: [
      ["identity-writer-launch", 0o500],
      ["identity-writer-launch.mjs", 0o500],
      ["identity-writer-bootstrap.mjs", 0o500],
      ["launcher-contract.json", 0o600],
    ].map(([basename, mode], index) => ({
      basename,
      mode,
      device: "1",
      inode: String(index + 1),
      realpathSha256: HEX[index + 1].repeat(64),
      sha256:
        basename === "identity-writer-bootstrap.mjs"
          ? sha256Of(bootstrapBytes)
          : HEX[index + 2].repeat(64),
      size: 100 + index,
    })),
    toolRoot: { mode: 0o700, device: "1", inode: "12", realpathSha256: SHA_B },
    toolRootFiles,
    runtimeRoots,
    requestRoot: { mode: 0o700, device: "1", inode: "10", realpathSha256: SHA },
    outputRoot: {
      mode: 0o700,
      device: "1",
      inode: "11",
      realpathSha256: SHA_C,
    },
    runtimeEnvironment,
    fourFileFsyncSha256: SHA,
    toolRootFsyncSha256: SHA_B,
    runtimeRootFsyncSha256: SHA_C,
    directoryFsyncSha256: SHA,
    readbackReportSha256: sha256Of(canonicalJsonBytes(readback)),
    environmentValueSetSha256: sha256Of(canonicalJsonBytes(runtimeEnvironment)),
    prePostToctouSha256: SHA,
    materializedAt: "2026-09-03T00:00:01.000Z",
    result: "PASS",
  };
  const review = {
    schemaVersion: "organization-identity-launcher-materialization-review/v3",
    launcherContractSha256: materialization.launcherContractSha256,
    launcherMaterializationPacketSha256:
      readback.launcherMaterializationPacketSha256,
    launcherMaterializationReceiptSha256: sha256Of(
      canonicalJsonBytes(materialization),
    ),
    readbackReportSha256: materialization.readbackReportSha256,
    reportSha256: SHA,
    counterexampleSetSha256: SHA_B,
    reviewerClass: "INDEPENDENT_ROOT_LAUNCHER_REVIEW",
    critical: 0,
    important: 0,
    verdict: "PASS",
  };
  await Promise.all([
    writeFile(
      path.join(launcherRoot, "launcher-contract.json"),
      contractBytes,
      { mode: 0o600 },
    ),
    writeFile(
      path.join(launcherRoot, "launcher-materialization-readback.json"),
      canonicalJsonBytes(readback),
      { mode: 0o600 },
    ),
    writeFile(
      path.join(launcherRoot, "launcher-materialization.json"),
      canonicalJsonBytes(materialization),
      { mode: 0o600 },
    ),
    writeFile(
      path.join(launcherRoot, "launcher-materialization-review.json"),
      canonicalJsonBytes(review),
      { mode: 0o600 },
    ),
  ]);
  return {
    fixtureRoot,
    launcherRoot,
    request: buildValidRequest({
      launcherMaterializationReceiptSha256: sha256Of(
        canonicalJsonBytes(materialization),
      ),
      launcherMaterializationReviewReceiptSha256: sha256Of(
        canonicalJsonBytes(review),
      ),
    }),
  };
}

export async function removeFixtureRoot(root) {
  await rm(root, { recursive: true, force: true });
}
