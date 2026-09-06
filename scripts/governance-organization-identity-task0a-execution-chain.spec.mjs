import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildClosedCommandRequest,
  buildExecutionChainRequestV3,
  buildExternalLaunchReceiptV2,
  canonicalJsonBytes,
  finalizeExecutionChainRequestV3,
  runLauncherCli,
} from "./governance-organization-identity-launcher.mjs";
import {
  BOOTSTRAP_CONTRACT,
  runBootstrapRequest,
  validateBootstrapRunReceipt,
} from "./governance-organization-identity-bootstrap.mjs";
import { EXECUTION_CHAIN_CONTRACT_V3_SHA256 } from "./governance-organization-identity-execution-chain-contracts.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonSha = (value) => sha(canonicalJsonBytes(value));
const COMMIT = "9".repeat(40);

test("Task0A review command uses canonical request entry and writes a bound receipt", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-task0a-chain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requestRoot = path.join(root, "requests");
  const outputRoot = path.join(root, "outputs");
  const evidenceRoot = path.join(root, "evidence");
  await Promise.all([
    mkdir(requestRoot, { mode: 0o700 }),
    mkdir(outputRoot, { mode: 0o700 }),
    mkdir(evidenceRoot, { mode: 0o700 }),
  ]);
  const reportPath = path.join(evidenceRoot, "review.md");
  const receiptPath = path.join(evidenceRoot, "review.json");
  const reportBytes = Buffer.from("Critical: 0\nImportant: 0\nVerdict: PASS\n", "utf8");
  const reportSha256 = sha(reportBytes);
  await writeFile(reportPath, reportBytes, { mode: 0o600 });
  const reviewReceipt = {
    schemaVersion: "organization-identity-bootstrap-scoped-review/v1",
    reviewerClass: "INDEPENDENT_BOOTSTRAP_REVIEW",
    subjectCommit: COMMIT,
    subjectParentCommit: "8".repeat(40),
    range: `${"8".repeat(40)}..${COMMIT}`,
    pathSetSha256: "a".repeat(64),
    reportSha256,
    counterexampleSetSha256: "b".repeat(64),
    finalSpecSha256: "536e376a40d9ef4f49a65bc0224b74d58eb8a2d743fa766aa020397e67279dd4",
    critical: 0,
    important: 0,
    verdict: "PASS",
    containsCredentialValue: false,
  };
  await writeFile(receiptPath, canonicalJsonBytes(reviewReceipt), { mode: 0o600 });
  const request = buildClosedCommandRequest({
    taskId: "0A",
    commandId: "SCOPED_REVIEW_VERIFY_V1",
    mode: "VERIFY",
    subjectCommit: COMMIT,
    bootstrapContractSha256: jsonSha(BOOTSTRAP_CONTRACT),
    launcherMaterializationReceiptSha256: "c".repeat(64),
    launcherMaterializationReviewReceiptSha256: "d".repeat(64),
    authorizationReceiptSha256: null,
    externalControllerReceiptSha256: null,
    anchorReceiptSha256: null,
    parameters: {
      evidenceRoot,
      reportPath,
      reportSha256,
      receiptPath,
      receiptSha256: sha(canonicalJsonBytes(reviewReceipt)),
      reviewedSubjectCommit: COMMIT,
    },
    requestRoot,
    outputRoot,
  });
  const requestPath = path.join(requestRoot, "request.json");
  await writeFile(request.input.inputRecordPath, canonicalJsonBytes(request.parameters), { mode: 0o600 });
  await writeFile(requestPath, canonicalJsonBytes(request), { mode: 0o600 });

  const bootstrapPath = fileURLToPath(
    new URL("./governance-organization-identity-bootstrap.mjs", import.meta.url),
  );
  const result = await runBootstrapRequest(requestPath, { fixtureEvidenceRoot: evidenceRoot, predecessorDiagnostic: true });
  assert.equal(result.status, "PASS");
  const cli = spawnSync(process.execPath, [bootstrapPath, "--request", requestPath], {
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    encoding: "utf8",
  });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /FIXED_ROOT_REQUIRED/);
  const receipt = JSON.parse(await readFile(request.input.outputRecordPath, "utf8"));
  assert.equal(validateBootstrapRunReceipt(receipt, request).status, "PASS");
  assert.equal(receipt.commandId, "SCOPED_REVIEW_VERIFY_V1");
  assert.equal(receipt.requestId, request.requestId);
  assert.equal(receipt.result, "PASS");
  assert.equal(result.receiptSha256, sha(canonicalJsonBytes(receipt)));
  const replay = await runBootstrapRequest(requestPath, { fixtureEvidenceRoot: evidenceRoot, predecessorDiagnostic: true });
  assert.deepEqual(replay, { status: "INTEGRITY_ERROR", code: "OUTPUT_ALREADY_EXISTS" });
});

