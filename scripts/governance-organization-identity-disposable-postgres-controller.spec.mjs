import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildDisposablePostgresInvocation,
  validateDisposablePostgresContract,
  validateDisposablePostgresReceipt,
  validateDisposablePostgresRequest,
} from "./governance-organization-identity-disposable-postgres-controller.mjs";

const SHA = "a".repeat(64);
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
const roles = [
  "NODE",
  "DOCKER",
  "PSQL",
  "COREPACK_SHIM",
  "COREPACK_LIB_COREPACK_CJS",
  "PNPM_SHIM",
  "PNPM_ENTRYPOINT",
  "PRISMA_CLI",
];
const executableClosure = roles.map((role) => ({
  role,
  logicalIdentity: `${role.toLowerCase()}@test`,
  executablePath: `/controlled/${role.toLowerCase()}`,
  realpathSha256: SHA,
  sha256: SHA,
  size: 1,
}));

function contract(overrides = {}) {
  return {
    schemaVersion:
      "organization-identity-disposable-postgres-controller-contract/v1",
    rootDirectory:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/disposable-postgres",
    requestRoot:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/disposable-postgres/requests",
    outputRoot:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/disposable-postgres/outputs",
    controllerSourceBlobId: "1".repeat(40),
    controllerSourceSha256: SHA,
    executableClosure,
    requiredRoles: roles,
    allowedEnvironmentNames: [
      "PATH",
      "HOME",
      "XDG_CONFIG_HOME",
      "TMPDIR",
      "DOCKER_HOST_HANDLE",
      "POSTGRES_CREDENTIAL_HANDLE",
      "CI",
      "LANG",
      "LC_ALL",
    ],
    allowedOperations: ["0M_COMPATIBILITY", "B6_MIXED_FLEET"],
    topologySchemaSha256: SHA,
    resourceLabelSchemaSha256: SHA,
    imageDigestSchemaSha256: SHA,
    timeAndSpaceCapSchemaSha256: SHA,
    syntheticCredentialHandleSchemaSha256: SHA,
    migrationInputSchemaSha256: SHA,
    cleanupProofSchemaSha256: SHA,
    loopbackOnly: true,
    noEgress: true,
    retainedResourceAllowed: false,
    ...overrides,
  };
}

