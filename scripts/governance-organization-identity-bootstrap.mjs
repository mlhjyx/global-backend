#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_ID = /^[0-9a-f]{40}$/;
const FINAL_SPEC_SHA256 =
  "536e376a40d9ef4f49a65bc0224b74d58eb8a2d743fa766aa020397e67279dd4";
const ROOT_DIRECTORY =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher";
const REQUEST_ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/requests";
const OUTPUT_ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/outputs";
const TOOL_ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root";
const RUNTIME_ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime";
const ACCEPTED_LAUNCHER_CONTRACT_SHA256 =
  "7f4ebcb725bf6f87bb32c0ef6da98933c77e0d5de69341e0a5f93171c45bc5a3";

const list = (text) => Object.freeze(text.trim().split(/\s+/));

export const ACCEPTED_INSTALL_INPUT_PATHS = list(`
package.json apps/api/package.json packages/db/package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json
scripts/governance-organization-identity-bootstrap.mjs scripts/governance-organization-identity-bootstrap.spec.mjs .dockerignore .gitignore
`);
export const DEFAULT_ABSENCE_SENTINELS = list(
  `.npmrc .pnpmfile.cjs .pnpmfile.js pnpmfile.cjs pnpmfile.js patches`,
);
export const ALLOWED_ENVIRONMENT_NAMES = list(
  `PATH HOME XDG_CONFIG_HOME XDG_CACHE_HOME COREPACK_HOME PNPM_HOME TMPDIR NPM_CONFIG_USERCONFIG CI LANG LC_ALL`,
);
export const TOOL_LOGICAL_EXPECTATIONS = Object.freeze(
  [
    ["ENV", "posix-env", "EXEC_ONLY", "PINNED_ABSOLUTE_EXECUTABLE"],
    ["NODE", "node", "EXEC_ONLY", "PINNED_ABSOLUTE_EXECUTABLE"],
    ["GIT", "git", "EXEC_ONLY", "PINNED_ABSOLUTE_EXECUTABLE"],
    ["COREPACK_SHIM", "corepack", "HASH_BEFORE_EXEC", "PINNED_SHIM"],
    [
      "COREPACK_LIB_COREPACK_CJS",
      "corepack",
      "HASH_BEFORE_EXEC",
      "PINNED_ENTRYPOINT",
    ],
    ["PNPM_SHIM", "pnpm", "HASH_BEFORE_EXEC", "PINNED_SHIM"],
    ["PNPM_ENTRYPOINT", "pnpm", "HASH_BEFORE_EXEC", "PINNED_ENTRYPOINT"],
  ].map(([role, packageName, loadPolicy, authority]) =>
    Object.freeze({ role, packageName, loadPolicy, authority }),
  ),
);
export const PER_RUN_VARIABLE_FIELD_PATHS = list(`
outputRecordSha256 externalLaunchReceiptSha256 subjectConfigurationSetSha256 subjectAbsenceSentinelSetSha256 subjectGitClosureSha256
environmentValueSetSha256 fixedRootSetSha256 postInstallBootstrapRehashSha256 prismaSchemaSha256 generatedClientSetSha256
generatedDmmfSha256 generatedDelegateSetSha256 generatedOutputSetSha256 typescriptDynamicImportSha256 hostileMarkerSetSha256 prePostToctouSha256
`);
const BOOTSTRAP_RECEIPT_KEYS = list(`
schemaVersion receiptCardinality bootstrapContractSha256 launcherMaterializationReceiptSha256 launcherMaterializationReviewReceiptSha256 requestId
taskId commandId mode closedCommandRequestSha256 inputRecordPath inputRecordUri inputRecordSha256 payloadSchemaSha256 payloadSha256 outputRecordPath
outputRecordSha256 authorizationReceiptSha256 externalControllerReceiptSha256 anchorReceiptSha256 externalLaunchReceiptSha256 acceptedSubjectCommit
subjectConfigurationSetSha256 subjectAbsenceSentinelSetSha256 subjectGitClosureSha256 environmentValueSetSha256 taskRoot taskRootDevice taskRootInode
fixedRootSetSha256 postInstallBootstrapRehashSha256 dependencyDeclarationRoots toolExecutionRoots prismaSchemaSha256 generatedClientSetSha256
generatedDmmfSha256 generatedDelegateSetSha256 generatedOutputSetSha256 typescriptDynamicImportSha256 hostileMarkerSetSha256 hostileMarkerExecutionCount
prePostToctouSha256 startedAt finishedAt result
`);
const TASK_IDS = list(
  `0L 0P 0A 0B 0F 0C 0M 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18`,
);
const LOCAL_COMMAND_IDS = list(`
BOOTSTRAP_AUTHORITY_RUN_V1 SCOPED_REVIEW_VERIFY_V1 CURRENT_MAIN_AUDIT_LOCAL_V1 CURRENT_MAIN_VALIDATE_V1 CURRENT_MAIN_GENERATE_V1
COPY_WRITE_ELIGIBILITY_V1 COPY_SYNC_CITATIONS_V1 GIT_REFRESH_START_V1 GIT_REFRESH_COMMIT_V1 GIT_ADMISSION_COMMIT_V1 GIT_ACCEPTANCE_COMMIT_V1
REFRESH_VERIFY_V1 MIGRATION_STATIC_VERIFY_V1 PRISMA_GENERATE_V1 SCANNER_TEST_V1 SCANNER_BASELINE_V1 SCANNER_STAGE_V1 SCANNER_ZERO_V1
SCANNER_ACCEPTANCE_V1 GOVERNANCE_VERIFY_V1 DOCS_VERIFY_V1 API_VERIFY_V1 RUNTIME_ARTIFACT_VERIFY_V1 CONTRACT_GRAPH_VERIFY_V1 V3_WORKTREE_CREATE_V1
`);
const CONTRACT_KEYS = list(
  `schemaVersion launcherContractSha256 bootstrapSchemaSha256 closedRequestSchemaSha256 effectivePnpmArgvRuleSha256 receiptComparatorSha256 toolLogicalExpectations allowedEnvironmentNames`,
);
const CONTRACT_DIGEST_KEYS = list(
  `launcherContractSha256 bootstrapSchemaSha256 closedRequestSchemaSha256 effectivePnpmArgvRuleSha256 receiptComparatorSha256`,
);
const EXTERNAL_LAUNCH_KEYS = list(
  `schemaVersion requestId commandId mode subjectCommit invocationDescriptorSha256 launcherContractSha256 launchedByExecutableClosureSha256 acceptedAt result`,
);
const TOOL_ROOT_KEYS = list(
  `logicalPackage version lockIntegrity rootRealpathSha256 loadedFileCount loadedFileSetSha256 contentSetSha256 prePostToctouSha256`,
);
const RECEIPT_SHA_KEYS = list(`
bootstrapContractSha256 launcherMaterializationReceiptSha256 launcherMaterializationReviewReceiptSha256 requestId closedCommandRequestSha256
inputRecordSha256 payloadSchemaSha256 payloadSha256 outputRecordSha256 externalLaunchReceiptSha256 subjectConfigurationSetSha256
subjectAbsenceSentinelSetSha256 subjectGitClosureSha256 environmentValueSetSha256 fixedRootSetSha256 postInstallBootstrapRehashSha256
prismaSchemaSha256 generatedClientSetSha256 generatedDmmfSha256 generatedDelegateSetSha256 generatedOutputSetSha256 typescriptDynamicImportSha256
hostileMarkerSetSha256 prePostToctouSha256
`);
const NULLABLE_RECEIPT_SHA_KEYS = list(
  `authorizationReceiptSha256 externalControllerReceiptSha256 anchorReceiptSha256`,
);
const RECEIPT_SET_KEYS = list(
  `schemaVersion taskId subjectCommit receiptCount receipts receiptSetSha256`,
);
const RECEIPT_SET_ENTRY_KEYS = list(
  `requestId commandId requestSha256 receiptSha256`,
);
const REVIEW_RECEIPT_KEYS = list(
  `schemaVersion reviewerClass subjectCommit subjectParentCommit range pathSetSha256 reportSha256 counterexampleSetSha256 finalSpecSha256 critical important verdict containsCredentialValue`,
);

