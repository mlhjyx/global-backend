import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
const baselineLastMigration = "20260824130000_personal_artifact_cleanup";
const container = process.env.TASK6A_PG_CONTAINER;
const port = process.env.TASK6A_PG_PORT;
const databases = Object.freeze({
  fresh: "task6a_raw_fresh",
  upgrade: "task6a_raw_upgrade",
  rollback: "task6a_raw_rollback",
});

const ORGANIZATION = "00000000-0000-4000-8000-000000000001";
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

let baselineDirectory;
let firstDeployOutput = "";
let secondDeployOutput = "";
let injectedRollbackOutput = "";

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

function seedCurrentMainClone() {
  dockerPsql(
    databases.upgrade,
    `
    INSERT INTO organization(id,name,created_at,updated_at)
      VALUES ('${ORGANIZATION}','Task 6A',now(),now());
    INSERT INTO workspace(id,organization_id,name,created_at,updated_at) VALUES
      ('${WORKSPACE_A}','${ORGANIZATION}','A',now(),now()),
      ('${WORKSPACE_B}','${ORGANIZATION}','B',now(),now());
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
      id,workspace_id,name,domain,status,dedupe_key,version,created_at,updated_at
    ) VALUES ('${COMPANY_A}','${WORKSPACE_A}','Unsafe A',NULL,'NEW','n:unsafe a:',1,now(),now());
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
    ) VALUES (gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}','${SOURCE_ENTITY}','domain_exact',1,now());
    INSERT INTO field_evidence(
      id,workspace_id,entity_type,entity_id,field,value,provider_key,raw_record_id,
      confidence,license,allowed_actions,fetched_at
    ) VALUES (
      gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A}','name','"Legacy GmbH"',
      'mapyourshow','${SOURCE_ENTITY}',1,'public','["display","match"]','2026-08-25T16:31:00Z'
    );
  `,
  );
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

  migrateDeploy(databases.upgrade, baseline.schemaPath);
  seedCurrentMainClone();
  migrateDeploy(databases.upgrade);

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
    assert.match(secondDeployOutput, /No pending migrations to apply/u);
    assert.equal(
      dockerPsql(
        databases.fresh,
        `
      SELECT count(*) FROM "_prisma_migrations"
      WHERE migration_name IN ('${schemaMigrationName}','${backfillMigrationName}')
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL;
    `,
      ),
      "2",
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
        (SELECT raw_record_id::text FROM identity_link WHERE canonical_id='${COMPANY_A}' LIMIT 1),
        (SELECT raw_record_id::text FROM field_evidence WHERE entity_id='${COMPANY_A}' LIMIT 1)
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
      `SET\nBEGIN\n${WORKSPACE_A}\n1\nCOMMIT`,
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
      `SET\nBEGIN\n${WORKSPACE_B}\n0\nCOMMIT`,
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `
      SET SESSION AUTHORIZATION app_user;
      SELECT count(*) FROM raw_source_record WHERE id='${SAFE_RAW_A}';
    `,
      ),
      "SET\n0",
    );

    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        `
      INSERT INTO raw_source_record(
        id,workspace_id,run_id,provider_key,source_class,external_id,payload,
        source_url,fetched_at,content_hash,parser_version,cost_cents,created_at,
        ingest_key,payload_hash,payload_bytes,ingest_version,ingest_status,
        disposition_code,retention_days,expires_at,expired_at,source_policy_snapshot
      ) VALUES (
        '80000000-0000-4000-8000-000000000001','${WORKSPACE_A}','${RUN_A}',
        'registry','company_registry','new-a','{"name":"New A"}',
        'https://registry.example/new-a',now(),repeat('e',64),'registry/v1',0,now(),
        'external:${"e".repeat(64)}',repeat('f',64),16,'raw-source/v2','ACCEPTED',
        NULL,30,now()-interval '1 minute',NULL,
        '{"kind":"source_policy","id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","domain":"registry.example","retentionDays":30,"reviewStatus":"APPROVED","updatedAt":"2026-08-25T00:00:00.000Z","minimizedFields":[]}'
      );
    `,
      ),
    );
    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_B,
        `
      INSERT INTO raw_source_record(
        id,workspace_id,run_id,provider_key,source_class,external_id,payload,
        source_url,fetched_at,content_hash,parser_version,cost_cents,created_at,
        ingest_key,payload_hash,payload_bytes,ingest_version,ingest_status,
        retention_days,expires_at,source_policy_snapshot
      ) VALUES (
        '80000000-0000-4000-8000-000000000002','${WORKSPACE_B}','${RUN_A}',
        'registry','company_registry','cross-run','{"name":"Cross"}',
        'https://registry.example/cross',now(),repeat('e',64),'registry/v1',0,now(),
        'external:${"d".repeat(64)}',repeat('c',64),16,'raw-source/v2','ACCEPTED',
        30,now()+interval '30 days','{"kind":"source_policy","retentionDays":30,"minimizedFields":[]}'
      );
    `,
      ),
      { rejects: /raw_source_record_workspace_run_fkey|foreign key/u },
    );
  });

  it("prevents provenance rewrites and physical delete while allowing one-way minimal expiry", () => {
    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        `
      UPDATE raw_source_record SET provider_key='rewritten'
      WHERE id='80000000-0000-4000-8000-000000000001';
    `,
      ),
      { rejects: /immutable|raw-source\/v2/u },
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

    const expired = JSON.parse(
      dockerPsql(
        databases.upgrade,
        asApp(
          WORKSPACE_A,
          `
      SELECT jsonb_build_object(
        'result',(SELECT row_to_json(x) FROM expire_due_raw_source_records_v1(
          '${WORKSPACE_A}'::uuid,50,statement_timestamp()
        ) x),
        'row',(SELECT jsonb_build_object(
          'status',ingest_status,'expiredAt',expired_at,'payload',payload,
          'payloadHash',payload_hash,'payloadBytes',payload_bytes
        ) FROM raw_source_record WHERE id='80000000-0000-4000-8000-000000000001')
      )::text;
    `,
        )
          .split("\n")
          .find((line) => line.startsWith("{")),
      ),
    );
    assert.equal(expired.result.expired, 1);
    assert.equal(expired.row.status, "EXPIRED");
    assert.equal(expired.row.payload._rawReceipt, "raw-source/expired/v1");
    assert.deepEqual(Object.keys(expired.row.payload).sort(), [
      "_rawReceipt",
      "payloadBytes",
      "payloadHash",
      "previousStatus",
    ]);
    assert.equal(expired.row.payload.payloadHash, expired.row.payloadHash);
    assert.equal(expired.row.payload.payloadBytes, expired.row.payloadBytes);

    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        `
      UPDATE raw_source_record SET ingest_status='ACCEPTED'
      WHERE id='80000000-0000-4000-8000-000000000001';
    `,
      ),
      { rejects: /immutable|one-way/u },
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
      `SET\nBEGIN\n${WORKSPACE_A}\n0\nCOMMIT`,
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
});
