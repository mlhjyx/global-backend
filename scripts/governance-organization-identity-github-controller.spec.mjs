import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildGitHubControllerInvocation,
  validateGitHubControllerContract,
  validateGitHubControllerReceipt,
  validateGitHubControllerRequest,
} from "./governance-organization-identity-github-controller.mjs";

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

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

const closure = ["NODE", "GIT", "GH"].map((role) => ({
  role,
  logicalIdentity: `${role.toLowerCase()}@test`,
  executablePath: `/controlled/${role.toLowerCase()}`,
  realpathSha256: SHA,
  sha256: SHA,
  size: 1,
}));

function contract(overrides = {}) {
  const operations = [
    "PROTECTED_MAIN_READBACK",
    "FETCH_EXACT_OBJECT",
    "PUSH_EXACT_BRANCH",
    "PR_CREATE",
    "PR_UPDATE_BODY",
    "PR_READBACK",
    "RULES_CHECKS_READBACK",
    "PR_MERGE",
    "COMMIT_BRANCH_PARENT_READBACK",
    "WORKFLOW_RUN_READBACK",
    "WORKFLOW_RERUN",
    "CONTROLLER_VARIABLES_WRITE",
  ];
  return {
    schemaVersion: "organization-identity-github-controller-contract/v1",
    rootDirectory:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/github",
    requestRoot:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/github/requests",
    outputRoot:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/github/outputs",
    controllerSourceBlobId: "1".repeat(40),
    controllerSourceSha256: SHA,
    repository: "mlhjyx/global-backend",
    remote: "origin",
    protectedRef: "refs/heads/main",
    executableClosure: closure,
    requiredRoles: ["NODE", "GIT", "GH"],
    allowedEnvironmentNames: [
      "PATH",
      "HOME",
      "XDG_CONFIG_HOME",
      "TMPDIR",
      "GH_HOST",
      "GITHUB_TOKEN_HANDLE",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_TERMINAL_PROMPT",
    ],
    credentialHandleSchemaSha256: SHA,
    operationRequestSchemaSha256: Object.fromEntries(
      operations.map((operation) => [operation, SHA]),
    ),
    operationResultSchemaSha256: Object.fromEntries(
      operations.map((operation) => [operation, SHA]),
    ),
    noSecretPersistence: true,
    ...overrides,
  };
}

function request(overrides = {}) {
  const result = {
    schemaVersion: "organization-identity-github-controller-request/v1",
    requestId: SHA,
    operation: "PROTECTED_MAIN_READBACK",
    contractSha256: SHA,
    materializationReceiptSha256: SHA,
    controllerReviewReceiptSha256: SHA,
    authorizationReceiptSha256: SHA,
    credentialHandle: {
      provider: "ROOT_SECRET_STORE",
      handleSha256: SHA,
      scopeSha256: SHA,
      injectedByFileDescriptor: true,
      valuePersisted: false,
      valueEmitted: false,
    },
    payloadSchemaSha256: SHA,
    payloadSha256: "",
    outputRecordPath:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/github/outputs/readback.json",
    payload: { repository: "mlhjyx/global-backend", ref: "refs/heads/main" },
    ...overrides,
  };
  if (!("payloadSha256" in overrides)) {
    result.payloadSha256 = sha(`${canonical(result.payload)}\n`);
  }
  return result;
}

