import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALLOWED_ENVIRONMENT_NAMES,
  LOCAL_COMMAND_IDS,
  buildClosedCommandRequest,
  canonicalJsonBytes,
  computeLauncherContractDigests,
  dispatchClosedCommand,
  executeClosedInvocation,
  parseClosedCommandRequest,
  renderRootWrapper,
  runLauncherCli,
  validateBootstrapRunReceipt,
  validateBootstrapRunReceiptSet,
  validateLauncherMaterializationReceipt,
  validateLauncherMaterializationReviewReceipt,
  validateLauncherReadbackReport,
  verifyExecutableClosure,
  verifyControlledFile,
  verifyLauncherContract,
} from "./governance-organization-identity-launcher.mjs";

const launcherModulePath = fileURLToPath(
  new URL("./governance-organization-identity-launcher.mjs", import.meta.url),
);

const SHA = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const COMMIT = "1".repeat(40);
const REQUEST_ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/requests";
const OUTPUT_ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/outputs";
const TOOL_ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root";
const RUNTIME_ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime";

const expectedCommandIds = [
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
];

const expectedEnvironmentNames = [
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
];
const HEX = Object.freeze([
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

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function closure() {
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
    executablePath: `/controlled/bin/${role.toLowerCase()}`,
    realpathSha256: String(index + 1).repeat(64),
    sha256: String(index + 2).repeat(64),
    size: 100 + index,
    mode: 0o500,
  }));
}

function runtimeEnvironment() {
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

function toolRootFiles(executableClosure = closure()) {
  const closureByRole = Object.fromEntries(
    executableClosure.map((entry) => [entry.role, entry]),
  );
  return [
    ["ENV", "bin/env", 0o500],
    ["NODE", "bin/node", 0o500],
    ["GIT", "bin/git", 0o500],
    ["COREPACK_SHIM", "lib/corepack/dist/corepack.js", 0o400],
    ["COREPACK_LIB_COREPACK_CJS", "lib/corepack/dist/lib/corepack.cjs", 0o400],
    ["PNPM_SHIM", "lib/pnpm/9.15.9/bin/pnpm.cjs", 0o400],
    ["PNPM_ENTRYPOINT", "lib/pnpm/9.15.9/dist/pnpm.cjs", 0o400],
  ].map(([role, relativePath, mode], index) => {
    const source = closureByRole[role];
    return {
      role,
      relativePath,
      mode,
      device: "2",
      inode: String(index + 21),
      realpathSha256: HEX[index + 2].repeat(64),
      sha256: HEX[index + 3].repeat(64),
      size: 200 + index,
      sourceExecutablePath: source.executablePath,
      sourceRealpathSha256: source.realpathSha256,
      sourceSha256: source.sha256,
      sourceMode: source.mode,
      sourcePathPolicy: "RESOLVED_REGULAR_FILE_COPY_ONLY",
      destinationPathKind: "REGULAR_FILE",
    };
  });
}

function runtimeRoots() {
  return [
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
    realpathSha256: HEX[index + 4].repeat(64),
  }));
}

