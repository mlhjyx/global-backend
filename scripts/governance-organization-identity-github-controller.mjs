import { createHash } from "node:crypto";
import path from "node:path";

const pass = (extra = {}) => ({ status: "PASS", ...extra });
const integrity = (code) => ({ status: "INTEGRITY_ERROR", code });
const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
};
const canonicalJsonBytes = (value) => Buffer.from(`${canonicalJson(value)}\n`);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isSha256 = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isGitObjectId = (value) =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const isAbsoluteNormalizedPath = (value) =>
  typeof value === "string" &&
  path.posix.isAbsolute(value) &&
  path.posix.normalize(value) === value;
function isPassivePlainData(value, seen = new Set()) {
  if (value === null) return true;
  if (typeof value === "string") return value.normalize("NFC") === value;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length) return false;
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null)
      return false;
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (Array.isArray(value) && key === "length") continue;
      if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) return false;
      if (
        !("value" in descriptor) ||
        descriptor.get ||
        descriptor.set ||
        !isPassivePlainData(descriptor.value, seen)
      )
        return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    seen.delete(value);
  }
}
const hasExactKeys = (value, keys) =>
  isPassivePlainData(value) &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const valuesEqual = (left, right) =>
  canonicalJson(left) === canonicalJson(right);
function validateExternalExecutableClosure(entries, roles) {
  if (!Array.isArray(entries) || entries.length !== roles.length)
    return integrity("EXECUTABLE_CLOSURE_INVALID");
  for (let index = 0; index < roles.length; index += 1) {
    const entry = entries[index];
    if (
      !hasExactKeys(entry, [
        "role",
        "logicalIdentity",
        "executablePath",
        "realpathSha256",
        "sha256",
        "size",
      ]) ||
      entry.role !== roles[index] ||
      !isAbsoluteNormalizedPath(entry.executablePath) ||
      !isSha256(entry.realpathSha256) ||
      !isSha256(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    )
      return integrity("EXECUTABLE_CLOSURE_INVALID");
  }
  return pass();
}
const validateExactEnvironmentNames = (actual, expected) =>
  valuesEqual(actual, expected)
    ? pass()
    : integrity("ENVIRONMENT_NAME_SET_INVALID");
function validateCredentialHandleBinding(binding) {
  return hasExactKeys(binding, [
    "provider",
    "handleSha256",
    "scopeSha256",
    "injectedByFileDescriptor",
    "valuePersisted",
    "valueEmitted",
  ]) &&
    ["ROOT_SECRET_STORE", "GITHUB_ACTIONS_SECRET"].includes(binding.provider) &&
    isSha256(binding.handleSha256) &&
    isSha256(binding.scopeSha256) &&
    binding.injectedByFileDescriptor === true &&
    binding.valuePersisted === false &&
    binding.valueEmitted === false
    ? pass()
    : integrity("CREDENTIAL_HANDLE_INVALID");
}
const validateOutputPath = (value, root) =>
  isAbsoluteNormalizedPath(value) &&
  path.posix.dirname(value) === root &&
  value.endsWith(".json")
    ? pass()
    : integrity("OUTPUT_PATH_INVALID");

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

function validateGitHubEvidence(request, contract, evidence) {
  const materializationKeys = [
    "schemaVersion",
    "controllerClass",
    "contractSha256",
    "controllerSourceSha256",
    "rootDirectorySha256",
    "requestRootSha256",
    "outputRootSha256",
    "ownerUid",
    "ownerGid",
    "directoryMode",
    "controllerMode",
    "recordMode",
    "executableClosureSetSha256",
    "environmentSchemaSha256",
    "prePostToctouSha256",
    "result",
  ];
  const reviewKeys = [
    "schemaVersion",
    "controllerClass",
    "contractSha256",
    "materializationReceiptSha256",
    "requestSchemaSha256",
    "reportSha256",
    "counterexampleSetSha256",
    "reviewerClass",
    "critical",
    "important",
    "verdict",
  ];
  let authorization;
  try {
    authorization = JSON.parse(evidence?.authorizationReceiptCanonicalBytes);
    if (
      evidence.authorizationReceiptCanonicalBytes !==
      canonicalJsonBytes(authorization).toString("utf8")
    ) {
      return integrity("GITHUB_CONTROLLER_EVIDENCE_INVALID");
    }
  } catch {
    return integrity("GITHUB_CONTROLLER_EVIDENCE_INVALID");
  }
  if (
    !hasExactKeys(evidence, [
      "materializationReceipt",
      "controllerReviewReceipt",
      "authorizationReceiptCanonicalBytes",
    ]) ||
    !hasExactKeys(evidence.materializationReceipt, materializationKeys) ||
    evidence.materializationReceipt.schemaVersion !==
      "organization-identity-external-controller-materialization/v1" ||
    evidence.materializationReceipt.controllerClass !== "GITHUB" ||
    evidence.materializationReceipt.contractSha256 !==
      sha256(canonicalJsonBytes(contract)) ||
    evidence.materializationReceipt.controllerSourceSha256 !==
      contract.controllerSourceSha256 ||
    evidence.materializationReceipt.ownerUid !== 0 ||
    evidence.materializationReceipt.ownerGid !== 0 ||
    evidence.materializationReceipt.directoryMode !== 0o700 ||
    evidence.materializationReceipt.controllerMode !== 0o500 ||
    evidence.materializationReceipt.recordMode !== 0o600 ||
    evidence.materializationReceipt.executableClosureSetSha256 !==
      sha256(canonicalJsonBytes(contract.executableClosure)) ||
    evidence.materializationReceipt.result !== "PASS" ||
    request.materializationReceiptSha256 !==
      sha256(canonicalJsonBytes(evidence.materializationReceipt)) ||
    !hasExactKeys(evidence.controllerReviewReceipt, reviewKeys) ||
    evidence.controllerReviewReceipt.schemaVersion !==
      "organization-identity-controller-review/v1" ||
    evidence.controllerReviewReceipt.controllerClass !== "GITHUB" ||
    evidence.controllerReviewReceipt.contractSha256 !==
      request.contractSha256 ||
    evidence.controllerReviewReceipt.materializationReceiptSha256 !==
      request.materializationReceiptSha256 ||
    request.controllerReviewReceiptSha256 !==
      sha256(canonicalJsonBytes(evidence.controllerReviewReceipt)) ||
    evidence.controllerReviewReceipt.reviewerClass !==
      "INDEPENDENT_CONTROLLER_SECURITY_REVIEW" ||
    evidence.controllerReviewReceipt.critical !== 0 ||
    evidence.controllerReviewReceipt.important !== 0 ||
    evidence.controllerReviewReceipt.verdict !== "PASS" ||
    !hasExactKeys(authorization, [
      "controllerClass",
      "requestId",
      "operation",
      "scope",
    ]) ||
    authorization.controllerClass !== "GITHUB" ||
    authorization.requestId !== request.requestId ||
    authorization.operation !== request.operation ||
    authorization.scope !== "EXACT_REQUEST_ONLY" ||
    request.authorizationReceiptSha256 !==
      sha256(Buffer.from(evidence.authorizationReceiptCanonicalBytes, "utf8"))
  ) {
    return integrity("GITHUB_CONTROLLER_EVIDENCE_INVALID");
  }
  return pass();
}

export function validateGitHubControllerRequest(request, contract, evidence) {
  if (
    validateGitHubControllerContract(contract).status !== "PASS" ||
    !hasExactKeys(request, REQUEST_KEYS) ||
    request.schemaVersion !==
      "organization-identity-github-controller-request/v1" ||
    !GITHUB_CONTROLLER_OPERATIONS.includes(request.operation) ||
    !isSha256(request.requestId) ||
    request.contractSha256 !== sha256(canonicalJsonBytes(contract)) ||
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
    !operationPayloadValid[request.operation](request.payload) ||
    validateGitHubEvidence(request, contract, evidence).status !== "PASS"
  ) {
    return integrity("GITHUB_CONTROLLER_REQUEST_INVALID");
  }
  if (!isSha256(request.authorizationReceiptSha256)) {
    return integrity("GITHUB_CONTROLLER_AUTHORIZATION_INVALID");
  }
  return pass();
}

export function buildGitHubControllerInvocation(request, contract, evidence) {
  const validated = validateGitHubControllerRequest(
    request,
    contract,
    evidence,
  );
  if (validated.status !== "PASS") return validated;
  const common = {
    operation: request.operation,
    preconditions: request.payload,
    resultSchemaSha256: contract.operationResultSchemaSha256[request.operation],
  };
  const inputPath = `${contract.requestRoot}/${request.requestId}-${request.operation.toLowerCase()}.payload.json`;
  switch (request.operation) {
    case "PROTECTED_MAIN_READBACK":
      return pass({
        ...common,
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
        ...common,
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
        ...common,
        executableRole: "GIT",
        argv: [
          "push",
          "--set-upstream",
          "origin",
          `${request.payload.expectedHead}:refs/heads/${request.payload.branch}`,
        ],
      });
    case "PR_CREATE":
      return pass({
        ...common,
        executableRole: "GH",
        argv: [
          "api",
          "repos/mlhjyx/global-backend/pulls",
          "--method",
          "POST",
          "--input",
          inputPath,
        ],
        inputPath,
        inputRecordBytes: canonicalJsonBytes(request.payload),
      });
    case "PR_UPDATE_BODY":
      return pass({
        ...common,
        executableRole: "GH",
        argv: [
          "api",
          `repos/mlhjyx/global-backend/pulls/${request.payload.number}`,
          "--method",
          "PATCH",
          "--input",
          inputPath,
        ],
        inputPath,
        inputRecordBytes: canonicalJsonBytes(request.payload),
      });
    case "PR_READBACK":
      return pass({
        ...common,
        executableRole: "GH",
        argv: [
          "pr",
          "view",
          String(request.payload.number ?? request.payload.headBranch),
          "--repo",
          "mlhjyx/global-backend",
          "--json",
          "number,baseRefName,headRefName,baseRefOid,headRefOid,title,body,state,mergeStateStatus",
        ],
      });
    case "RULES_CHECKS_READBACK":
      return pass({
        ...common,
        executableRole: "GH",
        argv: [
          "pr",
          "checks",
          String(request.payload.number),
          "--repo",
          "mlhjyx/global-backend",
          "--json",
          "name,state,workflow,bucket,link",
        ],
      });
    case "PR_MERGE":
      return pass({
        ...common,
        executableRole: "GH",
        argv: [
          "api",
          `repos/mlhjyx/global-backend/pulls/${request.payload.number}/merge`,
          "--method",
          "PUT",
          "--input",
          inputPath,
        ],
        inputPath,
        inputRecordBytes: canonicalJsonBytes(request.payload),
      });
    case "COMMIT_BRANCH_PARENT_READBACK":
      return pass({
        ...common,
        executableRole: "GH",
        argv: [
          "api",
          `repos/mlhjyx/global-backend/commits/${request.payload.mergeResponseSha}`,
          "--method",
          "GET",
        ],
      });
    case "WORKFLOW_RUN_READBACK":
      return pass({
        ...common,
        executableRole: "GH",
        argv:
          request.payload.runId === null
            ? [
                "run",
                "list",
                "--repo",
                "mlhjyx/global-backend",
                "--workflow",
                request.payload.workflowPath,
                "--commit",
                request.payload.expectedHeadSha,
                "--json",
                "databaseId,headSha,status,conclusion,attempt,workflowName",
              ]
            : [
                "run",
                "view",
                String(request.payload.runId),
                "--repo",
                "mlhjyx/global-backend",
                "--json",
                "databaseId,headSha,status,conclusion,attempt,workflowName",
              ],
      });
    case "WORKFLOW_RERUN":
      return pass({
        ...common,
        executableRole: "GH",
        preReadbacks: [
          {
            argv: [
              "run",
              "view",
              String(request.payload.runId),
              "--repo",
              "mlhjyx/global-backend",
              "--json",
              "attempt,headSha",
            ],
            expected: {
              runAttempt: request.payload.runAttempt,
              headSha: request.payload.expectedHeadSha,
            },
          },
        ],
        argv: [
          "run",
          "rerun",
          String(request.payload.runId),
          "--repo",
          "mlhjyx/global-backend",
        ],
      });
    case "CONTROLLER_VARIABLES_WRITE":
      return pass({
        ...common,
        executableRole: "GH",
        argv: [
          "api",
          "repos/mlhjyx/global-backend/actions/variables",
          "--method",
          "POST",
          "--input",
          inputPath,
        ],
        inputPath,
        inputRecordBytes: canonicalJsonBytes(request.payload),
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

export function validateGitHubControllerReceipt(
  receipt,
  request,
  contract,
  resultRecord,
  evidence,
) {
  if (
    !contract ||
    !resultRecord ||
    validateGitHubControllerContract(contract).status !== "PASS" ||
    validateGitHubControllerRequest(request, contract, evidence).status !==
      "PASS" ||
    !isPassivePlainData(resultRecord) ||
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
    receipt.requestSha256 !== sha256(canonicalJsonBytes(request)) ||
    receipt.resultSchemaSha256 !==
      contract.operationResultSchemaSha256[request.operation] ||
    receipt.resultSha256 !== sha256(canonicalJsonBytes(resultRecord)) ||
    receipt.executableClosureSetSha256 !==
      sha256(canonicalJsonBytes(contract.executableClosure)) ||
    !isSha256(receipt.prePostToctouSha256) ||
    receipt.credentialHandleSha256 !== request.credentialHandle.handleSha256 ||
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
