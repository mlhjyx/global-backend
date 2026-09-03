import { createHash } from "node:crypto";
import path from "node:path";

const REQUEST_SCHEMA_VERSION =
  "organization-identity-closed-command-request/v2";
const ROOT_DIRECTORY =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher";
const DEFAULT_REQUEST_ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/requests";
const DEFAULT_OUTPUT_ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/outputs";
export const APPROVED_PLAN = Object.freeze({
  path: "docs/superpowers/plans/2026-09-01-organization-identity-writer-ban-at-source.md",
  commit: "543c9416b4bc18be4bde37825f4fcd74a78c229c",
  blobId: "ff6a8dd57f90b2a95b6a32e4ea2bd4ca8f6bcf8c",
  sha256: "05bf739511871466a57a002031930da1166fa4f40c71390bafb2f38421b811f9",
});
export const APPROVED_SPEC = Object.freeze({
  path: "docs/superpowers/specs/2026-09-01-organization-identity-writer-ban-at-source-design.md",
  commit: "b060c5dd4afef9fe42dfe510b02f930f56cdf7fe",
  blobId: "98891bcab636b852e71919b7de77343647917017",
  sha256: "536e376a40d9ef4f49a65bc0224b74d58eb8a2d743fa766aa020397e67279dd4",
});

export const LOCAL_COMMAND_IDS = Object.freeze([
  "BOOTSTRAP_AUTHORITY_RUN_V1",
  "SCOPED_REVIEW_VERIFY_V1",
  "CURRENT_MAIN_AUDIT_LOCAL_V1",
  "CURRENT_MAIN_VALIDATE_V1",
  "CURRENT_MAIN_GENERATE_V1",
  "COPY_WRITE_ELIGIBILITY_V1",
  "COPY_SYNC_CITATIONS_V1",
  "GIT_REFRESH_START_V1",
  "GIT_REFRESH_COMMIT_V1",
  "GIT_ADMISSION_COMMIT_V1",
  "GIT_ACCEPTANCE_COMMIT_V1",
  "REFRESH_VERIFY_V1",
  "MIGRATION_STATIC_VERIFY_V1",
  "PRISMA_GENERATE_V1",
  "SCANNER_TEST_V1",
  "SCANNER_BASELINE_V1",
  "SCANNER_STAGE_V1",
  "SCANNER_ZERO_V1",
  "SCANNER_ACCEPTANCE_V1",
  "GOVERNANCE_VERIFY_V1",
  "DOCS_VERIFY_V1",
  "API_VERIFY_V1",
  "RUNTIME_ARTIFACT_VERIFY_V1",
  "CONTRACT_GRAPH_VERIFY_V1",
  "V3_WORKTREE_CREATE_V1",
]);

export const ALLOWED_ENVIRONMENT_NAMES = Object.freeze([
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "COREPACK_HOME",
  "PNPM_HOME",
  "TMPDIR",
  "NPM_CONFIG_USERCONFIG",
  "CI",
  "LANG",
  "LC_ALL",
]);

const TASK_IDS = Object.freeze([
  "0L",
  "0P",
  "0A",
  "0B",
  "0F",
  "0C",
  "0M",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
  "13",
  "14",
  "15",
  "16",
  "17",
  "18",
]);

const EXECUTABLE_ROLES = Object.freeze([
  "ENV",
  "NODE",
  "GIT",
  "COREPACK_SHIM",
  "COREPACK_LIB_COREPACK_CJS",
  "PNPM_SHIM",
  "PNPM_ENTRYPOINT",
]);

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_ID = /^[0-9a-f]{40}$/;

function pass(extra = {}) {
  return { status: "PASS", ...extra };
}

