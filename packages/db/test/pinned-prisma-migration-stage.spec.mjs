import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const expandSuitePath = resolve(
  repositoryRoot,
  "packages/db/test/organization-identity-v2-expand.disposable.spec.mjs",
);
const backfillSuitePath = resolve(
  repositoryRoot,
  "packages/db/test/organization-identity-v2-legacy-link-backfill.disposable.spec.mjs",
);
const contractSuitePath = resolve(
  repositoryRoot,
  "packages/db/test/organization-identity-v2-contract.disposable.spec.mjs",
);
const resolverSuitePath = resolve(
  repositoryRoot,
  "packages/db/test/organization-identity-v2-resolver-command.disposable.spec.mjs",
);
const currentMigrationRoot = resolve(
  repositoryRoot,
  "packages/db/prisma/migrations",
);
const preExpandCommit = "e408ed0a95b8cbc098c3530fe7ae49b2036402f0";
const expandCommit = "3de138b66f9babb246173f1fcf04e94af49e632b";
const backfillCommit = "c17385c4674782c15972f48fd6cda02730ccb299";
const contractCommit = "400caab2f8d827cc012ee5f928e7af4d6a1d6e08";
const resolverCommit = "7789b5dc94b4f79e3b0d08c0098add492f584219";
const expandMigration = "20260829090000_organization_identity_v2_expand_ddl";
const backfillMigration =
  "20260829091000_organization_identity_v2_legacy_link_backfill_dml";
const contractMigration =
  "20260829092000_organization_identity_v2_contract_ddl";
const resolverMigration =
  "20260830090000_organization_identity_v2_resolver_command";
const resolverMigrationPath =
  `packages/db/prisma/migrations/${resolverMigration}/migration.sql`;
const resolverMigrationChecksum =
  "3cb5fe7ca22b3067b92d71ac25198c7ff14d08c08a0907343d84130bb0b7a882";
const forbiddenResolverMigrationChecksums = Object.freeze([
  "3bf6e58db819352ca0777380e9adb2fbf32ca9eeb311b91df696b569302da7af",
  "098aa285a17cdc6e5ea2c092cbfb31a57cd0ec3ed6db83b0c1221e9d86f55c6a",
  "6e4b5a3bf448c1debb2450eef648d81dcd4e468d6a4aa48adc409b2933e39d23",
  "8423589e72a6bc6ef6914819063b5d76999fd2ab24f9ff5252ec2b68590e70be",
  "18d5a9b535d79e7d92b0886379d240919fb9e8c40c039cb0efed3089100e3cd8",
  "fb6b377fc23704bd7057c8367fd9713f67f9923497552abf399f59cb5347826b",
  "0c716f1d5449b89d3ade64ce5cc1c7214a3b96303b3737a6e2681334581ba518",
  "8c5d07dc1d8d7bc4befef71a8a26a0744232c2b176faaf1162a4aed761da6c66",
  "7e101a1d13c31a2657ea84b19b82e3b855102db104393ee33a9bb8a6c5415972",
]);
const futureMigration = "20260830091000_organization_identity_v2_future_guard";
const currentMainLaterMigrations = Object.freeze([
  "20260830120000_governed_subject_relation_schema",
  "20260830121000_governed_subject_relation_append_attest",
  "20260830121500_execution_domain_ack_authority_first_lock",
  "20260830122000_governed_subject_relation_tombstone",
  "20260830130000_discovery_query_lineage_schema",
  "20260830130100_discovery_query_lineage_functions",
  "20260830130200_discovery_query_lineage_execution_outcome",
  "20260830130300_discovery_company_materialization_schema",
  "20260830130400_discovery_company_materialization_functions",
]);

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeStage(repository, migrationName, schemaLabel) {
  const prismaRoot = resolve(repository, "packages/db/prisma");
  const migrationRoot = resolve(prismaRoot, "migrations");
  const migrationDirectory = resolve(migrationRoot, migrationName);
  mkdirSync(migrationDirectory, { recursive: true, mode: 0o700 });
  if (!readdirSync(migrationRoot).includes("migration_lock.toml")) {
    writeFileSync(
      resolve(migrationRoot, "migration_lock.toml"),
      'provider = "postgresql"\n',
      { mode: 0o600 },
    );
  }
  writeFileSync(
    resolve(migrationDirectory, "migration.sql"),
    `SELECT '${migrationName}';\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    resolve(prismaRoot, "schema.prisma"),
    `// schema:${schemaLabel}\n`,
    { mode: 0o600 },
  );
  runGit(repository, ["add", "packages/db/prisma"]);
  runGit(repository, ["commit", "-m", `stage ${schemaLabel}`]);
  return runGit(repository, ["rev-parse", "HEAD"]).trim();
}

