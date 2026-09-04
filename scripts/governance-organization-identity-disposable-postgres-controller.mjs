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

function validateAuthorizationReceipt(bytes, request) {
  if (typeof bytes !== "string") return false;
  try {
    const parsed = JSON.parse(bytes);
    return (
      hasExactKeys(parsed, [
        "controllerClass",
        "requestId",
        "operation",
        "scope",
      ]) &&
      bytes === canonicalJsonBytes(parsed).toString("utf8") &&
      parsed.controllerClass === "DISPOSABLE_POSTGRES" &&
      parsed.requestId === request.requestId &&
      parsed.operation === request.operation &&
      parsed.scope === "EXACT_REQUEST_ONLY"
    );
  } catch {
    return false;
  }
}

function validateControllerEvidence(request, contract, evidence) {
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
  if (
    !hasExactKeys(evidence, [
      "materializationReceipt",
      "controllerReviewReceipt",
      "authorizationReceiptCanonicalBytes",
    ]) ||
    !hasExactKeys(evidence.materializationReceipt, materializationKeys) ||
    evidence.materializationReceipt.schemaVersion !==
      "organization-identity-external-controller-materialization/v1" ||
    evidence.materializationReceipt.controllerClass !== "DISPOSABLE_POSTGRES" ||
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
    evidence.controllerReviewReceipt.controllerClass !==
      "DISPOSABLE_POSTGRES" ||
    evidence.controllerReviewReceipt.contractSha256 !==
      request.contractSha256 ||
    evidence.controllerReviewReceipt.materializationReceiptSha256 !==
      request.materializationReceiptSha256 ||
    evidence.controllerReviewReceipt.reviewerClass !==
      "INDEPENDENT_CONTROLLER_SECURITY_REVIEW" ||
    evidence.controllerReviewReceipt.critical !== 0 ||
    evidence.controllerReviewReceipt.important !== 0 ||
    evidence.controllerReviewReceipt.verdict !== "PASS" ||
    request.controllerReviewReceiptSha256 !==
      sha256(canonicalJsonBytes(evidence.controllerReviewReceipt)) ||
    !validateAuthorizationReceipt(
      evidence.authorizationReceiptCanonicalBytes,
      request,
    ) ||
    request.authorizationReceiptSha256 !==
      sha256(Buffer.from(evidence.authorizationReceiptCanonicalBytes, "utf8"))
  )
    return integrity("DISPOSABLE_POSTGRES_EVIDENCE_INVALID");
  return pass();
}

export function validateDisposablePostgresRequest(request, contract, evidence) {
  if (
    validateDisposablePostgresContract(contract).status !== "PASS" ||
    !hasExactKeys(request, REQUEST_KEYS) ||
    request.schemaVersion !==
      "organization-identity-disposable-postgres-controller-request/v1" ||
    !OPERATIONS.includes(request.operation) ||
    !isSha256(request.requestId) ||
    request.contractSha256 !== sha256(canonicalJsonBytes(contract)) ||
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
      "PASS" ||
    validateControllerEvidence(request, contract, evidence).status !== "PASS"
  ) {
    return integrity("DISPOSABLE_POSTGRES_REQUEST_INVALID");
  }
  return pass();
}

