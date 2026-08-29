import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const migrationRoot = resolve(repositoryRoot, "packages/db/prisma/migrations");
const schemaPath = resolve(repositoryRoot, "packages/db/prisma/schema.prisma");
const preExpandCommit = "e408ed0a95b8cbc098c3530fe7ae49b2036402f0";
const expandMigrationName =
  "20260829090000_organization_identity_v2_expand_ddl";
const backfillMigrationName =
  "20260829091000_organization_identity_v2_legacy_link_backfill_dml";
const backfillMigrationPath = resolve(
  migrationRoot,
  backfillMigrationName,
  "migration.sql",
);
const container = process.env.TASK6B_PG_CONTAINER;
const port = process.env.TASK6B_PG_PORT;
const databases = Object.freeze({
  fresh: "task6b_identity_dml_fresh",
  upgrade: "task6b_identity_dml_upgrade",
  failure: "task6b_identity_dml_failure",
  lock: "task6b_identity_dml_lock",
});

const WORKSPACE_A = "10000000-0000-4000-8000-000000000011";
const WORKSPACE_B = "10000000-0000-4000-8000-000000000012";
const RUN_A = "20000000-0000-4000-8000-000000000011";
const RUN_B = "20000000-0000-4000-8000-000000000012";
const RAW_A = "30000000-0000-4000-8000-000000000011";
const RAW_B = "30000000-0000-4000-8000-000000000012";
const COMPANY_A = "40000000-0000-4000-8000-000000000011";
const COMPANY_B = "40000000-0000-4000-8000-000000000012";
const CONTACT_A = "50000000-0000-4000-8000-000000000011";
const CONTACT_B = "50000000-0000-4000-8000-000000000012";
const LINK_COMPANY_A = "60000000-0000-4000-8000-000000000011";
const LINK_CONTACT_A = "60000000-0000-4000-8000-000000000012";
const LINK_COMPANY_B = "60000000-0000-4000-8000-000000000013";
const LINK_CONTACT_B = "60000000-0000-4000-8000-000000000014";
const DUPLICATE_LINK = "60000000-0000-4000-8000-000000000015";
const CONFLICT_A = "70000000-0000-4000-8000-000000000011";
const POLICY = "80000000-0000-4000-8000-000000000011";
const MISSING_TARGET = "90000000-0000-4000-8000-000000000011";

let preExpandTree;
let expandOnlyTree;
let topologyInventory;
let firstFreshDeployOutput = "";
let secondFreshDeployOutput = "";
let candidateUpgradeOutput = "";
let identityBefore = "";
let identityAfter = "";
let rawBefore = "";
let rawAfter = "";
let schemaBeforeResult;
let schemaAfterResult;
let backfillSql = "";

function requireTopology() {
  assert.equal(container, "codex-task6b-identity-pg-20260829-a");
  assert.equal(port, "55439");
}

function assertDatabase(database) {
  assert.ok(
    database === "postgres" || Object.values(databases).includes(database),
    `database outside Task 6B.1b scope: ${database}`,
  );
}

function ownerUrl(database) {
  requireTopology();
  assertDatabase(database);
  assert.notEqual(database, "postgres");
  return `postgresql://global:global@127.0.0.1:${port}/${database}?schema=public`;
}

function dockerPsqlArgs(database) {
  requireTopology();
  assertDatabase(database);
  return [
    "exec",
    "-i",
    container,
    "psql",
    "-U",
    "global",
    "-d",
    database,
    "--no-psqlrc",
    "-X",
    "-qAt",
    "-v",
    "ON_ERROR_STOP=1",
  ];
}

