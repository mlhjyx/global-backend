import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDisposablePostgresInvocation,
  validateDisposablePostgresContract,
  validateDisposablePostgresReceipt,
  validateDisposablePostgresRequest,
} from "./governance-organization-identity-disposable-postgres-controller.mjs";

const SHA = "a".repeat(64);
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

function request(overrides = {}) {
  return {
    schemaVersion:
      "organization-identity-disposable-postgres-controller-request/v1",
    requestId: SHA,
    operation: "0M_COMPATIBILITY",
    contractSha256: SHA,
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
    validateDisposablePostgresRequest(request(), contract()).status,
    "PASS",
  );
  for (const mutation of [
    { authorizationReceiptSha256: null },
    { imageDigest: "postgres:16" },
    { topologySha256: null },
    { timeAndSpaceCapSha256: null },
    { cleanupPlanSha256: null },
    { operation: "RETAINED_DATABASE" },
    { command: "docker run" },
  ]) {
    assert.equal(
      validateDisposablePostgresRequest(request(mutation), contract()).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("disposable invocation remains a closed controller operation", () => {
  const result = buildDisposablePostgresInvocation(request(), contract());
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.operationPlan, [
    "CREATE_NO_EGRESS_LOOPBACK_RESOURCE",
    "RUN_0M_COMPATIBILITY",
    "PROVE_CLEANUP",
  ]);
  assert.equal(JSON.stringify(result).includes("password"), false);
});

test("disposable receipts require zero retained resources and matching controller identity", () => {
  const receipt = {
    schemaVersion:
      "organization-identity-disposable-postgres-controller-receipt/v1",
    contractSha256: SHA,
    controllerReviewReceiptSha256: SHA,
    operation: "0M_COMPATIBILITY",
    requestId: SHA,
    requestSha256: SHA,
    authorizationReceiptSha256: SHA,
    imageDigest: `sha256:${SHA}`,
    topologySha256: SHA,
    resourceSetSha256: SHA,
    migrationInputSetSha256: SHA,
    syntheticCredentialHandleSha256: SHA,
    scenarioResultSetSha256: SHA,
    cleanupProofSha256: SHA,
    executableClosureSetSha256: SHA,
    prePostToctouSha256: SHA,
    containsCredentialValue: false,
    retainedResources: 0,
    result: "PASS",
  };
  assert.equal(
    validateDisposablePostgresReceipt(receipt, request()).status,
    "PASS",
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
      validateDisposablePostgresReceipt(mutation, request()).status,
      "INTEGRITY_ERROR",
    );
  }
});
