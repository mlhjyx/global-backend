import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
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

import {
  buildClosedCommandRequest,
  canonicalJsonBytes,
  validateBootstrapRunReceipt as validateTask0LBootstrapRunReceipt,
  validateBootstrapRunReceiptSet as validateTask0LBootstrapRunReceiptSet,
} from "./governance-organization-identity-launcher.mjs";
import { validateBootstrapContractV2 as validateTask0LBootstrapContract } from "./governance-organization-identity-controller-contracts.mjs";

import {
  BOOTSTRAP_CONTRACT,
  PER_RUN_VARIABLE_FIELD_PATHS,
  buildBootstrapRunReceipt,
  compareRunToAcceptedContract,
  materializeAcceptedInstallInputs,
  materializeBootstrapRunReceiptSet,
  planAcceptedBootstrapCommand,
  runAcceptedPrismaGenerate,
  validateBootstrapContract,
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
const SHA_D = "d".repeat(64);
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
    version: "10.0.0",
    lockIntegrity: "sha512-test",
    rootRealpathSha256: SHA,
    loadedFileCount: 0,
    loadedFileSetSha256: SHA,
    contentSetSha256: SHA,
    prePostToctouSha256: SHA,
    ...overrides,
  };
}

async function createFixtureRepo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-bootstrap-repo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["apps/api", "packages/db", "scripts"]) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  const files = new Map([
    ["package.json", '{"scripts":{"postinstall":"node hostile.js"}}\n'],
    ["apps/api/package.json", '{"name":"@global/api"}\n'],
    ["packages/db/package.json", '{"name":"@global/db"}\n'],
    ["pnpm-workspace.yaml", "packages:\n  - packages/*\n  - apps/*\n"],
    ["pnpm-lock.yaml", "lockfileVersion: '9.0'\n"],
    ["tsconfig.base.json", '{"compilerOptions":{}}\n'],
    ["scripts/governance-organization-identity-bootstrap.mjs", "export {}\n"],
    ["scripts/governance-organization-identity-bootstrap.spec.mjs", "import 'node:test';\n"],
    [".dockerignore", "node_modules\n"],
    [".gitignore", "node_modules\n"],
  ]);
  for (const [name, content] of files) {
    await writeFile(path.join(root, name), content);
  }
  const git = (args) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(git(["init"]).status, 0);
  assert.equal(git(["config", "user.email", "test@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Task0P Test"]).status, 0);
  assert.equal(git(["add", "."]).status, 0);
  assert.equal(git(["commit", "-m", "fixture"]).status, 0);
  const commit = git(["rev-parse", "HEAD"]).stdout.trim();
  return { root, commit, files };
}

test("exports an immutable BootstrapContractV2 accepted by Task0L shared validators", async () => {
  assert.equal(validateBootstrapContract(BOOTSTRAP_CONTRACT).status, "PASS");
  assert.equal(validateTask0LBootstrapContract(BOOTSTRAP_CONTRACT).status, "PASS");
  const first = sha(canonicalJsonBytes(BOOTSTRAP_CONTRACT));
  const moduleAgain = await import(
    `${bootstrapModulePath}?cacheBust=${Date.now()}`
  );
  assert.equal(sha(canonicalJsonBytes(moduleAgain.BOOTSTRAP_CONTRACT)), first);
  for (const forbidden of [
    "subjectCommit",
    "taskRoot",
    "generatedOutputSetSha256",
    "startedAt",
    "environmentValueSetSha256",
  ]) {
    assert.equal(Object.hasOwn(BOOTSTRAP_CONTRACT, forbidden), false);
  }
  assert.equal(
    validateBootstrapContract({ ...BOOTSTRAP_CONTRACT, subjectCommit: COMMIT })
      .status,
    "INTEGRITY_ERROR",
  );
  assert.equal(
    validateBootstrapContract({
      ...BOOTSTRAP_CONTRACT,
      toolLogicalExpectations: [
        ...BOOTSTRAP_CONTRACT.toolLogicalExpectations,
        { role: "MUTABLE", packageName: "mutable" },
      ],
    }).status,
    "INTEGRITY_ERROR",
  );
});

test("validates exact-key external launch receipts", () => {
  const request = validRequest();
  const receipt = {
    schemaVersion: "organization-identity-external-launch-receipt/v1",
    requestId: request.requestId,
    commandId: request.commandId,
    mode: request.mode,
    subjectCommit: request.subjectCommit,
    invocationDescriptorSha256: SHA,
    launcherContractSha256: request.bootstrapContractSha256,
    launchedByExecutableClosureSha256: SHA_B,
    acceptedAt: "2026-09-04T00:00:00.000Z",
    result: "PASS",
  };
  assert.equal(validateExternalLaunchReceipt(receipt, request).status, "PASS");
  assert.equal(
    validateExternalLaunchReceipt({ ...receipt, extra: true }, request).status,
    "INTEGRITY_ERROR",
  );
  assert.equal(
    validateExternalLaunchReceipt({ ...receipt, commandId: "SCANNER_TEST_V1" }, request)
      .status,
    "INTEGRITY_ERROR",
  );
});

