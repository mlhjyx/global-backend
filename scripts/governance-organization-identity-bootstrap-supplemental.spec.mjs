import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
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
import { spawnSync } from "node:child_process";

import {
  buildClosedCommandRequest,
  canonicalJsonBytes,
} from "./governance-organization-identity-launcher.mjs";
import {
  BOOTSTRAP_CONTRACT,
  buildBootstrapRunReceipt,
  compareRunToAcceptedContract,
  loadAcceptedScanner,
  materializeAcceptedInstallInputs,
  materializeBootstrapRunReceiptSet,
  planAcceptedBootstrapCommand,
  runAcceptedPrismaGenerate,
  validateBootstrapRunReceipt,
  validateBootstrapRunReceiptSet,
  validateExternalLaunchReceipt,
  verifyBootstrapPreimage,
  verifyDependencyAndToolRoots,
  verifyPostInstallBootstrapRehash,
  verifyReviewReceipt,
} from "./governance-organization-identity-bootstrap.mjs";

const SHA = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const COMMIT = "1".repeat(40);
const REQUEST_ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/requests";
const OUTPUT_ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/outputs";

const bootstrapModulePath = fileURLToPath(
  new URL("./governance-organization-identity-bootstrap.mjs", import.meta.url),
);

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validRequest(overrides = {}) {
  return buildClosedCommandRequest({
    taskId: "0P",
    commandId: "BOOTSTRAP_AUTHORITY_RUN_V1",
    mode: "INSTALL_AND_PRISMA_GENERATE",
    subjectCommit: COMMIT,
    bootstrapContractSha256: sha(canonicalJsonBytes(BOOTSTRAP_CONTRACT)),
    launcherMaterializationReceiptSha256: SHA_B,
    launcherMaterializationReviewReceiptSha256: SHA_C,
    authorizationReceiptSha256: null,
    externalControllerReceiptSha256: null,
    anchorReceiptSha256: null,
    parameters: {
      frozenLockfile: true,
      ignoreScripts: true,
      ignorePnpmfile: true,
      npmUserConfig: "/dev/null",
    },
    requestRoot: REQUEST_ROOT,
    outputRoot: OUTPUT_ROOT,
    ...overrides,
  });
}

function fixtureToolRoot(overrides = {}) {
  return {
    logicalPackage: "pnpm",
    version: "9.15.9",
    lockIntegrity: "sha512-test",
    rootRealpathSha256: SHA,
    loadedFileCount: 2,
    loadedFileSetSha256: SHA_B,
    contentSetSha256: SHA_C,
    prePostToctouSha256: SHA,
    ...overrides,
  };
}

function buildReceipt(request, overrides = {}) {
  return buildBootstrapRunReceipt({
    request,
    externalLaunchReceiptSha256: SHA,
    outputRecordSha256: SHA_B,
    subjectConfigurationSetSha256: SHA,
    subjectAbsenceSentinelSetSha256: SHA_B,
    subjectGitClosureSha256: SHA_C,
    environmentValueSetSha256: SHA,
    taskRoot: "/tmp/bootstrap-task",
    taskRootDevice: "1",
    taskRootInode: "2",
    fixedRootSetSha256: SHA_B,
    postInstallBootstrapRehashSha256: SHA_C,
    dependencyDeclarationRoots: [fixtureToolRoot()],
    toolExecutionRoots: [fixtureToolRoot({ logicalPackage: "typescript" })],
    prismaSchemaSha256: SHA,
    generatedClientSetSha256: SHA_B,
    generatedDmmfSha256: SHA_C,
    generatedDelegateSetSha256: SHA,
    generatedOutputSetSha256: SHA_B,
    typescriptDynamicImportSha256: SHA_C,
    hostileMarkerSetSha256: SHA,
    prePostToctouSha256: SHA_B,
    startedAt: "2026-09-04T00:00:00.000Z",
    finishedAt: "2026-09-04T00:00:01.000Z",
    ...overrides,
  });
}

