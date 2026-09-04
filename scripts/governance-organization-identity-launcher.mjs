import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  commit: "e8a2b2aa08ed5933b3228cc5dd24c468d0f417c2",
  blobId: "6e6234913f00c9bf496ccdeb3eb60bad88fc9691",
  sha256: "3bd1c56dff6c2f284b5f34a7ee16c8d14ba0a44069abf0c3aa8ab4c47b78555f",
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
      if (Object.getOwnPropertySymbols(value).length !== 0) return false;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === "length") continue;
        if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
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

function validateVerifiedWorktreeReceipt(receipt, request) {
  if (
    !exactKeys(receipt, [
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
    !isAbsoluteNormalized(receipt.repositoryRoot) ||
    !isAbsoluteNormalized(receipt.worktreePath) ||
    !receipt.worktreePath.startsWith(`${receipt.repositoryRoot}/`) ||
    !isSha(receipt.gitDirRealpathSha256) ||
    !isSha(receipt.commonDirRealpathSha256) ||
    typeof receipt.branch !== "string" ||
    receipt.branch.length === 0 ||
    !isCommit(receipt.headCommit) ||
    !isCommit(receipt.subjectCommit) ||
    receipt.headCommit !== request.subjectCommit ||
    receipt.subjectCommit !== request.subjectCommit ||
    !isSha(receipt.statusPorcelainSha256) ||
    !isSha(receipt.worktreeListEntrySha256) ||
    receipt.expectedMode !== request.mode ||
    !isSha(receipt.verifiedByExecutableClosureSha256) ||
    !isSha(receipt.prePostToctouSha256) ||
    receipt.result !== "PASS"
  ) {
    return integrity("VERIFIED_WORKTREE_RECEIPT_REQUIRED");
  }
  return pass();
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

export function computeLauncherContractDigests() {
  const requestUnion = Object.entries(COMMAND_REGISTRY).map(
    ([commandId, entry]) => ({
      commandId,
      modes: entry.modes,
      parameterKeys: [...entry.keys].sort(),
    }),
  );
  return {
    commandRegistrySha256: sha256(
      canonicalJsonBytes({
        ruleVersion: "closed-command-descriptor/v2",
        commandIds: LOCAL_COMMAND_IDS,
        requestUnion,
      }),
    ),
    exactEnvironmentSchemaSha256: sha256(
      canonicalJsonBytes({
        names: ALLOWED_ENVIRONMENT_NAMES,
        npmUserConfig: "/dev/null",
        cleanEnvironment: true,
      }),
    ),
    bootstrapContractSchemaSha256: sha256(
      canonicalJsonBytes({
        schemaVersion: "organization-identity-bootstrap-contract/v2",
        receiptSchemaVersion: "organization-identity-bootstrap-run/v2",
      }),
    ),
    requestUnionSchemaSha256: sha256(canonicalJsonBytes(requestUnion)),
    requestInputDerivationSha256: sha256(
      canonicalJsonBytes({
        requestIdTuple: [
          "taskId",
          "commandId",
          "mode",
          "subjectCommit",
          "inputRecordSha256",
          "payloadSchemaSha256",
          "payloadSha256",
          "authorizationReceiptSha256",
          "externalControllerReceiptSha256",
          "anchorReceiptSha256",
        ],
        inputRecordUri: "sha256:<inputRecordSha256>",
        basenameRule:
          "<taskId>-<commandId-lowercase>-<requestId>.(input|output).json",
      }),
    ),
    outputSchemaSetSha256: sha256(
      canonicalJsonBytes([
        "organization-identity-closed-command-output/v1",
        "organization-identity-bootstrap-run/v2",
        "organization-identity-bootstrap-run-set/v1",
      ]),
    ),
  };
}

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

const ROOT_BOOTSTRAP_PATH = `${ROOT_DIRECTORY}/identity-writer-bootstrap.mjs`;

function nodeDescriptor(request) {
  return {
    executableRole: "NODE",
    argv: [
      ROOT_BOOTSTRAP_PATH,
      "--command",
      request.commandId,
      "--mode",
      request.mode,
      "--subject",
      request.subjectCommit,
      "--input",
      request.input.inputRecordPath,
      "--output",
      request.input.outputRecordPath,
    ],
    subjectCommit: request.subjectCommit,
    inputRecordPath: request.input.inputRecordPath,
    outputRecordPath: request.input.outputRecordPath,
    parameters: request.parameters,
    preconditions: request.parameters,
    outputSchemaVersion: "organization-identity-bootstrap-run/v2",
  };
}

function gitDescriptor(request, argv, readbacks) {
  return {
    executableRole: "GIT",
    argv,
    subjectCommit: request.subjectCommit,
    inputRecordPath: request.input.inputRecordPath,
    outputRecordPath: request.input.outputRecordPath,
    parameters: request.parameters,
    preconditions: request.parameters,
    readbacks,
    outputSchemaVersion: "organization-identity-bootstrap-run/v2",
  };
}

function invocationDescriptor(request) {
  const { commandId, mode, parameters } = request;
  switch (commandId) {
    case "BOOTSTRAP_AUTHORITY_RUN_V1":
      switch (mode) {
        case "INSTALL_AND_PRISMA_GENERATE":
          return nodeDescriptor(request);
        default:
          return null;
      }
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
    case "SCANNER_ZERO_V1":
    case "GOVERNANCE_VERIFY_V1":
    case "DOCS_VERIFY_V1":
    case "API_VERIFY_V1":
    case "RUNTIME_ARTIFACT_VERIFY_V1":
    case "CONTRACT_GRAPH_VERIFY_V1":
      switch (mode) {
        case "VERIFY":
        case "COLLECT_LOCAL_FACTS":
        case "VALIDATE":
        case "GENERATE":
        case "WRITE_ELIGIBILITY":
        case "SYNC_CITATIONS":
        case "TEST":
        case "ZERO_CHECK":
          return nodeDescriptor(request);
        default:
          return null;
      }
    case "SCANNER_BASELINE_V1":
      switch (mode) {
        case "RAW_RECEIPT_ONLY":
        case "RAW_CANDIDATE":
        case "BASELINE_GENERATE":
        case "BASELINE_CHECK":
          return nodeDescriptor(request);
        default:
          return null;
      }
    case "SCANNER_STAGE_V1":
      switch (mode) {
        case "STAGE_GENERATE":
        case "STAGE_CHECK":
        case "ANCHOR_ONLY":
          return nodeDescriptor(request);
        default:
          return null;
      }
    case "SCANNER_ACCEPTANCE_V1":
      switch (mode) {
        case "ACCEPTANCE_RED":
        case "ACCEPTANCE_GENERATE":
        case "ACCEPTANCE_CHECK":
          return nodeDescriptor(request);
        default:
          return null;
      }
    case "GIT_REFRESH_START_V1":
      switch (mode) {
        case "START_NO_COMMIT":
          return gitDescriptor(
            request,
            ["merge", "--no-commit", "--no-ff", parameters.otherParent],
            [
              {
                phase: "BEFORE",
                argv: ["rev-parse", "HEAD"],
                expected: parameters.expectedHead,
              },
              {
                phase: "AFTER",
                argv: ["diff", "--name-only", "--cached"],
                expectedSetSha256: parameters.exactMergeResultPathSetSha256,
              },
            ],
          );
        default:
          return null;
      }
    case "GIT_REFRESH_COMMIT_V1":
      switch (mode) {
        case "COMMIT_REFRESH":
          return gitDescriptor(
            request,
            ["commit", "--message", parameters.commitMessage],
            [
              {
                phase: "BEFORE",
                argv: ["rev-parse", "HEAD"],
                expected: parameters.expectedFirstParent,
              },
              {
                phase: "BEFORE",
                argv: ["rev-parse", "MERGE_HEAD"],
                expected: parameters.expectedSecondParent,
              },
              {
                phase: "AFTER",
                argv: ["rev-parse", "HEAD^1"],
                expected: parameters.expectedFirstParent,
              },
              {
                phase: "AFTER",
                argv: ["rev-parse", "HEAD^2"],
                expected: parameters.expectedSecondParent,
              },
              {
                phase: "BEFORE",
                argv: ["diff", "--name-only", "--cached"],
                expectedSetSha256: parameters.stagedPathSetSha256,
              },
            ],
          );
        default:
          return null;
      }
    case "GIT_ADMISSION_COMMIT_V1":
    case "GIT_ACCEPTANCE_COMMIT_V1":
      switch (mode) {
        case "COMMIT_ADMISSION":
        case "COMMIT_ACCEPTANCE":
          return gitDescriptor(
            request,
            ["commit", "--message", parameters.commitMessage],
            [
              {
                phase: "BEFORE",
                argv: ["rev-parse", "HEAD"],
                expected: parameters.expectedParent,
              },
              {
                phase: "AFTER",
                argv: ["rev-parse", "HEAD^"],
                expected: parameters.expectedParent,
              },
              {
                phase: "BEFORE",
                argv: [
                  "diff",
                  "--cached",
                  "--name-status",
                  "--",
                  parameters.stagedPath,
                ],
                expectedStatus: parameters.stagedStatus,
                expectedPath: parameters.stagedPath,
              },
            ],
          );
        default:
          return null;
      }
    case "V3_WORKTREE_CREATE_V1":
      switch (mode) {
        case "CREATE":
          return gitDescriptor(
            request,
            [
              "worktree",
              "add",
              "-b",
              parameters.branch,
              parameters.worktreePath,
              parameters.mergeCommit,
            ],
            [
              {
                phase: "BEFORE",
                argv: ["rev-parse", "HEAD"],
                expected: request.subjectCommit,
              },
              {
                phase: "BEFORE",
                argv: ["worktree", "list", "--porcelain"],
                expectedAbsentPath: parameters.worktreePath,
              },
              {
                phase: "AFTER",
                argv: ["-C", parameters.worktreePath, "rev-parse", "HEAD"],
                expected: parameters.mergeCommit,
              },
            ],
          );
        default:
          return null;
      }
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
  const descriptor = invocationDescriptor(request);
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
    allowedArgvSha256: "0".repeat(64),
  };
  partial.requestId = deriveRequestId(partial);
  const stem = `${partial.taskId}-${partial.commandId.toLowerCase()}-${partial.requestId}`;
  partial.input.inputRecordPath = `${requestRoot}/${stem}.input.json`;
  partial.input.outputRecordPath = `${outputRoot}/${stem}.output.json`;
  partial.allowedArgvSha256 = sha256(
    canonicalJsonBytes(invocationDescriptor(partial)),
  );
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
  if (!(replaySet instanceof Set)) return integrity("REPLAY_GUARD_REQUIRED");
  if (replaySet.has(request.requestId)) {
    return integrity("REQUEST_REPLAY");
  }
  if (typeof verifiedContext.preDispatchReverify === "function") {
    const reverified = await verifiedContext.preDispatchReverify(request);
    if (reverified?.status !== "PASS") return integrity("PRE_DISPATCH_TOCTOU");
  }
  replaySet.add(request.requestId);
  const invocation = {
    commandId: request.commandId,
    mode: request.mode,
    ...validation.invocation,
  };
  if (invocation.executableRole === "GIT") {
    const worktreeReceipt = verifiedContext.verifiedWorktreeReceipt;
    const verifiedWorktree = validateVerifiedWorktreeReceipt(
      worktreeReceipt,
      request,
    );
    if (verifiedWorktree.status !== "PASS") return verifiedWorktree;
    invocation.cwd = worktreeReceipt.worktreePath;
  }
  let executionResult = null;
  if (typeof verifiedContext.loadDependency !== "function") {
    return integrity("EXECUTOR_REQUIRED");
  }
  try {
    executionResult = await verifiedContext.loadDependency(invocation);
  } catch {
    return integrity("EXECUTOR_THROWN");
  }
  if (executionResult?.status !== "PASS") {
    return executionResult?.status === "INTEGRITY_ERROR"
      ? executionResult
      : integrity("EXECUTOR_RESULT_INVALID");
  }
  return pass({ invocation, executionResult });
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
  const contractDigests = computeLauncherContractDigests();
  for (const digestKey of [
    "commandRegistrySha256",
    "exactEnvironmentSchemaSha256",
    "bootstrapContractSchemaSha256",
    "requestUnionSchemaSha256",
    "requestInputDerivationSha256",
    "outputSchemaSetSha256",
  ]) {
    if (
      !isSha(contract[digestKey]) ||
      contract[digestKey] !== contractDigests[digestKey]
    )
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

export function validateBootstrapRunReceiptSet(receiptSet, records) {
  if (
    !Array.isArray(records) ||
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
    records.length !== receiptSet.receiptCount ||
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
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const entry = receiptSet.receipts[index];
    if (
      !exactKeys(record, ["request", "receipt"]) ||
      validateBootstrapRunReceipt(record.receipt, record.request).status !==
        "PASS" ||
      entry.requestId !== record.request.requestId ||
      entry.commandId !== record.request.commandId ||
      entry.requestSha256 !== sha256(canonicalJsonBytes(record.request)) ||
      entry.receiptSha256 !== sha256(canonicalJsonBytes(record.receipt))
    ) {
      return integrity("BOOTSTRAP_RECEIPT_SET_BINDING_INVALID");
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
  if (!readbackReport) return integrity("LAUNCHER_READBACK_REQUIRED");
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
    validateLauncherReadbackReport(readbackReport).status !== "PASS" ||
    receipt.launcherContractSha256 !== readbackReport.launcherContractSha256 ||
    receipt.readbackReportSha256 !== sha256(canonicalJsonBytes(readbackReport))
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
  if (!materializationReceipt || !readbackReport) {
    return integrity("LAUNCHER_MATERIALIZATION_PREDECESSOR_REQUIRED");
  }
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
    receipt.launcherContractSha256 !==
      materializationReceipt.launcherContractSha256 ||
    receipt.launcherMaterializationReceiptSha256 !==
      sha256(canonicalJsonBytes(materializationReceipt))
  ) {
    return integrity("LAUNCHER_MATERIALIZATION_REVIEW_BINDING_INVALID");
  }
  if (
    receipt.readbackReportSha256 !== sha256(canonicalJsonBytes(readbackReport))
  ) {
    return integrity("LAUNCHER_MATERIALIZATION_REVIEW_BINDING_INVALID");
  }
  return pass();
}

function statMode(stat) {
  return Number(stat.mode & 0o777n);
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    statMode(left) === statMode(right)
  );
}

export async function verifyControlledFile(
  filePath,
  expected = {},
  adapters = {},
) {
  if (!isAbsoluteNormalized(filePath)) {
    return integrity("CONTROLLED_FILE_PATH_INVALID");
  }
  const fileLstat = adapters.lstat ?? lstat;
  const fileOpen = adapters.open ?? open;
  const fileRealpath = adapters.realpath ?? realpath;
  let before;
  let handle;
  try {
    before = await fileLstat(filePath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      return integrity("CONTROLLED_FILE_LINK_INVALID");
    }
    if (
      (expected.expectedMode !== undefined &&
        statMode(before) !== expected.expectedMode) ||
      (expected.expectedUid !== undefined &&
        Number(before.uid) !== expected.expectedUid) ||
      (expected.expectedGid !== undefined &&
        Number(before.gid) !== expected.expectedGid)
    ) {
      return integrity("CONTROLLED_FILE_PERMISSION_INVALID");
    }
    const resolved = await fileRealpath(filePath);
    if (
      resolved !== filePath ||
      (expected.expectedRealpath !== undefined &&
        resolved !== expected.expectedRealpath)
    ) {
      return integrity("CONTROLLED_FILE_REALPATH_INVALID");
    }
    handle = await fileOpen(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const opened = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, opened)) {
      return integrity("CONTROLLED_FILE_TOCTOU");
    }
    const bytes = await handle.readFile();
    if (typeof adapters.afterRead === "function") {
      await adapters.afterRead({ bytes, before, opened });
    }
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await fileLstat(filePath, { bigint: true });
    if (
      !sameFileIdentity(opened, afterHandle) ||
      !sameFileIdentity(opened, afterPath) ||
      afterPath.nlink !== 1n
    ) {
      return integrity("CONTROLLED_FILE_TOCTOU");
    }
    const digest = sha256(bytes);
    if (
      expected.expectedSha256 !== undefined &&
      digest !== expected.expectedSha256
    ) {
      return integrity("CONTROLLED_FILE_DIGEST_INVALID");
    }
    return pass({
      bytes,
      observation: {
        path: filePath,
        device: String(opened.dev),
        inode: String(opened.ino),
        ownerUid: Number(opened.uid),
        ownerGid: Number(opened.gid),
        mode: statMode(opened),
        size: Number(opened.size),
        realpathSha256: sha256(Buffer.from(resolved, "utf8")),
        sha256: digest,
      },
    });
  } catch {
    return integrity("CONTROLLED_FILE_UNAVAILABLE");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function verifyControlledDirectory(directoryPath, expected = {}) {
  if (!isAbsoluteNormalized(directoryPath)) {
    return integrity("CONTROLLED_DIRECTORY_PATH_INVALID");
  }
  try {
    const [stat, resolved] = await Promise.all([
      lstat(directoryPath, { bigint: true }),
      realpath(directoryPath),
    ]);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      resolved !== directoryPath ||
      (expected.expectedMode !== undefined &&
        statMode(stat) !== expected.expectedMode) ||
      (expected.expectedUid !== undefined &&
        Number(stat.uid) !== expected.expectedUid) ||
      (expected.expectedGid !== undefined &&
        Number(stat.gid) !== expected.expectedGid)
    ) {
      return integrity("CONTROLLED_DIRECTORY_INVALID");
    }
    return pass({
      observation: {
        mode: statMode(stat),
        device: String(stat.dev),
        inode: String(stat.ino),
        realpathSha256: sha256(Buffer.from(resolved, "utf8")),
      },
    });
  } catch {
    return integrity("CONTROLLED_DIRECTORY_UNAVAILABLE");
  }
}

async function readCanonicalRecord(filePath, expected) {
  const verified = await verifyControlledFile(filePath, expected);
  if (verified.status !== "PASS") return verified;
  try {
    const value = JSON.parse(verified.bytes.toString("utf8"));
    if (
      !passivePlain(value) ||
      !verified.bytes.equals(canonicalJsonBytes(value))
    ) {
      return integrity("CANONICAL_RECORD_INVALID");
    }
    return pass({ value: cloneNullPrototype(value), verified });
  } catch {
    return integrity("CANONICAL_RECORD_INVALID");
  }
}

async function verifyFixedLauncherTrust(request, options) {
  const expectedOwner = {
    expectedUid: options.expectedUid ?? 0,
    expectedGid: options.expectedGid ?? 0,
  };
  const contractRecord = await readCanonicalRecord(
    `${ROOT_DIRECTORY}/launcher-contract.json`,
    { ...expectedOwner, expectedMode: 0o600 },
  );
  if (contractRecord.status !== "PASS") return contractRecord;
  const materializationRecord = await readCanonicalRecord(
    `${ROOT_DIRECTORY}/launcher-materialization.json`,
    {
      ...expectedOwner,
      expectedMode: 0o600,
      expectedSha256: request.launcherMaterializationReceiptSha256,
    },
  );
  if (materializationRecord.status !== "PASS") return materializationRecord;
  const readbackRecord = await readCanonicalRecord(
    `${ROOT_DIRECTORY}/launcher-materialization-readback.json`,
    {
      ...expectedOwner,
      expectedMode: 0o600,
      expectedSha256: materializationRecord.value.readbackReportSha256,
    },
  );
  if (readbackRecord.status !== "PASS") return readbackRecord;
  const reviewRecord = await readCanonicalRecord(
    `${ROOT_DIRECTORY}/launcher-materialization-review.json`,
    {
      ...expectedOwner,
      expectedMode: 0o600,
      expectedSha256: request.launcherMaterializationReviewReceiptSha256,
    },
  );
  if (reviewRecord.status !== "PASS") return reviewRecord;
  if (
    materializationRecord.value.launcherContractSha256 !==
      contractRecord.verified.observation.sha256 ||
    validateLauncherMaterializationReceipt(
      materializationRecord.value,
      readbackRecord.value,
    ).status !== "PASS" ||
    validateLauncherMaterializationReviewReceipt(
      reviewRecord.value,
      materializationRecord.value,
      readbackRecord.value,
    ).status !== "PASS"
  ) {
    return integrity("LAUNCHER_TRUST_CHAIN_INVALID");
  }
  const verificationFiles = [
    {
      path: `${ROOT_DIRECTORY}/identity-writer-launch.mjs`,
      expectedSha256: contractRecord.value.approvedLauncher.sha256,
      expectedMode: 0o500,
    },
    {
      path: `${ROOT_DIRECTORY}/identity-writer-bootstrap.mjs`,
      expectedSha256: contractRecord.value.approvedBootstrap.sha256,
      expectedMode: 0o500,
    },
    ...contractRecord.value.executableClosure.map((entry) => ({
      path: entry.executablePath,
      expectedSha256: entry.sha256,
      expectedMode: entry.mode,
    })),
  ];
  for (const entry of verificationFiles) {
    const verified = await verifyControlledFile(entry.path, {
      ...expectedOwner,
      ...entry,
    });
    if (verified.status !== "PASS") return verified;
  }
  return pass({
    contract: contractRecord.value,
    verificationFiles,
    executableByRole: Object.fromEntries(
      contractRecord.value.executableClosure.map((entry) => [
        entry.role,
        entry.executablePath,
      ]),
    ),
  });
}

async function deriveVerifiedWorktreeReceipt(request, trust, options) {
  if (invocationDescriptor(request)?.executableRole !== "GIT") {
    return pass({ verifiedWorktreeReceipt: trust.verifiedWorktreeReceipt });
  }
  const gitPath = trust.executableByRole?.GIT;
  if (!isAbsoluteNormalized(gitPath))
    return integrity("GIT_EXECUTABLE_REQUIRED");
  const gitInvocation = {
    executableRole: "GIT",
    executablePath: gitPath,
    subjectCommit: request.subjectCommit,
    mode: request.mode,
  };
  let facts;
  if (typeof options.deriveWorktreeReceipt === "function") {
    facts = await options.deriveWorktreeReceipt(gitInvocation);
  } else {
    const cwd = options.worktreePath ?? process.cwd();
    const run = (argv) =>
      runClosedProcess(gitPath, argv, options.environment ?? {}, cwd);
    const root = run(["rev-parse", "--show-toplevel"]);
    const gitDir = run(["rev-parse", "--git-dir"]);
    const commonDir = run(["rev-parse", "--git-common-dir"]);
    const branch = run(["branch", "--show-current"]);
    const head = run(["rev-parse", "HEAD"]);
    const status = run(["status", "--porcelain=v1"]);
    const worktrees = run(["worktree", "list", "--porcelain"]);
    if (
      [root, gitDir, commonDir, branch, head, status, worktrees].some(
        (r) => r.status !== "PASS",
      )
    ) {
      return integrity("VERIFIED_WORKTREE_RECEIPT_REQUIRED");
    }
    facts = {
      repositoryRoot: root.stdout.trim(),
      worktreePath: cwd,
      gitDirRealpath: path.posix.normalize(
        path.posix.resolve(cwd, gitDir.stdout.trim()),
      ),
      commonDirRealpath: path.posix.normalize(
        path.posix.resolve(cwd, commonDir.stdout.trim()),
      ),
      branch: branch.stdout.trim(),
      headCommit: head.stdout.trim(),
      statusPorcelain: status.stdout,
      worktreeListEntry: worktrees.stdout,
    };
  }
  const receipt = {
    schemaVersion: "organization-identity-verified-worktree/v1",
    repositoryRoot: facts.repositoryRoot,
    worktreePath: facts.worktreePath,
    gitDirRealpathSha256: sha256(Buffer.from(facts.gitDirRealpath, "utf8")),
    commonDirRealpathSha256: sha256(
      Buffer.from(facts.commonDirRealpath, "utf8"),
    ),
    branch: facts.branch,
    headCommit: facts.headCommit,
    subjectCommit: facts.subjectCommit ?? request.subjectCommit,
    statusPorcelainSha256: sha256(
      Buffer.from(facts.statusPorcelain ?? "", "utf8"),
    ),
    worktreeListEntrySha256: sha256(
      Buffer.from(facts.worktreeListEntry ?? "", "utf8"),
    ),
    expectedMode: facts.expectedMode ?? request.mode,
    verifiedByExecutableClosureSha256:
      facts.verifiedByExecutableClosureSha256 ??
      sha256(canonicalJsonBytes(trust.verificationFiles ?? [])),
    prePostToctouSha256:
      facts.prePostToctouSha256 ?? sha256(canonicalJsonBytes(gitInvocation)),
    result: "PASS",
  };
  const validated = validateVerifiedWorktreeReceipt(receipt, request);
  return validated.status === "PASS"
    ? pass({ verifiedWorktreeReceipt: receipt })
    : validated;
}

async function createExclusiveOutput(outputPath, owner) {
  let handle;
  try {
    handle = await open(
      outputPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    const stat = await handle.stat({ bigint: true });
    if (
      Number(stat.uid) !== owner.expectedUid ||
      Number(stat.gid) !== owner.expectedGid ||
      statMode(stat) !== 0o600 ||
      stat.nlink !== 1n
    ) {
      await handle.close();
      return integrity("OUTPUT_PERMISSION_INVALID");
    }
    return pass({ handle });
  } catch {
    await handle?.close().catch(() => undefined);
    return integrity("OUTPUT_CREATE_EXCLUSIVE_FAILED");
  }
}

async function finalizeOutput(handle, outputPath, value) {
  try {
    const bytes = canonicalJsonBytes(value);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    const directory = await open(
      path.posix.dirname(outputPath),
      fsConstants.O_RDONLY,
    );
    await directory.sync();
    await directory.close();
    const verified = await verifyControlledFile(outputPath, {
      expectedSha256: sha256(bytes),
      expectedMode: 0o600,
      expectedUid: process.getuid?.() ?? 0,
      expectedGid: process.getgid?.() ?? 0,
    });
    return verified.status === "PASS" ? pass({ bytes }) : verified;
  } catch {
    await handle.close().catch(() => undefined);
    return integrity("OUTPUT_FINALIZATION_FAILED");
  }
}

function runClosedProcess(executablePath, argv, environment, cwd) {
  const result = spawnSync(executablePath, argv, {
    env: environment,
    cwd,
    encoding: "utf8",
    shell: false,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.signal || result.status !== 0) {
    return integrity("CLOSED_PROCESS_FAILED");
  }
  return pass({
    stdout: result.stdout,
    resultSha256: sha256(
      canonicalJsonBytes({
        exitCode: result.status,
        stderrSha256: sha256(Buffer.from(result.stderr, "utf8")),
        stdoutSha256: sha256(Buffer.from(result.stdout, "utf8")),
      }),
    ),
  });
}

function verifyReadback(readback, executablePath, environment, cwd) {
  const result = runClosedProcess(
    executablePath,
    readback.argv,
    environment,
    cwd,
  );
  if (result.status !== "PASS") return result;
  const normalized = result.stdout.trim();
  if (readback.expected !== undefined && normalized !== readback.expected) {
    return integrity("CLOSED_PROCESS_READBACK_MISMATCH");
  }
  if (readback.expectedSetSha256 !== undefined) {
    const normalizedSet = result.stdout
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean)
      .sort();
    if (
      sha256(canonicalJsonBytes(normalizedSet)) !== readback.expectedSetSha256
    ) {
      return integrity("CLOSED_PROCESS_READBACK_MISMATCH");
    }
  }
  if (readback.expectedStatus !== undefined) {
    const [status, observedPath] = normalized.split(/\s+/, 2);
    if (
      status !== readback.expectedStatus ||
      observedPath !== readback.expectedPath
    ) {
      return integrity("CLOSED_PROCESS_READBACK_MISMATCH");
    }
  }
  if (
    readback.expectedAbsentPath !== undefined &&
    result.stdout.includes(readback.expectedAbsentPath)
  ) {
    return integrity("CLOSED_PROCESS_READBACK_MISMATCH");
  }
  return pass({ resultSha256: result.resultSha256 });
}

export async function executeClosedInvocation(invocation, trust, environment) {
  if (
    !exactKeys(environment, ALLOWED_ENVIRONMENT_NAMES) ||
    environment.NPM_CONFIG_USERCONFIG !== "/dev/null" ||
    environment.CI !== "1" ||
    environment.LANG !== "C.UTF-8" ||
    environment.LC_ALL !== "C.UTF-8"
  ) {
    return integrity("EXECUTION_ENVIRONMENT_INVALID");
  }
  const executablePath = trust?.executableByRole?.[invocation.executableRole];
  if (
    !isAbsoluteNormalized(executablePath) ||
    !Array.isArray(invocation.argv)
  ) {
    return integrity("EXECUTABLE_ROLE_UNAVAILABLE");
  }
  const readbacks = Array.isArray(invocation.readbacks)
    ? invocation.readbacks
    : [];
  for (const readback of readbacks.filter(({ phase }) => phase === "BEFORE")) {
    const checked = verifyReadback(
      readback,
      executablePath,
      environment,
      invocation.cwd,
    );
    if (checked.status !== "PASS") return checked;
  }
  const executed = runClosedProcess(
    executablePath,
    invocation.argv,
    environment,
    invocation.cwd,
  );
  if (executed.status !== "PASS") return executed;
  for (const readback of readbacks.filter(({ phase }) => phase === "AFTER")) {
    const checked = verifyReadback(
      readback,
      executablePath,
      environment,
      invocation.cwd,
    );
    if (checked.status !== "PASS") return checked;
  }
  return pass({ outputRecordSha256: executed.resultSha256 });
}

export async function runLauncherCli(argv, options = {}) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 2 ||
    argv[0] !== "--request" ||
    !isAbsoluteNormalized(argv[1])
  ) {
    return { exitCode: 64, result: integrity("CLI_ARGUMENTS_INVALID") };
  }
  const requestRoot = options.requestRoot ?? DEFAULT_REQUEST_ROOT;
  const outputRoot = options.outputRoot ?? DEFAULT_OUTPUT_ROOT;
  const expectedUid = options.expectedUid ?? 0;
  const expectedGid = options.expectedGid ?? 0;
  if (path.posix.dirname(argv[1]) !== requestRoot) {
    return { exitCode: 65, result: integrity("REQUEST_PATH_INVALID") };
  }
  const roots = await Promise.all([
    verifyControlledDirectory(requestRoot, {
      expectedMode: 0o700,
      expectedUid,
      expectedGid,
    }),
    verifyControlledDirectory(outputRoot, {
      expectedMode: 0o700,
      expectedUid,
      expectedGid,
    }),
  ]);
  if (roots.some(({ status }) => status !== "PASS")) {
    return { exitCode: 66, result: integrity("ROOT_PERMISSION_INVALID") };
  }
  const requestFile = await verifyControlledFile(argv[1], {
    expectedMode: 0o600,
    expectedUid,
    expectedGid,
  });
  if (requestFile.status !== "PASS")
    return { exitCode: 67, result: requestFile };
  const parsed = parseClosedCommandRequest(requestFile.bytes, {
    requestRoot,
    outputRoot,
  });
  if (parsed.status !== "PASS") return { exitCode: 68, result: parsed };
  const request = parsed.request;
  const inputFile = await verifyControlledFile(request.input.inputRecordPath, {
    expectedSha256: request.input.inputRecordSha256,
    expectedMode: 0o600,
    expectedUid,
    expectedGid,
  });
  if (inputFile.status !== "PASS") return { exitCode: 69, result: inputFile };
  const verifyTrust = options.verifyTrust ?? verifyFixedLauncherTrust;
  const trust = await verifyTrust(request, {
    ...options,
    expectedUid,
    expectedGid,
  });
  if (trust.status !== "PASS") return { exitCode: 70, result: trust };
  const evidenceFiles = [];
  for (const field of [
    "authorizationReceiptSha256",
    "externalControllerReceiptSha256",
    "anchorReceiptSha256",
  ]) {
    const expectedSha256 = request[field];
    if (expectedSha256 === null) continue;
    const evidencePath =
      options.evidencePaths?.[field] ??
      (field === "anchorReceiptSha256"
        ? "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json"
        : undefined);
    if (!isAbsoluteNormalized(evidencePath)) {
      return {
        exitCode: 70,
        result: integrity("EVIDENCE_PATH_UNAVAILABLE"),
      };
    }
    const evidence = await verifyControlledFile(evidencePath, {
      expectedSha256,
      expectedMode: 0o600,
      expectedUid,
      expectedGid,
    });
    if (evidence.status !== "PASS") return { exitCode: 70, result: evidence };
    evidenceFiles.push({
      path: evidencePath,
      expectedSha256,
      expectedMode: 0o600,
    });
  }
  try {
    await lstat(request.input.outputRecordPath, { bigint: true });
    return { exitCode: 71, result: integrity("OUTPUT_ALREADY_EXISTS") };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return { exitCode: 71, result: integrity("OUTPUT_STATE_UNAVAILABLE") };
    }
  }
  const executeInvocation =
    options.executeInvocation ??
    (() => integrity("AUTHORITY_EXECUTOR_REQUIRED"));
  const replaySet = new Set();
  const worktreeReceipt = await deriveVerifiedWorktreeReceipt(
    request,
    trust,
    options,
  );
  if (worktreeReceipt.status !== "PASS") {
    return { exitCode: 70, result: worktreeReceipt };
  }
  const dispatched = await dispatchClosedCommand(request, {
    requestRoot,
    outputRoot,
    inputRecordBytes: inputFile.bytes,
    outputExists: false,
    requestReplaySet: replaySet,
    verifiedWorktreeReceipt: worktreeReceipt.verifiedWorktreeReceipt,
    preDispatchReverify: async () => {
      const [requestAgain, inputAgain] = await Promise.all([
        verifyControlledFile(argv[1], {
          expectedSha256: requestFile.observation.sha256,
          expectedMode: 0o600,
          expectedUid,
          expectedGid,
        }),
        verifyControlledFile(request.input.inputRecordPath, {
          expectedSha256: request.input.inputRecordSha256,
          expectedMode: 0o600,
          expectedUid,
          expectedGid,
        }),
      ]);
      if (requestAgain.status !== "PASS" || inputAgain.status !== "PASS") {
        return integrity("PRE_DISPATCH_TOCTOU");
      }
      const reverifyFiles = [
        ...(Array.isArray(trust.verificationFiles)
          ? trust.verificationFiles
          : []),
        ...evidenceFiles,
      ];
      for (const entry of reverifyFiles) {
        const verified = await verifyControlledFile(entry.path, {
          expectedSha256: entry.expectedSha256,
          expectedMode: entry.expectedMode,
          expectedUid,
          expectedGid,
        });
        if (verified.status !== "PASS") return verified;
      }
      return pass();
    },
    loadDependency: executeInvocation,
  });
  if (dispatched.status !== "PASS") {
    return { exitCode: 73, result: dispatched };
  }
  const receiptFile = await verifyControlledFile(
    request.input.outputRecordPath,
    {
      expectedSha256: dispatched.executionResult?.receiptSha256,
      expectedMode: 0o600,
      expectedUid,
      expectedGid,
    },
  );
  if (receiptFile.status !== "PASS") {
    return { exitCode: 72, result: receiptFile };
  }
  let receipt;
  try {
    receipt = JSON.parse(receiptFile.bytes.toString("utf8"));
  } catch {
    return { exitCode: 72, result: integrity("BOOTSTRAP_RECEIPT_INVALID") };
  }
  if (
    !receiptFile.bytes.equals(canonicalJsonBytes(receipt)) ||
    validateBootstrapRunReceipt(receipt, request).status !== "PASS"
  ) {
    return { exitCode: 72, result: integrity("BOOTSTRAP_RECEIPT_INVALID") };
  }
  return {
    exitCode: 0,
    result: pass({ receipt }),
  };
}

const IS_DIRECT_EXECUTION =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_DIRECT_EXECUTION) {
  runLauncherCli(process.argv.slice(2))
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      process.exitCode = 74;
    });
}
