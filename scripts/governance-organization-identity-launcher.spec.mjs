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
    });
    assert.equal(result.status, "PASS");
    assert.equal(
      canonical(result.invocation.preconditions),
      canonical(parameters),
    );
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

test("parses a canonical request into a null-prototype record", () => {
  const result = parse(validRequest());
  assert.equal(result.status, "PASS");
  assert.equal(Object.getPrototypeOf(result.request), null);
  assert.equal(Object.getPrototypeOf(result.request.parameters), null);
});

test("rejects malformed, noncanonical, extra-key, and non-NFC request bytes", () => {
  const request = validRequest();
  const cases = [
    Buffer.from(JSON.stringify(request)),
    Buffer.from(`${canonical({ ...request, argv: ["--hostile"] })}\n`),
    Buffer.from(`${canonical({ ...request, taskId: "e\u0301" })}\n`),
    Buffer.from("{not-json}\n"),
  ];
  for (const bytes of cases) {
    assert.equal(
      parseClosedCommandRequest(bytes, {
        requestRoot: REQUEST_ROOT,
        outputRoot: OUTPUT_ROOT,
      }).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("rejects accessor and proxy JSON surrogates without evaluating dependencies", () => {
  let getterReads = 0;
  const accessor = Object.defineProperty({}, "schemaVersion", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "organization-identity-closed-command-request/v2";
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("hostile proxy trap");
      },
    },
  );
  for (const surrogate of [accessor, proxy]) {
    const result = parseClosedCommandRequest(Buffer.from("{}\n"), {
      requestRoot: REQUEST_ROOT,
      outputRoot: OUTPUT_ROOT,
      parseJson: () => surrogate,
    });
    assert.deepEqual(result, {
      status: "INTEGRITY_ERROR",
      code: "CANONICAL_JSON_INVALID",
    });
  }
  assert.equal(getterReads, 0);
});

test("rejects symbol-keyed and accessor-bearing array JSON surrogates", () => {
  const withSymbol = [];
  withSymbol[Symbol("hidden")] = "metadata";
  const withAccessor = [];
  Object.defineProperty(withAccessor, "hidden", {
    enumerable: false,
    get() {
      throw new Error("must not run");
    },
  });
  for (const parameters of [withSymbol, withAccessor]) {
    const surrogate = { ...validRequest(), parameters };
    const result = parseClosedCommandRequest(canonicalJsonBytes(surrogate), {
      requestRoot: REQUEST_ROOT,
      outputRoot: OUTPUT_ROOT,
      parseJson: () => surrogate,
    });
    assert.deepEqual(result, {
      status: "INTEGRITY_ERROR",
      code: "CANONICAL_JSON_INVALID",
    });
  }
});

test("rejects arbitrary command IDs, modes, shell text, and unknown task IDs", () => {
  const cases = [
    { commandId: "node scripts/governance-verify.mjs" },
    { commandId: "GITHUB_PR_MERGE_V1" },
    { mode: "TEST; touch /tmp/hostile" },
    { mode: "ARBITRARY" },
    { taskId: "../../other" },
  ];
  for (const mutation of cases) {
    const request = { ...validRequest(), ...mutation };
    const result = parseClosedCommandRequest(
      Buffer.from(`${canonical(request)}\n`),
      { requestRoot: REQUEST_ROOT, outputRoot: OUTPUT_ROOT },
    );
    assert.equal(result.status, "INTEGRITY_ERROR");
  }
});

test("rejects relative, out-of-root, misnamed, and content-address mismatch paths", () => {
  const original = validRequest();
  const cases = [
    { ...original.input, inputRecordPath: "relative.input.json" },
    { ...original.input, inputRecordPath: "/tmp/other.input.json" },
    { ...original.input, outputRecordPath: "/tmp/other.output.json" },
    { ...original.input, inputRecordUri: `sha256:${SHA_C}` },
    { ...original.input, inputRecordPath: `${REQUEST_ROOT}/wrong.input.json` },
  ];
  for (const input of cases) {
    const result = parseClosedCommandRequest(
      Buffer.from(`${canonical({ ...original, input })}\n`),
      { requestRoot: REQUEST_ROOT, outputRoot: OUTPUT_ROOT },
    );
    assert.equal(result.status, "INTEGRITY_ERROR");
  }
});

test("rejects payload schema, payload digest, request ID, and argv digest drift", () => {
  const request = validRequest();
  for (const mutation of [
    { input: { ...request.input, payloadSchemaSha256: SHA } },
    { input: { ...request.input, payloadSha256: SHA } },
    { requestId: SHA },
    { allowedArgvSha256: SHA },
  ]) {
    const result = parseClosedCommandRequest(
      Buffer.from(`${canonical({ ...request, ...mutation })}\n`),
      { requestRoot: REQUEST_ROOT, outputRoot: OUTPUT_ROOT },
    );
    assert.equal(result.status, "INTEGRITY_ERROR");
  }
});

test("rejects scanner baseline, stage, acceptance, and API suite values outside their unions", () => {
  const cases = [
    validRequest({
      commandId: "SCANNER_BASELINE_V1",
      mode: "BASELINE_CHECK",
      parameters: {
        baselineSubjectCommit: COMMIT,
        currentMainAdmissionCommit: "2".repeat(40),
        b0mMigrationCommit: "3".repeat(40),
        artifactACommit: "2400bac28796bae44294114edc99eaccb1bd65b3",
        dispositionReceiptSha256: null,
        outputDirectory: "/tmp",
      },
    }),
    validRequest({
      commandId: "SCANNER_STAGE_V1",
      mode: "STAGE_CHECK",
      parameters: {
        baselineSubjectCommit: COMMIT,
        currentMainAdmissionCommit: "2".repeat(40),
        b0mMigrationCommit: "3".repeat(40),
        stage: "B7_UNKNOWN",
      },
    }),
    validRequest({
      commandId: "SCANNER_ACCEPTANCE_V1",
      mode: "ACCEPTANCE_CHECK",
      parameters: {
        baselineSubjectCommit: COMMIT,
        currentMainAdmissionCommit: "2".repeat(40),
        b0mMigrationCommit: "3".repeat(40),
        implementationParent: COMMIT,
        implementationReviewSha256: SHA,
        acceptancePath: "/tmp/acceptance.json",
      },
    }),
    validRequest({
      commandId: "API_VERIFY_V1",
      mode: "VERIFY",
      parameters: { suiteId: "API_EVERYTHING" },
    }),
  ];
  for (const request of cases) {
    assert.equal(parse(request).status, "INTEGRITY_ERROR");
  }
});

test("verifies the complete executable closure and rejects omissions, extras, relative paths, or inode drift", () => {
  const entries = closure();
  assert.deepEqual(verifyExecutableClosure(entries, entries), {
    status: "PASS",
    executableClosureSetSha256: sha(`${canonical(entries)}\n`),
  });
  for (const candidate of [
    entries.slice(0, -1),
    [...entries, { ...entries[0], role: "GH" }],
    entries.map((entry, index) =>
      index === 1 ? { ...entry, executablePath: "node" } : entry,
    ),
    entries.map((entry, index) =>
      index === 1 ? { ...entry, sha256: SHA_C } : entry,
    ),
  ]) {
    assert.equal(
      verifyExecutableClosure(entries, candidate).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("verifies the immutable launcher trust roots and permission matrix", () => {
  const contractDigests = computeLauncherContractDigests();
  const contract = {
    schemaVersion: "organization-identity-launcher-contract/v2",
    rootDirectory:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher",
    requestRoot: REQUEST_ROOT,
    outputRoot: OUTPUT_ROOT,
    rootPolicy: {
      ownerUid: 0,
      ownerGid: 0,
      directoryMode: 0o700,
      requestMode: 0o600,
      outputMode: 0o600,
      createExclusive: true,
      rejectSymlink: true,
    },
    approvedPlan: {
      path: "docs/superpowers/plans/2026-09-01-organization-identity-writer-ban-at-source.md",
      commit: "543c9416b4bc18be4bde37825f4fcd74a78c229c",
      blobId: "ff6a8dd57f90b2a95b6a32e4ea2bd4ca8f6bcf8c",
      sha256:
        "05bf739511871466a57a002031930da1166fa4f40c71390bafb2f38421b811f9",
    },
    approvedSpec: {
      path: "docs/superpowers/specs/2026-09-01-organization-identity-writer-ban-at-source-design.md",
      commit: "b060c5dd4afef9fe42dfe510b02f930f56cdf7fe",
      blobId: "98891bcab636b852e71919b7de77343647917017",
      sha256:
        "536e376a40d9ef4f49a65bc0224b74d58eb8a2d743fa766aa020397e67279dd4",
    },
    approvedLauncher: {
      path: "scripts/governance-organization-identity-launcher.mjs",
      commit: COMMIT,
      blobId: "4".repeat(40),
      sha256: SHA,
    },
    approvedBootstrap: {
      path: "scripts/governance-organization-identity-bootstrap.mjs",
      commit: COMMIT,
      blobId: "5".repeat(40),
      sha256: SHA_B,
    },
    executableClosure: closure(),
    commandIds: expectedCommandIds,
    ...contractDigests,
  };
  const observed = {
    rootDirectory: { ownerUid: 0, ownerGid: 0, mode: 0o700, symlink: false },
    requestRoot: { ownerUid: 0, ownerGid: 0, mode: 0o700, symlink: false },
    outputRoot: { ownerUid: 0, ownerGid: 0, mode: 0o700, symlink: false },
    approvedPlan: contract.approvedPlan,
    approvedSpec: contract.approvedSpec,
    executableClosure: closure(),
  };
  const verified = verifyLauncherContract(contract, observed);
  assert.equal(verified.status, "PASS", verified.code);
  assert.equal(
    verifyLauncherContract(
      { ...contract, commandRegistrySha256: SHA },
      observed,
    ).status,
    "INTEGRITY_ERROR",
  );
  for (const mutation of [
    { ...observed, requestRoot: { ...observed.requestRoot, mode: 0o755 } },
    { ...observed, outputRoot: { ...observed.outputRoot, ownerUid: 1000 } },
    {
      ...observed,
      rootDirectory: { ...observed.rootDirectory, symlink: true },
    },
    { ...observed, approvedSpec: { ...observed.approvedSpec, sha256: SHA } },
  ]) {
    assert.equal(
      verifyLauncherContract(contract, mutation).status,
      "INTEGRITY_ERROR",
    );
  }
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
    preDispatchReverify: async () => {
      reverifyCount += 1;
      return { status: "PASS" };
    },
    loadDependency: async (invocation) => {
      dependencyLoadCount += 1;
      return invocation;
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

test("controlled-file preflight rejects symlinks, hardlinks, broad modes, and inode replacement", async (t) => {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "identity-launcher-"),
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const bytes = canonicalJsonBytes({ fixture: "safe" });
  const expectedSha256 = sha(bytes);
  const safePath = path.join(fixtureRoot, "safe.json");
  await writeFile(safePath, bytes, { mode: 0o600 });
  await chmod(safePath, 0o600);
  const identity = {
    expectedSha256,
    expectedMode: 0o600,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
  };
  assert.equal((await verifyControlledFile(safePath, identity)).status, "PASS");

  const symlinkPath = path.join(fixtureRoot, "link.json");
  await symlink(safePath, symlinkPath);
  assert.equal(
    (await verifyControlledFile(symlinkPath, identity)).status,
    "INTEGRITY_ERROR",
  );

  const hardlinkPath = path.join(fixtureRoot, "hard.json");
  await link(safePath, hardlinkPath);
  assert.equal(
    (await verifyControlledFile(safePath, identity)).code,
    "CONTROLLED_FILE_LINK_INVALID",
  );
  await rm(hardlinkPath);
  await chmod(safePath, 0o644);
  assert.equal(
    (await verifyControlledFile(safePath, identity)).code,
    "CONTROLLED_FILE_PERMISSION_INVALID",
  );
  await chmod(safePath, 0o600);

  assert.equal(
    (
      await verifyControlledFile(safePath, identity, {
        afterRead: async () => {
          const replacement = path.join(fixtureRoot, "replacement.json");
          await writeFile(replacement, bytes, { mode: 0o600 });
          await rm(safePath);
          await import("node:fs/promises").then(({ rename }) =>
            rename(replacement, safePath),
          );
        },
      })
    ).code,
    "CONTROLLED_FILE_TOCTOU",
  );
});

test("launcher CLI rejects wrong argc and flags at process level", () => {
  for (const args of [
    [],
    ["--bad"],
    ["--request"],
    ["--request", "relative.json"],
    ["--request", "/tmp/a", "extra"],
  ]) {
    const result = spawnSync(process.execPath, [launcherModulePath, ...args], {
      encoding: "utf8",
      env: {},
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
});

test("launcher CLI reads canonical request/input, reserves output once, and dispatches exactly once", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "identity-cli-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const requestRoot = path.join(fixtureRoot, "requests");
  const outputRoot = path.join(fixtureRoot, "outputs");
  await import("node:fs/promises").then(({ mkdir }) =>
    Promise.all([
      mkdir(requestRoot, { mode: 0o700 }),
      mkdir(outputRoot, { mode: 0o700 }),
    ]),
  );
  const authorizationBytes = canonicalJsonBytes({
    schemaVersion: "authorization-fixture/v1",
    scope: "one-request",
  });
  const authorizationPath = path.join(fixtureRoot, "authorization.json");
  await writeFile(authorizationPath, authorizationBytes, { mode: 0o600 });
  const request = validRequest({
    requestRoot,
    outputRoot,
    authorizationReceiptSha256: sha(authorizationBytes),
  });
  await writeFile(
    request.input.inputRecordPath,
    canonicalJsonBytes(request.parameters),
    {
      mode: 0o600,
    },
  );
  const requestPath = path.join(requestRoot, "request.json");
  await writeFile(requestPath, canonicalJsonBytes(request), { mode: 0o600 });
  let executionCount = 0;
  const options = {
    requestRoot,
    outputRoot,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    verifyTrust: async () => ({ status: "PASS" }),
    evidencePaths: {
      authorizationReceiptSha256: authorizationPath,
    },
    executeInvocation: async () => {
      executionCount += 1;
      return { status: "PASS", outputRecordSha256: SHA };
    },
  };
  assert.notEqual(
    (
      await runLauncherCli(["--request", requestPath], {
        ...options,
        evidencePaths: {},
      })
    ).exitCode,
    0,
  );
  assert.equal(executionCount, 0);
  assert.equal(
    (await runLauncherCli(["--request", requestPath], options)).exitCode,
    0,
  );
  const output = JSON.parse(
    await readFile(request.input.outputRecordPath, "utf8"),
  );
  assert.equal(output.requestId, request.requestId);
  assert.equal(output.result, "PASS");
  assert.equal(executionCount, 1);
  assert.notEqual(
    (await runLauncherCli(["--request", requestPath], options)).exitCode,
    0,
  );
  assert.equal(executionCount, 1);
});

test("closed executor rejects inherited loader names before hostile marker execution", async (t) => {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "identity-executor-"),
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const marker = path.join(fixtureRoot, "marker");
  const environment = Object.fromEntries(
    expectedEnvironmentNames.map((name) => [
      name,
      name === "NPM_CONFIG_USERCONFIG"
        ? "/dev/null"
        : name === "CI"
          ? "1"
          : name === "LANG" || name === "LC_ALL"
            ? "C.UTF-8"
            : fixtureRoot,
    ]),
  );
  const invocation = {
    executableRole: "NODE",
    argv: [
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
    ],
    readbacks: [],
  };
  const trust = { executableByRole: { NODE: process.execPath } };
  assert.equal(
    (
      await executeClosedInvocation(invocation, trust, {
        ...environment,
        NODE_OPTIONS: "--require=/tmp/hostile.cjs",
      })
    ).code,
    "EXECUTION_ENVIRONMENT_INVALID",
  );
  assert.rejects(readFile(marker));
  assert.equal(
    (
      await executeClosedInvocation(
        { ...invocation, argv: ["-e", ""] },
        trust,
        environment,
      )
    ).status,
    "PASS",
  );
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

test("renders a wrapper that accepts one absolute request and clears inherited Node loaders", () => {
  const environment = Object.fromEntries(
    expectedEnvironmentNames.map((name) => [
      name,
      name === "NPM_CONFIG_USERCONFIG"
        ? "/dev/null"
        : name === "CI"
          ? "1"
          : name === "LANG" || name === "LC_ALL"
            ? "C.UTF-8"
            : `/controlled/${name.toLowerCase()}`,
    ]),
  );
  const wrapper = renderRootWrapper({
    environment,
    nodePath: "/controlled/bin/node",
    launcherPath:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/identity-writer-launch.mjs",
  });
  assert.match(wrapper, /^#!\/bin\/sh\n/);
  assert.match(wrapper, /exec \/usr\/bin\/env -i/);
  assert.match(wrapper, /NPM_CONFIG_USERCONFIG=\/dev\/null/);
  assert.match(wrapper, /--request "\$2"/);
  assert.equal(wrapper.includes("NODE_OPTIONS"), false);
  assert.equal(wrapper.includes("NODE_PATH"), false);
  for (const forbidden of ["eval", "`", "$(", " jq ", "source ", "PATH=node"]) {
    assert.equal(wrapper.includes(forbidden), false);
  }
  assert.throws(
    () =>
      renderRootWrapper({
        environment: { ...environment, NODE_OPTIONS: "--require=/tmp/hostile" },
        nodePath: "/controlled/bin/node",
        launcherPath: "/controlled/launcher.mjs",
      }),
    /ENVIRONMENT_NAME_SET_INVALID/,
  );
});

function bootstrapReceipt(overrides = {}) {
  const request = validRequest();
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
    closedCommandRequestSha256: sha(canonicalJsonBytes(request)),
    inputRecordPath: request.input.inputRecordPath,
    inputRecordUri: request.input.inputRecordUri,
    inputRecordSha256: request.input.inputRecordSha256,
    payloadSchemaSha256: request.input.payloadSchemaSha256,
    payloadSha256: request.input.payloadSha256,
    outputRecordPath: request.input.outputRecordPath,
    outputRecordSha256: SHA,
    authorizationReceiptSha256: null,
    externalControllerReceiptSha256: null,
    anchorReceiptSha256: null,
    externalLaunchReceiptSha256: SHA,
    acceptedSubjectCommit: COMMIT,
    subjectConfigurationSetSha256: SHA,
    subjectAbsenceSentinelSetSha256: SHA,
    subjectGitClosureSha256: SHA,
    environmentValueSetSha256: SHA,
    taskRoot: "/controlled/task-root",
    taskRootDevice: "1",
    taskRootInode: "2",
    fixedRootSetSha256: SHA,
    postInstallBootstrapRehashSha256: SHA,
    dependencyDeclarationRoots: [],
    toolExecutionRoots: [],
    prismaSchemaSha256: SHA,
    generatedClientSetSha256: SHA,
    generatedDmmfSha256: SHA,
    generatedDelegateSetSha256: SHA,
    generatedOutputSetSha256: SHA,
    typescriptDynamicImportSha256: SHA,
    hostileMarkerSetSha256: SHA,
    hostileMarkerExecutionCount: 0,
    prePostToctouSha256: SHA,
    startedAt: "2026-09-03T00:00:00.000Z",
    finishedAt: "2026-09-03T00:00:01.000Z",
    result: "PASS",
    ...overrides,
  };
}

test("validates one-command bootstrap receipts and rejects receipt reuse", () => {
  const request = validRequest();
  const receipt = bootstrapReceipt();
  assert.equal(validateBootstrapRunReceipt(receipt, request).status, "PASS");
  assert.equal(
    validateBootstrapRunReceipt(
      { ...receipt, hostileMarkerExecutionCount: 1 },
      request,
    ).status,
    "INTEGRITY_ERROR",
  );
  assert.equal(
    validateBootstrapRunReceipt(
      { ...receipt, commandId: "API_VERIFY_V1" },
      request,
    ).status,
    "INTEGRITY_ERROR",
  );

  const entry = {
    requestId: receipt.requestId,
    commandId: receipt.commandId,
    requestSha256: receipt.closedCommandRequestSha256,
    receiptSha256: sha(canonicalJsonBytes(receipt)),
  };
  const receiptSet = {
    schemaVersion: "organization-identity-bootstrap-run-set/v1",
    taskId: "2",
    subjectCommit: COMMIT,
    receiptCount: 1,
    receipts: [entry],
    receiptSetSha256: sha(canonicalJsonBytes([entry])),
  };
  assert.equal(validateBootstrapRunReceiptSet(receiptSet).status, "PASS");
  const reused = {
    ...receiptSet,
    receiptCount: 2,
    receipts: [entry, entry],
    receiptSetSha256: sha(canonicalJsonBytes([entry, entry])),
  };
  assert.deepEqual(validateBootstrapRunReceiptSet(reused), {
    status: "INTEGRITY_ERROR",
    code: "BOOTSTRAP_RECEIPT_REPLAY",
  });
});

test("validates the one-way four-file launcher materialization receipt chain", () => {
  const readback = {
    schemaVersion: "organization-identity-launcher-readback/v1",
    launcherContractSha256: SHA,
    fourFileObservationSetSha256: SHA,
    requestRootObservationSha256: SHA,
    outputRootObservationSha256: SHA,
    executableClosureObservationSha256: SHA,
    hostileCounterexampleSetSha256: SHA,
    reviewerClass: "INDEPENDENT_ROOT_LAUNCHER_READBACK",
    observedAt: "2026-09-03T00:00:00.000Z",
  };
  const readbackSha = sha(canonicalJsonBytes(readback));
  assert.equal(validateLauncherReadbackReport(readback).status, "PASS");
  assert.equal(
    validateLauncherReadbackReport({ ...readback, extraPath: "/tmp/other" })
      .status,
    "INTEGRITY_ERROR",
  );

  const files = [
    ["identity-writer-launch", 0o500],
    ["identity-writer-launch.mjs", 0o500],
    ["identity-writer-bootstrap.mjs", 0o500],
    ["launcher-contract.json", 0o600],
  ].map(([basename, mode], index) => ({
    basename,
    mode,
    device: "1",
    inode: String(index + 1),
    realpathSha256: String(index + 1).repeat(64),
    sha256: String(index + 2).repeat(64),
    size: 100 + index,
  }));
  const materialization = {
    schemaVersion: "organization-identity-launcher-materialization/v2",
    launcherContractSha256: SHA,
    ownerUid: 0,
    ownerGid: 0,
    directoryMode: 0o700,
    files,
    requestRoot: {
      mode: 0o700,
      device: "1",
      inode: "10",
      realpathSha256: SHA,
    },
    outputRoot: {
      mode: 0o700,
      device: "1",
      inode: "11",
      realpathSha256: SHA,
    },
    fourFileFsyncSha256: SHA,
    directoryFsyncSha256: SHA,
    readbackReportSha256: readbackSha,
    prePostToctouSha256: SHA,
    materializedAt: "2026-09-03T00:00:01.000Z",
    result: "PASS",
  };
  assert.equal(
    validateLauncherMaterializationReceipt(materialization, readback).status,
    "PASS",
  );
  assert.equal(
    validateLauncherMaterializationReceipt(materialization).status,
    "INTEGRITY_ERROR",
  );
  for (const mutation of [
    { ...materialization, files: [...files].reverse() },
    {
      ...materialization,
      files: files.map((file, index) =>
        index === 0 ? { ...file, mode: 0o755 } : file,
      ),
    },
    { ...materialization, directoryFsyncSha256: null },
    { ...materialization, ownerUid: 1000 },
    { ...materialization, result: "HOLD" },
  ]) {
    assert.equal(
      validateLauncherMaterializationReceipt(mutation, readback).status,
      "INTEGRITY_ERROR",
    );
  }

  const review = {
    schemaVersion: "organization-identity-launcher-materialization-review/v1",
    launcherContractSha256: SHA,
    launcherMaterializationReceiptSha256: sha(
      canonicalJsonBytes(materialization),
    ),
    readbackReportSha256: readbackSha,
    reportSha256: SHA,
    counterexampleSetSha256: SHA,
    reviewerClass: "INDEPENDENT_ROOT_LAUNCHER_REVIEW",
    critical: 0,
    important: 0,
    verdict: "PASS",
  };
  assert.equal(
    validateLauncherMaterializationReviewReceipt(
      review,
      materialization,
      readback,
    ).status,
    "PASS",
  );
  assert.equal(
    validateLauncherMaterializationReviewReceipt(review).status,
    "INTEGRITY_ERROR",
  );
  for (const mutation of [
    {
      ...review,
      launcherMaterializationReceiptSha256: review.readbackReportSha256,
    },
    { ...review, critical: 1 },
    { ...review, important: 1 },
    { ...review, reviewerClass: "LOCAL_LAUNCHER" },
    { ...review, materializationReceipt: materialization },
  ]) {
    assert.equal(
      validateLauncherMaterializationReviewReceipt(
        mutation,
        materialization,
        readback,
      ).status,
      "INTEGRITY_ERROR",
    );
  }
});