function integrity(code) {
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isSha(value) {
  return typeof value === "string" && SHA256.test(value);
}

function isCommit(value) {
  return typeof value === "string" && GIT_ID.test(value);
}

function isAbsoluteNormalized(value) {
  return (
    typeof value === "string" &&
    path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    !value.includes("\0")
  );
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
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === "length") continue;
        if (!("value" in descriptor) || descriptor.get || descriptor.set)
          return false;
        if (!passivePlain(descriptor.value, seen)) return false;
      }
      return Object.keys(value).every((key, index) => key === String(index));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(value).length !== 0) return false;
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (!("value" in descriptor) || descriptor.get || descriptor.set)
        return false;
      if (!passivePlain(descriptor.value, seen)) return false;
    }
    return true;
  } catch {
    return false;
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

function cloneNullPrototype(value) {
  if (Array.isArray(value)) return value.map(cloneNullPrototype);
  if (value === null || typeof value !== "object") return value;
  const result = Object.create(null);
  for (const [key, child] of Object.entries(value)) {
    result[key] = cloneNullPrototype(child);
  }
  return result;
}

function enumValue(value, allowed) {
  return typeof value === "string" && allowed.includes(value);
}

function nullableSha(value) {
  return value === null || isSha(value);
}

function exactObject(value, keys, predicates) {
  if (!exactKeys(value, keys)) return false;
  return Object.entries(predicates).every(([key, predicate]) =>
    predicate(value[key]),
  );
}

const scannerCommon = {
  baselineSubjectCommit: isCommit,
  currentMainAdmissionCommit: isCommit,
  b0mMigrationCommit: isCommit,
};

const scannerTestSuites = [
  "B0_SCANNER",
  "DELEGATE_ENGINE",
  "RAW_CLOSURE",
  "STAGE_SECURITY",
  "B0_BASELINE",
  "B0_ACCEPTANCE",
  "B1_TEMPORAL",
  "B2_TEMPORAL",
  "B3_PROJECTION",
  "B4_PROJECTION",
  "B4M_MATERIALIZATION",
  "B5_ZERO",
  "B6_CLOSEOUT",
];
const stages = [
  "B0_BASELINE",
  "B1_TEMPORAL_RED",
  "B2_TEMPORAL_CUTOVER",
  "B3_PROJECTION_RED",
  "B4_PROJECTION_CUTOVER",
  "B4M_MATERIALIZATION_CUTOVER",
  "B5_ZERO_GATE",
  "B6_CLOSEOUT",
];

function schema(modes, predicates) {
  return Object.freeze({
    modes: Object.freeze(modes),
    keys: Object.freeze(Object.keys(predicates)),
    predicates: Object.freeze(predicates),
  });
}

const COMMAND_REGISTRY = Object.freeze({
  BOOTSTRAP_AUTHORITY_RUN_V1: schema(["INSTALL_AND_PRISMA_GENERATE"], {
    frozenLockfile: (value) => value === true,
    ignoreScripts: (value) => value === true,
    ignorePnpmfile: (value) => value === true,
    npmUserConfig: (value) => value === "/dev/null",
  }),
  SCOPED_REVIEW_VERIFY_V1: schema(["VERIFY"], {
    reportPath: isAbsoluteNormalized,
    reportSha256: isSha,
    receiptPath: isAbsoluteNormalized,
    receiptSha256: isSha,
    reviewedSubjectCommit: isCommit,
  }),
  CURRENT_MAIN_AUDIT_LOCAL_V1: schema(["COLLECT_LOCAL_FACTS"], {
    branchPreRefreshCommit: isCommit,
    advertisedLiveMainCommit: isCommit,
    githubControllerReceiptSha256: isSha,
  }),
  CURRENT_MAIN_VALIDATE_V1: schema(["VALIDATE"], {
    auditPacketSha256: isSha,
    auditReviewReceiptSha256: isSha,
    refreshMergeCommit: (value) => value === null || isCommit(value),
    admissionPath: (value) =>
      value ===
      "docs/governance/organization-identity-current-main-admission.json",
  }),
  CURRENT_MAIN_GENERATE_V1: schema(["GENERATE"], {
    auditPacketSha256: isSha,
    auditReviewReceiptSha256: isSha,
    refreshMergeCommit: isCommit,
    admissionPath: (value) =>
      value ===
      "docs/governance/organization-identity-current-main-admission.json",
  }),
  COPY_WRITE_ELIGIBILITY_V1: schema(["WRITE_ELIGIBILITY"], {
    auditPacketSha256: isSha,
    eligibilityPath: (value) =>
      value === "docs/evidence/site-builder/copy-runtime-eligibility.json",
  }),
  COPY_SYNC_CITATIONS_V1: schema(["SYNC_CITATIONS"], {
    auditPacketSha256: isSha,
    eligibilityPath: (value) =>
      value === "docs/evidence/site-builder/copy-runtime-eligibility.json",
    eligibilityInputSha256: isSha,
    citationPath: (value) =>
      value ===
      "docs/implementation-records/copy-fixed-source-impact-governance.md",
  }),
  GIT_REFRESH_START_V1: schema(["START_NO_COMMIT"], {
    expectedHead: isCommit,
    otherParent: isCommit,
    exactMergeResultPathSetSha256: isSha,
  }),
  GIT_REFRESH_COMMIT_V1: schema(["COMMIT_REFRESH"], {
    expectedFirstParent: isCommit,
    expectedSecondParent: isCommit,
    stagedPathSetSha256: isSha,
    commitMessage: (value) =>
      value === "chore: merge admitted main for identity writer baseline",
  }),
  GIT_ADMISSION_COMMIT_V1: schema(["COMMIT_ADMISSION"], {
    expectedParent: isCommit,
    stagedPath: (value) =>
      value ===
      "docs/governance/organization-identity-current-main-admission.json",
    stagedStatus: (value) => enumValue(value, ["ADD", "MODIFY"]),
    commitMessage: (value) =>
      value === "chore: admit current main for identity writer baseline",
  }),
  GIT_ACCEPTANCE_COMMIT_V1: schema(["COMMIT_ACCEPTANCE"], {
    expectedParent: isCommit,
    stagedPath: (value) =>
      value === "docs/governance/organization-identity-writer-acceptance.json",
    stagedStatus: (value) => value === "ADD",
    commitMessage: (value) =>
      value === "chore: anchor organization identity writer baseline",
  }),
  REFRESH_VERIFY_V1: schema(["VERIFY"], {
    suiteId: (value) => value === "REFRESH_FULL",
    refreshMergeCommit: isCommit,
  }),
  MIGRATION_STATIC_VERIFY_V1: schema(["VERIFY"], {
    suiteId: (value) => value === "MIGRATION_0M_STATIC",
    b0mMigrationCommit: isCommit,
  }),
  PRISMA_GENERATE_V1: schema(["VERIFY"], {
    suiteId: (value) => value === "PRISMA_GENERATE",
    schemaPath: (value) => value === "packages/db/prisma/schema.prisma",
  }),
  SCANNER_TEST_V1: schema(["TEST"], {
    ...scannerCommon,
    suiteId: (value) => enumValue(value, scannerTestSuites),
  }),
  SCANNER_BASELINE_V1: schema(
    [
      "RAW_RECEIPT_ONLY",
      "RAW_CANDIDATE",
      "BASELINE_GENERATE",
      "BASELINE_CHECK",
    ],
    {
      ...scannerCommon,
      artifactACommit: (value) =>
        value === "2400bac28796bae44294114edc99eaccb1bd65b3",
      dispositionReceiptSha256: nullableSha,
      outputDirectory: (value) => value === null || value === "docs/governance",
    },
  ),
  SCANNER_STAGE_V1: schema(["STAGE_GENERATE", "STAGE_CHECK", "ANCHOR_ONLY"], {
    ...scannerCommon,
    stage: (value) => enumValue(value, stages),
  }),
  SCANNER_ZERO_V1: schema(["ZERO_CHECK"], {
    ...scannerCommon,
    expectedWriterCount: (value) => [0, 1, 2, 3].includes(value),
  }),
  SCANNER_ACCEPTANCE_V1: schema(
    ["ACCEPTANCE_RED", "ACCEPTANCE_GENERATE", "ACCEPTANCE_CHECK"],
    {
      ...scannerCommon,
      implementationParent: isCommit,
      implementationReviewSha256: isSha,
      acceptancePath: (value) =>
        value ===
        "docs/governance/organization-identity-writer-acceptance.json",
    },
  ),
  GOVERNANCE_VERIFY_V1: schema(["VERIFY"], {
    suiteId: (value) => enumValue(value, ["GOVERNANCE_B0", "GOVERNANCE_ZERO"]),
  }),
  DOCS_VERIFY_V1: schema(["VERIFY"], {
    suiteId: (value) => value === "DOCS_FULL",
  }),
  API_VERIFY_V1: schema(["VERIFY"], {
    suiteId: (value) =>
      enumValue(value, [
        "API_FULL",
        "API_TEMPORAL",
        "API_PROJECTION",
        "API_MATERIALIZATION",
        "API_DOWNSTREAM",
        "API_MIXED_FLEET",
      ]),
  }),
  RUNTIME_ARTIFACT_VERIFY_V1: schema(["VERIFY"], {
    suiteId: (value) => value === "RUNTIME_ARTIFACT",
  }),
  CONTRACT_GRAPH_VERIFY_V1: schema(["VERIFY"], {
    suiteId: (value) => value === "CONTRACT_GRAPH",
  }),
  V3_WORKTREE_CREATE_V1: schema(["CREATE"], {
    mergeCommit: isCommit,
    branch: (value) =>
      value === "codex/pr407-organization-identity-caller-cutover-v3",
    worktreePath: (value) =>
      value ===
      "/global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v3",
  }),
});

function validateParameters(commandId, mode, parameters) {
  const entry = COMMAND_REGISTRY[commandId];
  if (!entry) return integrity("CLOSED_COMMAND_ID_INVALID");
  if (!entry.modes.includes(mode))
    return integrity("CLOSED_COMMAND_MODE_INVALID");
  if (!exactObject(parameters, entry.keys, entry.predicates)) {
    return integrity("CLOSED_COMMAND_PARAMETERS_INVALID");
  }
  return pass();
}

function invocationDescriptor(commandId, mode, parameters) {
  switch (commandId) {
    case "BOOTSTRAP_AUTHORITY_RUN_V1":
      return {
        executableRole: "PNPM_ENTRYPOINT",
        argv: [
          "install",
          "--frozen-lockfile",
          "--ignore-scripts",
          "--ignore-pnpmfile",
          "--config.ignore-pnpmfile=true",
        ],
      };
    case "GIT_REFRESH_START_V1":
      return {
        executableRole: "GIT",
        argv: ["merge", "--no-commit", "--no-ff", parameters.otherParent],
      };
    case "GIT_REFRESH_COMMIT_V1":
    case "GIT_ADMISSION_COMMIT_V1":
    case "GIT_ACCEPTANCE_COMMIT_V1":
      return {
        executableRole: "GIT",
        argv: ["commit", "--message", parameters.commitMessage],
      };
    case "V3_WORKTREE_CREATE_V1":
      return {
        executableRole: "GIT",
        argv: [
          "worktree",
          "add",
          "-b",
          parameters.branch,
          parameters.worktreePath,
          parameters.mergeCommit,
        ],
      };
    case "SCOPED_REVIEW_VERIFY_V1":
    case "CURRENT_MAIN_AUDIT_LOCAL_V1":
    case "CURRENT_MAIN_VALIDATE_V1":
    case "CURRENT_MAIN_GENERATE_V1":
    case "COPY_WRITE_ELIGIBILITY_V1":
    case "COPY_SYNC_CITATIONS_V1":
    case "REFRESH_VERIFY_V1":
    case "MIGRATION_STATIC_VERIFY_V1":
    case "PRISMA_GENERATE_V1":
    case "SCANNER_TEST_V1":
    case "SCANNER_BASELINE_V1":
    case "SCANNER_STAGE_V1":
    case "SCANNER_ZERO_V1":
    case "SCANNER_ACCEPTANCE_V1":
    case "GOVERNANCE_VERIFY_V1":
    case "DOCS_VERIFY_V1":
    case "API_VERIFY_V1":
    case "RUNTIME_ARTIFACT_VERIFY_V1":
    case "CONTRACT_GRAPH_VERIFY_V1":
      return {
        executableRole: "NODE",
        argv: ["--closed-command", commandId, "--mode", mode],
      };
    default:
      return null;
  }
}

function payloadSchemaSha(commandId) {
  const entry = COMMAND_REGISTRY[commandId];
  if (!entry) return null;
  return sha256(
    canonicalJsonBytes({
      commandId,
      modes: entry.modes,
      parameterKeys: [...entry.keys].sort(),
    }),
  );
}

function expectedBasenames(request) {
  const stem = `${request.taskId}-${request.commandId.toLowerCase()}-${request.requestId}`;
  return {
    input: `${stem}.input.json`,
    output: `${stem}.output.json`,
  };
}

function deriveRequestId(request) {
  return sha256(
    canonicalJsonBytes([
      request.taskId,
      request.commandId,
      request.mode,
      request.subjectCommit,
      request.input.inputRecordSha256,
      request.input.payloadSchemaSha256,
      request.input.payloadSha256,
      request.authorizationReceiptSha256,
      request.externalControllerReceiptSha256,
      request.anchorReceiptSha256,
    ]),
  );
}

const REQUEST_KEYS = [
  "schemaVersion",
  "requestId",
  "taskId",
  "commandId",
  "mode",
  "subjectCommit",
  "bootstrapContractSha256",
  "launcherMaterializationReceiptSha256",
  "launcherMaterializationReviewReceiptSha256",
  "authorizationReceiptSha256",
  "externalControllerReceiptSha256",
  "anchorReceiptSha256",
  "input",
  "allowedArgvSha256",
  "parameters",
];
const INPUT_KEYS = [
  "inputRecordPath",
  "inputRecordUri",
  "inputRecordSha256",
  "payloadSchemaSha256",
  "payloadSha256",
  "outputRecordPath",
];

function validateRequestObject(request, roots) {
  if (!exactKeys(request, REQUEST_KEYS))
    return integrity("REQUEST_SCHEMA_INVALID");
  if (!LOCAL_COMMAND_IDS.includes(request.commandId)) {
    return integrity("CLOSED_COMMAND_ID_INVALID");
  }
  if (
    request.schemaVersion !== REQUEST_SCHEMA_VERSION ||
    !TASK_IDS.includes(request.taskId) ||
    !isCommit(request.subjectCommit) ||
    !isSha(request.bootstrapContractSha256) ||
    !isSha(request.launcherMaterializationReceiptSha256) ||
    !isSha(request.launcherMaterializationReviewReceiptSha256) ||
    !nullableSha(request.authorizationReceiptSha256) ||
    !nullableSha(request.externalControllerReceiptSha256) ||
    !nullableSha(request.anchorReceiptSha256) ||
    !isSha(request.requestId) ||
    !isSha(request.allowedArgvSha256)
  ) {
    return integrity("REQUEST_SCHEMA_INVALID");
  }
  const parameters = validateParameters(
    request.commandId,
    request.mode,
    request.parameters,
  );
  if (parameters.status !== "PASS") return parameters;
  if (!exactKeys(request.input, INPUT_KEYS))
    return integrity("REQUEST_INPUT_INVALID");

  const requestRoot = roots.requestRoot ?? DEFAULT_REQUEST_ROOT;
  const outputRoot = roots.outputRoot ?? DEFAULT_OUTPUT_ROOT;
  const basenames = expectedBasenames(request);
  const parameterBytes = canonicalJsonBytes(request.parameters);
  const parameterSha = sha256(parameterBytes);
  const expectedSchemaSha = payloadSchemaSha(request.commandId);
  const descriptor = invocationDescriptor(
    request.commandId,
    request.mode,
    request.parameters,
  );
  const expectedArgvSha = sha256(canonicalJsonBytes(descriptor));
  if (
    !isAbsoluteNormalized(request.input.inputRecordPath) ||
    path.posix.dirname(request.input.inputRecordPath) !== requestRoot ||
    path.posix.basename(request.input.inputRecordPath) !== basenames.input ||
    !isAbsoluteNormalized(request.input.outputRecordPath) ||
    path.posix.dirname(request.input.outputRecordPath) !== outputRoot ||
    path.posix.basename(request.input.outputRecordPath) !== basenames.output ||
    request.input.inputRecordUri !==
      `sha256:${request.input.inputRecordSha256}` ||
    request.input.inputRecordSha256 !== parameterSha ||
    request.input.payloadSha256 !== parameterSha ||
    request.input.payloadSchemaSha256 !== expectedSchemaSha ||
    request.allowedArgvSha256 !== expectedArgvSha ||
    request.requestId !== deriveRequestId(request)
  ) {
    return integrity("REQUEST_INPUT_INVALID");
  }
  return pass({ invocation: descriptor });
}

export function buildClosedCommandRequest({
  requestRoot = DEFAULT_REQUEST_ROOT,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  ...fields
}) {
  const parameters = cloneNullPrototype(fields.parameters);
  const inputRecordSha256 = sha256(canonicalJsonBytes(parameters));
  const payloadSchemaSha256 = payloadSchemaSha(fields.commandId);
  const descriptor = invocationDescriptor(
    fields.commandId,
    fields.mode,
    parameters,
  );
  const partial = {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    requestId: "0".repeat(64),
    ...fields,
    parameters,
    input: {
      inputRecordPath: "",
      inputRecordUri: `sha256:${inputRecordSha256}`,
      inputRecordSha256,
      payloadSchemaSha256,
      payloadSha256: inputRecordSha256,
      outputRecordPath: "",
    },
    allowedArgvSha256: sha256(canonicalJsonBytes(descriptor)),
  };
  partial.requestId = deriveRequestId(partial);
  const stem = `${partial.taskId}-${partial.commandId.toLowerCase()}-${partial.requestId}`;
  partial.input.inputRecordPath = `${requestRoot}/${stem}.input.json`;
  partial.input.outputRecordPath = `${outputRoot}/${stem}.output.json`;
  return cloneNullPrototype(partial);
}

export function parseClosedCommandRequest(bytes, options = {}) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    return integrity("CANONICAL_JSON_INVALID");
  }
  let parsed;
  try {
    const text = Buffer.from(bytes).toString("utf8");
    if (Buffer.from(text, "utf8").compare(Buffer.from(bytes)) !== 0) {
      return integrity("CANONICAL_JSON_INVALID");
    }
    parsed = (options.parseJson ?? JSON.parse)(text);
    if (!passivePlain(parsed)) return integrity("CANONICAL_JSON_INVALID");
    if (!Buffer.from(bytes).equals(canonicalJsonBytes(parsed))) {
      return integrity("CANONICAL_JSON_INVALID");
    }
  } catch {
    return integrity("CANONICAL_JSON_INVALID");
  }
  const request = cloneNullPrototype(parsed);
  const validation = validateRequestObject(request, options);
  if (validation.status !== "PASS") return validation;
  return pass({ request });
}