test("Task0A request rejects a review file outside its declared evidence root", async () => {
  const request = buildClosedCommandRequest({
    taskId: "0A",
    commandId: "SCOPED_REVIEW_VERIFY_V1",
    mode: "VERIFY",
    subjectCommit: COMMIT,
    bootstrapContractSha256: jsonSha(BOOTSTRAP_CONTRACT),
    launcherMaterializationReceiptSha256: "c".repeat(64),
    launcherMaterializationReviewReceiptSha256: "d".repeat(64),
    authorizationReceiptSha256: null,
    externalControllerReceiptSha256: null,
    anchorReceiptSha256: null,
    parameters: {
      evidenceRoot: "/controlled/evidence",
      reportPath: "/outside/review.md",
      reportSha256: "a".repeat(64),
      receiptPath: "/controlled/evidence/review.json",
      receiptSha256: "b".repeat(64),
      reviewedSubjectCommit: COMMIT,
    },
    requestRoot: "/controlled/requests",
    outputRoot: "/controlled/outputs",
  });
  const parsed = (await import("./governance-organization-identity-launcher.mjs"))
    .parseClosedCommandRequest(canonicalJsonBytes(request), {
      requestRoot: "/controlled/requests",
      outputRoot: "/controlled/outputs",
    });
  assert.deepEqual(parsed, {
    status: "INTEGRITY_ERROR",
    code: "REVIEW_EVIDENCE_ROOT_INVALID",
  });
});

test("v3 request binds an external launch sidecar and separates outcome from receipt", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-task0a-v3-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requestRoot = path.join(root, "requests");
  const outputRoot = path.join(root, "outputs");
  const evidenceRoot = path.join(root, "evidence");
  await Promise.all([
    mkdir(requestRoot, { mode: 0o700 }),
    mkdir(outputRoot, { mode: 0o700 }),
    mkdir(evidenceRoot, { mode: 0o700 }),
  ]);
  const reportPath = path.join(evidenceRoot, "review.md");
  const receiptPath = path.join(evidenceRoot, "review.json");
  const reportBytes = Buffer.from("Critical: 0\nImportant: 0\nVerdict: PASS\n", "utf8");
  const reportSha256 = sha(reportBytes);
  await writeFile(reportPath, reportBytes, { mode: 0o600 });
  const reviewReceipt = {
    schemaVersion: "organization-identity-bootstrap-scoped-review/v1",
    reviewerClass: "INDEPENDENT_BOOTSTRAP_REVIEW",
    subjectCommit: COMMIT,
    subjectParentCommit: "8".repeat(40),
    range: `${"8".repeat(40)}..${COMMIT}`,
    pathSetSha256: "a".repeat(64),
    reportSha256,
    counterexampleSetSha256: "b".repeat(64),
    finalSpecSha256: "536e376a40d9ef4f49a65bc0224b74d58eb8a2d743fa766aa020397e67279dd4",
    critical: 0,
    important: 0,
    verdict: "PASS",
    containsCredentialValue: false,
  };
  await writeFile(receiptPath, canonicalJsonBytes(reviewReceipt), { mode: 0o600 });
  let request = buildExecutionChainRequestV3({
    taskId: "0A",
    commandId: "SCOPED_REVIEW_VERIFY_V1",
    mode: "VERIFY",
    subjectCommit: COMMIT,
    bootstrapContractSha256: EXECUTION_CHAIN_CONTRACT_V3_SHA256,
    executableClosureSha256: sha(canonicalJsonBytes([])),
    launcherContractSha256: sha(canonicalJsonBytes({ fixture: "launcher-contract" })),
    launcherMaterializationReceiptSha256: "c".repeat(64),
    launcherMaterializationReviewReceiptSha256: "d".repeat(64),
    authorizationReceiptSha256: null,
    externalControllerReceiptSha256: null,
    anchorReceiptSha256: null,
    parameters: {
      evidenceRoot,
      reportPath,
      reportSha256,
      receiptPath,
      receiptSha256: sha(canonicalJsonBytes(reviewReceipt)),
      reviewedSubjectCommit: COMMIT,
    },
    requestRoot,
    outputRoot,
  });
  const external = buildExternalLaunchReceiptV2(request);
  await writeFile(request.input.externalLaunchReceiptPath, canonicalJsonBytes(external), { mode: 0o600 });
  await writeFile(request.input.inputRecordPath, canonicalJsonBytes(request.parameters), { mode: 0o600 });
  const requestPath = path.join(requestRoot, "request.json");
  await writeFile(requestPath, canonicalJsonBytes(request), { mode: 0o600 });
  const result = await runBootstrapRequest(requestPath, { fixtureEvidenceRoot: evidenceRoot });
  assert.equal(result.status, "PASS");
  const outcome = JSON.parse(await readFile(request.input.outputRecordPath, "utf8"));
  const finalReceipt = JSON.parse(await readFile(request.input.receiptPath, "utf8"));
  assert.equal(finalReceipt.externalLaunchReceiptSha256, request.externalLaunchReceiptSha256);
  assert.equal(finalReceipt.outputRecordSha256, sha(canonicalJsonBytes(outcome)));
  assert.notEqual(request.input.outputRecordPath, request.input.receiptPath);
});

