import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  materializeRootAnchor,
  planRootAnchorWrite,
  readbackRootAnchor,
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

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

function canonicalBytes(value) {
  return Buffer.from(`${canonical(value)}\n`);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

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

function upstreamEvidence() {
  const controllerContract = contract();
  const materializationReceipt = {
    schemaVersion:
      "organization-identity-external-controller-materialization/v1",
    controllerClass: "ROOT_ANCHOR",
    contractSha256: digest(canonicalBytes(controllerContract)),
    controllerSourceSha256: controllerContract.controllerSource.sha256,
    rootDirectorySha256: SHA,
    requestRootSha256: SHA,
    outputRootSha256: SHA,
    ownerUid: 0,
    ownerGid: 0,
    directoryMode: 0o700,
    controllerMode: 0o500,
    recordMode: 0o600,
    executableClosureSetSha256: digest(
      canonicalBytes(controllerContract.executableClosure),
    ),
    environmentSchemaSha256: SHA,
    prePostToctouSha256: SHA,
    result: "PASS",
  };
  const controllerReviewReceipt = {
    schemaVersion: "organization-identity-controller-review/v1",
    controllerClass: "ROOT_ANCHOR",
    contractSha256: materializationReceipt.contractSha256,
    materializationReceiptSha256: digest(
      canonicalBytes(materializationReceipt),
    ),
    requestSchemaSha256: SHA,
    reportSha256: SHA,
    counterexampleSetSha256: SHA,
    reviewerClass: "INDEPENDENT_CONTROLLER_SECURITY_REVIEW",
    critical: 0,
    important: 0,
    verdict: "PASS",
  };
  return {
    materializationReceipt,
    controllerReviewReceipt,
    authorizationReceipt: {
      controllerClass: "ROOT_ANCHOR",
      requestId: SHA,
      operation: "ROOT_ANCHOR_WRITE",
      scope: "EXACT_REQUEST_ONLY",
    },
    localLauncherEvidence: {
      schemaVersion: "organization-identity-launcher-materialization-review/v1",
      launcherContractSha256: SHA,
      launcherMaterializationReceiptSha256: SHA,
      readbackReportSha256: SHA,
      reportSha256: SHA,
      counterexampleSetSha256: SHA,
      reviewerClass: "INDEPENDENT_ROOT_LAUNCHER_REVIEW",
      critical: 0,
      important: 0,
      verdict: "PASS",
    },
    bootstrapContract: {
      schemaVersion: "organization-identity-bootstrap-contract/v2",
      launcherContractSha256: SHA,
      bootstrapSchemaSha256: SHA,
      closedRequestSchemaSha256: SHA,
      effectivePnpmArgvRuleSha256: SHA,
      receiptComparatorSha256: SHA,
      toolLogicalExpectations: [],
      allowedEnvironmentNames: [],
    },
    githubControllerEvidence: {
      schemaVersion: "organization-identity-github-controller-receipt/v1",
      contractSha256: SHA,
      controllerReviewReceiptSha256: SHA,
      operation: "PR_READBACK",
      requestId: SHA,
      requestSha256: SHA,
      payloadSchemaSha256: SHA,
      payloadSha256: SHA,
      authorizationReceiptSha256: SHA,
      repository: "mlhjyx/global-backend",
      resultSchemaSha256: SHA,
      resultSha256: SHA,
      executableClosureSetSha256: SHA,
      prePostToctouSha256: SHA,
      containsCredentialValue: false,
      result: "PASS",
    },
    protectedBaseEvidence: {
      schemaVersion: "organization-identity-protected-base-launcher-receipt/v1",
      contractSha256: SHA,
      contractReviewReceiptSha256: SHA,
      workflowBlobId: "3".repeat(40),
      protectedBaseCommit: "4".repeat(40),
      event: "push",
      repository: "mlhjyx/global-backend",
      ref: "refs/heads/main",
      runId: 1,
      runAttempt: 1,
      runnerOs: "linux",
      runnerArchitecture: "x64",
      runnerUid: 0,
      materializedTaskRootSha256: SHA,
      materializedSourceBlobSetSha256: SHA,
      executableClosureSetSha256: SHA,
      toolLogicalIdentitySetSha256: SHA,
      eventInputSha256: SHA,
      controllerVariableSetSha256: SHA,
      requestSetSha256: SHA,
      outputReceiptSetSha256: SHA,
      prePostToctouSha256: SHA,
      prBytesExecuted: false,
      result: "PASS",
    },
    admittedRefreshAcceptanceEvidence: {
      schemaVersion: "organization-identity-writer-acceptance/v1",
      refreshBaseCommit: "5".repeat(40),
      refreshMergeCommit: "6".repeat(40),
      currentMainAdmissionCommit: "7".repeat(40),
      reviewedImplementationCommit: "8".repeat(40),
      stageMapSha256: SHA,
    },
    workflowRunEvidence: {
      schemaVersion: "organization-identity-workflow-run-evidence/v1",
      workflowPath: ".github/workflows/organization-identity-writer-anchor.yml",
      event: "push",
      ref: "refs/heads/main",
      headSha: "9".repeat(40),
      runId: 1,
      runAttempt: 1,
      conclusion: "success",
      result: "PASS",
    },
    controllerVariableWriteReceipt: {
      schemaVersion: "organization-identity-github-controller-receipt/v1",
      contractSha256: SHA,
      controllerReviewReceiptSha256: SHA,
      operation: "CONTROLLER_VARIABLES_WRITE",
      requestId: SHA,
      requestSha256: SHA,
      payloadSchemaSha256: SHA,
      payloadSha256: SHA,
      authorizationReceiptSha256: SHA,
      repository: "mlhjyx/global-backend",
      resultSchemaSha256: SHA,
      resultSha256: SHA,
      executableClosureSetSha256: SHA,
      prePostToctouSha256: SHA,
      containsCredentialValue: false,
      result: "PASS",
    },
  };
}

function request(overrides = {}) {
  const result = {
    schemaVersion: "organization-identity-root-anchor-write-request/v1",
    requestId: SHA,
    contractSha256: digest(canonicalBytes(contract())),
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
  const evidence = upstreamEvidence();
  const bindings = {
    materializationReceiptSha256: "materializationReceipt",
    controllerReviewReceiptSha256: "controllerReviewReceipt",
    authorizationReceiptSha256: "authorizationReceipt",
    localLauncherEvidenceSha256: "localLauncherEvidence",
    bootstrapContractSha256: "bootstrapContract",
    githubControllerEvidenceSha256: "githubControllerEvidence",
    protectedBaseEvidenceSha256: "protectedBaseEvidence",
    admittedRefreshAcceptanceEvidenceSha256:
      "admittedRefreshAcceptanceEvidence",
    workflowRunEvidenceSha256: "workflowRunEvidence",
    controllerVariableWriteReceiptSha256: "controllerVariableWriteReceipt",
  };
  for (const [field, record] of Object.entries(bindings)) {
    if (!(field in overrides))
      result[field] = digest(canonicalBytes(evidence[record]));
  }
  return result;
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
    validateRootAnchorWriteRequest(
      request(),
      contract(),
      expected,
      upstreamEvidence(),
    ).status,
    "PASS",
  );
  for (const mutation of [
    { contractSha256: SHA },
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
      validateRootAnchorWriteRequest(
        request(mutation),
        contract(),
        expected,
        upstreamEvidence(),
      ).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("root-anchor rejects shallow upstream authority surrogates", () => {
  const valid = request();
  const expected = {
    orderedMergeParents: valid.orderedMergeParents,
    canonicalAnchorPayloadSha256: valid.canonicalAnchorPayloadSha256,
    canonicalAnchorPayloadSize: valid.canonicalAnchorPayloadSize,
  };
  const evidence = upstreamEvidence();
  for (const recordKey of [
    "localLauncherEvidence",
    "bootstrapContract",
    "githubControllerEvidence",
    "protectedBaseEvidence",
    "admittedRefreshAcceptanceEvidence",
    "workflowRunEvidence",
    "controllerVariableWriteReceipt",
  ]) {
    const shallow = {
      ...evidence,
      [recordKey]: { schemaVersion: evidence[recordKey].schemaVersion },
    };
    assert.equal(
      validateRootAnchorWriteRequest(valid, contract(), expected, shallow)
        .status,
      "INTEGRITY_ERROR",
      recordKey,
    );
  }
});

test("root-anchor planner holds before any write on pre-existing, linked, nonregular, or inode-swapped targets", () => {
  const expected = {
    orderedMergeParents: ["1".repeat(40), "2".repeat(40)],
    canonicalAnchorPayloadSha256: "b".repeat(64),
    canonicalAnchorPayloadSize: 42,
  };
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
    assert.deepEqual(
      planRootAnchorWrite(
        request(),
        contract(),
        observation,
        expected,
        upstreamEvidence(),
      ),
      {
        status: "ROOT_ANCHOR_WRITE_HOLD",
        code: "ROOT_ANCHOR_TARGET_INVALID",
      },
    );
  }
  assert.deepEqual(
    planRootAnchorWrite(
      request(),
      contract(),
      {
        targetExists: false,
        targetKind: "absent",
        hardlinkCount: 0,
        inodeStable: true,
        ownerUid: 0,
        ownerGid: 0,
        directoryMode: 0o700,
      },
      expected,
      upstreamEvidence(),
    ),
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

test("root-anchor controller writes and reads back a canonical anchor in a bounded fixture", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "identity-anchor-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await chmod(fixtureRoot, 0o700);
  const outputRoot = path.join(fixtureRoot, "outputs");
  await mkdir(outputRoot, { mode: 0o700 });
  const targetPath = path.join(fixtureRoot, "protected-main-anchor.json");
  const writeReceiptPath = path.join(outputRoot, "write.json");
  const readbackReceiptPath = path.join(outputRoot, "readback.json");
  const payload = {
    schemaVersion: "organization-identity-protected-main-anchor/v1",
    acceptedCommit: "3".repeat(40),
    orderedMergeParents: ["1".repeat(40), "2".repeat(40)],
    predecessorSha256: null,
  };
  const payloadBytes = canonicalBytes(payload);
  const writeRequest = request({
    canonicalAnchorPayloadSha256: digest(payloadBytes),
    canonicalAnchorPayloadSize: payloadBytes.length,
  });
  const expected = {
    orderedMergeParents: writeRequest.orderedMergeParents,
    canonicalAnchorPayloadSha256: writeRequest.canonicalAnchorPayloadSha256,
    canonicalAnchorPayloadSize: writeRequest.canonicalAnchorPayloadSize,
  };
  const written = await materializeRootAnchor({
    request: writeRequest,
    contract: contract(),
    expected,
    upstreamEvidence: upstreamEvidence(),
    payloadBytes,
    fixture: {
      rootDirectory: fixtureRoot,
      outputRoot,
      targetPath,
      writeReceiptPath,
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
    },
  });
  assert.equal(written.status, "PASS");
  assert.deepEqual(await readFile(targetPath), payloadBytes);
  assert.equal(
    JSON.parse(await readFile(writeReceiptPath, "utf8")).anchorSha256,
    digest(payloadBytes),
  );
  const readback = await readbackRootAnchor({
    request: writeRequest,
    contract: contract(),
    writeReceipt: written.writeReceipt,
    fixture: {
      rootDirectory: fixtureRoot,
      outputRoot,
      targetPath,
      readbackReceiptPath,
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
    },
  });
  assert.equal(readback.status, "PASS");
  assert.equal(
    JSON.parse(await readFile(readbackReceiptPath, "utf8")).anchorSha256,
    digest(payloadBytes),
  );
  assert.equal(
    (
      await materializeRootAnchor({
        request: writeRequest,
        contract: contract(),
        expected,
        upstreamEvidence: upstreamEvidence(),
        payloadBytes,
        fixture: {
          rootDirectory: fixtureRoot,
          outputRoot,
          targetPath,
          writeReceiptPath: path.join(outputRoot, "second-write.json"),
          expectedUid: process.getuid(),
          expectedGid: process.getgid(),
        },
      })
    ).status,
    "ROOT_ANCHOR_WRITE_HOLD",
  );
});

test("root-anchor fixture refuses symlink targets and broader parent mode", async (t) => {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "identity-anchor-hostile-"),
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const payloadBytes = canonicalBytes({ safe: true });
  const writeRequest = request({
    canonicalAnchorPayloadSha256: digest(payloadBytes),
    canonicalAnchorPayloadSize: payloadBytes.length,
  });
  const expected = {
    orderedMergeParents: writeRequest.orderedMergeParents,
    canonicalAnchorPayloadSha256: writeRequest.canonicalAnchorPayloadSha256,
    canonicalAnchorPayloadSize: writeRequest.canonicalAnchorPayloadSize,
  };
  const targetPath = path.join(fixtureRoot, "anchor.json");
  const outside = path.join(fixtureRoot, "outside.json");
  await writeFile(outside, "outside");
  await symlink(outside, targetPath);
  const base = {
    request: writeRequest,
    contract: contract(),
    expected,
    upstreamEvidence: upstreamEvidence(),
    payloadBytes,
    fixture: {
      rootDirectory: fixtureRoot,
      outputRoot: fixtureRoot,
      targetPath,
      writeReceiptPath: path.join(fixtureRoot, "write.json"),
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
    },
  };
  assert.equal(
    (await materializeRootAnchor(base)).status,
    "ROOT_ANCHOR_WRITE_HOLD",
  );
  await rm(targetPath);
  await chmod(fixtureRoot, 0o755);
  assert.equal(
    (await materializeRootAnchor(base)).status,
    "ROOT_ANCHOR_WRITE_HOLD",
  );
});

test("root-anchor fixture confines write and readback receipts beneath its verified output root", async (t) => {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "identity-anchor-confine-"),
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await chmod(fixtureRoot, 0o700);
  const outputRoot = path.join(fixtureRoot, "outputs");
  await mkdir(outputRoot, { mode: 0o700 });
  const payloadBytes = canonicalBytes({ fixture: "confined" });
  const writeRequest = request({
    canonicalAnchorPayloadSha256: digest(payloadBytes),
    canonicalAnchorPayloadSize: payloadBytes.length,
  });
  const expected = {
    orderedMergeParents: writeRequest.orderedMergeParents,
    canonicalAnchorPayloadSha256: writeRequest.canonicalAnchorPayloadSha256,
    canonicalAnchorPayloadSize: writeRequest.canonicalAnchorPayloadSize,
  };
  const escaped = path.join(
    os.tmpdir(),
    `escaped-${writeRequest.requestId}.json`,
  );
  t.after(() => rm(escaped, { force: true }));
  const result = await materializeRootAnchor({
    request: writeRequest,
    contract: contract(),
    expected,
    upstreamEvidence: upstreamEvidence(),
    payloadBytes,
    fixture: {
      rootDirectory: fixtureRoot,
      outputRoot,
      targetPath: path.join(fixtureRoot, "anchor.json"),
      writeReceiptPath: escaped,
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
    },
  });
  assert.equal(result.status, "ROOT_ANCHOR_WRITE_HOLD");
  await assert.rejects(readFile(escaped));

  const outside = await mkdtemp(
    path.join(os.tmpdir(), "identity-anchor-outside-"),
  );
  t.after(() => rm(outside, { recursive: true, force: true }));
  const linkedOutput = path.join(fixtureRoot, "linked-output");
  await symlink(outside, linkedOutput);
  const linked = await materializeRootAnchor({
    request: writeRequest,
    contract: contract(),
    expected,
    upstreamEvidence: upstreamEvidence(),
    payloadBytes,
    fixture: {
      rootDirectory: fixtureRoot,
      outputRoot: linkedOutput,
      targetPath: path.join(fixtureRoot, "second-anchor.json"),
      writeReceiptPath: path.join(linkedOutput, "write.json"),
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
    },
  });
  assert.equal(linked.status, "ROOT_ANCHOR_WRITE_HOLD");
  await assert.rejects(readFile(path.join(outside, "write.json")));
});

function writeReceipt(overrides = {}) {
  const writeRequest = request();
  return {
    schemaVersion: "organization-identity-root-anchor-write-receipt/v1",
    contractSha256: writeRequest.contractSha256,
    materializationReceiptSha256: writeRequest.materializationReceiptSha256,
    controllerReviewReceiptSha256: writeRequest.controllerReviewReceiptSha256,
    requestSha256: digest(canonicalBytes(writeRequest)),
    authorizationReceiptSha256: writeRequest.authorizationReceiptSha256,
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
    { ...written, requestSha256: SHA },
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
    contractSha256: written.contractSha256,
    requestSha256: written.requestSha256,
    writeReceiptSha256: digest(canonicalBytes(written)),
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
  const validatedReadback = validateRootAnchorReadbackReceipt(
    readback,
    written,
  );
  assert.equal(validatedReadback.status, "PASS", validatedReadback.code);
  for (const mutation of [
    { ...readback, writeReceiptSha256: SHA },
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
  const writeRequest = request();
  const written = writeReceipt();
  const readback = {
    schemaVersion: "organization-identity-root-anchor-readback/v1",
    contractSha256: written.contractSha256,
    requestSha256: written.requestSha256,
    writeReceiptSha256: digest(canonicalBytes(written)),
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
  const receipt = {
    schemaVersion: "organization-identity-root-anchor-operation-review/v1",
    controllerContractSha256: SHA,
    controllerMaterializationReceiptSha256: SHA,
    controllerReviewReceiptSha256: SHA,
    writeRequestSha256: digest(canonicalBytes(writeRequest)),
    writeReceiptSha256: digest(canonicalBytes(written)),
    readbackReceiptSha256: digest(canonicalBytes(readback)),
    anchorSha256: written.anchorSha256,
    reportSha256: SHA,
    counterexampleSetSha256: SHA,
    reviewerClass: "INDEPENDENT_ROOT_ANCHOR_OPERATION_REVIEW",
    critical: 0,
    important: 0,
    verdict: "PASS",
  };
  const records = {
    writeRequest,
    writeReceipt: written,
    readbackReceipt: readback,
  };
  assert.equal(
    validateRootAnchorOperationReviewReceipt(receipt, records).status,
    "PASS",
  );
  assert.equal(
    validateRootAnchorOperationReviewReceipt(receipt).status,
    "INTEGRITY_ERROR",
  );
  for (const mutation of [
    { ...receipt, anchorSha256: receipt.writeReceiptSha256 },
    { ...receipt, readbackReceiptSha256: receipt.writeReceiptSha256 },
    { ...receipt, reviewerClass: "LOCAL_LAUNCHER" },
    { ...receipt, important: 1 },
    { ...receipt, verdict: "FAIL" },
  ]) {
    assert.equal(
      validateRootAnchorOperationReviewReceipt(mutation, records).status,
      "INTEGRITY_ERROR",
    );
  }
});
