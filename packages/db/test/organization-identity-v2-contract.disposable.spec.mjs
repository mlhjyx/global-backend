import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { materializePinnedPrismaStage } from "./helpers/pinned-prisma-stage.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const backfillCommit = "c17385c4674782c15972f48fd6cda02730ccb299";
const contractCommit = "400caab2f8d827cc012ee5f928e7af4d6a1d6e08";
const contractMigrationName =
  "20260829092000_organization_identity_v2_contract_ddl";
// This suite materializes the exact pre-reissue historical stage. This checksum
// is provenance-only and is forbidden from retained or official inventory.
const supersededHistoricalExpandChecksum =
  "2f6bab93bd253dd7ec80d2c94c45f91e2c6bb1fae51127b94e15b0e11b85a119";
const container = process.env.TASK6B_PG_CONTAINER;
const port = process.env.TASK6B_PG_PORT;
const databases = Object.freeze({
  fresh: "task6b_identity_contract_fresh",
  upgrade: "task6b_identity_contract_upgrade",
  preflight: "task6b_identity_contract_preflight",
  injection: "task6b_identity_contract_injection",
  lock: "task6b_identity_contract_lock",
});

const WORKSPACE_A = "11000000-0000-4000-8000-000000000001";
const WORKSPACE_B = "11000000-0000-4000-8000-000000000002";
const RUN_A = "12000000-0000-4000-8000-000000000001";
const RUN_B = "12000000-0000-4000-8000-000000000002";
const RAW_A = "13000000-0000-4000-8000-000000000001";
const RAW_B = "13000000-0000-4000-8000-000000000002";
const COMPANY_A = "14000000-0000-4000-8000-000000000001";
const COMPANY_A2 = "14000000-0000-4000-8000-000000000002";
const COMPANY_A3 = "14000000-0000-4000-8000-000000000003";
const COMPANY_A4 = "14000000-0000-4000-8000-000000000004";
const COMPANY_A5 = "14000000-0000-4000-8000-000000000005";
const COMPANY_B = "14000000-0000-4000-8000-000000000006";
const COMPANY_A6 = "14000000-0000-4000-8000-000000000007";
const COMPANY_A7 = "14000000-0000-4000-8000-000000000008";
const CONTACT_A = "15000000-0000-4000-8000-000000000001";
const CONTACT_B = "15000000-0000-4000-8000-000000000002";
const LINK_SEED_A = "16000000-0000-4000-8000-000000000001";
const LINK_SEED_B = "16000000-0000-4000-8000-000000000002";
const LINK_APP_COMPANY = "16000000-0000-4000-8000-000000000003";
const LINK_APP_CONTACT = "16000000-0000-4000-8000-000000000004";
const LINK_HASH = "16000000-0000-4000-8000-000000000005";
const LINK_PENDING_ACTIVE = "16000000-0000-4000-8000-000000000006";
const LINK_PENDING_REVOKED = "16000000-0000-4000-8000-000000000007";
const LINK_ACTIVE_INVALID = "16000000-0000-4000-8000-000000000008";
const LINK_TARGET_LOCK = "16000000-0000-4000-8000-000000000009";
const LINK_PENDING_OWNER_INVALID = "16000000-0000-4000-8000-000000000010";
const LINK_HISTORY_COMPANY = "16000000-0000-4000-8000-000000000011";
const LINK_HISTORY_CONTACT = "16000000-0000-4000-8000-000000000012";
const POLICY = "17000000-0000-4000-8000-000000000001";
const MISSING_TARGET = "18000000-0000-4000-8000-000000000001";
const COMPANY_TARGET_LOCK = "19000000-0000-4000-8000-000000000001";
const COMPANY_HISTORY_DIRECT = "19000000-0000-4000-8000-000000000002";
const COMPANY_HISTORY_CASCADE = "19000000-0000-4000-8000-000000000003";
const CONTACT_HISTORY_CASCADE = "19500000-0000-4000-8000-000000000001";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const PRISMA_RESIDUAL_FIXTURE_RELATIVE_PATH =
  "packages/db/test/fixtures/organization-identity-v2-contract-prisma-residual.sql";
const PRISMA_RESIDUAL_MANIFEST_RELATIVE_PATH =
  "packages/db/test/fixtures/organization-identity-v2-contract-prisma-residual.manifest.json";
const prismaResidualFixturePath = resolve(
  repositoryRoot,
  PRISMA_RESIDUAL_FIXTURE_RELATIVE_PATH,
);
const prismaResidualManifestPath = resolve(
  repositoryRoot,
  PRISMA_RESIDUAL_MANIFEST_RELATIVE_PATH,
);
const REVIEWED_PRISMA_RESIDUAL_SHA256 =
  "74f090715241bd8fb14c66f327f5505491065d976a25e35d1752f3e2c3e1afb8";

const CONTRACT_TABLES = Object.freeze([
  "identity_link",
  "organization_identifier",
  "organization_identity_conflict",
  "organization_identity_conflict_party",
  "organization_identity_decision",
  "organization_canonical_mapping",
  "organization_identity_replay",
]);
const CONTRACT_FUNCTIONS = Object.freeze([
  "enforce_identity_link_contract_v2",
  "enforce_identity_link_target_v2",
  "enforce_organization_canonical_mapping_contract_v2",
  "enforce_organization_identifier_contract_v2",
  "enforce_organization_identity_conflict_contract_v2",
  "enforce_organization_identity_conflict_party_contract_v2",
  "enforce_organization_identity_decision_contract_v2",
  "enforce_organization_identity_replay_contract_v2",
]);
const REQUIRED_FORBIDDEN_RESIDUAL_PATTERNS = Object.freeze([
  'ALTER TABLE\\s+"identity_link"[\\s\\S]*?ALTER COLUMN\\s+"(?:status|resolver_version|input_hash|conflict_id)"',
  "identity_link_status",
  "identity_link_input_hash_check",
  "identity_link_pending_conflict_owner_check",
  "identity_link_workspace_canonical_raw_key",
  "organization_identifier",
  "organization_identity_conflict",
  "organization_identity_conflict_party",
  "organization_identity_decision",
  "organization_canonical_mapping",
  "organization_identity_replay",
  "identity_link_10_typed_target_guard",
  "identity_link_20_contract_guard",
  "organization_identifier_contract_guard",
  "organization_identity_conflict_contract_guard",
  "organization_identity_conflict_party_contract_guard",
  "organization_identity_decision_contract_guard",
  "organization_canonical_mapping_contract_guard",
  "organization_identity_replay_contract_guard",
  ...CONTRACT_FUNCTIONS,
]);

let backfillTree;
let contractStage;
let topologyInventory;
let contractSql = "";
let firstFreshDeployOutput = "";
let secondFreshDeployOutput = "";
let upgradeDeployOutput = "";
let freshSchemaDiffResult;
let schemaDiffResult;
let rawBefore = "";
let rawAfter = "";
let rawAclBefore = "";
let rawAclAfter = "";
let runtimeBefore = "";
let runtimeAfter = "";

function requireTopology() {
  assert.equal(container, "codex-task6b-identity-pg-20260829-a");
  assert.equal(port, "55439");
}

