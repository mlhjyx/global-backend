import {
  canonicalJsonBytes,
  hasExactKeys,
  integrity,
  isGitObjectId,
  isSha256,
  pass,
  sha256,
  validateCredentialHandleBinding,
  validateExactEnvironmentNames,
  validateExternalExecutableClosure,
  validateOutputPath,
  valuesEqual,
} from "./governance-organization-identity-controller-contracts.mjs";

export const GITHUB_CONTROLLER_OPERATIONS = Object.freeze([
  "PROTECTED_MAIN_READBACK",
  "FETCH_EXACT_OBJECT",
  "PUSH_EXACT_BRANCH",
  "PR_CREATE",
  "PR_UPDATE_BODY",
  "PR_READBACK",
  "RULES_CHECKS_READBACK",
  "PR_MERGE",
  "COMMIT_BRANCH_PARENT_READBACK",
  "WORKFLOW_RUN_READBACK",
  "WORKFLOW_RERUN",
  "CONTROLLER_VARIABLES_WRITE",
]);

const REQUIRED_ROLES = Object.freeze(["NODE", "GIT", "GH"]);
const ALLOWED_ENVIRONMENT_NAMES = Object.freeze([
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "TMPDIR",
  "GH_HOST",
  "GITHUB_TOKEN_HANDLE",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_TERMINAL_PROMPT",
]);
const ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/github";
const REQUEST_ROOT = `${ROOT}/requests`;
const OUTPUT_ROOT = `${ROOT}/outputs`;
const CONTRACT_KEYS = [
  "schemaVersion",
  "rootDirectory",
  "requestRoot",
  "outputRoot",
  "controllerSourceBlobId",
  "controllerSourceSha256",
  "repository",
  "remote",
  "protectedRef",
  "executableClosure",
  "requiredRoles",
  "allowedEnvironmentNames",
  "credentialHandleSchemaSha256",
  "operationRequestSchemaSha256",
  "operationResultSchemaSha256",
  "noSecretPersistence",
];

export function validateGitHubControllerContract(contract) {
  if (
    !hasExactKeys(contract, CONTRACT_KEYS) ||
    contract.schemaVersion !==
      "organization-identity-github-controller-contract/v1" ||
    contract.rootDirectory !== ROOT ||
    contract.requestRoot !== REQUEST_ROOT ||
    contract.outputRoot !== OUTPUT_ROOT ||
    contract.repository !== "mlhjyx/global-backend" ||
    contract.remote !== "origin" ||
    contract.protectedRef !== "refs/heads/main" ||
    !isGitObjectId(contract.controllerSourceBlobId) ||
    !isSha256(contract.controllerSourceSha256) ||
    !isSha256(contract.credentialHandleSchemaSha256) ||
    contract.noSecretPersistence !== true ||
    !valuesEqual(contract.requiredRoles, REQUIRED_ROLES) ||
    validateExactEnvironmentNames(
      contract.allowedEnvironmentNames,
      ALLOWED_ENVIRONMENT_NAMES,
    ).status !== "PASS" ||
    validateExternalExecutableClosure(
      contract.executableClosure,
      REQUIRED_ROLES,
    ).status !== "PASS"
  ) {
    return integrity("GITHUB_CONTROLLER_CONTRACT_INVALID");
  }
  for (const key of [
    "operationRequestSchemaSha256",
    "operationResultSchemaSha256",
  ]) {
    const record = contract[key];
    if (
      !hasExactKeys(record, GITHUB_CONTROLLER_OPERATIONS) ||
      GITHUB_CONTROLLER_OPERATIONS.some(
        (operation) => !isSha256(record[operation]),
      )
    ) {
      return integrity("GITHUB_CONTROLLER_CONTRACT_INVALID");
    }
  }
  return pass();
}

function exactPayload(payload, keys, predicates) {
  return (
    hasExactKeys(payload, keys) &&
    Object.entries(predicates).every(([key, predicate]) =>
      predicate(payload[key]),
    )
  );
}

const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const branch = (value) =>
  value === "codex/pr407-organization-identity-caller-cutover-v2";
