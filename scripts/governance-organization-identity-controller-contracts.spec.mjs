import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  buildControllerReceiptSetSha256,
  isPassivePlainData,
  validateControllerSourceClosureV1,
  validateCredentialHandleBinding,
  validateExternalExecutableClosure,
  validateRootAnchorOperationReviewClosureV2,
  validateRootAnchorUpstreamEvidenceClosureV2,
  validateVerifiedWorktreeReceiptV1,
} from "./governance-organization-identity-controller-contracts.mjs";

const SHA = "a".repeat(64);
const ANCHOR =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json";

const entry = (role) => ({
  role,
  logicalIdentity: `${role.toLowerCase()}@test`,
  executablePath: `/controlled/${role.toLowerCase()}`,
  realpathSha256: SHA,
  sha256: SHA,
  size: 1,
});

test("passive JSON rejects symbol-keyed and accessor-bearing arrays", () => {
  const withSymbol = [];
  withSymbol[Symbol("hidden")] = true;
  const withAccessor = [];
  Object.defineProperty(withAccessor, "hidden", {
    get() {
      throw new Error("must not run");
    },
  });
  assert.equal(isPassivePlainData(withSymbol), false);
  assert.equal(isPassivePlainData(withAccessor), false);
});

test("each external controller is a self-contained materializable module", async (t) => {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "identity-controller-source-"),
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  for (const helper of [
    "governance-organization-identity-root-anchor-filesystem.mjs",
    "governance-organization-identity-controller-contracts.mjs",
  ]) {
    await copyFile(
      path.join(process.cwd(), "scripts", helper),
      path.join(fixtureRoot, helper),
    );
  }
  for (const basename of [
    "governance-organization-identity-github-controller.mjs",
    "governance-organization-identity-disposable-postgres-controller.mjs",
    "governance-organization-identity-gitleaks-controller.mjs",
    "governance-organization-identity-root-anchor-controller.mjs",
  ]) {
    const source = path.join(process.cwd(), "scripts", basename);
    const isolated = path.join(fixtureRoot, basename);
    await copyFile(source, isolated);
    await assert.doesNotReject(
      import(`${pathToFileURL(isolated).href}?isolated=1`),
    );
  }
});

