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
const validateOutputPath = (value, root) =>
  isAbsoluteNormalizedPath(value) &&
  path.posix.dirname(value) === root &&
  value.endsWith(".json")
    ? pass()
    : integrity("OUTPUT_PATH_INVALID");

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
  "controllerSourceClosureSha256",
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
      "organization-identity-gitleaks-controller-contract/v2" ||
    contract.rootDirectory !== ROOT ||
    contract.requestRoot !== REQUEST_ROOT ||
    contract.outputRoot !== OUTPUT_ROOT ||
    !isGitObjectId(contract.controllerSourceBlobId) ||
    !isSha256(contract.controllerSourceSha256) ||
    !isSha256(contract.controllerSourceClosureSha256) ||
    contract.controllerSourceClosureSha256 ===
      contract.controllerSourceSha256 ||
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
  "controllerSourceClosureSha256",
  "authorizationReceiptSha256",
  "subjectCommit",
  "sourceTreeSha256",
  "configBlobId",
  "configSha256",
  "redact",
  "noBanner",
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
      parsed.controllerClass === "GITLEAKS" &&
      parsed.requestId === request.requestId &&
      parsed.operation === "SCAN" &&
      parsed.scope === "EXACT_REQUEST_ONLY"
    );
  } catch {
    return false;
  }
}

function validateControllerEvidence(request, contract, records) {
  const materializationKeys = [
    "schemaVersion",
    "controllerClass",
    "contractSha256",
    "controllerSourceSha256",
    "controllerSourceClosureSha256",
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
    "controllerSourceClosureSha256",
    "requestSchemaSha256",
    "reportSha256",
    "counterexampleSetSha256",
    "reviewerClass",
    "critical",
    "important",
    "verdict",
    "containsCredentialValue",
  ];
  if (
    !hasExactKeys(records, [
      "materializationReceipt",
      "controllerReviewReceipt",
      "authorizationReceiptCanonicalBytes",
    ]) ||
    !hasExactKeys(records.materializationReceipt, materializationKeys) ||
    records.materializationReceipt.schemaVersion !==
      "organization-identity-external-controller-materialization/v2" ||
    records.materializationReceipt.controllerClass !== "GITLEAKS" ||
    records.materializationReceipt.contractSha256 !==
      sha256(canonicalJsonBytes(contract)) ||
    records.materializationReceipt.controllerSourceSha256 !==
      contract.controllerSourceSha256 ||
    records.materializationReceipt.controllerSourceClosureSha256 !==
      contract.controllerSourceClosureSha256 ||
    records.materializationReceipt.ownerUid !== 0 ||
    records.materializationReceipt.ownerGid !== 0 ||
    records.materializationReceipt.directoryMode !== 0o700 ||
    records.materializationReceipt.controllerMode !== 0o500 ||
    records.materializationReceipt.recordMode !== 0o600 ||
    records.materializationReceipt.executableClosureSetSha256 !==
      sha256(canonicalJsonBytes(contract.executableClosure)) ||
    records.materializationReceipt.result !== "PASS" ||
    request.materializationReceiptSha256 !==
      sha256(canonicalJsonBytes(records.materializationReceipt)) ||
    !hasExactKeys(records.controllerReviewReceipt, reviewKeys) ||
    records.controllerReviewReceipt.schemaVersion !==
      "organization-identity-controller-review/v2" ||
    records.controllerReviewReceipt.controllerClass !== "GITLEAKS" ||
    records.controllerReviewReceipt.contractSha256 !== request.contractSha256 ||
    records.controllerReviewReceipt.materializationReceiptSha256 !==
      request.materializationReceiptSha256 ||
    records.controllerReviewReceipt.controllerSourceClosureSha256 !==
      request.controllerSourceClosureSha256 ||
    records.controllerReviewReceipt.reviewerClass !==
      "INDEPENDENT_CONTROLLER_SECURITY_REVIEW" ||
    records.controllerReviewReceipt.critical !== 0 ||
    records.controllerReviewReceipt.important !== 0 ||
    records.controllerReviewReceipt.verdict !== "PASS" ||
    records.controllerReviewReceipt.containsCredentialValue !== false ||
    request.controllerReviewReceiptSha256 !==
      sha256(canonicalJsonBytes(records.controllerReviewReceipt)) ||
    !validateAuthorizationReceipt(
      records.authorizationReceiptCanonicalBytes,
      request,
    ) ||
    request.authorizationReceiptSha256 !==
      sha256(Buffer.from(records.authorizationReceiptCanonicalBytes, "utf8"))
  )
    return integrity("GITLEAKS_EVIDENCE_INVALID");
  return pass();
}

export function validateGitleaksRequest(request, contract, evidence) {
  if (
    validateGitleaksContract(contract).status !== "PASS" ||
    !hasExactKeys(request, REQUEST_KEYS) ||
    request.schemaVersion !==
      "organization-identity-gitleaks-controller-request/v2" ||
    !isSha256(request.requestId) ||
    request.contractSha256 !== sha256(canonicalJsonBytes(contract)) ||
    request.controllerSourceClosureSha256 !==
      contract.controllerSourceClosureSha256 ||
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
      "PASS" ||
    validateControllerEvidence(request, contract, evidence).status !== "PASS"
  ) {
    return integrity("GITLEAKS_CONTROLLER_REQUEST_INVALID");
  }
  return pass();
}

