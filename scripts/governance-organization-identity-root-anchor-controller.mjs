import path from "node:path";

import {
  openVerifiedDirectory,
  readbackFile,
  targetAbsent,
  verifyFixtureRoot,
  writeExclusiveCanonical,
} from "./governance-organization-identity-root-anchor-filesystem.mjs";
import {
  canonicalJsonBytes,
  hasExactKeys,
  integrity,
  isGitObjectId,
  isPassivePlainData,
  isSha256,
  pass,
  sha256,
  validateRootAnchorOperationReviewReceiptV2 as validateSharedOperationReview,
  validateExactEnvironmentNames,
  validateExternalExecutableClosure,
  validateRootAnchorReadbackReceiptV2 as validateSharedReadback,
  validateRootAnchorOperationReviewClosureV2,
  validateRootAnchorWriteReceiptV2 as validateSharedWriteReceipt,
  validateRootAnchorWriteRequestV2 as validateSharedWriteRequest,
  validateRootAnchorUpstreamEvidenceClosureV2,
  valuesEqual,
} from "./governance-organization-identity-controller-contracts.mjs";
const ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/root-anchor";
const REQUEST_ROOT = `${ROOT}/requests`;
const OUTPUT_ROOT = `${ROOT}/outputs`;
const ANCHOR_DIRECTORY =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2";
const ANCHOR_PATH = `${ANCHOR_DIRECTORY}/protected-main-anchor.json`;
const WRITE_RECEIPT_PATH = `${OUTPUT_ROOT}/root-anchor-write-receipt.json`;
const REQUIRED_ROLES = Object.freeze(["ENV", "NODE"]);
const ALLOWED_ENVIRONMENT_NAMES = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
]);

const CONTRACT_KEYS = [
  "schemaVersion",
  "rootDirectory",
  "requestRoot",
  "outputRoot",
  "anchorDirectory",
  "anchorPath",
  "controllerSource",
  "controllerTest",
  "executableClosure",
  "requiredRoles",
  "allowedEnvironmentNames",
  "environmentValueRuleSha256",
  "anchorSchemaSha256",
  "requestSchemaSha256",
  "writeReceiptSchemaSha256",
  "readbackReceiptSchemaSha256",
  "operationReviewSchemaSha256",
  "canonicalizationRuleSha256",
  "rootPolicy",
  "predecessorPolicy",
  "credentialIngressAllowed",
  "anchorSelfHashFieldAllowed",
];

function validSource(value, expectedPath) {
  return (
    hasExactKeys(value, ["path", "blobId", "sha256"]) &&
    value.path === expectedPath &&
    isGitObjectId(value.blobId) &&
    isSha256(value.sha256)
  );
}

function validRootPolicy(value) {
  return (
    hasExactKeys(value, [
      "ownerUid",
      "ownerGid",
      "directoryMode",
      "controllerMode",
      "recordMode",
      "anchorMode",
      "noFollow",
      "createExclusive",
      "overwriteAllowed",
      "fileFsyncRequired",
      "directoryFsyncRequired",
    ]) &&
    value.ownerUid === 0 &&
    value.ownerGid === 0 &&
    value.directoryMode === 0o700 &&
    value.controllerMode === 0o500 &&
    value.recordMode === 0o600 &&
    value.anchorMode === 0o600 &&
    value.noFollow === true &&
    value.createExclusive === true &&
    value.overwriteAllowed === false &&
    value.fileFsyncRequired === true &&
    value.directoryFsyncRequired === true
  );
}

function validPredecessorPolicy(value) {
  return (
    hasExactKeys(value, [
      "mode",
      "requiredPredecessorSha256",
      "targetMustBeAbsent",
    ]) &&
    value.mode === "GENESIS_ONLY" &&
    value.requiredPredecessorSha256 === null &&
    value.targetMustBeAbsent === true
  );
}

