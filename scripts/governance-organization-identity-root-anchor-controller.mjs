import {
  hasExactKeys,
  integrity,
  isGitObjectId,
  isSha256,
  pass,
  validateExactEnvironmentNames,
  validateExternalExecutableClosure,
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
      "scripts/governance-organization-identity-root-anchor-controller.spec.mjs",
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

const REQUEST_KEYS = [
  "schemaVersion",
  "requestId",
  "contractSha256",
  "materializationReceiptSha256",
  "controllerReviewReceiptSha256",
  "authorizationReceiptSha256",
  "targetPath",
  "targetMode",
  "predecessor",
  "localLauncherEvidenceSha256",
  "bootstrapContractSha256",
  "githubControllerEvidenceSha256",
  "protectedBaseEvidenceSha256",
  "admittedRefreshAcceptanceEvidenceSha256",
  "orderedMergeParents",
  "workflowRunEvidenceSha256",
  "controllerVariableWriteReceiptSha256",
  "canonicalAnchorPayloadSha256",
  "canonicalAnchorPayloadSize",
  "writeReceiptPath",
];

export function validateRootAnchorWriteRequest(
  request,
  contract,
  expected = {},
) {
  if (
    validateRootAnchorContract(contract).status !== "PASS" ||
    !hasExactKeys(request, REQUEST_KEYS) ||
    request.schemaVersion !==
      "organization-identity-root-anchor-write-request/v1" ||
    !isSha256(request.requestId) ||
    !isSha256(request.contractSha256) ||
    !isSha256(request.materializationReceiptSha256) ||
    !isSha256(request.controllerReviewReceiptSha256) ||
    !isSha256(request.authorizationReceiptSha256) ||
    request.targetPath !== ANCHOR_PATH ||
    request.targetMode !== 0o600 ||
    !hasExactKeys(request.predecessor, [
      "mode",
      "sha256",
      "targetMustBeAbsent",
    ]) ||
    request.predecessor.mode !== "GENESIS_ONLY" ||
    request.predecessor.sha256 !== null ||
    request.predecessor.targetMustBeAbsent !== true ||
    !Array.isArray(request.orderedMergeParents) ||
    request.orderedMergeParents.length !== 2 ||
    !request.orderedMergeParents.every(isGitObjectId) ||
    request.orderedMergeParents[0] === request.orderedMergeParents[1] ||
    !Number.isSafeInteger(request.canonicalAnchorPayloadSize) ||
    request.canonicalAnchorPayloadSize <= 0 ||
    request.writeReceiptPath !== WRITE_RECEIPT_PATH
  ) {
    return integrity("ROOT_ANCHOR_REQUEST_INVALID");
  }
  for (const key of [
    "localLauncherEvidenceSha256",
    "bootstrapContractSha256",
    "githubControllerEvidenceSha256",
    "protectedBaseEvidenceSha256",
    "admittedRefreshAcceptanceEvidenceSha256",
    "workflowRunEvidenceSha256",
    "controllerVariableWriteReceiptSha256",
    "canonicalAnchorPayloadSha256",
  ]) {
    if (!isSha256(request[key]))
      return integrity("ROOT_ANCHOR_REQUEST_INVALID");
  }
  if (
    expected.orderedMergeParents !== undefined &&
    !valuesEqual(request.orderedMergeParents, expected.orderedMergeParents)
  ) {
    return integrity("ROOT_ANCHOR_PARENT_ORDER_INVALID");
  }
  if (
    expected.canonicalAnchorPayloadSha256 !== undefined &&
    request.canonicalAnchorPayloadSha256 !==
      expected.canonicalAnchorPayloadSha256
  ) {
    return integrity("ROOT_ANCHOR_CANONICAL_PAYLOAD_INVALID");
  }
  if (
    expected.canonicalAnchorPayloadSize !== undefined &&
    request.canonicalAnchorPayloadSize !== expected.canonicalAnchorPayloadSize
  ) {
    return integrity("ROOT_ANCHOR_CANONICAL_PAYLOAD_INVALID");
  }
  return pass();
}

export function planRootAnchorWrite(request, contract, observation) {
  if (
    validateRootAnchorWriteRequest(request, contract).status !== "PASS" ||
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

const WRITE_RECEIPT_KEYS = [
  "schemaVersion",
  "contractSha256",
  "materializationReceiptSha256",
  "controllerReviewReceiptSha256",
  "requestSha256",
  "authorizationReceiptSha256",
  "targetPath",
  "anchorSha256",
  "anchorSize",
  "ownerUid",
  "ownerGid",
  "mode",
  "device",
  "inode",
  "predecessorSha256",
  "fileFsyncSha256",
  "directoryFsyncSha256",
  "prePostToctouSha256",
  "anchorContainsSelfHash",
  "result",
];

export function validateRootAnchorWriteReceipt(receipt, request) {
  if (
    !hasExactKeys(receipt, WRITE_RECEIPT_KEYS) ||
    receipt.schemaVersion !==
      "organization-identity-root-anchor-write-receipt/v1" ||
    receipt.contractSha256 !== request.contractSha256 ||
    receipt.materializationReceiptSha256 !==
      request.materializationReceiptSha256 ||
    receipt.controllerReviewReceiptSha256 !==
      request.controllerReviewReceiptSha256 ||
    receipt.authorizationReceiptSha256 !== request.authorizationReceiptSha256 ||
    receipt.targetPath !== ANCHOR_PATH ||
    !isSha256(receipt.requestSha256) ||
    !isSha256(receipt.anchorSha256) ||
    receipt.anchorSha256 !== request.canonicalAnchorPayloadSha256 ||
    !Number.isSafeInteger(receipt.anchorSize) ||
    receipt.anchorSize <= 0 ||
    receipt.anchorSize !== request.canonicalAnchorPayloadSize ||
    receipt.ownerUid !== 0 ||
    receipt.ownerGid !== 0 ||
    receipt.mode !== 0o600 ||
    typeof receipt.device !== "string" ||
    receipt.device.length === 0 ||
    typeof receipt.inode !== "string" ||
    receipt.inode.length === 0 ||
    receipt.predecessorSha256 !== null ||
    !isSha256(receipt.fileFsyncSha256) ||
    !isSha256(receipt.directoryFsyncSha256) ||
    !isSha256(receipt.prePostToctouSha256) ||
    receipt.anchorContainsSelfHash !== false ||
    receipt.result !== "PASS"
  ) {
    return integrity("ROOT_ANCHOR_WRITE_RECEIPT_INVALID");
  }
  return pass();
}

const READBACK_KEYS = [
  "schemaVersion",
  "contractSha256",
  "requestSha256",
  "writeReceiptSha256",
  "targetPath",
  "noFollowVerified",
  "ownerUid",
  "ownerGid",
  "mode",
  "device",
  "inode",
  "anchorSha256",
  "anchorSize",
  "canonicalSchemaSha256",
  "inputEvidenceSetSha256",
  "predecessorSha256",
  "anchorContainsSelfHash",
  "prePostToctouSha256",
  "reviewerClass",
  "result",
];

export function validateRootAnchorReadbackReceipt(receipt, writeReceipt) {
  if (
    !hasExactKeys(receipt, READBACK_KEYS) ||
    receipt.schemaVersion !== "organization-identity-root-anchor-readback/v1" ||
    receipt.contractSha256 !== writeReceipt.contractSha256 ||
    receipt.requestSha256 !== writeReceipt.requestSha256 ||
    !isSha256(receipt.writeReceiptSha256) ||
    receipt.targetPath !== writeReceipt.targetPath ||
    receipt.noFollowVerified !== true ||
    receipt.ownerUid !== writeReceipt.ownerUid ||
    receipt.ownerGid !== writeReceipt.ownerGid ||
    receipt.mode !== writeReceipt.mode ||
    receipt.device !== writeReceipt.device ||
    receipt.inode !== writeReceipt.inode ||
    receipt.anchorSha256 !== writeReceipt.anchorSha256 ||
    receipt.anchorSize !== writeReceipt.anchorSize ||
    !isSha256(receipt.canonicalSchemaSha256) ||
    !isSha256(receipt.inputEvidenceSetSha256) ||
    receipt.predecessorSha256 !== null ||
    receipt.anchorContainsSelfHash !== false ||
    !isSha256(receipt.prePostToctouSha256) ||
    receipt.reviewerClass !== "INDEPENDENT_ROOT_ANCHOR_READBACK" ||
    receipt.result !== "PASS"
  ) {
    return integrity("ROOT_ANCHOR_READBACK_INVALID");
  }
  return pass();
}

const REVIEW_KEYS = [
  "schemaVersion",
  "controllerContractSha256",
  "controllerMaterializationReceiptSha256",
  "controllerReviewReceiptSha256",
  "writeRequestSha256",
  "writeReceiptSha256",
  "readbackReceiptSha256",
  "anchorSha256",
  "reportSha256",
  "counterexampleSetSha256",
  "reviewerClass",
  "critical",
  "important",
  "verdict",
];

export function validateRootAnchorOperationReviewReceipt(receipt) {
  if (
    !hasExactKeys(receipt, REVIEW_KEYS) ||
    receipt.schemaVersion !==
      "organization-identity-root-anchor-operation-review/v1" ||
    Object.keys(receipt)
      .filter((key) => key.endsWith("Sha256"))
      .some((key) => !isSha256(receipt[key])) ||
    receipt.writeReceiptSha256 === receipt.readbackReceiptSha256 ||
    receipt.writeReceiptSha256 === receipt.anchorSha256 ||
    receipt.readbackReceiptSha256 === receipt.anchorSha256 ||
    receipt.reviewerClass !== "INDEPENDENT_ROOT_ANCHOR_OPERATION_REVIEW" ||
    receipt.critical !== 0 ||
    receipt.important !== 0 ||
    receipt.verdict !== "PASS"
  ) {
    return integrity("ROOT_ANCHOR_OPERATION_REVIEW_INVALID");
  }
  return pass();
}