function validRequest(overrides = {}) {
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

function parse(request, options = {}) {
  return parseClosedCommandRequest(canonicalJsonBytes(request), {
    requestRoot: REQUEST_ROOT,
    outputRoot: OUTPUT_ROOT,
    ...options,
  });
}

test("verifies the complete executable closure and rejects omissions, extras, relative paths, or inode drift", () => {
  const entries = closure();
  assert.deepEqual(verifyExecutableClosure(entries, entries), {
    status: "PASS",
    executableClosureSetSha256: sha(`${canonical(entries)}\n`),
  });
  for (const candidate of [
    entries.slice(0, -1),
    [...entries, { ...entries[0], role: "GH" }],
    entries.map((entry, index) =>
      index === 1 ? { ...entry, executablePath: "node" } : entry,
    ),
    entries.map((entry, index) =>
      index === 1 ? { ...entry, sha256: SHA_C } : entry,
    ),
  ]) {
    assert.equal(
      verifyExecutableClosure(entries, candidate).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("verifies the immutable launcher trust roots and permission matrix", () => {
  const contractDigests = computeLauncherContractDigests();
  const executableClosure = closure();
  const contract = {
    schemaVersion: "organization-identity-launcher-contract/v2",
    rootDirectory:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher",
    requestRoot: REQUEST_ROOT,
    outputRoot: OUTPUT_ROOT,
    toolRoot: TOOL_ROOT,
    runtimeRoot: RUNTIME_ROOT,
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
    approvedPlan: {
      path: "docs/superpowers/plans/2026-09-01-organization-identity-writer-ban-at-source.md",
      commit: "9d52a27e611b99329b8eb5fc80b27cc6f5a3ae63",
      blobId: "d2c0d7a75f4bdf8f76edb90c7ba20653f455fc43",
      sha256:
        "3fe4aeb5a11e5ab08b9f4040cfdf1242c6d211c346e5bb9b6038890e4d0a2dbe",
    },
    approvedSpec: {
      path: "docs/superpowers/specs/2026-09-01-organization-identity-writer-ban-at-source-design.md",
      commit: "b060c5dd4afef9fe42dfe510b02f930f56cdf7fe",
      blobId: "98891bcab636b852e71919b7de77343647917017",
      sha256:
        "536e376a40d9ef4f49a65bc0224b74d58eb8a2d743fa766aa020397e67279dd4",
    },
    approvedLauncher: {
      path: "scripts/governance-organization-identity-launcher.mjs",
      commit: COMMIT,
      blobId: "4".repeat(40),
      sha256: SHA,
    },
    approvedBootstrap: {
      path: "scripts/governance-organization-identity-bootstrap.mjs",
      commit: COMMIT,
      blobId: "5".repeat(40),
      sha256: SHA_B,
    },
    executableClosure,
    toolRootFiles: toolRootFiles(executableClosure),
    runtimeEnvironment: runtimeEnvironment(),
    runtimeRoots: runtimeRoots(),
    commandIds: expectedCommandIds,
    ...contractDigests,
  };
  const observed = {
    rootDirectory: { ownerUid: 0, ownerGid: 0, mode: 0o700, symlink: false },
    requestRoot: { ownerUid: 0, ownerGid: 0, mode: 0o700, symlink: false },
    outputRoot: { ownerUid: 0, ownerGid: 0, mode: 0o700, symlink: false },
    toolRoot: { ownerUid: 0, ownerGid: 0, mode: 0o700, symlink: false },
    runtimeRoot: { ownerUid: 0, ownerGid: 0, mode: 0o700, symlink: false },
    approvedPlan: contract.approvedPlan,
    approvedSpec: contract.approvedSpec,
    executableClosure,
  };
  const verified = verifyLauncherContract(contract, observed);
  assert.equal(verified.status, "PASS", verified.code);
  assert.equal(
    verifyLauncherContract(
      {
        ...contract,
        approvedPlan: {
          ...contract.approvedPlan,
          commit: "9228673d8bd7277c3132ac461cb7d9e41666782f",
          blobId: "481430567129f74f489c694c73b6e298503d15b5",
          sha256:
            "ee653539f745a06dbc379b74425792513a348e3f541f48e8e6eae7cd43db5718",
        },
      },
      observed,
    ).status,
    "INTEGRITY_ERROR",
  );
  assert.equal(
    verifyLauncherContract(
      {
        ...contract,
        approvedPlan: {
          ...contract.approvedPlan,
          blobId: "6e6234913f00c9bf496ccdeb3eb60bad88fc9691",
        },
      },
      observed,
    ).status,
    "INTEGRITY_ERROR",
  );
  assert.equal(
    verifyLauncherContract(
      { ...contract, commandRegistrySha256: SHA },
      observed,
    ).status,
    "INTEGRITY_ERROR",
  );
  for (const mutation of [
    { ...observed, requestRoot: { ...observed.requestRoot, mode: 0o755 } },
    { ...observed, outputRoot: { ...observed.outputRoot, ownerUid: 1000 } },
    { ...observed, toolRoot: { ...observed.toolRoot, symlink: true } },
    {
      ...observed,
      rootDirectory: { ...observed.rootDirectory, symlink: true },
    },
    { ...observed, approvedSpec: { ...observed.approvedSpec, sha256: SHA } },
    {
      ...contract,
      runtimeEnvironment: {
        ...contract.runtimeEnvironment,
        PATH: "/usr/bin:/bin",
      },
    },
    {
      ...contract,
      toolRootFiles: contract.toolRootFiles.slice(0, -1),
    },
    {
      ...contract,
      runtimeRoots: [...contract.runtimeRoots].reverse(),
    },
  ]) {
    assert.equal(
      verifyLauncherContract(
        mutation.runtimeEnvironment ? mutation : contract,
        mutation.runtimeEnvironment ? observed : mutation,
      ).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("controlled-file preflight rejects symlinks, hardlinks, broad modes, and inode replacement", async (t) => {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "identity-launcher-"),
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const bytes = canonicalJsonBytes({ fixture: "safe" });
  const expectedSha256 = sha(bytes);
  const safePath = path.join(fixtureRoot, "safe.json");
  await writeFile(safePath, bytes, { mode: 0o600 });
  await chmod(safePath, 0o600);
  const identity = {
    expectedSha256,
    expectedMode: 0o600,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
  };
  assert.equal((await verifyControlledFile(safePath, identity)).status, "PASS");

  const symlinkPath = path.join(fixtureRoot, "link.json");
  await symlink(safePath, symlinkPath);
  assert.equal(
    (await verifyControlledFile(symlinkPath, identity)).status,
    "INTEGRITY_ERROR",
  );

  const hardlinkPath = path.join(fixtureRoot, "hard.json");
  await link(safePath, hardlinkPath);
  assert.equal(
    (await verifyControlledFile(safePath, identity)).code,
    "CONTROLLED_FILE_LINK_INVALID",
  );
  await rm(hardlinkPath);
  await chmod(safePath, 0o644);
  assert.equal(
    (await verifyControlledFile(safePath, identity)).code,
    "CONTROLLED_FILE_PERMISSION_INVALID",
  );
  await chmod(safePath, 0o600);

  assert.equal(
    (
      await verifyControlledFile(safePath, identity, {
        afterRead: async () => {
          const replacement = path.join(fixtureRoot, "replacement.json");
          await writeFile(replacement, bytes, { mode: 0o600 });
          await rm(safePath);
          await import("node:fs/promises").then(({ rename }) =>
            rename(replacement, safePath),
          );
        },
      })
    ).code,
    "CONTROLLED_FILE_TOCTOU",
  );
});

test("renders a wrapper that accepts one absolute request and clears inherited Node loaders", () => {
  const environment = runtimeEnvironment();
  const wrapper = renderRootWrapper({
    envPath: `${TOOL_ROOT}/bin/env`,
    environment,
    nodePath: `${TOOL_ROOT}/bin/node`,
    launcherPath:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/identity-writer-launch.mjs",
  });
  assert.match(wrapper, /^#!\/bin\/sh\n/);
  assert.match(wrapper, new RegExp(`exec ${TOOL_ROOT}/bin/env -i`));
  assert.match(wrapper, new RegExp(`PATH=${TOOL_ROOT}/bin`));
  assert.match(wrapper, /NPM_CONFIG_USERCONFIG=\/dev\/null/);
  assert.match(wrapper, /--request "\$2"/);
  assert.equal(wrapper.includes("NODE_OPTIONS"), false);
  assert.equal(wrapper.includes("NODE_PATH"), false);
  for (const forbidden of ["eval", "`", "$(", " jq ", "source ", "PATH=node"]) {
    assert.equal(wrapper.includes(forbidden), false);
  }
  assert.throws(
    () =>
      renderRootWrapper({
        environment: { ...environment, NODE_OPTIONS: "--require=/tmp/hostile" },
        envPath: `${TOOL_ROOT}/bin/env`,
        nodePath: `${TOOL_ROOT}/bin/node`,
        launcherPath: "/controlled/launcher.mjs",
      }),
    /ENVIRONMENT_NAME_SET_INVALID/,
  );
  assert.throws(
    () =>
      renderRootWrapper({
        environment: { ...environment, PATH: "/usr/bin:/bin" },
        envPath: `${TOOL_ROOT}/bin/env`,
        nodePath: `${TOOL_ROOT}/bin/node`,
        launcherPath:
          "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/identity-writer-launch.mjs",
      }),
    /WRAPPER_VALUE_INVALID/,
  );
});

function bootstrapReceipt(overrides = {}, request = validRequest()) {
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
    closedCommandRequestSha256: sha(canonicalJsonBytes(request)),
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

test("validates one-command bootstrap receipts and rejects receipt reuse", () => {
  const request = validRequest();
  const receipt = bootstrapReceipt();
  assert.equal(validateBootstrapRunReceipt(receipt, request).status, "PASS");
  assert.equal(validateBootstrapRunReceipt(receipt).status, "INTEGRITY_ERROR");
  assert.equal(
    validateBootstrapRunReceipt(
      { ...receipt, hostileMarkerExecutionCount: 1 },
      request,
    ).status,
    "INTEGRITY_ERROR",
  );
  assert.equal(
    validateBootstrapRunReceipt(
      { ...receipt, commandId: "API_VERIFY_V1" },
      request,
    ).status,
    "INTEGRITY_ERROR",
  );

  const entry = {
    requestId: receipt.requestId,
    commandId: receipt.commandId,
    requestSha256: receipt.closedCommandRequestSha256,
    receiptSha256: sha(canonicalJsonBytes(receipt)),
  };
  const receiptSet = {
    schemaVersion: "organization-identity-bootstrap-run-set/v1",
    taskId: "2",
    subjectCommit: COMMIT,
    receiptCount: 1,
    receipts: [entry],
    receiptSetSha256: sha(canonicalJsonBytes([entry])),
  };
  assert.equal(
    validateBootstrapRunReceiptSet(receiptSet, [{ request, receipt }]).status,
    "PASS",
  );
  assert.equal(
    validateBootstrapRunReceiptSet(receiptSet).status,
    "INTEGRITY_ERROR",
  );
  const reused = {
    ...receiptSet,
    receiptCount: 2,
    receipts: [entry, entry],
    receiptSetSha256: sha(canonicalJsonBytes([entry, entry])),
  };
  assert.deepEqual(
    validateBootstrapRunReceiptSet(reused, [
      { request, receipt },
      { request, receipt },
    ]),
    {
      status: "INTEGRITY_ERROR",
      code: "BOOTSTRAP_RECEIPT_REPLAY",
    },
  );
});

test("validates the one-way four-file launcher materialization receipt chain", () => {
  const environmentValueSetSha256 = sha(
    canonicalJsonBytes(runtimeEnvironment()),
  );
  const readback = {
    schemaVersion: "organization-identity-launcher-readback/v1",
    launcherContractSha256: SHA,
    fourFileObservationSetSha256: SHA,
    toolRootObservationSetSha256: SHA_B,
    runtimeRootObservationSetSha256: SHA_C,
    requestRootObservationSha256: SHA,
    outputRootObservationSha256: SHA,
    executableClosureObservationSha256: SHA,
    environmentValueSetSha256,
    hostileCounterexampleSetSha256: SHA,
    reviewerClass: "INDEPENDENT_ROOT_LAUNCHER_READBACK",
    observedAt: "2026-09-03T00:00:00.000Z",
  };
  const readbackSha = sha(canonicalJsonBytes(readback));
  assert.equal(validateLauncherReadbackReport(readback).status, "PASS");
  assert.equal(
    validateLauncherReadbackReport({ ...readback, extraPath: "/tmp/other" })
      .status,
    "INTEGRITY_ERROR",
  );

  const files = [
    ["identity-writer-launch", 0o500],
    ["identity-writer-launch.mjs", 0o500],
    ["identity-writer-bootstrap.mjs", 0o500],
    ["launcher-contract.json", 0o600],
  ].map(([basename, mode], index) => ({
    basename,
    mode,
    device: "1",
    inode: String(index + 1),
    realpathSha256: String(index + 1).repeat(64),
    sha256: String(index + 2).repeat(64),
    size: 100 + index,
  }));
  const toolFiles = toolRootFiles();
  const materialization = {
    schemaVersion: "organization-identity-launcher-materialization/v2",
    launcherContractSha256: SHA,
    ownerUid: 0,
    ownerGid: 0,
    directoryMode: 0o700,
    files,
    toolRoot: {
      mode: 0o700,
      device: "1",
      inode: "12",
      realpathSha256: SHA_B,
    },
    toolRootFiles: toolFiles,
    runtimeRoots: runtimeRoots(),
    requestRoot: {
      mode: 0o700,
      device: "1",
      inode: "10",
      realpathSha256: SHA,
    },
    outputRoot: {
      mode: 0o700,
      device: "1",
      inode: "11",
      realpathSha256: SHA,
    },
    runtimeEnvironment: runtimeEnvironment(),
    fourFileFsyncSha256: SHA,
    toolRootFsyncSha256: SHA_B,
    runtimeRootFsyncSha256: SHA_C,
    directoryFsyncSha256: SHA,
    readbackReportSha256: readbackSha,
    environmentValueSetSha256,
    prePostToctouSha256: SHA,
    materializedAt: "2026-09-03T00:00:01.000Z",
    result: "PASS",
  };
  assert.equal(
    validateLauncherMaterializationReceipt(materialization, readback).status,
    "PASS",
  );
  assert.equal(
    validateLauncherMaterializationReceipt(materialization).status,
    "INTEGRITY_ERROR",
  );
  for (const mutation of [
    { ...materialization, files: [...files].reverse() },
    {
      ...materialization,
      files: files.map((file, index) =>
        index === 0 ? { ...file, mode: 0o755 } : file,
      ),
    },
    { ...materialization, toolRootFiles: toolFiles.slice(0, -1) },
    { ...materialization, runtimeRoots: runtimeRoots().slice(1) },
    {
      ...materialization,
      runtimeEnvironment: {
        ...materialization.runtimeEnvironment,
        COREPACK_HOME: `${RUNTIME_ROOT}/cache/corepack`,
      },
    },
    { ...materialization, directoryFsyncSha256: null },
    { ...materialization, toolRootFsyncSha256: null },
    { ...materialization, ownerUid: 1000 },
    { ...materialization, result: "HOLD" },
  ]) {
    assert.equal(
      validateLauncherMaterializationReceipt(mutation, readback).status,
      "INTEGRITY_ERROR",
    );
  }

  const review = {
    schemaVersion: "organization-identity-launcher-materialization-review/v2",
    launcherContractSha256: SHA,
    launcherMaterializationReceiptSha256: sha(
      canonicalJsonBytes(materialization),
    ),
    readbackReportSha256: readbackSha,
    reportSha256: SHA,
    counterexampleSetSha256: SHA_B,
    reviewerClass: "INDEPENDENT_ROOT_LAUNCHER_REVIEW",
    critical: 0,
    important: 0,
    verdict: "PASS",
  };
  assert.equal(
    validateLauncherMaterializationReviewReceipt(
      review,
      materialization,
      readback,
    ).status,
    "PASS",
  );
  assert.equal(
    validateLauncherMaterializationReviewReceipt(review).status,
    "INTEGRITY_ERROR",
  );
  for (const mutation of [
    {
      ...review,
      launcherMaterializationReceiptSha256: review.readbackReportSha256,
    },
    { ...review, readbackReportSha256: review.reportSha256 },
    { ...review, critical: 1 },
    { ...review, important: 1 },
    { ...review, reviewerClass: "LOCAL_LAUNCHER" },
    { ...review, materializationReceipt: materialization },
  ]) {
    assert.equal(
      validateLauncherMaterializationReviewReceipt(
        mutation,
        materialization,
        readback,
      ).status,
      "INTEGRITY_ERROR",
    );
  }
});