function pass(extra = {}) {
  return { status: "PASS", ...extra };
}
function integrity(code, extra = {}) {
  return { status: "INTEGRITY_ERROR", code, ...extra };
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
function isSha(value) {
  return typeof value === "string" && SHA256.test(value);
}
function isCommit(value) {
  return typeof value === "string" && GIT_ID.test(value);
}
function nullableSha(value) {
  return value === null || isSha(value);
}

function passivePlain(value, seen = new Set()) {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string") return value.normalize("NFC") === value;
  if (type === "number") return Number.isFinite(value);
  if (type === "boolean") return true;
  if (type !== "object" || seen.has(value)) return false;
  seen.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (
      prototype !== Object.prototype &&
      prototype !== null &&
      !Array.isArray(value)
    )
      return false;
    if (Object.getOwnPropertySymbols(value).length !== 0) return false;
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (!("value" in descriptor) || descriptor.get || descriptor.set)
        return false;
      if (!passivePlain(descriptor.value, seen)) return false;
    }
    return true;
  } finally {
    seen.delete(value);
  }
}

function exactKeys(value, keys) {
  if (!passivePlain(value) || value === null || Array.isArray(value))
    return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isAbsoluteNormalized(value) {
  return (
    typeof value === "string" &&
    path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    !value.includes("\0")
  );
}

function digestRule(name, value) {
  return sha256(canonicalJsonBytes({ name, value }));
}

export const BOOTSTRAP_CONTRACT = Object.freeze({
  schemaVersion: "organization-identity-bootstrap-contract/v2",
  launcherContractSha256: ACCEPTED_LAUNCHER_CONTRACT_SHA256,
  bootstrapSchemaSha256: digestRule("bootstrap-schema", {
    receiptKeys: BOOTSTRAP_RECEIPT_KEYS,
    externalLaunchReceipt: "exact-key/v1",
    scopedReviewReceipt: "exact-key/v1",
  }),
  closedRequestSchemaSha256: digestRule("closed-request-schema", {
    commandId: "BOOTSTRAP_AUTHORITY_RUN_V1",
    mode: "INSTALL_AND_PRISMA_GENERATE",
    parameters: {
      frozenLockfile: true,
      ignoreScripts: true,
      ignorePnpmfile: true,
      npmUserConfig: "/dev/null",
    },
  }),
  effectivePnpmArgvRuleSha256: digestRule("effective-pnpm-argv-rule", {
    cwd: "<taskRoot>",
    install: [
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--ignore-pnpmfile",
      "--config.ignore-pnpmfile=true",
      "--config.store-dir",
      "<roots.store>",
      "--config.virtual-store-dir",
      "<roots.virtualStore>",
      "--config.modules-dir",
      "<roots.modules>",
      "--config.cache-dir",
      "<roots.cache>",
      "--config.globalconfig",
      "<roots.config>/globalrc",
      "--config.userconfig",
      "/dev/null",
    ],
    environment: {
      PATH: "/usr/bin:/bin",
      HOME: "<roots.taskHome>",
      XDG_CONFIG_HOME: "<roots.config>",
      XDG_CACHE_HOME: "<roots.cache>",
      COREPACK_HOME: "<roots.cache>/corepack",
      PNPM_HOME: "<roots.cache>/pnpm-home",
      TMPDIR: "<roots.tmp>",
      NPM_CONFIG_USERCONFIG: "/dev/null",
      CI: "1",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    },
    prismaGenerate: ["--filter", "@global/db", "generate"],
  }),
  receiptComparatorSha256: digestRule("receipt-comparator", {
    perRunVariableFieldPaths: PER_RUN_VARIABLE_FIELD_PATHS,
    requestBoundFields: [
      "requestId",
      "taskId",
      "commandId",
      "mode",
      "inputRecordPath",
      "outputRecordPath",
      "acceptedSubjectCommit",
    ],
  }),
  toolLogicalExpectations: TOOL_LOGICAL_EXPECTATIONS,
  allowedEnvironmentNames: ALLOWED_ENVIRONMENT_NAMES,
});

function exactToolExpectation(value, expected) {
  return (
    exactKeys(value, list(`role packageName loadPolicy authority`)) &&
    value.role === expected.role &&
    value.packageName === expected.packageName &&
    value.loadPolicy === expected.loadPolicy &&
    value.authority === expected.authority
  );
}

export function validateBootstrapContract(contract) {
  if (
    !exactKeys(contract, CONTRACT_KEYS) ||
    contract.schemaVersion !== "organization-identity-bootstrap-contract/v2" ||
    canonicalJson(contract) !== canonicalJson(BOOTSTRAP_CONTRACT) ||
    !CONTRACT_DIGEST_KEYS.every((key) => isSha(contract[key])) ||
    !Array.isArray(contract.toolLogicalExpectations) ||
    contract.toolLogicalExpectations.length !==
      TOOL_LOGICAL_EXPECTATIONS.length ||
    !contract.toolLogicalExpectations.every((entry, index) =>
      exactToolExpectation(entry, TOOL_LOGICAL_EXPECTATIONS[index]),
    ) ||
    !Array.isArray(contract.allowedEnvironmentNames) ||
    canonicalJson(contract.allowedEnvironmentNames) !==
      canonicalJson(ALLOWED_ENVIRONMENT_NAMES)
  ) {
    return integrity("BOOTSTRAP_CONTRACT_INVALID");
  }
  return pass({
    bootstrapContractSha256: sha256(canonicalJsonBytes(contract)),
  });
}

export function validateExternalLaunchReceipt(receipt, request) {
  if (
    !exactKeys(receipt, EXTERNAL_LAUNCH_KEYS) ||
    receipt.schemaVersion !==
      "organization-identity-external-launch-receipt/v1" ||
    !isSha(receipt.requestId) ||
    !LOCAL_COMMAND_IDS.includes(receipt.commandId) ||
    !isCommit(receipt.subjectCommit) ||
    !isSha(receipt.invocationDescriptorSha256) ||
    !isSha(receipt.launcherContractSha256) ||
    !isSha(receipt.launchedByExecutableClosureSha256) ||
    !Number.isFinite(Date.parse(receipt.acceptedAt)) ||
    receipt.result !== "PASS"
  ) {
    return integrity("EXTERNAL_LAUNCH_RECEIPT_INVALID");
  }
  if (
    request &&
    (receipt.requestId !== request.requestId ||
      receipt.commandId !== request.commandId ||
      receipt.mode !== request.mode ||
      receipt.subjectCommit !== request.subjectCommit ||
      receipt.launcherContractSha256 !==
        BOOTSTRAP_CONTRACT.launcherContractSha256)
  ) {
    return integrity("EXTERNAL_LAUNCH_RECEIPT_BINDING_INVALID");
  }
  return pass({
    externalLaunchReceiptSha256: sha256(canonicalJsonBytes(receipt)),
  });
}

function validateToolRootReceipt(receipt) {
  return (
    exactKeys(receipt, TOOL_ROOT_KEYS) &&
    typeof receipt.logicalPackage === "string" &&
    receipt.logicalPackage.length > 0 &&
    typeof receipt.version === "string" &&
    receipt.version.length > 0 &&
    typeof receipt.lockIntegrity === "string" &&
    receipt.lockIntegrity.length > 0 &&
    isSha(receipt.rootRealpathSha256) &&
    Number.isSafeInteger(receipt.loadedFileCount) &&
    receipt.loadedFileCount >= 0 &&
    isSha(receipt.loadedFileSetSha256) &&
    isSha(receipt.contentSetSha256) &&
    isSha(receipt.prePostToctouSha256)
  );
}

export function buildBootstrapRunReceipt(input) {
  const { request } = input;
  const startedAt = input.startedAt ?? new Date().toISOString();
  const finishedAt = input.finishedAt ?? startedAt;
  return {
    schemaVersion: "organization-identity-bootstrap-run/v2",
    receiptCardinality: "ONE_COMMAND_ONE_RECEIPT",
    bootstrapContractSha256: request.bootstrapContractSha256,
    launcherMaterializationReceiptSha256:
      request.launcherMaterializationReceiptSha256,
    launcherMaterializationReviewReceiptSha256:
      request.launcherMaterializationReviewReceiptSha256,
    requestId: request.requestId,
    taskId: request.taskId,
    commandId: request.commandId,
    mode: request.mode,
    closedCommandRequestSha256: sha256(canonicalJsonBytes(request)),
    inputRecordPath: request.input.inputRecordPath,
    inputRecordUri: request.input.inputRecordUri,
    inputRecordSha256: request.input.inputRecordSha256,
    payloadSchemaSha256: request.input.payloadSchemaSha256,
    payloadSha256: request.input.payloadSha256,
    outputRecordPath: request.input.outputRecordPath,
    outputRecordSha256: input.outputRecordSha256,
    authorizationReceiptSha256: request.authorizationReceiptSha256,
    externalControllerReceiptSha256: request.externalControllerReceiptSha256,
    anchorReceiptSha256: request.anchorReceiptSha256,
    externalLaunchReceiptSha256: input.externalLaunchReceiptSha256,
    acceptedSubjectCommit: request.subjectCommit,
    subjectConfigurationSetSha256: input.subjectConfigurationSetSha256,
    subjectAbsenceSentinelSetSha256: input.subjectAbsenceSentinelSetSha256,
    subjectGitClosureSha256: input.subjectGitClosureSha256,
    environmentValueSetSha256: input.environmentValueSetSha256,
    taskRoot: input.taskRoot,
    taskRootDevice: input.taskRootDevice,
    taskRootInode: input.taskRootInode,
    fixedRootSetSha256: input.fixedRootSetSha256,
    postInstallBootstrapRehashSha256: input.postInstallBootstrapRehashSha256,
    dependencyDeclarationRoots: input.dependencyDeclarationRoots ?? [],
    toolExecutionRoots: input.toolExecutionRoots ?? [],
    prismaSchemaSha256: input.prismaSchemaSha256,
    generatedClientSetSha256: input.generatedClientSetSha256,
    generatedDmmfSha256: input.generatedDmmfSha256,
    generatedDelegateSetSha256: input.generatedDelegateSetSha256,
    generatedOutputSetSha256: input.generatedOutputSetSha256,
    typescriptDynamicImportSha256: input.typescriptDynamicImportSha256,
    hostileMarkerSetSha256: input.hostileMarkerSetSha256,
    hostileMarkerExecutionCount: input.hostileMarkerExecutionCount ?? 0,
    prePostToctouSha256: input.prePostToctouSha256,
    startedAt,
    finishedAt,
    result: input.result ?? "PASS",
  };
}

export function validateBootstrapRunReceipt(receipt, request) {
  if (!request) return integrity("BOOTSTRAP_RECEIPT_PREDECESSOR_REQUIRED");
  if (
    !exactKeys(receipt, BOOTSTRAP_RECEIPT_KEYS) ||
    receipt.schemaVersion !== "organization-identity-bootstrap-run/v2" ||
    receipt.receiptCardinality !== "ONE_COMMAND_ONE_RECEIPT" ||
    receipt.result !== "PASS" ||
    receipt.hostileMarkerExecutionCount !== 0 ||
    !Array.isArray(receipt.dependencyDeclarationRoots) ||
    !receipt.dependencyDeclarationRoots.every(validateToolRootReceipt) ||
    !Array.isArray(receipt.toolExecutionRoots) ||
    !receipt.toolExecutionRoots.every(validateToolRootReceipt)
  ) {
    return integrity("BOOTSTRAP_RECEIPT_INVALID");
  }
  for (const key of RECEIPT_SHA_KEYS) {
    if (!isSha(receipt[key])) return integrity("BOOTSTRAP_RECEIPT_INVALID");
  }
  for (const key of NULLABLE_RECEIPT_SHA_KEYS) {
    if (!nullableSha(receipt[key]))
      return integrity("BOOTSTRAP_RECEIPT_INVALID");
  }
  if (
    !isCommit(receipt.acceptedSubjectCommit) ||
    !TASK_IDS.includes(receipt.taskId) ||
    !LOCAL_COMMAND_IDS.includes(receipt.commandId) ||
    !isAbsoluteNormalized(receipt.inputRecordPath) ||
    !isAbsoluteNormalized(receipt.outputRecordPath) ||
    !isAbsoluteNormalized(receipt.taskRoot) ||
    receipt.inputRecordUri !== `sha256:${receipt.inputRecordSha256}` ||
    typeof receipt.taskRootDevice !== "string" ||
    typeof receipt.taskRootInode !== "string" ||
    !Number.isFinite(Date.parse(receipt.startedAt)) ||
    !Number.isFinite(Date.parse(receipt.finishedAt)) ||
    Date.parse(receipt.startedAt) > Date.parse(receipt.finishedAt)
  ) {
    return integrity("BOOTSTRAP_RECEIPT_INVALID");
  }
  const pairs = [
    [receipt.bootstrapContractSha256, request.bootstrapContractSha256],
    [
      receipt.launcherMaterializationReceiptSha256,
      request.launcherMaterializationReceiptSha256,
    ],
    [
      receipt.launcherMaterializationReviewReceiptSha256,
      request.launcherMaterializationReviewReceiptSha256,
    ],
    [receipt.requestId, request.requestId],
    [receipt.taskId, request.taskId],
    [receipt.commandId, request.commandId],
    [receipt.mode, request.mode],
    [receipt.inputRecordPath, request.input.inputRecordPath],
    [receipt.inputRecordUri, request.input.inputRecordUri],
    [receipt.inputRecordSha256, request.input.inputRecordSha256],
    [receipt.payloadSchemaSha256, request.input.payloadSchemaSha256],
    [receipt.payloadSha256, request.input.payloadSha256],
    [receipt.outputRecordPath, request.input.outputRecordPath],
    [receipt.authorizationReceiptSha256, request.authorizationReceiptSha256],
    [
      receipt.externalControllerReceiptSha256,
      request.externalControllerReceiptSha256,
    ],
    [receipt.anchorReceiptSha256, request.anchorReceiptSha256],
    [receipt.acceptedSubjectCommit, request.subjectCommit],
    [receipt.closedCommandRequestSha256, sha256(canonicalJsonBytes(request))],
  ];
  if (pairs.some(([actual, expected]) => actual !== expected)) {
    return integrity("BOOTSTRAP_RECEIPT_BINDING_INVALID");
  }
  return pass();
}

export function materializeBootstrapRunReceiptSet(
  taskId,
  subjectCommit,
  records,
) {
  const receipts = records
    .map(({ request, receipt }) => ({
      requestId: request.requestId,
      commandId: request.commandId,
      requestSha256: sha256(canonicalJsonBytes(request)),
      receiptSha256: sha256(canonicalJsonBytes(receipt)),
    }))
    .sort((left, right) => left.requestId.localeCompare(right.requestId));
  return {
    schemaVersion: "organization-identity-bootstrap-run-set/v1",
    taskId,
    subjectCommit,
    receiptCount: receipts.length,
    receipts,
    receiptSetSha256: sha256(canonicalJsonBytes(receipts)),
  };
}

export function validateBootstrapRunReceiptSet(receiptSet, records) {
  if (
    !Array.isArray(records) ||
    !exactKeys(receiptSet, RECEIPT_SET_KEYS) ||
    receiptSet.schemaVersion !== "organization-identity-bootstrap-run-set/v1" ||
    !TASK_IDS.includes(receiptSet.taskId) ||
    !isCommit(receiptSet.subjectCommit) ||
    !Number.isSafeInteger(receiptSet.receiptCount) ||
    !Array.isArray(receiptSet.receipts) ||
    receiptSet.receiptCount !== receiptSet.receipts.length ||
    records.length !== receiptSet.receiptCount ||
    !isSha(receiptSet.receiptSetSha256)
  ) {
    return integrity("BOOTSTRAP_RECEIPT_SET_INVALID");
  }
  const requestIds = [];
  const receiptIds = [];
  for (let index = 0; index < records.length; index += 1) {
    const entry = receiptSet.receipts[index];
    const record = records[index];
    if (
      !exactKeys(entry, RECEIPT_SET_ENTRY_KEYS) ||
      validateBootstrapRunReceipt(record.receipt, record.request).status !==
        "PASS" ||
      entry.requestId !== record.request.requestId ||
      entry.commandId !== record.request.commandId ||
      entry.requestSha256 !== sha256(canonicalJsonBytes(record.request)) ||
      entry.receiptSha256 !== sha256(canonicalJsonBytes(record.receipt))
    ) {
      return integrity("BOOTSTRAP_RECEIPT_SET_BINDING_INVALID");
    }
    requestIds.push(entry.requestId);
    receiptIds.push(entry.receiptSha256);
  }
  if (
    new Set(requestIds).size !== requestIds.length ||
    new Set(receiptIds).size !== receiptIds.length
  ) {
    return integrity("BOOTSTRAP_RECEIPT_REPLAY");
  }
  const sorted = [...receiptSet.receipts].sort((left, right) =>
    left.requestId.localeCompare(right.requestId),
  );
  if (
    canonicalJson(sorted) !== canonicalJson(receiptSet.receipts) ||
    receiptSet.receiptSetSha256 !==
      sha256(canonicalJsonBytes(receiptSet.receipts))
  ) {
    return integrity("BOOTSTRAP_RECEIPT_SET_INVALID");
  }
  return pass();
}

export function compareRunToAcceptedContract(contract, receipt, request) {
  const validatedContract = validateBootstrapContract(contract);
  if (validatedContract.status !== "PASS") {
    return integrity("BOOTSTRAP_CONTRACT_INVALID");
  }
  if (validateBootstrapRunReceipt(receipt, request).status !== "PASS") {
    return integrity("BOOTSTRAP_RECEIPT_INVALID");
  }
  if (
    validatedContract.bootstrapContractSha256 !==
      request.bootstrapContractSha256 ||
    validatedContract.bootstrapContractSha256 !==
      receipt.bootstrapContractSha256
  ) {
    return integrity("BOOTSTRAP_CONTRACT_BINDING_INVALID");
  }
  if (receipt.hostileMarkerExecutionCount !== 0) {
    return integrity("BOOTSTRAP_HOSTILE_MARKER_EXECUTED");
  }
  return pass();
}

function rejectUnsafeRelative(repoPath) {
  if (
    typeof repoPath !== "string" ||
    repoPath.length === 0 ||
    repoPath.startsWith("/") ||
    repoPath.includes("\0") ||
    repoPath.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new Error("REPOSITORY_PATH_INVALID");
  }
}

function gitBytes(repoRoot, subjectCommit, repoPath) {
  rejectUnsafeRelative(repoPath);
  const ref = `${subjectCommit}:${repoPath}`;
  const result = spawnSync("git", ["-C", repoRoot, "show", ref], {
    encoding: "buffer",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

function gitHasPath(repoRoot, subjectCommit, repoPath) {
  rejectUnsafeRelative(repoPath);
  const result = spawnSync(
    "git",
    ["-C", repoRoot, "cat-file", "-e", `${subjectCommit}:${repoPath}`],
    {
      encoding: "utf8",
    },
  );
  return result.status === 0;
}

function assertInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error("ROOT_CONTAINMENT_INVALID");
  }
}

function rejectSymlinkAncestors(root, target) {
  const dirs = [];
  for (
    let current = path.dirname(target);
    current !== root;
    current = path.dirname(current)
  ) {
    if (current === path.dirname(current))
      throw new Error("ROOT_CONTAINMENT_INVALID");
    dirs.push(current);
  }
  for (const dir of dirs.reverse())
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink())
      throw new Error("MATERIALIZATION_SYMLINK_ANCESTOR");
}

function rejectAbsoluteSymlinkAncestors(target) {
  const resolvedTarget = path.resolve(target);
  const { root } = path.parse(resolvedTarget);
  const dirs = [];
  for (
    let current = path.dirname(resolvedTarget);
    current !== root;
    current = path.dirname(current)
  ) {
    dirs.push(current);
  }
  for (const dir of dirs.reverse())
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink())
      throw new Error("PATH_SYMLINK_ANCESTOR");
}

