import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import {
  COMMIT,
  EXPECTED_COMMAND_IDS as expectedCommandIds,
  OUTPUT_ROOT,
  REQUEST_ROOT,
  RUNTIME_ROOT,
  SHA,
  SHA_B,
  SHA_C,
  TOOL_ROOT,
  buildBootstrapReceipt as bootstrapReceipt,
  buildClosure as closure,
  buildLauncherFilePlan as launcherFilePlan,
  buildLauncherRuntimeEnvironment as runtimeEnvironment,
  buildObservedToolRootFiles as observedToolRootFiles,
  buildRuntimeRootObservations as runtimeRoots,
  buildRuntimeRootPlan as runtimeRootPlan,
  buildToolRootFiles as toolRootFiles,
  buildValidRequest as validRequest,
  canonicalJson as canonical,
  sha256Of as sha,
} from "./governance-organization-identity-test-fixtures.mjs";

const launcherModulePath = fileURLToPath(
  new URL("./governance-organization-identity-launcher.mjs", import.meta.url),
);

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
    executableClosureSetSha256: sha(
      Buffer.from(`${canonical(entries)}\n`, "utf8"),
    ),
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
    schemaVersion: "organization-identity-launcher-contract/v3",
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
      commit: "0a6d0a3362dd927bc3c4893b2228488328cbcf95",
      blobId: "bc27bcd728bffa8ddfedf8a264b4687a0dc128b7",
      sha256:
        "6a1712d635f028b406ff00d84b88ea4ad749d004a4d946478a8b0d508df7bfcd",
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
    launcherFilePlan: launcherFilePlan(),
    contractFilePlan: {
      basename: "launcher-contract.json",
      relativePath: "launcher-contract.json",
      mode: 0o600,
      realpathPathSha256: SHA,
      selfDigestExcluded: true,
    },
    materializedExecutableClosure: toolRootFiles(executableClosure),
    runtimeEnvironment: runtimeEnvironment(),
    runtimeRootPlan: runtimeRootPlan(),
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
    materializedExecutableClosure: contract.materializedExecutableClosure,
  };
  const verified = verifyLauncherContract(contract, observed);
  assert.equal(verified.status, "PASS", verified.code);
  assert.equal(
    verifyLauncherContract(
      {
        ...contract,
        approvedPlan: {
          ...contract.approvedPlan,
          commit: "9d52a27e611b99329b8eb5fc80b27cc6f5a3ae63",
          blobId: "d2c0d7a75f4bdf8f76edb90c7ba20653f455fc43",
          sha256:
            "3fe4aeb5a11e5ab08b9f4040cfdf1242c6d211c346e5bb9b6038890e4d0a2dbe",
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
        approvedBootstrap: {
          path: "scripts/governance-organization-identity-bootstrap.mjs",
          commit: COMMIT,
          blobId: "5".repeat(40),
          sha256: SHA_B,
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
      materializedExecutableClosure:
        contract.materializedExecutableClosure.slice(0, -1),
    },
    {
      ...contract,
      runtimeRootPlan: [...contract.runtimeRootPlan].reverse(),
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
  const sourceToolClosureSha256 = SHA_B;
  const materializedExecutableClosureSha256 = SHA_C;
  const readback = {
    schemaVersion: "organization-identity-launcher-readback/v2",
    launcherContractSha256: SHA,
    launcherMaterializationPacketSha256: SHA_B,
    sourceToolClosureSha256,
    materializedExecutableClosureSha256,
    launcherFileObservationSetSha256: SHA,
    toolRootObservationSetSha256: SHA_B,
    runtimeRootObservationSetSha256: SHA_C,
    requestRootObservationSha256: SHA,
    outputRootObservationSha256: SHA,
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
  const toolFiles = observedToolRootFiles();
  const materialization = {
    schemaVersion: "organization-identity-launcher-materialization/v3",
    launcherContractSha256: SHA,
    launcherMaterializationPacketSha256: SHA_B,
    rootMaterializationRequestSha256: SHA_C,
    authorizationReceiptSha256: "d".repeat(64),
    sourceToolClosureSha256,
    materializedExecutableClosureSha256,
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
    schemaVersion: "organization-identity-launcher-materialization-review/v3",
    launcherContractSha256: SHA,
    launcherMaterializationPacketSha256: SHA_B,
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