function dockerPsql(database, sql, options = {}) {
  const result = spawnSync("docker", dockerPsqlArgs(database), {
    encoding: "utf8",
    input: sql,
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (options.rejects) {
    assert.notEqual(result.status, 0, `SQL unexpectedly succeeded:\n${output}`);
    assert.match(output, options.rejects);
    return output;
  }
  assert.equal(result.status, 0, output);
  return result.stdout.trim();
}

function inspectExactTopology() {
  requireTopology();
  const result = spawnSync(
    "docker",
    [
      "inspect",
      "--format",
      "{{json .Config.Image}}\n{{json .NetworkSettings.Ports}}",
      container,
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, "");
  const [imageJson, portsJson, ...extra] = result.stdout.trim().split("\n");
  assert.deepEqual(extra, []);
  return Object.freeze({
    image: JSON.parse(imageJson),
    publishedPorts: JSON.parse(portsJson),
  });
}

function runPrisma(args, database) {
  const result = spawnSync(
    "pnpm",
    ["--filter", "@global/db", "exec", "prisma", ...args],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ...(database ? { DATABASE_URL: ownerUrl(database) } : {}),
      },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return Object.freeze({
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}\n${result.stderr}`.trim(),
  });
}

function migrateDeploy(database, candidateSchemaPath = schemaPath) {
  const result = runPrisma(
    ["migrate", "deploy", "--schema", candidateSchemaPath],
    database,
  );
  assert.equal(result.status, 0, result.output);
  return result.output;
}

function runPrismaDiff(database) {
  return runPrisma(
    [
      "migrate",
      "diff",
      "--script",
      "--from-url",
      ownerUrl(database),
      "--to-schema-datamodel",
      schemaPath,
    ],
    database,
  );
}

function readPreExpandSchema() {
  const result = spawnSync(
    "git",
    ["show", `${preExpandCommit}:packages/db/prisma/schema.prisma`],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, "");
  return result.stdout;
}

function createMigrationTree({ prefix, excludedMigrations, schema }) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const prismaRoot = join(root, "prisma");
  const migrations = join(prismaRoot, "migrations");
  mkdirSync(migrations, { recursive: true, mode: 0o700 });
  cpSync(
    resolve(migrationRoot, "migration_lock.toml"),
    resolve(migrations, "migration_lock.toml"),
  );
  for (const entry of readdirSync(migrationRoot, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      excludedMigrations.has(entry.name) ||
      !/^\d{14}_[a-z0-9_]+$/u.test(entry.name)
    ) {
      continue;
    }
    cpSync(
      resolve(migrationRoot, entry.name),
      resolve(migrations, entry.name),
      { recursive: true },
    );
  }
  const candidateSchemaPath = resolve(prismaRoot, "schema.prisma");
  writeFileSync(candidateSchemaPath, schema, { mode: 0o600 });
  return Object.freeze({ root, schemaPath: candidateSchemaPath });
}

function asApp(workspaceId, sql) {
  return `
    SET SESSION AUTHORIZATION app_user;
    BEGIN;
    DO $scope$ BEGIN
      PERFORM set_config('app.current_workspace_id', '${workspaceId}', true);
    END $scope$;
    ${sql}
    COMMIT;
  `;
}

function asOwner(workspaceId, sql) {
  return `
    BEGIN;
    DO $scope$ BEGIN
      PERFORM set_config('app.current_workspace_id', '${workspaceId}', true);
    END $scope$;
    ${sql}
    COMMIT;
  `;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function rawWriterCommand({
  workspaceId,
  runId,
  rawId,
  externalId,
  day,
  contentHashCharacter,
}) {
  const fetchedAt = `2026-08-${day}T00:00:00.000Z`;
  const payload = {
    externalId,
    name: `Legacy Identity ${day} GmbH`,
    domain: `legacy-identity-${day}.example`,
    attributes: { products: ["industrial pump"] },
    provenance: {
      sourceUrl: `https://registry.example/legacy-identity-${day}`,
      fetchedAt,
      contentHash: contentHashCharacter.repeat(64),
      parserVersion: "registry/v2",
    },
  };
  return {
    schemaVersion: "raw-source-writer/v2",
    recordId: rawId,
    workspaceId,
    runId,
    sourceEntityId: null,
    providerKey: "registry",
    sourceClass: "company_registry",
    externalId,
    payload,
    sourceUrl: payload.provenance.sourceUrl,
    fetchedAt,
    contentHash: payload.provenance.contentHash,
    parserVersion: payload.provenance.parserVersion,
    ingestKey: `external:${sha256(externalId)}`,
    ingestStatus: "ACCEPTED",
    dispositionCode: null,
    sourcePolicyId: POLICY,
    retentionDays: 30,
    costCents: 0,
  };
}

function writerSql(command) {
  const encoded = JSON.stringify(command).replaceAll("'", "''");
  return `SELECT raw_record_id::text FROM write_raw_source_record_v2('${encoded}'::jsonb);`;
}

function seedLegacyRows(database) {
  dockerPsql(
    database,
    `
    INSERT INTO data_provider(id,key,class,status,cost_per_call_cents,created_at)
    VALUES (gen_random_uuid(),'registry','company_registry','ENABLED',0,now());
    INSERT INTO source_policy(
      id,domain,source_type,access_mode,robots_status,terms_status,
      personal_data,allowed_purpose,crawl_delay_ms,retention_days,
      review_status,owner,created_at,updated_at
    ) VALUES (
      '${POLICY}','registry.example','gov_registry','api','ALLOWS',
      'REVIEWED_OK',false,'["discovery"]',0,30,'APPROVED','backend',now(),now()
    );
    INSERT INTO workspace(id,name,created_at,updated_at) VALUES
      ('${WORKSPACE_A}','Task 6B.1b A',now(),now()),
      ('${WORKSPACE_B}','Task 6B.1b B',now(),now());
    INSERT INTO discovery_run(id,workspace_id,plan_id,icp_id,status,created_at) VALUES
      ('${RUN_A}','${WORKSPACE_A}',gen_random_uuid(),gen_random_uuid(),'RUNNING',now()),
      ('${RUN_B}','${WORKSPACE_B}',gen_random_uuid(),gen_random_uuid(),'RUNNING',now());
    ${asOwner(
      WORKSPACE_A,
      `INSERT INTO canonical_company(
        id,workspace_id,name,domain,status,dedupe_key,version,created_at,updated_at
      ) VALUES (
        '${COMPANY_A}','${WORKSPACE_A}','Legacy A','legacy-a.example','NEW',
        'legacy-a',1,'2026-08-29T00:00:00Z','2026-08-29T00:00:00Z'
      );
      INSERT INTO canonical_contact(
        id,workspace_id,company_id,full_name,title,seniority,department,
        dedupe_key,created_at
      ) VALUES (
        '${CONTACT_A}','${WORKSPACE_A}','${COMPANY_A}','Ada A','CTO','c_level',
        'Engineering','legacy-contact-a','2026-08-29T00:10:00Z'
      );`,
    )}
    ${asOwner(
      WORKSPACE_B,
      `INSERT INTO canonical_company(
        id,workspace_id,name,domain,status,dedupe_key,version,created_at,updated_at
      ) VALUES (
        '${COMPANY_B}','${WORKSPACE_B}','Legacy B','legacy-b.example','NEW',
        'legacy-b',1,'2026-08-29T00:00:00Z','2026-08-29T00:00:00Z'
      );
      INSERT INTO canonical_contact(
        id,workspace_id,company_id,full_name,title,seniority,department,
        dedupe_key,created_at
      ) VALUES (
        '${CONTACT_B}','${WORKSPACE_B}','${COMPANY_B}','Bob B','COO','c_level',
        'Operations','legacy-contact-b','2026-08-29T00:10:00Z'
      );`,
    )}
    ${asApp(
      WORKSPACE_A,
      writerSql(
        rawWriterCommand({
          workspaceId: WORKSPACE_A,
          runId: RUN_A,
          rawId: RAW_A,
          externalId: "legacy-identity-a",
          day: "29",
          contentHashCharacter: "a",
        }),
      ),
    )}
    ${asApp(
      WORKSPACE_B,
      writerSql(
        rawWriterCommand({
          workspaceId: WORKSPACE_B,
          runId: RUN_B,
          rawId: RAW_B,
          externalId: "legacy-identity-b",
          day: "28",
          contentHashCharacter: "b",
        }),
      ),
    )}
    ${asApp(
      WORKSPACE_A,
      `INSERT INTO identity_link(
        id,workspace_id,canonical_type,canonical_id,raw_record_id,
        match_rule,confidence,created_at
      ) VALUES
        ('${LINK_COMPANY_A}','${WORKSPACE_A}','company','${COMPANY_A}',
         '${RAW_A}','domain_exact',0.875,'2026-08-29T01:01:01Z'),
        ('${LINK_CONTACT_A}','${WORKSPACE_A}','contact','${CONTACT_A}',
         '${RAW_A}','provider_id',0.625,'2026-08-29T01:02:02Z');`,
    )}
    ${asApp(
      WORKSPACE_B,
      `INSERT INTO identity_link(
        id,workspace_id,canonical_type,canonical_id,raw_record_id,
        match_rule,confidence,created_at
      ) VALUES
        ('${LINK_COMPANY_B}','${WORKSPACE_B}','company','${COMPANY_B}',
         '${RAW_B}','name_country',0.75,'2026-08-29T01:03:03Z'),
        ('${LINK_CONTACT_B}','${WORKSPACE_B}','contact','${CONTACT_B}',
         '${RAW_B}','provider_id',0.5,'2026-08-29T01:04:04Z');`,
    )}
  `,
  );
}

function identityOldColumnBytes(database) {
  return dockerPsql(
    database,
    `SELECT count(*)::text || E'\\n' || string_agg(
      encode(convert_to(concat_ws('|',
        id::text,workspace_id::text,canonical_type,canonical_id::text,
        raw_record_id::text,match_rule,confidence::text,
        to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS')
      ),'UTF8'),'hex'), E'\\n' ORDER BY id
    ) FROM identity_link;`,
  );
}

function rawBytes(database) {
  return dockerPsql(
    database,
    `SELECT count(*)::text || E'\\n' || string_agg(
      encode(convert_to(concat_ws('|',
        id::text,workspace_id::text,payload::text,payload_hash,
        payload_bytes::text,ingest_key,ingest_version,ingest_status,
        coalesce(disposition_code,''),source_policy_snapshot::text,
        to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS')
      ),'UTF8'),'hex'), E'\\n' ORDER BY id
    ) FROM raw_source_record WHERE id IN ('${RAW_A}','${RAW_B}');`,
  );
}

function allLifecycleNull(database, excludedId = null) {
  const exclusion = excludedId ? `AND id <> '${excludedId}'` : "";
  return dockerPsql(
    database,
    `SELECT count(*) FROM identity_link
     WHERE (status IS NOT NULL OR resolver_version IS NOT NULL
       OR input_hash IS NOT NULL OR conflict_id IS NOT NULL)
       ${exclusion};`,
  );
}

function expectBackfillFailure(database, expected) {
  assert.notEqual(
    backfillSql,
    "",
    "exact legacy IdentityLink DML migration is absent",
  );
  return dockerPsql(database, backfillSql, { rejects: expected });
}

function updateLink(database, linkId, assignment) {
  dockerPsql(
    database,
    `UPDATE identity_link SET ${assignment} WHERE id='${linkId}';`,
  );
}

function unsafeUpdateLink(database, linkId, assignment) {
  dockerPsql(
    database,
    `SET session_replication_role = replica;
     UPDATE identity_link SET ${assignment} WHERE id='${linkId}';
     SET session_replication_role = origin;`,
  );
}

function startCanonicalCompanyLockHolder(database) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("docker", dockerPsqlArgs(database), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let ready = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectPromise(
        new Error(`lock holder did not become ready:\n${stdout}\n${stderr}`),
      );
    }, 5000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!ready && stdout.includes("TASK6B_DML_LOCK_READY")) {
        ready = true;
        clearTimeout(timer);
        resolvePromise(Object.freeze({ child }));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!ready) rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!ready) {
        rejectPromise(
          new Error(
            `lock holder exited before ready (${code}):\n${stdout}\n${stderr}`,
          ),
        );
      }
    });
    child.stdin.write(`
      BEGIN;
      LOCK TABLE canonical_company IN ROW EXCLUSIVE MODE;
      SELECT 'TASK6B_DML_LOCK_READY';
    `);
  });
}