const operationPayloadValid = {
  PROTECTED_MAIN_READBACK: (payload) =>
    exactPayload(payload, ["repository", "ref"], {
      repository: (value) => value === "mlhjyx/global-backend",
      ref: (value) => value === "refs/heads/main",
    }),
  FETCH_EXACT_OBJECT: (payload) =>
    exactPayload(payload, ["remote", "ref", "objectSha", "flags"], {
      remote: (value) => value === "origin",
      ref: (value) => value === "refs/heads/main",
      objectSha: isGitObjectId,
      flags: (value) =>
        valuesEqual(value, [
          "--no-tags",
          "--no-write-fetch-head",
          "--no-auto-maintenance",
          "--no-write-commit-graph",
        ]),
    }),
  PUSH_EXACT_BRANCH: (payload) =>
    exactPayload(payload, ["branch", "expectedHead", "setUpstream", "force"], {
      branch,
      expectedHead: isGitObjectId,
      setUpstream: (value) => value === true,
      force: (value) => value === false,
    }),
  PR_CREATE: (payload) =>
    exactPayload(payload, ["base", "head", "title", "bodySha256"], {
      base: (value) => value === "main",
      head: branch,
      title: (value) => value === "Organization Identity writer ban-at-source",
      bodySha256: isSha256,
    }),
  PR_UPDATE_BODY: (payload) =>
    exactPayload(
      payload,
      ["number", "expectedBaseSha", "expectedHeadSha", "title", "bodySha256"],
      {
        number: positiveInteger,
        expectedBaseSha: isGitObjectId,
        expectedHeadSha: isGitObjectId,
        title: (value) =>
          value === "Organization Identity writer ban-at-source",
        bodySha256: isSha256,
      },
    ),
  PR_READBACK: (payload) =>
    exactPayload(payload, ["number", "headBranch"], {
      number: (value) => value === null || positiveInteger(value),
      headBranch: branch,
    }),
  RULES_CHECKS_READBACK: (payload) =>
    exactPayload(payload, ["number", "expectedBaseSha", "expectedHeadSha"], {
      number: positiveInteger,
      expectedBaseSha: isGitObjectId,
      expectedHeadSha: isGitObjectId,
    }),
  PR_MERGE: (payload) =>
    exactPayload(
      payload,
      [
        "number",
        "expectedBaseSha",
        "expectedHeadSha",
        "mergeMethod",
        "immediateReadbackReceiptSetSha256",
      ],
      {
        number: positiveInteger,
        expectedBaseSha: isGitObjectId,
        expectedHeadSha: isGitObjectId,
        mergeMethod: (value) => value === "merge",
        immediateReadbackReceiptSetSha256: isSha256,
      },
    ),
  COMMIT_BRANCH_PARENT_READBACK: (payload) =>
    exactPayload(payload, ["mergeResponseSha", "expectedParents"], {
      mergeResponseSha: isGitObjectId,
      expectedParents: (value) =>
        Array.isArray(value) &&
        value.length === 2 &&
        value.every(isGitObjectId) &&
        value[0] !== value[1],
    }),
  WORKFLOW_RUN_READBACK: (payload) =>
    exactPayload(payload, ["workflowPath", "expectedHeadSha", "runId"], {
      workflowPath: (value) =>
        value === ".github/workflows/organization-identity-writer-anchor.yml",
      expectedHeadSha: isGitObjectId,
      runId: (value) => value === null || positiveInteger(value),
    }),
  WORKFLOW_RERUN: (payload) =>
    exactPayload(payload, ["runId", "runAttempt", "expectedHeadSha"], {
      runId: positiveInteger,
      runAttempt: positiveInteger,
      expectedHeadSha: isGitObjectId,
    }),
  CONTROLLER_VARIABLES_WRITE: (payload) =>
    exactPayload(
      payload,
      [
        "variableCount",
        "variableNameSetSha256",
        "variableValueDigestSetSha256",
      ],
      {
        variableCount: (value) => value === 15,
        variableNameSetSha256: isSha256,
        variableValueDigestSetSha256: isSha256,
      },
    ),
};

const REQUEST_KEYS = [
  "schemaVersion",
  "requestId",
  "operation",
  "contractSha256",
  "materializationReceiptSha256",
  "controllerReviewReceiptSha256",
  "authorizationReceiptSha256",
  "credentialHandle",
  "payloadSchemaSha256",
  "payloadSha256",
  "outputRecordPath",
  "payload",
];

export function validateGitHubControllerRequest(request, contract) {
  if (
    validateGitHubControllerContract(contract).status !== "PASS" ||
    !hasExactKeys(request, REQUEST_KEYS) ||
    request.schemaVersion !==
      "organization-identity-github-controller-request/v1" ||
    !GITHUB_CONTROLLER_OPERATIONS.includes(request.operation) ||
    !isSha256(request.requestId) ||
    !isSha256(request.contractSha256) ||
    !isSha256(request.materializationReceiptSha256) ||
    !isSha256(request.controllerReviewReceiptSha256) ||
    !isSha256(request.payloadSchemaSha256) ||
    !isSha256(request.payloadSha256) ||
    request.payloadSchemaSha256 !==
      contract.operationRequestSchemaSha256[request.operation] ||
    request.payloadSha256 !== sha256(canonicalJsonBytes(request.payload)) ||
    validateCredentialHandleBinding(request.credentialHandle).status !==
      "PASS" ||
    validateOutputPath(request.outputRecordPath, contract.outputRoot).status !==
      "PASS" ||
    typeof operationPayloadValid[request.operation] !== "function" ||
    !operationPayloadValid[request.operation](request.payload)
  ) {
    return integrity("GITHUB_CONTROLLER_REQUEST_INVALID");
  }
  if (!isSha256(request.authorizationReceiptSha256)) {
    return integrity("GITHUB_CONTROLLER_AUTHORIZATION_INVALID");
  }
  return pass();
}

