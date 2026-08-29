// Test intent source-mined from tugjvnh@70885cdb; rewritten for current main.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
const migrationName = "20260829090000_organization_identity_v2_expand_ddl";
const migrationPath = resolve(migrationRoot, migrationName, "migration.sql");
const container = process.env.TASK6B_PG_CONTAINER;
const port = process.env.TASK6B_PG_PORT;
const databases = Object.freeze({
  fresh: "task6b_identity_fresh",
  upgrade: "task6b_identity_upgrade",
  rollback: "task6b_identity_rollback",
});

const WORKSPACE_A = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_B = "10000000-0000-4000-8000-000000000002";
const RUN_A = "20000000-0000-4000-8000-000000000001";
const RUN_B = "20000000-0000-4000-8000-000000000002";
const RAW_A = "30000000-0000-4000-8000-000000000001";
const RAW_B = "30000000-0000-4000-8000-000000000002";
const COMPANY_A = "40000000-0000-4000-8000-000000000001";
const COMPANY_A_ALIAS = "40000000-0000-4000-8000-000000000002";
const COMPANY_B = "40000000-0000-4000-8000-000000000003";
const COMPANY_B_ALIAS = "40000000-0000-4000-8000-000000000004";
const LEGACY_LINK_A = "50000000-0000-4000-8000-000000000001";
const POLICY = "60000000-0000-4000-8000-000000000001";
const IDENTIFIER_A = "70000000-0000-4000-8000-000000000001";
const IDENTIFIER_B = "70000000-0000-4000-8000-000000000002";
const CONFLICT_A = "80000000-0000-4000-8000-000000000001";
const CONFLICT_B = "80000000-0000-4000-8000-000000000002";
const PARTY_A = "90000000-0000-4000-8000-000000000001";
const PARTY_B = "90000000-0000-4000-8000-000000000002";
const DECISION_A = "a0000000-0000-4000-8000-000000000001";
const DECISION_B = "a0000000-0000-4000-8000-000000000002";
const MAPPING_A = "b0000000-0000-4000-8000-000000000001";
const MAPPING_B = "b0000000-0000-4000-8000-000000000002";
const REPLAY_A = "c0000000-0000-4000-8000-000000000001";
const REPLAY_B = "c0000000-0000-4000-8000-000000000002";

const tenantTables = Object.freeze([
  "organization_identifier",
  "organization_identity_conflict",
  "organization_identity_conflict_party",
  "organization_identity_decision",
  "organization_canonical_mapping",
  "organization_identity_replay",
]);
const enumNames = Object.freeze([
  "organization_identifier_status",
  "organization_identity_conflict_status",
  "organization_identity_decision_action",
  "organization_canonical_mapping_status",
  "organization_identity_replay_status",
  "identity_link_status",
]);

let baselineDirectory;
let firstDeployOutput = "";
let secondDeployOutput = "";
let baselineDeployOutput = "";
let candidateDeployOutput = "";
let injectedRollbackOutput = "";
let legacyIdentityBefore = "";
let legacyIdentityAfter = "";
let rawBefore = "";
let rawAfter = "";
let validateResult;
let generateResult;
let diffResult;

function requireTopology() {
  assert.equal(container, "codex-task6b-identity-pg-20260829-a");
  assert.equal(port, "55439");
}

function assertDatabase(database) {
  assert.ok(
    database === "postgres" || Object.values(databases).includes(database),
    `database outside Task 6B scope: ${database}`,
  );
}

function ownerUrl(database) {
  requireTopology();
  assertDatabase(database);
  assert.notEqual(database, "postgres");
  return `postgresql://global:global@127.0.0.1:${port}/${database}?schema=public`;
}

