import assert from "node:assert/strict";
import test from "node:test";

import {
  planRootAnchorWrite,
  validateRootAnchorContract,
  validateRootAnchorOperationReviewReceipt,
  validateRootAnchorReadbackReceipt,
  validateRootAnchorWriteReceipt,
  validateRootAnchorWriteRequest,
} from "./governance-organization-identity-root-anchor-controller.mjs";

const SHA = "a".repeat(64);
const ANCHOR =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json";
const WRITE_RECEIPT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/root-anchor/outputs/root-anchor-write-receipt.json";
const closure = ["ENV", "NODE"].map((role) => ({
  role,
  logicalIdentity: `${role.toLowerCase()}@test`,
  executablePath: `/controlled/${role.toLowerCase()}`,
  realpathSha256: SHA,
  sha256: SHA,
  size: 1,
}));

function contract(overrides = {}) {
  return {
    schemaVersion: "organization-identity-root-anchor-controller-contract/v1",
    rootDirectory:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/root-anchor",
    requestRoot:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/root-anchor/requests",
    outputRoot:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/root-anchor/outputs",
    anchorDirectory:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2",
    anchorPath: ANCHOR,
    controllerSource: {
      path: "scripts/governance-organization-identity-root-anchor-controller.mjs",
      blobId: "1".repeat(40),
      sha256: SHA,
    },
    controllerTest: {
      path: "scripts/governance-organization-identity-root-anchor-controller.spec.mjs",
      blobId: "2".repeat(40),
      sha256: SHA,
    },
    executableClosure: closure,
    requiredRoles: ["ENV", "NODE"],
    allowedEnvironmentNames: ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"],
    environmentValueRuleSha256: SHA,
    anchorSchemaSha256: SHA,
    requestSchemaSha256: SHA,
    writeReceiptSchemaSha256: SHA,
    readbackReceiptSchemaSha256: SHA,
    operationReviewSchemaSha256: SHA,
    canonicalizationRuleSha256: SHA,
    rootPolicy: {
      ownerUid: 0,
      ownerGid: 0,
      directoryMode: 0o700,
      controllerMode: 0o500,
      recordMode: 0o600,
      anchorMode: 0o600,
      noFollow: true,
      createExclusive: true,
      overwriteAllowed: false,
      fileFsyncRequired: true,
      directoryFsyncRequired: true,
    },
    predecessorPolicy: {
      mode: "GENESIS_ONLY",
      requiredPredecessorSha256: null,
      targetMustBeAbsent: true,
    },
    credentialIngressAllowed: false,
    anchorSelfHashFieldAllowed: false,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    schemaVersion: "organization-identity-root-anchor-write-request/v1",
    requestId: SHA,
    contractSha256: SHA,
    materializationReceiptSha256: SHA,
    controllerReviewReceiptSha256: SHA,
    authorizationReceiptSha256: SHA,
    targetPath: ANCHOR,
    targetMode: 0o600,
    predecessor: {
      mode: "GENESIS_ONLY",
      sha256: null,
      targetMustBeAbsent: true,
    },
    localLauncherEvidenceSha256: SHA,
    bootstrapContractSha256: SHA,
    githubControllerEvidenceSha256: SHA,
    protectedBaseEvidenceSha256: SHA,
    admittedRefreshAcceptanceEvidenceSha256: SHA,
    orderedMergeParents: ["1".repeat(40), "2".repeat(40)],
    workflowRunEvidenceSha256: SHA,
    controllerVariableWriteReceiptSha256: SHA,
    canonicalAnchorPayloadSha256: "b".repeat(64),
    canonicalAnchorPayloadSize: 42,
    writeReceiptPath: WRITE_RECEIPT,
    ...overrides,
  };
}