async function createFixtureRepo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bootstrap-extra-repo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new Map([
    ["package.json", '{\n  "name": "fixture"\n}\n'],
    ["apps/api/package.json", '{\n  "name": "api"\n}\n'],
    ["packages/db/package.json", '{\n  "name": "db"\n}\n'],
    ["pnpm-workspace.yaml", "packages:\n  - apps/*\n  - packages/*\n"],
    ["pnpm-lock.yaml", "lockfileVersion: '9.0'\n"],
    ["tsconfig.base.json", '{\n  "compilerOptions": {}\n}\n'],
    ["scripts/governance-organization-identity-bootstrap.mjs", "export {};\n"],
    [
      "scripts/governance-organization-identity-bootstrap.spec.mjs",
      "export {};\n",
    ],
    [".dockerignore", "node_modules\n"],
    [".gitignore", "node_modules\n"],
  ]);
  for (const [name, content] of files) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(git(["init"]).status, 0);
  assert.equal(git(["config", "user.email", "test@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Coverage Test"]).status, 0);
  assert.equal(git(["add", "."]).status, 0);
  assert.equal(git(["commit", "-m", "fixture"]).status, 0);
  return { root, commit: git(["rev-parse", "HEAD"]).stdout.trim() };
}

test("external launch receipts accept standalone exact records and reject malformed variants", () => {
  const request = validRequest();
  const receipt = {
    schemaVersion: "organization-identity-external-launch-receipt/v1",
    requestId: request.requestId,
    commandId: request.commandId,
    mode: request.mode,
    subjectCommit: request.subjectCommit,
    invocationDescriptorSha256: SHA,
    launcherContractSha256: BOOTSTRAP_CONTRACT.launcherContractSha256,
    launchedByExecutableClosureSha256: SHA_B,
    acceptedAt: "2026-09-04T00:00:00.000Z",
    result: "PASS",
  };
  assert.equal(validateExternalLaunchReceipt(receipt).status, "PASS");
  for (const mutation of [
    { ...receipt, acceptedAt: "nope" },
    { ...receipt, result: "FAIL" },
    { ...receipt, subjectCommit: "short" },
    { ...receipt, launcherContractSha256: "nope" },
  ]) {
    assert.equal(
      validateExternalLaunchReceipt(mutation, request).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("receipt-set helpers sort multi-record inputs and compare rejects bound failures", () => {
  const requestA = validRequest();
  const requestB = validRequest({
    subjectCommit: "2".repeat(40),
    bootstrapContractSha256: SHA,
  });
  const receiptA = buildReceipt(requestA);
  const receiptB = buildReceipt(requestB, {
    bootstrapContractSha256: requestB.bootstrapContractSha256,
  });
  const set = materializeBootstrapRunReceiptSet("0P", COMMIT, [
    { request: requestB, receipt: receiptB },
    { request: requestA, receipt: receiptA },
  ]);
  assert.equal(set.receiptCount, 2);
  assert.equal(
    set.receipts[0].requestId.localeCompare(set.receipts[1].requestId) < 0,
    true,
  );
  assert.equal(
    validateBootstrapRunReceiptSet(set, [
      { request: requestA, receipt: receiptA },
      { request: requestB, receipt: receiptB },
    ]).status,
    "INTEGRITY_ERROR",
  );
  assert.equal(
    compareRunToAcceptedContract(
      BOOTSTRAP_CONTRACT,
      {
        ...receiptA,
        hostileMarkerExecutionCount: 1,
      },
      requestA,
    ).status,
    "INTEGRITY_ERROR",
  );
  assert.equal(
    compareRunToAcceptedContract(
      BOOTSTRAP_CONTRACT,
      {
        ...receiptA,
        bootstrapContractSha256: SHA_B,
      },
      requestA,
    ).status,
    "INTEGRITY_ERROR",
  );
});

test("preimage and materialization reject invalid requests and task-root symlinks", async (t) => {
  const { root, commit } = await createFixtureRepo(t);
  assert.equal(
    (
      await verifyBootstrapPreimage({
        repoRoot: "relative",
        subjectCommit: commit,
      })
    ).status,
    "INTEGRITY_ERROR",
  );
  assert.equal(
    (
      await verifyBootstrapPreimage({
        repoRoot: root,
        subjectCommit: commit,
        acceptedInputPaths: ["missing.json"],
      })
    ).status,
    "INTEGRITY_ERROR",
  );
  const symlinkParent = await mkdtemp(
    path.join(os.tmpdir(), "bootstrap-symlink-"),
  );
  const target = await mkdtemp(
    path.join(os.tmpdir(), "bootstrap-symlink-target-"),
  );
  t.after(() => rm(symlinkParent, { recursive: true, force: true }));
  t.after(() => rm(target, { recursive: true, force: true }));
  const taskRoot = path.join(symlinkParent, "task-root");
  await symlink(target, taskRoot);
  assert.equal(
    (
      await materializeAcceptedInstallInputs({
        repoRoot: root,
        subjectCommit: commit,
        taskRoot,
      })
    ).status,
    "INTEGRITY_ERROR",
  );
});

test("tool-root and scanner helpers reject request and digest drift variants", async (t) => {
  const taskRoot = await mkdtemp(
    path.join(os.tmpdir(), "bootstrap-tool-roots-"),
  );
  t.after(() => rm(taskRoot, { recursive: true, force: true }));
  assert.equal(
    verifyDependencyAndToolRoots({
      taskRoot,
      environment: { HOME: "/tmp/outside" },
    }).status,
    "INTEGRITY_ERROR",
  );
  assert.throws(
    () =>
      planAcceptedBootstrapCommand({
        taskRoot,
        pnpmEntrypoint: "relative",
      }),
    /BOOTSTRAP_COMMAND_REQUEST_INVALID/,
  );
  assert.throws(
    () =>
      runAcceptedPrismaGenerate({
        taskRoot,
        pnpmEntrypoint: "relative",
      }),
    /PRISMA_GENERATE_REQUEST_INVALID/,
  );
  assert.equal(
    (
      await verifyPostInstallBootstrapRehash({
        bootstrapPath: "relative",
        expectedSha256: SHA,
      })
    ).status,
    "INTEGRITY_ERROR",
  );
  const scanner = path.join(taskRoot, "scanner.mjs");
  await writeFile(scanner, "export const value = 1;\n");
  const imported = await loadAcceptedScanner({
    modulePath: scanner,
    expectedSha256: sha(await readFile(scanner)),
    importer: async (specifier) => {
      assert.match(specifier, /^file:/);
      return { default: "custom" };
    },
  });
  assert.equal(imported.status, "PASS");
  assert.equal(imported.module.default, "custom");
});

test("review verification covers hash-mismatch and CLI failure branches", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bootstrap-review-extra-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reportPath = path.join(root, "review.md");
  await writeFile(reportPath, "Critical: 0\nImportant: 0\nVerdict: PASS\n");
  const receipt = {
    schemaVersion: "organization-identity-bootstrap-scoped-review/v1",
    reviewerClass: "INDEPENDENT_BOOTSTRAP_REVIEW",
    subjectCommit: COMMIT,
    subjectParentCommit: "2".repeat(40),
    range: `${"2".repeat(40)}..${COMMIT}`,
    pathSetSha256: SHA,
    reportSha256: SHA_B,
    counterexampleSetSha256: SHA_C,
    finalSpecSha256:
      "536e376a40d9ef4f49a65bc0224b74d58eb8a2d743fa766aa020397e67279dd4",
    critical: 0,
    important: 0,
    verdict: "PASS",
    containsCredentialValue: false,
  };
  assert.equal(
    (
      await verifyReviewReceipt({
        reportPath,
        receipt,
        subjectCommit: COMMIT,
      })
    ).status,
    "INTEGRITY_ERROR",
  );
  assert.equal(
    (
      await verifyReviewReceipt({
        reportPath: "relative",
        receipt,
        subjectCommit: COMMIT,
      })
    ).status,
    "INTEGRITY_ERROR",
  );
  const missingReceiptPath = path.join(root, "missing.json");
  const cliFail = spawnSync(
    process.execPath,
    [
      bootstrapModulePath,
      "verify-review",
      "--report",
      reportPath,
      "--receipt",
      missingReceiptPath,
      "--subject",
      COMMIT,
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(cliFail.status, 0);
});
