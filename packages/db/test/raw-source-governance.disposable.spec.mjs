// Test intent source-mined from tugjvnh@70885cdb; rewritten for current main.
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
const schemaMigrationName = "20260826090000_raw_source_governance_schema";
const backfillMigrationName = "20260826100000_raw_source_governance_backfill";
const constraintsMigrationName =
  "20260826110000_raw_source_governance_constraints";
const writerMigrationName = "20260826120000_raw_source_governance_writer";
const writerHardeningMigrationName =
  "20260826130000_raw_source_governance_writer_hardening";
const historicalCleanupMigrationName =
  "20260826140000_raw_source_governance_historical_cleanup";
const schemaMigrationPath = resolve(
  migrationRoot,
  schemaMigrationName,
  "migration.sql",
);
const backfillMigrationPath = resolve(
  migrationRoot,
  backfillMigrationName,
  "migration.sql",
);
const constraintsMigrationPath = resolve(
  migrationRoot,
  constraintsMigrationName,
  "migration.sql",
);
const writerMigrationPath = resolve(
  migrationRoot,
  writerMigrationName,
  "migration.sql",
);
const writerHardeningMigrationPath = resolve(
  migrationRoot,
  writerHardeningMigrationName,
  "migration.sql",
);
const historicalCleanupMigrationPath = resolve(
  migrationRoot,
  historicalCleanupMigrationName,
  "migration.sql",
);
const baselineLastMigration = "20260824130000_personal_artifact_cleanup";
const container = process.env.TASK6A_PG_CONTAINER;
const port = process.env.TASK6A_PG_PORT;
const databases = Object.freeze({
  fresh: "task6a_raw_fresh",
  upgrade: "task6a_raw_upgrade",
  rollback: "task6a_raw_rollback",
  backfillRollback: "task6a_raw_backfill_rollback",
  writerRollback: "task6a_raw_writer_rollback",
  writerHardeningRollback: "task6a_raw_writer_hardening_rollback",
  historicalCleanupRollback: "task6a_raw_history_cleanup_rollback",
  locks: "task6a_raw_locks",
});

const WORKSPACE_A = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_B = "10000000-0000-4000-8000-000000000002";
const RUN_A = "20000000-0000-4000-8000-000000000001";
const RUN_B = "20000000-0000-4000-8000-000000000002";
const SAFE_RAW_A = "30000000-0000-4000-8000-000000000001";
const RESTRICTED_RAW_A = "30000000-0000-4000-8000-000000000002";
const SAFE_RAW_B = "30000000-0000-4000-8000-000000000003";
const SOURCE = "40000000-0000-4000-8000-000000000001";
const FETCH = "50000000-0000-4000-8000-000000000001";
const SOURCE_ENTITY = "60000000-0000-4000-8000-000000000001";
const COMPANY_A = "70000000-0000-4000-8000-000000000001";
const LOCKED_RAW = "90000000-0000-4000-8000-000000000001";
const POLICY_A = "a0000000-0000-4000-8000-000000000001";
const POLICY_B = "a0000000-0000-4000-8000-000000000002";

let baselineDirectory;
let firstDeployOutput = "";
let secondDeployOutput = "";
let baselineDeployOutput = "";
let injectedRollbackOutput = "";
let injectedBackfillRollbackOutput = "";
let injectedWriterRollbackOutput = "";
let injectedWriterHardeningRollbackOutput = "";
let injectedHistoricalCleanupRollbackOutput = "";

function requireTopology() {
  assert.match(container ?? "", /^codex-task6a-raw-pg-[a-z0-9-]+$/u);
  assert.match(port ?? "", /^[1-9][0-9]{3,4}$/u);
}

function ownerUrl(database) {
  requireTopology();
  return `postgresql://global:global@127.0.0.1:${port}/${database}?schema=public`;
}