export function buildGitHubControllerInvocation(request, contract) {
  const validated = validateGitHubControllerRequest(request, contract);
  if (validated.status !== "PASS") return validated;
  switch (request.operation) {
    case "PROTECTED_MAIN_READBACK":
      return pass({
        executableRole: "GH",
        argv: [
          "api",
          "repos/mlhjyx/global-backend/git/ref/heads/main",
          "--method",
          "GET",
        ],
      });
    case "FETCH_EXACT_OBJECT":
      return pass({
        executableRole: "GIT",
        argv: [
          "fetch",
          ...request.payload.flags,
          "origin",
          request.payload.objectSha,
        ],
      });
    case "PUSH_EXACT_BRANCH":
      return pass({
        executableRole: "GIT",
        argv: ["push", "--set-upstream", "origin", request.payload.branch],
      });
    case "PR_CREATE":
    case "PR_UPDATE_BODY":
    case "PR_READBACK":
    case "RULES_CHECKS_READBACK":
    case "PR_MERGE":
    case "COMMIT_BRANCH_PARENT_READBACK":
    case "WORKFLOW_RUN_READBACK":
    case "WORKFLOW_RERUN":
    case "CONTROLLER_VARIABLES_WRITE":
      return pass({
        executableRole: "GH",
        argv: ["api", "--closed-operation", request.operation],
      });
    default:
      return integrity("GITHUB_CONTROLLER_OPERATION_INVALID");
  }
}

const RECEIPT_KEYS = [
  "schemaVersion",
  "contractSha256",
  "controllerReviewReceiptSha256",
  "operation",
  "requestId",
  "requestSha256",
  "payloadSchemaSha256",
  "payloadSha256",
  "authorizationReceiptSha256",
  "credentialHandleSha256",
  "repository",
  "observedOrWrittenRef",
  "observedBaseSha",
  "observedHeadSha",
  "resultSchemaSha256",
  "resultSha256",
  "httpStatus",
  "executableClosureSetSha256",
  "prePostToctouSha256",
  "containsCredentialValue",
  "result",
];

export function validateGitHubControllerReceipt(receipt, request) {
  if (
    !hasExactKeys(receipt, RECEIPT_KEYS) ||
    receipt.schemaVersion !==
      "organization-identity-github-controller-receipt/v1" ||
    receipt.operation !== request.operation ||
    receipt.requestId !== request.requestId ||
    receipt.contractSha256 !== request.contractSha256 ||
    receipt.controllerReviewReceiptSha256 !==
      request.controllerReviewReceiptSha256 ||
    receipt.payloadSchemaSha256 !== request.payloadSchemaSha256 ||
    receipt.payloadSha256 !== request.payloadSha256 ||
    receipt.authorizationReceiptSha256 !== request.authorizationReceiptSha256 ||
    receipt.repository !== "mlhjyx/global-backend" ||
    receipt.containsCredentialValue !== false ||
    receipt.result !== "PASS" ||
    !isSha256(receipt.requestSha256) ||
    !isSha256(receipt.resultSchemaSha256) ||
    !isSha256(receipt.resultSha256) ||
    !isSha256(receipt.executableClosureSetSha256) ||
    !isSha256(receipt.prePostToctouSha256) ||
    (receipt.credentialHandleSha256 !== null &&
      !isSha256(receipt.credentialHandleSha256)) ||
    (receipt.observedBaseSha !== null &&
      !isGitObjectId(receipt.observedBaseSha)) ||
    (receipt.observedHeadSha !== null &&
      !isGitObjectId(receipt.observedHeadSha)) ||
    (receipt.observedOrWrittenRef !== null &&
      typeof receipt.observedOrWrittenRef !== "string") ||
    (receipt.httpStatus !== null &&
      (!Number.isSafeInteger(receipt.httpStatus) ||
        receipt.httpStatus < 100 ||
        receipt.httpStatus > 599))
  ) {
    return integrity("GITHUB_CONTROLLER_RECEIPT_INVALID");
  }
  return pass();
}