export async function verifyBootstrapPreimage({
  repoRoot,
  subjectCommit,
  acceptedInputPaths = ACCEPTED_INSTALL_INPUT_PATHS,
  acceptedAbsentPaths = DEFAULT_ABSENCE_SENTINELS,
} = {}) {
  if (!isAbsoluteNormalized(repoRoot) || !isCommit(subjectCommit)) {
    return integrity("BOOTSTRAP_PREIMAGE_REQUEST_INVALID");
  }
  try {
    const tracked = [];
    for (const repoPath of acceptedInputPaths) {
      const bytes = gitBytes(repoRoot, subjectCommit, repoPath);
      if (!bytes) return integrity("ACCEPTED_GIT_BLOB_MISSING", { repoPath });
      const current = path.join(repoRoot, repoPath);
      if (existsSync(current)) {
        const lst = lstatSync(current);
        if (lst.isSymbolicLink())
          return integrity("ACCEPTED_INPUT_SYMLINK", { repoPath });
      }
      tracked.push({ path: repoPath, sha256: sha256(bytes) });
    }
    const absent = [];
    for (const repoPath of acceptedAbsentPaths) {
      if (
        gitHasPath(repoRoot, subjectCommit, repoPath) ||
        existsSync(path.join(repoRoot, repoPath))
      ) {
        return integrity("ACCEPTED_ABSENCE_SENTINEL_PRESENT", { repoPath });
      }
      absent.push(repoPath);
    }
    return pass({
      subjectConfigurationSetSha256: sha256(canonicalJsonBytes(tracked)),
      subjectAbsenceSentinelSetSha256: sha256(canonicalJsonBytes(absent)),
      subjectGitClosureSha256: sha256(
        canonicalJsonBytes({ subjectCommit, tracked, absent }),
      ),
    });
  } catch (error) {
    return integrity("BOOTSTRAP_PREIMAGE_UNAVAILABLE", {
      reason: error.message,
    });
  }
}