export function validateRootAnchorContract(contract) {
  if (
    !hasExactKeys(contract, CONTRACT_KEYS) ||
    contract.schemaVersion !==
      "organization-identity-root-anchor-controller-contract/v1" ||
    contract.rootDirectory !== ROOT ||
    contract.requestRoot !== REQUEST_ROOT ||
    contract.outputRoot !== OUTPUT_ROOT ||
    contract.anchorDirectory !== ANCHOR_DIRECTORY ||
    contract.anchorPath !== ANCHOR_PATH ||
    !validSource(
      contract.controllerSource,
      "scripts/governance-organization-identity-root-anchor-controller.mjs",
    ) ||
    !validSource(
      contract.controllerTest,
      "scripts/governance-organization-identity-root-anchor-closure.spec.mjs",
    ) ||
    !valuesEqual(contract.requiredRoles, REQUIRED_ROLES) ||
    validateExternalExecutableClosure(
      contract.executableClosure,
      REQUIRED_ROLES,
    ).status !== "PASS" ||
    validateExactEnvironmentNames(
      contract.allowedEnvironmentNames,
      ALLOWED_ENVIRONMENT_NAMES,
    ).status !== "PASS" ||
    !validRootPolicy(contract.rootPolicy) ||
    !validPredecessorPolicy(contract.predecessorPolicy) ||
    contract.credentialIngressAllowed !== false ||
    contract.anchorSelfHashFieldAllowed !== false
  ) {
    return integrity("ROOT_ANCHOR_CONTRACT_INVALID");
  }
  for (const key of [
    "environmentValueRuleSha256",
    "anchorSchemaSha256",
    "requestSchemaSha256",
    "writeReceiptSchemaSha256",
    "readbackReceiptSchemaSha256",
    "operationReviewSchemaSha256",
    "canonicalizationRuleSha256",
  ]) {
    if (!isSha256(contract[key]))
      return integrity("ROOT_ANCHOR_CONTRACT_INVALID");
  }
  return pass();
}

function validateRootUpstreamEvidence(request, contract, records) {
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
  if (
    validateRootAnchorUpstreamEvidenceClosureV2(records).status !== "PASS" ||
    records.rootAnchorControllerMaterialization.contractSha256 !==
      sha256(canonicalJsonBytes(contract)) ||
    records.rootAnchorControllerReview.contractSha256 !==
      request.contractSha256 ||
    records.rootAnchorAuthorization.requestId !== request.requestId
  ) {
    return integrity("ROOT_ANCHOR_UPSTREAM_EVIDENCE_INVALID");
  }
  for (const [field, recordKey] of Object.entries(bindings)) {
    if (request[field] !== sha256(canonicalJsonBytes(records[recordKey]))) {
      return integrity("ROOT_ANCHOR_UPSTREAM_EVIDENCE_INVALID");
    }
  }
  return pass();
}

export function validateRootAnchorWriteRequest(
  request,
  contract,
  expected,
  upstreamEvidence,
) {
  if (
    !hasExactKeys(expected, [
      "orderedMergeParents",
      "canonicalAnchorPayloadSha256",
      "canonicalAnchorPayloadSize",
    ])
  ) {
    return integrity("ROOT_ANCHOR_EXPECTED_INPUT_REQUIRED");
  }
  if (
    validateRootUpstreamEvidence(request, contract, upstreamEvidence).status !==
    "PASS"
  ) {
    return integrity("ROOT_ANCHOR_UPSTREAM_EVIDENCE_INVALID");
  }
  if (
    validateRootAnchorContract(contract).status !== "PASS" ||
    validateSharedWriteRequest(request).status !== "PASS" ||
    request.contractSha256 !== sha256(canonicalJsonBytes(contract)) ||
    request.writeReceiptPath !== WRITE_RECEIPT_PATH
  ) {
    return integrity("ROOT_ANCHOR_REQUEST_INVALID");
  }
  if (!valuesEqual(request.orderedMergeParents, expected.orderedMergeParents)) {
    return integrity("ROOT_ANCHOR_PARENT_ORDER_INVALID");
  }
  if (
    request.canonicalAnchorPayloadSha256 !==
    expected.canonicalAnchorPayloadSha256
  ) {
    return integrity("ROOT_ANCHOR_CANONICAL_PAYLOAD_INVALID");
  }
  if (
    request.canonicalAnchorPayloadSize !== expected.canonicalAnchorPayloadSize
  ) {
    return integrity("ROOT_ANCHOR_CANONICAL_PAYLOAD_INVALID");
  }
  return pass();
}

export function planRootAnchorWrite(
  request,
  contract,
  observation,
  expected,
  upstreamEvidence,
) {
  if (
    validateRootAnchorWriteRequest(
      request,
      contract,
      expected,
      upstreamEvidence,
    ).status !== "PASS" ||
    !hasExactKeys(observation, [
      "targetExists",
      "targetKind",
      "hardlinkCount",
      "inodeStable",
      "ownerUid",
      "ownerGid",
      "directoryMode",
    ]) ||
    observation.targetExists !== false ||
    observation.targetKind !== "absent" ||
    observation.hardlinkCount !== 0 ||
    observation.inodeStable !== true ||
    observation.ownerUid !== 0 ||
    observation.ownerGid !== 0 ||
    observation.directoryMode !== 0o700
  ) {
    return {
      status: "ROOT_ANCHOR_WRITE_HOLD",
      code: "ROOT_ANCHOR_TARGET_INVALID",
    };
  }
  return {
    status: "PASS",
    writeMode: "CREATE_EXCLUSIVE_NOFOLLOW",
    targetPath: ANCHOR_PATH,
    fileMode: 0o600,
    fileFsyncRequired: true,
    directoryFsyncRequired: true,
  };
}