export async function dispatchClosedCommand(request, verifiedContext = {}) {
  if (
    !passivePlain(request) ||
    !LOCAL_COMMAND_IDS.includes(request?.commandId)
  ) {
    return integrity("CLOSED_COMMAND_ID_INVALID");
  }
  const validation = validateRequestObject(request, verifiedContext);
  if (validation.status !== "PASS") return validation;
  if (
    !Buffer.isBuffer(verifiedContext.inputRecordBytes) ||
    !verifiedContext.inputRecordBytes.equals(
      canonicalJsonBytes(request.parameters),
    ) ||
    sha256(verifiedContext.inputRecordBytes) !== request.input.inputRecordSha256
  ) {
    return integrity("INPUT_RECORD_DRIFT");
  }
  if (verifiedContext.outputExists === true)
    return integrity("OUTPUT_ALREADY_EXISTS");
  const replaySet = verifiedContext.requestReplaySet;
  if (replaySet instanceof Set && replaySet.has(request.requestId)) {
    return integrity("REQUEST_REPLAY");
  }
  if (typeof verifiedContext.preDispatchReverify === "function") {
    const reverified = await verifiedContext.preDispatchReverify(request);
    if (reverified?.status !== "PASS") return integrity("PRE_DISPATCH_TOCTOU");
  }
  if (replaySet instanceof Set) replaySet.add(request.requestId);
  const invocation = {
    commandId: request.commandId,
    mode: request.mode,
    ...validation.invocation,
  };
  if (typeof verifiedContext.loadDependency === "function") {
    await verifiedContext.loadDependency(invocation);
  }
  return pass({ invocation });
}

