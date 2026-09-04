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
  const contract = {
    schemaVersion: "organization-identity-launcher-contract/v2",
    rootDirectory:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher",
    requestRoot: REQUEST_ROOT,
    outputRoot: OUTPUT_ROOT,
    rootPolicy: {
      ownerUid: 0,
      ownerGid: 0,
      directoryMode: 0o700,
      requestMode: 0o600,
      outputMode: 0o600,
      createExclusive: true,
      rejectSymlink: true,
    },
    approvedPlan: {
      path: "docs/superpowers/plans/2026-09-01-organization-identity-writer-ban-at-source.md",
      commit: "33ddcee4e6cb31c107b7ffe4fd5b2ba427e927c3",
      blobId: "599cd7f7769e0ad40fc42f8a3ea8d26cf6741a10",
      sha256:
        "7a0aee3b3533373330ae02d4a4db84779411d6624b48d4d7dc10a91a269fabb5",
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
    executableClosure: closure(),
    commandIds: expectedCommandIds,
    ...contractDigests,
  };
  const observed = {
    rootDirectory: { ownerUid: 0, ownerGid: 0, mode: 0o700, symlink: false },
    requestRoot: { ownerUid: 0, ownerGid: 0, mode: 0o700, symlink: false },
    outputRoot: { ownerUid: 0, ownerGid: 0, mode: 0o700, symlink: false },
    approvedPlan: contract.approvedPlan,
    approvedSpec: contract.approvedSpec,
    executableClosure: closure(),
  };
  const verified = verifyLauncherContract(contract, observed);
  assert.equal(verified.status, "PASS", verified.code);
  assert.equal(
    verifyLauncherContract(
      {
        ...contract,
        approvedPlan: {
          ...contract.approvedPlan,
          commit: "e8a2b2aa08ed5933b3228cc5dd24c468d0f417c2",
          blobId: "6e6234913f00c9bf496ccdeb3eb60bad88fc9691",
          sha256:
            "3bd1c56dff6c2f284b5f34a7ee16c8d14ba0a44069abf0c3aa8ab4c47b78555f",
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
    {
      ...observed,
      rootDirectory: { ...observed.rootDirectory, symlink: true },
    },
    { ...observed, approvedSpec: { ...observed.approvedSpec, sha256: SHA } },
  ]) {
    assert.equal(
      verifyLauncherContract(contract, mutation).status,
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
  const environment = Object.fromEntries(
    expectedEnvironmentNames.map((name) => [
      name,
      name === "NPM_CONFIG_USERCONFIG"
        ? "/dev/null"
        : name === "CI"
          ? "1"
          : name === "LANG" || name === "LC_ALL"
            ? "C.UTF-8"
            : `/controlled/${name.toLowerCase()}`,
    ]),
  );
  const wrapper = renderRootWrapper({
    environment,
    nodePath: "/controlled/bin/node",
    launcherPath:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/identity-writer-launch.mjs",
  });
  assert.match(wrapper, /^#!\/bin\/sh\n/);
  assert.match(wrapper, /exec \/usr\/bin\/env -i/);
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
        nodePath: "/controlled/bin/node",
        launcherPath: "/controlled/launcher.mjs",
      }),
    /ENVIRONMENT_NAME_SET_INVALID/,
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
  const readback = {
    schemaVersion: "organization-identity-launcher-readback/v1",
    launcherContractSha256: SHA,
    fourFileObservationSetSha256: SHA,
    requestRootObservationSha256: SHA,
    outputRootObservationSha256: SHA,
    executableClosureObservationSha256: SHA,
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
  const materialization = {
    schemaVersion: "organization-identity-launcher-materialization/v2",
    launcherContractSha256: SHA,
    ownerUid: 0,
    ownerGid: 0,
    directoryMode: 0o700,
    files,
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
    fourFileFsyncSha256: SHA,
    directoryFsyncSha256: SHA,
    readbackReportSha256: readbackSha,
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
    { ...materialization, directoryFsyncSha256: null },
    { ...materialization, ownerUid: 1000 },
    { ...materialization, result: "HOLD" },
  ]) {
    assert.equal(
      validateLauncherMaterializationReceipt(mutation, readback).status,
      "INTEGRITY_ERROR",
    );
  }

  const review = {
    schemaVersion: "organization-identity-launcher-materialization-review/v1",
    launcherContractSha256: SHA,
    launcherMaterializationReceiptSha256: sha(
      canonicalJsonBytes(materialization),
    ),
    readbackReportSha256: readbackSha,
    reportSha256: SHA,
    counterexampleSetSha256: SHA,
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