test("builds one-command BootstrapRunReceipts compatible with Task0L and rejects replay", () => {
  const request = validRequest();
  const receipt = buildBootstrapRunReceipt({
    request,
    externalLaunchReceiptSha256: SHA_D,
    outputRecordSha256: SHA,
    subjectConfigurationSetSha256: SHA,
    subjectAbsenceSentinelSetSha256: SHA,
    subjectGitClosureSha256: SHA,
    environmentValueSetSha256: SHA,
    taskRoot: "/tmp/task0p-root",
    taskRootDevice: "1",
    taskRootInode: "2",
    fixedRootSetSha256: SHA,
    postInstallBootstrapRehashSha256: SHA,
    dependencyDeclarationRoots: [fixtureToolRoot()],
    toolExecutionRoots: [fixtureToolRoot({ logicalPackage: "typescript" })],
    prismaSchemaSha256: SHA,
    generatedClientSetSha256: SHA,
    generatedDmmfSha256: SHA,
    generatedDelegateSetSha256: SHA,
    generatedOutputSetSha256: SHA,
    typescriptDynamicImportSha256: SHA,
    hostileMarkerSetSha256: SHA,
    prePostToctouSha256: SHA,
    startedAt: "2026-09-04T00:00:00.000Z",
    finishedAt: "2026-09-04T00:00:01.000Z",
  });
  assert.equal(validateBootstrapRunReceipt(receipt, request).status, "PASS");
  assert.equal(
    validateTask0LBootstrapRunReceipt(receipt, request).status,
    "PASS",
  );
  assert.equal(compareRunToAcceptedContract(BOOTSTRAP_CONTRACT, receipt, request).status, "PASS");
  for (const fieldPath of PER_RUN_VARIABLE_FIELD_PATHS) {
    const clone = structuredClone(receipt);
    const finalKey = fieldPath.split(".").at(-1);
    let target = clone;
    for (const key of fieldPath.split(".").slice(0, -1)) target = target[key];
    if (typeof target[finalKey] === "string" && /^[0-9a-f]{64}$/.test(target[finalKey])) {
      target[finalKey] = SHA_B;
    }
    assert.equal(compareRunToAcceptedContract(BOOTSTRAP_CONTRACT, clone, request).status, "PASS");
  }
  assert.equal(
    validateBootstrapRunReceipt({ ...receipt, unlisted: true }, request).status,
    "INTEGRITY_ERROR",
  );
  const set = materializeBootstrapRunReceiptSet("0P", COMMIT, [
    { request, receipt },
  ]);
  assert.equal(
    validateBootstrapRunReceiptSet(set, [{ request, receipt }]).status,
    "PASS",
  );
  assert.equal(
    validateTask0LBootstrapRunReceiptSet(set, [{ request, receipt }]).status,
    "PASS",
  );
  assert.equal(
    validateBootstrapRunReceiptSet(
      { ...set, receiptCount: 2, receipts: [set.receipts[0], set.receipts[0]] },
      [
        { request, receipt },
        { request, receipt },
      ],
    ).code,
    "BOOTSTRAP_RECEIPT_REPLAY",
  );
});

test("verifies accepted Git blobs and absences before immutable materialization", async (t) => {
  const { root, commit, files } = await createFixtureRepo(t);
  const taskRoot = await mkdtemp(path.join(os.tmpdir(), "identity-bootstrap-task-"));
  t.after(() => rm(taskRoot, { recursive: true, force: true }));
  const verified = await verifyBootstrapPreimage({
    repoRoot: root,
    subjectCommit: commit,
  });
  assert.equal(verified.status, "PASS", verified.code);
  const materialized = await materializeAcceptedInstallInputs({
    repoRoot: root,
    subjectCommit: commit,
    taskRoot,
  });
  assert.equal(materialized.status, "PASS", materialized.code);
  for (const [name, content] of files) {
    assert.equal(await readFile(path.join(taskRoot, name), "utf8"), content);
  }
  assert.equal(
    (
      await writeFile(
        path.join(root, ".pnpmfile.cjs"),
        "require('node:fs').writeFileSync(process.env.HOSTILE_MARKER, 'loaded')\n",
      ),
      await verifyBootstrapPreimage({
        repoRoot: root,
        subjectCommit: commit,
        acceptedAbsentPaths: [".pnpmfile.cjs"],
      })
    ).status,
    "INTEGRITY_ERROR",
  );
  await symlink("/tmp", path.join(taskRoot, "linked-store"));
  assert.equal(
    verifyDependencyAndToolRoots({
      taskRoot,
      roots: { store: path.join(taskRoot, "linked-store") },
      environment: {},
    }).status,
    "INTEGRITY_ERROR",
  );
});