function createFutureMigrationRepository({ testHooks } = {}) {
  if (
    testHooks !== undefined &&
    (testHooks === null ||
      typeof testHooks !== "object" ||
      Array.isArray(testHooks) ||
      Object.keys(testHooks).length !== 1 ||
      typeof testHooks.afterMkdtemp !== "function")
  ) {
    throw new TypeError("testHooks must contain only an afterMkdtemp function");
  }
  const root = mkdtempSync(join(tmpdir(), "task6b-pinned-stage-fixture-"));
  try {
    testHooks?.afterMkdtemp(root);
    chmodSync(root, 0o700);
    runGit(root, ["init", "--quiet"]);
    runGit(root, ["config", "user.name", "Task 6B Test"]);
    runGit(root, ["config", "user.email", "task6b@example.invalid"]);

    const commits = Object.freeze({
      preExpand: writeStage(root, "20260829080000_fixture_base", "pre-expand"),
      expand: writeStage(root, expandMigration, "expand"),
      backfill: writeStage(root, backfillMigration, "backfill"),
      contract: writeStage(root, contractMigration, "contract"),
      resolver: writeStage(root, resolverMigration, "resolver"),
      future: writeStage(root, futureMigration, "future"),
    });
    return Object.freeze({ root, commits });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function migrationNames(stage) {
  return readdirSync(stage.migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function gitSchemaAt(repository, commit) {
  return runGit(repository, [
    "show",
    `${commit}:packages/db/prisma/schema.prisma`,
  ]);
}

async function loadMaterializer() {
  return import("./helpers/pinned-prisma-stage.mjs");
}

function taskDirectoryInventory(parent, prefix) {
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort();
}

describe("pinned Prisma migration stages", () => {
  it("statically rejects live migration enumeration and blacklist stages", () => {
    const sources = [
      readFileSync(expandSuitePath, "utf8"),
      readFileSync(backfillSuitePath, "utf8"),
      readFileSync(contractSuitePath, "utf8"),
      readFileSync(resolverSuitePath, "utf8"),
    ];
    const combined = sources.join("\n");

    for (const source of sources) {
      assert.doesNotMatch(source, /readdirSync\(migrationRoot/u);
      assert.doesNotMatch(source, /excludedMigrations/u);
      assert.doesNotMatch(source, /cpSync\(\s*resolve\(migrationRoot/u);
    }
    for (const commit of [
      preExpandCommit,
      expandCommit,
      backfillCommit,
      contractCommit,
    ]) {
      assert.match(combined, new RegExp(commit, "u"));
    }
    assert.match(combined, /materializePinnedPrismaStage/u);
  });

  it("pins the final resolver bytes to their exact last-change commit and forbids every superseded checksum", () => {
    assert.equal(
      runGit(repositoryRoot, [
        "log",
        "-1",
        "--format=%H",
        "--",
        resolverMigrationPath,
      ]).trim(),
      resolverCommit,
    );
    assert.equal(
      sha256(readFileSync(resolve(repositoryRoot, resolverMigrationPath))),
      resolverMigrationChecksum,
    );
    assert.equal(
      sha256(
        runGit(repositoryRoot, [
          "show",
          `${resolverCommit}:${resolverMigrationPath}`,
        ]),
      ),
      resolverMigrationChecksum,
    );

    const migrationCommits = runGit(repositoryRoot, [
      "log",
      "--format=%H",
      "--",
      resolverMigrationPath,
    ])
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean);
    const historicalChecksums = [
      ...new Set(
        migrationCommits.map((commit) =>
          sha256(
            runGit(repositoryRoot, [
              "show",
              `${commit}:${resolverMigrationPath}`,
            ]),
          ),
        ),
      ),
    ];
    assert.equal(historicalChecksums[0], resolverMigrationChecksum);
    assert.deepEqual(
      historicalChecksums.slice(1).sort(),
      [...forbiddenResolverMigrationChecksums].sort(),
    );
    assert.ok(
      !forbiddenResolverMigrationChecksums.includes(resolverMigrationChecksum),
    );
  });

  it("excludes an unknown future migration from every earlier stage and pairs schema with the same commit", async () => {
    const { materializePinnedPrismaStage } = await loadMaterializer();
    const fixture = createFutureMigrationRepository();
    const stages = [];
    try {
      for (const [name, commit, expectedMigrations, expectedSchema] of [
        [
          "pre-expand",
          fixture.commits.preExpand,
          ["20260829080000_fixture_base"],
          "// schema:pre-expand\n",
        ],
        [
          "expand",
          fixture.commits.expand,
          ["20260829080000_fixture_base", expandMigration],
          "// schema:expand\n",
        ],
        [
          "backfill",
          fixture.commits.backfill,
          ["20260829080000_fixture_base", expandMigration, backfillMigration],
          "// schema:backfill\n",
        ],
        [
          "contract",
          fixture.commits.contract,
          [
            "20260829080000_fixture_base",
            expandMigration,
            backfillMigration,
            contractMigration,
          ],
          "// schema:contract\n",
        ],
        [
          "resolver",
          fixture.commits.resolver,
          [
            "20260829080000_fixture_base",
            expandMigration,
            backfillMigration,
            contractMigration,
            resolverMigration,
          ],
          "// schema:resolver\n",
        ],
      ]) {
        const stage = materializePinnedPrismaStage({
          repositoryRoot: fixture.root,
          commit,
          prefix: `task6b-${name}-`,
        });
        stages.push(stage);
        assert.equal(stage.commit, commit);
        assert.equal(statSync(stage.root).mode & 0o777, 0o700);
        assert.deepEqual(migrationNames(stage), expectedMigrations);
        assert.ok(!migrationNames(stage).includes(futureMigration));
        assert.equal(readFileSync(stage.schemaPath, "utf8"), expectedSchema);
        assert.equal(
          readFileSync(stage.schemaPath, "utf8"),
          gitSchemaAt(fixture.root, commit),
        );
      }

      assert.equal(fixture.commits.future.length, 40);
      assert.ok(
        readdirSync(
          resolve(fixture.root, "packages/db/prisma/migrations"),
        ).includes(futureMigration),
      );
    } finally {
      for (const stage of stages) {
        rmSync(stage.root, { recursive: true, force: true });
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("materializes each reviewed real stage from its exact commit only", async () => {
    const { materializePinnedPrismaStage } = await loadMaterializer();
    const stages = [];
    try {
      for (const [name, commit] of [
        ["pre-expand", preExpandCommit],
        ["expand", expandCommit],
        ["backfill", backfillCommit],
        ["contract", contractCommit],
        ["resolver", resolverCommit],
      ]) {
        const stage = materializePinnedPrismaStage({
          repositoryRoot,
          commit,
          prefix: `task6b-real-${name}-`,
        });
        stages.push(stage);
        assert.equal(stage.commit, commit);
        assert.equal(
          readFileSync(stage.schemaPath, "utf8"),
          gitSchemaAt(repositoryRoot, commit),
        );
        assert.ok(!migrationNames(stage).includes(futureMigration));
      }

      assert.ok(!migrationNames(stages[0]).includes(expandMigration));
      assert.ok(!migrationNames(stages[0]).includes(backfillMigration));
      assert.ok(migrationNames(stages[1]).includes(expandMigration));
      assert.ok(!migrationNames(stages[1]).includes(backfillMigration));
      assert.ok(migrationNames(stages[2]).includes(expandMigration));
      assert.ok(migrationNames(stages[2]).includes(backfillMigration));
      assert.ok(!migrationNames(stages[2]).includes(contractMigration));
      assert.ok(migrationNames(stages[3]).includes(expandMigration));
      assert.ok(migrationNames(stages[3]).includes(backfillMigration));
      assert.ok(migrationNames(stages[3]).includes(contractMigration));
      assert.ok(!migrationNames(stages[3]).includes(resolverMigration));
      assert.ok(migrationNames(stages[4]).includes(expandMigration));
      assert.ok(migrationNames(stages[4]).includes(backfillMigration));
      assert.ok(migrationNames(stages[4]).includes(contractMigration));
      assert.ok(migrationNames(stages[4]).includes(resolverMigration));
      const mergedMigrationNames = readdirSync(currentMigrationRoot, {
        withFileTypes: true,
      })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      for (const migration of currentMainLaterMigrations) {
        assert.ok(mergedMigrationNames.includes(migration));
        assert.ok(!migrationNames(stages[4]).includes(migration));
      }
    } finally {
      for (const stage of stages) {
        rmSync(stage.root, { recursive: true, force: true });
      }
    }
  });

  it("removes only its exact materializer root after an injected post-mkdtemp failure", async () => {
    const { materializePinnedPrismaStage } = await loadMaterializer();
    const prefix = "task6b-cleanup-materializer-";
    const parent = resolve(repositoryRoot, "packages/db");
    const inventoryPrefix = `.${prefix}`;
    const before = taskDirectoryInventory(parent, inventoryPrefix);
    let unexpectedStage;

    try {
      assert.throws(() => {
        unexpectedStage = materializePinnedPrismaStage({
          repositoryRoot,
          commit: preExpandCommit,
          prefix,
          testHooks: {
            afterMkdtemp() {
              throw new Error("TEST_POST_MKDTEMP_MATERIALIZER_FAILURE");
            },
          },
        });
      }, /TEST_POST_MKDTEMP_MATERIALIZER_FAILURE/u);
      assert.deepEqual(taskDirectoryInventory(parent, inventoryPrefix), before);
    } finally {
      if (unexpectedStage?.root && existsSync(unexpectedStage.root)) {
        rmSync(unexpectedStage.root, { recursive: true, force: true });
      }
    }

    assert.deepEqual(taskDirectoryInventory(parent, inventoryPrefix), before);
  });

  it("removes only its exact fixture root after an injected post-mkdtemp failure", () => {
    const prefix = "task6b-pinned-stage-fixture-";
    const parent = tmpdir();
    const before = taskDirectoryInventory(parent, prefix);
    let unexpectedFixture;

    try {
      assert.throws(() => {
        unexpectedFixture = createFutureMigrationRepository({
          testHooks: {
            afterMkdtemp() {
              throw new Error("TEST_POST_MKDTEMP_FIXTURE_FAILURE");
            },
          },
        });
      }, /TEST_POST_MKDTEMP_FIXTURE_FAILURE/u);
      assert.deepEqual(taskDirectoryInventory(parent, prefix), before);
    } finally {
      if (unexpectedFixture?.root && existsSync(unexpectedFixture.root)) {
        rmSync(unexpectedFixture.root, { recursive: true, force: true });
      }
    }

    assert.deepEqual(taskDirectoryInventory(parent, prefix), before);
  });
});