export function buildGitleaksInvocation(request, contract, evidence) {
  const validated = validateGitleaksRequest(request, contract, evidence);
  if (validated.status !== "PASS") return validated;
  const sourceRoot = `${contract.requestRoot}/${request.requestId}-source`;
  const configPath = `${sourceRoot}/${contract.configPath}`;
  return pass({
    executableRole: "GITLEAKS",
    cwd: sourceRoot,
    argv: [
      "git",
      "--redact",
      "--no-banner",
      "--config",
      configPath,
      "--log-opts",
      request.subjectCommit,
    ],
    preconditions: {
      subjectCommit: request.subjectCommit,
      sourceTreeSha256: request.sourceTreeSha256,
      configBlobId: request.configBlobId,
      configSha256: request.configSha256,
      redact: true,
      noBanner: true,
    },
    resultSchemaSha256: contract.resultSchemaSha256,
    outputRecordPath: request.outputRecordPath,
  });
}

const RECEIPT_KEYS = [
  "schemaVersion",
  "contractSha256",
  "controllerReviewReceiptSha256",
  "controllerSourceClosureSha256",
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

export function validateGitleaksReceipt(
  receipt,
  request,
  contract,
  resultRecord,
  evidence,
) {
  if (
    !contract ||
    !resultRecord ||
    validateGitleaksContract(contract).status !== "PASS" ||
    validateGitleaksRequest(request, contract, evidence).status !== "PASS" ||
    !isPassivePlainData(resultRecord) ||
    !hasExactKeys(receipt, RECEIPT_KEYS) ||
    receipt.schemaVersion !==
      "organization-identity-gitleaks-controller-receipt/v2" ||
    receipt.contractSha256 !== request.contractSha256 ||
    receipt.controllerReviewReceiptSha256 !==
      request.controllerReviewReceiptSha256 ||
    receipt.controllerSourceClosureSha256 !==
      request.controllerSourceClosureSha256 ||
    receipt.requestId !== request.requestId ||
    receipt.authorizationReceiptSha256 !== request.authorizationReceiptSha256 ||
    receipt.subjectCommit !== request.subjectCommit ||
    receipt.sourceTreeSha256 !== request.sourceTreeSha256 ||
    receipt.configBlobId !== request.configBlobId ||
    receipt.requestSha256 !== sha256(canonicalJsonBytes(request)) ||
    receipt.executableClosureSetSha256 !==
      sha256(canonicalJsonBytes(contract.executableClosure)) ||
    receipt.findingSetSha256 !== sha256(canonicalJsonBytes(resultRecord)) ||
    receipt.redactionVerified !== true ||
    receipt.result !== "PASS"
  ) {
    return integrity("GITLEAKS_CONTROLLER_RECEIPT_INVALID");
  }
  return pass();
}

export async function runGitleaksControllerCli(argv, adapters, contract) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 2 ||
    argv[0] !== "--request" ||
    !path.posix.isAbsolute(argv[1]) ||
    typeof adapters?.readCanonicalRequest !== "function" ||
    typeof adapters?.readEvidence !== "function" ||
    typeof adapters?.readSourceClosure !== "function" ||
    typeof adapters?.runGitleaks !== "function" ||
    typeof adapters?.writeFileExclusive !== "function"
  ) {
    return integrity("GITLEAKS_CLI_INVALID");
  }
  const request = await adapters.readCanonicalRequest(argv[1]);
  const evidence = await adapters.readEvidence(request);
  const invocation = buildGitleaksInvocation(request, contract, evidence);
  if (invocation.status !== "PASS") return invocation;
  const sourceClosure = await adapters.readSourceClosure(request);
  if (
    sourceClosure?.sourceTreeSha256 !== request.sourceTreeSha256 ||
    sourceClosure?.configBlobId !== request.configBlobId ||
    sourceClosure?.configSha256 !== request.configSha256
  ) {
    return integrity("GITLEAKS_SOURCE_CLOSURE_INVALID");
  }
  let runResult;
  try {
    runResult = await adapters.runGitleaks(invocation.argv, invocation);
  } catch {
    return integrity("GITLEAKS_EXECUTION_FAILED");
  }
  if (
    runResult?.status !== "PASS" ||
    !isPassivePlainData(runResult.resultRecord)
  ) {
    return integrity("GITLEAKS_EXECUTION_FAILED");
  }
  const serialized = JSON.stringify(runResult.resultRecord);
  const unredacted =
    serialized.includes('"redacted":false') ||
    serialized.includes('"secret"') ||
    serialized.includes('"password"') ||
    serialized.includes('"token"');
  if (unredacted) {
    return integrity("GITLEAKS_REDACTION_INVALID");
  }
  const receipt = {
    schemaVersion: "organization-identity-gitleaks-controller-receipt/v2",
    contractSha256: request.contractSha256,
    controllerReviewReceiptSha256: request.controllerReviewReceiptSha256,
    controllerSourceClosureSha256: request.controllerSourceClosureSha256,
    requestId: request.requestId,
    requestSha256: sha256(canonicalJsonBytes(request)),
    authorizationReceiptSha256: request.authorizationReceiptSha256,
    subjectCommit: request.subjectCommit,
    sourceTreeSha256: request.sourceTreeSha256,
    configBlobId: request.configBlobId,
    executableClosureSetSha256: sha256(
      canonicalJsonBytes(contract.executableClosure),
    ),
    findingSetSha256: sha256(canonicalJsonBytes(runResult.resultRecord)),
    redactionVerified: true,
    result: "PASS",
  };
  const validated = validateGitleaksReceipt(
    receipt,
    request,
    contract,
    runResult.resultRecord,
    evidence,
  );
  if (validated.status !== "PASS") return validated;
  await adapters.writeFileExclusive(
    request.outputRecordPath,
    canonicalJsonBytes(receipt),
  );
  return pass({ receipt, resultRecord: runResult.resultRecord });
}
