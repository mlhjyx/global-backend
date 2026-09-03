import {
  hasExactKeys,
  integrity,
  isGitObjectId,
  isSha256,
  pass,
  validateCredentialHandleBinding,
  validateExactEnvironmentNames,
  validateExternalExecutableClosure,
  validateOutputPath,
  valuesEqual,
} from "./governance-organization-identity-controller-contracts.mjs";

const ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/disposable-postgres";
const REQUEST_ROOT = `${ROOT}/requests`;
const OUTPUT_ROOT = `${ROOT}/outputs`;
const REQUIRED_ROLES = Object.freeze([
  "NODE",
  "DOCKER",
  "PSQL",
  "COREPACK_SHIM",
  "COREPACK_LIB_COREPACK_CJS",
  "PNPM_SHIM",
  "PNPM_ENTRYPOINT",
  "PRISMA_CLI",
]);
const ALLOWED_ENVIRONMENT_NAMES = Object.freeze([
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "TMPDIR",
  "DOCKER_HOST_HANDLE",
  "POSTGRES_CREDENTIAL_HANDLE",
  "CI",
  "LANG",
  "LC_ALL",
]);
const OPERATIONS = Object.freeze(["0M_COMPATIBILITY", "B6_MIXED_FLEET"]);

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
  "allowedOperations",
  "topologySchemaSha256",
  "resourceLabelSchemaSha256",
  "imageDigestSchemaSha256",
  "timeAndSpaceCapSchemaSha256",
  "syntheticCredentialHandleSchemaSha256",
  "migrationInputSchemaSha256",
  "cleanupProofSchemaSha256",
  "loopbackOnly",
  "noEgress",
  "retainedResourceAllowed",
];

export function validateDisposablePostgresContract(contract) {
  if (
    !hasExactKeys(contract, CONTRACT_KEYS) ||
    contract.schemaVersion !==
      "organization-identity-disposable-postgres-controller-contract/v1" ||
    contract.rootDirectory !== ROOT ||
    contract.requestRoot !== REQUEST_ROOT ||
    contract.outputRoot !== OUTPUT_ROOT ||
    !isGitObjectId(contract.controllerSourceBlobId) ||
    !isSha256(contract.controllerSourceSha256) ||
    !valuesEqual(contract.requiredRoles, REQUIRED_ROLES) ||
    !valuesEqual(contract.allowedOperations, OPERATIONS) ||
    validateExactEnvironmentNames(
      contract.allowedEnvironmentNames,
      ALLOWED_ENVIRONMENT_NAMES,
    ).status !== "PASS" ||
    validateExternalExecutableClosure(
      contract.executableClosure,
      REQUIRED_ROLES,
    ).status !== "PASS" ||
    contract.loopbackOnly !== true ||
    contract.noEgress !== true ||
    contract.retainedResourceAllowed !== false
  ) {
    return integrity("DISPOSABLE_POSTGRES_CONTRACT_INVALID");
  }
  for (const key of [
    "topologySchemaSha256",
    "resourceLabelSchemaSha256",
    "imageDigestSchemaSha256",
    "timeAndSpaceCapSchemaSha256",
    "syntheticCredentialHandleSchemaSha256",
    "migrationInputSchemaSha256",
    "cleanupProofSchemaSha256",
  ]) {
    if (!isSha256(contract[key])) {
      return integrity("DISPOSABLE_POSTGRES_CONTRACT_INVALID");
    }
  }
  return pass();
}

const REQUEST_KEYS = [
  "schemaVersion",
  "requestId",
  "operation",
  "contractSha256",
  "materializationReceiptSha256",
  "controllerReviewReceiptSha256",
  "authorizationReceiptSha256",
  "syntheticCredentialHandle",
  "imageDigest",
  "topologySha256",
  "resourceLabelSetSha256",
  "timeAndSpaceCapSha256",
  "migrationInputSetSha256",
  "scenarioSetSha256",
  "cleanupPlanSha256",
  "outputRecordPath",
];

