import {
  hasExactKeys,
  integrity,
  isGitObjectId,
  isSha256,
  pass,
  validateExactEnvironmentNames,
  validateExternalExecutableClosure,
  validateOutputPath,
  valuesEqual,
} from "./governance-organization-identity-controller-contracts.mjs";

const ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/gitleaks";
const REQUEST_ROOT = `${ROOT}/requests`;
const OUTPUT_ROOT = `${ROOT}/outputs`;
const REQUIRED_ROLES = Object.freeze(["NODE", "GITLEAKS"]);
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
  "controllerSourceBlobId",
  "controllerSourceSha256",
  "executableClosure",
  "requiredRoles",
  "allowedEnvironmentNames",
  "configPath",
  "configBlobId",
  "configSha256",
  "requestSchemaSha256",
  "resultSchemaSha256",
  "credentialIngressAllowed",
];

export function validateGitleaksContract(contract) {
  if (
    !hasExactKeys(contract, CONTRACT_KEYS) ||
    contract.schemaVersion !==
      "organization-identity-gitleaks-controller-contract/v1" ||
    contract.rootDirectory !== ROOT ||
    contract.requestRoot !== REQUEST_ROOT ||
    contract.outputRoot !== OUTPUT_ROOT ||
    !isGitObjectId(contract.controllerSourceBlobId) ||
    !isSha256(contract.controllerSourceSha256) ||
    !valuesEqual(contract.requiredRoles, REQUIRED_ROLES) ||
    validateExternalExecutableClosure(
      contract.executableClosure,
      REQUIRED_ROLES,
    ).status !== "PASS" ||
    validateExactEnvironmentNames(
      contract.allowedEnvironmentNames,
      ALLOWED_ENVIRONMENT_NAMES,
    ).status !== "PASS" ||
    contract.configPath !== ".gitleaks.toml" ||
    !isGitObjectId(contract.configBlobId) ||
    !isSha256(contract.configSha256) ||
    !isSha256(contract.requestSchemaSha256) ||
    !isSha256(contract.resultSchemaSha256) ||
    contract.credentialIngressAllowed !== false
  ) {
    return integrity("GITLEAKS_CONTROLLER_CONTRACT_INVALID");
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
  "subjectCommit",
  "sourceTreeSha256",
  "configBlobId",
  "configSha256",
  "redact",
  "noBanner",
  "outputRecordPath",
];

export function validateGitleaksRequest(request, contract) {
  if (
    validateGitleaksContract(contract).status !== "PASS" ||
    !hasExactKeys(request, REQUEST_KEYS) ||
    request.schemaVersion !==
      "organization-identity-gitleaks-controller-request/v1" ||
    !isSha256(request.requestId) ||
    !isSha256(request.contractSha256) ||
    !isSha256(request.materializationReceiptSha256) ||
    !isSha256(request.controllerReviewReceiptSha256) ||
    !isSha256(request.authorizationReceiptSha256) ||
    !isGitObjectId(request.subjectCommit) ||
    !isSha256(request.sourceTreeSha256) ||
    request.configBlobId !== contract.configBlobId ||
    request.configSha256 !== contract.configSha256 ||
    request.redact !== true ||
    request.noBanner !== true ||
    validateOutputPath(request.outputRecordPath, contract.outputRoot).status !==
      "PASS"
  ) {
    return integrity("GITLEAKS_CONTROLLER_REQUEST_INVALID");
  }
  return pass();
}

export function buildGitleaksInvocation(request, contract) {
  const validated = validateGitleaksRequest(request, contract);
  if (validated.status !== "PASS") return validated;
  return pass({
    executableRole: "GITLEAKS",
    argv: [
      "git",
      "--redact",
      "--no-banner",
      "--config",
      contract.configPath,
      "--log-opts",
      request.subjectCommit,
    ],
  });
}

const RECEIPT_KEYS = [
  "schemaVersion",
  "contractSha256",
  "controllerReviewReceiptSha256",
  "requestId",
  "requestSha256",
  "authorizationReceiptSha256",
  "subjectCommit",
  "sourceTreeSha256",
  "configBlobId",
  "executableClosureSetSha256",
  "findingSetSha256",
  "redactionVerified",
  "result",
];

export function validateGitleaksReceipt(receipt, request) {
  if (
    !hasExactKeys(receipt, RECEIPT_KEYS) ||
    receipt.schemaVersion !==
      "organization-identity-gitleaks-controller-receipt/v1" ||
    receipt.contractSha256 !== request.contractSha256 ||
    receipt.controllerReviewReceiptSha256 !==
      request.controllerReviewReceiptSha256 ||
    receipt.requestId !== request.requestId ||
    receipt.authorizationReceiptSha256 !== request.authorizationReceiptSha256 ||
    receipt.subjectCommit !== request.subjectCommit ||
    receipt.sourceTreeSha256 !== request.sourceTreeSha256 ||
    receipt.configBlobId !== request.configBlobId ||
    !isSha256(receipt.requestSha256) ||
    !isSha256(receipt.executableClosureSetSha256) ||
    !isSha256(receipt.findingSetSha256) ||
    receipt.redactionVerified !== true ||
    receipt.result !== "PASS"
  ) {
    return integrity("GITLEAKS_CONTROLLER_RECEIPT_INVALID");
  }
  return pass();
}