test("root-anchor contract fixes one genesis target and create-exclusive fsync policy", () => {
  assert.equal(validateRootAnchorContract(contract()).status, "PASS");
  for (const mutation of [
    { anchorPath: `${ANCHOR}.other` },
    { requiredRoles: ["NODE"] },
    { rootPolicy: { ...contract().rootPolicy, overwriteAllowed: true } },
    { rootPolicy: { ...contract().rootPolicy, directoryFsyncRequired: false } },
    {
      predecessorPolicy: {
        ...contract().predecessorPolicy,
        targetMustBeAbsent: false,
      },
    },
    { credentialIngressAllowed: true },
    { anchorSelfHashFieldAllowed: true },
  ]) {
    assert.equal(
      validateRootAnchorContract(contract(mutation)).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("root-anchor requests reject extra targets, stale predecessors, missing authorization, and reordered parents", () => {
  const expected = {
    orderedMergeParents: ["1".repeat(40), "2".repeat(40)],
    canonicalAnchorPayloadSha256: "b".repeat(64),
    canonicalAnchorPayloadSize: 42,
  };
  assert.equal(
    validateRootAnchorWriteRequest(request(), contract(), expected).status,
    "PASS",
  );
  for (const mutation of [
    { targetPath: `${ANCHOR}.other` },
    { targetMode: 0o644 },
    { authorizationReceiptSha256: null },
    {
      predecessor: {
        mode: "GENESIS_ONLY",
        sha256: SHA,
        targetMustBeAbsent: true,
      },
    },
    { orderedMergeParents: ["2".repeat(40), "1".repeat(40)] },
    { writeReceiptPath: "/tmp/receipt.json" },
    { extraFile: "/tmp/other" },
  ]) {
    assert.equal(
      validateRootAnchorWriteRequest(request(mutation), contract(), expected)
        .status,
      "INTEGRITY_ERROR",
    );
  }
});

test("root-anchor planner holds before any write on pre-existing, linked, nonregular, or inode-swapped targets", () => {
  const observations = [
    { targetExists: true, targetKind: "file", hardlinkCount: 1 },
    { targetExists: false, targetKind: "symlink", hardlinkCount: 1 },
    { targetExists: false, targetKind: "device", hardlinkCount: 1 },
    { targetExists: false, targetKind: "file", hardlinkCount: 2 },
    {
      targetExists: false,
      targetKind: "absent",
      hardlinkCount: 0,
      inodeStable: false,
    },
  ];
  for (const observation of observations) {
    assert.deepEqual(planRootAnchorWrite(request(), contract(), observation), {
      status: "ROOT_ANCHOR_WRITE_HOLD",
      code: "ROOT_ANCHOR_TARGET_INVALID",
    });
  }
  assert.deepEqual(
    planRootAnchorWrite(request(), contract(), {
      targetExists: false,
      targetKind: "absent",
      hardlinkCount: 0,
      inodeStable: true,
      ownerUid: 0,
      ownerGid: 0,
      directoryMode: 0o700,
    }),
    {
      status: "PASS",
      writeMode: "CREATE_EXCLUSIVE_NOFOLLOW",
      targetPath: ANCHOR,
      fileMode: 0o600,
      fileFsyncRequired: true,
      directoryFsyncRequired: true,
    },
  );
});

function writeReceipt(overrides = {}) {
  return {
    schemaVersion: "organization-identity-root-anchor-write-receipt/v1",
    contractSha256: SHA,
    materializationReceiptSha256: SHA,
    controllerReviewReceiptSha256: SHA,
    requestSha256: SHA,
    authorizationReceiptSha256: SHA,
    targetPath: ANCHOR,
    anchorSha256: "b".repeat(64),
    anchorSize: 42,
    ownerUid: 0,
    ownerGid: 0,
    mode: 0o600,
    device: "1",
    inode: "2",
    predecessorSha256: null,
    fileFsyncSha256: SHA,
    directoryFsyncSha256: SHA,
    prePostToctouSha256: SHA,
    anchorContainsSelfHash: false,
    result: "PASS",
    ...overrides,
  };
}

test("root-anchor write and readback receipts bind fsync, inode, canonical bytes, and no self hash", () => {
  const written = writeReceipt();
  assert.equal(
    validateRootAnchorWriteReceipt(written, request()).status,
    "PASS",
  );
  for (const mutation of [
    { ...written, anchorSha256: "c".repeat(64) },
    { ...written, fileFsyncSha256: null },
    { ...written, directoryFsyncSha256: null },
    { ...written, ownerUid: 1000 },
    { ...written, mode: 0o644 },
    { ...written, anchorContainsSelfHash: true },
    { ...written, predecessorSha256: SHA },
  ]) {
    assert.equal(
      validateRootAnchorWriteReceipt(mutation, request()).status,
      "INTEGRITY_ERROR",
    );
  }

  const readback = {
    schemaVersion: "organization-identity-root-anchor-readback/v1",
    contractSha256: SHA,
    requestSha256: SHA,
    writeReceiptSha256: SHA,
    targetPath: ANCHOR,
    noFollowVerified: true,
    ownerUid: 0,
    ownerGid: 0,
    mode: 0o600,
    device: written.device,
    inode: written.inode,
    anchorSha256: written.anchorSha256,
    anchorSize: written.anchorSize,
    canonicalSchemaSha256: SHA,
    inputEvidenceSetSha256: SHA,
    predecessorSha256: null,
    anchorContainsSelfHash: false,
    prePostToctouSha256: SHA,
    reviewerClass: "INDEPENDENT_ROOT_ANCHOR_READBACK",
    result: "PASS",
  };
  assert.equal(
    validateRootAnchorReadbackReceipt(readback, written).status,
    "PASS",
  );
  for (const mutation of [
    { ...readback, inode: "3" },
    { ...readback, noFollowVerified: false },
    { ...readback, anchorSha256: SHA },
    { ...readback, anchorContainsSelfHash: true },
  ]) {
    assert.equal(
      validateRootAnchorReadbackReceipt(mutation, written).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("root-anchor operation review rejects circular, substituted, or non-independent receipts", () => {
  const receipt = {
    schemaVersion: "organization-identity-root-anchor-operation-review/v1",
    controllerContractSha256: SHA,
    controllerMaterializationReceiptSha256: SHA,
    controllerReviewReceiptSha256: SHA,
    writeRequestSha256: SHA,
    writeReceiptSha256: SHA,
    readbackReceiptSha256: "b".repeat(64),
    anchorSha256: "c".repeat(64),
    reportSha256: SHA,
    counterexampleSetSha256: SHA,
    reviewerClass: "INDEPENDENT_ROOT_ANCHOR_OPERATION_REVIEW",
    critical: 0,
    important: 0,
    verdict: "PASS",
  };
  assert.equal(
    validateRootAnchorOperationReviewReceipt(receipt).status,
    "PASS",
  );
  for (const mutation of [
    { ...receipt, anchorSha256: receipt.writeReceiptSha256 },
    { ...receipt, readbackReceiptSha256: receipt.writeReceiptSha256 },
    { ...receipt, reviewerClass: "LOCAL_LAUNCHER" },
    { ...receipt, important: 1 },
    { ...receipt, verdict: "FAIL" },
  ]) {
    assert.equal(
      validateRootAnchorOperationReviewReceipt(mutation).status,
      "INTEGRITY_ERROR",
    );
  }
});
