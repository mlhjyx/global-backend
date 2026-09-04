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
  loadAcceptedScanner,
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
const TOOL_ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root";
const RUNTIME_ROOT =
  "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime";

const bootstrapModulePath = fileURLToPath(
  new URL("./governance-organization-identity-bootstrap.mjs", import.meta.url),
);

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestRule(name, value) {
  return sha(canonicalJsonBytes({ name, value }));
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
  const root = await mkdtemp(
    path.join(os.tmpdir(), "identity-bootstrap-repo-"),
  );
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
    [
      "scripts/governance-organization-identity-bootstrap.spec.mjs",
      "import 'node:test';\n",
    ],
    [".dockerignore", "node_modules\n"],
    [".gitignore", "node_modules\n"],
  ]);
  for (const [name, content] of files) {
    await writeFile(path.join(root, name), content);
  }
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
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
  assert.equal(
    validateTask0LBootstrapContract(BOOTSTRAP_CONTRACT).status,
    "PASS",
  );
  assert.equal(
    BOOTSTRAP_CONTRACT.launcherContractSha256,
    digestRule("launcher-contract", {
      schemaVersion: "organization-identity-launcher-contract/v2",
      approvedPlan: {
        path: "docs/superpowers/plans/2026-09-01-organization-identity-writer-ban-at-source.md",
        commit: "9228673d8bd7277c3132ac461cb7d9e41666782f",
        blobId: "481430567129f74f489c694c73b6e298503d15b5",
        sha256:
          "ee653539f745a06dbc379b74425792513a348e3f541f48e8e6eae7cd43db5718",
      },
      rootDirectory:
        "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher",
      requestRoot: REQUEST_ROOT,
      outputRoot: OUTPUT_ROOT,
      toolRoot: TOOL_ROOT,
      runtimeRoot: RUNTIME_ROOT,
      toolRootFiles: [
        ["ENV", "bin/env", 0o500],
        ["NODE", "bin/node", 0o500],
        ["GIT", "bin/git", 0o500],
        ["COREPACK_SHIM", "lib/corepack/dist/corepack.js", 0o400],
        [
          "COREPACK_LIB_COREPACK_CJS",
          "lib/corepack/dist/lib/corepack.cjs",
          0o400,
        ],
        ["PNPM_SHIM", "lib/pnpm/9.15.9/bin/pnpm.cjs", 0o400],
        ["PNPM_ENTRYPOINT", "lib/pnpm/9.15.9/dist/pnpm.cjs", 0o400],
      ],
      runtimeEnvironment: {
        PATH: `${TOOL_ROOT}/bin`,
        HOME: `${RUNTIME_ROOT}/home`,
        XDG_CONFIG_HOME: `${RUNTIME_ROOT}/xdg-config`,
        XDG_CACHE_HOME: `${RUNTIME_ROOT}/xdg-cache`,
        COREPACK_HOME: `${RUNTIME_ROOT}/corepack-home`,
        PNPM_HOME: `${RUNTIME_ROOT}/pnpm-home`,
        TMPDIR: `${RUNTIME_ROOT}/tmp`,
        NPM_CONFIG_USERCONFIG: "/dev/null",
        CI: "1",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      },
      materializationReviewSchemaVersion:
        "organization-identity-launcher-materialization-review/v2",
    }),
  );
  assert.equal(
    BOOTSTRAP_CONTRACT.effectivePnpmArgvRuleSha256,
    digestRule("effective-pnpm-argv-rule", {
      cwd: "<taskRoot>",
      install: [
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--ignore-pnpmfile",
        "--config.ignore-pnpmfile=true",
        "--config.store-dir",
        "<roots.store>",
        "--config.virtual-store-dir",
        "<roots.virtualStore>",
        "--config.modules-dir",
        "<roots.modules>",
        "--config.cache-dir",
        "<roots.cache>",
        "--config.globalconfig",
        "<roots.config>/globalrc",
        "--config.userconfig",
        "/dev/null",
      ],
      environment: {
        PATH: "/usr/bin:/bin",
        HOME: "<roots.taskHome>",
        XDG_CONFIG_HOME: "<roots.config>",
        XDG_CACHE_HOME: "<roots.cache>",
        COREPACK_HOME: "<roots.cache>/corepack",
        PNPM_HOME: "<roots.cache>/pnpm-home",
        TMPDIR: "<roots.tmp>",
        NPM_CONFIG_USERCONFIG: "/dev/null",
        CI: "1",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      },
      prismaGenerate: ["--filter", "@global/db", "generate"],
    }),
  );
  const trackedContract = JSON.parse(
    await readFile(
      path.join(
        process.cwd(),
        "docs/governance/organization-identity-bootstrap-contract.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(trackedContract, BOOTSTRAP_CONTRACT);
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
    launcherContractSha256: BOOTSTRAP_CONTRACT.launcherContractSha256,
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
    validateExternalLaunchReceipt(
      { ...receipt, commandId: "SCANNER_TEST_V1" },
      request,
    ).status,
    "INTEGRITY_ERROR",
  );
  assert.equal(
    validateExternalLaunchReceipt(
      { ...receipt, launcherContractSha256: request.bootstrapContractSha256 },
      request,
    ).status,
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
  assert.equal(
    compareRunToAcceptedContract(BOOTSTRAP_CONTRACT, receipt, request).status,
    "PASS",
  );
  for (const fieldPath of PER_RUN_VARIABLE_FIELD_PATHS) {
    const clone = structuredClone(receipt);
    const finalKey = fieldPath.split(".").at(-1);
    let target = clone;
    for (const key of fieldPath.split(".").slice(0, -1)) target = target[key];
    if (
      typeof target[finalKey] === "string" &&
      /^[0-9a-f]{64}$/.test(target[finalKey])
    ) {
      target[finalKey] = SHA_B;
    }
    assert.equal(
      compareRunToAcceptedContract(BOOTSTRAP_CONTRACT, clone, request).status,
      "PASS",
    );
  }
  assert.equal(
    validateBootstrapRunReceipt({ ...receipt, unlisted: true }, request).status,
    "INTEGRITY_ERROR",
  );
  assert.equal(
    compareRunToAcceptedContract(
      {
        ...BOOTSTRAP_CONTRACT,
        launcherContractSha256: SHA_B,
      },
      receipt,
      request,
    ).status,
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
  const taskRoot = await mkdtemp(
    path.join(os.tmpdir(), "identity-bootstrap-task-"),
  );
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
  const attackRoot = await mkdtemp(
    path.join(os.tmpdir(), "identity-bootstrap-task-"),
  );
  t.after(() => rm(attackRoot, { recursive: true, force: true }));
  await symlink(os.tmpdir(), path.join(attackRoot, "scripts"));
  assert.equal(
    (
      await materializeAcceptedInstallInputs({
        repoRoot: root,
        subjectCommit: commit,
        taskRoot: attackRoot,
      })
    ).status,
    "INTEGRITY_ERROR",
  );
  assert.equal(
    (
      await materializeAcceptedInstallInputs({
        repoRoot: root,
        subjectCommit: commit,
        taskRoot: "relative",
      })
    ).status,
    "INTEGRITY_ERROR",
  );
  assert.equal(
    (await writeFile(
      path.join(root, ".pnpmfile.cjs"),
      "require('node:fs').writeFileSync(process.env.HOSTILE_MARKER, 'loaded')\n",
    ),
    await verifyBootstrapPreimage({
      repoRoot: root,
      subjectCommit: commit,
      acceptedAbsentPaths: [".pnpmfile.cjs"],
    })).status,
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
  const symlinkAncestorRoot = await mkdtemp(
    path.join(os.tmpdir(), "identity-bootstrap-root-ancestor-"),
  );
  t.after(() => rm(symlinkAncestorRoot, { recursive: true, force: true }));
  const escaped = await mkdtemp(
    path.join(os.tmpdir(), "identity-bootstrap-escaped-"),
  );
  t.after(() => rm(escaped, { recursive: true, force: true }));
  await symlink(escaped, path.join(symlinkAncestorRoot, ".bootstrap"));
  assert.equal(
    verifyDependencyAndToolRoots({
      taskRoot: symlinkAncestorRoot,
      environment: {},
    }).status,
    "INTEGRITY_ERROR",
  );
  const modulesAncestorRoot = await mkdtemp(
    path.join(os.tmpdir(), "identity-bootstrap-modules-ancestor-"),
  );
  t.after(() => rm(modulesAncestorRoot, { recursive: true, force: true }));
  await symlink(escaped, path.join(modulesAncestorRoot, "node_modules"));
  assert.equal(
    verifyDependencyAndToolRoots({
      taskRoot: modulesAncestorRoot,
      environment: {},
    }).status,
    "INTEGRITY_ERROR",
  );
  for (const rootName of [
    "store",
    "virtualStore",
    "modules",
    "cache",
    "config",
    "taskHome",
    "tmp",
    "declarations",
    "tools",
    "outputs",
  ]) {
    const rootWithSymlink = await mkdtemp(
      path.join(os.tmpdir(), `identity-bootstrap-${rootName}-`),
    );
    t.after(() => rm(rootWithSymlink, { recursive: true, force: true }));
    await symlink(escaped, path.join(rootWithSymlink, "linked"));
    assert.equal(
      verifyDependencyAndToolRoots({
        taskRoot: rootWithSymlink,
        roots: { [rootName]: path.join(rootWithSymlink, "linked", rootName) },
        environment: {},
      }).status,
      "INTEGRITY_ERROR",
      rootName,
    );
  }
});

test("plans exact clean pnpm and Prisma commands without loading hostile hooks", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "identity-bootstrap-hostile-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "marker");
  await writeFile(
    path.join(root, ".pnpmfile.cjs"),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded')\n`,
  );
  await writeFile(
    path.join(root, "preload.cjs"),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'preload')\n`,
  );
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
    "--config.store-dir",
    planned.roots.store,
    "--config.virtual-store-dir",
    planned.roots.virtualStore,
    "--config.modules-dir",
    planned.roots.modules,
    "--config.cache-dir",
    planned.roots.cache,
    "--config.globalconfig",
    path.join(planned.roots.config, "globalrc"),
    "--config.userconfig",
    "/dev/null",
  ]);
  assert.equal(planned.cwd, root);
  assert.equal(planned.environment.HOME, planned.roots.taskHome);
  assert.equal(planned.environment.XDG_CONFIG_HOME, planned.roots.config);
  assert.equal(planned.environment.XDG_CACHE_HOME, planned.roots.cache);
  assert.equal(planned.environment.TMPDIR, planned.roots.tmp);
  assert.equal(planned.environment.NPM_CONFIG_USERCONFIG, "/dev/null");
  assert.equal(Object.hasOwn(planned.environment, "NODE_OPTIONS"), false);
  assert.equal(Object.hasOwn(planned.environment, "NODE_PATH"), false);
  assert.equal(planned.hostileMarkerExecutionCount, 0);
  planned.roots.store = path.join(root, ".bootstrap", "store-drift");
  assert.equal(
    verifyDependencyAndToolRoots({
      taskRoot: root,
      roots: planned.roots,
      environment: planned.environment,
    }).status,
    "INTEGRITY_ERROR",
  );
  const driftedEnvironment = {
    ...planAcceptedBootstrapCommand({
      taskRoot: root,
      pnpmEntrypoint: "/opt/pnpm/bin/pnpm.cjs",
    }).environment,
    TMPDIR: path.join(root, ".bootstrap", "tmp-drift"),
  };
  assert.equal(
    verifyDependencyAndToolRoots({
      taskRoot: root,
      roots: planAcceptedBootstrapCommand({
        taskRoot: root,
        pnpmEntrypoint: "/opt/pnpm/bin/pnpm.cjs",
      }).roots,
      environment: driftedEnvironment,
    }).status,
    "INTEGRITY_ERROR",
  );
  assert.throws(
    () =>
      planAcceptedBootstrapCommand({
        taskRoot: "relative",
        pnpmEntrypoint: "/opt/pnpm/bin/pnpm.cjs",
      }),
    /BOOTSTRAP_COMMAND_REQUEST_INVALID/,
  );
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
  assert.throws(
    () =>
      runAcceptedPrismaGenerate({
        taskRoot: "relative",
        pnpmEntrypoint: "/opt/pnpm/bin/pnpm.cjs",
      }),
    /PRISMA_GENERATE_REQUEST_INVALID/,
  );
});

test("rehashes bootstrap after install before dynamic TypeScript scanner import", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "identity-bootstrap-rehash-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const bootstrap = path.join(root, "bootstrap.mjs");
  await writeFile(bootstrap, "export const ok = true;\n");
  await chmod(bootstrap, 0o600);
  const first = await verifyPostInstallBootstrapRehash({
    bootstrapPath: bootstrap,
    expectedSha256: sha(await readFile(bootstrap)),
  });
  assert.equal(first.status, "PASS", first.code);
  assert.equal(first.bootstrapRealpathSha256, sha(Buffer.from(bootstrap)));
  await writeFile(bootstrap, "export const ok = false;\n");
  const drift = await verifyPostInstallBootstrapRehash({
    bootstrapPath: bootstrap,
    expectedSha256: first.bootstrapSha256,
  });
  assert.equal(drift.status, "INTEGRITY_ERROR");
  const linked = path.join(root, "bootstrap-link.mjs");
  await symlink(bootstrap, linked);
  assert.equal(
    (
      await verifyPostInstallBootstrapRehash({
        bootstrapPath: linked,
        expectedSha256: first.bootstrapSha256,
      })
    ).status,
    "INTEGRITY_ERROR",
  );
  const ancestorTarget = await mkdtemp(
    path.join(os.tmpdir(), "identity-bootstrap-rehash-target-"),
  );
  t.after(() => rm(ancestorTarget, { recursive: true, force: true }));
  const ancestorRoot = await mkdtemp(
    path.join(os.tmpdir(), "identity-bootstrap-rehash-ancestor-"),
  );
  t.after(() => rm(ancestorRoot, { recursive: true, force: true }));
  await writeFile(path.join(ancestorTarget, "bootstrap.mjs"), "export {};\n");
  await symlink(ancestorTarget, path.join(ancestorRoot, "linked"));
  assert.equal(
    (
      await verifyPostInstallBootstrapRehash({
        bootstrapPath: path.join(ancestorRoot, "linked", "bootstrap.mjs"),
        expectedSha256: sha(
          await readFile(path.join(ancestorTarget, "bootstrap.mjs")),
        ),
      })
    ).status,
    "INTEGRITY_ERROR",
  );
  const scanner = path.join(root, "scanner.mjs");
  await writeFile(scanner, "export const loaded = 'scanner';\n");
  const loaded = await loadAcceptedScanner({
    modulePath: scanner,
    expectedSha256: sha(await readFile(scanner)),
  });
  assert.equal(loaded.status, "PASS", loaded.code);
  assert.equal(loaded.module.loaded, "scanner");
  assert.equal(
    (
      await loadAcceptedScanner({
        modulePath: scanner,
        expectedSha256: SHA,
      })
    ).status,
    "INTEGRITY_ERROR",
  );
  assert.equal(
    (
      await loadAcceptedScanner({
        modulePath: "relative",
        expectedSha256: SHA,
      })
    ).status,
    "INTEGRITY_ERROR",
  );
});

test("closed review verification rejects drift, duplicate severities, and failing verdicts", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "identity-bootstrap-review-"),
  );
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
    (await verifyReviewReceipt({ reportPath, receipt, subjectCommit: COMMIT }))
      .status,
    "PASS",
  );
  await writeFile(path.join(root, "receipt.json"), JSON.stringify(receipt));
  assert.equal(
    spawnSync(process.execPath, [
      bootstrapModulePath,
      "verify-review",
      "--report",
      path.relative(process.cwd(), reportPath),
      "--receipt",
      path.relative(process.cwd(), path.join(root, "receipt.json")),
      "--subject",
      COMMIT,
    ]).status,
    0,
  );
  assert.equal(
    (
      await verifyReviewReceipt({
        reportPath,
        receipt: { ...receipt, extra: true },
        subjectCommit: COMMIT,
      })
    ).status,
    "INTEGRITY_ERROR",
  );
  await writeFile(
    reportPath,
    "Critical: 0\nCritical: 0\nImportant: 0\nVerdict: PASS\n",
  );
  assert.equal(
    (await verifyReviewReceipt({ reportPath, receipt, subjectCommit: COMMIT }))
      .status,
    "INTEGRITY_ERROR",
  );
  assert.equal(
    spawnSync(process.execPath, [bootstrapModulePath, "unknown-command"])
      .status,
    1,
  );
});
