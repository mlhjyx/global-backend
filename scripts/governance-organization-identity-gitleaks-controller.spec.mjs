import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildGitleaksInvocation,
  validateGitleaksContract,
  validateGitleaksReceipt,
  validateGitleaksRequest,
} from "./governance-organization-identity-gitleaks-controller.mjs";

const SHA = "a".repeat(64);
const COMMIT = "1".repeat(40);
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}
const digest = (value) =>
  createHash("sha256")
    .update(`${canonical(value)}\n`)
    .digest("hex");
const executableClosure = ["NODE", "GITLEAKS"].map((role) => ({
  role,
  logicalIdentity: `${role.toLowerCase()}@test`,
  executablePath: `/controlled/${role.toLowerCase()}`,
  realpathSha256: SHA,
  sha256: SHA,
  size: 1,
}));

function contract(overrides = {}) {
  return {
    schemaVersion: "organization-identity-gitleaks-controller-contract/v1",
    rootDirectory:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/gitleaks",
    requestRoot:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/gitleaks/requests",
    outputRoot:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/gitleaks/outputs",
    controllerSourceBlobId: "1".repeat(40),
    controllerSourceSha256: SHA,
    executableClosure,
    requiredRoles: ["NODE", "GITLEAKS"],
    allowedEnvironmentNames: ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"],
    configPath: ".gitleaks.toml",
    configBlobId: "2".repeat(40),
    configSha256: SHA,
    requestSchemaSha256: SHA,
    resultSchemaSha256: SHA,
    credentialIngressAllowed: false,
    ...overrides,
  };
}

function evidence() {
  const controllerContract = contract();
  const materializationReceipt = {
    schemaVersion:
      "organization-identity-external-controller-materialization/v1",
    controllerClass: "GITLEAKS",
    contractSha256: digest(controllerContract),
    controllerSourceSha256: controllerContract.controllerSourceSha256,
    rootDirectorySha256: SHA,
    requestRootSha256: SHA,
    outputRootSha256: SHA,
    ownerUid: 0,
    ownerGid: 0,
    directoryMode: 0o700,
    controllerMode: 0o500,
    recordMode: 0o600,
    executableClosureSetSha256: digest(controllerContract.executableClosure),
    environmentSchemaSha256: SHA,
    prePostToctouSha256: SHA,
    result: "PASS",
  };
  const controllerReviewReceipt = {
    schemaVersion: "organization-identity-controller-review/v1",
    controllerClass: "GITLEAKS",
    contractSha256: materializationReceipt.contractSha256,
    materializationReceiptSha256: digest(materializationReceipt),
    requestSchemaSha256: SHA,
    reportSha256: SHA,
    counterexampleSetSha256: SHA,
    reviewerClass: "INDEPENDENT_CONTROLLER_SECURITY_REVIEW",
    critical: 0,
    important: 0,
    verdict: "PASS",
  };
  const authorizationReceiptCanonicalBytes = `${canonical({
    controllerClass: "GITLEAKS",
    requestId: SHA,
    operation: "SCAN",
    scope: "EXACT_REQUEST_ONLY",
  })}\n`;
  return {
    materializationReceipt,
    controllerReviewReceipt,
    authorizationReceiptCanonicalBytes,
  };
}

function request(overrides = {}) {
  const result = {
    schemaVersion: "organization-identity-gitleaks-controller-request/v1",
    requestId: SHA,
    contractSha256: digest(contract()),
    materializationReceiptSha256: SHA,
    controllerReviewReceiptSha256: SHA,
    authorizationReceiptSha256: SHA,
    subjectCommit: COMMIT,
    sourceTreeSha256: SHA,
    configBlobId: "2".repeat(40),
    configSha256: SHA,
    redact: true,
    noBanner: true,
    outputRecordPath:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/gitleaks/outputs/result.json",
    ...overrides,
  };
  const records = evidence();
  for (const [key, record] of [
    ["materializationReceiptSha256", records.materializationReceipt],
    ["controllerReviewReceiptSha256", records.controllerReviewReceipt],
    ["authorizationReceiptSha256", records.authorizationReceiptCanonicalBytes],
  ]) {
    if (!(key in overrides)) {
      result[key] =
        typeof record === "string"
          ? createHash("sha256").update(record).digest("hex")
          : digest(record);
    }
  }
  return result;
}

