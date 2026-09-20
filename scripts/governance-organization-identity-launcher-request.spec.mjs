import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  COMMIT,
  EXPECTED_ENVIRONMENT_NAMES as expectedEnvironmentNames,
  OUTPUT_ROOT,
  REQUEST_ROOT,
  SHA,
  SHA_B,
  SHA_C,
  buildBootstrapReceipt as bootstrapReceipt,
  buildClosure as closure,
  buildValidRequest as validRequest,
  canonicalJson as canonical,
  createLauncherTrustFixture,
  removeFixtureRoot,
  sha256Of as sha,
} from "./governance-organization-identity-test-fixtures.mjs";
import {
  canonicalJsonBytes,
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
  verifyFixedLauncherTrust,
  verifyLauncherContract,
  writeCanonicalOutputRecord,
} from "./governance-organization-identity-launcher.mjs";

const launcherModulePath = fileURLToPath(
  new URL("./governance-organization-identity-launcher.mjs", import.meta.url),
);

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
  const candidateReceipt = bootstrapReceipt(request);
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

test("launcher CLI derives a verified worktree receipt for Git-backed commands", async (t) => {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "identity-cli-git-worktree-"),
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const requestRoot = path.join(fixtureRoot, "requests");
  const outputRoot = path.join(fixtureRoot, "outputs");
  await import("node:fs/promises").then(({ mkdir }) =>
    Promise.all([
      mkdir(requestRoot, { mode: 0o700 }),
      mkdir(outputRoot, { mode: 0o700 }),
    ]),
  );
  const request = validRequest({
    commandId: "GIT_REFRESH_START_V1",
    mode: "START_NO_COMMIT",
    parameters: {
      expectedHead: COMMIT,
      otherParent: "2".repeat(40),
      exactMergeResultPathSetSha256: SHA,
    },
    requestRoot,
    outputRoot,
  });
  await writeFile(
    request.input.inputRecordPath,
    canonicalJsonBytes(request.parameters),
    { mode: 0o600 },
  );
  const requestPath = path.join(requestRoot, "request.json");
  await writeFile(requestPath, canonicalJsonBytes(request), { mode: 0o600 });
  let invocationSeen;
  const result = await runLauncherCli(["--request", requestPath], {
    requestRoot,
    outputRoot,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    verifyTrust: async () => ({
      status: "PASS",
      executableByRole: { GIT: "/controlled/bin/git" },
      verificationFiles: [],
    }),
    deriveWorktreeReceipt: async (gitInvocation) => ({
      repositoryRoot: "/global/backend",
      worktreePath:
        "/global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v2",
      gitDirRealpath: "/global/backend/.git/worktrees/pr407",
      commonDirRealpath: "/global/backend/.git",
      branch: "codex/pr407-organization-identity-caller-cutover-v2",
      headCommit: request.subjectCommit,
      statusPorcelain: "",
      worktreeListEntry:
        "worktree pr407\nHEAD 1111\nbranch refs/heads/codex/pr407\n",
      expectedMode: request.mode,
      verifiedByExecutableClosureSha256: SHA,
      prePostToctouSha256: SHA,
      gitInvocation,
    }),
    executeInvocation: async (invocation) => {
      invocationSeen = invocation;
      const receipt = bootstrapReceipt(request);
      const receiptBytes = canonicalJsonBytes(receipt);
      await writeFile(request.input.outputRecordPath, receiptBytes, {
        mode: 0o600,
        flag: "wx",
      });
      return { status: "PASS", receiptSha256: sha(receiptBytes) };
    },
  });
  assert.equal(result.exitCode, 0, result.result?.code);
  assert.equal(
    invocationSeen.cwd,
    "/global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v2",
  );
  assert.equal(invocationSeen.executableRole, "GIT");
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

  const wrongReceipt = bootstrapReceipt(request, { requestId: "f".repeat(64) });
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

test("fixture trust-chain verification requires explicit fixtureMode and rejects digest drift", async (t) => {
  const { fixtureRoot, launcherRoot, request } =
    await createLauncherTrustFixture();
  t.after(() => removeFixtureRoot(fixtureRoot));
  assert.notEqual(
    (
      await verifyFixedLauncherTrust(request, {
        expectedUid: process.getuid(),
        expectedGid: process.getgid(),
      })
    ).status,
    "PASS",
  );
  assert.equal(
    (
      await verifyFixedLauncherTrust(request, {
        rootDirectory: launcherRoot,
        expectedUid: process.getuid(),
        expectedGid: process.getgid(),
      })
    ).code,
    "LAUNCHER_FIXTURE_MODE_REQUIRED",
  );
  assert.equal(
    (
      await verifyFixedLauncherTrust(request, {
        rootDirectory: launcherRoot,
        fixtureMode: launcherRoot,
        expectedUid: process.getuid(),
        expectedGid: process.getgid(),
      })
    ).status,
    "PASS",
  );
  await writeFile(
    path.join(launcherRoot, "launcher-materialization-readback.json"),
    Buffer.from('{"z":1,"a":2}\n', "utf8"),
    { mode: 0o600 },
  );
  assert.equal(
    (
      await verifyFixedLauncherTrust(request, {
        rootDirectory: launcherRoot,
        fixtureMode: launcherRoot,
        expectedUid: process.getuid(),
        expectedGid: process.getgid(),
      })
    ).code,
    "CONTROLLED_FILE_DIGEST_INVALID",
  );
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
