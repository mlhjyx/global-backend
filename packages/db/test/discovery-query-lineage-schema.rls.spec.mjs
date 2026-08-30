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

describe("Discovery query lineage schema, RLS and upgrade parity", () => {
  before(() => {
    const identity = [FRESH, UPGRADE].map((database) => psql(database,
      `SELECT current_database()||'|'||(SELECT oid FROM pg_database
        WHERE datname=current_database())||'|'||current_user;`));
    assert.notEqual(identity[0], identity[1]);
    for (const database of [FRESH, UPGRADE]) {
      assert.equal(psql(database, `SELECT count(*) FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;`), "119");
      assert.equal(psql(database, `SELECT count(*) FROM _prisma_migrations
        WHERE migration_name='${TARGET}';`), "0");
      assert.equal(psql(database, `SELECT count(*) FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN
          (${TABLES.map((table) => `'${table}'`).join(",")});`), "0");
    }
  });

  it("installs the complete three-table column matrix in fresh and upgrade databases", () => {
    for (const database of [FRESH, UPGRADE]) {
      const rows = inventory(database).split("\n");
      assert.equal(rows.length, 59);
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
      const definitions = psql(database, `SELECT conrelid::regclass::text||'|'||contype||'|'||
        pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace
        AND conrelid IN (${TABLES.map((table) => `'public.${table}'::regclass`).join(",")})
        ORDER BY conrelid::regclass::text,contype,conname;`);
      for (const anchor of [
        "FOREIGN KEY (workspace_id, run_id) REFERENCES discovery_run(workspace_id, id)",
        "FOREIGN KEY (scope_key, operation_id) REFERENCES tool_budget_operation(scope_key, id)",
        "FOREIGN KEY (ack_id) REFERENCES execution_domain_ack(ack_id)",
        "FOREIGN KEY (workspace_id, raw_record_id) REFERENCES raw_source_record(workspace_id, id)",
        "UNIQUE (workspace_id, run_id, query_ordinal)",
        "UNIQUE (workspace_id, operation_id, relation_key)",
      ]) assert.match(definitions, new RegExp(anchor.replace(/[()]/g, "\\$&")));
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
      assert.deepEqual(acl.split("\n"), TABLES.map((table) => `${table}|app_user|SELECT`));
    }
  });

  it("keeps all three tables append-only and workspace-isolated", () => {
    requireTables(FRESH);
    for (const table of TABLES) {
      for (const statement of [`UPDATE ${table} SET workspace_id=workspace_id`,
        `DELETE FROM ${table}`]) {
        const denied = raw(FRESH, `SET SESSION AUTHORIZATION app_user; BEGIN;
          SELECT set_config('app.current_workspace_id',
            '10000000-0000-4000-8000-000000000001',true); ${statement}; ROLLBACK;`);
        assert.notEqual(denied.status, 0);
        assert.match(denied.stderr, /permission denied/);
      }
    }
  });
});