export function validateDisposablePostgresRequest(request, contract) {
  if (
    validateDisposablePostgresContract(contract).status !== "PASS" ||
    !hasExactKeys(request, REQUEST_KEYS) ||
    request.schemaVersion !==
      "organization-identity-disposable-postgres-controller-request/v1" ||
    !OPERATIONS.includes(request.operation) ||
    !isSha256(request.requestId) ||
    !isSha256(request.contractSha256) ||
    !isSha256(request.materializationReceiptSha256) ||
    !isSha256(request.controllerReviewReceiptSha256) ||
    !isSha256(request.authorizationReceiptSha256) ||
    validateCredentialHandleBinding(request.syntheticCredentialHandle)
      .status !== "PASS" ||
    typeof request.imageDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(request.imageDigest) ||
    !isSha256(request.topologySha256) ||
    !isSha256(request.resourceLabelSetSha256) ||
    !isSha256(request.timeAndSpaceCapSha256) ||
    !isSha256(request.migrationInputSetSha256) ||
    !isSha256(request.scenarioSetSha256) ||
    !isSha256(request.cleanupPlanSha256) ||
    validateOutputPath(request.outputRecordPath, contract.outputRoot).status !==
      "PASS"
  ) {
    return integrity("DISPOSABLE_POSTGRES_REQUEST_INVALID");
  }
  return pass();
}

export function buildDisposablePostgresInvocation(request, contract) {
  const validated = validateDisposablePostgresRequest(request, contract);
  if (validated.status !== "PASS") return validated;
  const scenarioOperation =
    request.operation === "0M_COMPATIBILITY"
      ? "RUN_0M_COMPATIBILITY"
      : "RUN_B6_MIXED_FLEET";
  return pass({
    executableRoles: REQUIRED_ROLES,
    operationPlan: [
      "CREATE_NO_EGRESS_LOOPBACK_RESOURCE",
      scenarioOperation,
      "PROVE_CLEANUP",
    ],
  });
}

const RECEIPT_KEYS = [
  "schemaVersion",
  "contractSha256",
  "controllerReviewReceiptSha256",
  "operation",
  "requestId",
  "requestSha256",
  "authorizationReceiptSha256",
  "imageDigest",
  "topologySha256",
  "resourceSetSha256",
  "migrationInputSetSha256",
  "syntheticCredentialHandleSha256",
  "scenarioResultSetSha256",
  "cleanupProofSha256",
  "executableClosureSetSha256",
  "prePostToctouSha256",
  "containsCredentialValue",
  "retainedResources",
  "result",
];

export function validateDisposablePostgresReceipt(receipt, request) {
  if (
    !hasExactKeys(receipt, RECEIPT_KEYS) ||
    receipt.schemaVersion !==
      "organization-identity-disposable-postgres-controller-receipt/v1" ||
    receipt.contractSha256 !== request.contractSha256 ||
    receipt.controllerReviewReceiptSha256 !==
      request.controllerReviewReceiptSha256 ||
    receipt.operation !== request.operation ||
    receipt.requestId !== request.requestId ||
    receipt.authorizationReceiptSha256 !== request.authorizationReceiptSha256 ||
    receipt.imageDigest !== request.imageDigest ||
    receipt.topologySha256 !== request.topologySha256 ||
    receipt.migrationInputSetSha256 !== request.migrationInputSetSha256 ||
    receipt.syntheticCredentialHandleSha256 !==
      request.syntheticCredentialHandle.handleSha256 ||
    receipt.containsCredentialValue !== false ||
    receipt.retainedResources !== 0 ||
    receipt.result !== "PASS"
  ) {
    return integrity("DISPOSABLE_POSTGRES_RECEIPT_INVALID");
  }
  for (const key of [
    "requestSha256",
    "resourceSetSha256",
    "scenarioResultSetSha256",
    "cleanupProofSha256",
    "executableClosureSetSha256",
    "prePostToctouSha256",
  ]) {
    if (!isSha256(receipt[key])) {
      return integrity("DISPOSABLE_POSTGRES_RECEIPT_INVALID");
    }
  }
  return pass();
}
