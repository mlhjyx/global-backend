import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { before, describe, it } from "node:test";

const CONTAINER = process.env.DISCOVERY_QUERY_LINEAGE_PG_CONTAINER;
const FRESH = process.env.DISCOVERY_QUERY_LINEAGE_FRESH_DB ?? "dql_fresh";
const UPGRADE = process.env.DISCOVERY_QUERY_LINEAGE_UPGRADE_DB ?? "dql_upgrade";
const TARGET = "20260830130000_discovery_query_lineage_schema";
const TABLES = [
  "discovery_query_receipt",
  "discovery_query_operation_attempt",
  "discovery_query_attempt_item",
];
const WS_A = "10000000-0000-4000-8000-000000000001";
const WS_B = "10000000-0000-4000-8000-000000000002";
const RUN_A = "20000000-0000-4000-8000-000000000001";
const RUN_B = "20000000-0000-4000-8000-000000000002";
const OP_A = "30000000-0000-4000-8000-000000000001";
const AUTH_A = "40000000-0000-4000-8000-000000000001";
const ACCOUNT_A = "50000000-0000-4000-8000-000000000001";
const RAW_A = "60000000-0000-4000-8000-000000000001";
const RAW_B = "60000000-0000-4000-8000-000000000002";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function args(database) {
  assert.match(CONTAINER ?? "", /^codex-dql-pg-[a-z0-9-]+$/);
  assert.ok([FRESH, UPGRADE].includes(database));
  return ["exec", "-i", CONTAINER, "psql", "-U", "global", "-d", database,
    "--no-psqlrc", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"];
}

function raw(database, sql) {
  return spawnSync("docker", args(database), {
    input: sql, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
}

function psql(database, sql) {
  const result = raw(database, sql);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}

function inventory(database) {
  return psql(database, `SELECT table_name||'|'||column_name||'|'||data_type||'|'||
    is_nullable||'|'||COALESCE(column_default,'') FROM information_schema.columns
    WHERE table_schema='public' AND table_name IN
      (${TABLES.map((table) => `'${table}'`).join(",")})
    ORDER BY table_name,ordinal_position;`);
}

function requireTables(database) {
  assert.equal(psql(database, `SELECT count(*) FROM information_schema.tables
    WHERE table_schema='public' AND table_name IN
      (${TABLES.map((table) => `'${table}'`).join(",")});`), "3",
  `DISCOVERY_QUERY_LINEAGE_TABLES_MISSING:${database}`);
}

function seedLineageFixtures(database) {
  psql(database, `SET session_replication_role=replica;
    INSERT INTO discovery_query_receipt(workspace_id,run_id,plan_id,authority_id,
      account_key,purpose,subject_type,subject_id,request_sha256,query_key,
      query_ordinal,source_class,providers,provider_count,record_count,
      accepted_count,quarantined_count,rejected_count,duplicate_count,
      governance_denied_count,usage_quantity,cost_cents,contract_sha256)
    VALUES
      ('${WS_A}','${RUN_A}','70000000-0000-4000-8000-000000000001','${AUTH_A}',
       'discovery.run:discovery_run:request:${HASH_A}:${HASH_A}','discovery.run',
       'discovery_run','request:${HASH_A}','${HASH_A}','${HASH_B}',0,
       'public_intelligence','["public_web"]',1,1,1,0,0,0,0,1,0,'${HASH_C}'),
      ('${WS_B}','${RUN_B}','70000000-0000-4000-8000-000000000002',
       '40000000-0000-4000-8000-000000000002',
       'discovery.run:discovery_run:request:${HASH_B}:${HASH_B}','discovery.run',
       'discovery_run','request:${HASH_B}','${HASH_B}','${HASH_A}',0,
       'public_intelligence','[]',0,0,0,0,0,0,0,0,0,'${HASH_C}')
    ON CONFLICT DO NOTHING;
    INSERT INTO discovery_query_operation_attempt(workspace_id,run_id,query_key,
      provider_key,producer_id,operation_id,scope_key,authority_id,account_id,
      operation_generation,ack_id,consumer,domain_aggregate_type,domain_ack_key,
      domain_revision,result_digest,result_schema,lineage_schema,
      provider_record_count,covered_item_count,contract_sha256)
    VALUES ('${WS_A}','${RUN_A}','${HASH_B}','public_web','discovery.extract_company',
      '${OP_A}','${WS_A}','${AUTH_A}','${ACCOUNT_A}',1,'${HASH_A}',
      'PublicWebDiscoveryProvider.mineDomain','RawSourceRecord','${HASH_B}',
      '${HASH_C}','${HASH_A}','discovery-extract-company/v1',
      'discovery-company-result-lineage/v1',4,1,'${HASH_C}')
    ON CONFLICT DO NOTHING;
    INSERT INTO raw_source_record(id,workspace_id,run_id,provider_key,source_class,
      payload,ingest_version) VALUES
      ('${RAW_A}','${WS_A}','${RUN_A}','public_web','public_intelligence','{}','fixture/v1'),
      ('${RAW_B}','${WS_A}','${RUN_A}','public_web','public_intelligence','{}','fixture/v1')
    ON CONFLICT DO NOTHING;
    SET session_replication_role=origin;
    INSERT INTO discovery_query_attempt_item(id,workspace_id,run_id,query_key,
      provider_key,operation_id,record_index,resolution_kind,source_record_index,
      raw_record_id,raw_payload_hash,raw_ingest_status,relation_key,
      operation_subject_id,child_subject_id,relation_id,contract_sha256)
    VALUES ('80000000-0000-4000-8000-000000000001','${WS_A}','${RUN_A}','${HASH_B}',
      'public_web','${OP_A}',0,'INSERTED',NULL,'${RAW_A}','${HASH_A}','ACCEPTED',
      'discovery.raw_source_record:0','90000000-0000-4000-8000-000000000001',
      '90000000-0000-4000-8000-000000000002',
      '90000000-0000-4000-8000-000000000003','${HASH_C}')
    ON CONFLICT DO NOTHING;`);
}

describe("Discovery query lineage schema, RLS and upgrade parity", () => {
  before(() => {
    const identity = [FRESH, UPGRADE].map((database) => psql(database,
      `SELECT current_database()||'|'||(SELECT oid FROM pg_database
        WHERE datname=current_database())||'|'||current_user;`));
    assert.notEqual(identity[0], identity[1]);
    for (const database of [FRESH, UPGRADE]) {
      assert.equal(psql(database, `SELECT count(*) FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;`), "120");
      assert.equal(psql(database, `SELECT count(*) FROM _prisma_migrations
        WHERE migration_name='${TARGET}' AND finished_at IS NOT NULL
          AND rolled_back_at IS NULL;`), "1");
      assert.equal(psql(database, `SELECT count(*) FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN
          (${TABLES.map((table) => `'${table}'`).join(",")});`), "3");
    }
  });

  it("installs the complete three-table column matrix in fresh and upgrade databases", () => {
    for (const database of [FRESH, UPGRADE]) {
      const rows = inventory(database).split("\n");
      assert.equal(rows.length, 64);
      for (const required of [
        "discovery_query_receipt|workspace_id|uuid|NO|",
        "discovery_query_receipt|providers|jsonb|NO|",
        "discovery_query_receipt|record_count|bigint|NO|",
        "discovery_query_operation_attempt|operation_id|uuid|NO|",
        "discovery_query_operation_attempt|ack_id|character|NO|",
        "discovery_query_operation_attempt|covered_item_count|integer|NO|",
        "discovery_query_attempt_item|id|uuid|NO|",
        "discovery_query_attempt_item|source_record_index|integer|YES|",
        "discovery_query_attempt_item|raw_record_id|uuid|NO|",
        "discovery_query_attempt_item|relation_id|uuid|NO|",
      ]) assert.ok(rows.some((row) => row.startsWith(required)), required);
    }
    assert.equal(inventory(FRESH), inventory(UPGRADE));
  });

  it("locks primary, unique, tenant and real external foreign keys", () => {
    for (const database of [FRESH, UPGRADE]) {
      requireTables(database);
      const definitions = psql(database, `SELECT conrelid::regclass::text||'|'||contype::text||'|'||
        pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace
        AND conrelid IN (${TABLES.map((table) => `'public.${table}'::regclass`).join(",")})
        ORDER BY conrelid::regclass::text,contype,conname;`);
      for (const anchor of [
        "FOREIGN KEY (workspace_id, run_id) REFERENCES discovery_run(workspace_id, id)",
        "FOREIGN KEY (scope_key, operation_id) REFERENCES tool_budget_operation(scope_key, id)",
        "FOREIGN KEY (ack_id) REFERENCES execution_domain_ack(ack_id)",
        "FOREIGN KEY (workspace_id, raw_record_id) REFERENCES raw_source_record(workspace_id, id)",
        "FOREIGN KEY (workspace_id, run_id, query_key, provider_key, source_record_index, raw_record_id) REFERENCES discovery_query_attempt_item(workspace_id, run_id, query_key, provider_key, record_index, raw_record_id)",
        "UNIQUE (workspace_id, run_id, query_ordinal)",
        "UNIQUE (workspace_id, operation_id, relation_key)",
      ]) assert.match(
        definitions,
        new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      assert.doesNotMatch(definitions, /canonical_company|identity_link|opportunity/i);
    }
  });

  it("enforces checks for providers, attempt bounds, counts and REUSE_BATCH", () => {
    requireTables(FRESH);
    const checks = psql(FRESH, `SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE connamespace='public'::regnamespace AND contype='c'
      AND conrelid IN (${TABLES.map((table) => `'public.${table}'::regclass`).join(",")})
      ORDER BY conname;`);
    for (const pattern of [
      /provider_count.*0.*16/i,
      /jsonb_array_length\(providers\)/i,
      /covered_item_count.*4095/i,
      /record_count.*524160/i,
      /cost_cents.*1000000000/i,
      /resolution_kind.*INSERTED.*EXISTING.*REUSE_BATCH/i,
      /source_record_index.*record_index/i,
    ]) assert.match(checks, pattern);
    assert.equal(psql(FRESH, `SELECT
      discovery_query_providers_valid_v1('[]'),
      discovery_query_providers_valid_v1('["a-b","a.b","a_b"]'),
      discovery_query_providers_valid_v1('["a_b","a-b"]'),
      discovery_query_providers_valid_v1('["a-b","a-b"]'),
      discovery_query_providers_valid_v1('[1]'),
      discovery_query_providers_valid_v1(
        to_jsonb(ARRAY(SELECT 'p'||i FROM generate_series(1,17) i)));`),
      "t|t|f|f|f|f");
    assert.equal(psql(FRESH, `SELECT provolatile::text||'|'||
      array_to_string(proconfig,',') FROM pg_proc
      WHERE oid='public.discovery_query_providers_valid_v1(jsonb)'::regprocedure;`),
      "i|search_path=pg_catalog, public");
    assert.equal(psql(FRESH, `SELECT count(*) FROM aclexplode((SELECT proacl FROM pg_proc
      WHERE oid='public.discovery_query_providers_valid_v1(jsonb)'::regprocedure))
      WHERE grantee=0 OR grantee::regrole::text IN
        ('app_user','runtime_api','runtime_worker','runtime_outbox_relay',
         'execution_budget_platform_writer');`), "0");
  });

  it("uses FORCE RLS and exposes SELECT only to app_user", () => {
    for (const database of [FRESH, UPGRADE]) {
      requireTables(database);
      assert.equal(psql(database, `SELECT count(*) FROM pg_class WHERE relname IN
        (${TABLES.map((table) => `'${table}'`).join(",")})
        AND relrowsecurity AND relforcerowsecurity;`), "3");
      const policies = psql(database, `SELECT tablename||'|'||qual||'|'||with_check
        FROM pg_policies WHERE schemaname='public' AND tablename IN
          (${TABLES.map((table) => `'${table}'`).join(",")}) ORDER BY tablename;`);
      assert.equal((policies.match(/current_workspace_id/g) ?? []).length, 6);
      const acl = psql(database, `SELECT c.relname||'|'||
        CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END||'|'||x.privilege_type
        FROM pg_class c CROSS JOIN LATERAL
          aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x
        WHERE c.relname IN (${TABLES.map((table) => `'${table}'`).join(",")})
          AND (x.grantee=0 OR x.grantee::regrole::text IN
            ('app_user','execution_budget_platform_writer','runtime_api','runtime_worker','runtime_outbox_relay'))
        ORDER BY c.relname,x.grantee,x.privilege_type;`);
      assert.deepEqual(acl.split("\n"), TABLES.map((table) =>
        `${table}|app_user|SELECT`).sort());
    }
  });

  it("keeps all three tables append-only and workspace-isolated", () => {
    requireTables(FRESH);
    seedLineageFixtures(FRESH);
    assert.equal(psql(FRESH, `SELECT count(*) FROM pg_trigger trigger
      JOIN pg_proc function ON function.oid=trigger.tgfoid
      WHERE trigger.tgrelid IN
        (${TABLES.map((table) => `'public.${table}'::regclass`).join(",")})
        AND NOT trigger.tgisinternal AND trigger.tgenabled='O'
        AND trigger.tgtype=27
        AND function.proname='reject_discovery_query_lineage_mutation_v1';`), "3");
    for (const table of TABLES) {
      for (const statement of [`UPDATE ${table} SET workspace_id=workspace_id`,
        `DELETE FROM ${table}`]) {
        const denied = raw(FRESH, `SET SESSION AUTHORIZATION app_user; BEGIN;
          SELECT set_config('app.current_workspace_id',
            '10000000-0000-4000-8000-000000000001',true); ${statement}; ROLLBACK;`);
        assert.notEqual(denied.status, 0);
        assert.match(denied.stderr, /permission denied/);
      }
      for (const statement of [`UPDATE ${table} SET workspace_id=workspace_id`,
        `DELETE FROM ${table}`]) {
        const immutable = raw(FRESH, `BEGIN; ${statement}; ROLLBACK;`);
        assert.notEqual(immutable.status, 0);
        assert.match(immutable.stderr, /DISCOVERY_QUERY_LINEAGE_IMMUTABLE/);
      }
    }
    assert.equal(psql(FRESH, `SET SESSION AUTHORIZATION app_user; BEGIN;
      SET LOCAL app.current_workspace_id='${WS_A}';
      SELECT count(*) FROM discovery_query_receipt; ROLLBACK;`), "1");
    assert.equal(psql(FRESH, `SET SESSION AUTHORIZATION app_user; BEGIN;
      SET LOCAL app.current_workspace_id='${WS_B}';
      SELECT count(*) FROM discovery_query_receipt; ROLLBACK;`), "1");
    assert.equal(psql(FRESH, `SET SESSION AUTHORIZATION app_user;
      SELECT count(*) FROM discovery_query_receipt;`), "0");
  });

  it("requires REUSE_BATCH to reference the same provider-local Raw item", () => {
    requireTables(FRESH);
    seedLineageFixtures(FRESH);
    const item = (id, index, sourceIndex, rawId) => `INSERT INTO
      discovery_query_attempt_item(id,workspace_id,run_id,query_key,provider_key,
        operation_id,record_index,resolution_kind,source_record_index,raw_record_id,
        raw_payload_hash,raw_ingest_status,relation_key,operation_subject_id,
        child_subject_id,relation_id,contract_sha256)
      VALUES ('${id}','${WS_A}','${RUN_A}','${HASH_B}','public_web','${OP_A}',
        ${index},'REUSE_BATCH',${sourceIndex},'${rawId}','${HASH_A}','ACCEPTED',
        'discovery.raw_source_record:${index}',
        '90000000-0000-4000-8000-000000000001',
        '90000000-0000-4000-8000-000000000002',
        '90000000-0000-4000-8000-0000000000${String(index).padStart(2,"0")}',
        '${HASH_C}');`;
    psql(FRESH, item('80000000-0000-4000-8000-000000000002',1,0,RAW_A));
    for (const invalid of [
      item('80000000-0000-4000-8000-000000000003',2,1,RAW_B),
      item('80000000-0000-4000-8000-000000000004',3,2,RAW_A),
      item('80000000-0000-4000-8000-000000000005',4,4,RAW_A),
    ]) {
      const denied = raw(FRESH, invalid);
      assert.notEqual(denied.status, 0);
      assert.match(denied.stderr, /foreign key|check constraint/i);
    }
  });
});