function assertDatabase(database) {
  assert.ok(
    database === "postgres" || Object.values(databases).includes(database),
    `database outside Task 6B.1c scope: ${database}`,
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
    maxBuffer: 64 * 1024 * 1024,
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
  const result = spawnSync(
    "docker",
    [
      "inspect",
      "--format",
      "{{json .Config.Image}}\n{{json .State.Running}}\n{{json .NetworkSettings.Ports}}",
      container,
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const [imageJson, runningJson, portsJson, ...extra] = result.stdout
    .trim()
    .split("\n");
  assert.deepEqual(extra, []);
  return Object.freeze({
    image: JSON.parse(imageJson),
    running: JSON.parse(runningJson),
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
        CHECKPOINT_DISABLE: "1",
        PRISMA_GENERATE_SKIP_AUTOINSTALL: "true",
        PRISMA_HIDE_UPDATE_MESSAGE: "true",
        ...(database ? { DATABASE_URL: ownerUrl(database) } : {}),
      },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return Object.freeze({
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}\n${result.stderr}`.trim(),
  });
}

function migrateDeploy(database, schemaPath) {
  const result = runPrisma(
    ["migrate", "deploy", "--schema", schemaPath],
    database,
  );
  assert.equal(result.status, 0, result.output);
  return result.output;
}

function runPrismaDiff(database, schemaPath) {
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

function assertTrackedPath(relativePath) {
  const result = spawnSync(
    "git",
    ["ls-files", "--error-unmatch", "--", relativePath],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(
    result.status,
    0,
    `reviewed Prisma residual artifact is not tracked: ${relativePath}\n${result.stdout}\n${result.stderr}`,
  );
  assert.equal(result.stdout.trim(), relativePath);
}

function parseResidualStatements(sql) {
  const uncommented = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trim();
  assert.ok(uncommented.endsWith(";"));
  return uncommented
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => `${statement};`);
}

function loadReviewedPrismaResidual(observedOutput) {
  assert.ok(
    existsSync(prismaResidualFixturePath),
    `tracked exact Prisma residual fixture is absent: ${PRISMA_RESIDUAL_FIXTURE_RELATIVE_PATH}\nObserved stdout:\n${observedOutput}`,
  );
  assert.ok(
    existsSync(prismaResidualManifestPath),
    `tracked Prisma residual manifest is absent: ${PRISMA_RESIDUAL_MANIFEST_RELATIVE_PATH}`,
  );
  assertTrackedPath(PRISMA_RESIDUAL_FIXTURE_RELATIVE_PATH);
  assertTrackedPath(PRISMA_RESIDUAL_MANIFEST_RELATIVE_PATH);

  const fixture = readFileSync(prismaResidualFixturePath, "utf8");
  assert.notEqual(
    fixture,
    "",
    "reviewed Prisma residual fixture must be nonempty",
  );
  assert.equal(sha256(fixture), REVIEWED_PRISMA_RESIDUAL_SHA256);

  const manifest = JSON.parse(readFileSync(prismaResidualManifestPath, "utf8"));
  assert.equal(
    manifest.schemaVersion,
    "organization-identity-v2-contract-prisma-residual/v1",
  );
  assert.equal(manifest.fixture, PRISMA_RESIDUAL_FIXTURE_RELATIVE_PATH);
  assert.equal(manifest.sha256, REVIEWED_PRISMA_RESIDUAL_SHA256);
  assert.equal(manifest.contractStageCommit, contractCommit);
  assert.equal(
    manifest.command,
    "prisma migrate diff --script --from-url <task6b_identity_database> --to-schema-datamodel <exact_contract_stage_schema>",
  );
  assert.ok(Array.isArray(manifest.allowedCategories));
  assert.ok(manifest.allowedCategories.length > 0);
  const allowedStatements = manifest.allowedCategories.flatMap((category) => {
    assert.equal(typeof category.id, "string");
    assert.ok(category.id.length > 0);
    assert.equal(typeof category.reason, "string");
    assert.ok(category.reason.length > 0);
    assert.ok(Array.isArray(category.statements));
    assert.ok(category.statements.length > 0);
    return category.statements;
  });
  assert.deepEqual(parseResidualStatements(fixture), allowedStatements);
  assert.deepEqual(
    manifest.forbiddenStatementPatterns,
    REQUIRED_FORBIDDEN_RESIDUAL_PATTERNS,
  );
  for (const statement of allowedStatements) {
    for (const pattern of manifest.forbiddenStatementPatterns) {
      assert.doesNotMatch(statement, new RegExp(pattern, "u"));
    }
  }
  return fixture;
}

function assertExactPrismaDiff(result, label, fixture) {
  assert.equal(result.status, 0, `${label}: ${result.output}`);
  assert.equal(result.stderr, "", `${label} emitted stderr`);
  assert.notEqual(fixture, "", "reviewed Prisma residual cannot be empty");
  assert.equal(result.stdout, fixture, `${label} differs from tracked fixture`);
  return sha256(result.stdout);
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
    RESET SESSION AUTHORIZATION;
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

function rawWriterCommand({ workspaceId, runId, rawId, externalId, hash }) {
  const payload = {
    externalId,
    name: `${externalId} GmbH`,
    domain: `${externalId}.example`,
    attributes: { products: ["industrial pump"] },
    provenance: {
      sourceUrl: `https://registry.example/${externalId}`,
      fetchedAt: "2026-08-29T00:00:00.000Z",
      contentHash: hash,
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
    fetchedAt: payload.provenance.fetchedAt,
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

function companyRows() {
  return [
    [COMPANY_A, "Contract A", "contract-a.example", "contract-a"],
    [COMPANY_A2, "Contract A2", "contract-a2.example", "contract-a2"],
    [COMPANY_A3, "Contract A3", "contract-a3.example", "contract-a3"],
    [COMPANY_A4, "Contract A4", "contract-a4.example", "contract-a4"],
    [COMPANY_A5, "Contract A5", "contract-a5.example", "contract-a5"],
    [COMPANY_A6, "Contract A6", "contract-a6.example", "contract-a6"],
    [COMPANY_A7, "Contract A7", "contract-a7.example", "contract-a7"],
  ]
    .map(
      ([id, name, domain, dedupe]) =>
        `('${id}','${WORKSPACE_A}','${name}','${domain}','NEW','${dedupe}',1,now(),now())`,
    )
    .join(",\n");
}

function seedBaseline(database, { validLifecycle }) {
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
      ('${WORKSPACE_A}','Task 6B.1c A',now(),now()),
      ('${WORKSPACE_B}','Task 6B.1c B',now(),now());
    INSERT INTO discovery_run(id,workspace_id,plan_id,icp_id,status,created_at) VALUES
      ('${RUN_A}','${WORKSPACE_A}',gen_random_uuid(),gen_random_uuid(),'RUNNING',now()),
      ('${RUN_B}','${WORKSPACE_B}',gen_random_uuid(),gen_random_uuid(),'RUNNING',now());
    ${asOwner(
      WORKSPACE_A,
      `INSERT INTO canonical_company(
        id,workspace_id,name,domain,status,dedupe_key,version,created_at,updated_at
      ) VALUES ${companyRows()};
      INSERT INTO canonical_contact(
        id,workspace_id,company_id,full_name,title,seniority,department,
        dedupe_key,created_at
      ) VALUES (
        '${CONTACT_A}','${WORKSPACE_A}','${COMPANY_A}','Ada Contract','CTO',
        'c_level','Engineering','contract-contact-a',now()
      );`,
    )}
    ${asOwner(
      WORKSPACE_B,
      `INSERT INTO canonical_company(
        id,workspace_id,name,domain,status,dedupe_key,version,created_at,updated_at
      ) VALUES (
        '${COMPANY_B}','${WORKSPACE_B}','Contract B','contract-b.example','NEW',
        'contract-b',1,now(),now()
      );
      INSERT INTO canonical_contact(
        id,workspace_id,company_id,full_name,title,seniority,department,
        dedupe_key,created_at
      ) VALUES (
        '${CONTACT_B}','${WORKSPACE_B}','${COMPANY_B}','Bob Contract','COO',
        'c_level','Operations','contract-contact-b',now()
      );`,
    )}
    ${asApp(
      WORKSPACE_A,
      writerSql(
        rawWriterCommand({
          workspaceId: WORKSPACE_A,
          runId: RUN_A,
          rawId: RAW_A,
          externalId: "contract-raw-a",
          hash: HASH_A,
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
          externalId: "contract-raw-b",
          hash: HASH_B,
        }),
      ),
    )}
    ${asOwner(
      WORKSPACE_A,
      `INSERT INTO identity_link(
        id,workspace_id,canonical_type,canonical_id,raw_record_id,
        match_rule,confidence${validLifecycle ? ",status,resolver_version,input_hash" : ""}
      ) VALUES (
        '${LINK_SEED_A}','${WORKSPACE_A}','company','${COMPANY_A}','${RAW_A}',
        'domain_exact',0.9${validLifecycle ? ",'ACTIVE','identity-v1','legacy'" : ""}
      );`,
    )}
    ${asOwner(
      WORKSPACE_B,
      `INSERT INTO identity_link(
        id,workspace_id,canonical_type,canonical_id,raw_record_id,
        match_rule,confidence${validLifecycle ? ",status,resolver_version,input_hash" : ""}
      ) VALUES (
        '${LINK_SEED_B}','${WORKSPACE_B}','contact','${CONTACT_B}','${RAW_B}',
        'provider_id',0.8${validLifecycle ? ",'ACTIVE','identity-v1','legacy'" : ""}
      );`,
    )}
  `,
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

function rawAclSnapshot(database) {
  return dockerPsql(
    database,
    `SELECT string_agg(kind || ':' || identity || ':' || privilege, E'\\n' ORDER BY kind,identity,privilege)
     FROM (
       SELECT 'table' AS kind, table_name AS identity, privilege_type AS privilege
       FROM information_schema.role_table_grants
       WHERE grantee='app_user' AND table_schema='public'
         AND table_name='raw_source_record'
       UNION ALL
       SELECT 'column', table_name || '.' || column_name, privilege_type
       FROM information_schema.column_privileges
       WHERE grantee='app_user' AND table_schema='public'
         AND table_name='raw_source_record'
       UNION ALL
       SELECT 'routine', routine_name, privilege_type
       FROM information_schema.routine_privileges
       WHERE grantee='app_user' AND routine_schema='public'
         AND routine_name LIKE '%raw_source_record%'
     ) grants;`,
  );
}

function runtimeSnapshot(database) {
  return dockerPsql(
    database,
    `SELECT string_agg(kind || ':' || identity || ':' || definition, E'\\n' ORDER BY kind,identity)
     FROM (
       SELECT 'column' AS kind, column_name AS identity,
         concat_ws('|',data_type,udt_name,is_nullable,column_default) AS definition
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name='runtime_process_lease'
       UNION ALL
       SELECT 'constraint', conname, pg_get_constraintdef(oid, true)
       FROM pg_constraint
       WHERE conrelid='public.runtime_process_lease'::regclass
       UNION ALL
       SELECT 'index', indexname, indexdef
       FROM pg_indexes
       WHERE schemaname='public' AND tablename='runtime_process_lease'
       UNION ALL
       SELECT 'function', p.oid::regprocedure::text, pg_get_functiondef(p.oid)
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public'
         AND p.proname LIKE '%runtime_process_lease%'
     ) objects;`,
  );
}

function contractObjectSnapshot(database) {
  const tableValues = CONTRACT_TABLES.map((table) => `('${table}')`).join(",");
  const functionValues = CONTRACT_FUNCTIONS.map(
    (functionName) => `('${functionName}')`,
  ).join(",");
  return dockerPsql(
    database,
    `WITH target_tables(table_name) AS (VALUES ${tableValues}),
     target_functions(function_name) AS (VALUES ${functionValues})
     SELECT jsonb_build_object(
       'columns', COALESCE((
         SELECT jsonb_agg(to_jsonb(snapshot) ORDER BY snapshot.table_name,snapshot.ordinal_position)
         FROM (
           SELECT columns.table_name,columns.ordinal_position,columns.column_name,
             columns.is_nullable,columns.data_type,columns.udt_name,
             COALESCE(columns.column_default,'') AS column_default
           FROM information_schema.columns AS columns
           JOIN target_tables USING (table_name)
           WHERE columns.table_schema='public'
         ) AS snapshot
       ),'[]'::jsonb),
       'constraints', COALESCE((
         SELECT jsonb_agg(to_jsonb(snapshot) ORDER BY snapshot.table_name,snapshot.constraint_name)
         FROM (
           SELECT relation.relname AS table_name,constraint_record.conname AS constraint_name,
             constraint_record.contype AS constraint_type,
             constraint_record.convalidated AS validated,
             pg_get_constraintdef(constraint_record.oid,true) AS definition
           FROM pg_constraint AS constraint_record
           JOIN pg_class AS relation ON relation.oid=constraint_record.conrelid
           JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
           JOIN target_tables ON target_tables.table_name=relation.relname
           WHERE namespace.nspname='public'
         ) AS snapshot
       ),'[]'::jsonb),
       'indexes', COALESCE((
         SELECT jsonb_agg(to_jsonb(snapshot) ORDER BY snapshot.table_name,snapshot.index_name)
         FROM (
           SELECT indexes.tablename AS table_name,indexes.indexname AS index_name,
             indexes.indexdef AS definition
           FROM pg_indexes AS indexes
           JOIN target_tables ON target_tables.table_name=indexes.tablename
           WHERE indexes.schemaname='public'
         ) AS snapshot
       ),'[]'::jsonb),
       'triggers', COALESCE((
         SELECT jsonb_agg(to_jsonb(snapshot) ORDER BY snapshot.table_name,snapshot.trigger_name)
         FROM (
           SELECT relation.relname AS table_name,trigger_record.tgname AS trigger_name,
             trigger_record.tgenabled AS enabled,
             pg_get_triggerdef(trigger_record.oid,true) AS definition
           FROM pg_trigger AS trigger_record
           JOIN pg_class AS relation ON relation.oid=trigger_record.tgrelid
           JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
           JOIN target_tables ON target_tables.table_name=relation.relname
           WHERE namespace.nspname='public' AND NOT trigger_record.tgisinternal
         ) AS snapshot
       ),'[]'::jsonb),
       'table_acl', COALESCE((
         SELECT jsonb_agg(to_jsonb(snapshot) ORDER BY snapshot.table_name)
         FROM (
           SELECT relation.relname AS table_name,pg_get_userbyid(relation.relowner) AS owner,
             COALESCE(relation.relacl::text,'') AS raw_acl,
             COALESCE((
               SELECT string_agg(
                 (CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END)
                   || ':' || acl.privilege_type || ':' || acl.is_grantable,
                 ',' ORDER BY acl.grantee,acl.privilege_type,acl.is_grantable
               )
               FROM aclexplode(COALESCE(relation.relacl,acldefault('r',relation.relowner))) AS acl
             ),'') AS effective_acl
           FROM pg_class AS relation
           JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
           JOIN target_tables ON target_tables.table_name=relation.relname
           WHERE namespace.nspname='public'
         ) AS snapshot
       ),'[]'::jsonb),
       'functions', COALESCE((
         SELECT jsonb_agg(to_jsonb(snapshot) ORDER BY snapshot.identity)
         FROM (
           SELECT format('public.%I(%s)',procedure_record.proname,
                    pg_get_function_identity_arguments(procedure_record.oid)) AS identity,
             pg_get_functiondef(procedure_record.oid) AS definition,
             COALESCE(to_jsonb(procedure_record.proconfig),'[]'::jsonb) AS proconfig,
             COALESCE(procedure_record.proacl::text,'') AS raw_acl,
             COALESCE((
               SELECT string_agg(
                 (CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END)
                   || ':' || acl.privilege_type || ':' || acl.is_grantable,
                 ',' ORDER BY acl.grantee,acl.privilege_type,acl.is_grantable
               )
               FROM aclexplode(COALESCE(procedure_record.proacl,
                 acldefault('f',procedure_record.proowner))) AS acl
             ),'') AS effective_acl
           FROM pg_proc AS procedure_record
           JOIN pg_namespace AS namespace ON namespace.oid=procedure_record.pronamespace
           JOIN target_functions ON target_functions.function_name=procedure_record.proname
           WHERE namespace.nspname='public' AND procedure_record.pronargs=0
         ) AS snapshot
       ),'[]'::jsonb)
     )::text;`,
  );
}

function expectOwnerFailure(database, sql, expected) {
  return dockerPsql(database, asOwner(WORKSPACE_A, sql), {
    rejects: expected,
  });
}

function insertConflictSql({
  id,
  workspaceId = WORKSPACE_A,
  status = "OPEN",
  revision = 1,
}) {
  const resolvedAt = status === "RESOLVED" ? ",resolved_at" : "";
  const resolvedValue = status === "RESOLVED" ? ",'2026-08-29T04:00:00Z'" : "";
  return `INSERT INTO organization_identity_conflict(
    id,workspace_id,raw_record_id,conflict_type,fingerprint,status,revision,
    facts,created_at${resolvedAt}
  ) VALUES (
    '${id}','${workspaceId}',${workspaceId === WORKSPACE_A ? `'${RAW_A}'` : `'${RAW_B}'`},
    'DUPLICATE_CANDIDATE','${id.replaceAll("-", "").padEnd(64, "f").slice(0, 64)}',
    '${status}',${revision},'{}','2026-08-29T03:00:00Z'${resolvedValue}
  );`;
}

function insertDecisionSql({
  id,
  requestId,
  action,
  workspaceId = WORKSPACE_A,
  conflictId = null,
  canonicalCompanyId = null,
  decisionHash = HASH_A,
}) {
  return `INSERT INTO organization_identity_decision(
    id,workspace_id,conflict_id,action,canonical_company_id,request_id,
    expected_revision,request_precondition_etag,reason_code,note,decided_by,
    decision_hash,fact_snapshot,created_at
  ) VALUES (
    '${id}','${workspaceId}',${conflictId ? `'${conflictId}'` : "NULL"},
    '${action}',${canonicalCompanyId ? `'${canonicalCompanyId}'` : "NULL"},
    '${requestId}',1,'etag-1','REVIEWED',NULL,'task6b-controller',
    '${decisionHash}','{}','2026-08-29T05:00:00Z'
  );`;
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
      if (!ready && stdout.includes("TASK6B_CONTRACT_LOCK_READY")) {
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
      SELECT 'TASK6B_CONTRACT_LOCK_READY';
    `);
  });
}

function startIdentityTargetLockHolder(database) {
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
        new Error(
          `target lock holder did not become ready:\n${stdout}\n${stderr}`,
        ),
      );
    }, 5000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!ready && stdout.includes("TASK6B_TARGET_LOCK_READY")) {
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
            `target lock holder exited before ready (${code}):\n${stdout}\n${stderr}`,
          ),
        );
      }
    });
    child.stdin.write(`
      BEGIN;
      SELECT set_config('app.current_workspace_id', '${WORKSPACE_A}', true);
      INSERT INTO identity_link(
        id,workspace_id,canonical_type,canonical_id,raw_record_id,
        match_rule,confidence
      ) VALUES (
        '${LINK_TARGET_LOCK}','${WORKSPACE_A}','company',
        '${COMPANY_TARGET_LOCK}','${RAW_A}','target-lock',0.91
      );
      SELECT 'TASK6B_TARGET_LOCK_READY';
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

  backfillTree = materializePinnedPrismaStage({
    repositoryRoot,
    commit: backfillCommit,
    prefix: "task6b-identity-contract-backfill-",
  });
  contractStage = materializePinnedPrismaStage({
    repositoryRoot,
    commit: contractCommit,
    prefix: "task6b-identity-contract-green-",
  });
  for (const database of [
    databases.upgrade,
    databases.preflight,
    databases.injection,
    databases.lock,
  ]) {
    migrateDeploy(database, backfillTree.schemaPath);
  }
  seedBaseline(databases.upgrade, { validLifecycle: true });
  seedBaseline(databases.preflight, { validLifecycle: false });
  seedBaseline(databases.injection, { validLifecycle: true });
  seedBaseline(databases.lock, { validLifecycle: true });

  const pinnedContractMigrationPath = resolve(
    contractStage.migrationRoot,
    contractMigrationName,
    "migration.sql",
  );
  assert.ok(
    existsSync(pinnedContractMigrationPath),
    "exact contract migration is absent from the pinned GREEN stage",
  );
  contractSql = readFileSync(pinnedContractMigrationPath, "utf8");

  firstFreshDeployOutput = migrateDeploy(
    databases.fresh,
    contractStage.schemaPath,
  );
  secondFreshDeployOutput = migrateDeploy(
    databases.fresh,
    contractStage.schemaPath,
  );
  freshSchemaDiffResult = runPrismaDiff(
    databases.fresh,
    contractStage.schemaPath,
  );
  rawBefore = rawBytes(databases.upgrade);
  rawAclBefore = rawAclSnapshot(databases.upgrade);
  runtimeBefore = runtimeSnapshot(databases.upgrade);
  upgradeDeployOutput = migrateDeploy(
    databases.upgrade,
    contractStage.schemaPath,
  );
  schemaDiffResult = runPrismaDiff(databases.upgrade, contractStage.schemaPath);
  rawAfter = rawBytes(databases.upgrade);
  rawAclAfter = rawAclSnapshot(databases.upgrade);
  runtimeAfter = runtimeSnapshot(databases.upgrade);
});

after(() => {
  if (backfillTree?.root) {
    rmSync(backfillTree.root, { recursive: true, force: true });
  }
  if (contractStage?.root) {
    rmSync(contractStage.root, { recursive: true, force: true });
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

describe("Organization Identity v2 contract on disposable PostgreSQL 16", () => {
  it("attests the controller-owned running image and exact loopback port", () => {
    assert.deepEqual(topologyInventory, {
      image: "pgvector/pgvector:pg16",
      running: true,
      publishedPorts: {
        "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55439" }],
      },
    });
  });

  it("deploys fresh/upgrade once, makes second deploy a no-op and keeps same-stage diff exact", () => {
    assert.match(
      firstFreshDeployOutput,
      new RegExp(contractMigrationName, "u"),
    );
    assert.match(upgradeDeployOutput, new RegExp(contractMigrationName, "u"));
    assert.match(secondFreshDeployOutput, /No pending migrations to apply/u);
    const fixture = loadReviewedPrismaResidual(freshSchemaDiffResult.stdout);
    assert.equal(
      assertExactPrismaDiff(
        freshSchemaDiffResult,
        "fresh schema diff",
        fixture,
      ),
      assertExactPrismaDiff(schemaDiffResult, "upgrade schema diff", fixture),
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT count(*) FROM "_prisma_migrations"
         WHERE migration_name='${contractMigrationName}'
           AND finished_at IS NOT NULL AND rolled_back_at IS NULL;`,
      ),
      "1",
    );
  });

  it("preserves prior ledger checksums and Raw bytes/grants/runtime objects", () => {
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT string_agg(migration_name || ':' || checksum, E'\\n' ORDER BY migration_name)
         FROM "_prisma_migrations"
         WHERE migration_name IN (
           '20260829090000_organization_identity_v2_expand_ddl',
           '20260829091000_organization_identity_v2_legacy_link_backfill_dml'
         );`,
      ),
      [
        `20260829090000_organization_identity_v2_expand_ddl:${supersededHistoricalExpandChecksum}`,
        "20260829091000_organization_identity_v2_legacy_link_backfill_dml:d897ab5c50dd038e2f4bb04b7d1b37bd404ce7f9c68ac7dc5a45a47272fc9426",
      ].join("\n"),
    );
    assert.equal(rawAfter, rawBefore);
    assert.equal(rawAfter.split("\n")[0], "2");
    assert.equal(rawAclAfter, rawAclBefore);
    assert.equal(runtimeAfter, runtimeBefore);
  });

  it("fails closed on incomplete and invalid preflight rows without contract residue", () => {
    const beforeSnapshot = contractObjectSnapshot(databases.preflight);
    dockerPsql(databases.preflight, contractSql, {
      rejects: /IDENTITY_LINK_CONTRACT_PREFLIGHT_LIFECYCLE_INVALID/u,
    });
    assert.equal(contractObjectSnapshot(databases.preflight), beforeSnapshot);
    assert.equal(
      dockerPsql(
        databases.preflight,
        "SELECT count(*) FROM identity_link WHERE status IS NULL OR resolver_version IS NULL OR input_hash IS NULL;",
      ),
      "2",
    );

    dockerPsql(
      databases.preflight,
      `UPDATE identity_link SET status='ACTIVE',resolver_version='identity-v1',input_hash='${HASH_A.toUpperCase()}';`,
    );
    dockerPsql(databases.preflight, contractSql, {
      rejects: /IDENTITY_LINK_CONTRACT_PREFLIGHT_LIFECYCLE_INVALID/u,
    });
    assert.equal(contractObjectSnapshot(databases.preflight), beforeSnapshot);
  });

  it("rolls back every candidate object on injected pre-COMMIT failure", () => {
    const beforeSnapshot = contractObjectSnapshot(databases.injection);
    const injectedSql = contractSql.replace(
      /\nCOMMIT;\s*$/u,
      "\nSELECT 1 / 0;\nCOMMIT;\n",
    );
    assert.notEqual(injectedSql, contractSql);
    dockerPsql(databases.injection, injectedSql, {
      rejects: /division by zero/u,
    });
    assert.equal(contractObjectSnapshot(databases.injection), beforeSnapshot);
  });

  it("times out around five seconds at the first lock with zero contract residue", async () => {
    const beforeSnapshot = contractObjectSnapshot(databases.lock);
    const holder = await startCanonicalCompanyLockHolder(databases.lock);
    let durationMs = 0;
    try {
      const startedAt = Date.now();
      dockerPsql(databases.lock, contractSql, {
        rejects: /canceling statement due to lock timeout/u,
      });
      durationMs = Date.now() - startedAt;
    } finally {
      await releaseLockHolder(holder);
    }
    assert.ok(
      durationMs >= 4000,
      `lock timeout fired too early: ${durationMs}ms`,
    );
    assert.ok(
      durationMs < 7000,
      `lock timeout exceeded bound: ${durationMs}ms`,
    );
    assert.equal(contractObjectSnapshot(databases.lock), beforeSnapshot);
  });

  it("finalizes IdentityLink metadata and keeps the seven-column app writer compatible", () => {
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT string_agg(column_name || '|' || is_nullable || '|' || coalesce(column_default,''), E'\\n' ORDER BY column_name)
         FROM information_schema.columns
         WHERE table_schema='public' AND table_name='identity_link'
           AND column_name IN ('status','resolver_version','input_hash','conflict_id');`,
      ),
      [
        "conflict_id|YES|",
        "input_hash|NO|'legacy'::character varying",
        "resolver_version|NO|'identity-v1'::character varying",
        "status|NO|'ACTIVE'::identity_link_status",
      ].join("\n"),
    );
    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        `INSERT INTO identity_link(
          id,workspace_id,canonical_type,canonical_id,raw_record_id,match_rule,confidence
        ) VALUES (
          '${LINK_APP_COMPANY}','${WORKSPACE_A}','company','${COMPANY_A2}',
          '${RAW_A}','domain_exact',0.75
        );`,
      ),
    );
    dockerPsql(
      databases.upgrade,
      asApp(
        WORKSPACE_A,
        `INSERT INTO identity_link(
          id,workspace_id,canonical_type,canonical_id,raw_record_id,match_rule,confidence
        ) VALUES (
          '${LINK_APP_CONTACT}','${WORKSPACE_A}','contact','${CONTACT_A}',
          '${RAW_A}','provider_id',0.7
        );`,
      ),
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT string_agg(status::text || '|' || resolver_version || '|' || input_hash || '|' || coalesce(conflict_id::text,''), E'\\n' ORDER BY id)
         FROM identity_link WHERE id IN ('${LINK_APP_COMPANY}','${LINK_APP_CONTACT}');`,
      ),
      "ACTIVE|identity-v1|legacy|\nACTIVE|identity-v1|legacy|",
    );
  });

  it("enforces IdentityLink hash, uniqueness, typed target insert/update and app ACL", () => {
    expectOwnerFailure(
      databases.upgrade,
      `INSERT INTO identity_link(
        id,workspace_id,canonical_type,canonical_id,raw_record_id,match_rule,
        confidence,status,resolver_version,input_hash,conflict_id
      ) VALUES (
        '${LINK_PENDING_OWNER_INVALID}','${WORKSPACE_A}','company','${COMPANY_A7}',
        '${RAW_A}','pending-without-owner',0.61,'PENDING_CONFLICT',
        'identity-v1','legacy',NULL
      );`,
      /identity_link_pending_conflict_owner_check/u,
    );
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT count(*) FROM identity_link WHERE id='${LINK_PENDING_OWNER_INVALID}';`,
      ),
      "0",
    );

    expectOwnerFailure(
      databases.upgrade,
      `INSERT INTO identity_link(
        id,workspace_id,canonical_type,canonical_id,raw_record_id,match_rule,
        confidence,status,resolver_version,input_hash
      ) VALUES (
        '${LINK_HASH}','${WORKSPACE_A}','company','${COMPANY_A3}','${RAW_A}',
        'hash-test',0.6,'ACTIVE','identity-v1','${HASH_A.toUpperCase()}'
      );`,
      /identity_link_input_hash_check/u,
    );
    dockerPsql(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        `INSERT INTO identity_link(
          id,workspace_id,canonical_type,canonical_id,raw_record_id,match_rule,
          confidence,status,resolver_version,input_hash
        ) VALUES (
          '${LINK_HASH}','${WORKSPACE_A}','company','${COMPANY_A3}','${RAW_A}',
          'hash-test',0.6,'ACTIVE','identity-v1','${HASH_C}'
        );`,
      ),
    );
    expectOwnerFailure(
      databases.upgrade,
      `INSERT INTO identity_link(
        id,workspace_id,canonical_type,canonical_id,raw_record_id,match_rule,confidence
      ) VALUES (
        gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A3}','${RAW_A}',
        'duplicate',0.5
      );`,
      /identity_link_workspace_canonical_raw_key/u,
    );

    for (const [canonicalType, canonicalId] of [
      ["organization", COMPANY_A],
      ["company", MISSING_TARGET],
      ["company", COMPANY_B],
      ["contact", MISSING_TARGET],
      ["contact", CONTACT_B],
    ]) {
      expectOwnerFailure(
        databases.upgrade,
        `INSERT INTO identity_link(
          id,workspace_id,canonical_type,canonical_id,raw_record_id,match_rule,confidence
        ) VALUES (
          gen_random_uuid(),'${WORKSPACE_A}','${canonicalType}','${canonicalId}',
          '${RAW_A}','target-negative',0.4
        );`,
        canonicalType === "organization"
          ? /IDENTITY_LINK_CANONICAL_TYPE_INVALID/u
          : /IDENTITY_LINK_CANONICAL_TARGET_INVALID/u,
      );
    }
    for (const target of [MISSING_TARGET, COMPANY_B]) {
      expectOwnerFailure(
        databases.upgrade,
        `UPDATE identity_link SET canonical_id='${target}' WHERE id='${LINK_APP_COMPANY}';`,
        /IDENTITY_LINK_CANONICAL_TARGET_INVALID/u,
      );
    }

    for (const [column, value] of [
      ["status", "'ACTIVE'"],
      ["resolver_version", "'identity-v1'"],
      ["input_hash", "'legacy'"],
      ["conflict_id", `'${MISSING_TARGET}'`],
      ["created_at", "now()"],
    ]) {
      const sql = `INSERT INTO identity_link(
        id,workspace_id,canonical_type,canonical_id,raw_record_id,
        match_rule,confidence,${column}
      ) VALUES (
        gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A4}',
        '${RAW_A}','acl-${column}',0.3,${value}
      );`;
      dockerPsql(databases.upgrade, asApp(WORKSPACE_A, sql), {
        rejects: /permission denied for table identity_link/u,
      });
    }
    for (const sql of [
      `UPDATE identity_link SET status='REVOKED' WHERE id='${LINK_APP_COMPANY}';`,
      `DELETE FROM identity_link WHERE id='${LINK_APP_COMPANY}';`,
      "TRUNCATE identity_link;",
    ]) {
      dockerPsql(databases.upgrade, asApp(WORKSPACE_A, sql), {
        rejects: /permission denied for table identity_link/u,
      });
    }
  });

  it("holds a canonical target key lock until the IdentityLink insert transaction ends", async () => {
    dockerPsql(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        `INSERT INTO canonical_company(
          id,workspace_id,name,domain,status,dedupe_key,version,created_at,updated_at
        ) VALUES (
          '${COMPANY_TARGET_LOCK}','${WORKSPACE_A}','Target Lock',
          'target-lock.example','NEW','target-lock',1,now(),now()
        );`,
      ),
    );
    const holder = await startIdentityTargetLockHolder(databases.upgrade);
    try {
      dockerPsql(
        databases.upgrade,
        `SET lock_timeout='1s';
         DELETE FROM canonical_company WHERE id='${COMPANY_TARGET_LOCK}';`,
        { rejects: /canceling statement due to lock timeout/u },
      );
    } finally {
      await releaseLockHolder(holder);
    }
  });

  it("keeps historical UUID stubs when committed company/contact targets are later deleted", () => {
    dockerPsql(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        `INSERT INTO canonical_company(
          id,workspace_id,name,domain,status,dedupe_key,version,created_at,updated_at
        ) VALUES
          ('${COMPANY_HISTORY_DIRECT}','${WORKSPACE_A}','History Direct',
           'history-direct.example','NEW','history-direct',1,now(),now()),
          ('${COMPANY_HISTORY_CASCADE}','${WORKSPACE_A}','History Cascade',
           'history-cascade.example','NEW','history-cascade',1,now(),now());
         INSERT INTO canonical_contact(
           id,workspace_id,company_id,full_name,title,seniority,department,
           dedupe_key,created_at
         ) VALUES (
           '${CONTACT_HISTORY_CASCADE}','${WORKSPACE_A}','${COMPANY_HISTORY_CASCADE}',
           'Historical Contact','CTO','c_level','Engineering',
           'historical-contact',now()
         );
         INSERT INTO identity_link(
           id,workspace_id,canonical_type,canonical_id,raw_record_id,
           match_rule,confidence
         ) VALUES
           ('${LINK_HISTORY_COMPANY}','${WORKSPACE_A}','company',
            '${COMPANY_HISTORY_DIRECT}','${RAW_A}','history-company',0.81),
           ('${LINK_HISTORY_CONTACT}','${WORKSPACE_A}','contact',
            '${CONTACT_HISTORY_CASCADE}','${RAW_A}','history-contact',0.82);`,
      ),
    );

    dockerPsql(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        `DELETE FROM canonical_company
         WHERE id IN ('${COMPANY_HISTORY_DIRECT}','${COMPANY_HISTORY_CASCADE}');`,
      ),
    );

    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT concat_ws('|',
          (SELECT count(*) FROM canonical_company
           WHERE id IN ('${COMPANY_HISTORY_DIRECT}','${COMPANY_HISTORY_CASCADE}')),
          (SELECT count(*) FROM canonical_contact
           WHERE id='${CONTACT_HISTORY_CASCADE}'),
          (SELECT count(*) FROM identity_link
           WHERE id IN ('${LINK_HISTORY_COMPANY}','${LINK_HISTORY_CONTACT}')),
          (SELECT count(*) FROM identity_link
           WHERE id='${LINK_HISTORY_COMPANY}'
             AND canonical_type='company'
             AND canonical_id='${COMPANY_HISTORY_DIRECT}'),
          (SELECT count(*) FROM identity_link
           WHERE id='${LINK_HISTORY_CONTACT}'
             AND canonical_type='contact'
             AND canonical_id='${CONTACT_HISTORY_CASCADE}')
        );`,
      ),
      "0|0|2|1|1",
    );
    expectOwnerFailure(
      databases.upgrade,
      `INSERT INTO identity_link(
        id,workspace_id,canonical_type,canonical_id,raw_record_id,
        match_rule,confidence
      ) VALUES (
        gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_HISTORY_DIRECT}',
        '${RAW_A}','post-delete-target',0.1
      );`,
      /IDENTITY_LINK_CANONICAL_TARGET_INVALID/u,
    );
  });

  it("allows only the complete IdentityLink status graph and immutable/no-delete rules", () => {
    const conflictId = "21000000-0000-4000-8000-000000000001";
    dockerPsql(
      databases.upgrade,
      asOwner(WORKSPACE_A, insertConflictSql({ id: conflictId })),
    );
    for (const [id, status, canonicalType, canonicalId] of [
      [LINK_PENDING_ACTIVE, "PENDING_CONFLICT", "company", COMPANY_A4],
      [LINK_PENDING_REVOKED, "PENDING_CONFLICT", "company", COMPANY_A5],
      [LINK_ACTIVE_INVALID, "ACTIVE", "company", COMPANY_A6],
    ]) {
      dockerPsql(
        databases.upgrade,
        asOwner(
          WORKSPACE_A,
          `INSERT INTO identity_link(
            id,workspace_id,canonical_type,canonical_id,raw_record_id,match_rule,
            confidence,status,resolver_version,input_hash,conflict_id
          ) VALUES (
            '${id}','${WORKSPACE_A}','${canonicalType}','${canonicalId}','${RAW_A}',
            '${id}',0.55,'${status}','identity-v1','legacy','${conflictId}'
          );`,
        ),
      );
    }
    dockerPsql(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        `UPDATE identity_link SET status=status WHERE id='${LINK_PENDING_ACTIVE}';
         UPDATE identity_link SET status='ACTIVE' WHERE id='${LINK_PENDING_ACTIVE}';
         UPDATE identity_link SET status='REVOKED' WHERE id='${LINK_PENDING_ACTIVE}';
         UPDATE identity_link SET status='REVOKED' WHERE id='${LINK_PENDING_REVOKED}';`,
      ),
    );
    expectOwnerFailure(
      databases.upgrade,
      `UPDATE identity_link SET status='ACTIVE' WHERE id='${LINK_PENDING_ACTIVE}';`,
      /IDENTITY_LINK_STATUS_TRANSITION_INVALID/u,
    );
    expectOwnerFailure(
      databases.upgrade,
      `UPDATE identity_link SET status='PENDING_CONFLICT' WHERE id='${LINK_ACTIVE_INVALID}';`,
      /IDENTITY_LINK_STATUS_TRANSITION_INVALID/u,
    );
    for (const assignment of [
      "match_rule='rewritten'",
      "confidence=0.1",
      "resolver_version='identity-v2'",
      `input_hash='${HASH_B}'`,
      "created_at=created_at + interval '1 second'",
      "conflict_id=NULL",
    ]) {
      expectOwnerFailure(
        databases.upgrade,
        `UPDATE identity_link SET ${assignment} WHERE id='${LINK_ACTIVE_INVALID}';`,
        /IDENTITY_LINK_IMMUTABLE/u,
      );
    }
    expectOwnerFailure(
      databases.upgrade,
      `DELETE FROM identity_link WHERE id='${LINK_ACTIVE_INVALID}';`,
      /IDENTITY_LINK_DELETE_FORBIDDEN/u,
    );
  });

  it("enforces OrganizationIdentifier transitions, monotonic time, immutability and no delete", () => {
    const conflictId = "22000000-0000-4000-8000-000000000001";
    const pendingActive = "22000000-0000-4000-8000-000000000002";
    const pendingRevoked = "22000000-0000-4000-8000-000000000003";
    const activeRevoked = "22000000-0000-4000-8000-000000000004";
    dockerPsql(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        `${insertConflictSql({ id: conflictId })}
         INSERT INTO organization_identifier(
           id,workspace_id,company_id,scheme,jurisdiction,normalized_value,
           authority_provider_key,raw_record_id,conflict_id,confidence,
           normalizer_version,validator_version,provenance,status,
           first_seen_at,last_seen_at,created_at
         ) VALUES
           ('${pendingActive}','${WORKSPACE_A}','${COMPANY_A}','LEI','DE','lei-pa',
            'registry','${RAW_A}','${conflictId}',0.9,'n1','v1','{}','PENDING_CONFLICT',
            '2026-08-29T01:00:00Z','2026-08-29T01:00:00Z','2026-08-29T01:00:00Z'),
           ('${pendingRevoked}','${WORKSPACE_A}','${COMPANY_A2}','LEI','DE','lei-pr',
            'registry','${RAW_A}','${conflictId}',0.8,'n1','v1','{}','PENDING_CONFLICT',
            '2026-08-29T01:00:00Z','2026-08-29T01:00:00Z','2026-08-29T01:00:00Z'),
           ('${activeRevoked}','${WORKSPACE_A}','${COMPANY_A3}','LEI','DE','lei-ar',
            'registry','${RAW_A}',NULL,0.7,'n1','v1','{}','ACTIVE',
            '2026-08-29T01:00:00Z','2026-08-29T01:00:00Z','2026-08-29T01:00:00Z');
         UPDATE organization_identifier SET status='ACTIVE',last_seen_at='2026-08-29T02:00:00Z'
           WHERE id='${pendingActive}';
         UPDATE organization_identifier SET status='REVOKED',revoked_at='2026-08-29T03:00:00Z'
           WHERE id='${pendingRevoked}';
         UPDATE organization_identifier SET status='REVOKED',revoked_at='2026-08-29T03:00:00Z'
           WHERE id='${activeRevoked}';`,
      ),
    );
    expectOwnerFailure(
      databases.upgrade,
      `UPDATE organization_identifier SET last_seen_at='2026-08-29T00:00:00Z' WHERE id='${pendingActive}';`,
      /ORGANIZATION_IDENTIFIER_LAST_SEEN_REGRESSION/u,
    );
    expectOwnerFailure(
      databases.upgrade,
      `UPDATE organization_identifier SET status='ACTIVE',revoked_at=NULL WHERE id='${activeRevoked}';`,
      /ORGANIZATION_IDENTIFIER_STATUS_TRANSITION_INVALID/u,
    );
    expectOwnerFailure(
      databases.upgrade,
      `UPDATE organization_identifier SET status='PENDING_CONFLICT' WHERE id='${pendingActive}';`,
      /ORGANIZATION_IDENTIFIER_STATUS_TRANSITION_INVALID/u,
    );
    for (const assignment of [
      "normalized_value='rewritten'",
      "provenance='{}'::jsonb || '{\"changed\":true}'::jsonb",
      "created_at=created_at + interval '1 second'",
    ]) {
      expectOwnerFailure(
        databases.upgrade,
        `UPDATE organization_identifier SET ${assignment} WHERE id='${pendingActive}';`,
        /ORGANIZATION_IDENTIFIER_IMMUTABLE/u,
      );
    }
    expectOwnerFailure(
      databases.upgrade,
      `DELETE FROM organization_identifier WHERE id='${pendingActive}';`,
      /ORGANIZATION_IDENTIFIER_DELETE_FORBIDDEN/u,
    );
  });

  it("enforces conflict revisions/transitions plus party and decision append-only rules", () => {
    const legal = "23000000-0000-4000-8000-000000000001";
    const illegal = "23000000-0000-4000-8000-000000000002";
    const party = "23000000-0000-4000-8000-000000000003";
    const decision = "23000000-0000-4000-8000-000000000004";
    const resolvingIllegal = "23000000-0000-4000-8000-000000000005";
    dockerPsql(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        `${insertConflictSql({ id: legal })}
         ${insertConflictSql({ id: illegal })}
         ${insertConflictSql({ id: resolvingIllegal })}
         UPDATE organization_identity_conflict SET status='RESOLVING',revision=2
           WHERE id='${legal}';
         UPDATE organization_identity_conflict
           SET status='RESOLVED',revision=3,resolved_at='2026-08-29T04:00:00Z'
           WHERE id='${legal}';
         UPDATE organization_identity_conflict SET status='RESOLVING',revision=2
           WHERE id='${resolvingIllegal}';
         INSERT INTO organization_identity_conflict_party(
           id,workspace_id,conflict_id,company_id,role,created_at
         ) VALUES (
           '${party}','${WORKSPACE_A}','${illegal}','${COMPANY_A}','PRIMARY',now()
         );
         ${insertDecisionSql({
           id: decision,
           requestId: "conflict-append-only",
           action: "KEEP_SEPARATE",
           conflictId: illegal,
         })}`,
      ),
    );
    expectOwnerFailure(
      databases.upgrade,
      `UPDATE organization_identity_conflict SET status='RESOLVING',revision=3 WHERE id='${illegal}';`,
      /ORGANIZATION_IDENTITY_CONFLICT_REVISION_INVALID/u,
    );
    expectOwnerFailure(
      databases.upgrade,
      `UPDATE organization_identity_conflict SET status='RESOLVED',revision=2,resolved_at=now() WHERE id='${illegal}';`,
      /ORGANIZATION_IDENTITY_CONFLICT_STATUS_TRANSITION_INVALID/u,
    );
    expectOwnerFailure(
      databases.upgrade,
      `UPDATE organization_identity_conflict SET status='OPEN',revision=3 WHERE id='${resolvingIllegal}';`,
      /ORGANIZATION_IDENTITY_CONFLICT_STATUS_TRANSITION_INVALID/u,
    );
    expectOwnerFailure(
      databases.upgrade,
      `UPDATE organization_identity_conflict SET facts='{\"changed\":true}' WHERE id='${illegal}';`,
      /ORGANIZATION_IDENTITY_CONFLICT_IMMUTABLE/u,
    );
    expectOwnerFailure(
      databases.upgrade,
      `UPDATE organization_identity_conflict SET created_at=created_at + interval '1 second' WHERE id='${illegal}';`,
      /ORGANIZATION_IDENTITY_CONFLICT_IMMUTABLE/u,
    );
    expectOwnerFailure(
      databases.upgrade,
      `UPDATE organization_identity_conflict SET status='RESOLVING',revision=4,resolved_at=NULL WHERE id='${legal}';`,
      /ORGANIZATION_IDENTITY_CONFLICT_STATUS_TRANSITION_INVALID/u,
    );
    for (const [sql, expected] of [
      [
        `UPDATE organization_identity_conflict_party SET role=role WHERE id='${party}';`,
        /ORGANIZATION_IDENTITY_CONFLICT_PARTY_IMMUTABLE/u,
      ],
      [
        `UPDATE organization_identity_conflict_party SET created_at=created_at + interval '1 second' WHERE id='${party}';`,
        /ORGANIZATION_IDENTITY_CONFLICT_PARTY_IMMUTABLE/u,
      ],
      [
        `DELETE FROM organization_identity_conflict_party WHERE id='${party}';`,
        /ORGANIZATION_IDENTITY_CONFLICT_PARTY_DELETE_FORBIDDEN/u,
      ],
      [
        `UPDATE organization_identity_decision SET note='rewrite' WHERE id='${decision}';`,
        /ORGANIZATION_IDENTITY_DECISION_APPEND_ONLY/u,
      ],
      [
        `UPDATE organization_identity_decision SET created_at=created_at + interval '1 second' WHERE id='${decision}';`,
        /ORGANIZATION_IDENTITY_DECISION_APPEND_ONLY/u,
      ],
      [
        `DELETE FROM organization_identity_decision WHERE id='${decision}';`,
        /ORGANIZATION_IDENTITY_DECISION_DELETE_FORBIDDEN/u,
      ],
      [
        `DELETE FROM organization_identity_conflict WHERE id='${illegal}';`,
        /ORGANIZATION_IDENTITY_CONFLICT_DELETE_FORBIDDEN/u,
      ],
    ]) {
      expectOwnerFailure(databases.upgrade, sql, expected);
    }
  });

  it("validates mapping decisions before mutation and allows only ACTIVE to REVOKED +1", () => {
    const conflict = "24000000-0000-4000-8000-000000000001";
    const merge = "24000000-0000-4000-8000-000000000002";
    const wrongAction = "24000000-0000-4000-8000-000000000003";
    const wrongTarget = "24000000-0000-4000-8000-000000000004";
    const split = "24000000-0000-4000-8000-000000000005";
    const mapping = "24000000-0000-4000-8000-000000000006";
    const conflictB = "24000000-0000-4000-8000-000000000007";
    const wrongWorkspace = "24000000-0000-4000-8000-000000000008";
    const wrongSplitAction = "24000000-0000-4000-8000-000000000009";
    const wrongSplitWorkspace = "24000000-0000-4000-8000-000000000010";
    const mappingWrongSplitAction = "24000000-0000-4000-8000-000000000011";
    const mappingWrongSplitWorkspace = "24000000-0000-4000-8000-000000000012";
    const mappingRevisionJump = "24000000-0000-4000-8000-000000000013";
    const mappingMissingSplit = "24000000-0000-4000-8000-000000000014";
    dockerPsql(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        `${insertConflictSql({ id: conflict })}
         ${insertDecisionSql({ id: merge, requestId: "map-merge", action: "MERGE", conflictId: conflict, canonicalCompanyId: COMPANY_A2 })}
         ${insertDecisionSql({ id: wrongAction, requestId: "map-wrong-action", action: "KEEP_SEPARATE", conflictId: conflict })}
         ${insertDecisionSql({ id: wrongTarget, requestId: "map-wrong-target", action: "MERGE", conflictId: conflict, canonicalCompanyId: COMPANY_A3 })}
         ${insertDecisionSql({ id: split, requestId: "map-split", action: "SPLIT" })}
         ${insertDecisionSql({ id: wrongSplitAction, requestId: "map-wrong-split-action", action: "KEEP_SEPARATE", conflictId: conflict })}`,
      ),
    );
    dockerPsql(
      databases.upgrade,
      asOwner(
        WORKSPACE_B,
        `${insertConflictSql({ id: conflictB, workspaceId: WORKSPACE_B })}
         ${insertDecisionSql({
           id: wrongWorkspace,
           requestId: "map-wrong-workspace",
           action: "MERGE",
           workspaceId: WORKSPACE_B,
           conflictId: conflictB,
           canonicalCompanyId: COMPANY_B,
         })}
         ${insertDecisionSql({
           id: wrongSplitWorkspace,
           requestId: "map-wrong-split-workspace",
           action: "SPLIT",
           workspaceId: WORKSPACE_B,
         })}`,
      ),
    );
    for (const [decisionId, expected] of [
      [wrongAction, /ORGANIZATION_CANONICAL_MAPPING_DECISION_INVALID/u],
      [wrongTarget, /ORGANIZATION_CANONICAL_MAPPING_DECISION_INVALID/u],
      [wrongWorkspace, /ORGANIZATION_CANONICAL_MAPPING_DECISION_INVALID/u],
    ]) {
      expectOwnerFailure(
        databases.upgrade,
        `INSERT INTO organization_canonical_mapping(
          id,workspace_id,source_company_id,canonical_company_id,status,revision,
          merge_decision_id,created_at
        ) VALUES (
          gen_random_uuid(),'${WORKSPACE_A}','${COMPANY_A}','${COMPANY_A2}',
          'ACTIVE',1,'${decisionId}',now()
        );`,
        expected,
      );
    }
    dockerPsql(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        `INSERT INTO organization_canonical_mapping(
          id,workspace_id,source_company_id,canonical_company_id,status,revision,
          merge_decision_id,created_at
        ) VALUES (
          '${mapping}','${WORKSPACE_A}','${COMPANY_A}','${COMPANY_A2}',
          'ACTIVE',1,'${merge}','2026-08-29T06:00:00Z'
        );
        UPDATE organization_canonical_mapping
          SET status='REVOKED',revision=2,split_decision_id='${split}',
              revoked_at='2026-08-29T07:00:00Z'
          WHERE id='${mapping}';`,
      ),
    );
    dockerPsql(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        `INSERT INTO organization_canonical_mapping(
          id,workspace_id,source_company_id,canonical_company_id,status,revision,
          merge_decision_id,created_at
        ) VALUES
          ('${mappingWrongSplitAction}','${WORKSPACE_A}','${COMPANY_A3}',
           '${COMPANY_A2}','ACTIVE',1,'${merge}','2026-08-29T06:00:00Z'),
          ('${mappingWrongSplitWorkspace}','${WORKSPACE_A}','${COMPANY_A4}',
           '${COMPANY_A2}','ACTIVE',1,'${merge}','2026-08-29T06:00:00Z'),
          ('${mappingRevisionJump}','${WORKSPACE_A}','${COMPANY_A5}',
           '${COMPANY_A2}','ACTIVE',1,'${merge}','2026-08-29T06:00:00Z'),
          ('${mappingMissingSplit}','${WORKSPACE_A}','${COMPANY_A6}',
           '${COMPANY_A2}','ACTIVE',1,'${merge}','2026-08-29T06:00:00Z');`,
      ),
    );
    for (const [mappingId, revision, splitDecisionId, expected] of [
      [
        mappingWrongSplitAction,
        2,
        wrongSplitAction,
        /ORGANIZATION_CANONICAL_MAPPING_DECISION_INVALID/u,
      ],
      [
        mappingWrongSplitWorkspace,
        2,
        wrongSplitWorkspace,
        /ORGANIZATION_CANONICAL_MAPPING_DECISION_INVALID/u,
      ],
      [
        mappingRevisionJump,
        3,
        split,
        /ORGANIZATION_CANONICAL_MAPPING_REVISION_INVALID/u,
      ],
      [
        mappingMissingSplit,
        2,
        null,
        /ORGANIZATION_CANONICAL_MAPPING_STATUS_TRANSITION_INVALID/u,
      ],
    ]) {
      expectOwnerFailure(
        databases.upgrade,
        `UPDATE organization_canonical_mapping
         SET status='REVOKED',revision=${revision},
             split_decision_id=${splitDecisionId ? `'${splitDecisionId}'` : "NULL"},
             revoked_at='2026-08-29T07:00:00Z'
         WHERE id='${mappingId}';`,
        expected,
      );
    }
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT count(*) FROM organization_canonical_mapping
         WHERE id IN (
           '${mappingWrongSplitAction}','${mappingWrongSplitWorkspace}',
           '${mappingRevisionJump}','${mappingMissingSplit}'
         ) AND status='ACTIVE' AND revision=1
           AND split_decision_id IS NULL AND revoked_at IS NULL;`,
      ),
      "4",
    );
    expectOwnerFailure(
      databases.upgrade,
      `UPDATE organization_canonical_mapping SET status='ACTIVE',revision=3,split_decision_id=NULL,revoked_at=NULL WHERE id='${mapping}';`,
      /ORGANIZATION_CANONICAL_MAPPING_STATUS_TRANSITION_INVALID/u,
    );
    expectOwnerFailure(
      databases.upgrade,
      `UPDATE organization_canonical_mapping SET canonical_company_id='${COMPANY_A3}' WHERE id='${mapping}';`,
      /ORGANIZATION_CANONICAL_MAPPING_DECISION_INVALID|ORGANIZATION_CANONICAL_MAPPING_IMMUTABLE/u,
    );
    expectOwnerFailure(
      databases.upgrade,
      `UPDATE organization_canonical_mapping SET created_at=created_at + interval '1 second' WHERE id='${mapping}';`,
      /ORGANIZATION_CANONICAL_MAPPING_IMMUTABLE/u,
    );
    expectOwnerFailure(
      databases.upgrade,
      `DELETE FROM organization_canonical_mapping WHERE id='${mapping}';`,
      /ORGANIZATION_CANONICAL_MAPPING_DELETE_FORBIDDEN/u,
    );
  });

  it("validates replay decision hash, claim/completion graph, shape, time and terminal state", () => {
    const decisionSuccess = "25000000-0000-4000-8000-000000000001";
    const decisionRetry = "25000000-0000-4000-8000-000000000002";
    const decisionIllegal = "25000000-0000-4000-8000-000000000003";
    const replaySuccess = "25000000-0000-4000-8000-000000000004";
    const replayRetry = "25000000-0000-4000-8000-000000000005";
    const replayIllegal = "25000000-0000-4000-8000-000000000006";
    dockerPsql(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        `${insertDecisionSql({ id: decisionSuccess, requestId: "replay-success", action: "SPLIT", decisionHash: HASH_A })}
         ${insertDecisionSql({ id: decisionRetry, requestId: "replay-retry", action: "SPLIT", decisionHash: HASH_B })}
         ${insertDecisionSql({ id: decisionIllegal, requestId: "replay-illegal", action: "SPLIT", decisionHash: HASH_C })}
         INSERT INTO organization_identity_replay(
           id,workspace_id,decision_id,status,attempt,input_hash,created_at,updated_at
         ) VALUES
           ('${replaySuccess}','${WORKSPACE_A}','${decisionSuccess}','PENDING',0,'${HASH_A}',
            '2026-08-29T08:00:00Z','2026-08-29T08:00:00Z'),
           ('${replayRetry}','${WORKSPACE_A}','${decisionRetry}','PENDING',0,'${HASH_B}',
            '2026-08-29T08:00:00Z','2026-08-29T08:00:00Z'),
           ('${replayIllegal}','${WORKSPACE_A}','${decisionIllegal}','PENDING',0,'${HASH_C}',
            '2026-08-29T08:00:00Z','2026-08-29T08:00:00Z');
         UPDATE organization_identity_replay
           SET status='RUNNING',attempt=1,updated_at='2026-08-29T09:00:00Z'
           WHERE id='${replaySuccess}';
         UPDATE organization_identity_replay
           SET status='SUCCEEDED',output_hash='${HASH_A}',completed_at='2026-08-29T10:00:00Z',updated_at='2026-08-29T10:00:00Z'
           WHERE id='${replaySuccess}';
         UPDATE organization_identity_replay
           SET status='RUNNING',attempt=1,updated_at='2026-08-29T09:00:00Z'
           WHERE id='${replayRetry}';
         UPDATE organization_identity_replay
           SET status='FAILED',error_code='TEMPORARY',completed_at='2026-08-29T10:00:00Z',updated_at='2026-08-29T10:00:00Z'
           WHERE id='${replayRetry}';
         UPDATE organization_identity_replay
           SET status='RUNNING',attempt=2,error_code=NULL,completed_at=NULL,updated_at='2026-08-29T11:00:00Z'
           WHERE id='${replayRetry}';`,
      ),
    );
    expectOwnerFailure(
      databases.upgrade,
      `INSERT INTO organization_identity_replay(
        id,workspace_id,decision_id,status,attempt,input_hash,created_at,updated_at
      ) VALUES (
        gen_random_uuid(),'${WORKSPACE_A}','${decisionIllegal}','PENDING',0,'${HASH_A}',now(),now()
      );`,
      /ORGANIZATION_IDENTITY_REPLAY_INPUT_HASH_MISMATCH/u,
    );
    expectOwnerFailure(
      databases.upgrade,
      `UPDATE organization_identity_replay SET input_hash='${HASH_A}' WHERE id='${replayIllegal}';`,
      /ORGANIZATION_IDENTITY_REPLAY_INPUT_HASH_MISMATCH/u,
    );
    expectOwnerFailure(
      databases.upgrade,
      `UPDATE organization_identity_replay SET status='RUNNING',attempt=2,updated_at='2026-08-29T09:00:00Z' WHERE id='${replayIllegal}';`,
      /ORGANIZATION_IDENTITY_REPLAY_ATTEMPT_INVALID/u,
    );
    expectOwnerFailure(
      databases.upgrade,
      `UPDATE organization_identity_replay SET status='PENDING',attempt=2 WHERE id='${replayRetry}';`,
      /ORGANIZATION_IDENTITY_REPLAY_STATUS_TRANSITION_INVALID/u,
    );
    expectOwnerFailure(
      databases.upgrade,
      `UPDATE organization_identity_replay SET status='FAILED',error_code='LATE',completed_at=now(),updated_at=now() WHERE id='${replaySuccess}';`,
      /ORGANIZATION_IDENTITY_REPLAY_STATUS_TRANSITION_INVALID/u,
    );
    expectOwnerFailure(
      databases.upgrade,
      `UPDATE organization_identity_replay SET updated_at='2026-08-29T07:00:00Z' WHERE id='${replayIllegal}';`,
      /ORGANIZATION_IDENTITY_REPLAY_TIMESTAMP_INVALID/u,
    );
    expectOwnerFailure(
      databases.upgrade,
      `UPDATE organization_identity_replay SET created_at=created_at + interval '1 second' WHERE id='${replayIllegal}';`,
      /ORGANIZATION_IDENTITY_REPLAY_IMMUTABLE/u,
    );
    expectOwnerFailure(
      databases.upgrade,
      `DELETE FROM organization_identity_replay WHERE id='${replayIllegal}';`,
      /ORGANIZATION_IDENTITY_REPLAY_DELETE_FORBIDDEN/u,
    );
  });

  it("rejects the compact replay illegal-edge, attempt and state-shape matrix", () => {
    const pendingDecision = "26000000-0000-4000-8000-000000000001";
    const runningDecision = "26000000-0000-4000-8000-000000000002";
    const failedDecision = "26000000-0000-4000-8000-000000000003";
    const succeededDecision = "26000000-0000-4000-8000-000000000004";
    const pendingReplay = "26000000-0000-4000-8000-000000000005";
    const runningReplay = "26000000-0000-4000-8000-000000000006";
    const failedReplay = "26000000-0000-4000-8000-000000000007";
    const succeededReplay = "26000000-0000-4000-8000-000000000008";
    const hashD = "d".repeat(64);
    const hashE = "e".repeat(64);
    const hashF = "f".repeat(64);
    const hashZero = "0".repeat(64);

    dockerPsql(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        `${insertDecisionSql({ id: pendingDecision, requestId: "matrix-pending", action: "SPLIT", decisionHash: hashD })}
         ${insertDecisionSql({ id: runningDecision, requestId: "matrix-running", action: "SPLIT", decisionHash: hashE })}
         ${insertDecisionSql({ id: failedDecision, requestId: "matrix-failed", action: "SPLIT", decisionHash: hashF })}
         ${insertDecisionSql({ id: succeededDecision, requestId: "matrix-succeeded", action: "SPLIT", decisionHash: hashZero })}
         INSERT INTO organization_identity_replay(
           id,workspace_id,decision_id,status,attempt,input_hash,created_at,updated_at
         ) VALUES
           ('${pendingReplay}','${WORKSPACE_A}','${pendingDecision}','PENDING',0,
            '${hashD}','2026-08-29T08:00:00Z','2026-08-29T08:00:00Z'),
           ('${runningReplay}','${WORKSPACE_A}','${runningDecision}','PENDING',0,
            '${hashE}','2026-08-29T08:00:00Z','2026-08-29T08:00:00Z'),
           ('${failedReplay}','${WORKSPACE_A}','${failedDecision}','PENDING',0,
            '${hashF}','2026-08-29T08:00:00Z','2026-08-29T08:00:00Z'),
           ('${succeededReplay}','${WORKSPACE_A}','${succeededDecision}','PENDING',0,
            '${hashZero}','2026-08-29T08:00:00Z','2026-08-29T08:00:00Z');
         UPDATE organization_identity_replay
           SET status='RUNNING',attempt=1,updated_at='2026-08-29T09:00:00Z'
           WHERE id IN ('${runningReplay}','${failedReplay}','${succeededReplay}');
         UPDATE organization_identity_replay
           SET status='FAILED',error_code='EXPECTED_FAILURE',
               completed_at='2026-08-29T10:00:00Z',updated_at='2026-08-29T10:00:00Z'
           WHERE id='${failedReplay}';
         UPDATE organization_identity_replay
           SET status='SUCCEEDED',output_hash='${hashZero}',
               completed_at='2026-08-29T10:00:00Z',updated_at='2026-08-29T10:00:00Z'
           WHERE id='${succeededReplay}';`,
      ),
    );

    for (const [sql, expected] of [
      [
        `UPDATE organization_identity_replay
         SET status='SUCCEEDED',attempt=0,output_hash='${hashD}',
             completed_at='2026-08-29T11:00:00Z',updated_at='2026-08-29T11:00:00Z'
         WHERE id='${pendingReplay}';`,
        /ORGANIZATION_IDENTITY_REPLAY_STATUS_TRANSITION_INVALID/u,
      ],
      [
        `UPDATE organization_identity_replay
         SET status='FAILED',attempt=0,error_code='DIRECT_FAILURE',
             completed_at='2026-08-29T11:00:00Z',updated_at='2026-08-29T11:00:00Z'
         WHERE id='${pendingReplay}';`,
        /ORGANIZATION_IDENTITY_REPLAY_STATUS_TRANSITION_INVALID/u,
      ],
      [
        `UPDATE organization_identity_replay
         SET status='PENDING',attempt=1,updated_at='2026-08-29T11:00:00Z'
         WHERE id='${runningReplay}';`,
        /ORGANIZATION_IDENTITY_REPLAY_STATUS_TRANSITION_INVALID/u,
      ],
      [
        `UPDATE organization_identity_replay
         SET status='PENDING',error_code=NULL,completed_at=NULL,
             updated_at='2026-08-29T11:00:00Z'
         WHERE id='${failedReplay}';`,
        /ORGANIZATION_IDENTITY_REPLAY_STATUS_TRANSITION_INVALID/u,
      ],
      [
        `UPDATE organization_identity_replay
         SET status='SUCCEEDED',output_hash='${hashF}',error_code=NULL,
             updated_at='2026-08-29T11:00:00Z'
         WHERE id='${failedReplay}';`,
        /ORGANIZATION_IDENTITY_REPLAY_STATUS_TRANSITION_INVALID/u,
      ],
      [
        `UPDATE organization_identity_replay
         SET status='PENDING',attempt=0,output_hash=NULL,completed_at=NULL,
             updated_at='2026-08-29T11:00:00Z'
         WHERE id='${succeededReplay}';`,
        /ORGANIZATION_IDENTITY_REPLAY_STATUS_TRANSITION_INVALID/u,
      ],
      [
        `UPDATE organization_identity_replay
         SET status='RUNNING',attempt=2,output_hash=NULL,completed_at=NULL,
             updated_at='2026-08-29T11:00:00Z'
         WHERE id='${succeededReplay}';`,
        /ORGANIZATION_IDENTITY_REPLAY_STATUS_TRANSITION_INVALID/u,
      ],
      [
        `UPDATE organization_identity_replay
         SET status='FAILED',output_hash=NULL,error_code='LATE_FAILURE',
             updated_at='2026-08-29T11:00:00Z'
         WHERE id='${succeededReplay}';`,
        /ORGANIZATION_IDENTITY_REPLAY_STATUS_TRANSITION_INVALID/u,
      ],
      [
        `UPDATE organization_identity_replay
         SET status='RUNNING',attempt=2,updated_at='2026-08-29T09:00:00Z'
         WHERE id='${pendingReplay}';`,
        /ORGANIZATION_IDENTITY_REPLAY_ATTEMPT_INVALID/u,
      ],
      [
        `UPDATE organization_identity_replay
         SET status='RUNNING',attempt=1,error_code=NULL,completed_at=NULL,
             updated_at='2026-08-29T11:00:00Z'
         WHERE id='${failedReplay}';`,
        /ORGANIZATION_IDENTITY_REPLAY_ATTEMPT_INVALID/u,
      ],
      [
        `UPDATE organization_identity_replay
         SET status='SUCCEEDED',attempt=2,output_hash='${hashE}',
             completed_at='2026-08-29T11:00:00Z',updated_at='2026-08-29T11:00:00Z'
         WHERE id='${runningReplay}';`,
        /ORGANIZATION_IDENTITY_REPLAY_ATTEMPT_INVALID/u,
      ],
      [
        `UPDATE organization_identity_replay
         SET status='RUNNING',attempt=1,output_hash='${hashD}',
             updated_at='2026-08-29T09:00:00Z'
         WHERE id='${pendingReplay}';`,
        /ORGANIZATION_IDENTITY_REPLAY_STATE_SHAPE_INVALID/u,
      ],
      [
        `UPDATE organization_identity_replay
         SET status='SUCCEEDED',output_hash=NULL,
             completed_at='2026-08-29T11:00:00Z',updated_at='2026-08-29T11:00:00Z'
         WHERE id='${runningReplay}';`,
        /ORGANIZATION_IDENTITY_REPLAY_STATE_SHAPE_INVALID/u,
      ],
      [
        `UPDATE organization_identity_replay
         SET status='SUCCEEDED',output_hash='${hashE}',error_code='UNEXPECTED',
             completed_at='2026-08-29T11:00:00Z',updated_at='2026-08-29T11:00:00Z'
         WHERE id='${runningReplay}';`,
        /ORGANIZATION_IDENTITY_REPLAY_STATE_SHAPE_INVALID/u,
      ],
      [
        `UPDATE organization_identity_replay
         SET status='SUCCEEDED',output_hash='${hashE}',completed_at=NULL,
             updated_at='2026-08-29T11:00:00Z'
         WHERE id='${runningReplay}';`,
        /ORGANIZATION_IDENTITY_REPLAY_STATE_SHAPE_INVALID/u,
      ],
      [
        `UPDATE organization_identity_replay
         SET status='FAILED',error_code=NULL,
             completed_at='2026-08-29T11:00:00Z',updated_at='2026-08-29T11:00:00Z'
         WHERE id='${runningReplay}';`,
        /ORGANIZATION_IDENTITY_REPLAY_STATE_SHAPE_INVALID/u,
      ],
      [
        `UPDATE organization_identity_replay
         SET status='FAILED',error_code='',
             completed_at='2026-08-29T11:00:00Z',updated_at='2026-08-29T11:00:00Z'
         WHERE id='${runningReplay}';`,
        /ORGANIZATION_IDENTITY_REPLAY_STATE_SHAPE_INVALID/u,
      ],
      [
        `UPDATE organization_identity_replay
         SET status='FAILED',output_hash='${hashE}',error_code='FAILURE',
             completed_at='2026-08-29T11:00:00Z',updated_at='2026-08-29T11:00:00Z'
         WHERE id='${runningReplay}';`,
        /ORGANIZATION_IDENTITY_REPLAY_STATE_SHAPE_INVALID/u,
      ],
      [
        `UPDATE organization_identity_replay
         SET status='FAILED',error_code='FAILURE',completed_at=NULL,
             updated_at='2026-08-29T11:00:00Z'
         WHERE id='${runningReplay}';`,
        /ORGANIZATION_IDENTITY_REPLAY_STATE_SHAPE_INVALID/u,
      ],
      [
        `UPDATE organization_identity_replay
         SET status='RUNNING',attempt=1,updated_at='2026-08-29T07:00:00Z'
         WHERE id='${pendingReplay}';`,
        /ORGANIZATION_IDENTITY_REPLAY_TIMESTAMP_INVALID/u,
      ],
      [
        `UPDATE organization_identity_replay
         SET status='SUCCEEDED',output_hash='${hashE}',
             completed_at='2026-08-29T12:00:00Z',updated_at='2026-08-29T11:00:00Z'
         WHERE id='${runningReplay}';`,
        /ORGANIZATION_IDENTITY_REPLAY_TIMESTAMP_INVALID/u,
      ],
    ]) {
      expectOwnerFailure(databases.upgrade, sql, expected);
    }

    for (const [attempt, outputHash] of [
      [1, null],
      [0, hashD],
    ]) {
      expectOwnerFailure(
        databases.upgrade,
        `INSERT INTO organization_identity_replay(
          id,workspace_id,decision_id,status,attempt,input_hash,output_hash,
          created_at,updated_at
        ) VALUES (
          gen_random_uuid(),'${WORKSPACE_A}','${pendingDecision}','PENDING',
          ${attempt},'${hashD}',${outputHash ? `'${outputHash}'` : "NULL"},
          '2026-08-29T08:00:00Z','2026-08-29T08:00:00Z'
        );`,
        /ORGANIZATION_IDENTITY_REPLAY_STATE_SHAPE_INVALID/u,
      );
    }
  });

  it("keeps all six tables SELECT-only and removes app/PUBLIC contract-function execution", () => {
    const tables = CONTRACT_TABLES.filter((table) => table !== "identity_link");
    const privileges = [
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "TRUNCATE",
      "REFERENCES",
      "TRIGGER",
    ];
    const tableValues = tables.map((table) => `('${table}')`).join(",");
    const privilegeValues = privileges
      .map((privilege) => `('${privilege}')`)
      .join(",");
    const actualTablePrivileges = dockerPsql(
      databases.upgrade,
      `WITH tables(table_name) AS (VALUES ${tableValues}),
       privileges(privilege_name) AS (VALUES ${privilegeValues})
       SELECT string_agg(
         table_name || '|' || privilege_name || '|' ||
         has_table_privilege(
           'app_user',format('public.%I',table_name),privilege_name
         )::text,
         E'\\n' ORDER BY table_name,privilege_name
       )
       FROM tables CROSS JOIN privileges;`,
    );
    const expectedTablePrivileges = [...tables]
      .sort()
      .flatMap((table) =>
        [...privileges]
          .sort()
          .map(
            (privilege) =>
              `${table}|${privilege}|${privilege === "SELECT" ? "true" : "false"}`,
          ),
      )
      .join("\n");
    assert.equal(actualTablePrivileges, expectedTablePrivileges);

    const functionValues = CONTRACT_FUNCTIONS.map(
      (functionName) => `('${functionName}')`,
    ).join(",");
    const actualFunctionPrivileges = dockerPsql(
      databases.upgrade,
      `WITH target_functions(function_name) AS (VALUES ${functionValues})
       SELECT string_agg(
         identity || '|' || app_execute::text || '|' || public_execute::text,
         E'\\n' ORDER BY identity
       )
       FROM (
         SELECT format('public.%I(%s)',procedure_record.proname,
                  pg_get_function_identity_arguments(procedure_record.oid)) AS identity,
           has_function_privilege(
             'app_user',procedure_record.oid,'EXECUTE'
           ) AS app_execute,
           COALESCE(bool_or(
             acl.grantee=0 AND acl.privilege_type='EXECUTE'
           ),false) AS public_execute
         FROM pg_proc AS procedure_record
         JOIN pg_namespace AS namespace ON namespace.oid=procedure_record.pronamespace
         JOIN target_functions ON target_functions.function_name=procedure_record.proname
         LEFT JOIN LATERAL aclexplode(COALESCE(
           procedure_record.proacl,acldefault('f',procedure_record.proowner)
         )) AS acl ON true
         WHERE namespace.nspname='public' AND procedure_record.pronargs=0
         GROUP BY procedure_record.oid,procedure_record.proname
       ) AS function_privileges;`,
    );
    assert.equal(
      actualFunctionPrivileges,
      CONTRACT_FUNCTIONS.map(
        (functionName) => `public.${functionName}()|false|false`,
      )
        .sort()
        .join("\n"),
    );
  });
});