export function verifyExecutableClosure(expectedEntries, observedEntries) {
  if (
    !Array.isArray(expectedEntries) ||
    !Array.isArray(observedEntries) ||
    expectedEntries.length !== EXECUTABLE_ROLES.length ||
    observedEntries.length !== EXECUTABLE_ROLES.length
  ) {
    return integrity("EXECUTABLE_CLOSURE_INVALID");
  }
  const entryKeys = [
    "role",
    "logicalIdentity",
    "executablePath",
    "realpathSha256",
    "sha256",
    "size",
    "mode",
  ];
  for (let index = 0; index < EXECUTABLE_ROLES.length; index += 1) {
    const expected = expectedEntries[index];
    const observed = observedEntries[index];
    if (
      !exactKeys(expected, entryKeys) ||
      !exactKeys(observed, entryKeys) ||
      expected.role !== EXECUTABLE_ROLES[index] ||
      observed.role !== EXECUTABLE_ROLES[index] ||
      !isAbsoluteNormalized(expected.executablePath) ||
      !isAbsoluteNormalized(observed.executablePath) ||
      !isSha(expected.realpathSha256) ||
      !isSha(expected.sha256) ||
      !Number.isSafeInteger(expected.size) ||
      expected.size < 0 ||
      !Number.isSafeInteger(expected.mode) ||
      canonicalJson(expected) !== canonicalJson(observed)
    ) {
      return integrity("EXECUTABLE_CLOSURE_INVALID");
    }
  }
  return pass({
    executableClosureSetSha256: sha256(canonicalJsonBytes(observedEntries)),
  });
}