export async function materializeRootAnchor({
  request,
  contract,
  expected,
  upstreamEvidence,
  payloadBytes,
  fixture,
}) {
  if (!fixture) {
    return {
      status: "ROOT_ANCHOR_WRITE_HOLD",
      code: "PRODUCTION_ROOT_AUTHORIZATION_REQUIRED",
    };
  }
  if (
    validateRootAnchorWriteRequest(
      request,
      contract,
      expected,
      upstreamEvidence,
    ).status !== "PASS" ||
    !Buffer.isBuffer(payloadBytes) ||
    payloadBytes.length !== request.canonicalAnchorPayloadSize ||
    sha256(payloadBytes) !== request.canonicalAnchorPayloadSha256
  ) {
    return integrity("ROOT_ANCHOR_CANONICAL_PAYLOAD_INVALID");
  }
  try {
    const parsed = JSON.parse(payloadBytes.toString("utf8"));
    if (
      !isPassivePlainData(parsed) ||
      !payloadBytes.equals(canonicalJsonBytes(parsed)) ||
      Object.hasOwn(parsed, "anchorSha256") ||
      Object.hasOwn(parsed, "selfSha256")
    ) {
      return integrity("ROOT_ANCHOR_CANONICAL_PAYLOAD_INVALID");
    }
  } catch {
    return integrity("ROOT_ANCHOR_CANONICAL_PAYLOAD_INVALID");
  }
  const root = await verifyFixtureRoot(
    fixture,
    "writeReceiptPath",
    ANCHOR_DIRECTORY,
  );
  if (root.status !== "PASS" || !(await targetAbsent(fixture.targetPath))) {
    return {
      status: "ROOT_ANCHOR_WRITE_HOLD",
      code: "ROOT_ANCHOR_TARGET_INVALID",
    };
  }
  let rootDirectory;
  let outputDirectory;
  try {
    rootDirectory = await openVerifiedDirectory(fixture.rootDirectory, fixture);
    outputDirectory = await openVerifiedDirectory(fixture.outputRoot, fixture);
    const stableTargetPath = path.join(
      rootDirectory.stablePath,
      path.basename(fixture.targetPath),
    );
    const stableWriteReceiptPath = path.join(
      outputDirectory.stablePath,
      path.basename(fixture.writeReceiptPath),
    );
    if (!(await targetAbsent(stableTargetPath))) {
      return {
        status: "ROOT_ANCHOR_WRITE_HOLD",
        code: "ROOT_ANCHOR_TARGET_INVALID",
      };
    }
    const written = await writeExclusiveCanonical(
      stableTargetPath,
      payloadBytes,
      fixture,
    );
    if (written.status !== "PASS") {
      return { status: "ROOT_ANCHOR_WRITE_HOLD", code: written.code };
    }
    await rootDirectory.handle.sync();
    const readback = await readbackFile(
      stableTargetPath,
      {
        sha256: request.canonicalAnchorPayloadSha256,
        size: payloadBytes.length,
      },
      fixture,
      sha256,
    );
    if (readback.status !== "PASS") {
      return { status: "ROOT_ANCHOR_WRITE_HOLD", code: readback.code };
    }
    const writeReceipt = {
      schemaVersion: "organization-identity-root-anchor-write-receipt/v1",
      contractSha256: request.contractSha256,
      materializationReceiptSha256: request.materializationReceiptSha256,
      controllerReviewReceiptSha256: request.controllerReviewReceiptSha256,
      requestSha256: sha256(canonicalJsonBytes(request)),
      authorizationReceiptSha256: request.authorizationReceiptSha256,
      targetPath: ANCHOR_PATH,
      anchorSha256: request.canonicalAnchorPayloadSha256,
      anchorSize: payloadBytes.length,
      ownerUid: 0,
      ownerGid: 0,
      mode: 0o600,
      device: String(readback.stat.dev),
      inode: String(readback.stat.ino),
      predecessorSha256: null,
      fileFsyncSha256: sha256(
        canonicalJsonBytes({ inode: String(readback.stat.ino), synced: true }),
      ),
      directoryFsyncSha256: sha256(
        canonicalJsonBytes({ directory: fixture.rootDirectory, synced: true }),
      ),
      prePostToctouSha256: sha256(
        canonicalJsonBytes({
          device: String(readback.stat.dev),
          inode: String(readback.stat.ino),
        }),
      ),
      anchorContainsSelfHash: false,
      result: "PASS",
    };
    const receiptWrite = await writeExclusiveCanonical(
      stableWriteReceiptPath,
      canonicalJsonBytes(writeReceipt),
      fixture,
    );
    if (receiptWrite.status !== "PASS") {
      return { status: "ROOT_ANCHOR_WRITE_HOLD", code: receiptWrite.code };
    }
    await outputDirectory.handle.sync();
    return pass({ writeReceipt });
  } finally {
    await outputDirectory?.handle.close().catch(() => undefined);
    await rootDirectory?.handle.close().catch(() => undefined);
  }
}