export async function materializeAcceptedInstallInputs({
  repoRoot,
  subjectCommit,
  taskRoot,
  acceptedInputPaths = ACCEPTED_INSTALL_INPUT_PATHS,
  acceptedAbsentPaths = DEFAULT_ABSENCE_SENTINELS,
} = {}) {
  const preimage = await verifyBootstrapPreimage({
    repoRoot,
    subjectCommit,
    acceptedInputPaths,
    acceptedAbsentPaths,
  });
  if (preimage.status !== "PASS") return preimage;
  if (!isAbsoluteNormalized(taskRoot)) return integrity("TASK_ROOT_INVALID");
  try {
    mkdirSync(taskRoot, { recursive: true, mode: 0o700 });
    const taskReal = realpathSync(taskRoot);
    if (lstatSync(taskRoot).isSymbolicLink())
      return integrity("TASK_ROOT_SYMLINK");
    for (const repoPath of acceptedInputPaths) {
      const bytes = gitBytes(repoRoot, subjectCommit, repoPath);
      const target = path.join(taskRoot, repoPath);
      assertInside(taskReal, target);
      rejectSymlinkAncestors(taskReal, target);
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
    }
    return pass({
      ...preimage,
      taskRoot: taskReal,
      fixedRootSetSha256: sha256(canonicalJsonBytes({ taskRoot: taskReal })),
    });
  } catch (error) {
    return integrity("MATERIALIZATION_FAILED", { reason: error.message });
  }
}