test("GitHub contract requires the exact GH/Git/Node closure and environment", () => {
  assert.equal(validateGitHubControllerContract(contract()).status, "PASS");
  for (const mutation of [
    { executableClosure: closure.filter(({ role }) => role !== "GH") },
    { requiredRoles: ["NODE", "GIT"] },
    {
      allowedEnvironmentNames: [
        ...contract().allowedEnvironmentNames,
        "NODE_OPTIONS",
      ],
    },
    { repository: "other/repo" },
    { noSecretPersistence: false },
  ]) {
    assert.equal(
      validateGitHubControllerContract(contract(mutation)).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("GitHub requests enforce exact operation payloads and authorization", () => {
  assert.equal(
    validateGitHubControllerRequest(request(), contract()).status,
    "PASS",
  );
  const merge = request({
    operation: "PR_MERGE",
    authorizationReceiptSha256: SHA,
    payload: {
      number: 407,
      expectedBaseSha: COMMIT,
      expectedHeadSha: "2".repeat(40),
      mergeMethod: "merge",
      immediateReadbackReceiptSetSha256: SHA,
    },
  });
  assert.equal(
    validateGitHubControllerRequest(merge, contract()).status,
    "PASS",
  );
  assert.equal(
    validateGitHubControllerRequest(
      request({ authorizationReceiptSha256: null }),
      contract(),
    ).status,
    "INTEGRITY_ERROR",
  );
  for (const mutation of [
    { ...merge, authorizationReceiptSha256: null },
    { ...merge, payloadSha256: "b".repeat(64) },
    { ...merge, payload: { ...merge.payload, mergeMethod: "squash" } },
    { ...merge, payload: { ...merge.payload, command: "gh pr merge" } },
    { ...merge, operation: "ARBITRARY" },
    {
      ...merge,
      credentialHandle: { ...merge.credentialHandle, value: "secret" },
    },
  ]) {
    assert.equal(
      validateGitHubControllerRequest(mutation, contract()).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("GitHub invocation is closed and carries only a credential handle", () => {
  const result = buildGitHubControllerInvocation(request(), contract());
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.argv, [
    "api",
    "repos/mlhjyx/global-backend/git/ref/heads/main",
    "--method",
    "GET",
  ]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("every GitHub operation has one exact closed payload and invocation branch", () => {
  const cases = [
    [
      "PROTECTED_MAIN_READBACK",
      { repository: "mlhjyx/global-backend", ref: "refs/heads/main" },
    ],
    [
      "FETCH_EXACT_OBJECT",
      {
        remote: "origin",
        ref: "refs/heads/main",
        objectSha: COMMIT,
        flags: [
          "--no-tags",
          "--no-write-fetch-head",
          "--no-auto-maintenance",
          "--no-write-commit-graph",
        ],
      },
    ],
    [
      "PUSH_EXACT_BRANCH",
      {
        branch: "codex/pr407-organization-identity-caller-cutover-v2",
        expectedHead: COMMIT,
        setUpstream: true,
        force: false,
      },
    ],
    [
      "PR_CREATE",
      {
        base: "main",
        head: "codex/pr407-organization-identity-caller-cutover-v2",
        title: "Organization Identity writer ban-at-source",
        bodySha256: SHA,
      },
    ],
    [
      "PR_UPDATE_BODY",
      {
        number: 407,
        expectedBaseSha: COMMIT,
        expectedHeadSha: "2".repeat(40),
        title: "Organization Identity writer ban-at-source",
        bodySha256: SHA,
      },
    ],
    [
      "PR_READBACK",
      {
        number: 407,
        headBranch: "codex/pr407-organization-identity-caller-cutover-v2",
      },
    ],
    [
      "RULES_CHECKS_READBACK",
      {
        number: 407,
        expectedBaseSha: COMMIT,
        expectedHeadSha: "2".repeat(40),
      },
    ],
    [
      "PR_MERGE",
      {
        number: 407,
        expectedBaseSha: COMMIT,
        expectedHeadSha: "2".repeat(40),
        mergeMethod: "merge",
        immediateReadbackReceiptSetSha256: SHA,
      },
    ],
    [
      "COMMIT_BRANCH_PARENT_READBACK",
      {
        mergeResponseSha: "3".repeat(40),
        expectedParents: [COMMIT, "2".repeat(40)],
      },
    ],
    [
      "WORKFLOW_RUN_READBACK",
      {
        workflowPath:
          ".github/workflows/organization-identity-writer-anchor.yml",
        expectedHeadSha: COMMIT,
        runId: 123,
      },
    ],
    ["WORKFLOW_RERUN", { runId: 123, runAttempt: 1, expectedHeadSha: COMMIT }],
    [
      "CONTROLLER_VARIABLES_WRITE",
      {
        variableCount: 15,
        variableNameSetSha256: SHA,
        variableValueDigestSetSha256: "b".repeat(64),
      },
    ],
  ];
  for (const [operation, payload] of cases) {
    const operationRequest = request({ operation, payload });
    assert.equal(
      validateGitHubControllerRequest(operationRequest, contract()).status,
      "PASS",
    );
    assert.equal(
      buildGitHubControllerInvocation(operationRequest, contract()).status,
      "PASS",
    );
  }
});

test("GitHub receipts are operation-bound and reject cross-controller or credential records", () => {
  const protectedMainRequest = request();
  const receipt = {
    schemaVersion: "organization-identity-github-controller-receipt/v1",
    contractSha256: SHA,
    controllerReviewReceiptSha256: SHA,
    operation: "PROTECTED_MAIN_READBACK",
    requestId: SHA,
    requestSha256: SHA,
    payloadSchemaSha256: protectedMainRequest.payloadSchemaSha256,
    payloadSha256: protectedMainRequest.payloadSha256,
    authorizationReceiptSha256: protectedMainRequest.authorizationReceiptSha256,
    credentialHandleSha256: SHA,
    repository: "mlhjyx/global-backend",
    observedOrWrittenRef: "refs/heads/main",
    observedBaseSha: null,
    observedHeadSha: COMMIT,
    resultSchemaSha256: SHA,
    resultSha256: SHA,
    httpStatus: 200,
    executableClosureSetSha256: SHA,
    prePostToctouSha256: SHA,
    containsCredentialValue: false,
    result: "PASS",
  };
  assert.equal(
    validateGitHubControllerReceipt(receipt, protectedMainRequest).status,
    "PASS",
  );
  for (const mutation of [
    { ...receipt, operation: "PR_READBACK" },
    { ...receipt, repository: "other/repo" },
    { ...receipt, containsCredentialValue: true },
    { ...receipt, credentialValue: "secret" },
    {
      ...receipt,
      schemaVersion: "organization-identity-gitleaks-controller-receipt/v1",
    },
  ]) {
    assert.equal(
      validateGitHubControllerReceipt(mutation, protectedMainRequest).status,
      "INTEGRITY_ERROR",
    );
  }
});
