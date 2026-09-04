import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALLOWED_ENVIRONMENT_NAMES,
  LOCAL_COMMAND_IDS,
  buildClosedCommandRequest,
  canonicalJsonBytes,
  computeLauncherContractDigests,
  dispatchClosedCommand,
  executeClosedInvocation,
  parseClosedCommandRequest,
  renderRootWrapper,
  runLauncherCli,
  validateBootstrapRunReceipt,
  validateBootstrapRunReceiptSet,
  validateLauncherMaterializationReceipt,
  validateLauncherMaterializationReviewReceipt,
  validateLauncherReadbackReport,
  verifyExecutableClosure,
  verifyControlledFile,
  verifyLauncherContract,
} from "./governance-organization-identity-launcher.mjs";

const launcherModulePath = fileURLToPath(
  new URL("./governance-organization-identity-launcher.mjs", import.meta.url),
);

const SHA = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const COMMIT = "1".repeat(40);
const REQUEST_ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/requests";
const OUTPUT_ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/outputs";

const expectedCommandIds = [
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
];

const expectedEnvironmentNames = [
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
];

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function closure() {
  return [
    "ENV",
    "NODE",
    "GIT",
    "COREPACK_SHIM",
    "COREPACK_LIB_COREPACK_CJS",
    "PNPM_SHIM",
    "PNPM_ENTRYPOINT",
  ].map((role, index) => ({
    role,
    logicalIdentity: `${role.toLowerCase()}@test`,
    executablePath: `/controlled/bin/${role.toLowerCase()}`,
    realpathSha256: String(index + 1).repeat(64),
    sha256: String(index + 2).repeat(64),
    size: 100 + index,
    mode: 0o500,
  }));
}

function validRequest(overrides = {}) {
  return buildClosedCommandRequest({
    taskId: "2",
    commandId: "SCANNER_TEST_V1",
    mode: "TEST",
    subjectCommit: COMMIT,
    bootstrapContractSha256: SHA,
    launcherMaterializationReceiptSha256: SHA_B,
    launcherMaterializationReviewReceiptSha256: SHA_C,
    authorizationReceiptSha256: null,
    externalControllerReceiptSha256: null,
    anchorReceiptSha256: null,
    parameters: {
      baselineSubjectCommit: COMMIT,
      currentMainAdmissionCommit: "2".repeat(40),
      b0mMigrationCommit: "3".repeat(40),
      suiteId: "B0_SCANNER",
    },
    requestRoot: REQUEST_ROOT,
    outputRoot: OUTPUT_ROOT,
    ...overrides,
  });
}

function parse(request, options = {}) {
  return parseClosedCommandRequest(canonicalJsonBytes(request), {
    requestRoot: REQUEST_ROOT,
    outputRoot: OUTPUT_ROOT,
    ...options,
  });
}

function verifiedWorktreeReceipt(request, expectedMode = request.mode) {
  return {
    schemaVersion: "organization-identity-verified-worktree/v1",
    repositoryRoot: "/global/backend",
    worktreePath:
      "/global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v2",
    gitDirRealpathSha256: SHA,
    commonDirRealpathSha256: SHA,
    branch: "codex/pr407-organization-identity-caller-cutover-v2",
    headCommit: request.subjectCommit,
    subjectCommit: request.subjectCommit,
    statusPorcelainSha256: SHA,
    worktreeListEntrySha256: SHA,
    expectedMode,
    verifiedByExecutableClosureSha256: SHA,
    prePostToctouSha256: SHA,
    result: "PASS",
  };
}