function cleanRoots(taskRoot) {
  return {
    store: path.join(taskRoot, ".bootstrap", "store"),
    virtualStore: path.join(taskRoot, "node_modules", ".pnpm"),
    modules: path.join(taskRoot, "node_modules"),
    cache: path.join(taskRoot, ".bootstrap", "cache"),
    config: path.join(taskRoot, ".bootstrap", "config"),
    taskHome: path.join(taskRoot, ".bootstrap", "home"),
    tmp: path.join(taskRoot, ".bootstrap", "tmp"),
    declarations: path.join(taskRoot, ".bootstrap", "declarations"),
    tools: path.join(taskRoot, ".bootstrap", "tools"),
    outputs: path.join(taskRoot, ".bootstrap", "outputs"),
  };
}

function cleanEnvironment(taskRoot) {
  const roots = cleanRoots(taskRoot);
  return {
    PATH: "/usr/bin:/bin",
    HOME: roots.taskHome,
    XDG_CONFIG_HOME: roots.config,
    XDG_CACHE_HOME: roots.cache,
    COREPACK_HOME: path.join(roots.cache, "corepack"),
    PNPM_HOME: path.join(roots.cache, "pnpm-home"),
    TMPDIR: roots.tmp,
    NPM_CONFIG_USERCONFIG: "/dev/null",
    CI: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
}

export function verifyDependencyAndToolRoots({
  taskRoot,
  roots = cleanRoots(taskRoot),
  environment = {},
} = {}) {
  if (!isAbsoluteNormalized(taskRoot)) return integrity("TASK_ROOT_INVALID");
  try {
    const realTaskRoot = realpathSync(taskRoot);
    const expectedRoots = cleanRoots(realTaskRoot);
    if (canonicalJson(roots) !== canonicalJson(expectedRoots)) {
      return integrity("FIXED_ROOT_DRIFT");
    }
    const expectedEnvironment = cleanEnvironment(realTaskRoot);
    if (
      ["NODE_OPTIONS", "NODE_PATH"].some((name) =>
        Object.hasOwn(environment, name),
      )
    ) {
      return integrity("NODE_LOADER_ENVIRONMENT_FORBIDDEN");
    }
    for (const name of [
      "HOME",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "TMPDIR",
      "NPM_CONFIG_USERCONFIG",
    ]) {
      if (
        Object.hasOwn(environment, name) &&
        environment[name] !== expectedEnvironment[name]
      ) {
        return integrity("FIXED_ENVIRONMENT_DRIFT", { name });
      }
    }
    for (const [name, root] of Object.entries(roots)) {
      if (!isAbsoluteNormalized(root))
        return integrity("FIXED_ROOT_INVALID", { name });
      assertInside(realTaskRoot, root);
      rejectSymlinkAncestors(realTaskRoot, root);
      if (existsSync(root)) {
        const lst = lstatSync(root);
        if (lst.isSymbolicLink())
          return integrity("FIXED_ROOT_SYMLINK", { name });
      }
    }
    return pass({
      fixedRootSetSha256: sha256(
        canonicalJsonBytes({ taskRoot: realTaskRoot, roots }),
      ),
    });
  } catch (error) {
    return integrity("FIXED_ROOT_INVALID", { reason: error.message });
  }
}

export function planAcceptedBootstrapCommand({
  taskRoot,
  pnpmEntrypoint,
} = {}) {
  if (!isAbsoluteNormalized(taskRoot) || !isAbsoluteNormalized(pnpmEntrypoint))
    throw new Error("BOOTSTRAP_COMMAND_REQUEST_INVALID");
  const realTaskRoot = realpathSync(taskRoot);
  const roots = cleanRoots(realTaskRoot);
  const environment = cleanEnvironment(realTaskRoot);
  const verified = verifyDependencyAndToolRoots({
    taskRoot: realTaskRoot,
    roots,
    environment,
  });
  if (verified.status !== "PASS") throw new Error(verified.code);
  for (const root of Object.values(roots))
    mkdirSync(root, { recursive: true, mode: 0o700 });
  return {
    command: "BOOTSTRAP_AUTHORITY_RUN_V1",
    cwd: realTaskRoot,
    argv: [
      pnpmEntrypoint,
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--ignore-pnpmfile",
      "--config.ignore-pnpmfile=true",
      "--config.store-dir",
      roots.store,
      "--config.virtual-store-dir",
      roots.virtualStore,
      "--config.modules-dir",
      roots.modules,
      "--config.cache-dir",
      roots.cache,
      "--config.globalconfig",
      path.join(roots.config, "globalrc"),
      "--config.userconfig",
      "/dev/null",
    ],
    environment,
    roots,
    hostileMarkerExecutionCount: 0,
    execution: "DATA_ONLY_NOT_EXECUTED",
  };
}

export function runAcceptedPrismaGenerate({ taskRoot, pnpmEntrypoint } = {}) {
  if (!isAbsoluteNormalized(taskRoot) || !isAbsoluteNormalized(pnpmEntrypoint))
    throw new Error("PRISMA_GENERATE_REQUEST_INVALID");
  const realTaskRoot = realpathSync(taskRoot);
  const environment = cleanEnvironment(realTaskRoot);
  return {
    command: "PRISMA_GENERATE_V1",
    cwd: realTaskRoot,
    argv: [pnpmEntrypoint, "--filter", "@global/db", "generate"],
    environment,
    roots: cleanRoots(realTaskRoot),
    hostileMarkerExecutionCount: 0,
    execution: "DATA_ONLY_NOT_EXECUTED",
  };
}

export async function verifyPostInstallBootstrapRehash({
  bootstrapPath,
  expectedSha256,
} = {}) {
  if (!isAbsoluteNormalized(bootstrapPath) || !isSha(expectedSha256)) {
    return integrity("BOOTSTRAP_REHASH_REQUEST_INVALID");
  }
  let fd;
  try {
    rejectAbsoluteSymlinkAncestors(bootstrapPath);
    const beforeLink = lstatSync(bootstrapPath);
    if (beforeLink.isSymbolicLink()) {
      return integrity("BOOTSTRAP_REHASH_SYMLINK");
    }
    const beforeRealpath = realpathSync(bootstrapPath);
    fd = openSync(bootstrapPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (before.dev !== beforeLink.dev || before.ino !== beforeLink.ino) {
      return integrity("BOOTSTRAP_REHASH_TOCTOU");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const afterLink = lstatSync(bootstrapPath);
    const afterRealpath = realpathSync(bootstrapPath);
    const digest = sha256(bytes);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.dev !== afterLink.dev ||
      before.ino !== afterLink.ino ||
      beforeRealpath !== afterRealpath
    ) {
      return integrity("BOOTSTRAP_REHASH_TOCTOU");
    }
    if (digest !== expectedSha256) return integrity("BOOTSTRAP_REHASH_DRIFT");
    const bootstrapRealpathSha256 = sha256(Buffer.from(afterRealpath, "utf8"));
    return pass({
      bootstrapSha256: digest,
      bootstrapRealpathSha256,
      bootstrapDevice: String(after.dev),
      bootstrapInode: String(after.ino),
      postInstallBootstrapRehashSha256: sha256(
        canonicalJsonBytes({
          path: bootstrapPath,
          realpathSha256: bootstrapRealpathSha256,
          dev: String(after.dev),
          ino: String(after.ino),
          sha256: digest,
        }),
      ),
    });
  } catch (error) {
    return integrity("BOOTSTRAP_REHASH_UNAVAILABLE", { reason: error.message });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function loadAcceptedScanner({
  modulePath,
  expectedSha256,
  importer,
} = {}) {
  if (!isAbsoluteNormalized(modulePath) || !isSha(expectedSha256)) {
    return integrity("SCANNER_IMPORT_REQUEST_INVALID");
  }
  const bytes = await readFile(modulePath);
  const digest = sha256(bytes);
  if (digest !== expectedSha256) return integrity("SCANNER_IMPORT_DRIFT");
  const dynamicImporter = importer ?? ((specifier) => import(specifier));
  const module = await dynamicImporter(pathToFileURL(modulePath).href);
  return pass({
    module,
    typescriptDynamicImportSha256: sha256(
      canonicalJsonBytes({ modulePath, sha256: digest }),
    ),
  });
}

function parseSeverityLines(reportBytes) {
  const text = reportBytes.toString("utf8");
  const critical = text.match(/^Critical: .+$/gm) ?? [];
  const important = text.match(/^Important: .+$/gm) ?? [];
  const verdict = text.match(/^Verdict: .+$/gm) ?? [];
  if (critical.length !== 1 || important.length !== 1 || verdict.length !== 1) {
    return null;
  }
  return {
    critical: critical[0] === "Critical: 0" ? 0 : Number.NaN,
    important: important[0] === "Important: 0" ? 0 : Number.NaN,
    verdict: verdict[0].slice("Verdict: ".length),
  };
}

export async function verifyReviewReceipt({
  reportPath,
  receipt,
  subjectCommit,
} = {}) {
  if (!isAbsoluteNormalized(reportPath) || !isCommit(subjectCommit)) {
    return integrity("REVIEW_REQUEST_INVALID");
  }
  if (
    !exactKeys(receipt, REVIEW_RECEIPT_KEYS) ||
    receipt.schemaVersion !==
      "organization-identity-bootstrap-scoped-review/v1" ||
    receipt.reviewerClass !== "INDEPENDENT_BOOTSTRAP_REVIEW" ||
    receipt.subjectCommit !== subjectCommit ||
    !isCommit(receipt.subjectParentCommit) ||
    receipt.range !==
      `${receipt.subjectParentCommit}..${receipt.subjectCommit}` ||
    !isSha(receipt.pathSetSha256) ||
    !isSha(receipt.reportSha256) ||
    !isSha(receipt.counterexampleSetSha256) ||
    receipt.finalSpecSha256 !== FINAL_SPEC_SHA256 ||
    receipt.critical !== 0 ||
    receipt.important !== 0 ||
    receipt.verdict !== "PASS" ||
    receipt.containsCredentialValue !== false
  ) {
    return integrity("BOOTSTRAP_REVIEW_RECEIPT_INVALID");
  }
  const reportBytes = await readFile(reportPath);
  const severities = parseSeverityLines(reportBytes);
  if (
    !severities ||
    severities.critical !== 0 ||
    severities.important !== 0 ||
    severities.verdict !== "PASS" ||
    sha256(reportBytes) !== receipt.reportSha256
  ) {
    return integrity("BOOTSTRAP_REVIEW_REPORT_INVALID");
  }
  return pass({ reviewReceiptSha256: sha256(canonicalJsonBytes(receipt)) });
}

async function cli(argv) {
  const [command, ...rest] = argv;
  if (command !== "verify-review") {
    return { status: "USAGE_ERROR", code: "UNKNOWN_COMMAND" };
  }
  const args = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    args.set(rest[index], rest[index + 1]);
  }
  const receiptPath = args.get("--receipt");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  return verifyReviewReceipt({
    reportPath: path.resolve(args.get("--report")),
    receipt,
    subjectCommit: args.get("--subject"),
  });
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) ===
    realpathSync(new URL(import.meta.url).pathname)
) {
  const result = await cli(process.argv.slice(2));
  if (result.status === "PASS") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  }
  process.stderr.write(`${JSON.stringify(result)}\n`);
  process.exit(1);
}