export async function readbackRootAnchor({
  request,
  contract,
  writeReceipt,
  fixture,
}) {
  if (
    !fixture ||
    validateRootAnchorWriteReceipt(writeReceipt, request).status !== "PASS"
  ) {
    return integrity("ROOT_ANCHOR_WRITE_RECEIPT_INVALID");
  }
  const root = await verifyFixtureRoot(
    fixture,
    "readbackReceiptPath",
    ANCHOR_DIRECTORY,
  );
  if (root.status !== "PASS") return root;
  let rootDirectory;
  let outputDirectory;
  try {
    rootDirectory = await openVerifiedDirectory(fixture.rootDirectory, fixture);
    outputDirectory = await openVerifiedDirectory(fixture.outputRoot, fixture);
    const stableTargetPath = path.join(
      rootDirectory.stablePath,
      path.basename(fixture.targetPath),
    );
    const stableReadbackReceiptPath = path.join(
      outputDirectory.stablePath,
      path.basename(fixture.readbackReceiptPath),
    );
    const observed = await readbackFile(
      stableTargetPath,
      { sha256: writeReceipt.anchorSha256, size: writeReceipt.anchorSize },
      fixture,
      sha256,
    );
    if (observed.status !== "PASS") return observed;
    const readbackReceipt = {
      schemaVersion: "organization-identity-root-anchor-readback/v1",
      contractSha256: writeReceipt.contractSha256,
      requestSha256: writeReceipt.requestSha256,
      writeReceiptSha256: sha256(canonicalJsonBytes(writeReceipt)),
      targetPath: ANCHOR_PATH,
      noFollowVerified: true,
      ownerUid: 0,
      ownerGid: 0,
      mode: 0o600,
      device: String(observed.stat.dev),
      inode: String(observed.stat.ino),
      anchorSha256: observed.status === "PASS" ? sha256(observed.bytes) : "",
      anchorSize: observed.bytes.length,
      canonicalSchemaSha256: contract.anchorSchemaSha256,
      inputEvidenceSetSha256: sha256(
        canonicalJsonBytes({
          requestSha256: writeReceipt.requestSha256,
          writeReceiptSha256: sha256(canonicalJsonBytes(writeReceipt)),
        }),
      ),
      predecessorSha256: null,
      anchorContainsSelfHash: false,
      prePostToctouSha256: writeReceipt.prePostToctouSha256,
      reviewerClass: "INDEPENDENT_ROOT_ANCHOR_READBACK",
      result: "PASS",
    };
    const receiptWrite = await writeExclusiveCanonical(
      stableReadbackReceiptPath,
      canonicalJsonBytes(readbackReceipt),
      fixture,
    );
    if (receiptWrite.status !== "PASS") return receiptWrite;
    await outputDirectory.handle.sync();
    return pass({ readbackReceipt });
  } finally {
    await outputDirectory?.handle.close().catch(() => undefined);
    await rootDirectory?.handle.close().catch(() => undefined);
  }
}

export function validateRootAnchorWriteReceipt(receipt, request) {
  return validateSharedWriteReceipt(receipt, request);
}

export function validateRootAnchorReadbackReceipt(receipt, writeReceipt) {
  return validateSharedReadback(receipt, writeReceipt);
}

export function validateRootAnchorOperationReviewReceipt(receipt, records) {
  const scoped = {
    writeRequest: records?.writeRequest,
    writeReceipt: records?.writeReceipt,
    readbackReceipt: records?.readbackReceipt,
  };
  if (validateSharedOperationReview(receipt, scoped).status !== "PASS")
    return integrity("ROOT_ANCHOR_OPERATION_REVIEW_INVALID");
  if (
    records.upstreamEvidence &&
    validateRootAnchorOperationReviewClosureV2({
      ...records,
      operationReviewReceipt: receipt,
    }).status !== "PASS"
  ) {
    return integrity("ROOT_ANCHOR_OPERATION_REVIEW_INVALID");
  }
  return { status: "PASS" };
}