export function validateApprovedSource(
  actual,
  expected,
  allowVariableIdentity,
) {
  if (!exactKeys(actual, ["path", "commit", "blobId", "sha256"])) return false;
  if (actual.path !== expected.path) return false;
  if (
    !isCommit(actual.commit) ||
    !GIT_ID.test(actual.blobId) ||
    !isSha(actual.sha256)
  ) {
    return false;
  }
  if (!allowVariableIdentity) {
    return (
      actual.commit === expected.commit &&
      actual.blobId === expected.blobId &&
      actual.sha256 === expected.sha256
    );
  }
  return true;
}

export function verifyLauncherContract(contract, observed) {
  const contractKeys = [
    "schemaVersion",
    "rootDirectory",
    "requestRoot",
    "outputRoot",
    "rootPolicy",
    "approvedPlan",
    "approvedSpec",
    "approvedLauncher",
    "approvedBootstrap",
    "executableClosure",
    "commandIds",
    "commandRegistrySha256",
    "exactEnvironmentSchemaSha256",
    "bootstrapContractSchemaSha256",
    "requestUnionSchemaSha256",
    "requestInputDerivationSha256",
    "outputSchemaSetSha256",
  ];
  if (!exactKeys(contract, contractKeys)) {
    return integrity("LAUNCHER_CONTRACT_KEYS_INVALID");
  }
  if (
    contract.schemaVersion !== "organization-identity-launcher-contract/v2" ||
    contract.rootDirectory !== ROOT_DIRECTORY ||
    contract.requestRoot !== DEFAULT_REQUEST_ROOT ||
    contract.outputRoot !== DEFAULT_OUTPUT_ROOT
  ) {
    return integrity("LAUNCHER_CONTRACT_ROOT_INVALID");
  }
  if (
    !exactObject(
      contract.rootPolicy,
      [
        "ownerUid",
        "ownerGid",
        "directoryMode",
        "requestMode",
        "outputMode",
        "createExclusive",
        "rejectSymlink",
      ],
      {
        ownerUid: (value) => value === 0,
        ownerGid: (value) => value === 0,
        directoryMode: (value) => value === 0o700,
        requestMode: (value) => value === 0o600,
        outputMode: (value) => value === 0o600,
        createExclusive: (value) => value === true,
        rejectSymlink: (value) => value === true,
      },
    )
  ) {
    return integrity("LAUNCHER_CONTRACT_POLICY_INVALID");
  }
  if (!validateApprovedSource(contract.approvedPlan, APPROVED_PLAN, false)) {
    return integrity("LAUNCHER_CONTRACT_PLAN_INVALID");
  }
  if (!validateApprovedSource(contract.approvedSpec, APPROVED_SPEC, false)) {
    return integrity("LAUNCHER_CONTRACT_SPEC_INVALID");
  }
  if (
    !validateApprovedSource(
      contract.approvedLauncher,
      {
        path: "scripts/governance-organization-identity-launcher.mjs",
      },
      true,
    ) ||
    !validateApprovedSource(
      contract.approvedBootstrap,
      {
        path: "scripts/governance-organization-identity-bootstrap.mjs",
      },
      true,
    )
  ) {
    return integrity("LAUNCHER_CONTRACT_SOURCE_INVALID");
  }
  if (canonicalJson(contract.commandIds) !== canonicalJson(LOCAL_COMMAND_IDS)) {
    return integrity("LAUNCHER_CONTRACT_COMMANDS_INVALID");
  }
  for (const digestKey of [
    "commandRegistrySha256",
    "exactEnvironmentSchemaSha256",
    "bootstrapContractSchemaSha256",
    "requestUnionSchemaSha256",
    "requestInputDerivationSha256",
    "outputSchemaSetSha256",
  ]) {
    if (!isSha(contract[digestKey]))
      return integrity("LAUNCHER_CONTRACT_INVALID");
  }
  if (
    !exactKeys(observed, [
      "rootDirectory",
      "requestRoot",
      "outputRoot",
      "approvedPlan",
      "approvedSpec",
      "executableClosure",
    ])
  ) {
    return integrity("LAUNCHER_OBSERVATION_INVALID");
  }
  for (const rootName of ["rootDirectory", "requestRoot", "outputRoot"]) {
    const root = observed[rootName];
    if (
      !exactObject(root, ["ownerUid", "ownerGid", "mode", "symlink"], {
        ownerUid: (value) => value === 0,
        ownerGid: (value) => value === 0,
        mode: (value) => value === 0o700,
        symlink: (value) => value === false,
      })
    ) {
      return integrity("LAUNCHER_PERMISSION_INVALID");
    }
  }
  if (
    canonicalJson(observed.approvedPlan) !==
      canonicalJson(contract.approvedPlan) ||
    canonicalJson(observed.approvedSpec) !==
      canonicalJson(contract.approvedSpec)
  ) {
    return integrity("LAUNCHER_SOURCE_DRIFT");
  }
  return verifyExecutableClosure(
    contract.executableClosure,
    observed.executableClosure,
  );
}