test("the local command registry is exhaustive and excludes every external controller", () => {
  assert.deepEqual(LOCAL_COMMAND_IDS, expectedCommandIds);
  assert.deepEqual(ALLOWED_ENVIRONMENT_NAMES, expectedEnvironmentNames);
  const serialized = LOCAL_COMMAND_IDS.join("\n");
  for (const forbidden of [
    "GH",
    "GITHUB",
    "GITLEAKS",
    "DOCKER",
    "PSQL",
    "DISPOSABLE_POSTGRES",
    "ROOT_ANCHOR",
    "FETCH_EXACT_OBJECT",
    "PUSH_EXACT_BRANCH",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

function commandFixture(commandId) {
  const scannerCommon = {
    baselineSubjectCommit: COMMIT,
    currentMainAdmissionCommit: "2".repeat(40),
    b0mMigrationCommit: "3".repeat(40),
  };
  switch (commandId) {
    case "BOOTSTRAP_AUTHORITY_RUN_V1":
      return [
        "INSTALL_AND_PRISMA_GENERATE",
        {
          frozenLockfile: true,
          ignoreScripts: true,
          ignorePnpmfile: true,
          npmUserConfig: "/dev/null",
        },
      ];
    case "SCOPED_REVIEW_VERIFY_V1":
      return [
        "VERIFY",
        {
          reportPath: "/controlled/review.md",
          reportSha256: SHA,
          receiptPath: "/controlled/review.json",
          receiptSha256: SHA_B,
          reviewedSubjectCommit: COMMIT,
        },
      ];
    case "CURRENT_MAIN_AUDIT_LOCAL_V1":
      return [
        "COLLECT_LOCAL_FACTS",
        {
          branchPreRefreshCommit: COMMIT,
          advertisedLiveMainCommit: "2".repeat(40),
          githubControllerReceiptSha256: SHA,
        },
      ];
    case "CURRENT_MAIN_VALIDATE_V1":
    case "CURRENT_MAIN_GENERATE_V1":
      return [
        commandId === "CURRENT_MAIN_VALIDATE_V1" ? "VALIDATE" : "GENERATE",
        {
          auditPacketSha256: SHA,
          auditReviewReceiptSha256: SHA_B,
          refreshMergeCommit:
            commandId === "CURRENT_MAIN_VALIDATE_V1" ? null : "2".repeat(40),
          admissionPath:
            "docs/governance/organization-identity-current-main-admission.json",
        },
      ];
    case "COPY_WRITE_ELIGIBILITY_V1":
      return [
        "WRITE_ELIGIBILITY",
        {
          auditPacketSha256: SHA,
          eligibilityPath:
            "docs/evidence/site-builder/copy-runtime-eligibility.json",
        },
      ];
    case "COPY_SYNC_CITATIONS_V1":
      return [
        "SYNC_CITATIONS",
        {
          auditPacketSha256: SHA,
          eligibilityPath:
            "docs/evidence/site-builder/copy-runtime-eligibility.json",
          eligibilityInputSha256: SHA_B,
          citationPath:
            "docs/implementation-records/copy-fixed-source-impact-governance.md",
        },
      ];
    case "GIT_REFRESH_START_V1":
      return [
        "START_NO_COMMIT",
        {
          expectedHead: COMMIT,
          otherParent: "2".repeat(40),
          exactMergeResultPathSetSha256: SHA,
        },
      ];
    case "GIT_REFRESH_COMMIT_V1":
      return [
        "COMMIT_REFRESH",
        {
          expectedFirstParent: COMMIT,
          expectedSecondParent: "2".repeat(40),
          stagedPathSetSha256: SHA,
          commitMessage:
            "chore: merge admitted main for identity writer baseline",
        },
      ];
    case "GIT_ADMISSION_COMMIT_V1":
      return [
        "COMMIT_ADMISSION",
        {
          expectedParent: COMMIT,
          stagedPath:
            "docs/governance/organization-identity-current-main-admission.json",
          stagedStatus: "ADD",
          commitMessage:
            "chore: admit current main for identity writer baseline",
        },
      ];
    case "GIT_ACCEPTANCE_COMMIT_V1":
      return [
        "COMMIT_ACCEPTANCE",
        {
          expectedParent: COMMIT,
          stagedPath:
            "docs/governance/organization-identity-writer-acceptance.json",
          stagedStatus: "ADD",
          commitMessage: "chore: anchor organization identity writer baseline",
        },
      ];
    case "REFRESH_VERIFY_V1":
      return [
        "VERIFY",
        { suiteId: "REFRESH_FULL", refreshMergeCommit: COMMIT },
      ];
    case "MIGRATION_STATIC_VERIFY_V1":
      return [
        "VERIFY",
        { suiteId: "MIGRATION_0M_STATIC", b0mMigrationCommit: COMMIT },
      ];
    case "PRISMA_GENERATE_V1":
      return [
        "VERIFY",
        {
          suiteId: "PRISMA_GENERATE",
          schemaPath: "packages/db/prisma/schema.prisma",
        },
      ];
    case "SCANNER_TEST_V1":
      return ["TEST", { ...scannerCommon, suiteId: "B0_SCANNER" }];
    case "SCANNER_BASELINE_V1":
      return [
        "BASELINE_CHECK",
        {
          ...scannerCommon,
          artifactACommit: "2400bac28796bae44294114edc99eaccb1bd65b3",
          dispositionReceiptSha256: null,
          outputDirectory: null,
        },
      ];
    case "SCANNER_STAGE_V1":
      return ["STAGE_CHECK", { ...scannerCommon, stage: "B0_BASELINE" }];
    case "SCANNER_ZERO_V1":
      return ["ZERO_CHECK", { ...scannerCommon, expectedWriterCount: 3 }];
    case "SCANNER_ACCEPTANCE_V1":
      return [
        "ACCEPTANCE_CHECK",
        {
          ...scannerCommon,
          implementationParent: COMMIT,
          implementationReviewSha256: SHA,
          acceptancePath:
            "docs/governance/organization-identity-writer-acceptance.json",
        },
      ];
    case "GOVERNANCE_VERIFY_V1":
      return ["VERIFY", { suiteId: "GOVERNANCE_B0" }];
    case "DOCS_VERIFY_V1":
      return ["VERIFY", { suiteId: "DOCS_FULL" }];
    case "API_VERIFY_V1":
      return ["VERIFY", { suiteId: "API_FULL" }];
    case "RUNTIME_ARTIFACT_VERIFY_V1":
      return ["VERIFY", { suiteId: "RUNTIME_ARTIFACT" }];
    case "CONTRACT_GRAPH_VERIFY_V1":
      return ["VERIFY", { suiteId: "CONTRACT_GRAPH" }];
    case "V3_WORKTREE_CREATE_V1":
      return [
        "CREATE",
        {
          mergeCommit: COMMIT,
          branch: "codex/pr407-organization-identity-caller-cutover-v3",
          worktreePath:
            "/global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v3",
        },
      ];
    default:
      throw new Error(`missing fixture for ${commandId}`);
  }
}

test("every local command builds a complete executable descriptor from typed input", async () => {
  for (const commandId of LOCAL_COMMAND_IDS) {
    const [mode, parameters] = commandFixture(commandId);
    const request = validRequest({ commandId, mode, parameters });
    const result = await dispatchClosedCommand(request, {
      requestRoot: REQUEST_ROOT,
      outputRoot: OUTPUT_ROOT,
      inputRecordBytes: canonicalJsonBytes(request.parameters),
      requestReplaySet: new Set(),
      outputExists: false,
      preDispatchReverify: async () => ({ status: "PASS" }),
      verifiedWorktreeReceipt: verifiedWorktreeReceipt(request),
      loadDependency: async () => ({ status: "PASS" }),
    });
    assert.equal(result.status, "PASS", commandId);
    assert.equal(result.invocation.argv.length > 2, true, commandId);
    assert.equal(
      result.invocation.outputRecordPath,
      request.input.outputRecordPath,
    );
    assert.equal(result.invocation.subjectCommit, request.subjectCommit);
    assert.deepEqual(result.invocation.parameters, request.parameters);
    if (result.invocation.executableRole === "NODE") {
      assert.equal(
        result.invocation.argv[0],
        "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/identity-writer-bootstrap.mjs",
      );
    }
  }
});

test("Git descriptors retain exact state preconditions and immutable targets", async () => {
  for (const commandId of [
    "GIT_REFRESH_START_V1",
    "GIT_REFRESH_COMMIT_V1",
    "GIT_ADMISSION_COMMIT_V1",
    "GIT_ACCEPTANCE_COMMIT_V1",
    "V3_WORKTREE_CREATE_V1",
  ]) {
    const [mode, parameters] = commandFixture(commandId);
    const request = validRequest({ commandId, mode, parameters });
    const result = await dispatchClosedCommand(request, {
      requestRoot: REQUEST_ROOT,
      outputRoot: OUTPUT_ROOT,
      inputRecordBytes: canonicalJsonBytes(request.parameters),
      requestReplaySet: new Set(),
      outputExists: false,
      preDispatchReverify: async () => ({ status: "PASS" }),
      verifiedWorktreeReceipt: verifiedWorktreeReceipt(request),
      loadDependency: async () => ({ status: "PASS" }),
    });
    assert.equal(result.status, "PASS");
    assert.equal(
      canonical(result.invocation.preconditions),
      canonical(parameters),
    );
    assert.equal(
      result.invocation.cwd,
      "/global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v2",
    );
    const beforeReadbacks = result.invocation.readbacks.filter(
      ({ phase }) => phase === "BEFORE",
    );
    assert.equal(beforeReadbacks.length > 0, true);
    assert.equal(canonical(result.invocation).includes(COMMIT), true);
    if (commandId === "GIT_REFRESH_START_V1") {
      assert.equal(
        canonical(result.invocation).includes(
          parameters.exactMergeResultPathSetSha256,
        ),
        true,
      );
    }
  }
});

test("Git dispatch rejects an unverified caller CWD before loading", async () => {
  const [mode, parameters] = commandFixture("GIT_ACCEPTANCE_COMMIT_V1");
  const request = validRequest({
    commandId: "GIT_ACCEPTANCE_COMMIT_V1",
    mode,
    parameters,
  });
  let loads = 0;
  const result = await dispatchClosedCommand(request, {
    requestRoot: REQUEST_ROOT,
    outputRoot: OUTPUT_ROOT,
    inputRecordBytes: canonicalJsonBytes(request.parameters),
    requestReplaySet: new Set(),
    outputExists: false,
    preDispatchReverify: async () => ({ status: "PASS" }),
    loadDependency: async () => {
      loads += 1;
      return { status: "PASS" };
    },
  });
  assert.deepEqual(result, {
    status: "INTEGRITY_ERROR",
    code: "VERIFIED_WORKTREE_RECEIPT_REQUIRED",
  });
  assert.equal(loads, 0);
});

test("Git dispatch rejects caller-asserted worktree surrogates even when shape matches", async () => {
  const [mode, parameters] = commandFixture("GIT_REFRESH_START_V1");
  const request = validRequest({
    commandId: "GIT_REFRESH_START_V1",
    mode,
    parameters,
  });
  const result = await dispatchClosedCommand(request, {
    requestRoot: REQUEST_ROOT,
    outputRoot: OUTPUT_ROOT,
    inputRecordBytes: canonicalJsonBytes(request.parameters),
    outputExists: false,
    requestReplaySet: new Set(),
    preDispatchReverify: () => ({ status: "PASS" }),
    verifiedWorktree: {
      path: "/global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v2",
      subjectCommit: request.subjectCommit,
    },
    loadDependency: () => ({ status: "PASS" }),
  });
  assert.deepEqual(result, {
    status: "INTEGRITY_ERROR",
    code: "VERIFIED_WORKTREE_RECEIPT_REQUIRED",
  });
});

test("rejects an executable-looking value before dependency loading", async () => {
  let dependencyLoadCount = 0;
  let hostileMarkerExecutionCount = 0;
  const request = {
    ...validRequest(),
    commandId: "node scripts/governance-verify.mjs",
  };
  const result = await dispatchClosedCommand(request, {
    requestRoot: REQUEST_ROOT,
    outputRoot: OUTPUT_ROOT,
    inputRecordBytes: canonicalJsonBytes(request.parameters),
    loadDependency: async () => {
      dependencyLoadCount += 1;
      hostileMarkerExecutionCount += 1;
    },
  });
  assert.deepEqual(result, {
    status: "INTEGRITY_ERROR",
    code: "CLOSED_COMMAND_ID_INVALID",
  });
  assert.equal(dependencyLoadCount, 0);
  assert.equal(hostileMarkerExecutionCount, 0);
});

test("dispatch revalidates typed input and TOCTOU before one dependency load", async () => {
  const request = validRequest();
  let dependencyLoadCount = 0;
  let reverifyCount = 0;
  const context = {
    requestRoot: REQUEST_ROOT,
    outputRoot: OUTPUT_ROOT,
    inputRecordBytes: canonicalJsonBytes(request.parameters),
    requestReplaySet: new Set(),
    outputExists: false,
    verifiedWorktree: { path: process.cwd(), subjectCommit: COMMIT },
    preDispatchReverify: async () => {
      reverifyCount += 1;
      return { status: "PASS" };
    },
    loadDependency: async (invocation) => {
      dependencyLoadCount += 1;
      return {
        status: "PASS",
        invocation,
        executionResult: { status: "PASS" },
      };
    },
  };
  const result = await dispatchClosedCommand(request, context);
  assert.equal(result.status, "PASS");
  assert.equal(result.invocation.commandId, "SCANNER_TEST_V1");
  assert.equal(result.invocation.mode, "TEST");
  assert.equal(dependencyLoadCount, 1);
  assert.equal(reverifyCount, 1);
  assert.equal(
    (await dispatchClosedCommand(request, context)).code,
    "REQUEST_REPLAY",
  );
  assert.equal(dependencyLoadCount, 1);
});

test("dispatch requires a controller-owned replay set", async () => {
  const request = validRequest();
  const result = await dispatchClosedCommand(request, {
    requestRoot: REQUEST_ROOT,
    outputRoot: OUTPUT_ROOT,
    inputRecordBytes: canonicalJsonBytes(request.parameters),
    outputExists: false,
    preDispatchReverify: async () => ({ status: "PASS" }),
  });
  assert.deepEqual(result, {
    status: "INTEGRITY_ERROR",
    code: "REPLAY_GUARD_REQUIRED",
  });
});

test("dispatch refuses authority when no verified executor is supplied", async () => {
  const request = validRequest();
  const result = await dispatchClosedCommand(request, {
    requestRoot: REQUEST_ROOT,
    outputRoot: OUTPUT_ROOT,
    inputRecordBytes: canonicalJsonBytes(request.parameters),
    requestReplaySet: new Set(),
    outputExists: false,
    verifiedWorktree: {
      path: process.cwd(),
      subjectCommit: request.subjectCommit,
    },
    preDispatchReverify: async () => ({ status: "PASS" }),
  });
  assert.deepEqual(result, {
    status: "INTEGRITY_ERROR",
    code: "EXECUTOR_REQUIRED",
  });
});

test("dispatch rejects typed-input drift, output reuse, and failed inode revalidation before loading", async () => {
  const request = validRequest();
  const cases = [
    { inputRecordBytes: canonicalJsonBytes({ hostile: true }) },
    {
      inputRecordBytes: canonicalJsonBytes(request.parameters),
      outputExists: true,
    },
    {
      inputRecordBytes: canonicalJsonBytes(request.parameters),
      preDispatchReverify: async () => ({ status: "INTEGRITY_ERROR" }),
    },
  ];
  for (const mutation of cases) {
    let loads = 0;
    const result = await dispatchClosedCommand(request, {
      requestRoot: REQUEST_ROOT,
      outputRoot: OUTPUT_ROOT,
      requestReplaySet: new Set(),
      outputExists: false,
      preDispatchReverify: async () => ({ status: "PASS" }),
      loadDependency: async () => {
        loads += 1;
      },
      ...mutation,
    });
    assert.equal(result.status, "INTEGRITY_ERROR");
    assert.equal(loads, 0);
  }
});
