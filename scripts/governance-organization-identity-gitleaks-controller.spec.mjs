import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGitleaksInvocation,
  validateGitleaksContract,
  validateGitleaksReceipt,
  validateGitleaksRequest,
} from "./governance-organization-identity-gitleaks-controller.mjs";

const SHA = "a".repeat(64);
const COMMIT = "1".repeat(40);
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

function request(overrides = {}) {
  return {
    schemaVersion: "organization-identity-gitleaks-controller-request/v1",
    requestId: SHA,
    contractSha256: SHA,
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
  assert.equal(validateGitleaksRequest(request(), contract()).status, "PASS");
  for (const mutation of [
    { redact: false },
    { noBanner: false },
    { authorizationReceiptSha256: null },
    { configBlobId: "3".repeat(40) },
    { configSha256: "b".repeat(64) },
    { credential: "secret" },
    { argv: ["--no-redact"] },
  ]) {
    assert.equal(
      validateGitleaksRequest(request(mutation), contract()).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("Gitleaks invocation is closed to git-history detect with redaction", () => {
  const result = buildGitleaksInvocation(request(), contract());
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.argv, [
    "git",
    "--redact",
    "--no-banner",
    "--config",
    ".gitleaks.toml",
    "--log-opts",
    COMMIT,
  ]);
});

test("Gitleaks receipts reject cross-controller substitution and unredacted evidence", () => {
  const receipt = {
    schemaVersion: "organization-identity-gitleaks-controller-receipt/v1",
    contractSha256: SHA,
    controllerReviewReceiptSha256: SHA,
    requestId: SHA,
    requestSha256: SHA,
    authorizationReceiptSha256: SHA,
    subjectCommit: COMMIT,
    sourceTreeSha256: SHA,
    configBlobId: "2".repeat(40),
    executableClosureSetSha256: SHA,
    findingSetSha256: SHA,
    redactionVerified: true,
    result: "PASS",
  };
  assert.equal(validateGitleaksReceipt(receipt, request()).status, "PASS");
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
      validateGitleaksReceipt(mutation, request()).status,
      "INTEGRITY_ERROR",
    );
  }
});