function shellToken(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_./:@+-]+$/.test(value)) {
    throw new Error("WRAPPER_VALUE_INVALID");
  }
  return value;
}

export function renderRootWrapper({ environment, nodePath, launcherPath }) {
  if (
    !exactKeys(environment, ALLOWED_ENVIRONMENT_NAMES) ||
    Object.keys(environment).some(
      (name, index) => name !== ALLOWED_ENVIRONMENT_NAMES[index],
    )
  ) {
    throw new Error("ENVIRONMENT_NAME_SET_INVALID");
  }
  if (
    environment.NPM_CONFIG_USERCONFIG !== "/dev/null" ||
    environment.CI !== "1" ||
    environment.LANG !== "C.UTF-8" ||
    environment.LC_ALL !== "C.UTF-8" ||
    !isAbsoluteNormalized(nodePath) ||
    !isAbsoluteNormalized(launcherPath)
  ) {
    throw new Error("WRAPPER_VALUE_INVALID");
  }
  const assignments = ALLOWED_ENVIRONMENT_NAMES.map(
    (name) => `${name}=${shellToken(environment[name])}`,
  );
  return [
    "#!/bin/sh",
    "set -eu",
    'if [ "$#" -ne 2 ] || [ "$1" != "--request" ]; then',
    "  exit 64",
    "fi",
    'case "$2" in',
    "  /*) ;;",
    "  *) exit 64 ;;",
    "esac",
    `exec /usr/bin/env -i ${assignments.join(" ")} ${shellToken(nodePath)} ${shellToken(launcherPath)} --request "$2"`,
    "",
  ].join("\n");
}

