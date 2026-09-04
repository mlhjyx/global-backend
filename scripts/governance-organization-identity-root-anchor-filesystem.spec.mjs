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
      path: "scripts/governance-organization-identity-root-anchor-closure.spec.mjs",
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
  const rootAnchorControllerMaterialization = {
    schemaVersion:
      "organization-identity-external-controller-materialization/v2",
    controllerClass: "ROOT_ANCHOR",
    contractSha256: digest(canonicalBytes(controllerContract)),
    controllerSourceClosureSha256: "f".repeat(64),
    result: "PASS",
  };
  const rootAnchorControllerReview = {
    schemaVersion: "organization-identity-controller-review/v2",
    controllerClass: "ROOT_ANCHOR",
    contractSha256: rootAnchorControllerMaterialization.contractSha256,
    materializationReceiptSha256: digest(
      canonicalBytes(rootAnchorControllerMaterialization),
    ),
    controllerSourceClosureSha256:
      rootAnchorControllerMaterialization.controllerSourceClosureSha256,
    critical: 0,
    important: 0,
    verdict: "PASS",
    containsCredentialValue: false,
  };
  return {
    localLauncherReview: {
      schemaVersion: "organization-identity-launcher-materialization-review/v2",
      launcherContractSha256: SHA,
      launcherMaterializationReceiptSha256: SHA,
      launcherMaterializationReviewReceiptSha256: "b".repeat(64),
      readbackReportSha256: SHA,
      reportSha256: SHA,
      counterexampleSetSha256: SHA,
      reviewerClass: "INDEPENDENT_ROOT_LAUNCHER_REVIEW",
      critical: 0,
      important: 0,
      verdict: "PASS",
      containsCredentialValue: false,
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
    githubProtectedMainReadback: {
      schemaVersion: "organization-identity-github-controller-receipt/v2",
      contractSha256: SHA,
      controllerReviewReceiptSha256: "b".repeat(64),
      controllerSourceClosureSha256: "c".repeat(64),
      operation: "PROTECTED_MAIN_READBACK",
      repository: "mlhjyx/global-backend",
      observedHeadSha: "1".repeat(40),
      resultSha256: SHA,
      containsCredentialValue: false,
      result: "PASS",
    },
    githubControllerVariableWrite: {
      schemaVersion: "organization-identity-github-controller-receipt/v2",
      contractSha256: SHA,
      controllerReviewReceiptSha256: "b".repeat(64),
      controllerSourceClosureSha256: "c".repeat(64),
      operation: "CONTROLLER_VARIABLES_WRITE",
      repository: "mlhjyx/global-backend",
      resultSha256: "d".repeat(64),
      containsCredentialValue: false,
      result: "PASS",
    },
    protectedBaseLaunch: {
      schemaVersion: "organization-identity-protected-base-launcher-receipt/v2",
      repository: "mlhjyx/global-backend",
      protectedBaseCommit: "1".repeat(40),
      controllerVariableSetSha256: "d".repeat(64),
      containsCredentialValue: false,
      result: "PASS",
    },
    admittedRefreshAcceptance: {
      schemaVersion: "organization-identity-writer-acceptance/v1",
      currentMainAdmissionCommit: "1".repeat(40),
      reviewedImplementationCommit: "2".repeat(40),
      stageMapSha256: SHA,
      result: "PASS",
    },
    workflowRun: {
      schemaVersion: "organization-identity-workflow-run-evidence/v1",
      repository: "mlhjyx/global-backend",
      workflowPath: ".github/workflows/organization-identity-writer-anchor.yml",
      event: "push",
      ref: "refs/heads/main",
      headSha: "1".repeat(40),
      runId: 1,
      runAttempt: 1,
      conclusion: "success",
      containsCredentialValue: false,
      result: "PASS",
    },
    rootAnchorControllerMaterialization,
    rootAnchorControllerReview,
    rootAnchorAuthorization: {
      controllerClass: "ROOT_ANCHOR",
      requestId: SHA,
      operation: "ROOT_ANCHOR_WRITE",
      scope: "EXACT_REQUEST_ONLY",
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
    materializationReceiptSha256: "rootAnchorControllerMaterialization",
    controllerReviewReceiptSha256: "rootAnchorControllerReview",
    authorizationReceiptSha256: "rootAnchorAuthorization",
    localLauncherEvidenceSha256: "localLauncherReview",
    bootstrapContractSha256: "bootstrapContract",
    githubControllerEvidenceSha256: "githubProtectedMainReadback",
    protectedBaseEvidenceSha256: "protectedBaseLaunch",
    admittedRefreshAcceptanceEvidenceSha256: "admittedRefreshAcceptance",
    workflowRunEvidenceSha256: "workflowRun",
    controllerVariableWriteReceiptSha256: "githubControllerVariableWrite",
  };
  for (const [field, record] of Object.entries(bindings)) {
    if (!(field in overrides))
      result[field] = digest(canonicalBytes(evidence[record]));
  }
  return result;
}

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