function releaseLockHolder(holder) {
  return new Promise((resolvePromise, rejectPromise) => {
    holder.child.once("error", rejectPromise);
    holder.child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`lock holder rollback exited ${code}`));
    });
    holder.child.stdin.end("ROLLBACK;\n");
  });
}

before(() => {
  requireTopology();
  topologyInventory = inspectExactTopology();
  assert.equal(
    dockerPsql(
      "postgres",
      "SELECT current_setting('server_version_num')::int >= 160000;",
    ),
    "t",
  );
  dockerPsql(
    "postgres",
    Object.values(databases)
      .map(
        (database) => `
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname='${database}' AND pid <> pg_backend_pid();
      DROP DATABASE IF EXISTS ${database};
      CREATE DATABASE ${database} OWNER global;
    `,
      )
      .join("\n"),
  );

  preExpandTree = createMigrationTree({
    prefix: "task6b-identity-dml-pre-expand-",
    excludedMigrations: new Set([expandMigrationName, backfillMigrationName]),
    schema: readPreExpandSchema(),
  });
  expandOnlyTree = createMigrationTree({
    prefix: "task6b-identity-dml-expand-only-",
    excludedMigrations: new Set([backfillMigrationName]),
    schema: readFileSync(schemaPath, "utf8"),
  });
  backfillSql = existsSync(backfillMigrationPath)
    ? readFileSync(backfillMigrationPath, "utf8")
    : "";

  firstFreshDeployOutput = migrateDeploy(databases.fresh);
  secondFreshDeployOutput = migrateDeploy(databases.fresh);

  for (const database of [
    databases.upgrade,
    databases.failure,
    databases.lock,
  ]) {
    migrateDeploy(database, preExpandTree.schemaPath);
    seedLegacyRows(database);
    migrateDeploy(database, expandOnlyTree.schemaPath);
  }

  identityBefore = identityOldColumnBytes(databases.upgrade);
  rawBefore = rawBytes(databases.upgrade);
  schemaBeforeResult = runPrismaDiff(databases.upgrade);
  candidateUpgradeOutput = migrateDeploy(databases.upgrade);
  schemaAfterResult = runPrismaDiff(databases.upgrade);
  identityAfter = identityOldColumnBytes(databases.upgrade);
  rawAfter = rawBytes(databases.upgrade);
});