function evidence(operation = "0M_COMPATIBILITY") {
  const controllerContract = contract();
  const materializationReceipt = {
    schemaVersion:
      "organization-identity-external-controller-materialization/v1",
    controllerClass: "DISPOSABLE_POSTGRES",
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
    controllerClass: "DISPOSABLE_POSTGRES",
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
    controllerClass: "DISPOSABLE_POSTGRES",
    requestId: SHA,
    operation,
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
    schemaVersion:
      "organization-identity-disposable-postgres-controller-request/v1",
    requestId: SHA,
    operation: "0M_COMPATIBILITY",
    contractSha256: digest(contract()),
    materializationReceiptSha256: SHA,
    controllerReviewReceiptSha256: SHA,
    authorizationReceiptSha256: SHA,
    syntheticCredentialHandle: {
      provider: "ROOT_SECRET_STORE",
      handleSha256: SHA,
      scopeSha256: SHA,
      injectedByFileDescriptor: true,
      valuePersisted: false,
      valueEmitted: false,
    },
    imageDigest: `sha256:${SHA}`,
    topologySha256: SHA,
    resourceLabelSetSha256: SHA,
    timeAndSpaceCapSha256: SHA,
    migrationInputSetSha256: SHA,
    scenarioSetSha256: SHA,
    cleanupPlanSha256: SHA,
    outputRecordPath:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/disposable-postgres/outputs/result.json",
    ...overrides,
  };
  const records = evidence(result.operation);
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

test("disposable contract requires the full Docker/psql/Prisma/Corepack closure", () => {
  assert.equal(validateDisposablePostgresContract(contract()).status, "PASS");
  for (const mutation of [
    { requiredRoles: roles.filter((role) => role !== "PSQL") },
    {
      executableClosure: executableClosure.filter(
        ({ role }) => role !== "PRISMA_CLI",
      ),
    },
    { loopbackOnly: false },
    { noEgress: false },
    { retainedResourceAllowed: true },
  ]) {
    assert.equal(
      validateDisposablePostgresContract(contract(mutation)).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("disposable requests require authorization, content-addressed image, caps, labels, and cleanup", () => {
  assert.equal(
    validateDisposablePostgresRequest(request(), contract(), evidence()).status,
    "PASS",
  );
  for (const mutation of [
    { contractSha256: SHA },
    { authorizationReceiptSha256: null },
    { imageDigest: "postgres:16" },
    { topologySha256: null },
    { timeAndSpaceCapSha256: null },
    { cleanupPlanSha256: null },
    { operation: "RETAINED_DATABASE" },
    { command: "docker run" },
  ]) {
    assert.equal(
      validateDisposablePostgresRequest(
        request(mutation),
        contract(),
        evidence(),
      ).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("disposable invocation remains a closed controller operation", () => {
  const result = buildDisposablePostgresInvocation(
    request(),
    contract(),
    evidence(),
  );
  assert.equal(result.status, "PASS");
  assert.deepEqual(
    result.operationPlan.map(({ phase }) => phase),
    [
      "CREATE_NETWORK",
      "CREATE_DATABASE",
      "VERIFY_TOPOLOGY",
      "RUN_0M_COMPATIBILITY",
      "CLEANUP",
      "VERIFY_CLEANUP",
    ],
  );
  assert.equal(
    result.operationPlan.some(({ argv }) => argv?.includes("--internal")),
    true,
  );
  assert.equal(
    result.operationPlan.some(({ argv }) =>
      argv?.some((value) => value.startsWith("127.0.0.1:")),
    ),
    true,
  );
  assert.equal(result.preconditions.noEgress, true);
  assert.equal(result.preconditions.loopbackOnly, true);
  assert.equal(
    result.preconditions.cleanupPlanSha256,
    request().cleanupPlanSha256,
  );
  const serialized = JSON.stringify(result.operationPlan);
  for (const flag of [
    "--cpus",
    "--memory",
    "--pids-limit",
    "--read-only",
    "--tmpfs",
  ]) {
    assert.equal(serialized.includes(flag), true);
  }
  for (const role of roles) {
    assert.equal(serialized.includes(`\"executableRole\":\"${role}\"`), true);
  }
  assert.deepEqual(
    result.finallyPlan.map(({ phase }) => phase),
    ["CLEANUP", "VERIFY_CLEANUP"],
  );
  assert.equal(JSON.stringify(result).includes("password"), false);
});

test("disposable receipts require zero retained resources and matching controller identity", () => {
  const operationRequest = request();
  const controllerContract = contract();
  const resultRecord = {
    schemaVersion: "disposable-result-fixture/v1",
    scenarios: [],
    cleanup: "PASS",
  };
  const receipt = {
    schemaVersion:
      "organization-identity-disposable-postgres-controller-receipt/v1",
    contractSha256: operationRequest.contractSha256,
    controllerReviewReceiptSha256:
      operationRequest.controllerReviewReceiptSha256,
    operation: "0M_COMPATIBILITY",
    requestId: SHA,
    requestSha256: digest(operationRequest),
    authorizationReceiptSha256: operationRequest.authorizationReceiptSha256,
    imageDigest: `sha256:${SHA}`,
    topologySha256: SHA,
    resourceSetSha256: SHA,
    migrationInputSetSha256: SHA,
    syntheticCredentialHandleSha256: SHA,
    scenarioResultSetSha256: digest(resultRecord),
    cleanupProofSha256: SHA,
    executableClosureSetSha256: digest(controllerContract.executableClosure),
    prePostToctouSha256: SHA,
    containsCredentialValue: false,
    retainedResources: 0,
    result: "PASS",
  };
  assert.equal(
    validateDisposablePostgresReceipt(
      receipt,
      operationRequest,
      controllerContract,
      resultRecord,
      evidence(),
    ).status,
    "PASS",
  );
  assert.equal(
    validateDisposablePostgresReceipt(receipt, operationRequest).status,
    "INTEGRITY_ERROR",
  );
  for (const mutation of [
    { ...receipt, retainedResources: 1 },
    { ...receipt, cleanupProofSha256: null },
    { ...receipt, containsCredentialValue: true },
    { ...receipt, operation: "B6_MIXED_FLEET" },
    {
      ...receipt,
      schemaVersion: "organization-identity-github-controller-receipt/v1",
    },
  ]) {
    assert.equal(
      validateDisposablePostgresReceipt(
        mutation,
        operationRequest,
        controllerContract,
        resultRecord,
        evidence(),
      ).status,
      "INTEGRITY_ERROR",
    );
  }
  assert.equal(
    validateDisposablePostgresReceipt(
      receipt,
      operationRequest,
      controllerContract,
      { ...resultRecord, cleanup: "FAIL" },
      evidence(),
    ).status,
    "INTEGRITY_ERROR",
  );
});
