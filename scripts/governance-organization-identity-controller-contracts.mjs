import { createHash } from "node:crypto";
import path from "node:path";

export const EXTERNAL_EXECUTABLE_ROLES = Object.freeze([
  "ENV",
  "NODE",
  "GIT",
  "GH",
  "GITLEAKS",
  "DOCKER",
  "PSQL",
  "COREPACK_SHIM",
  "COREPACK_LIB_COREPACK_CJS",
  "PNPM_SHIM",
  "PNPM_ENTRYPOINT",
  "PRISMA_CLI",
]);

export const CONTROLLER_CLASSES = Object.freeze([
  "GITHUB",
  "DISPOSABLE_POSTGRES",
  "GITLEAKS",
  "ROOT_ANCHOR",
  "PROTECTED_BASE_LAUNCHER",
]);

export function pass(extra = {}) {
  return { status: "PASS", ...extra };
}

export function integrity(code) {
  return { status: "INTEGRITY_ERROR", code };
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function canonicalJsonBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function isGitObjectId(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

export function isAbsoluteNormalizedPath(value) {
  return (
    typeof value === "string" &&
    path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    !value.includes("\0")
  );
}

export function hasExactKeys(value, keys) {
  if (!isPassivePlainData(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function isPassivePlainData(value, seen = new Set()) {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string") return value.normalize("NFC") === value;
  if (type === "number") return Number.isFinite(value);
  if (type === "boolean") return true;
  if (type !== "object" || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length !== 0) return false;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === "length") continue;
        if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
        if (!("value" in descriptor) || descriptor.get || descriptor.set)
          return false;
        if (!isPassivePlainData(descriptor.value, seen)) return false;
      }
      return Object.keys(value).every((key, index) => key === String(index));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(value).length !== 0) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const descriptor of Object.values(descriptors)) {
      if (!("value" in descriptor) || descriptor.get || descriptor.set)
        return false;
      if (!isPassivePlainData(descriptor.value, seen)) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    seen.delete(value);
  }
}

export function valuesEqual(actual, expected) {
  return canonicalJson(actual) === canonicalJson(expected);
}

export function validateExternalExecutableClosure(entries, expectedRoles) {
  if (!Array.isArray(entries) || !Array.isArray(expectedRoles)) {
    return integrity("EXECUTABLE_CLOSURE_INVALID");
  }
  if (
    !valuesEqual(expectedRoles, [...new Set(expectedRoles)]) ||
    expectedRoles.some((role) => !EXTERNAL_EXECUTABLE_ROLES.includes(role)) ||
    entries.length !== expectedRoles.length
  ) {
    return integrity("EXECUTABLE_CLOSURE_INVALID");
  }
  const keys = [
    "role",
    "logicalIdentity",
    "executablePath",
    "realpathSha256",
    "sha256",
    "size",
  ];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (
      !hasExactKeys(entry, keys) ||
      entry.role !== expectedRoles[index] ||
      typeof entry.logicalIdentity !== "string" ||
      entry.logicalIdentity.length === 0 ||
      !isAbsoluteNormalizedPath(entry.executablePath) ||
      !isSha256(entry.realpathSha256) ||
      !isSha256(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    ) {
      return integrity("EXECUTABLE_CLOSURE_INVALID");
    }
  }
  return pass({
    executableClosureSetSha256: sha256(canonicalJsonBytes(entries)),
  });
}

export function validateCredentialHandleBinding(binding) {
  if (
    !hasExactKeys(binding, [
      "provider",
      "handleSha256",
      "scopeSha256",
      "injectedByFileDescriptor",
      "valuePersisted",
      "valueEmitted",
    ]) ||
    !["ROOT_SECRET_STORE", "GITHUB_ACTIONS_SECRET"].includes(
      binding.provider,
    ) ||
    !isSha256(binding.handleSha256) ||
    !isSha256(binding.scopeSha256) ||
    binding.injectedByFileDescriptor !== true ||
    binding.valuePersisted !== false ||
    binding.valueEmitted !== false
  ) {
    return integrity("CREDENTIAL_HANDLE_INVALID");
  }
  return pass();
}

export function validateExternalControllerMaterializationReceipt(
  receipt,
  expectedClass,
) {
  if (
    !hasExactKeys(receipt, [
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
    ]) ||
    receipt.schemaVersion !==
      "organization-identity-external-controller-materialization/v1" ||
    !CONTROLLER_CLASSES.slice(0, 4).includes(expectedClass) ||
    receipt.controllerClass !== expectedClass ||
    receipt.ownerUid !== 0 ||
    receipt.ownerGid !== 0 ||
    receipt.directoryMode !== 0o700 ||
    receipt.controllerMode !== 0o500 ||
    receipt.recordMode !== 0o600 ||
    receipt.result !== "PASS"
  ) {
    return integrity("CONTROLLER_MATERIALIZATION_INVALID");
  }
  for (const key of [
    "contractSha256",
    "controllerSourceSha256",
    "rootDirectorySha256",
    "requestRootSha256",
    "outputRootSha256",
    "executableClosureSetSha256",
    "environmentSchemaSha256",
    "prePostToctouSha256",
  ]) {
    if (!isSha256(receipt[key])) {
      return integrity("CONTROLLER_MATERIALIZATION_INVALID");
    }
  }
  return pass();
}

export function validateControllerReviewReceipt(receipt, expectedClass) {
  if (
    !hasExactKeys(receipt, [
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
    ]) ||
    receipt.schemaVersion !== "organization-identity-controller-review/v1" ||
    receipt.controllerClass !== expectedClass ||
    receipt.reviewerClass !== "INDEPENDENT_CONTROLLER_SECURITY_REVIEW" ||
    receipt.critical !== 0 ||
    receipt.important !== 0 ||
    receipt.verdict !== "PASS" ||
    !isSha256(receipt.contractSha256) ||
    !isSha256(receipt.requestSchemaSha256) ||
    !isSha256(receipt.reportSha256) ||
    !isSha256(receipt.counterexampleSetSha256)
  ) {
    return integrity("CONTROLLER_REVIEW_INVALID");
  }
  const materializationAllowed =
    expectedClass === "PROTECTED_BASE_LAUNCHER"
      ? receipt.materializationReceiptSha256 === null
      : isSha256(receipt.materializationReceiptSha256);
  if (!materializationAllowed) return integrity("CONTROLLER_REVIEW_INVALID");
  return pass();
}

export function validateExactEnvironmentNames(actual, expected) {
  if (!valuesEqual(actual, expected)) {
    return integrity("ENVIRONMENT_NAME_SET_INVALID");
  }
  return pass();
}

export function validateOutputPath(outputRecordPath, outputRoot) {
  if (
    !isAbsoluteNormalizedPath(outputRecordPath) ||
    !isAbsoluteNormalizedPath(outputRoot) ||
    path.posix.dirname(outputRecordPath) !== outputRoot ||
    !outputRecordPath.endsWith(".json")
  ) {
    return integrity("OUTPUT_PATH_INVALID");
  }
  return pass();
}

function hasCredentialLikeKey(value) {
  if (value === null || typeof value !== "object") return false;
  for (const key of Object.keys(value)) {
    if (key === "containsCredentialValue") continue;
    if (/credential|secret|token|password|private/i.test(key)) return true;
    if (hasCredentialLikeKey(value[key])) return true;
  }
  return false;
}

function validateSourceEntry(entry) {
  return (
    hasExactKeys(entry, ["path", "blobId", "sha256"]) &&
    typeof entry.path === "string" &&
    entry.path.startsWith("scripts/") &&
    path.posix.normalize(entry.path) === entry.path &&
    !path.posix.isAbsolute(entry.path) &&
    isGitObjectId(entry.blobId) &&
    isSha256(entry.sha256)
  );
}

export function buildControllerReceiptSetSha256(records) {
  return sha256(canonicalJsonBytes(records));
}

export function validateControllerSourceClosureV1(closure) {
  const classPathToken = {
    GITHUB: "github",
    DISPOSABLE_POSTGRES: "disposable-postgres",
    GITLEAKS: "gitleaks",
    ROOT_ANCHOR: "root-anchor",
    PROTECTED_BASE_LAUNCHER: "protected-base",
  }[closure?.controllerClass];
  if (
    !hasExactKeys(closure, [
      "schemaVersion",
      "controllerClass",
      "primarySourcePath",
      "primarySourceBlobId",
      "primarySourceSha256",
      "sharedSourceEntries",
      "testSourceEntries",
      "sourceSetSha256",
    ]) ||
    closure.schemaVersion !==
      "organization-identity-controller-source-closure/v1" ||
    !CONTROLLER_CLASSES.includes(closure.controllerClass) ||
    !classPathToken ||
    !closure.primarySourcePath.includes(classPathToken) ||
    !validateSourceEntry({
      path: closure.primarySourcePath,
      blobId: closure.primarySourceBlobId,
      sha256: closure.primarySourceSha256,
    }) ||
    !Array.isArray(closure.sharedSourceEntries) ||
    !closure.sharedSourceEntries.every(validateSourceEntry) ||
    !Array.isArray(closure.testSourceEntries) ||
    !closure.testSourceEntries.every(validateSourceEntry)
  ) {
    return integrity("CONTROLLER_SOURCE_CLOSURE_INVALID");
  }
  const entries = [
    {
      path: closure.primarySourcePath,
      blobId: closure.primarySourceBlobId,
      sha256: closure.primarySourceSha256,
    },
    ...closure.sharedSourceEntries,
    ...closure.testSourceEntries,
  ];
  if (closure.sourceSetSha256 !== buildControllerReceiptSetSha256(entries)) {
    return integrity("CONTROLLER_SOURCE_CLOSURE_INVALID");
  }
  return pass({
    controllerSourceClosureSha256: sha256(canonicalJsonBytes(closure)),
  });
}

export function validateVerifiedWorktreeReceiptV1(receipt) {
  if (
    !hasExactKeys(receipt, [
      "schemaVersion",
      "repositoryRoot",
      "worktreePath",
      "gitDirRealpathSha256",
      "commonDirRealpathSha256",
      "branch",
      "headCommit",
      "subjectCommit",
      "statusPorcelainSha256",
      "worktreeListEntrySha256",
      "expectedMode",
      "verifiedByExecutableClosureSha256",
      "prePostToctouSha256",
      "result",
    ]) ||
    receipt.schemaVersion !== "organization-identity-verified-worktree/v1" ||
    !isAbsoluteNormalizedPath(receipt.repositoryRoot) ||
    !isAbsoluteNormalizedPath(receipt.worktreePath) ||
    !receipt.worktreePath.startsWith(`${receipt.repositoryRoot}/`) ||
    !isSha256(receipt.gitDirRealpathSha256) ||
    !isSha256(receipt.commonDirRealpathSha256) ||
    typeof receipt.branch !== "string" ||
    receipt.branch.length === 0 ||
    !isGitObjectId(receipt.headCommit) ||
    !isGitObjectId(receipt.subjectCommit) ||
    receipt.headCommit !== receipt.subjectCommit ||
    !isSha256(receipt.statusPorcelainSha256) ||
    !isSha256(receipt.worktreeListEntrySha256) ||
    typeof receipt.expectedMode !== "string" ||
    receipt.expectedMode.length === 0 ||
    !isSha256(receipt.verifiedByExecutableClosureSha256) ||
    !isSha256(receipt.prePostToctouSha256) ||
    receipt.result !== "PASS"
  ) {
    return integrity("VERIFIED_WORKTREE_RECEIPT_INVALID");
  }
  return pass({
    verifiedWorktreeReceiptSha256: sha256(canonicalJsonBytes(receipt)),
  });
}

export function validateLauncherMaterializationReviewReceiptV2(receipt) {
  if (
    !hasExactKeys(receipt, [
      "schemaVersion",
      "launcherContractSha256",
      "launcherMaterializationReceiptSha256",
      "launcherMaterializationReviewReceiptSha256",
      "readbackReportSha256",
      "reportSha256",
      "counterexampleSetSha256",
      "reviewerClass",
      "critical",
      "important",
      "verdict",
      "containsCredentialValue",
    ]) ||
    receipt.schemaVersion !==
      "organization-identity-launcher-materialization-review/v2" ||
    ![
      "launcherContractSha256",
      "launcherMaterializationReceiptSha256",
      "launcherMaterializationReviewReceiptSha256",
      "readbackReportSha256",
      "reportSha256",
      "counterexampleSetSha256",
    ].every((key) => isSha256(receipt[key])) ||
    receipt.reviewerClass !== "INDEPENDENT_ROOT_LAUNCHER_REVIEW" ||
    receipt.critical !== 0 ||
    receipt.important !== 0 ||
    receipt.verdict !== "PASS" ||
    receipt.containsCredentialValue !== false
  ) {
    return integrity("LAUNCHER_MATERIALIZATION_REVIEW_INVALID");
  }
  return pass();
}

export function validateBootstrapContractV2(contract) {
  if (
    !hasExactKeys(contract, [
      "schemaVersion",
      "launcherContractSha256",
      "bootstrapSchemaSha256",
      "closedRequestSchemaSha256",
      "effectivePnpmArgvRuleSha256",
      "receiptComparatorSha256",
      "toolLogicalExpectations",
      "allowedEnvironmentNames",
    ]) ||
    contract.schemaVersion !== "organization-identity-bootstrap-contract/v2" ||
    ![
      "launcherContractSha256",
      "bootstrapSchemaSha256",
      "closedRequestSchemaSha256",
      "effectivePnpmArgvRuleSha256",
      "receiptComparatorSha256",
    ].every((key) => isSha256(contract[key])) ||
    !Array.isArray(contract.toolLogicalExpectations) ||
    !Array.isArray(contract.allowedEnvironmentNames)
  ) {
    return integrity("BOOTSTRAP_CONTRACT_INVALID");
  }
  return pass();
}

export function validateGitHubControllerReceiptV2(receipt, operation) {
  const required = [
    "schemaVersion",
    "contractSha256",
    "controllerReviewReceiptSha256",
    "controllerSourceClosureSha256",
    "operation",
    "repository",
    "resultSha256",
    "containsCredentialValue",
    "result",
  ];
  const allowedExtra = new Set(["observedHeadSha"]);
  const actual = Object.keys(receipt ?? {});
  if (
    !isPassivePlainData(receipt) ||
    !required.every((key) => Object.hasOwn(receipt, key)) ||
    actual.some((key) => !required.includes(key) && !allowedExtra.has(key)) ||
    receipt.schemaVersion !==
      "organization-identity-github-controller-receipt/v2" ||
    (operation && receipt.operation !== operation) ||
    receipt.repository !== "mlhjyx/global-backend" ||
    !isSha256(receipt.contractSha256) ||
    !isSha256(receipt.controllerReviewReceiptSha256) ||
    !isSha256(receipt.controllerSourceClosureSha256) ||
    !isSha256(receipt.resultSha256) ||
    (Object.hasOwn(receipt, "observedHeadSha") &&
      !isGitObjectId(receipt.observedHeadSha)) ||
    receipt.containsCredentialValue !== false ||
    receipt.result !== "PASS"
  ) {
    return integrity("GITHUB_CONTROLLER_RECEIPT_INVALID");
  }
  return pass();
}

export function validateProtectedBaseLauncherReceiptV2(receipt) {
  if (
    !hasExactKeys(receipt, [
      "schemaVersion",
      "repository",
      "protectedBaseCommit",
      "controllerVariableSetSha256",
      "containsCredentialValue",
      "result",
    ]) ||
    receipt.schemaVersion !==
      "organization-identity-protected-base-launcher-receipt/v2" ||
    receipt.repository !== "mlhjyx/global-backend" ||
    !isGitObjectId(receipt.protectedBaseCommit) ||
    !isSha256(receipt.controllerVariableSetSha256) ||
    receipt.containsCredentialValue !== false ||
    receipt.result !== "PASS"
  ) {
    return integrity("PROTECTED_BASE_LAUNCHER_RECEIPT_INVALID");
  }
  return pass();
}

export function validateAdmittedRefreshAcceptanceEvidenceV1(evidence) {
  if (
    !hasExactKeys(evidence, [
      "schemaVersion",
      "currentMainAdmissionCommit",
      "reviewedImplementationCommit",
      "stageMapSha256",
      "result",
    ]) ||
    evidence.schemaVersion !== "organization-identity-writer-acceptance/v1" ||
    !isGitObjectId(evidence.currentMainAdmissionCommit) ||
    !isGitObjectId(evidence.reviewedImplementationCommit) ||
    !isSha256(evidence.stageMapSha256) ||
    evidence.result !== "PASS"
  ) {
    return integrity("ADMITTED_REFRESH_ACCEPTANCE_INVALID");
  }
  return pass();
}

export function validateWorkflowRunEvidenceV1(evidence) {
  if (
    !hasExactKeys(evidence, [
      "schemaVersion",
      "repository",
      "workflowPath",
      "event",
      "ref",
      "headSha",
      "runId",
      "runAttempt",
      "conclusion",
      "containsCredentialValue",
      "result",
    ]) ||
    evidence.schemaVersion !==
      "organization-identity-workflow-run-evidence/v1" ||
    evidence.repository !== "mlhjyx/global-backend" ||
    evidence.workflowPath !==
      ".github/workflows/organization-identity-writer-anchor.yml" ||
    evidence.event !== "push" ||
    evidence.ref !== "refs/heads/main" ||
    !isGitObjectId(evidence.headSha) ||
    !Number.isSafeInteger(evidence.runId) ||
    evidence.runId <= 0 ||
    !Number.isSafeInteger(evidence.runAttempt) ||
    evidence.runAttempt <= 0 ||
    evidence.conclusion !== "success" ||
    evidence.containsCredentialValue !== false ||
    evidence.result !== "PASS"
  ) {
    return integrity("WORKFLOW_RUN_EVIDENCE_INVALID");
  }
  return pass();
}

export function validateControllerVariableWriteReceiptV2(receipt) {
  return validateGitHubControllerReceiptV2(
    receipt,
    "CONTROLLER_VARIABLES_WRITE",
  );
}

function validateExternalControllerMaterializationReceiptV2(receipt) {
  if (
    !hasExactKeys(receipt, [
      "schemaVersion",
      "controllerClass",
      "contractSha256",
      "controllerSourceClosureSha256",
      "result",
    ]) ||
    receipt.schemaVersion !==
      "organization-identity-external-controller-materialization/v2" ||
    receipt.controllerClass !== "ROOT_ANCHOR" ||
    !isSha256(receipt.contractSha256) ||
    !isSha256(receipt.controllerSourceClosureSha256) ||
    receipt.result !== "PASS"
  ) {
    return integrity("CONTROLLER_MATERIALIZATION_INVALID");
  }
  return pass();
}

function validateControllerReviewReceiptV2(receipt) {
  if (
    !hasExactKeys(receipt, [
      "schemaVersion",
      "controllerClass",
      "contractSha256",
      "materializationReceiptSha256",
      "controllerSourceClosureSha256",
      "critical",
      "important",
      "verdict",
      "containsCredentialValue",
    ]) ||
    receipt.schemaVersion !== "organization-identity-controller-review/v2" ||
    receipt.controllerClass !== "ROOT_ANCHOR" ||
    !isSha256(receipt.contractSha256) ||
    !isSha256(receipt.materializationReceiptSha256) ||
    !isSha256(receipt.controllerSourceClosureSha256) ||
    receipt.critical !== 0 ||
    receipt.important !== 0 ||
    receipt.verdict !== "PASS" ||
    receipt.containsCredentialValue !== false
  ) {
    return integrity("CONTROLLER_REVIEW_INVALID");
  }
  return pass();
}

export function validateRootAnchorUpstreamEvidenceClosureV2(records) {
  if (
    !hasExactKeys(records, [
      "localLauncherReview",
      "bootstrapContract",
      "githubProtectedMainReadback",
      "githubControllerVariableWrite",
      "protectedBaseLaunch",
      "admittedRefreshAcceptance",
      "workflowRun",
      "rootAnchorControllerMaterialization",
      "rootAnchorControllerReview",
      "rootAnchorAuthorization",
    ]) ||
    hasCredentialLikeKey(records)
  ) {
    return integrity("ROOT_ANCHOR_UPSTREAM_EVIDENCE_INVALID");
  }
  const github = records.githubProtectedMainReadback;
  const variables = records.githubControllerVariableWrite;
  const protectedBase = records.protectedBaseLaunch;
  const workflow = records.workflowRun;
  if (
    validateLauncherMaterializationReviewReceiptV2(records.localLauncherReview)
      .status !== "PASS" ||
    validateBootstrapContractV2(records.bootstrapContract).status !== "PASS" ||
    validateGitHubControllerReceiptV2(github, "PROTECTED_MAIN_READBACK")
      .status !== "PASS" ||
    validateControllerVariableWriteReceiptV2(variables).status !== "PASS" ||
    validateProtectedBaseLauncherReceiptV2(protectedBase).status !== "PASS" ||
    validateAdmittedRefreshAcceptanceEvidenceV1(
      records.admittedRefreshAcceptance,
    ).status !== "PASS" ||
    validateWorkflowRunEvidenceV1(workflow).status !== "PASS" ||
    validateExternalControllerMaterializationReceiptV2(
      records.rootAnchorControllerMaterialization,
    ).status !== "PASS" ||
    validateControllerReviewReceiptV2(records.rootAnchorControllerReview)
      .status !== "PASS" ||
    !hasExactKeys(records.rootAnchorAuthorization, [
      "controllerClass",
      "requestId",
      "operation",
      "scope",
    ]) ||
    records.rootAnchorAuthorization.controllerClass !== "ROOT_ANCHOR" ||
    records.rootAnchorAuthorization.operation !== "ROOT_ANCHOR_WRITE" ||
    records.rootAnchorAuthorization.scope !== "EXACT_REQUEST_ONLY" ||
    records.localLauncherReview.launcherContractSha256 !==
      records.bootstrapContract.launcherContractSha256 ||
    github.repository !== protectedBase.repository ||
    github.repository !== workflow.repository ||
    github.observedHeadSha !== protectedBase.protectedBaseCommit ||
    github.observedHeadSha !== workflow.headSha ||
    github.observedHeadSha !==
      records.admittedRefreshAcceptance.currentMainAdmissionCommit ||
    variables.contractSha256 !== github.contractSha256 ||
    variables.controllerReviewReceiptSha256 !==
      github.controllerReviewReceiptSha256 ||
    variables.controllerSourceClosureSha256 !==
      github.controllerSourceClosureSha256 ||
    protectedBase.controllerVariableSetSha256 !== variables.resultSha256 ||
    records.rootAnchorControllerMaterialization.contractSha256 !==
      records.rootAnchorControllerReview.contractSha256 ||
    records.rootAnchorControllerMaterialization
      .controllerSourceClosureSha256 !==
      records.rootAnchorControllerReview.controllerSourceClosureSha256
  ) {
    return integrity("ROOT_ANCHOR_UPSTREAM_EVIDENCE_INVALID");
  }
  return pass({
    upstreamEvidenceClosureSha256: sha256(canonicalJsonBytes(records)),
  });
}

export function validateRootAnchorOperationReviewClosureV2(records) {
  if (
    !hasExactKeys(records, [
      "writeRequest",
      "writeReceipt",
      "readbackReceipt",
      "operationReviewReceipt",
      "upstreamEvidence",
    ]) ||
    validateRootAnchorUpstreamEvidenceClosureV2(records.upstreamEvidence)
      .status !== "PASS"
  ) {
    return integrity("ROOT_ANCHOR_OPERATION_REVIEW_INVALID");
  }
  const {
    writeRequest,
    writeReceipt,
    readbackReceipt,
    operationReviewReceipt,
  } = records;
  if (
    operationReviewReceipt.controllerContractSha256 !==
      writeRequest.contractSha256 ||
    operationReviewReceipt.controllerMaterializationReceiptSha256 !==
      writeRequest.materializationReceiptSha256 ||
    operationReviewReceipt.controllerReviewReceiptSha256 !==
      writeRequest.controllerReviewReceiptSha256 ||
    writeReceipt.contractSha256 !== writeRequest.contractSha256 ||
    writeReceipt.materializationReceiptSha256 !==
      writeRequest.materializationReceiptSha256 ||
    readbackReceipt.writeReceiptSha256 !==
      buildControllerReceiptSetSha256([writeReceipt])
  ) {
    return integrity("ROOT_ANCHOR_OPERATION_REVIEW_INVALID");
  }
  return pass();
}