test("external executable closure requires every exact role and rejects unlisted tools", () => {
  const expected = ["NODE", "GIT", "GH"];
  const observed = expected.map(entry);
  assert.equal(
    validateExternalExecutableClosure(observed, expected).status,
    "PASS",
  );
  for (const mutation of [
    observed.slice(0, -1),
    [...observed, entry("DOCKER")],
    observed.map((value, index) =>
      index === 0 ? { ...value, executablePath: "node" } : value,
    ),
  ]) {
    assert.equal(
      validateExternalExecutableClosure(mutation, expected).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("credential handles are references only and reject durable values", () => {
  const binding = {
    provider: "ROOT_SECRET_STORE",
    handleSha256: SHA,
    scopeSha256: SHA,
    injectedByFileDescriptor: true,
    valuePersisted: false,
    valueEmitted: false,
  };
  assert.equal(validateCredentialHandleBinding(binding).status, "PASS");
  for (const mutation of [
    { ...binding, value: "secret" },
    { ...binding, valuePersisted: true },
    { ...binding, valueEmitted: true },
    { ...binding, injectedByFileDescriptor: false },
  ]) {
    assert.equal(
      validateCredentialHandleBinding(mutation).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("ControllerSourceClosureV1 is exact, class-bound, and digest-bound", () => {
  const closure = {
    schemaVersion: "organization-identity-controller-source-closure/v1",
    controllerClass: "ROOT_ANCHOR",
    primarySourcePath:
      "scripts/governance-organization-identity-root-anchor-controller.mjs",
    primarySourceBlobId: "1".repeat(40),
    primarySourceSha256: SHA,
    sharedSourceEntries: [
      {
        path: "scripts/governance-organization-identity-controller-contracts.mjs",
        blobId: "2".repeat(40),
        sha256: "b".repeat(64),
      },
      {
        path: "scripts/governance-organization-identity-root-anchor-filesystem.mjs",
        blobId: "3".repeat(40),
        sha256: "c".repeat(64),
      },
    ],
    testSourceEntries: [
      {
        path: "scripts/governance-organization-identity-root-anchor-closure.spec.mjs",
        blobId: "4".repeat(40),
        sha256: "d".repeat(64),
      },
      {
        path: "scripts/governance-organization-identity-root-anchor-filesystem.spec.mjs",
        blobId: "5".repeat(40),
        sha256: "e".repeat(64),
      },
    ],
    sourceSetSha256: "",
  };
  closure.sourceSetSha256 = buildControllerReceiptSetSha256([
    {
      path: closure.primarySourcePath,
      blobId: closure.primarySourceBlobId,
      sha256: closure.primarySourceSha256,
    },
    ...closure.sharedSourceEntries,
    ...closure.testSourceEntries,
  ]);
  assert.equal(validateControllerSourceClosureV1(closure).status, "PASS");
  for (const mutation of [
    { ...closure, controllerClass: "GITHUB" },
    { ...closure, primarySourcePath: "/tmp/controller.mjs" },
    { ...closure, sourceSetSha256: SHA },
    { ...closure, credential: "secret" },
    {
      ...closure,
      sharedSourceEntries: closure.sharedSourceEntries.slice(0, 1),
    },
    {
      ...closure,
      testSourceEntries: [...closure.testSourceEntries].reverse(),
    },
    {
      ...closure,
      sharedSourceEntries: [
        { ...closure.sharedSourceEntries[0], extra: "same-shape" },
      ],
    },
  ]) {
    assert.equal(
      validateControllerSourceClosureV1(mutation).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("VerifiedWorktreeReceiptV1 rejects caller-shape, wrong-type, and substitution records", () => {
  const receipt = {
    schemaVersion: "organization-identity-verified-worktree/v1",
    repositoryRoot: "/global/backend",
    worktreePath:
      "/global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v2",
    gitDirRealpathSha256: SHA,
    commonDirRealpathSha256: SHA,
    branch: "codex/pr407-organization-identity-caller-cutover-v2",
    headCommit: "1".repeat(40),
    subjectCommit: "1".repeat(40),
    statusPorcelainSha256: "b".repeat(64),
    worktreeListEntrySha256: "c".repeat(64),
    expectedMode: "GIT_REFRESH_START",
    verifiedByExecutableClosureSha256: "d".repeat(64),
    prePostToctouSha256: "e".repeat(64),
    result: "PASS",
  };
  assert.equal(validateVerifiedWorktreeReceiptV1(receipt).status, "PASS");
  for (const mutation of [
    { path: receipt.worktreePath, subjectCommit: receipt.subjectCommit },
    { ...receipt, branch: "" },
    { ...receipt, subjectCommit: "2".repeat(40) },
    { ...receipt, statusPorcelainSha256: null },
    { ...receipt, result: "CALLER_ASSERTED" },
  ]) {
    assert.equal(
      validateVerifiedWorktreeReceiptV1(mutation).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("root-anchor shared closure rejects cross-record and final review substitutions", () => {
  const upstreamEvidence = {
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
    rootAnchorControllerMaterialization: {
      schemaVersion:
        "organization-identity-external-controller-materialization/v2",
      controllerClass: "ROOT_ANCHOR",
      contractSha256: "e".repeat(64),
      controllerSourceClosureSha256: "f".repeat(64),
      result: "PASS",
    },
    rootAnchorControllerReview: {
      schemaVersion: "organization-identity-controller-review/v2",
      controllerClass: "ROOT_ANCHOR",
      contractSha256: "e".repeat(64),
      materializationReceiptSha256: "a".repeat(64),
      controllerSourceClosureSha256: "f".repeat(64),
      critical: 0,
      important: 0,
      verdict: "PASS",
      containsCredentialValue: false,
    },
    rootAnchorAuthorization: {
      controllerClass: "ROOT_ANCHOR",
      requestId: SHA,
      operation: "ROOT_ANCHOR_WRITE",
      scope: "EXACT_REQUEST_ONLY",
    },
  };
  assert.equal(
    validateRootAnchorUpstreamEvidenceClosureV2(upstreamEvidence).status,
    "PASS",
  );
  assert.equal(
    validateRootAnchorUpstreamEvidenceClosureV2({
      ...upstreamEvidence,
      workflowRun: { ...upstreamEvidence.workflowRun, headSha: "2".repeat(40) },
    }).status,
    "INTEGRITY_ERROR",
  );
  const writeRequest = {
    contractSha256: "e".repeat(64),
    materializationReceiptSha256: "a".repeat(64),
    controllerReviewReceiptSha256: "b".repeat(64),
  };
  const writeReceipt = {
    contractSha256: writeRequest.contractSha256,
    materializationReceiptSha256: writeRequest.materializationReceiptSha256,
  };
  const readbackReceipt = {
    writeReceiptSha256: buildControllerReceiptSetSha256([writeReceipt]),
  };
  const operationReviewReceipt = {
    controllerContractSha256: writeRequest.contractSha256,
    controllerMaterializationReceiptSha256:
      writeRequest.materializationReceiptSha256,
    controllerReviewReceiptSha256: writeRequest.controllerReviewReceiptSha256,
  };
  assert.equal(
    validateRootAnchorOperationReviewClosureV2({
      writeRequest,
      writeReceipt,
      readbackReceipt,
      operationReviewReceipt,
      upstreamEvidence,
    }).status,
    "INTEGRITY_ERROR",
  );
  const fullWriteRequest = {
    schemaVersion: "organization-identity-root-anchor-write-request/v1",
    requestId: SHA,
    contractSha256: "e".repeat(64),
    materializationReceiptSha256: buildControllerReceiptSetSha256(
      upstreamEvidence.rootAnchorControllerMaterialization,
    ),
    controllerReviewReceiptSha256: buildControllerReceiptSetSha256(
      upstreamEvidence.rootAnchorControllerReview,
    ),
    authorizationReceiptSha256: buildControllerReceiptSetSha256(
      upstreamEvidence.rootAnchorAuthorization,
    ),
    targetPath: ANCHOR,
    targetMode: 0o600,
    predecessor: {
      mode: "GENESIS_ONLY",
      sha256: null,
      targetMustBeAbsent: true,
    },
    localLauncherEvidenceSha256: buildControllerReceiptSetSha256(
      upstreamEvidence.localLauncherReview,
    ),
    bootstrapContractSha256: buildControllerReceiptSetSha256(
      upstreamEvidence.bootstrapContract,
    ),
    githubControllerEvidenceSha256: buildControllerReceiptSetSha256(
      upstreamEvidence.githubProtectedMainReadback,
    ),
    protectedBaseEvidenceSha256: buildControllerReceiptSetSha256(
      upstreamEvidence.protectedBaseLaunch,
    ),
    admittedRefreshAcceptanceEvidenceSha256: buildControllerReceiptSetSha256(
      upstreamEvidence.admittedRefreshAcceptance,
    ),
    orderedMergeParents: ["1".repeat(40), "2".repeat(40)],
    workflowRunEvidenceSha256: buildControllerReceiptSetSha256(
      upstreamEvidence.workflowRun,
    ),
    controllerVariableWriteReceiptSha256: buildControllerReceiptSetSha256(
      upstreamEvidence.githubControllerVariableWrite,
    ),
    canonicalAnchorPayloadSha256: "9".repeat(64),
    canonicalAnchorPayloadSize: 42,
    writeReceiptPath:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/root-anchor/outputs/root-anchor-write-receipt.json",
  };
  const fullWriteReceipt = {
    schemaVersion: "organization-identity-root-anchor-write-receipt/v1",
    contractSha256: fullWriteRequest.contractSha256,
    materializationReceiptSha256: fullWriteRequest.materializationReceiptSha256,
    controllerReviewReceiptSha256:
      fullWriteRequest.controllerReviewReceiptSha256,
    requestSha256: buildControllerReceiptSetSha256(fullWriteRequest),
    authorizationReceiptSha256: fullWriteRequest.authorizationReceiptSha256,
    targetPath: ANCHOR,
    anchorSha256: fullWriteRequest.canonicalAnchorPayloadSha256,
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
  };
  const fullReadbackReceipt = {
    schemaVersion: "organization-identity-root-anchor-readback/v1",
    contractSha256: fullWriteReceipt.contractSha256,
    requestSha256: fullWriteReceipt.requestSha256,
    writeReceiptSha256: buildControllerReceiptSetSha256(fullWriteReceipt),
    targetPath: ANCHOR,
    noFollowVerified: true,
    ownerUid: 0,
    ownerGid: 0,
    mode: 0o600,
    device: "1",
    inode: "2",
    anchorSha256: fullWriteReceipt.anchorSha256,
    anchorSize: 42,
    canonicalSchemaSha256: SHA,
    inputEvidenceSetSha256: SHA,
    predecessorSha256: null,
    anchorContainsSelfHash: false,
    prePostToctouSha256: SHA,
    reviewerClass: "INDEPENDENT_ROOT_ANCHOR_READBACK",
    result: "PASS",
  };
  const fullOperationReviewReceipt = {
    schemaVersion: "organization-identity-root-anchor-operation-review/v1",
    controllerContractSha256: fullWriteRequest.contractSha256,
    controllerMaterializationReceiptSha256:
      fullWriteRequest.materializationReceiptSha256,
    controllerReviewReceiptSha256:
      fullWriteRequest.controllerReviewReceiptSha256,
    writeRequestSha256: buildControllerReceiptSetSha256(fullWriteRequest),
    writeReceiptSha256: buildControllerReceiptSetSha256(fullWriteReceipt),
    readbackReceiptSha256: buildControllerReceiptSetSha256(fullReadbackReceipt),
    anchorSha256: fullWriteReceipt.anchorSha256,
    reportSha256: SHA,
    counterexampleSetSha256: SHA,
    reviewerClass: "INDEPENDENT_ROOT_ANCHOR_OPERATION_REVIEW",
    critical: 0,
    important: 0,
    verdict: "PASS",
  };
  assert.equal(
    validateRootAnchorOperationReviewClosureV2({
      writeRequest: fullWriteRequest,
      writeReceipt: fullWriteReceipt,
      readbackReceipt: fullReadbackReceipt,
      operationReviewReceipt: fullOperationReviewReceipt,
      upstreamEvidence,
    }).status,
    "PASS",
  );
  const rebindParents = (orderedMergeParents) => {
    const reboundRequest = { ...fullWriteRequest, orderedMergeParents };
    const reboundWrite = {
      ...fullWriteReceipt,
      requestSha256: buildControllerReceiptSetSha256(reboundRequest),
    };
    const reboundReadback = {
      ...fullReadbackReceipt,
      requestSha256: reboundWrite.requestSha256,
      writeReceiptSha256: buildControllerReceiptSetSha256(reboundWrite),
    };
    const reboundReview = {
      ...fullOperationReviewReceipt,
      writeRequestSha256: buildControllerReceiptSetSha256(reboundRequest),
      writeReceiptSha256: buildControllerReceiptSetSha256(reboundWrite),
      readbackReceiptSha256: buildControllerReceiptSetSha256(reboundReadback),
    };
    return {
      writeRequest: reboundRequest,
      writeReceipt: reboundWrite,
      readbackReceipt: reboundReadback,
      operationReviewReceipt: reboundReview,
      upstreamEvidence,
    };
  };
  for (const wrongParents of [
    ["2".repeat(40), "1".repeat(40)],
    ["3".repeat(40), "2".repeat(40)],
    ["1".repeat(40), "3".repeat(40)],
  ]) {
    assert.equal(
      validateRootAnchorOperationReviewClosureV2(rebindParents(wrongParents))
        .status,
      "INTEGRITY_ERROR",
    );
  }
  assert.equal(
    validateRootAnchorOperationReviewClosureV2({
      writeRequest,
      writeReceipt,
      readbackReceipt,
      operationReviewReceipt: {
        ...operationReviewReceipt,
        controllerContractSha256: SHA,
      },
      upstreamEvidence,
    }).status,
    "INTEGRITY_ERROR",
  );
});

test("exact records reject null, scalar and proxy input without running traps", async () => {
  const { hasExactKeys } =
    await import("./governance-organization-identity-controller-contracts.mjs");
  for (const value of [null, undefined, 1, "x", true, []])
    assert.equal(hasExactKeys(value, []), false);
  let traps = 0;
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        traps++;
        throw Error("private");
      },
      ownKeys() {
        traps++;
        throw Error("private");
      },
    },
  );
  assert.equal(hasExactKeys(proxy, []), false);
  assert.equal(isPassivePlainData({ nested: proxy }), false);
  assert.equal(traps, 0);
});

test("passive controller arrays reject holes and altered prototypes", () => {
  assert.equal(isPassivePlainData(new Array(2)), false);
  assert.equal(isPassivePlainData(Object.setPrototypeOf([], null)), false);
});
