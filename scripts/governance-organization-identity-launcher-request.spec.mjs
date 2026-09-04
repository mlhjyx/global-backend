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
  const candidateReceipt = bootstrapReceipt({}, request);
  const candidateValidation = validateBootstrapRunReceipt(
    candidateReceipt,
    request,
  );
  assert.equal(candidateValidation.status, "PASS", candidateValidation.code);
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
      const receipt = candidateReceipt;
      const receiptBytes = canonicalJsonBytes(receipt);
      await writeFile(request.input.outputRecordPath, receiptBytes, {
        mode: 0o600,
        flag: "wx",
      });
      return { status: "PASS", receiptSha256: sha(receiptBytes) };
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
  const launched = await runLauncherCli(["--request", requestPath], options);
  assert.equal(launched.exitCode, 0, launched.result?.code);
  const output = JSON.parse(
    await readFile(request.input.outputRecordPath, "utf8"),
  );
  assert.equal(output.requestId, request.requestId);
  assert.equal(output.result, "PASS");
  assert.equal(output.schemaVersion, "organization-identity-bootstrap-run/v2");
  assert.equal(executionCount, 1);
  assert.notEqual(
    (await runLauncherCli(["--request", requestPath], options)).exitCode,
    0,
  );
  assert.equal(executionCount, 1);
});

test("dispatcher and CLI propagate returned and thrown executor failures without PASS output", async (t) => {
  const request = validRequest();
  const baseContext = {
    requestRoot: REQUEST_ROOT,
    outputRoot: OUTPUT_ROOT,
    inputRecordBytes: canonicalJsonBytes(request.parameters),
    requestReplaySet: new Set(),
    outputExists: false,
    preDispatchReverify: async () => ({ status: "PASS" }),
  };
  assert.deepEqual(
    await dispatchClosedCommand(request, {
      ...baseContext,
      loadDependency: async () => ({
        status: "INTEGRITY_ERROR",
        code: "PROCESS_FAILED",
      }),
    }),
    { status: "INTEGRITY_ERROR", code: "PROCESS_FAILED" },
  );
  assert.deepEqual(
    await dispatchClosedCommand(request, {
      ...baseContext,
      requestReplaySet: new Set(),
      loadDependency: async () => {
        throw new Error("hostile executor failure");
      },
    }),
    { status: "INTEGRITY_ERROR", code: "EXECUTOR_THROWN" },
  );

  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "identity-cli-fail-"),
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const requestRoot = path.join(fixtureRoot, "requests");
  const outputRoot = path.join(fixtureRoot, "outputs");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(requestRoot, { mode: 0o700 });
  await mkdir(outputRoot, { mode: 0o700 });
  const failedRequest = validRequest({ requestRoot, outputRoot });
  await writeFile(
    failedRequest.input.inputRecordPath,
    canonicalJsonBytes(failedRequest.parameters),
    { mode: 0o600 },
  );
  const requestPath = path.join(requestRoot, "request.json");
  await writeFile(requestPath, canonicalJsonBytes(failedRequest), {
    mode: 0o600,
  });
  const result = await runLauncherCli(["--request", requestPath], {
    requestRoot,
    outputRoot,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    verifyTrust: async () => ({ status: "PASS" }),
    executeInvocation: async () => ({
      status: "INTEGRITY_ERROR",
      code: "PROCESS_FAILED",
    }),
  });
  assert.notEqual(result.exitCode, 0);
  await assert.rejects(readFile(failedRequest.input.outputRecordPath));
});

test("launcher rejects executor PASS without exactly one bound BootstrapRunReceipt", async (t) => {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "identity-cli-receipt-"),
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const requestRoot = path.join(fixtureRoot, "requests");
  const outputRoot = path.join(fixtureRoot, "outputs");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(requestRoot, { mode: 0o700 });
  await mkdir(outputRoot, { mode: 0o700 });
  const request = validRequest({ requestRoot, outputRoot });
  await writeFile(
    request.input.inputRecordPath,
    canonicalJsonBytes(request.parameters),
    { mode: 0o600 },
  );
  const requestPath = path.join(requestRoot, "request.json");
  await writeFile(requestPath, canonicalJsonBytes(request), { mode: 0o600 });
  const options = {
    requestRoot,
    outputRoot,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    verifyTrust: async () => ({ status: "PASS" }),
    executeInvocation: async () => ({ status: "PASS" }),
  };
  const missing = await runLauncherCli(["--request", requestPath], options);
  assert.notEqual(missing.exitCode, 0);

  const wrongReceipt = bootstrapReceipt({ requestId: "f".repeat(64) }, request);
  await writeFile(
    request.input.outputRecordPath,
    canonicalJsonBytes(wrongReceipt),
    { mode: 0o600, flag: "wx" },
  );
  const reused = await runLauncherCli(["--request", requestPath], options);
  assert.notEqual(reused.exitCode, 0);
});

test("launcher refuses the default path without an authority executor", async (t) => {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "identity-cli-no-executor-"),
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const requestRoot = path.join(fixtureRoot, "requests");
  const outputRoot = path.join(fixtureRoot, "outputs");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(requestRoot, { mode: 0o700 });
  await mkdir(outputRoot, { mode: 0o700 });
  const request = validRequest({ requestRoot, outputRoot });
  await writeFile(
    request.input.inputRecordPath,
    canonicalJsonBytes(request.parameters),
    { mode: 0o600 },
  );
  const requestPath = path.join(requestRoot, "request.json");
  await writeFile(requestPath, canonicalJsonBytes(request), { mode: 0o600 });
  const result = await runLauncherCli(["--request", requestPath], {
    requestRoot,
    outputRoot,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    verifyTrust: async () => ({ status: "PASS" }),
  });
  assert.equal(result.exitCode, 73);
  await assert.rejects(readFile(request.input.outputRecordPath));
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

function bootstrapReceipt(overrides = {}, request = validRequest()) {
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
    authorizationReceiptSha256: request.authorizationReceiptSha256,
    externalControllerReceiptSha256: request.externalControllerReceiptSha256,
    anchorReceiptSha256: request.anchorReceiptSha256,
    externalLaunchReceiptSha256: SHA,
    acceptedSubjectCommit: request.subjectCommit,
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