after(() => {
  for (const tree of [preExpandTree, expandOnlyTree]) {
    if (tree?.root) rmSync(tree.root, { recursive: true, force: true });
  }
  if (container === "codex-task6b-identity-pg-20260829-a" && port === "55439") {
    dockerPsql(
      "postgres",
      Object.values(databases)
        .map(
          (database) => `
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname='${database}' AND pid <> pg_backend_pid();
        DROP DATABASE IF EXISTS ${database};
      `,
        )
        .join("\n"),
    );
  }
});

describe("Organization Identity v2 legacy IdentityLink DML on disposable PostgreSQL 16", () => {
  it("attests the controller-owned image, running container and exact loopback port", () => {
    assert.deepEqual(topologyInventory, {
      image: "pgvector/pgvector:pg16",
      publishedPorts: {
        "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55439" }],
      },
    });
  });

  it("deploys the exact DML with zero legacy links and makes the second deploy a ledger no-op", () => {
    assert.match(
      firstFreshDeployOutput,
      new RegExp(backfillMigrationName, "u"),
    );
    assert.match(secondFreshDeployOutput, /No pending migrations to apply/u);
    assert.equal(
      dockerPsql(
        databases.fresh,
        `SELECT concat_ws('|',
          (SELECT count(*) FROM identity_link),
          (SELECT count(*) FROM "_prisma_migrations"
           WHERE migration_name='${backfillMigrationName}'
             AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
        );`,
      ),
      "0|1",
    );
  });

  it("backfills valid A/B company and contact links once without changing old or Raw bytes", () => {
    assert.match(
      candidateUpgradeOutput,
      new RegExp(backfillMigrationName, "u"),
    );
    assert.equal(identityAfter, identityBefore);
    assert.equal(identityAfter.split("\n")[0], "4");
    assert.equal(rawAfter, rawBefore);
    assert.equal(rawAfter.split("\n")[0], "2");
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT concat_ws('|',
          count(*),
          count(*) FILTER (WHERE status='ACTIVE'),
          count(*) FILTER (WHERE resolver_version='identity-v1'),
          count(*) FILTER (WHERE input_hash='legacy'),
          count(*) FILTER (WHERE conflict_id IS NULL)
        ) FROM identity_link;`,
      ),
      "4|4|4|4|4",
    );
  });

  it("keeps the full Prisma schema diff byte-identical before and after DML", () => {
    assert.equal(schemaBeforeResult.status, 0, schemaBeforeResult.output);
    assert.equal(schemaAfterResult.status, 0, schemaAfterResult.output);
    assert.equal(schemaBeforeResult.stderr, "");
    assert.equal(schemaAfterResult.stderr, "");
    assert.equal(schemaAfterResult.stdout, schemaBeforeResult.stdout);
  });

  it("rolls back an unsupported canonical type before updating valid rows", () => {
    updateLink(
      databases.failure,
      LINK_COMPANY_A,
      "canonical_type='organization'",
    );
    try {
      expectBackfillFailure(databases.failure, /unsupported canonical_type/u);
      assert.equal(allLifecycleNull(databases.failure), "0");
    } finally {
      updateLink(databases.failure, LINK_COMPANY_A, "canonical_type='company'");
    }
  });

  it("rolls back missing and cross-workspace company targets before updating valid rows", () => {
    for (const target of [MISSING_TARGET, COMPANY_B]) {
      updateLink(databases.failure, LINK_COMPANY_A, `canonical_id='${target}'`);
      try {
        expectBackfillFailure(
          databases.failure,
          /missing or cross-workspace company target/u,
        );
        assert.equal(allLifecycleNull(databases.failure), "0");
      } finally {
        updateLink(
          databases.failure,
          LINK_COMPANY_A,
          `canonical_id='${COMPANY_A}'`,
        );
      }
    }
  });

  it("rolls back missing and cross-workspace contact targets before updating valid rows", () => {
    for (const target of [MISSING_TARGET, CONTACT_B]) {
      updateLink(databases.failure, LINK_CONTACT_A, `canonical_id='${target}'`);
      try {
        expectBackfillFailure(
          databases.failure,
          /missing or cross-workspace contact target/u,
        );
        assert.equal(allLifecycleNull(databases.failure), "0");
      } finally {
        updateLink(
          databases.failure,
          LINK_CONTACT_A,
          `canonical_id='${CONTACT_A}'`,
        );
      }
    }
  });

  it("rolls back missing and cross-workspace Raw targets despite the current FK", () => {
    for (const target of [MISSING_TARGET, RAW_B]) {
      unsafeUpdateLink(
        databases.failure,
        LINK_COMPANY_A,
        `raw_record_id='${target}'`,
      );
      try {
        expectBackfillFailure(
          databases.failure,
          /missing or cross-workspace raw target/u,
        );
        assert.equal(allLifecycleNull(databases.failure), "0");
      } finally {
        unsafeUpdateLink(
          databases.failure,
          LINK_COMPANY_A,
          `raw_record_id='${RAW_A}'`,
        );
      }
    }
  });

  it("rolls back duplicate canonical/raw bindings before updating valid rows", () => {
    dockerPsql(
      databases.failure,
      `INSERT INTO identity_link(
        id,workspace_id,canonical_type,canonical_id,raw_record_id,
        match_rule,confidence,created_at
      ) VALUES (
        '${DUPLICATE_LINK}','${WORKSPACE_A}','company','${COMPANY_A}',
        '${RAW_A}','duplicate-fixture',0.1,'2026-08-29T01:05:05Z'
      );`,
    );
    try {
      expectBackfillFailure(
        databases.failure,
        /duplicate canonical\/raw binding/u,
      );
      assert.equal(allLifecycleNull(databases.failure), "0");
    } finally {
      dockerPsql(
        databases.failure,
        `DELETE FROM identity_link WHERE id='${DUPLICATE_LINK}';`,
      );
    }
  });

  it("rolls back each partial status, resolver, input and conflict state", () => {
    dockerPsql(
      databases.failure,
      `INSERT INTO organization_identity_conflict(
        id,workspace_id,raw_record_id,conflict_type,fingerprint,status,
        revision,facts,created_at
      ) VALUES (
        '${CONFLICT_A}','${WORKSPACE_A}','${RAW_A}','LEGACY_PARTIAL',
        '${"c".repeat(64)}','OPEN',1,'{}','2026-08-29T02:00:00Z'
      );`,
    );
    const cases = [
      [LINK_COMPANY_A, "status='ACTIVE'", "status=NULL"],
      [
        LINK_CONTACT_A,
        "resolver_version='pre-release'",
        "resolver_version=NULL",
      ],
      [LINK_COMPANY_B, "input_hash='pre-release'", "input_hash=NULL"],
      [LINK_CONTACT_A, `conflict_id='${CONFLICT_A}'`, "conflict_id=NULL"],
    ];
    try {
      for (const [linkId, setup, reset] of cases) {
        updateLink(databases.failure, linkId, setup);
        try {
          expectBackfillFailure(
            databases.failure,
            /unexpected partial lifecycle state/u,
          );
          assert.equal(allLifecycleNull(databases.failure, linkId), "0");
        } finally {
          updateLink(databases.failure, linkId, reset);
        }
      }
    } finally {
      dockerPsql(
        databases.failure,
        `DELETE FROM organization_identity_conflict WHERE id='${CONFLICT_A}';`,
      );
    }
    assert.equal(allLifecycleNull(databases.failure), "0");
  });

  it("times out around five seconds on a second physical connection without partial updates", async () => {
    assert.notEqual(
      backfillSql,
      "",
      "exact legacy IdentityLink DML migration is absent",
    );
    const holder = await startCanonicalCompanyLockHolder(databases.lock);
    let failureOutput = "";
    let durationMs = 0;
    try {
      const startedAt = Date.now();
      failureOutput = dockerPsql(databases.lock, backfillSql, {
        rejects: /canceling statement due to lock timeout/u,
      });
      durationMs = Date.now() - startedAt;
      assert.equal(allLifecycleNull(databases.lock), "0");
    } finally {
      await releaseLockHolder(holder);
    }

    assert.match(failureOutput, /canceling statement due to lock timeout/u);
    assert.ok(
      durationMs >= 4000,
      `lock timeout fired too early: ${durationMs}ms`,
    );
    assert.ok(
      durationMs < 7000,
      `migration did not enforce the reviewed 5s lock bound: ${durationMs}ms`,
    );
  });
});