function dockerPsql(database, sql, options = {}) {
  requireTopology();
  const result = spawnSync(
    "docker",
    [
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
    ],
    {
      encoding: "utf8",
      input: sql,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (options.rejects) {
    assert.notEqual(result.status, 0, `SQL unexpectedly succeeded:\n${output}`);
    assert.match(output, options.rejects);
    return output;
  }
  assert.equal(result.status, 0, output);
  return result.stdout.trim();
}

function migrateDeploy(
  database,
  schemaPath = resolve(repositoryRoot, "packages/db/prisma/schema.prisma"),
) {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@global/db",
      "exec",
      "prisma",
      "migrate",
      "deploy",
      "--schema",
      schemaPath,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: ownerUrl(database) },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`;
}

function createBaselineMigrationTree() {
  const root = mkdtempSync(join(tmpdir(), "task6a-current-main-migrations-"));
  const prismaRoot = join(root, "prisma");
  const migrations = join(prismaRoot, "migrations");
  mkdirSync(migrations, { recursive: true, mode: 0o700 });
  cpSync(
    resolve(migrationRoot, "migration_lock.toml"),
    resolve(migrations, "migration_lock.toml"),
  );
  for (const entry of readdirSync(migrationRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name > baselineLastMigration) continue;
    cpSync(
      resolve(migrationRoot, entry.name),
      resolve(migrations, entry.name),
      { recursive: true },
    );
  }
  const schemaPath = resolve(prismaRoot, "schema.prisma");
  writeFileSync(
    schemaPath,
    [
      "datasource db {",
      '  provider = "postgresql"',
      '  url      = env("DATABASE_URL")',
      "}",
      "",
      "generator client {",
      '  provider = "prisma-client-js"',
      "}",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return { root, schemaPath };
}

function asApp(workspaceId, sql) {
  return `
    SET SESSION AUTHORIZATION app_user;
    BEGIN;
    SELECT set_config('app.current_workspace_id', '${workspaceId}', true);
    ${sql}
    COMMIT;
  `;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function ingestKeyForWriterPayload(payload) {
  if (typeof payload.externalId === "string" && payload.externalId) {
    return `external:${sha256(payload.externalId)}`;
  }
  if (
    payload.identifier &&
    typeof payload.identifier.scheme === "string" &&
    typeof payload.identifier.value === "string"
  ) {
    return `identity:${sha256(
      canonicalJson({
        scheme: payload.identifier.scheme.toLowerCase(),
        value: payload.identifier.value,
      }),
    )}`;
  }
  return `identity:${sha256(
    canonicalJson({
      country:
        typeof payload.country === "string"
          ? payload.country.toUpperCase()
          : undefined,
      domain:
        typeof payload.domain === "string"
          ? payload.domain.toLowerCase()
          : undefined,
      name:
        typeof payload.name === "string"
          ? payload.name.toLowerCase().replaceAll(/\s+/gu, " ")
          : undefined,
    }),
  )}`;
}

function writerCommand(overrides = {}) {
  const fetchedAt = overrides.fetchedAt ?? new Date().toISOString();
  const payload = overrides.payload ?? {
    externalId: overrides.externalId ?? "writer-a",
    name: "Writer A GmbH",
    domain: "writer-a.example",
    attributes: { products: ["pump"] },
    provenance: {
      sourceUrl: "https://registry.example/writer-a",
      fetchedAt,
      contentHash: "a".repeat(64),
      parserVersion: "registry/v2",
    },
  };
  return {
    schemaVersion: "raw-source-writer/v2",
    recordId: overrides.recordId ?? "82000000-0000-4000-8000-000000000001",
    workspaceId: overrides.workspaceId ?? WORKSPACE_A,
    runId: overrides.runId === undefined ? RUN_A : overrides.runId,
    sourceEntityId: overrides.sourceEntityId ?? null,
    providerKey: overrides.providerKey ?? "registry",
    sourceClass: overrides.sourceClass ?? "company_registry",
    externalId:
      overrides.commandExternalId === undefined
        ? (payload.externalId ?? null)
        : overrides.commandExternalId,
    payload,
    sourceUrl: payload.provenance?.sourceUrl ?? null,
    fetchedAt: payload.provenance?.fetchedAt ?? null,
    contentHash: payload.provenance?.contentHash ?? null,
    parserVersion: payload.provenance?.parserVersion ?? null,
    ingestKey: overrides.ingestKey ?? ingestKeyForWriterPayload(payload),
    ingestStatus: overrides.ingestStatus ?? "ACCEPTED",
    dispositionCode: overrides.dispositionCode ?? null,
    sourcePolicyId:
      overrides.sourcePolicyId === undefined
        ? POLICY_A
        : overrides.sourcePolicyId,
    retentionDays: overrides.retentionDays ?? 30,
    costCents: overrides.costCents ?? 0,
  };
}

function writerSql(command) {
  const encoded = JSON.stringify(command).replaceAll("'", "''");
  return `SELECT raw_record_id::text || '|' || payload_hash || '|' ||
    payload_bytes::text || '|' || ingest_status || '|' || inserted::text
    FROM write_raw_source_record_v2('${encoded}'::jsonb);`;
}

function seedCurrentMainClone(database = databases.upgrade) {
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
      '${POLICY_A}','registry.example','gov_registry','api','ALLOWS',
      'REVIEWED_OK',false,'["discovery"]',0,30,'APPROVED','backend',now(),now()
    );
    INSERT INTO workspace(id,name,created_at,updated_at) VALUES
      ('${WORKSPACE_A}','A',now(),now()),
      ('${WORKSPACE_B}','B',now(),now());
    INSERT INTO discovery_run(id,workspace_id,plan_id,icp_id,status,created_at) VALUES
      ('${RUN_A}','${WORKSPACE_A}',gen_random_uuid(),gen_random_uuid(),'RUNNING',now()),
      ('${RUN_B}','${WORKSPACE_B}',gen_random_uuid(),gen_random_uuid(),'RUNNING',now());
    INSERT INTO raw_source_record(
      id,workspace_id,run_id,provider_key,source_class,external_id,payload,
      source_url,fetched_at,content_hash,parser_version,cost_cents,created_at
    ) VALUES
      ('${SAFE_RAW_A}','${WORKSPACE_A}','${RUN_A}','registry','company_registry','safe-a',
       '{"name":"Safe A","domain":"safe-a.example"}',
       'https://registry.example/safe-a',now()-interval '2 days',repeat('a',64),'registry/v1',0,now()-interval '2 days'),
      ('${RESTRICTED_RAW_A}','${WORKSPACE_A}','${RUN_A}','usaspending_awards','public_intelligence','restricted-a',
       '{"name":"Unsafe A","attributes":{"procurement":{"recipient_name":"PERSON","description":"PERSONAL PROSE","query_match":true}}}',
       'https://api.usaspending.gov/awards',now()-interval '2 days',repeat('b',64),'usaspending/v1',0,now()-interval '2 days'),
      ('${SAFE_RAW_B}','${WORKSPACE_B}','${RUN_B}','registry','company_registry','safe-b',
       '{"name":"Safe B","domain":"safe-b.example"}',
       'https://registry.example/safe-b',now()-interval '2 days',repeat('c',64),'registry/v1',0,now()-interval '2 days');
    INSERT INTO canonical_company(
      id,workspace_id,name,domain,attributes,status,dedupe_key,version,created_at,updated_at
    ) VALUES (
      '${COMPANY_A}','${WORKSPACE_A}','Unsafe A',NULL,
      '{
        "products":["pump","person@example.test"],
        "gleif":{"lei":"529900SAFEENTITY001","legal_name":"Parker Hannifin"},
        "contact_email":"person@example.test",
        "owner_name":"alice van smith",
        "custom_payload":{"notes":"unbounded historical prose"}
      }',
      'NEW','n:unsafe a:',1,now(),now()
    );
    INSERT INTO monitored_source(
      id,provider_key,source_key,label,config,status,created_at,updated_at
    ) VALUES (
      '${SOURCE}','mapyourshow','fair:legacy','Legacy Fair',
      '{"host":"legacy.mapyourshow.com"}','ACTIVE',now(),now()
    );
    INSERT INTO source_fetch(
      id,source_id,status,total,parser_version,started_at,finished_at
    ) VALUES (
      '${FETCH}','${SOURCE}','DONE',1,'acquisition/v1',
      '2026-08-25T16:30:00Z','2026-08-25T16:31:00Z'
    );
    INSERT INTO source_entity(
      id,source_id,external_id,entity_kind,name,domain,country,cleaned,
      content_hash,first_seen_at,last_seen_at,miss_count,created_at,updated_at
    ) VALUES (
      '${SOURCE_ENTITY}','${SOURCE}','legacy-entity','company','Legacy GmbH',
      'legacy.example','DE',
      '{"products":["pump"],"email":"person@legacy.example","email_kind":"personal"}',
      repeat('d',64),'2026-08-25T16:31:00Z','2026-08-25T16:31:00Z',0,now(),now()
    );
    INSERT INTO identity_link(
      id,workspace_id,canonical_type,canonical_id,raw_record_id,match_rule,confidence,created_at
    ) VALUES
      (gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}','${SOURCE_ENTITY}','domain_exact',1,now()),
      (gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}','${RESTRICTED_RAW_A}','provider_id',1,now());
    INSERT INTO field_evidence(
      id,workspace_id,entity_type,entity_id,field,value,provider_key,raw_record_id,
      confidence,license,allowed_actions,fetched_at
    ) VALUES
      (
        gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}','name','"Legacy GmbH"',
        'mapyourshow','${SOURCE_ENTITY}',1,'public','["display","match"]','2026-08-25T16:31:00Z'
      ),
      (
        gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}','country','"DE"',
        'usaspending_awards','${RESTRICTED_RAW_A}',1,'public','["display"]','2026-08-25T16:31:00Z'
      ),
      (
        gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}','attributes',
        '{"products":["pump","person@example.test"],"owner_name":"alice van smith","custom_payload":{"notes":"unbounded historical prose"}}',
        'registry','${SAFE_RAW_A}',1,'public','["display","match"]','2026-08-25T16:31:00Z'
      ),
      (
        gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}','contact_email','"person@example.test"',
        'registry','${SAFE_RAW_A}',1,'public','["display","match"]','2026-08-25T16:31:00Z'
      );
  `,
  );
}

