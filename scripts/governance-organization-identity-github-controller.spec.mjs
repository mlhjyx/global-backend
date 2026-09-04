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
const SOURCE_CLOSURE = "e".repeat(64);

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
    schemaVersion: "organization-identity-github-controller-contract/v2",
    rootDirectory:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/github",
    requestRoot:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/github/requests",
    outputRoot:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/github/outputs",
    controllerSourceBlobId: "1".repeat(40),
    controllerSourceSha256: SHA,
    controllerSourceClosureSha256: SOURCE_CLOSURE,
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

function evidence(operation = "PROTECTED_MAIN_READBACK") {
  const controllerContract = contract();
  const materializationReceipt = {
    schemaVersion:
      "organization-identity-external-controller-materialization/v2",
    controllerClass: "GITHUB",
    contractSha256: sha(`${canonical(controllerContract)}\n`),
    controllerSourceSha256: controllerContract.controllerSourceSha256,
    controllerSourceClosureSha256:
      controllerContract.controllerSourceClosureSha256,
    rootDirectorySha256: SHA,
    requestRootSha256: SHA,
    outputRootSha256: SHA,
    ownerUid: 0,
    ownerGid: 0,
    directoryMode: 0o700,
    controllerMode: 0o500,
    recordMode: 0o600,
    executableClosureSetSha256: sha(
      `${canonical(controllerContract.executableClosure)}\n`,
    ),
    environmentSchemaSha256: SHA,
    prePostToctouSha256: SHA,
    result: "PASS",
  };
  const controllerReviewReceipt = {
    schemaVersion: "organization-identity-controller-review/v2",
    controllerClass: "GITHUB",
    contractSha256: materializationReceipt.contractSha256,
    materializationReceiptSha256: sha(`${canonical(materializationReceipt)}\n`),
    controllerSourceClosureSha256:
      controllerContract.controllerSourceClosureSha256,
    requestSchemaSha256: SHA,
    reportSha256: SHA,
    counterexampleSetSha256: SHA,
    reviewerClass: "INDEPENDENT_CONTROLLER_SECURITY_REVIEW",
    critical: 0,
    important: 0,
    verdict: "PASS",
    containsCredentialValue: false,
  };
  const authorizationReceiptCanonicalBytes = `${canonical({
    controllerClass: "GITHUB",
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
    schemaVersion: "organization-identity-github-controller-request/v2",
    requestId: SHA,
    operation: "PROTECTED_MAIN_READBACK",
    contractSha256: sha(`${canonical(contract())}\n`),
    materializationReceiptSha256: SHA,
    controllerReviewReceiptSha256: SHA,
    controllerSourceClosureSha256: SOURCE_CLOSURE,
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
    apiRequestBodySchemaSha256: null,
    apiRequestBodySha256: null,
    apiRequestBody: null,
    outputRecordPath:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/github/outputs/readback.json",
    payload: { repository: "mlhjyx/global-backend", ref: "refs/heads/main" },
    ...overrides,
  };
  if (!("payloadSha256" in overrides)) {
    result.payloadSha256 = sha(`${canonical(result.payload)}\n`);
  }
  if (
    result.apiRequestBody !== null &&
    !("apiRequestBodySha256" in overrides)
  ) {
    result.apiRequestBodySha256 = sha(`${canonical(result.apiRequestBody)}\n`);
  }
  if (
    result.apiRequestBody === null &&
    !("apiRequestBody" in overrides) &&
    ["PR_CREATE", "PR_UPDATE_BODY", "PR_MERGE"].includes(result.operation)
  ) {
    if (result.operation === "PR_CREATE") {
      result.apiRequestBody = {
        base: result.payload.base,
        head: result.payload.head,
        title: result.payload.title,
        body: "body text",
      };
    }
    if (result.operation === "PR_UPDATE_BODY") {
      result.apiRequestBody = {
        title: result.payload.title,
        body: "body text",
      };
    }
    if (result.operation === "PR_MERGE") {
      result.apiRequestBody = {
        merge_method: "merge",
        sha: result.payload.expectedHeadSha,
      };
    }
    result.apiRequestBodySchemaSha256 = SHA;
    result.apiRequestBodySha256 = sha(`${canonical(result.apiRequestBody)}\n`);
  }
  const records = evidence(result.operation);
  result.materializationReceiptSha256 = sha(
    `${canonical(records.materializationReceipt)}\n`,
  );
  result.controllerReviewReceiptSha256 = sha(
    `${canonical(records.controllerReviewReceipt)}\n`,
  );
  result.authorizationReceiptSha256 = sha(
    records.authorizationReceiptCanonicalBytes,
  );
  for (const key of [
    "materializationReceiptSha256",
    "controllerReviewReceiptSha256",
    "authorizationReceiptSha256",
  ]) {
    if (key in overrides) result[key] = overrides[key];
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
    {
      schemaVersion: "organization-identity-github-controller-contract/v1",
    },
    { controllerSourceClosureSha256: SHA },
  ]) {
    assert.equal(
      validateGitHubControllerContract(contract(mutation)).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("GitHub requests enforce exact operation payloads and authorization", () => {
  assert.equal(
    validateGitHubControllerRequest(request(), contract(), evidence()).status,
    "PASS",
  );
  const merge = request({
    operation: "PR_MERGE",
    payload: {
      number: 407,
      expectedBaseSha: COMMIT,
      expectedHeadSha: "2".repeat(40),
      mergeMethod: "merge",
      immediateReadbackReceiptSetSha256: SHA,
    },
  });
  assert.equal(
    validateGitHubControllerRequest(merge, contract(), evidence("PR_MERGE"))
      .status,
    "PASS",
  );
  assert.equal(
    validateGitHubControllerRequest(
      request({ authorizationReceiptSha256: null }),
      contract(),
      evidence(),
    ).status,
    "INTEGRITY_ERROR",
  );
  for (const mutation of [
    { ...merge, contractSha256: SHA },
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
      validateGitHubControllerRequest(
        mutation,
        contract(),
        evidence("PR_MERGE"),
      ).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("GitHub invocation is closed and carries only a credential handle", () => {
  const result = buildGitHubControllerInvocation(
    request(),
    contract(),
    evidence(),
  );
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.argv, [
    "api",
    "repos/mlhjyx/global-backend/git/ref/heads/main",
    "--method",
    "GET",
  ]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("GitHub mutation control payloads are separated from exact API bodies", () => {
  const create = request({
    operation: "PR_CREATE",
    payload: {
      base: "main",
      head: "codex/pr407-organization-identity-caller-cutover-v2",
      title: "Organization Identity writer ban-at-source",
      bodySha256: SHA,
      expectedBaseSha: COMMIT,
      expectedHeadSha: "2".repeat(40),
    },
    apiRequestBodySchemaSha256: SHA,
    apiRequestBody: {
      base: "main",
      head: "codex/pr407-organization-identity-caller-cutover-v2",
      title: "Organization Identity writer ban-at-source",
      body: "body text",
    },
  });
  assert.equal(
    validateGitHubControllerRequest(create, contract(), evidence("PR_CREATE"))
      .status,
    "PASS",
  );
  const createInvocation = buildGitHubControllerInvocation(
    create,
    contract(),
    evidence("PR_CREATE"),
  );
  assert.equal(createInvocation.status, "PASS");
  assert.equal(
    sha(createInvocation.inputRecordBytes),
    create.apiRequestBodySha256,
  );
  assert.equal(
    JSON.stringify(JSON.parse(createInvocation.inputRecordBytes)).includes(
      "expectedHeadSha",
    ),
    false,
  );
  for (const mutation of [
    {
      ...create,
      apiRequestBody: {
        ...create.apiRequestBody,
        expectedBaseSha: COMMIT,
      },
      apiRequestBodySha256: sha(
        `${canonical({ ...create.apiRequestBody, expectedBaseSha: COMMIT })}\n`,
      ),
    },
    {
      ...create,
      operation: "PR_UPDATE_BODY",
      payload: {
        number: 407,
        expectedBaseSha: COMMIT,
        expectedHeadSha: "2".repeat(40),
        title: "Organization Identity writer ban-at-source",
        bodySha256: SHA,
      },
      apiRequestBody: {
        title: "Organization Identity writer ban-at-source",
        body: "body text",
        expectedHeadSha: "2".repeat(40),
      },
      apiRequestBodySha256: sha(
        `${canonical({
          title: "Organization Identity writer ban-at-source",
          body: "body text",
          expectedHeadSha: "2".repeat(40),
        })}\n`,
      ),
    },
    {
      ...create,
      operation: "PR_MERGE",
      payload: {
        number: 407,
        expectedBaseSha: COMMIT,
        expectedHeadSha: "2".repeat(40),
        mergeMethod: "merge",
        immediateReadbackReceiptSetSha256: SHA,
      },
      apiRequestBody: { merge_method: "merge" },
      apiRequestBodySha256: sha(`${canonical({ merge_method: "merge" })}\n`),
    },
  ]) {
    assert.equal(
      validateGitHubControllerRequest(
        mutation,
        contract(),
        evidence(mutation.operation),
      ).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("GitHub workflow and variable writes require result readbacks, not caller success metadata", () => {
  const workflow = request({
    operation: "WORKFLOW_RUN_READBACK",
    payload: {
      workflowPath: ".github/workflows/organization-identity-writer-anchor.yml",
      expectedHeadSha: COMMIT,
      runId: 123,
    },
  });
  const receipt = {
    schemaVersion: "organization-identity-github-controller-receipt/v2",
    contractSha256: workflow.contractSha256,
    controllerReviewReceiptSha256: workflow.controllerReviewReceiptSha256,
    controllerSourceClosureSha256: workflow.controllerSourceClosureSha256,
    operation: workflow.operation,
    requestId: workflow.requestId,
    requestSha256: sha(`${canonical(workflow)}\n`),
    payloadSchemaSha256: workflow.payloadSchemaSha256,
    payloadSha256: workflow.payloadSha256,
    authorizationReceiptSha256: workflow.authorizationReceiptSha256,
    credentialHandleSha256: SHA,
    repository: "mlhjyx/global-backend",
    observedOrWrittenRef: "refs/heads/main",
    observedBaseSha: null,
    observedHeadSha: COMMIT,
    resultSchemaSha256:
      contract().operationResultSchemaSha256[workflow.operation],
    resultSha256: SHA,
    httpStatus: 200,
    executableClosureSetSha256: sha(
      `${canonical(contract().executableClosure)}\n`,
    ),
    prePostToctouSha256: SHA,
    containsCredentialValue: false,
    result: "PASS",
  };
  assert.equal(
    validateGitHubControllerReceipt(
      {
        ...receipt,
        resultSha256: sha(
          `${canonical({ headSha: COMMIT, runId: 123, workflowBlobId: "3".repeat(40), conclusion: "success" })}\n`,
        ),
      },
      workflow,
      contract(),
      {
        headSha: "2".repeat(40),
        runId: 123,
        workflowBlobId: "3".repeat(40),
        conclusion: "success",
      },
      evidence("WORKFLOW_RUN_READBACK"),
    ).status,
    "INTEGRITY_ERROR",
  );
  assert.equal(
    validateGitHubControllerRequest(
      request({
        operation: "CONTROLLER_VARIABLES_WRITE",
        payload: {
          variableCount: 15,
          variableNameSetSha256: SHA,
          variableValueDigestSetSha256: "b".repeat(64),
        },
      }),
      contract(),
      evidence("CONTROLLER_VARIABLES_WRITE"),
    ).status,
    "INTEGRITY_ERROR",
  );
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
        variables: Array.from({ length: 15 }, (_, index) => ({
          name: `IDENTITY_WRITER_VAR_${index}`,
          valueSha256: index === 0 ? SHA : "b".repeat(64),
          apiRequestBodySha256: index === 0 ? "c".repeat(64) : "d".repeat(64),
        })),
      },
    ],
  ];
  for (const [operation, payload] of cases) {
    const operationRequest = request({ operation, payload });
    assert.equal(
      validateGitHubControllerRequest(
        operationRequest,
        contract(),
        evidence(operation),
      ).status,
      "PASS",
    );
    const invocation = buildGitHubControllerInvocation(
      operationRequest,
      contract(),
      evidence(operation),
    );
    assert.equal(invocation.status, "PASS");
    assert.equal(invocation.argv.includes("--closed-operation"), false);
    assert.equal(JSON.stringify(invocation).includes(operation), true);
    if (invocation.inputPath) {
      const expectedInputSha =
        operationRequest.apiRequestBodySha256 ?? operationRequest.payloadSha256;
      assert.equal(sha(invocation.inputRecordBytes), expectedInputSha);
      assert.equal(invocation.argv.includes(invocation.inputPath), true);
    }
    if (operation === "WORKFLOW_RERUN") {
      assert.deepEqual(invocation.preReadbacks[0].expected, {
        runAttempt: payload.runAttempt,
        headSha: payload.expectedHeadSha,
      });
    }
  }
});

test("GitHub push uses the immutable expected-head refspec", () => {
  const push = request({
    operation: "PUSH_EXACT_BRANCH",
    payload: {
      branch: "codex/pr407-organization-identity-caller-cutover-v2",
      expectedHead: COMMIT,
      setUpstream: true,
      force: false,
    },
  });
  const invocation = buildGitHubControllerInvocation(
    push,
    contract(),
    evidence("PUSH_EXACT_BRANCH"),
  );
  assert.deepEqual(invocation.argv, [
    "push",
    "--set-upstream",
    "origin",
    `${COMMIT}:refs/heads/codex/pr407-organization-identity-caller-cutover-v2`,
  ]);
  assert.equal(invocation.preconditions.expectedHead, COMMIT);
});

test("GitHub receipts are operation-bound and reject cross-controller or credential records", () => {
  const protectedMainRequest = request();
  const controllerContract = contract();
  const resultRecord = {
    schemaVersion: "github-result-fixture/v1",
    operation: protectedMainRequest.operation,
    observedHeadSha: COMMIT,
  };
  const receipt = {
    schemaVersion: "organization-identity-github-controller-receipt/v2",
    contractSha256: protectedMainRequest.contractSha256,
    controllerReviewReceiptSha256:
      protectedMainRequest.controllerReviewReceiptSha256,
    controllerSourceClosureSha256:
      protectedMainRequest.controllerSourceClosureSha256,
    operation: "PROTECTED_MAIN_READBACK",
    requestId: SHA,
    requestSha256: sha(`${canonical(protectedMainRequest)}\n`),
    payloadSchemaSha256: protectedMainRequest.payloadSchemaSha256,
    payloadSha256: protectedMainRequest.payloadSha256,
    authorizationReceiptSha256: protectedMainRequest.authorizationReceiptSha256,
    credentialHandleSha256: SHA,
    repository: "mlhjyx/global-backend",
    observedOrWrittenRef: "refs/heads/main",
    observedBaseSha: null,
    observedHeadSha: COMMIT,
    resultSchemaSha256: SHA,
    resultSha256: sha(`${canonical(resultRecord)}\n`),
    httpStatus: 200,
    executableClosureSetSha256: sha(
      `${canonical(controllerContract.executableClosure)}\n`,
    ),
    prePostToctouSha256: SHA,
    containsCredentialValue: false,
    result: "PASS",
  };
  assert.equal(
    validateGitHubControllerReceipt(
      receipt,
      protectedMainRequest,
      controllerContract,
      resultRecord,
      evidence(),
    ).status,
    "PASS",
  );
  assert.equal(
    validateGitHubControllerReceipt(receipt, protectedMainRequest).status,
    "INTEGRITY_ERROR",
  );
  for (const mutation of [
    { ...receipt, operation: "PR_READBACK" },
    { ...receipt, repository: "other/repo" },
    { ...receipt, containsCredentialValue: true },
    { ...receipt, credentialValue: "secret" },
    {
      ...receipt,
      schemaVersion: "organization-identity-github-controller-receipt/v1",
    },
    { ...receipt, controllerSourceClosureSha256: SHA },
    {
      ...receipt,
      schemaVersion: "organization-identity-gitleaks-controller-receipt/v1",
    },
  ]) {
    assert.equal(
      validateGitHubControllerReceipt(
        mutation,
        protectedMainRequest,
        controllerContract,
        resultRecord,
        evidence(),
      ).status,
      "INTEGRITY_ERROR",
    );
  }
  assert.equal(
    validateGitHubControllerReceipt(
      receipt,
      protectedMainRequest,
      controllerContract,
      { ...resultRecord, observedHeadSha: "2".repeat(40) },
      evidence(),
    ).status,
    "INTEGRITY_ERROR",
  );
});