const BOOTSTRAP_RECEIPT_KEYS = [
  "schemaVersion",
  "receiptCardinality",
  "bootstrapContractSha256",
  "launcherMaterializationReceiptSha256",
  "launcherMaterializationReviewReceiptSha256",
  "requestId",
  "taskId",
  "commandId",
  "mode",
  "closedCommandRequestSha256",
  "inputRecordPath",
  "inputRecordUri",
  "inputRecordSha256",
  "payloadSchemaSha256",
  "payloadSha256",
  "outputRecordPath",
  "outputRecordSha256",
  "authorizationReceiptSha256",
  "externalControllerReceiptSha256",
  "anchorReceiptSha256",
  "externalLaunchReceiptSha256",
  "acceptedSubjectCommit",
  "subjectConfigurationSetSha256",
  "subjectAbsenceSentinelSetSha256",
  "subjectGitClosureSha256",
  "environmentValueSetSha256",
  "taskRoot",
  "taskRootDevice",
  "taskRootInode",
  "fixedRootSetSha256",
  "postInstallBootstrapRehashSha256",
  "dependencyDeclarationRoots",
  "toolExecutionRoots",
  "prismaSchemaSha256",
  "generatedClientSetSha256",
  "generatedDmmfSha256",
  "generatedDelegateSetSha256",
  "generatedOutputSetSha256",
  "typescriptDynamicImportSha256",
  "hostileMarkerSetSha256",
  "hostileMarkerExecutionCount",
  "prePostToctouSha256",
  "startedAt",
  "finishedAt",
  "result",
];

function validateToolRootReceipt(receipt) {
  return exactObject(
    receipt,
    [
      "logicalPackage",
      "version",
      "lockIntegrity",
      "rootRealpathSha256",
      "loadedFileCount",
      "loadedFileSetSha256",
      "contentSetSha256",
      "prePostToctouSha256",
    ],
    {
      logicalPackage: (value) => typeof value === "string" && value.length > 0,
      version: (value) => typeof value === "string" && value.length > 0,
      lockIntegrity: (value) => typeof value === "string" && value.length > 0,
      rootRealpathSha256: isSha,
      loadedFileCount: (value) => Number.isSafeInteger(value) && value >= 0,
      loadedFileSetSha256: isSha,
      contentSetSha256: isSha,
      prePostToctouSha256: isSha,
    },
  );
}