function openRowLock(database, rowId) {
  requireTopology();
  const child = spawn(
    "docker",
    [
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
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  child.stdin.write(`BEGIN;\nSELECT 'LOCKED:${rowId}'
    FROM raw_source_record WHERE id='${rowId}' FOR UPDATE;\n`);

  const ready = new Promise((resolveReady, rejectReady) => {
    let poll;
    const timeout = setTimeout(() => {
      clearInterval(poll);
      rejectReady(new Error(`row lock did not become ready:\n${output}`));
    }, 5_000);
    poll = setInterval(() => {
      if (!output.includes(`LOCKED:${rowId}`)) return;
      clearTimeout(timeout);
      clearInterval(poll);
      resolveReady();
    }, 10);
    child.once("exit", (code) => {
      if (output.includes(`LOCKED:${rowId}`)) return;
      clearTimeout(timeout);
      clearInterval(poll);
      rejectReady(new Error(`row-lock session exited ${code}:\n${output}`));
    });
  });

  const release = () =>
    new Promise((resolveRelease, rejectRelease) => {
      child.once("exit", (code) => {
        if (code === 0) resolveRelease();
        else
          rejectRelease(
            new Error(`row-lock release exited ${code}:\n${output}`),
          );
      });
      child.stdin.end("ROLLBACK;\n\\q\n");
    });
  return { ready, release };
}

before(() => {
  requireTopology();
  assert.equal(
    existsSync(schemaMigrationPath),
    true,
    `${schemaMigrationName} must exist`,
  );
  assert.equal(
    existsSync(backfillMigrationPath),
    true,
    `${backfillMigrationName} must exist`,
  );
  assert.equal(
    existsSync(constraintsMigrationPath),
    true,
    `${constraintsMigrationName} must exist`,
  );
  assert.equal(
    existsSync(writerMigrationPath),
    true,
    `${writerMigrationName} must exist`,
  );
  assert.equal(
    existsSync(writerHardeningMigrationPath),
    true,
    `${writerHardeningMigrationName} must exist`,
  );
  assert.equal(
    existsSync(historicalCleanupMigrationPath),
    true,
    `${historicalCleanupMigrationName} must exist`,
  );
  dockerPsql(
    "postgres",
    Object.values(databases)
      .map(
        (database) => `
    SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = '${database}' AND pid <> pg_backend_pid();
    DROP DATABASE IF EXISTS ${database};
    CREATE DATABASE ${database} OWNER global;
  `,
      )
      .join("\n"),
  );

  const baseline = createBaselineMigrationTree();
  baselineDirectory = baseline.root;

  firstDeployOutput = migrateDeploy(databases.fresh);
  secondDeployOutput = migrateDeploy(databases.fresh);

  baselineDeployOutput = migrateDeploy(databases.upgrade, baseline.schemaPath);
  assert.match(baselineDeployOutput, new RegExp(baselineLastMigration, "u"));
  assert.equal(
    dockerPsql(
      databases.upgrade,
      `SELECT current_database() || '|' || coalesce((
        SELECT string_agg(table_schema || '.' || table_name, ',' ORDER BY table_schema, table_name)
        FROM information_schema.tables
        WHERE table_name IN ('workspace', '_prisma_migrations')
      ), 'missing');`,
    ),
    `${databases.upgrade}|public._prisma_migrations,public.workspace`,
    baselineDeployOutput,
  );
  seedCurrentMainClone();
  migrateDeploy(databases.upgrade);

  migrateDeploy(databases.backfillRollback, baseline.schemaPath);
  seedCurrentMainClone(databases.backfillRollback);
  dockerPsql(
    databases.backfillRollback,
    readFileSync(schemaMigrationPath, "utf8"),
  );
  // The committed 1000 VALIDATE statements are the transactional integrity
  // gate after its DML. Inject only in-memory after that gate, before COMMIT.
  const injectedBackfill = readFileSync(backfillMigrationPath, "utf8").replace(
    /COMMIT;\s*$/u,
    "SELECT 1 / 0;\nCOMMIT;\n",
  );
  injectedBackfillRollbackOutput = dockerPsql(
    databases.backfillRollback,
    injectedBackfill,
    { rejects: /division by zero/u },
  );

  migrateDeploy(databases.writerRollback, baseline.schemaPath);
  for (const migrationPath of [
    schemaMigrationPath,
    backfillMigrationPath,
    constraintsMigrationPath,
  ]) {
    dockerPsql(databases.writerRollback, readFileSync(migrationPath, "utf8"));
  }
  const injectedWriter = readFileSync(writerMigrationPath, "utf8").replace(
    /COMMIT;\s*$/u,
    "SELECT 1 / 0;\nCOMMIT;\n",
  );
  injectedWriterRollbackOutput = dockerPsql(
    databases.writerRollback,
    injectedWriter,
    { rejects: /division by zero/u },
  );

  migrateDeploy(databases.writerHardeningRollback, baseline.schemaPath);
  for (const migrationPath of [
    schemaMigrationPath,
    backfillMigrationPath,
    constraintsMigrationPath,
    writerMigrationPath,
  ]) {
    dockerPsql(
      databases.writerHardeningRollback,
      readFileSync(migrationPath, "utf8"),
    );
  }
  const injectedWriterHardening = readFileSync(
    writerHardeningMigrationPath,
    "utf8",
  ).replace(/COMMIT;\s*$/u, "SELECT 1 / 0;\nCOMMIT;\n");
  injectedWriterHardeningRollbackOutput = dockerPsql(
    databases.writerHardeningRollback,
    injectedWriterHardening,
    { rejects: /division by zero/u },
  );

  migrateDeploy(databases.historicalCleanupRollback, baseline.schemaPath);
  seedCurrentMainClone(databases.historicalCleanupRollback);
  for (const migrationPath of [
    schemaMigrationPath,
    backfillMigrationPath,
    constraintsMigrationPath,
    writerMigrationPath,
    writerHardeningMigrationPath,
  ]) {
    dockerPsql(
      databases.historicalCleanupRollback,
      readFileSync(migrationPath, "utf8"),
    );
  }
  const injectedHistoricalCleanup = readFileSync(
    historicalCleanupMigrationPath,
    "utf8",
  ).replace(/COMMIT;\s*$/u, "SELECT 1 / 0;\nCOMMIT;\n");
  injectedHistoricalCleanupRollbackOutput = dockerPsql(
    databases.historicalCleanupRollback,
    injectedHistoricalCleanup,
    { rejects: /division by zero/u },
  );

  migrateDeploy(databases.locks);
  dockerPsql(
    databases.locks,
    `
    INSERT INTO data_provider(id,key,class,status,cost_per_call_cents,created_at)
      VALUES (gen_random_uuid(),'registry','company_registry','ENABLED',0,now());
    INSERT INTO source_policy(
      id,domain,source_type,access_mode,robots_status,terms_status,
      personal_data,allowed_purpose,crawl_delay_ms,retention_days,
      review_status,owner,created_at,updated_at
    ) VALUES (
      '${POLICY_A}','registry.example','gov_registry','api','ALLOWS',
      'REVIEWED_OK',false,'["discovery"]',0,30,'APPROVED','backend',now(),now()
    );
    INSERT INTO workspace(id,name,created_at,updated_at)
      VALUES ('${WORKSPACE_A}','Locks',now(),now());
    INSERT INTO discovery_run(id,workspace_id,plan_id,icp_id,status,created_at)
      VALUES ('${RUN_A}','${WORKSPACE_A}',gen_random_uuid(),gen_random_uuid(),'RUNNING',now());
    ${asApp(
      WORKSPACE_A,
      writerSql(
        writerCommand({
          recordId: LOCKED_RAW,
          externalId: "locked-a",
          fetchedAt: "2000-01-01T00:00:00.000Z",
          payload: {
            externalId: "locked-a",
            name: "Locked A GmbH",
            domain: "locked-a.example",
            attributes: { products: ["pump"] },
            provenance: {
              sourceUrl: "https://registry.example/locked-a",
              fetchedAt: "2000-01-01T00:00:00.000Z",
              contentHash: "a".repeat(64),
              parserVersion: "registry/v2",
            },
          },
        }),
      ),
    )}
  `,
  );

  migrateDeploy(databases.rollback, baseline.schemaPath);
  const injected = readFileSync(schemaMigrationPath, "utf8").replace(
    /COMMIT;\s*$/u,
    "SELECT 1 / 0;\nCOMMIT;\n",
  );
  injectedRollbackOutput = dockerPsql(databases.rollback, injected, {
    rejects: /division by zero/u,
  });
});

after(() => {
  if (baselineDirectory)
    rmSync(baselineDirectory, { recursive: true, force: true });
  if (container && port) {
    dockerPsql(
      "postgres",
      Object.values(databases)
        .map(
          (database) => `
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = '${database}' AND pid <> pg_backend_pid();
      DROP DATABASE IF EXISTS ${database};
    `,
        )
        .join("\n"),
    );
  }
});

describe("Raw Source current-lineage migrations on disposable PostgreSQL 16", () => {
  it("applies the entire migration lineage to a fresh database and is idempotent on second deploy", () => {
    assert.match(firstDeployOutput, new RegExp(schemaMigrationName, "u"));
    assert.match(firstDeployOutput, new RegExp(backfillMigrationName, "u"));
    assert.match(firstDeployOutput, new RegExp(constraintsMigrationName, "u"));
    assert.match(firstDeployOutput, new RegExp(writerMigrationName, "u"));
    assert.match(
      firstDeployOutput,
      new RegExp(writerHardeningMigrationName, "u"),
    );
    assert.match(
      firstDeployOutput,
      new RegExp(historicalCleanupMigrationName, "u"),
    );
    assert.match(secondDeployOutput, /No pending migrations to apply/u);
    assert.equal(
      dockerPsql(
        databases.fresh,
        `
      SELECT count(*) FROM "_prisma_migrations"
      WHERE migration_name IN (
        '${schemaMigrationName}','${backfillMigrationName}',
        '${constraintsMigrationName}','${writerMigrationName}',
        '${writerHardeningMigrationName}','${historicalCleanupMigrationName}'
      )
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL;
    `,
      ),
      "6",
    );
  });

  it("upgrades a fully migrated current-main clone without copying old PR migration names", () => {
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `
      SELECT last_seen_fetch_id::text FROM source_entity WHERE id='${SOURCE_ENTITY}';
    `,
      ),
      FETCH,
    );
    const bridge = JSON.parse(
      dockerPsql(
        databases.upgrade,
        `
      SELECT jsonb_build_object(
        'id',id,'sourceEntityId',source_entity_id,'runId',run_id,
        'ingestVersion',ingest_version,'ingestStatus',ingest_status,'payload',payload
      )::text
      FROM raw_source_record WHERE workspace_id='${WORKSPACE_A}'
        AND source_entity_id='${SOURCE_ENTITY}';
    `,
      ),
    );
    assert.equal(bridge.sourceEntityId, SOURCE_ENTITY);
    assert.equal(bridge.runId, null);
    assert.equal(bridge.ingestVersion, "raw-source/legacy-reference/v1");
    assert.equal(bridge.ingestStatus, "QUARANTINED");
    assert.equal(
      bridge.payload._rawReceipt,
      "raw-source/legacy-monitored-reference/v1",
    );
    assert.doesNotMatch(
      JSON.stringify(bridge.payload),
      /Legacy GmbH|person@legacy/u,
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `
      SELECT concat_ws('|',
        (SELECT raw_record_id::text FROM identity_link
          WHERE canonical_id='${COMPANY_A}' AND match_rule='domain_exact' LIMIT 1),
        (SELECT raw_record_id::text FROM field_evidence
          WHERE entity_id='${COMPANY_A}' AND field='name' LIMIT 1)
      );
    `,
      ),
      `${bridge.id}|${bridge.id}`,
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `
      SELECT count(*) FROM "_prisma_migrations"
      WHERE migration_name LIKE '20260812%raw_source_v2'
         OR migration_name LIKE '20260813%monitored_source_raw%'
         OR migration_name = '20260814120000_raw_source_governance_disposition';
    `,
      ),
      "0",
    );
  });

  it("cleans historical Canonical attributes and redacts unsafe FieldEvidence without deleting provenance rows", () => {
    assert.deepEqual(
      JSON.parse(
        dockerPsql(
          databases.upgrade,
          `SELECT attributes::text FROM canonical_company WHERE id='${COMPANY_A}';`,
        ),
      ),
      {
        gleif: {
          lei: "529900SAFEENTITY001",
          legal_name: "Parker Hannifin",
        },
        products: ["pump"],
      },
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT count(*) FROM field_evidence WHERE entity_id='${COMPANY_A}';`,
      ),
      "4",
    );
    const cleanedEvidence = JSON.parse(
      dockerPsql(
        databases.upgrade,
        `SELECT jsonb_agg(jsonb_build_object(
           'field',field,'value',value,'class',data_class,
           'actions',allowed_actions
         ) ORDER BY field)::text
         FROM field_evidence
         WHERE entity_id='${COMPANY_A}'
           AND field IN ('attributes','contact_email');`,
      ),
    );
    assert.equal(cleanedEvidence.length, 2);
    for (const evidence of cleanedEvidence) {
      assert.equal(
        evidence.value._historicalCleanup,
        "canonical-attribute-cleanup/v1",
      );
      assert.match(evidence.value.originalValueHash, /^[0-9a-f]{64}$/u);
      assert.equal(evidence.class, "red");
      assert.deepEqual(evidence.actions, []);
      assert.doesNotMatch(
        JSON.stringify(evidence.value),
        /person@example|alice van smith|unbounded historical prose/u,
      );
    }
    assert.equal(
      dockerPsql(
        databases.upgrade,
        asApp(
          WORKSPACE_A,
          `SELECT count(*) FROM field_evidence
           WHERE entity_id='${COMPANY_A}'
             AND value::text ~* '(person@example|alice van smith|unbounded historical prose)';`,
        ),
      ),
      `${WORKSPACE_A}\n0`,
    );
  });

  it("stores an immutable historical restriction with the exact Raw provenance snapshot", () => {
    const snapshot = JSON.parse(
      dockerPsql(
        databases.upgrade,
        `
      SELECT jsonb_build_object(
        'provider',d.provider_key,'runId',d.run_id,'hash',d.raw_payload_hash,
        'ingestVersion',d.raw_ingest_version,'rawCreatedAt',d.raw_created_at,
        'fields',d.detected_fields,'rawProvider',r.provider_key,
        'rawRunId',r.run_id,'rawHash',r.payload_hash,
        'rawIngestVersion',r.ingest_version,'rawCreated',r.created_at
      )::text
      FROM raw_source_governance_disposition d
      JOIN raw_source_record r
        ON r.workspace_id=d.workspace_id AND r.id=d.raw_record_id
      WHERE d.raw_record_id='${RESTRICTED_RAW_A}';
    `,
      ),
    );
    assert.equal(snapshot.provider, snapshot.rawProvider);
    assert.equal(snapshot.runId, snapshot.rawRunId);
    assert.equal(snapshot.hash, snapshot.rawHash);
    assert.equal(snapshot.ingestVersion, snapshot.rawIngestVersion);
    assert.equal(snapshot.rawCreatedAt, snapshot.rawCreated);
    assert.deepEqual(snapshot.fields, ["recipient_name", "description"]);
    dockerPsql(
      databases.upgrade,
      `UPDATE raw_source_governance_disposition SET actor='rewritten'
       WHERE raw_record_id='${RESTRICTED_RAW_A}';`,
      { rejects: /permanent and append-only/u },
    );
    dockerPsql(
      databases.upgrade,
      `DELETE FROM raw_source_governance_disposition
       WHERE raw_record_id='${RESTRICTED_RAW_A}';`,
      { rejects: /permanent and append-only/u },
    );
  });

  it("enforces workspace A/B/unset RLS and a composite workspace/run foreign key", () => {
    assert.equal(
      dockerPsql(
        databases.upgrade,
        asApp(
          WORKSPACE_A,
          `
      SELECT count(*) FROM raw_source_record WHERE id='${SAFE_RAW_A}';
    `,
        ),
      ),
      `${WORKSPACE_A}\n1`,
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        asApp(
          WORKSPACE_B,
          `
      SELECT count(*) FROM raw_source_record WHERE id='${SAFE_RAW_A}';
    `,
        ),
      ),
      `${WORKSPACE_B}\n0`,
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `
      SET SESSION AUTHORIZATION app_user;
      SELECT count(*) FROM raw_source_record WHERE id='${SAFE_RAW_A}';
    `,
      ),
      "0",
    );

    for (const legacyInsert of [
      `INSERT INTO raw_source_record(
        id,workspace_id,run_id,provider_key,source_class,external_id,payload,
        source_url,fetched_at,content_hash,parser_version,cost_cents,created_at
      ) VALUES (
        '81000000-0000-4000-8000-000000000001','${WORKSPACE_A}','${RUN_A}',
        'registry','company_registry','default-legacy','{"name":"Default Legacy"}',
        'https://registry.example/default-legacy',now(),repeat('a',64),'registry/v1',0,now()
      );`,
      `INSERT INTO raw_source_record(
        id,workspace_id,run_id,provider_key,source_class,external_id,payload,
        source_url,fetched_at,content_hash,parser_version,cost_cents,created_at,
        ingest_key,payload_hash,payload_bytes,ingest_version,ingest_status,
        retention_days,expires_at,source_policy_snapshot
      ) VALUES (
        '81000000-0000-4000-8000-000000000002','${WORKSPACE_A}','${RUN_A}',
        'registry','company_registry','explicit-legacy','{"name":"Explicit Legacy"}',
        'https://registry.example/explicit-legacy',now(),repeat('b',64),'registry/v1',0,now(),
        'external:${"c".repeat(64)}',repeat('d',64),32,'raw-source/v1','ACCEPTED',
        30,now()+interval '30 days','{"kind":"source_policy","retentionDays":30,"minimizedFields":[]}'
      );`,
      `INSERT INTO raw_source_record(
        id,workspace_id,run_id,provider_key,source_class,external_id,payload,
        source_url,fetched_at,content_hash,parser_version,cost_cents,created_at,
        ingest_key,payload_hash,payload_bytes,ingest_version,ingest_status,
        retention_days,expires_at,source_policy_snapshot
      ) VALUES (
        '81000000-0000-4000-8000-000000000004','${WORKSPACE_A}','${RUN_A}',
        'registry','company_registry','forged-v2','{"name":"Forged V2"}',
        'https://registry.example/forged-v2',now(),repeat('a',64),'registry/v2',0,now(),
        'external:${"9".repeat(64)}',repeat('0',64),1,'raw-source/v2','ACCEPTED',
        30,now()+interval '30 days','{"kind":"source_policy","id":"${POLICY_A}"}'
      );`,
    ]) {
      dockerPsql(databases.upgrade, asApp(WORKSPACE_A, legacyInsert), {
        rejects:
          /RAW_SOURCE_INSERT_V2_REQUIRED|raw-source\/v2|check constraint|permission denied/u,
      });
    }
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT count(*) FROM raw_source_record
         WHERE id IN (
           '81000000-0000-4000-8000-000000000001',
           '81000000-0000-4000-8000-000000000002',
           '81000000-0000-4000-8000-000000000004'
         );`,
      ),
      "0",
    );
    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        writerSql(
          writerCommand({
            recordId: "81000000-0000-4000-8000-000000000003",
            externalId: "safe-a",
            payload: {
              externalId: "safe-a",
              name: "Safe A GmbH",
              domain: "safe-a.example",
              attributes: { products: ["pump"] },
              provenance: {
                sourceUrl: "https://registry.example/safe-a-v2",
                fetchedAt: "2026-08-26T00:00:00.000Z",
                contentHash: "a".repeat(64),
                parserVersion: "registry/v2",
              },
            },
          }),
        ),
      ),
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT count(*) FROM raw_source_record
         WHERE run_id='${RUN_A}' AND provider_key='registry'
           AND external_id='safe-a' AND ingest_version='raw-source/v2';`,
      ),
      "1",
    );

    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        writerSql(
          writerCommand({
            recordId: "80000000-0000-4000-8000-000000000001",
            externalId: "new-a",
            payload: {
              externalId: "new-a",
              name: "New A GmbH",
              domain: "new-a.example",
              attributes: { products: ["pump"] },
              provenance: {
                sourceUrl: "https://registry.example/new-a",
                fetchedAt: "2000-01-01T00:00:00.000Z",
                contentHash: "e".repeat(64),
                parserVersion: "registry/v2",
              },
            },
          }),
        ),
      ),
    );
    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        writerSql(
          writerCommand({
            recordId: "80000000-0000-4000-8000-000000000003",
            externalId: "future-a",
            payload: {
              externalId: "future-a",
              name: "Future A GmbH",
              domain: "future-a.example",
              attributes: { products: ["pump"] },
              provenance: {
                sourceUrl: "https://registry.example/future-a",
                fetchedAt: new Date().toISOString(),
                contentHash: "a".repeat(64),
                parserVersion: "registry/v2",
              },
            },
          }),
        ),
      ),
    );
    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_B,
        writerSql(
          writerCommand({
            recordId: "80000000-0000-4000-8000-000000000002",
            workspaceId: WORKSPACE_B,
            runId: RUN_A,
            externalId: "cross-run",
          }),
        ),
      ),
      { rejects: /RAW_SOURCE_WRITER_RUN_BINDING_INVALID|foreign key/u },
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        asApp(
          WORKSPACE_A,
          `SELECT workspace_id::text
           FROM list_due_raw_retention_workspaces_v1(10, NULL);`,
        ),
      ),
      `${WORKSPACE_A}\n${WORKSPACE_A}`,
    );
  });

  it("admits only the direct app principal through the canonical writer and derives immutable receipt facts", () => {
    const valid = writerCommand({
      recordId: "83000000-0000-4000-8000-000000000001",
      externalId: "writer-valid",
    });
    const firstReceipt = dockerPsql(
      databases.upgrade,
      asApp(WORKSPACE_A, writerSql(valid)),
    )
      .split("\n")
      .at(-1);
    const [firstId, firstHash, firstBytes, firstStatus, firstInserted] =
      firstReceipt.split("|");
    assert.equal(firstId, valid.recordId);
    assert.match(firstHash, /^[0-9a-f]{64}$/u);
    assert.ok(Number(firstBytes) > 0);
    assert.equal(firstStatus, "ACCEPTED");
    assert.equal(firstInserted, "true");
    assert.equal(
      dockerPsql(databases.upgrade, asApp(WORKSPACE_A, writerSql(valid))),
      `${WORKSPACE_A}\n${valid.recordId}|${firstHash}|${firstBytes}|ACCEPTED|false`,
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT concat_ws('|',
           (payload_hash = '${firstHash}')::text,
           (payload_bytes = ${firstBytes})::text,
           source_policy_snapshot->>'id',
           source_policy_snapshot->>'domain',
           source_policy_snapshot->>'retentionDays',
           source_policy_snapshot->'allowedPurpose'->>0
         ) FROM raw_source_record WHERE id='${valid.recordId}';`,
      ),
      `true|true|${POLICY_A}|registry.example|30|discovery`,
    );

    dockerPsql(
      databases.upgrade,
      `INSERT INTO source_policy(
        id,domain,source_type,access_mode,robots_status,terms_status,
        personal_data,allowed_purpose,crawl_delay_ms,retention_days,
        review_status,owner,created_at,updated_at
      ) VALUES (
        '${POLICY_B}','other.example','gov_registry','api','ALLOWS',
        'REVIEWED_OK',false,'["discovery"]',0,30,'APPROVED','backend',now(),now()
      );`,
    );

    const mismatches = [
      [
        writerCommand({
          recordId: "83000000-0000-4000-8000-000000000002",
          commandExternalId: "forged-external-id",
        }),
        /RAW_SOURCE_WRITER_EXTERNAL_BINDING_INVALID/u,
      ],
      [
        writerCommand({
          recordId: "83000000-0000-4000-8000-000000000003",
          ingestKey: `external:${"5".repeat(64)}`,
        }),
        /RAW_SOURCE_WRITER_INGEST_KEY_INVALID/u,
      ],
      [
        writerCommand({
          recordId: "83000000-0000-4000-8000-000000000004",
          sourcePolicyId: POLICY_B,
        }),
        /RAW_SOURCE_WRITER_POLICY_BINDING_INVALID/u,
      ],
      [
        writerCommand({
          recordId: "83000000-0000-4000-8000-000000000005",
          providerKey: "missing-provider",
        }),
        /RAW_SOURCE_WRITER_PROVIDER_BINDING_INVALID/u,
      ],
    ];
    for (const [command, rejects] of mismatches) {
      dockerPsql(databases.upgrade, asApp(WORKSPACE_A, writerSql(command)), {
        rejects,
      });
    }
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT count(*) FROM raw_source_record
         WHERE id IN (
           '83000000-0000-4000-8000-000000000002',
           '83000000-0000-4000-8000-000000000003',
           '83000000-0000-4000-8000-000000000004',
           '83000000-0000-4000-8000-000000000005'
         );`,
      ),
      "0",
    );

    for (const deniedInvocation of [
      writerSql(valid),
      `SET SESSION AUTHORIZATION app_user; ${writerSql(valid)}`,
      `SET ROLE app_user;
       SELECT set_config('app.current_workspace_id','${WORKSPACE_A}',false);
       ${writerSql(valid)}`,
    ]) {
      dockerPsql(databases.upgrade, deniedInvocation, {
        rejects: /RAW_SOURCE_WRITER_DENIED|permission denied/u,
      });
    }
  });

  it("denies hostile app_user payload forgery, unbounded JSON, and immutable cost drift", () => {
    const base = writerCommand({
      recordId: "84000000-0000-4000-8000-000000000001",
      externalId: "hostile-base",
    });
    const overDeep = structuredClone(base.payload);
    let cursor = overDeep.attributes;
    for (let depth = 0; depth < 8; depth += 1) {
      cursor.nested = {};
      cursor = cursor.nested;
    }
    const tooManyNodes = structuredClone(base.payload);
    tooManyNodes.attributes.products = Array.from(
      { length: 300 },
      (_, index) => `pump-${index}`,
    );
    const hostile = [
      [
        writerCommand({
          recordId: "84000000-0000-4000-8000-000000000002",
          payload: { ...base.payload, secret_extension: "arbitrary object" },
        }),
        /RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID/u,
      ],
      [
        writerCommand({
          recordId: "84000000-0000-4000-8000-000000000003",
          externalId: "555-0100",
        }),
        /RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID/u,
      ],
      [
        writerCommand({
          recordId: "84000000-0000-4000-8000-000000000004",
          payload: {
            ...base.payload,
            identifier: { scheme: "registry-id", value: "555-0100" },
          },
        }),
        /RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID/u,
      ],
      [
        writerCommand({
          recordId: "84000000-0000-4000-8000-000000000005",
          payload: {
            ...base.payload,
            name: "Bearer secret",
          },
        }),
        /RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID/u,
      ],
      [
        writerCommand({
          recordId: "84000000-0000-4000-8000-000000000006",
          payload: {
            ...base.payload,
            provenance: {
              ...base.payload.provenance,
              sourceUrl: "https://registry.example/company/555-0100",
            },
          },
        }),
        /RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID/u,
      ],
      [
        writerCommand({
          recordId: "84000000-0000-4000-8000-000000000007",
          payload: {
            ...base.payload,
            provenance: {
              ...base.payload.provenance,
              sourceUrl: "https://registry.example/api%25255Fkey%25253Dsecret",
            },
          },
        }),
        /RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID/u,
      ],
      [
        writerCommand({
          recordId: "84000000-0000-4000-8000-000000000008",
          payload: {
            ...base.payload,
            name: `Acme ${"x".repeat(4 * 1024 * 1024)}`,
          },
        }),
        /RAW_SOURCE_WRITER_PAYLOAD_BOUNDS/u,
      ],
      [
        writerCommand({
          recordId: "84000000-0000-4000-8000-000000000009",
          payload: overDeep,
        }),
        /RAW_SOURCE_WRITER_PAYLOAD_BOUNDS/u,
      ],
      [
        writerCommand({
          recordId: "84000000-0000-4000-8000-000000000010",
          payload: tooManyNodes,
        }),
        /RAW_SOURCE_WRITER_PAYLOAD_BOUNDS/u,
      ],
      [
        writerCommand({
          recordId: "84000000-0000-4000-8000-000000000011",
          payload: {
            ...base.payload,
            identifier: { scheme: "fda-reg", value: "3004512345" },
          },
        }),
        /RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID/u,
      ],
    ];
    for (const [command, rejects] of hostile) {
      dockerPsql(databases.upgrade, asApp(WORKSPACE_A, writerSql(command)), {
        rejects,
      });
    }
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT count(*) FROM raw_source_record
         WHERE id::text LIKE '84000000-0000-4000-8000-%';`,
      ),
      "0",
    );

    const immutable = writerCommand({
      recordId: "84000000-0000-4000-8000-000000000012",
      externalId: "immutable-cost",
      costCents: 0,
    });
    dockerPsql(databases.upgrade, asApp(WORKSPACE_A, writerSql(immutable)));
    dockerPsql(
      databases.upgrade,
      asApp(WORKSPACE_A, writerSql({ ...immutable, costCents: 1 })),
      { rejects: /RAW_SOURCE_WRITER_DRIFT/u },
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT cost_cents FROM raw_source_record WHERE id='${immutable.recordId}';`,
      ),
      "0",
    );
  });

  it("requires an explicit discovery purpose and stores the effective purpose in the immutable snapshot", () => {
    const purposePolicies = [
      ["b0000000-0000-4000-8000-000000000001", "purpose-null.example", null],
      ["b0000000-0000-4000-8000-000000000002", "purpose-empty.example", []],
      [
        "b0000000-0000-4000-8000-000000000003",
        "purpose-malformed.example",
        "discovery",
      ],
      [
        "b0000000-0000-4000-8000-000000000004",
        "purpose-other.example",
        ["enrichment"],
      ],
    ];
    for (const [id, domain, allowedPurpose] of purposePolicies) {
      const encodedPurpose =
        allowedPurpose === null
          ? "NULL"
          : `'${JSON.stringify(allowedPurpose)}'::jsonb`;
      dockerPsql(
        databases.upgrade,
        `INSERT INTO source_policy(
          id,domain,source_type,access_mode,robots_status,terms_status,
          personal_data,allowed_purpose,crawl_delay_ms,retention_days,
          review_status,owner,created_at,updated_at
        ) VALUES (
          '${id}','${domain}','gov_registry','api','ALLOWS','REVIEWED_OK',
          false,${encodedPurpose},0,30,'APPROVED','backend',now(),now()
        );`,
      );
      const externalId = `purpose-${id.slice(-1)}`;
      const command = writerCommand({
        recordId: `85000000-0000-4000-8000-00000000000${id.slice(-1)}`,
        externalId,
        sourcePolicyId: id,
        payload: {
          externalId,
          name: "Purpose Test GmbH",
          domain: "purpose-test.example",
          attributes: { products: ["pump"] },
          provenance: {
            sourceUrl: `https://${domain}/company`,
            fetchedAt: "2026-08-26T00:00:00.000Z",
            contentHash: "a".repeat(64),
            parserVersion: "registry/v2",
          },
        },
      });
      dockerPsql(databases.upgrade, asApp(WORKSPACE_A, writerSql(command)), {
        rejects: /RAW_SOURCE_WRITER_POLICY_BINDING_INVALID/u,
      });
    }
  });

  it("persists PostgreSQL-authoritative digest and bytes for a real 1e-7 JSONB number", () => {
    const numericPolicy = "b0000000-0000-4000-8000-000000000010";
    dockerPsql(
      databases.upgrade,
      `INSERT INTO data_provider(id,key,class,status,cost_per_call_cents,created_at)
         VALUES (gen_random_uuid(),'public_web','public_intelligence','ENABLED',0,now());
       INSERT INTO source_policy(
         id,domain,source_type,access_mode,robots_status,terms_status,
         personal_data,allowed_purpose,crawl_delay_ms,retention_days,
         review_status,owner,created_at,updated_at
       ) VALUES (
         '${numericPolicy}','numeric.example','official_website','crawl',
         'ALLOWS','REVIEWED_OK',false,'["discovery"]',0,30,
         'APPROVED','backend',now(),now()
       );`,
    );
    const numeric = writerCommand({
      recordId: "86000000-0000-4000-8000-000000000001",
      runId: RUN_A,
      providerKey: "public_web",
      sourceClass: "public_intelligence",
      sourcePolicyId: numericPolicy,
      payload: {
        externalId: "numeric.example",
        name: "General Dynamics",
        domain: "numeric.example",
        attributes: {
          products: ["industrial pump"],
          keywords: ["industrial"],
          extraction_evidence_digest: "f".repeat(64),
          extraction_confidence: 1e-7,
          source_class: "public_intelligence",
        },
        provenance: {
          sourceUrl: "https://numeric.example/company",
          fetchedAt: "2026-08-26T00:00:00.000Z",
          contentHash: "e".repeat(64),
          parserVersion: "public-web/v1",
        },
      },
    });
    const receipt = dockerPsql(
      databases.upgrade,
      asApp(WORKSPACE_A, writerSql(numeric)),
    )
      .split("\n")
      .at(-1)
      .split("|");
    assert.equal(receipt[0], numeric.recordId);
    assert.match(receipt[1], /^[0-9a-f]{64}$/u);
    assert.ok(Number(receipt[2]) > 0);
    assert.equal(receipt[3], "ACCEPTED");
    assert.equal(receipt[4], "true");
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT concat_ws('|',
           (payload_hash='${receipt[1]}')::text,
           (payload_bytes=${receipt[2]})::text,
           payload #>> '{attributes,extraction_confidence}'
         ) FROM raw_source_record WHERE id='${numeric.recordId}';`,
      ),
      "true|true|0.0000001",
    );
  });

  it("prevents provenance rewrites and physical delete while allowing one-way minimal expiry", () => {
    for (const mutation of [
      "provider_key='rewritten'",
      `run_id='${RUN_B}'`,
      `source_entity_id='${SOURCE_ENTITY}'`,
      `payload_hash='${"1".repeat(64)}'`,
      `ingest_key='external:${"2".repeat(64)}'`,
      "ingest_version='raw-source/v999'",
      "created_at=created_at + interval '1 second'",
    ]) {
      dockerPsql(
        databases.upgrade,
        asApp(
          WORKSPACE_A,
          `UPDATE raw_source_record SET ${mutation}
           WHERE id='80000000-0000-4000-8000-000000000001';`,
        ),
        { rejects: /immutable|permission denied|raw-source\/v2/u },
      );
    }
    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        `UPDATE raw_source_record
         SET payload=jsonb_build_object(
             '_rawReceipt','raw-source/expired/v1',
             'previousStatus',ingest_status,
             'payloadHash',payload_hash,
             'payloadBytes',payload_bytes
           ), ingest_status='EXPIRED', expired_at=statement_timestamp()
         WHERE id='80000000-0000-4000-8000-000000000003';`,
      ),
      { rejects: /permission denied/u },
    );
    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        `
      DELETE FROM raw_source_record
      WHERE id='80000000-0000-4000-8000-000000000001';
    `,
      ),
      { rejects: /permission denied|physical deletion/u },
    );
    dockerPsql(
      databases.upgrade,
      `DELETE FROM raw_source_record
       WHERE id='80000000-0000-4000-8000-000000000001';`,
      { rejects: /physical deletion/u },
    );

    const expiredOutput = dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        `
      SELECT 'result:' || row_to_json(x)::text
      FROM expire_due_raw_source_records_v1(
        '${WORKSPACE_A}'::uuid,50,'infinity'::timestamptz
      ) x;
      SELECT 'row:' || jsonb_build_object(
          'status',ingest_status,'expiredAt',expired_at,'payload',payload,
          'payloadHash',payload_hash,'payloadBytes',payload_bytes
        )::text
      FROM raw_source_record WHERE id='80000000-0000-4000-8000-000000000001';
    `,
      ),
    );
    const outputLines = expiredOutput.split("\n");
    const resultLine = outputLines.find((line) => line.startsWith("result:"));
    const rowLine = outputLines.find((line) => line.startsWith("row:"));
    assert.ok(resultLine, expiredOutput);
    assert.ok(rowLine, expiredOutput);
    const result = JSON.parse(resultLine.slice("result:".length));
    const expired = JSON.parse(rowLine.slice("row:".length));
    assert.equal(result.expired, 1);
    assert.equal(expired.status, "EXPIRED");
    assert.equal(expired.payload._rawReceipt, "raw-source/expired/v1");
    assert.deepEqual(Object.keys(expired.payload).sort(), [
      "_rawReceipt",
      "payloadBytes",
      "payloadHash",
      "previousStatus",
    ]);
    assert.equal(expired.payload.payloadHash, expired.payloadHash);
    assert.equal(expired.payload.payloadBytes, expired.payloadBytes);
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT ingest_status || '|' || (expired_at IS NULL)::text
         FROM raw_source_record
         WHERE id='80000000-0000-4000-8000-000000000003';`,
      ),
      "ACCEPTED|true",
    );

    for (const deniedInvocation of [
      `SELECT * FROM expire_due_raw_source_records_v1(
        '${WORKSPACE_A}'::uuid,50,'infinity'::timestamptz);`,
      `SET SESSION AUTHORIZATION app_user;
       SELECT * FROM expire_due_raw_source_records_v1(
         '${WORKSPACE_A}'::uuid,50,'infinity'::timestamptz);`,
      `SET ROLE app_user;
       SELECT set_config('app.current_workspace_id','${WORKSPACE_A}',false);
       SELECT * FROM expire_due_raw_source_records_v1(
         '${WORKSPACE_A}'::uuid,50,'infinity'::timestamptz);`,
    ]) {
      dockerPsql(databases.upgrade, deniedInvocation, {
        rejects: /RAW_RETENTION_EXPIRE_DENIED|permission denied/u,
      });
    }

    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        `
      UPDATE raw_source_record SET ingest_status='ACCEPTED'
      WHERE id='80000000-0000-4000-8000-000000000001';
    `,
      ),
      { rejects: /immutable|one-way|permission denied/u },
    );
  });

  it("hides restricted Raw and rejects every explicit downstream identity/evidence write", () => {
    assert.equal(
      dockerPsql(
        databases.upgrade,
        asApp(
          WORKSPACE_A,
          `
      SELECT count(*) FROM raw_source_record WHERE id='${RESTRICTED_RAW_A}';
    `,
        ),
      ),
      `${WORKSPACE_A}\n0`,
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        asApp(
          WORKSPACE_A,
          `SELECT concat_ws('|',
             (SELECT count(*) FROM identity_link
               WHERE raw_record_id='${RESTRICTED_RAW_A}'),
             (SELECT count(*) FROM field_evidence
               WHERE raw_record_id='${RESTRICTED_RAW_A}')
           );`,
        ),
      ),
      `${WORKSPACE_A}\n0|0`,
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT concat_ws('|',
           (SELECT count(*) FROM identity_link
             WHERE raw_record_id='${RESTRICTED_RAW_A}'),
           (SELECT count(*) FROM field_evidence
             WHERE raw_record_id='${RESTRICTED_RAW_A}')
         );`,
      ),
      "1|1",
    );
    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        `
      INSERT INTO identity_link(
        id,workspace_id,canonical_type,canonical_id,raw_record_id,match_rule,confidence,created_at
      ) VALUES (
        gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}',
        '${RESTRICTED_RAW_A}','domain_exact',1,now()
      );
    `,
      ),
      { rejects: /restricted from downstream processing|row-level security/u },
    );
    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        `
      INSERT INTO field_evidence(
        id,workspace_id,entity_type,entity_id,field,value,provider_key,raw_record_id,
        confidence,license,allowed_actions,data_class,fetched_at
      ) VALUES (
        gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}','name','"Unsafe A"',
        'usaspending_awards','${RESTRICTED_RAW_A}',1,'public','["display"]','green',now()
      );
    `,
      ),
      { rejects: /restricted from downstream processing|row-level security/u },
    );
  });

  it("reports real SKIP LOCKED deferral and expires the row on the next run", async () => {
    const lock = openRowLock(databases.locks, LOCKED_RAW);
    await lock.ready;
    try {
      assert.equal(
        dockerPsql(
          databases.locks,
          asApp(
            WORKSPACE_A,
            `SELECT expired || '|' || deferred_for_conflict || '|' || has_more
             FROM expire_due_raw_source_records_v1(
               '${WORKSPACE_A}'::uuid,1,NULL
             );`,
          ),
        ),
        `${WORKSPACE_A}\n0|1|true`,
      );
    } finally {
      await lock.release();
    }

    assert.equal(
      dockerPsql(
        databases.locks,
        asApp(
          WORKSPACE_A,
          `SELECT expired || '|' || deferred_for_conflict || '|' || has_more
           FROM expire_due_raw_source_records_v1(
             '${WORKSPACE_A}'::uuid,1,NULL
           );`,
        ),
      ),
      `${WORKSPACE_A}\n1|0|false`,
    );
    assert.equal(
      dockerPsql(
        databases.locks,
        `SELECT ingest_status FROM raw_source_record WHERE id='${LOCKED_RAW}';`,
      ),
      "EXPIRED",
    );
  });

  it("rolls back post-backfill DML and every validation when the integrity gate fails before COMMIT", () => {
    assert.match(injectedBackfillRollbackOutput, /division by zero/u);
    assert.equal(
      dockerPsql(
        databases.backfillRollback,
        `SELECT concat_ws('|',
           (SELECT (last_seen_fetch_id IS NULL)::text FROM source_entity
             WHERE id='${SOURCE_ENTITY}'),
           (SELECT count(*) FROM raw_source_record
             WHERE source_entity_id='${SOURCE_ENTITY}'),
           (SELECT (payload_hash IS NULL)::text FROM raw_source_record
             WHERE id='${RESTRICTED_RAW_A}'),
           (SELECT count(*) FROM raw_source_governance_disposition),
           (SELECT raw_record_id::text FROM identity_link
             WHERE canonical_id='${COMPANY_A}' AND match_rule='domain_exact'),
           (SELECT raw_record_id::text FROM field_evidence
             WHERE entity_id='${COMPANY_A}' AND field='name')
         );`,
      ),
      `true|0|true|0|${SOURCE_ENTITY}|${SOURCE_ENTITY}`,
    );
    assert.equal(
      dockerPsql(
        databases.backfillRollback,
        `SELECT count(*)
         FROM pg_constraint
         WHERE conname IN (
           'raw_source_record_exactly_one_origin_check',
           'raw_source_record_ingest_status_check',
           'raw_source_record_v2_receipt_check',
           'raw_source_record_source_entity_id_fkey',
           'raw_source_record_workspace_run_fkey',
           'source_entity_last_seen_fetch_id_fkey',
           'source_entity_last_seen_fetch_fkey',
           'identity_link_workspace_raw_fkey',
           'field_evidence_workspace_raw_fkey'
         ) AND NOT convalidated;`,
      ),
      "9",
    );
  });

  it("rolls back the complete schema migration when a failure is injected before commit", () => {
    assert.match(injectedRollbackOutput, /division by zero/u);
    assert.equal(
      dockerPsql(
        databases.rollback,
        `
      SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='raw_source_record'
        AND column_name='ingest_version';
    `,
      ),
      "0",
    );
    assert.equal(
      dockerPsql(
        databases.rollback,
        `
      SELECT to_regclass('public.raw_source_governance_disposition') IS NULL;
    `,
      ),
      "t",
    );
    assert.equal(
      dockerPsql(
        databases.rollback,
        `
      SELECT count(*) FROM "_prisma_migrations"
      WHERE migration_name='${schemaMigrationName}';
    `,
      ),
      "0",
    );
  });

  it("rolls back writer functions and the INSERT revoke when 1200 fails before commit", () => {
    assert.match(injectedWriterRollbackOutput, /division by zero/u);
    assert.equal(
      dockerPsql(
        databases.writerRollback,
        `SELECT concat_ws('|',
          (to_regprocedure('write_raw_source_record_v2(jsonb)') IS NULL)::text,
          (to_regprocedure('raw_source_canonical_json_v1(jsonb)') IS NULL)::text,
          has_table_privilege('app_user','raw_source_record','INSERT')::text
        );`,
      ),
      "true|true|true",
    );
  });

  it("rolls back every 1300 writer hardening definition when failure is injected before COMMIT", () => {
    assert.match(injectedWriterHardeningRollbackOutput, /division by zero/u);
    assert.equal(
      dockerPsql(
        databases.writerHardeningRollback,
        `SELECT concat_ws('|',
          (to_regprocedure('raw_source_provider_payload_valid_v2(text,jsonb)') IS NULL)::text,
          (to_regprocedure('sanitize_canonical_company_attributes_v2(jsonb)') IS NULL)::text,
          (position('raw-source-writer/v1' in pg_get_functiondef(
            'write_raw_source_record_v2(jsonb)'::regprocedure
          )) > 0)::text,
          has_table_privilege('app_user','raw_source_record','INSERT')::text
        );`,
      ),
      "true|true|true|false",
    );
  });

  it("rolls back all 1400 historical cleanup DML without deleting evidence", () => {
    assert.match(injectedHistoricalCleanupRollbackOutput, /division by zero/u);
    assert.equal(
      dockerPsql(
        databases.historicalCleanupRollback,
        `SELECT concat_ws('|',
          (attributes ? 'contact_email')::text,
          (attributes ? 'custom_payload')::text,
          (attributes::text LIKE '%person@example.test%')::text,
          (SELECT count(*) FROM field_evidence WHERE entity_id='${COMPANY_A}'),
          (SELECT count(*) FROM field_evidence
             WHERE entity_id='${COMPANY_A}'
               AND value::text LIKE '%person@example.test%')
        ) FROM canonical_company WHERE id='${COMPANY_A}';`,
      ),
      "true|true|true|4|2",
    );
  });
});