test("v3 launcher fixture path reads the receipt path, not the outcome path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-task0a-launcher-v3-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requestRoot = path.join(root, "requests");
  const outputRoot = path.join(root, "outputs");
  const evidenceRoot = path.join(root, "evidence");
  await Promise.all([
    mkdir(requestRoot, { mode: 0o700 }),
    mkdir(outputRoot, { mode: 0o700 }),
    mkdir(evidenceRoot, { mode: 0o700 }),
  ]);
  const reportPath = path.join(evidenceRoot, "review.md");
  const reviewPath = path.join(evidenceRoot, "review.json");
  const reportBytes = Buffer.from("Critical: 0\nImportant: 0\nVerdict: PASS\n", "utf8");
  const reportSha256 = sha(reportBytes);
  await writeFile(reportPath, reportBytes, { mode: 0o600 });
  const review = {
    schemaVersion: "organization-identity-bootstrap-scoped-review/v1",
    reviewerClass: "INDEPENDENT_BOOTSTRAP_REVIEW",
    subjectCommit: COMMIT,
    subjectParentCommit: "8".repeat(40),
    range: `${"8".repeat(40)}..${COMMIT}`,
    pathSetSha256: "a".repeat(64),
    reportSha256,
    counterexampleSetSha256: "b".repeat(64),
    finalSpecSha256: "536e376a40d9ef4f49a65bc0224b74d58eb8a2d743fa766aa020397e67279dd4",
    critical: 0,
    important: 0,
    verdict: "PASS",
    containsCredentialValue: false,
  };
  await writeFile(reviewPath, canonicalJsonBytes(review), { mode: 0o600 });
  let request = buildExecutionChainRequestV3({
    taskId: "0A",
    commandId: "SCOPED_REVIEW_VERIFY_V1",
    mode: "VERIFY",
    subjectCommit: COMMIT,
    bootstrapContractSha256: EXECUTION_CHAIN_CONTRACT_V3_SHA256,
    executableClosureSha256: sha(canonicalJsonBytes([])),
    launcherContractSha256: sha(canonicalJsonBytes({ fixture: "launcher-contract" })),
    launcherMaterializationReceiptSha256: "c".repeat(64),
    launcherMaterializationReviewReceiptSha256: "d".repeat(64),
    authorizationReceiptSha256: null,
    externalControllerReceiptSha256: null,
    anchorReceiptSha256: null,
    parameters: {
      evidenceRoot,
      reportPath,
      reportSha256,
      receiptPath: reviewPath,
      receiptSha256: sha(canonicalJsonBytes(review)),
      reviewedSubjectCommit: COMMIT,
    },
    requestRoot,
    outputRoot,
  });
  const requestPath = path.join(requestRoot, "request.json");
  request = finalizeExecutionChainRequestV3(request, requestPath);
  await writeFile(request.input.inputRecordPath, canonicalJsonBytes(request.parameters), { mode: 0o600 });
  await writeFile(requestPath, canonicalJsonBytes(request), { mode: 0o600 });
  const bootstrapPath = fileURLToPath(new URL("./governance-organization-identity-bootstrap.mjs", import.meta.url));
  const wrapperPath = path.join(root, "fixture-bootstrap.mjs");
  const debugPath = path.join(root, "fixture-result.json");
  await writeFile(
    wrapperPath,
    `import { writeFileSync } from "node:fs";\nimport { runBootstrapRequest } from ${JSON.stringify(bootstrapPath)};\nconst result = await runBootstrapRequest(process.argv[3], { fixtureEvidenceRoot: ${JSON.stringify(evidenceRoot)} });\nwriteFileSync(${JSON.stringify(debugPath)}, JSON.stringify(result));\nprocess.stdout.write(JSON.stringify(result));\nprocess.exitCode = result.status === "PASS" ? 0 : 1;\n`,
    { mode: 0o500 },
  );
  const executionEnvironment = {
    PATH: "/usr/bin:/bin",
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    COREPACK_HOME: path.join(root, "corepack"),
    PNPM_HOME: path.join(root, "pnpm"),
    TMPDIR: path.join(root, "tmp"),
    NPM_CONFIG_USERCONFIG: "/dev/null",
    CI: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
  const result = await runLauncherCli(["--request", requestPath], {
    requestRoot,
    outputRoot,
    fixtureEvidenceRoot: evidenceRoot,
    fixtureBootstrapPath: wrapperPath,
    executionEnvironment,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    verifyTrust: async () => ({
      status: "PASS",
      executableByRole: { NODE: process.execPath },
      executableClosureSha256: sha(canonicalJsonBytes([])),
      contract: { launcherContractSha256: request.launcherContractSha256 },
      verificationFiles: [],
    }),
  });
  assert.equal(result.exitCode, 0, `${JSON.stringify(result)} debug=${await readFile(debugPath, "utf8")}`);
  const outcome = JSON.parse(await readFile(request.input.outputRecordPath, "utf8"));
  const receipt = JSON.parse(await readFile(request.input.receiptPath, "utf8"));
  assert.equal(receipt.outputRecordSha256, sha(canonicalJsonBytes(outcome)));
  assert.equal(result.result.receipt.requestId, request.requestId);

  let mismatchRequest = buildExecutionChainRequestV3({
    taskId: "1",
    commandId: "SCOPED_REVIEW_VERIFY_V1",
    mode: "VERIFY",
    subjectCommit: COMMIT,
    bootstrapContractSha256: EXECUTION_CHAIN_CONTRACT_V3_SHA256,
    executableClosureSha256: sha(canonicalJsonBytes({ wrong: true })),
    launcherContractSha256: sha(canonicalJsonBytes({ fixture: "launcher-contract" })),
    launcherMaterializationReceiptSha256: "c".repeat(64),
    launcherMaterializationReviewReceiptSha256: "d".repeat(64),
    authorizationReceiptSha256: null,
    externalControllerReceiptSha256: null,
    anchorReceiptSha256: null,
    parameters: request.parameters,
    requestRoot,
    outputRoot,
  });
  const mismatchPath = path.join(requestRoot, "mismatch-request.json");
  mismatchRequest = finalizeExecutionChainRequestV3(mismatchRequest, mismatchPath);
  await writeFile(mismatchRequest.input.inputRecordPath, canonicalJsonBytes(mismatchRequest.parameters), { mode: 0o600 });
  await writeFile(mismatchPath, canonicalJsonBytes(mismatchRequest), { mode: 0o600 });
  const mismatch = await runLauncherCli(["--request", mismatchPath], {
    requestRoot,
    outputRoot,
    fixtureEvidenceRoot: evidenceRoot,
    fixtureBootstrapPath: wrapperPath,
    executionEnvironment,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    verifyTrust: async () => ({
      status: "PASS",
      executableByRole: { NODE: process.execPath },
      executableClosureSha256: sha(canonicalJsonBytes([])),
      contract: { launcherContractSha256: mismatchRequest.launcherContractSha256 },
      verificationFiles: [],
    }),
  });
  assert.equal(mismatch.exitCode, 70);
  assert.equal(mismatch.result.code, "EXECUTABLE_CLOSURE_OBSERVATION_MISMATCH");
});