export function buildDisposablePostgresInvocation(request, contract, evidence) {
  const validated = validateDisposablePostgresRequest(
    request,
    contract,
    evidence,
  );
  if (validated.status !== "PASS") return validated;
  const scenarioOperation =
    request.operation === "0M_COMPATIBILITY"
      ? "RUN_0M_COMPATIBILITY"
      : "RUN_B6_MIXED_FLEET";
  const suffix = request.requestId.slice(0, 12);
  const network = `identity-${suffix}-net`;
  const database = `identity-${suffix}-pg`;
  return pass({
    executableRoles: REQUIRED_ROLES,
    preconditions: {
      loopbackOnly: contract.loopbackOnly,
      noEgress: contract.noEgress,
      topologySha256: request.topologySha256,
      resourceLabelSetSha256: request.resourceLabelSetSha256,
      timeAndSpaceCapSha256: request.timeAndSpaceCapSha256,
      cleanupPlanSha256: request.cleanupPlanSha256,
    },
    operationPlan: [
      {
        phase: "CREATE_NETWORK",
        executableRole: "DOCKER",
        argv: [
          "network",
          "create",
          "--internal",
          "--label",
          `organization-identity-request=${request.requestId}`,
          network,
        ],
      },
      {
        phase: "CREATE_DATABASE",
        executableRole: "DOCKER",
        argv: [
          "run",
          "--detach",
          "--rm",
          "--network",
          network,
          "--publish",
          "127.0.0.1:0:5432",
          "--cpus",
          "1",
          "--memory",
          "512m",
          "--pids-limit",
          "128",
          "--read-only",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,size=64m",
          "--label",
          `organization-identity-request=${request.requestId}`,
          "--name",
          database,
          request.imageDigest,
        ],
      },
      {
        phase: "VERIFY_TOPOLOGY",
        executableRole: "DOCKER",
        argv: ["inspect", database, network],
        expectedTopologySha256: request.topologySha256,
        expectedResourceLabelSetSha256: request.resourceLabelSetSha256,
        expectedTimeAndSpaceCapSha256: request.timeAndSpaceCapSha256,
      },
      {
        phase: scenarioOperation,
        executableRole: "NODE",
        argv: [
          "/controller/governance-organization-identity-disposable-postgres-controller.mjs",
          "--disposable-operation",
          request.operation,
          "--migration-input-set-sha256",
          request.migrationInputSetSha256,
          "--scenario-set-sha256",
          request.scenarioSetSha256,
        ],
        toolSteps: [
          {
            executableRole: "PSQL",
            argv: ["--no-psqlrc", "--set", "ON_ERROR_STOP=1"],
          },
          { executableRole: "COREPACK_SHIM", argv: ["pnpm", "--version"] },
          {
            executableRole: "COREPACK_LIB_COREPACK_CJS",
            argv: ["--identity-check"],
          },
          {
            executableRole: "PNPM_SHIM",
            argv: ["--offline", "--ignore-scripts"],
          },
          {
            executableRole: "PNPM_ENTRYPOINT",
            argv: ["--offline", "--ignore-scripts"],
          },
          {
            executableRole: "PRISMA_CLI",
            argv: ["generate", "--schema", "packages/db/prisma/schema.prisma"],
          },
        ],
      },
      {
        phase: "CLEANUP",
        executableRole: "DOCKER",
        argv: ["rm", "--force", database],
        thenArgv: ["network", "rm", network],
      },
      {
        phase: "VERIFY_CLEANUP",
        executableRole: "DOCKER",
        argv: ["container", "inspect", database],
        thenArgv: ["network", "inspect", network],
        expectedAbsent: true,
        cleanupPlanSha256: request.cleanupPlanSha256,
      },
    ],
    finallyPlan: [
      {
        phase: "CLEANUP",
        executableRole: "DOCKER",
        argv: ["rm", "--force", database],
        thenArgv: ["network", "rm", network],
      },
      {
        phase: "VERIFY_CLEANUP",
        executableRole: "DOCKER",
        argv: ["container", "inspect", database],
        thenArgv: ["network", "inspect", network],
        expectedAbsent: true,
        cleanupPlanSha256: request.cleanupPlanSha256,
      },
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

export function validateDisposablePostgresReceipt(
  receipt,
  request,
  contract,
  resultRecord,
  evidence,
) {
  if (
    !contract ||
    !resultRecord ||
    validateDisposablePostgresContract(contract).status !== "PASS" ||
    validateDisposablePostgresRequest(request, contract, evidence).status !==
      "PASS" ||
    !isPassivePlainData(resultRecord) ||
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
    receipt.requestSha256 !== sha256(canonicalJsonBytes(request)) ||
    receipt.scenarioResultSetSha256 !==
      sha256(canonicalJsonBytes(resultRecord)) ||
    receipt.executableClosureSetSha256 !==
      sha256(canonicalJsonBytes(contract.executableClosure)) ||
    receipt.containsCredentialValue !== false ||
    receipt.retainedResources !== 0 ||
    receipt.result !== "PASS"
  ) {
    return integrity("DISPOSABLE_POSTGRES_RECEIPT_INVALID");
  }
  for (const key of [
    "resourceSetSha256",
    "cleanupProofSha256",
    "prePostToctouSha256",
  ]) {
    if (!isSha256(receipt[key])) {
      return integrity("DISPOSABLE_POSTGRES_RECEIPT_INVALID");
    }
  }
  return pass();
}