test("Gitleaks contract requires only Node/Gitleaks and forbids credential ingress", () => {
  assert.equal(validateGitleaksContract(contract()).status, "PASS");
  for (const mutation of [
    { executableClosure: executableClosure.slice(0, 1) },
    { requiredRoles: ["NODE", "GITLEAKS", "GIT"] },
    { credentialIngressAllowed: true },
    {
      allowedEnvironmentNames: [
        ...contract().allowedEnvironmentNames,
        "GITHUB_TOKEN",
      ],
    },
    { configPath: "/tmp/.gitleaks.toml" },
  ]) {
    assert.equal(
      validateGitleaksContract(contract(mutation)).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("Gitleaks request enforces exact config identity and forced redaction", () => {
  assert.equal(
    validateGitleaksRequest(request(), contract(), evidence()).status,
    "PASS",
  );
  for (const mutation of [
    { contractSha256: SHA },
    { redact: false },
    { noBanner: false },
    { authorizationReceiptSha256: null },
    { configBlobId: "3".repeat(40) },
    { configSha256: "b".repeat(64) },
    { credential: "secret" },
    { argv: ["--no-redact"] },
  ]) {
    assert.equal(
      validateGitleaksRequest(request(mutation), contract(), evidence()).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("Gitleaks invocation is closed to git-history detect with redaction", () => {
  const result = buildGitleaksInvocation(request(), contract(), evidence());
  assert.equal(result.status, "PASS");
  const sourceRoot = `${contract().requestRoot}/${SHA}-source`;
  assert.deepEqual(result.argv, [
    "git",
    "--redact",
    "--no-banner",
    "--config",
    `${sourceRoot}/.gitleaks.toml`,
    "--log-opts",
    COMMIT,
  ]);
  assert.equal(result.cwd, sourceRoot);
  assert.equal(result.preconditions.sourceTreeSha256, SHA);
  assert.equal(result.preconditions.configSha256, SHA);
  assert.equal(result.resultSchemaSha256, contract().resultSchemaSha256);
});

test("Gitleaks receipts reject cross-controller substitution and unredacted evidence", () => {
  const scanRequest = request();
  const controllerContract = contract();
  const resultRecord = {
    schemaVersion: "gitleaks-result-fixture/v1",
    findings: [],
  };
  const receipt = {
    schemaVersion: "organization-identity-gitleaks-controller-receipt/v1",
    contractSha256: scanRequest.contractSha256,
    controllerReviewReceiptSha256: scanRequest.controllerReviewReceiptSha256,
    requestId: SHA,
    requestSha256: digest(scanRequest),
    authorizationReceiptSha256: scanRequest.authorizationReceiptSha256,
    subjectCommit: COMMIT,
    sourceTreeSha256: SHA,
    configBlobId: "2".repeat(40),
    executableClosureSetSha256: digest(controllerContract.executableClosure),
    findingSetSha256: digest(resultRecord),
    redactionVerified: true,
    result: "PASS",
  };
  assert.equal(
    validateGitleaksReceipt(
      receipt,
      scanRequest,
      controllerContract,
      resultRecord,
      evidence(),
    ).status,
    "PASS",
  );
  assert.equal(
    validateGitleaksReceipt(receipt, scanRequest).status,
    "INTEGRITY_ERROR",
  );
  for (const mutation of [
    { ...receipt, redactionVerified: false },
    { ...receipt, subjectCommit: "2".repeat(40) },
    { ...receipt, result: "FAIL" },
    { ...receipt, secret: "value" },
    {
      ...receipt,
      schemaVersion: "organization-identity-github-controller-receipt/v1",
    },
  ]) {
    assert.equal(
      validateGitleaksReceipt(
        mutation,
        scanRequest,
        controllerContract,
        resultRecord,
        evidence(),
      ).status,
      "INTEGRITY_ERROR",
    );
  }
  assert.equal(
    validateGitleaksReceipt(
      receipt,
      scanRequest,
      controllerContract,
      { ...resultRecord, findings: [{ redacted: false }] },
      evidence(),
    ).status,
    "INTEGRITY_ERROR",
  );
});