test("plans exact clean pnpm and Prisma commands without loading hostile hooks", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-bootstrap-hostile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "marker");
  await writeFile(path.join(root, ".pnpmfile.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded')\n`);
  await writeFile(path.join(root, "preload.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'preload')\n`);
  const planned = planAcceptedBootstrapCommand({
    taskRoot: root,
    pnpmEntrypoint: "/opt/pnpm/bin/pnpm.cjs",
  });
  assert.deepEqual(planned.argv, [
    "/opt/pnpm/bin/pnpm.cjs",
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--ignore-pnpmfile",
    "--config.ignore-pnpmfile=true",
  ]);
  assert.equal(planned.environment.NPM_CONFIG_USERCONFIG, "/dev/null");
  assert.equal(Object.hasOwn(planned.environment, "NODE_OPTIONS"), false);
  assert.equal(Object.hasOwn(planned.environment, "NODE_PATH"), false);
  assert.equal(planned.hostileMarkerExecutionCount, 0);
  const checked = verifyDependencyAndToolRoots({
    taskRoot: root,
    roots: planned.roots,
    environment: {
      NODE_OPTIONS: `--require=${path.join(root, "preload.cjs")}`,
    },
  });
  assert.equal(checked.status, "INTEGRITY_ERROR");
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  const prisma = runAcceptedPrismaGenerate({
    taskRoot: root,
    pnpmEntrypoint: "/opt/pnpm/bin/pnpm.cjs",
  });
  assert.deepEqual(prisma.argv, [
    "/opt/pnpm/bin/pnpm.cjs",
    "--filter",
    "@global/db",
    "generate",
  ]);
  assert.equal(prisma.hostileMarkerExecutionCount, 0);
});

test("rehashes bootstrap after install before dynamic TypeScript scanner import", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-bootstrap-rehash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bootstrap = path.join(root, "bootstrap.mjs");
  await writeFile(bootstrap, "export const ok = true;\n");
  await chmod(bootstrap, 0o600);
  const first = await verifyPostInstallBootstrapRehash({
    bootstrapPath: bootstrap,
    expectedSha256: sha(await readFile(bootstrap)),
  });
  assert.equal(first.status, "PASS", first.code);
  await writeFile(bootstrap, "export const ok = false;\n");
  const drift = await verifyPostInstallBootstrapRehash({
    bootstrapPath: bootstrap,
    expectedSha256: first.bootstrapSha256,
  });
  assert.equal(drift.status, "INTEGRITY_ERROR");
});

test("closed review verification rejects drift, duplicate severities, and failing verdicts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-bootstrap-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reportPath = path.join(root, "review.md");
  await writeFile(reportPath, "Critical: 0\nImportant: 0\nVerdict: PASS\n");
  const reportSha256 = sha(await readFile(reportPath));
  const receipt = {
    schemaVersion: "organization-identity-bootstrap-scoped-review/v1",
    reviewerClass: "INDEPENDENT_BOOTSTRAP_REVIEW",
    subjectCommit: COMMIT,
    subjectParentCommit: "2".repeat(40),
    range: `${"2".repeat(40)}..${COMMIT}`,
    pathSetSha256: SHA,
    reportSha256,
    counterexampleSetSha256: SHA_B,
    finalSpecSha256:
      "536e376a40d9ef4f49a65bc0224b74d58eb8a2d743fa766aa020397e67279dd4",
    critical: 0,
    important: 0,
    verdict: "PASS",
    containsCredentialValue: false,
  };
  assert.equal(
    (await verifyReviewReceipt({ reportPath, receipt, subjectCommit: COMMIT })).status,
    "PASS",
  );
  assert.equal(
    (await verifyReviewReceipt({
      reportPath,
      receipt: { ...receipt, extra: true },
      subjectCommit: COMMIT,
    })).status,
    "INTEGRITY_ERROR",
  );
  await writeFile(reportPath, "Critical: 0\nCritical: 0\nImportant: 0\nVerdict: PASS\n");
  assert.equal(
    (await verifyReviewReceipt({ reportPath, receipt, subjectCommit: COMMIT })).status,
    "INTEGRITY_ERROR",
  );
});