function dockerPsql(database, sql, options = {}) {
  requireTopology();
  assertDatabase(database);
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

function createBaselineMigrationTree() {
  const root = mkdtempSync(join(tmpdir(), "task6b-identity-current-main-"));
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
      entry.name === migrationName ||
      !/^\d{14}_[a-z0-9_]+$/u.test(entry.name)
    ) {
      continue;
    }
    cpSync(
      resolve(migrationRoot, entry.name),
      resolve(migrations, entry.name),
      {
        recursive: true,
      },
    );
  }
  const baselineSchemaPath = resolve(prismaRoot, "schema.prisma");
  writeFileSync(
    baselineSchemaPath,
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
  return { root, schemaPath: baselineSchemaPath };
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
    name: `Identity ${day} GmbH`,
    domain: `identity-${day}.example`,
    attributes: { products: ["industrial pump"] },
    provenance: {
      sourceUrl: `https://registry.example/identity-${day}`,
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

function seedCurrentMainClone(database) {
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
      ('${WORKSPACE_A}','Task 6B A',now(),now()),
      ('${WORKSPACE_B}','Task 6B B',now(),now());
    INSERT INTO discovery_run(id,workspace_id,plan_id,icp_id,status,created_at) VALUES
      ('${RUN_A}','${WORKSPACE_A}',gen_random_uuid(),gen_random_uuid(),'RUNNING',now()),
      ('${RUN_B}','${WORKSPACE_B}',gen_random_uuid(),gen_random_uuid(),'RUNNING',now());
    ${asOwner(
      WORKSPACE_A,
      `INSERT INTO canonical_company(
        id,workspace_id,name,domain,status,dedupe_key,version,created_at,updated_at
      ) VALUES
        ('${COMPANY_A}','${WORKSPACE_A}','Identity A','identity-a.example','NEW','identity-a',1,'2026-08-29T00:00:00Z','2026-08-29T00:00:00Z'),
        ('${COMPANY_A_ALIAS}','${WORKSPACE_A}','Identity A Alias',NULL,'NEW','identity-a-alias',1,'2026-08-29T00:00:00Z','2026-08-29T00:00:00Z');`,
    )}
    ${asOwner(
      WORKSPACE_B,
      `INSERT INTO canonical_company(
        id,workspace_id,name,domain,status,dedupe_key,version,created_at,updated_at
      ) VALUES
        ('${COMPANY_B}','${WORKSPACE_B}','Identity B','identity-b.example','NEW','identity-b',1,'2026-08-29T00:00:00Z','2026-08-29T00:00:00Z'),
        ('${COMPANY_B_ALIAS}','${WORKSPACE_B}','Identity B Alias',NULL,'NEW','identity-b-alias',1,'2026-08-29T00:00:00Z','2026-08-29T00:00:00Z');`,
    )}
    ${asApp(
      WORKSPACE_A,
      writerSql(
        rawWriterCommand({
          workspaceId: WORKSPACE_A,
          runId: RUN_A,
          rawId: RAW_A,
          externalId: "identity-a",
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
          externalId: "identity-b",
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
      ) VALUES (
        '${LEGACY_LINK_A}','${WORKSPACE_A}','company','${COMPANY_A}',
        '${RAW_A}','domain_exact',0.875,'2026-08-29T01:02:03Z'
      );`,
    )}
  `,
  );
}

function legacyIdentityBytes(database) {
  return dockerPsql(
    database,
    `SELECT encode(convert_to(concat_ws('|',
      id::text,workspace_id::text,canonical_type,canonical_id::text,
      raw_record_id::text,match_rule,confidence::text,
      to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS')
    ),'UTF8'),'hex') FROM identity_link WHERE id='${LEGACY_LINK_A}';`,
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

function seedExpandedRows(database) {
  for (const fixture of [
    {
      workspace: WORKSPACE_A,
      raw: RAW_A,
      company: COMPANY_A,
      alias: COMPANY_A_ALIAS,
      identifier: IDENTIFIER_A,
      conflict: CONFLICT_A,
      party: PARTY_A,
      decision: DECISION_A,
      mapping: MAPPING_A,
      replay: REPLAY_A,
      fingerprint: "a".repeat(64),
      inputHash: "1".repeat(64),
      value: "DE-A-100",
      request: "task6b-a",
    },
    {
      workspace: WORKSPACE_B,
      raw: RAW_B,
      company: COMPANY_B,
      alias: COMPANY_B_ALIAS,
      identifier: IDENTIFIER_B,
      conflict: CONFLICT_B,
      party: PARTY_B,
      decision: DECISION_B,
      mapping: MAPPING_B,
      replay: REPLAY_B,
      fingerprint: "b".repeat(64),
      inputHash: "2".repeat(64),
      value: "DE-B-200",
      request: "task6b-b",
    },
  ]) {
    dockerPsql(
      database,
      asOwner(
        fixture.workspace,
        `
        INSERT INTO organization_identity_conflict(
          id,workspace_id,raw_record_id,conflict_type,fingerprint,status,
          revision,facts,created_at
        ) VALUES (
          '${fixture.conflict}','${fixture.workspace}','${fixture.raw}',
          'AUTHORITY_COLLISION','${fixture.fingerprint}','OPEN',1,
          '{"schemaVersion":"organization-identity-conflict/v1"}',
          '2026-08-29T02:00:00Z'
        );
        INSERT INTO organization_identifier(
          id,workspace_id,company_id,scheme,jurisdiction,normalized_value,
          authority_provider_key,raw_record_id,conflict_id,confidence,
          normalizer_version,validator_version,provenance,status,
          first_seen_at,last_seen_at,created_at
        ) VALUES (
          '${fixture.identifier}','${fixture.workspace}','${fixture.company}',
          'registry-id','DE','${fixture.value}','registry','${fixture.raw}',NULL,
          1,'registry-id/v1','registry-id/v1',
          '{"schemaVersion":"organization-identifier-provenance/v1"}',
          'ACTIVE','2026-08-29T02:00:00Z','2026-08-29T02:00:00Z',
          '2026-08-29T02:00:00Z'
        );
        INSERT INTO organization_identity_conflict_party(
          id,workspace_id,conflict_id,company_id,role,created_at
        ) VALUES (
          '${fixture.party}','${fixture.workspace}','${fixture.conflict}',
          '${fixture.company}','CLAIMANT','2026-08-29T02:00:00Z'
        );
        INSERT INTO organization_identity_decision(
          id,workspace_id,conflict_id,action,canonical_company_id,request_id,
          expected_revision,request_precondition_etag,reason_code,note,
          decided_by,decision_hash,fact_snapshot,created_at
        ) VALUES (
          '${fixture.decision}','${fixture.workspace}','${fixture.conflict}',
          'MERGE','${fixture.company}','${fixture.request}',1,
          '"organization-identity-conflict:${fixture.conflict}:1"',
          'AUTHORITY_MATCH',NULL,'identity-decision-service',
          '${fixture.inputHash}','{"revision":1}','2026-08-29T02:00:00Z'
        );
        INSERT INTO organization_canonical_mapping(
          id,workspace_id,source_company_id,canonical_company_id,status,
          revision,merge_decision_id,split_decision_id,created_at,revoked_at
        ) VALUES (
          '${fixture.mapping}','${fixture.workspace}','${fixture.alias}',
          '${fixture.company}','ACTIVE',1,'${fixture.decision}',NULL,
          '2026-08-29T02:00:00Z',NULL
        );
        INSERT INTO organization_identity_replay(
          id,workspace_id,decision_id,status,attempt,input_hash,output_hash,
          error_code,created_at,updated_at,completed_at
        ) VALUES (
          '${fixture.replay}','${fixture.workspace}','${fixture.decision}',
          'PENDING',0,'${fixture.inputHash}',NULL,NULL,
          '2026-08-29T02:00:00Z','2026-08-29T02:00:00Z',NULL
        );
      `,
      ),
    );
  }
}

function expectSqlReject(database, sql, expected) {
  return dockerPsql(database, sql, { rejects: expected });
}

before(() => {
  requireTopology();
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

  const baseline = createBaselineMigrationTree();
  baselineDirectory = baseline.root;

  firstDeployOutput = migrateDeploy(databases.fresh);
  secondDeployOutput = migrateDeploy(databases.fresh);

  baselineDeployOutput = migrateDeploy(databases.upgrade, baseline.schemaPath);
  seedCurrentMainClone(databases.upgrade);
  legacyIdentityBefore = legacyIdentityBytes(databases.upgrade);
  rawBefore = rawBytes(databases.upgrade);
  candidateDeployOutput = migrateDeploy(databases.upgrade);
  legacyIdentityAfter = legacyIdentityBytes(databases.upgrade);
  rawAfter = rawBytes(databases.upgrade);

  migrateDeploy(databases.rollback, baseline.schemaPath);
  if (existsSync(migrationPath)) {
    const injected = readFileSync(migrationPath, "utf8").replace(
      /COMMIT;\s*$/u,
      "SELECT 1 / 0;\nCOMMIT;\n",
    );
    assert.notEqual(injected, readFileSync(migrationPath, "utf8"));
    injectedRollbackOutput = expectSqlReject(
      databases.rollback,
      injected,
      /division by zero/u,
    );
  } else {
    injectedRollbackOutput = "MIGRATION_MISSING";
  }

  validateResult = runPrisma(
    ["validate", "--schema", schemaPath],
    databases.fresh,
  );
  generateResult = runPrisma(
    ["generate", "--schema", schemaPath],
    databases.fresh,
  );
  diffResult = runPrisma(
    [
      "migrate",
      "diff",
      "--exit-code",
      "--from-url",
      ownerUrl(databases.fresh),
      "--to-schema-datamodel",
      schemaPath,
    ],
    databases.fresh,
  );
});

after(() => {
  if (baselineDirectory) {
    rmSync(baselineDirectory, { recursive: true, force: true });
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

describe("Organization Identity v2 expand DDL on disposable PostgreSQL 16", () => {
  it("applies the full migration lineage to a fresh database and is a no-op on second deploy", () => {
    assert.match(firstDeployOutput, new RegExp(migrationName, "u"));
    assert.match(secondDeployOutput, /No pending migrations to apply/u);
    assert.equal(
      dockerPsql(
        databases.fresh,
        `SELECT count(*) FROM "_prisma_migrations"
         WHERE migration_name='${migrationName}'
           AND finished_at IS NOT NULL AND rolled_back_at IS NULL;`,
      ),
      "1",
    );
  });

  it("upgrades the exact current-main baseline without mutating legacy IdentityLink or Raw bytes", () => {
    assert.match(
      baselineDeployOutput,
      /20260826250000_raw_source_ted_identifier_contact_gate/u,
    );
    assert.match(candidateDeployOutput, new RegExp(migrationName, "u"));
    assert.equal(legacyIdentityAfter, legacyIdentityBefore);
    assert.equal(rawAfter, rawBefore);
    assert.equal(rawAfter.split("\n")[0], "2");
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT concat_ws('|',
          (status IS NULL)::text,
          (resolver_version IS NULL)::text,
          (input_hash IS NULL)::text,
          (conflict_id IS NULL)::text
        ) FROM identity_link WHERE id='${LEGACY_LINK_A}';`,
      ),
      "true|true|true|true",
    );
  });

  it("creates exactly the six identity enums/tables and no Provider Quality or heartbeat residue", () => {
    assert.deepEqual(
      dockerPsql(
        databases.fresh,
        `SELECT typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
         WHERE n.nspname='public' AND typname IN (${enumNames
           .map((name) => `'${name}'`)
           .join(",")}) ORDER BY typname;`,
      ).split("\n"),
      [...enumNames].sort(),
    );
    assert.deepEqual(
      dockerPsql(
        databases.fresh,
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema='public' AND table_name IN (${tenantTables
           .map((name) => `'${name}'`)
           .join(",")}) ORDER BY table_name;`,
      ).split("\n"),
      [...tenantTables].sort(),
    );
    assert.equal(
      dockerPsql(
        databases.fresh,
        `SELECT concat_ws('|',
          (to_regclass('public.provider_quality_run_contribution') IS NULL)::text,
          (to_regclass('public.runtime_component_heartbeat') IS NULL)::text,
          (to_regprocedure('enforce_organization_mapping_root()') IS NULL)::text,
          (to_regprocedure('reject_organization_identity_delete()') IS NULL)::text
        );`,
      ),
      "true|true|true|true",
    );
  });

  it("creates the exact enum values", () => {
    assert.equal(
      dockerPsql(
        databases.fresh,
        `SELECT concat_ws('|',
          array_to_string(enum_range(NULL::organization_identifier_status),','),
          array_to_string(enum_range(NULL::organization_identity_conflict_status),','),
          array_to_string(enum_range(NULL::organization_identity_decision_action),','),
          array_to_string(enum_range(NULL::organization_canonical_mapping_status),','),
          array_to_string(enum_range(NULL::organization_identity_replay_status),','),
          array_to_string(enum_range(NULL::identity_link_status),',')
        );`,
      ),
      [
        "ACTIVE,PENDING_CONFLICT,REVOKED",
        "OPEN,RESOLVING,RESOLVED",
        "MERGE,KEEP_SEPARATE,SPLIT",
        "ACTIVE,REVOKED",
        "PENDING,RUNNING,SUCCEEDED,FAILED",
        "ACTIVE,PENDING_CONFLICT,REVOKED",
      ].join("|"),
    );
  });

  it("forces exact symmetric RLS policies and isolates A, B and unset app_user reads", () => {
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relname IN (${tenantTables
           .map((name) => `'${name}'`)
           .join(",")}) AND c.relrowsecurity AND c.relforcerowsecurity;`,
      ),
      "6",
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT count(*) FROM pg_policies
         WHERE schemaname='public'
           AND tablename IN (${tenantTables.map((name) => `'${name}'`).join(",")})
           AND policyname=tablename || '_tenant_isolation'
           AND cmd='ALL'
           AND roles=ARRAY['public']::name[]
           AND qual='(workspace_id = current_workspace_id())'
           AND with_check='(workspace_id = current_workspace_id())';`,
      ),
      "6",
    );

    seedExpandedRows(databases.upgrade);
    const countSql = `SELECT concat_ws('|',${tenantTables
      .map((table) => `(SELECT count(*) FROM ${table})`)
      .join(",")});`;
    assert.equal(
      dockerPsql(databases.upgrade, asApp(WORKSPACE_A, countSql)),
      "1|1|1|1|1|1",
    );
    assert.equal(
      dockerPsql(databases.upgrade, asApp(WORKSPACE_B, countSql)),
      "1|1|1|1|1|1",
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SET SESSION AUTHORIZATION app_user;
         RESET app.current_workspace_id;
         ${countSql}`,
      ),
      "0|0|0|0|0|0",
    );
  });

  it("denies every new-table app_user mutation and narrows IdentityLink to seven INSERT columns", () => {
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT count(*) FROM (
          SELECT table_name, count(*) AS grant_count,
            bool_and(privilege_type='SELECT') AS select_only
          FROM information_schema.role_table_grants
          WHERE grantee='app_user'
            AND table_schema='public'
            AND table_name IN (${tenantTables.map((name) => `'${name}'`).join(",")})
          GROUP BY table_name
        ) granted WHERE grant_count=1 AND select_only;`,
      ),
      "6",
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT concat_ws('|',
          has_table_privilege('app_user','identity_link','SELECT')::text,
          has_table_privilege('app_user','identity_link','INSERT')::text,
          has_table_privilege('app_user','identity_link','UPDATE')::text,
          has_table_privilege('app_user','identity_link','DELETE')::text,
          has_table_privilege('app_user','identity_link','TRUNCATE')::text,
          has_table_privilege('app_user','identity_link','REFERENCES')::text,
          has_table_privilege('app_user','identity_link','TRIGGER')::text,
          has_any_column_privilege('app_user','identity_link','INSERT')::text,
          has_any_column_privilege('app_user','identity_link','UPDATE')::text
        );`,
      ),
      "true|false|false|false|false|false|false|true|false",
    );
    const insertColumns = dockerPsql(
      databases.upgrade,
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='identity_link'
         AND has_column_privilege('app_user','identity_link',column_name,'INSERT')
       ORDER BY ordinal_position;`,
    ).split("\n");
    assert.deepEqual(insertColumns, [
      "id",
      "workspace_id",
      "canonical_type",
      "canonical_id",
      "raw_record_id",
      "match_rule",
      "confidence",
    ]);
    expectSqlReject(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        `INSERT INTO organization_identity_conflict(
          workspace_id,raw_record_id,conflict_type,fingerprint,facts
        ) VALUES ('${WORKSPACE_A}','${RAW_A}','DENIED','${"d".repeat(64)}','{}');`,
      ),
      /permission denied for table organization_identity_conflict/u,
    );
  });

  it("rejects every cross-workspace company, Raw, conflict, decision, mapping and replay edge", () => {
    const hash = "e".repeat(64);
    const identifierBase = (overrides) => `INSERT INTO organization_identifier(
      workspace_id,company_id,scheme,jurisdiction,normalized_value,
      authority_provider_key,raw_record_id,conflict_id,confidence,
      normalizer_version,validator_version,provenance,status
    ) VALUES (
      '${WORKSPACE_A}','${overrides.company ?? COMPANY_A}','registry-id','DE',
      '${overrides.value}','registry','${overrides.raw ?? RAW_A}',
      ${overrides.conflict ? `'${overrides.conflict}'` : "NULL"},1,
      'registry-id/v1','registry-id/v1','{}',
      '${overrides.status ?? "ACTIVE"}'
    );`;
    expectSqlReject(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        identifierBase({ company: COMPANY_B, value: "X-COMPANY" }),
      ),
      /organization_identifier_company_scope_fkey/u,
    );
    expectSqlReject(
      databases.upgrade,
      asOwner(WORKSPACE_A, identifierBase({ raw: RAW_B, value: "X-RAW" })),
      /organization_identifier_raw_scope_fkey/u,
    );
    expectSqlReject(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        identifierBase({
          conflict: CONFLICT_B,
          status: "PENDING_CONFLICT",
          value: "X-CONFLICT",
        }),
      ),
      /organization_identifier_conflict_scope_fkey/u,
    );
    expectSqlReject(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        `INSERT INTO organization_identity_conflict(
          workspace_id,raw_record_id,conflict_type,fingerprint,facts
        ) VALUES ('${WORKSPACE_A}','${RAW_B}','CROSS_RAW','${hash}','{}');`,
      ),
      /organization_identity_conflict_raw_scope_fkey/u,
    );
    expectSqlReject(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        `INSERT INTO organization_identity_conflict_party(
          workspace_id,conflict_id,company_id,role
        ) VALUES ('${WORKSPACE_A}','${CONFLICT_B}','${COMPANY_A}','CROSS');`,
      ),
      /organization_identity_conflict_party_conflict_scope_fkey/u,
    );
    expectSqlReject(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        `INSERT INTO organization_identity_decision(
          workspace_id,conflict_id,action,canonical_company_id,request_id,
          expected_revision,request_precondition_etag,reason_code,decided_by,
          decision_hash,fact_snapshot
        ) VALUES (
          '${WORKSPACE_A}','${CONFLICT_B}','MERGE','${COMPANY_A}',
          'cross-decision',1,'"cross"','CROSS','service','${hash}','{}'
        );`,
      ),
      /organization_identity_decision_conflict_scope_fkey/u,
    );
    expectSqlReject(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        `INSERT INTO organization_canonical_mapping(
          workspace_id,source_company_id,canonical_company_id,status,revision,
          merge_decision_id
        ) VALUES (
          '${WORKSPACE_A}','${COMPANY_B}','${COMPANY_A}','ACTIVE',1,'${DECISION_A}'
        );`,
      ),
      /organization_canonical_mapping_source_scope_fkey/u,
    );
    expectSqlReject(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        `INSERT INTO organization_canonical_mapping(
          workspace_id,source_company_id,canonical_company_id,status,revision,
          merge_decision_id
        ) VALUES (
          '${WORKSPACE_A}','${COMPANY_A_ALIAS}','${COMPANY_B}','ACTIVE',1,'${DECISION_A}'
        );`,
      ),
      /organization_canonical_mapping_canonical_scope_fkey/u,
    );
    expectSqlReject(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        `INSERT INTO organization_canonical_mapping(
          workspace_id,source_company_id,canonical_company_id,status,revision,
          merge_decision_id
        ) VALUES (
          '${WORKSPACE_A}','${COMPANY_A_ALIAS}','${COMPANY_A}','ACTIVE',1,'${DECISION_B}'
        );`,
      ),
      /organization_canonical_mapping_merge_decision_scope_fkey/u,
    );
    expectSqlReject(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        `INSERT INTO organization_identity_replay(
          workspace_id,decision_id,status,attempt,input_hash
        ) VALUES ('${WORKSPACE_A}','${DECISION_B}','PENDING',0,'${hash}');`,
      ),
      /organization_identity_replay_decision_scope_fkey/u,
    );
    expectSqlReject(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        `INSERT INTO identity_link(
          workspace_id,canonical_type,canonical_id,raw_record_id,match_rule,
          confidence,conflict_id
        ) VALUES (
          '${WORKSPACE_A}','company','${COMPANY_A}','${RAW_A}',
          'cross_conflict',0,'${CONFLICT_B}'
        );`,
      ),
      /identity_link_conflict_scope_fkey/u,
    );
  });

  it("rejects every illegal MERGE, KEEP_SEPARATE and SPLIT target shape", () => {
    const hash = "f".repeat(64);
    const invalid = [
      ["MERGE", "NULL", `'${COMPANY_A}'`, "merge-no-conflict"],
      ["MERGE", `'${CONFLICT_A}'`, "NULL", "merge-no-canonical"],
      ["KEEP_SEPARATE", "NULL", "NULL", "keep-no-conflict"],
      ["KEEP_SEPARATE", `'${CONFLICT_A}'`, `'${COMPANY_A}'`, "keep-canonical"],
      ["SPLIT", `'${CONFLICT_A}'`, "NULL", "split-conflict"],
      ["SPLIT", "NULL", `'${COMPANY_A}'`, "split-canonical"],
    ];
    for (const [action, conflict, canonical, request] of invalid) {
      expectSqlReject(
        databases.upgrade,
        asOwner(
          WORKSPACE_A,
          `INSERT INTO organization_identity_decision(
            workspace_id,conflict_id,action,canonical_company_id,request_id,
            expected_revision,request_precondition_etag,reason_code,decided_by,
            decision_hash,fact_snapshot
          ) VALUES (
            '${WORKSPACE_A}',${conflict},'${action}',${canonical},'${request}',
            1,'"invalid"','INVALID','service','${hash}','{}'
          );`,
        ),
        /organization_identity_decision_action_target_check/u,
      );
    }
  });

  it("enforces identifier blank, confidence, revocation and pending-owner checks", () => {
    const base = (value, confidence, status, conflict, revokedAt) => `
      INSERT INTO organization_identifier(
        workspace_id,company_id,scheme,jurisdiction,normalized_value,
        authority_provider_key,raw_record_id,conflict_id,confidence,
        normalizer_version,validator_version,provenance,status,revoked_at
      ) VALUES (
        '${WORKSPACE_A}','${COMPANY_A}','registry-id','DE','${value}',
        'registry','${RAW_A}',${conflict},${confidence},'v1','v1','{}',
        '${status}',${revokedAt}
      );`;
    for (const [sql, expected] of [
      [
        base("   ", 1, "ACTIVE", "NULL", "NULL"),
        /organization_identifier_value_not_blank_check/u,
      ],
      [
        base("BAD-CONFIDENCE", 1.01, "ACTIVE", "NULL", "NULL"),
        /organization_identifier_confidence_check/u,
      ],
      [
        base("BAD-REVOKED", 1, "REVOKED", "NULL", "NULL"),
        /organization_identifier_revocation_check/u,
      ],
      [
        base("BAD-PENDING", 1, "PENDING_CONFLICT", "NULL", "NULL"),
        /organization_identifier_pending_conflict_owner_check/u,
      ],
    ]) {
      expectSqlReject(databases.upgrade, asOwner(WORKSPACE_A, sql), expected);
    }
  });

  it("rolls back every enum, table, IdentityLink column and index on injected migration failure", () => {
    assert.match(injectedRollbackOutput, /division by zero/u);
    assert.equal(
      dockerPsql(
        databases.rollback,
        `SELECT concat_ws('|',
          (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
            WHERE n.nspname='public' AND typname IN (${enumNames.map((name) => `'${name}'`).join(",")})),
          (SELECT count(*) FROM information_schema.tables
            WHERE table_schema='public' AND table_name IN (${tenantTables.map((name) => `'${name}'`).join(",")})),
          (SELECT count(*) FROM information_schema.columns
            WHERE table_schema='public' AND table_name='identity_link'
              AND column_name IN ('status','resolver_version','input_hash','conflict_id')),
          (to_regclass('public.canonical_company_workspace_id_id_key') IS NULL)::text,
          (to_regclass('public.identity_link_workspace_id_conflict_id_idx') IS NULL)::text
        );`,
      ),
      "0|0|0|true|true",
    );
  });

  it("validates and generates Prisma and has no candidate-scoped database-to-schema diff", () => {
    assert.equal(validateResult.status, 0, validateResult.output);
    assert.match(validateResult.output, /schema\.prisma is valid/u);
    assert.equal(generateResult.status, 0, generateResult.output);
    assert.match(generateResult.output, /Generated Prisma Client/u);
    assert.notEqual(diffResult.status, null, diffResult.output);
    assert.doesNotMatch(
      diffResult.output,
      new RegExp(
        [...tenantTables, ...enumNames]
          .map((name) => name.replaceAll("_", "[_ ]"))
          .join("|"),
        "iu",
      ),
    );
    assert.doesNotMatch(
      diffResult.output,
      /canonical_company_workspace_id_id_key|identity_link_workspace_id_conflict_id_idx|identity_link_conflict_scope_fkey/iu,
    );
    assert.doesNotMatch(
      diffResult.output,
      /Changed the `identity_link` table[\s\S]+?(?:Added|Removed|Altered) column `(?:status|resolver_version|input_hash|conflict_id)`/iu,
    );
  });
});
