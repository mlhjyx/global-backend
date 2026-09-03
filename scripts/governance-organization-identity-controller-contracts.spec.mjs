import assert from "node:assert/strict";
import test from "node:test";

import {
  validateControllerReviewReceipt,
  validateCredentialHandleBinding,
  validateExternalControllerMaterializationReceipt,
  validateExternalExecutableClosure,
} from "./governance-organization-identity-controller-contracts.mjs";

const SHA = "a".repeat(64);

const entry = (role) => ({
  role,
  logicalIdentity: `${role.toLowerCase()}@test`,
  executablePath: `/controlled/${role.toLowerCase()}`,
  realpathSha256: SHA,
  sha256: SHA,
  size: 1,
});

test("external executable closure requires every exact role and rejects unlisted tools", () => {
  const expected = ["NODE", "GIT", "GH"];
  const observed = expected.map(entry);
  assert.equal(
    validateExternalExecutableClosure(observed, expected).status,
    "PASS",
  );
  for (const mutation of [
    observed.slice(0, -1),
    [...observed, entry("DOCKER")],
    observed.map((value, index) =>
      index === 0 ? { ...value, executablePath: "node" } : value,
    ),
  ]) {
    assert.equal(
      validateExternalExecutableClosure(mutation, expected).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("credential handles are references only and reject durable values", () => {
  const binding = {
    provider: "ROOT_SECRET_STORE",
    handleSha256: SHA,
    scopeSha256: SHA,
    injectedByFileDescriptor: true,
    valuePersisted: false,
    valueEmitted: false,
  };
  assert.equal(validateCredentialHandleBinding(binding).status, "PASS");
  for (const mutation of [
    { ...binding, value: "secret" },
    { ...binding, valuePersisted: true },
    { ...binding, valueEmitted: true },
    { ...binding, injectedByFileDescriptor: false },
  ]) {
    assert.equal(
      validateCredentialHandleBinding(mutation).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("controller materialization receipts are exact, root-owned, and class-bound", () => {
  const receipt = {
    schemaVersion:
      "organization-identity-external-controller-materialization/v1",
    controllerClass: "GITHUB",
    contractSha256: SHA,
    controllerSourceSha256: SHA,
    rootDirectorySha256: SHA,
    requestRootSha256: SHA,
    outputRootSha256: SHA,
    ownerUid: 0,
    ownerGid: 0,
    directoryMode: 0o700,
    controllerMode: 0o500,
    recordMode: 0o600,
    executableClosureSetSha256: SHA,
    environmentSchemaSha256: SHA,
    prePostToctouSha256: SHA,
    result: "PASS",
  };
  assert.equal(
    validateExternalControllerMaterializationReceipt(receipt, "GITHUB").status,
    "PASS",
  );
  for (const mutation of [
    { ...receipt, controllerClass: "GITLEAKS" },
    { ...receipt, ownerUid: 1000 },
    { ...receipt, controllerMode: 0o755 },
    { ...receipt, result: "HOLD" },
    { ...receipt, credential: "secret" },
  ]) {
    assert.equal(
      validateExternalControllerMaterializationReceipt(mutation, "GITHUB")
        .status,
      "INTEGRITY_ERROR",
    );
  }
});

test("controller review receipts require non-null materialization and zero-gate PASS", () => {
  const receipt = {
    schemaVersion: "organization-identity-controller-review/v1",
    controllerClass: "GITLEAKS",
    contractSha256: SHA,
    materializationReceiptSha256: SHA,
    requestSchemaSha256: SHA,
    reportSha256: SHA,
    counterexampleSetSha256: SHA,
    reviewerClass: "INDEPENDENT_CONTROLLER_SECURITY_REVIEW",
    critical: 0,
    important: 0,
    verdict: "PASS",
  };
  assert.equal(
    validateControllerReviewReceipt(receipt, "GITLEAKS").status,
    "PASS",
  );
  for (const mutation of [
    { ...receipt, materializationReceiptSha256: null },
    { ...receipt, critical: 1 },
    { ...receipt, important: 1 },
    { ...receipt, verdict: "FAIL" },
    { ...receipt, controllerClass: "GITHUB" },
  ]) {
    assert.equal(
      validateControllerReviewReceipt(mutation, "GITLEAKS").status,
      "INTEGRITY_ERROR",
    );
  }
});