export function validateBootstrapRunReceipt(receipt, request) {
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
  for (const key of [
    "bootstrapContractSha256",
    "launcherMaterializationReceiptSha256",
    "launcherMaterializationReviewReceiptSha256",
    "requestId",
    "closedCommandRequestSha256",
    "inputRecordSha256",
    "payloadSchemaSha256",
    "payloadSha256",
    "outputRecordSha256",
    "externalLaunchReceiptSha256",
    "subjectConfigurationSetSha256",
    "subjectAbsenceSentinelSetSha256",
    "subjectGitClosureSha256",
    "environmentValueSetSha256",
    "fixedRootSetSha256",
    "postInstallBootstrapRehashSha256",
    "prismaSchemaSha256",
    "generatedClientSetSha256",
    "generatedDmmfSha256",
    "generatedDelegateSetSha256",
    "generatedOutputSetSha256",
    "typescriptDynamicImportSha256",
    "hostileMarkerSetSha256",
    "prePostToctouSha256",
  ]) {
    if (!isSha(receipt[key])) return integrity("BOOTSTRAP_RECEIPT_INVALID");
  }
  for (const key of [
    "authorizationReceiptSha256",
    "externalControllerReceiptSha256",
    "anchorReceiptSha256",
  ]) {
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
  if (request) {
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
  }
  return pass();
}

export function validateBootstrapRunReceiptSet(receiptSet) {
  if (
    !exactKeys(receiptSet, [
      "schemaVersion",
      "taskId",
      "subjectCommit",
      "receiptCount",
      "receipts",
      "receiptSetSha256",
    ]) ||
    receiptSet.schemaVersion !== "organization-identity-bootstrap-run-set/v1" ||
    !TASK_IDS.includes(receiptSet.taskId) ||
    !isCommit(receiptSet.subjectCommit) ||
    !Number.isSafeInteger(receiptSet.receiptCount) ||
    !Array.isArray(receiptSet.receipts) ||
    receiptSet.receiptCount !== receiptSet.receipts.length ||
    !isSha(receiptSet.receiptSetSha256)
  ) {
    return integrity("BOOTSTRAP_RECEIPT_SET_INVALID");
  }
  const keys = ["requestId", "commandId", "requestSha256", "receiptSha256"];
  for (const entry of receiptSet.receipts) {
    if (
      !exactKeys(entry, keys) ||
      !isSha(entry.requestId) ||
      !LOCAL_COMMAND_IDS.includes(entry.commandId) ||
      !isSha(entry.requestSha256) ||
      !isSha(entry.receiptSha256)
    ) {
      return integrity("BOOTSTRAP_RECEIPT_SET_INVALID");
    }
  }
  const requestIds = receiptSet.receipts.map(({ requestId }) => requestId);
  const receiptIds = receiptSet.receipts.map(
    ({ receiptSha256 }) => receiptSha256,
  );
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

export function validateLauncherReadbackReport(report) {
  if (
    !exactKeys(report, [
      "schemaVersion",
      "launcherContractSha256",
      "fourFileObservationSetSha256",
      "requestRootObservationSha256",
      "outputRootObservationSha256",
      "executableClosureObservationSha256",
      "hostileCounterexampleSetSha256",
      "reviewerClass",
      "observedAt",
    ]) ||
    report.schemaVersion !== "organization-identity-launcher-readback/v1" ||
    report.reviewerClass !== "INDEPENDENT_ROOT_LAUNCHER_READBACK" ||
    !Number.isFinite(Date.parse(report.observedAt))
  ) {
    return integrity("LAUNCHER_READBACK_INVALID");
  }
  for (const key of [
    "launcherContractSha256",
    "fourFileObservationSetSha256",
    "requestRootObservationSha256",
    "outputRootObservationSha256",
    "executableClosureObservationSha256",
    "hostileCounterexampleSetSha256",
  ]) {
    if (!isSha(report[key])) return integrity("LAUNCHER_READBACK_INVALID");
  }
  return pass();
}

function validateRootControlledFile(file, basename, mode) {
  return (
    exactKeys(file, [
      "basename",
      "mode",
      "device",
      "inode",
      "realpathSha256",
      "sha256",
      "size",
    ]) &&
    file.basename === basename &&
    file.mode === mode &&
    typeof file.device === "string" &&
    file.device.length > 0 &&
    typeof file.inode === "string" &&
    file.inode.length > 0 &&
    isSha(file.realpathSha256) &&
    isSha(file.sha256) &&
    Number.isSafeInteger(file.size) &&
    file.size >= 0
  );
}

function validateMaterializedRoot(root) {
  return (
    exactKeys(root, ["mode", "device", "inode", "realpathSha256"]) &&
    root.mode === 0o700 &&
    typeof root.device === "string" &&
    root.device.length > 0 &&
    typeof root.inode === "string" &&
    root.inode.length > 0 &&
    isSha(root.realpathSha256)
  );
}

export function validateLauncherMaterializationReceipt(
  receipt,
  readbackReport,
) {
  if (
    !exactKeys(receipt, [
      "schemaVersion",
      "launcherContractSha256",
      "ownerUid",
      "ownerGid",
      "directoryMode",
      "files",
      "requestRoot",
      "outputRoot",
      "fourFileFsyncSha256",
      "directoryFsyncSha256",
      "readbackReportSha256",
      "prePostToctouSha256",
      "materializedAt",
      "result",
    ]) ||
    receipt.schemaVersion !==
      "organization-identity-launcher-materialization/v2" ||
    receipt.ownerUid !== 0 ||
    receipt.ownerGid !== 0 ||
    receipt.directoryMode !== 0o700 ||
    !Array.isArray(receipt.files) ||
    receipt.files.length !== 4 ||
    !validateRootControlledFile(
      receipt.files[0],
      "identity-writer-launch",
      0o500,
    ) ||
    !validateRootControlledFile(
      receipt.files[1],
      "identity-writer-launch.mjs",
      0o500,
    ) ||
    !validateRootControlledFile(
      receipt.files[2],
      "identity-writer-bootstrap.mjs",
      0o500,
    ) ||
    !validateRootControlledFile(
      receipt.files[3],
      "launcher-contract.json",
      0o600,
    ) ||
    new Set(receipt.files.map(({ inode }) => inode)).size !== 4 ||
    !validateMaterializedRoot(receipt.requestRoot) ||
    !validateMaterializedRoot(receipt.outputRoot) ||
    receipt.requestRoot.inode === receipt.outputRoot.inode ||
    !isSha(receipt.launcherContractSha256) ||
    !isSha(receipt.fourFileFsyncSha256) ||
    !isSha(receipt.directoryFsyncSha256) ||
    !isSha(receipt.readbackReportSha256) ||
    !isSha(receipt.prePostToctouSha256) ||
    !Number.isFinite(Date.parse(receipt.materializedAt)) ||
    receipt.result !== "PASS"
  ) {
    return integrity("LAUNCHER_MATERIALIZATION_INVALID");
  }
  if (
    readbackReport &&
    (validateLauncherReadbackReport(readbackReport).status !== "PASS" ||
      receipt.launcherContractSha256 !==
        readbackReport.launcherContractSha256 ||
      receipt.readbackReportSha256 !==
        sha256(canonicalJsonBytes(readbackReport)))
  ) {
    return integrity("LAUNCHER_MATERIALIZATION_READBACK_INVALID");
  }
  return pass();
}

export function validateLauncherMaterializationReviewReceipt(
  receipt,
  materializationReceipt,
  readbackReport,
) {
  if (
    !exactKeys(receipt, [
      "schemaVersion",
      "launcherContractSha256",
      "launcherMaterializationReceiptSha256",
      "readbackReportSha256",
      "reportSha256",
      "counterexampleSetSha256",
      "reviewerClass",
      "critical",
      "important",
      "verdict",
    ]) ||
    receipt.schemaVersion !==
      "organization-identity-launcher-materialization-review/v1" ||
    receipt.reviewerClass !== "INDEPENDENT_ROOT_LAUNCHER_REVIEW" ||
    receipt.critical !== 0 ||
    receipt.important !== 0 ||
    receipt.verdict !== "PASS" ||
    receipt.launcherMaterializationReceiptSha256 ===
      receipt.readbackReportSha256
  ) {
    return integrity("LAUNCHER_MATERIALIZATION_REVIEW_INVALID");
  }
  for (const key of [
    "launcherContractSha256",
    "launcherMaterializationReceiptSha256",
    "readbackReportSha256",
    "reportSha256",
    "counterexampleSetSha256",
  ]) {
    if (!isSha(receipt[key])) {
      return integrity("LAUNCHER_MATERIALIZATION_REVIEW_INVALID");
    }
  }
  if (
    materializationReceipt &&
    (receipt.launcherContractSha256 !==
      materializationReceipt.launcherContractSha256 ||
      receipt.launcherMaterializationReceiptSha256 !==
        sha256(canonicalJsonBytes(materializationReceipt)))
  ) {
    return integrity("LAUNCHER_MATERIALIZATION_REVIEW_BINDING_INVALID");
  }
  if (
    readbackReport &&
    receipt.readbackReportSha256 !== sha256(canonicalJsonBytes(readbackReport))
  ) {
    return integrity("LAUNCHER_MATERIALIZATION_REVIEW_BINDING_INVALID");
  }
  return pass();
}
