import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { before, describe, it } from "node:test";

const CONTAINER = process.env.GOVERNED_RELATION_PG_CONTAINER;
const FRESH_DATABASE = process.env.GOVERNED_RELATION_PG_FRESH_DATABASE ?? "gsr_fresh";
const UPGRADE_DATABASE = process.env.GOVERNED_RELATION_PG_UPGRADE_DATABASE ?? "gsr_upgrade";
const OWNER = process.env.GOVERNED_RELATION_PG_OWNER ?? "global";
const MIGRATION = "20260830120000_governed_subject_relation_schema";
const DATABASES = Object.freeze([FRESH_DATABASE, UPGRADE_DATABASE]);
const WORKSPACE_A = "71000000-0000-4000-8000-000000000001";
const WORKSPACE_B = "71000000-0000-4000-8000-000000000002";

const TABLES = Object.freeze([
  "governed_subject",
  "tool_operation_subject",
  "governed_subject_relation",
  "governed_subject_tombstone",
  "governed_subject_tombstone_audit",
]);

const IDS = Object.freeze({
  rootA: "72000000-0000-4000-8000-000000000001",
  operationA: "72000000-0000-4000-8000-000000000002",
  childA: "72000000-0000-4000-8000-000000000003",
  rootB: "72000000-0000-4000-8000-000000000011",
  operationB: "72000000-0000-4000-8000-000000000012",
  childB: "72000000-0000-4000-8000-000000000013",
  authorityA: "73000000-0000-4000-8000-000000000001",
  authorityB: "73000000-0000-4000-8000-000000000011",
  accountA: "74000000-0000-4000-8000-000000000001",
  accountB: "74000000-0000-4000-8000-000000000011",
  physicalOperationA: "75000000-0000-4000-8000-000000000001",
  physicalOperationB: "75000000-0000-4000-8000-000000000011",
  deletionA: "76000000-0000-4000-8000-000000000001",
  deletionB: "76000000-0000-4000-8000-000000000011",
  relationA: "77000000-0000-4000-8000-000000000001",
  relationB: "77000000-0000-4000-8000-000000000011",
});

const EXPECTED_COLUMNS = Object.freeze({
  governed_subject: [
    "id:uuid:NO:gen_random_uuid()",
    "scope_key:character varying(200):NO:",
    "workspace_id:uuid:NO:",
    "subject_type:character varying(191):NO:",
    "subject_id:uuid:NO:",
    "data_class:character varying(16):NO:",
    "dsr_subject_type:character varying(191):YES:",
    "dsr_subject_id:uuid:YES:",
    "created_at:timestamp(3) with time zone:NO:CURRENT_TIMESTAMP",
  ],
  tool_operation_subject: [
    "subject_id:uuid:NO:", "scope_key:character varying(200):NO:",
    "workspace_id:uuid:NO:", "authority_id:uuid:NO:",
    "account_id:uuid:NO:", "operation_id:uuid:NO:",
    "operation_generation:integer:NO:", "root_subject_id:uuid:NO:",
    "ack_id:character(64):NO:", "result_digest:character(64):NO:",
    "created_at:timestamp(3) with time zone:NO:CURRENT_TIMESTAMP",
  ],
  governed_subject_relation: [
    "id:uuid:NO:gen_random_uuid()", "scope_key:character varying(200):NO:",
    "workspace_id:uuid:NO:", "authority_id:uuid:NO:",
    "account_id:uuid:NO:", "operation_id:uuid:NO:",
    "operation_generation:integer:NO:", "ack_id:character(64):NO:",
    "operation_subject_id:uuid:NO:", "parent_subject_id:uuid:NO:",
    "child_subject_id:uuid:NO:", "relation_key:character varying(200):NO:",
    "relation_kind:character varying(32):NO:",
    "source_ref_namespace:character varying(64):NO:",
    "source_ref_uuid:uuid:YES:", "source_ref_sha256:character(64):YES:",
    "contract_sha256:character(64):NO:",
    "created_at:timestamp(3) with time zone:NO:CURRENT_TIMESTAMP",
  ],
  governed_subject_tombstone: [
    "workspace_id:uuid:NO:", "governed_subject_id:uuid:NO:",
    "tombstoned_at:timestamp(3) with time zone:NO:CURRENT_TIMESTAMP",
  ],
  governed_subject_tombstone_audit: [
    "deletion_request_id:uuid:NO:", "workspace_id:uuid:NO:",
    "governed_subject_id:uuid:NO:", "tombstoned_at:timestamp(3) with time zone:NO:",
  ],
});

function requireContainer() {
  assert.match(CONTAINER ?? "", /^codex-gsr-pg-[a-z0-9-]+$/);
  return CONTAINER;
}

function dockerArgs(database) {
  assert.match(database, /^gsr_(?:fresh|upgrade)$/);
  return [
    "exec", "-i", requireContainer(), "psql", "-U", OWNER, "-d", database,
    "--no-psqlrc", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
  ];
}

function psql(database, sql, options = {}) {
  const result = spawnSync("docker", dockerArgs(database), {
    encoding: "utf8", input: sql, maxBuffer: 16 * 1024 * 1024,
  });
  if (options.rejects) {
    assert.notEqual(result.status, 0, `SQL unexpectedly passed:\n${result.stdout}`);
    assert.match(`${result.stderr}\n${result.stdout}`, options.rejects);
    return "";
  }
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}

function asApp(sql, workspaceId = WORKSPACE_A) {
  return `
    SET SESSION AUTHORIZATION app_user;
    BEGIN;
    SELECT set_config('app.current_workspace_id', '${workspaceId}', true);
    ${sql}
    COMMIT;
  `;
}

function lines(value) {
  return value.split("\n").filter(Boolean);
}

function compact(value) {
  return value.replaceAll('"', "").replace(/\s+/g, " ").trim();
}

function columnInventory(database, table) {
  return lines(psql(database, `
    SELECT a.attname || ':' || pg_catalog.format_type(a.atttypid,a.atttypmod)
      || ':' || CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END
      || ':' || COALESCE(pg_get_expr(d.adbin,d.adrelid),'')
    FROM pg_attribute a
    JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relname='${table}'
      AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY a.attnum;
  `)).map(compact);
}

function constraintMap(database, table) {
  return new Map(lines(psql(database, `
    SELECT conname || E'\\t' || contype::text || E'\\t' || pg_get_constraintdef(oid,true)
    FROM pg_constraint
    WHERE conrelid='public.${table}'::regclass
    ORDER BY conname;
  `)).map((row) => {
    const [name, type, definition] = row.split("\t");
    return [name, `${type}:${compact(definition ?? "")}`];
  }));
}

function policy(database, table) {
  const row = psql(database, `
    SELECT COALESCE(qual,'') || E'\\t' || COALESCE(with_check,'')
    FROM pg_policies
    WHERE schemaname='public' AND tablename='${table}'
      AND policyname='${table}_workspace_isolation';
  `);
  const [using, check] = row.split("\t");
  return { using: compact(using ?? ""), check: compact(check ?? "") };
}

function exactWorkspaceExpression(value) {
  return compact(value).replace(/^\((.*)\)$/u, "$1") ===
    "workspace_id = current_workspace_id()";
}

function schemaInventory(database) {
  return psql(database, `
    WITH relations AS (
      SELECT c.oid,c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,
        pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')
    ), facts AS (
      SELECT 'relation:' || relname || ':' || relkind::text || ':' || owner || ':'
        || relrowsecurity::text || ':' || relforcerowsecurity::text AS fact FROM relations
      UNION ALL
      SELECT 'column:' || c.relname || ':' || a.attnum || ':' || a.attname || ':'
        || format_type(a.atttypid,a.atttypmod) || ':' || a.attnotnull || ':'
        || COALESCE(pg_get_expr(d.adbin,d.adrelid),'') AS fact
      FROM relations c
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      UNION ALL
      SELECT 'constraint:' || c.relname || ':' || k.conname || ':' || k.contype::text || ':'
        || pg_get_constraintdef(k.oid,true)
      FROM relations c JOIN pg_constraint k ON k.conrelid=c.oid
      UNION ALL
      SELECT 'index:' || tablename || ':' || indexname || ':' || indexdef
      FROM pg_indexes WHERE schemaname='public'
      UNION ALL
      SELECT 'policy:' || tablename || ':' || policyname || ':' || COALESCE(qual,'') || ':'
        || COALESCE(with_check,'')
      FROM pg_policies WHERE schemaname='public'
      UNION ALL
      SELECT 'function:' || p.proname || ':' || pg_get_function_identity_arguments(p.oid)
        || ':' || pg_get_function_result(p.oid) || ':' || p.provolatile::text || ':'
        || p.prosecdef::text || ':' || COALESCE(array_to_string(p.proconfig,','),'')
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public'
      UNION ALL
      SELECT 'trigger:' || c.relname || ':' || t.tgname || ':' || pg_get_triggerdef(t.oid,true)
      FROM pg_trigger t JOIN relations c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal
      UNION ALL
      SELECT 'enum:' || typ.typname || ':' || enum.enumsortorder || ':' || enum.enumlabel
      FROM pg_type typ JOIN pg_namespace n ON n.oid=typ.typnamespace
      JOIN pg_enum enum ON enum.enumtypid=typ.oid WHERE n.nspname='public'
      UNION ALL
      SELECT 'grant:' || table_name || ':' || grantee || ':' || privilege_type
      FROM information_schema.table_privileges WHERE table_schema='public'
    ) SELECT fact FROM facts ORDER BY fact;
  `);
}

function seedRlsRows(database) {
  const digestA = "a".repeat(64);
  const digestB = "b".repeat(64);
  psql(database, `
    INSERT INTO workspace(id,name,created_at,updated_at) VALUES
      ('${WORKSPACE_A}'::uuid,'GSR A',now(),now()),
      ('${WORKSPACE_B}'::uuid,'GSR B',now(),now()) ON CONFLICT(id) DO NOTHING;
    SET session_replication_role=replica;
    INSERT INTO governed_subject(id,scope_key,workspace_id,subject_type,subject_id,data_class,dsr_subject_type,dsr_subject_id,created_at) VALUES
      ('${IDS.rootA}'::uuid,'${WORKSPACE_A}','${WORKSPACE_A}'::uuid,'root_subject','81000000-0000-4000-8000-000000000001','NON_PERSONAL',NULL,NULL,now()),
      ('${IDS.operationA}'::uuid,'${WORKSPACE_A}','${WORKSPACE_A}'::uuid,'tool_operation','${IDS.physicalOperationA}','NON_PERSONAL',NULL,NULL,now()),
      ('${IDS.childA}'::uuid,'${WORKSPACE_A}','${WORKSPACE_A}'::uuid,'child_subject','82000000-0000-4000-8000-000000000001','PERSONAL','person','83000000-0000-4000-8000-000000000001',now()),
      ('${IDS.rootB}'::uuid,'${WORKSPACE_B}','${WORKSPACE_B}'::uuid,'root_subject','81000000-0000-4000-8000-000000000011','NON_PERSONAL',NULL,NULL,now()),
      ('${IDS.operationB}'::uuid,'${WORKSPACE_B}','${WORKSPACE_B}'::uuid,'tool_operation','${IDS.physicalOperationB}','NON_PERSONAL',NULL,NULL,now()),
      ('${IDS.childB}'::uuid,'${WORKSPACE_B}','${WORKSPACE_B}'::uuid,'child_subject','82000000-0000-4000-8000-000000000011','PERSONAL','person','83000000-0000-4000-8000-000000000011',now());
    INSERT INTO tool_operation_subject(subject_id,scope_key,workspace_id,authority_id,account_id,operation_id,operation_generation,root_subject_id,ack_id,result_digest,created_at) VALUES
      ('${IDS.operationA}','${WORKSPACE_A}','${WORKSPACE_A}','${IDS.authorityA}','${IDS.accountA}','${IDS.physicalOperationA}',1,'${IDS.operationA}','${digestA}','${digestA}',now()),
      ('${IDS.operationB}','${WORKSPACE_B}','${WORKSPACE_B}','${IDS.authorityB}','${IDS.accountB}','${IDS.physicalOperationB}',1,'${IDS.operationB}','${digestB}','${digestB}',now());
    INSERT INTO governed_subject_relation(id,scope_key,workspace_id,authority_id,account_id,operation_id,operation_generation,ack_id,operation_subject_id,parent_subject_id,child_subject_id,relation_key,relation_kind,source_ref_namespace,source_ref_uuid,source_ref_sha256,contract_sha256,created_at) VALUES
      ('${IDS.relationA}','${WORKSPACE_A}','${WORKSPACE_A}','${IDS.authorityA}','${IDS.accountA}','${IDS.physicalOperationA}',1,'${digestA}','${IDS.operationA}','${IDS.operationA}','${IDS.childA}','child:1','MATERIALIZED_CHILD','record','84000000-0000-4000-8000-000000000001',NULL,'${digestA}',now()),
      ('${IDS.relationB}','${WORKSPACE_B}','${WORKSPACE_B}','${IDS.authorityB}','${IDS.accountB}','${IDS.physicalOperationB}',1,'${digestB}','${IDS.operationB}','${IDS.operationB}','${IDS.childB}','child:1','MATERIALIZED_CHILD','record','84000000-0000-4000-8000-000000000011',NULL,'${digestB}',now());
    INSERT INTO governed_subject_tombstone(workspace_id,governed_subject_id,tombstoned_at) VALUES
      ('${WORKSPACE_A}','${IDS.childA}',now()),('${WORKSPACE_B}','${IDS.childB}',now());
    INSERT INTO governed_subject_tombstone_audit(deletion_request_id,workspace_id,governed_subject_id,tombstoned_at) VALUES
      ('${IDS.deletionA}','${WORKSPACE_A}','${IDS.childA}',now()),
      ('${IDS.deletionB}','${WORKSPACE_B}','${IDS.childB}',now());
    SET session_replication_role=origin;
  `);
}

function crossWorkspaceInsert(table) {
  const suffix = table.length.toString(16).padStart(12, "0");
  const id = `99000000-0000-4000-8000-${suffix}`;
  const digest = "c".repeat(64);
  const rows = {
    governed_subject: `INSERT INTO governed_subject(id,scope_key,workspace_id,subject_type,subject_id,data_class,dsr_subject_type,dsr_subject_id,created_at) VALUES ('${id}','${WORKSPACE_B}','${WORKSPACE_B}','probe_subject','${id}','NON_PERSONAL',NULL,NULL,now());`,
    tool_operation_subject: `INSERT INTO tool_operation_subject(subject_id,scope_key,workspace_id,authority_id,account_id,operation_id,operation_generation,root_subject_id,ack_id,result_digest,created_at) VALUES ('${id}','${WORKSPACE_B}','${WORKSPACE_B}','${IDS.authorityB}','${IDS.accountB}','${id}',1,'${id}','${digest}','${digest}',now());`,
    governed_subject_relation: `INSERT INTO governed_subject_relation(id,scope_key,workspace_id,authority_id,account_id,operation_id,operation_generation,ack_id,operation_subject_id,parent_subject_id,child_subject_id,relation_key,relation_kind,source_ref_namespace,source_ref_uuid,source_ref_sha256,contract_sha256,created_at) VALUES ('${id}','${WORKSPACE_B}','${WORKSPACE_B}','${IDS.authorityB}','${IDS.accountB}','${IDS.physicalOperationB}',1,'${digest}','${IDS.operationB}','${IDS.operationB}','${IDS.childB}','probe:${table.length}','MATERIALIZED_CHILD','probe','${id}',NULL,'${digest}',now());`,
    governed_subject_tombstone: `INSERT INTO governed_subject_tombstone(workspace_id,governed_subject_id,tombstoned_at) VALUES ('${WORKSPACE_B}','${IDS.rootB}',now());`,
    governed_subject_tombstone_audit: `INSERT INTO governed_subject_tombstone_audit(deletion_request_id,workspace_id,governed_subject_id,tombstoned_at) VALUES ('${id}','${WORKSPACE_B}','${IDS.childB}',now());`,
  };
  return rows[table];
}

describe("governed subject relation schema PostgreSQL and RLS", () => {
  before(() => {
    assert.notEqual(FRESH_DATABASE, UPGRADE_DATABASE);
    const identities = [];
    for (const database of DATABASES) {
      assert.equal(psql(database, "SELECT current_database() || ':' || current_user;"), `${database}:${OWNER}`);
      identities.push(psql(database, "SELECT oid::text FROM pg_database WHERE datname=current_database();"));
    }
    assert.notEqual(identities[0], identities[1], "fresh/upgrade database OIDs must differ");
  });

  it("binds upgrade provenance to a pre-Task1 baseline and applies the target migration exactly once", () => {
    const baseline = psql(UPGRADE_DATABASE, `
      SELECT database_name || E'\\t' || database_oid || E'\\t'
        || baseline_migration_count || E'\\t' || baseline_ledger_sha256
        || E'\\t' || target_migration_count || E'\\t' || target_table_count
      FROM gsr_harness.upgrade_baseline_attestation;
    `).split("\t");
    assert.equal(baseline[0], UPGRADE_DATABASE);
    assert.equal(
      baseline[1],
      psql(UPGRADE_DATABASE, "SELECT oid::text FROM pg_database WHERE datname=current_database();"),
    );
    assert.equal(baseline[4], "0");
    assert.equal(baseline[5], "0");

    const ledgers = DATABASES.map((database) => psql(database, `
      SELECT migration_name || ':' || checksum
      FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY migration_name;
    `));
    assert.equal(ledgers[0], ledgers[1]);
    const withoutTarget = lines(ledgers[1]).filter((line) => !line.startsWith(`${MIGRATION}:`)).join("\n");
    assert.equal(createHash("sha256").update(withoutTarget).digest("hex"), baseline[3]);
    assert.equal(Number(baseline[2]), lines(withoutTarget).length);
    for (const database of DATABASES) {
      assert.equal(psql(database, `
        SELECT count(*) FROM _prisma_migrations
        WHERE migration_name='${MIGRATION}' AND finished_at IS NOT NULL
          AND rolled_back_at IS NULL;
      `), "1");
    }
  });

  it("has a bidirectional zero diff and identical digest for the complete public schema catalog", () => {
    const inventories = DATABASES.map((database) => lines(schemaInventory(database)));
    assert.notEqual(inventories[0].length, 0);
    const fresh = new Set(inventories[0]);
    const upgrade = new Set(inventories[1]);
    assert.deepEqual([...fresh].filter((fact) => !upgrade.has(fact)), [], "fresh MINUS upgrade");
    assert.deepEqual([...upgrade].filter((fact) => !fresh.has(fact)), [], "upgrade MINUS fresh");
    const digests = inventories.map((facts) =>
      createHash("sha256").update(facts.join("\n")).digest("hex"));
    assert.equal(digests[0], digests[1]);
  });

  it("locks every pg_catalog column type, nullability and default in both databases", () => {
    for (const database of DATABASES) {
      for (const table of TABLES) {
        assert.deepEqual(columnInventory(database, table), EXPECTED_COLUMNS[table], `${database}:${table}`);
      }
    }
  });

  it("locks unique, composite FK and check semantics instead of constraint names alone", () => {
    for (const database of DATABASES) {
      const subject = constraintMap(database, "governed_subject");
      assert.match(subject.get("governed_subject_workspace_subject_key") ?? "", /u:UNIQUE \(workspace_id, subject_type, subject_id\)/);
      assert.match(subject.get("governed_subject_data_class_check") ?? "", /c:CHECK.*PERSONAL.*dsr_subject_type IS NOT NULL.*dsr_subject_id IS NOT NULL.*NON_PERSONAL.*dsr_subject_type IS NULL.*dsr_subject_id IS NULL/i);
      assert.match(subject.get("governed_subject_scope_check") ?? "", /c:CHECK.*scope_key.*workspace_id.*text/i);

      const operation = constraintMap(database, "tool_operation_subject");
      assert.match(operation.get("tool_operation_subject_workspace_operation_key") ?? "", /u:UNIQUE \(workspace_id, operation_id\)/);
      assert.match(operation.get("tool_operation_subject_workspace_generation_subject_key") ?? "", /u:UNIQUE \(workspace_id, operation_generation, subject_id\)/);
      assert.match(operation.get("tool_operation_subject_root_check") ?? "", /c:CHECK.*root_subject_id = subject_id/i);
      for (const [name, target] of [
        ["tool_operation_subject_authority_fkey", "execution_budget_authority(scope_key, id)"],
        ["tool_operation_subject_account_fkey", "tool_budget_account(scope_key, id)"],
        ["tool_operation_subject_operation_fkey", "tool_budget_operation(scope_key, id)"],
        ["tool_operation_subject_subject_fkey", "governed_subject(workspace_id, id)"],
        ["tool_operation_subject_root_fkey", "governed_subject(workspace_id, id)"],
        ["tool_operation_subject_ack_fkey", "execution_domain_ack(ack_id)"],
      ]) assert.ok((operation.get(name) ?? "").includes(target), `${database}:${name}`);

      const relation = constraintMap(database, "governed_subject_relation");
      assert.match(relation.get("governed_subject_relation_workspace_operation_relation_key") ?? "", /u:UNIQUE \(workspace_id, operation_id, relation_key\)/);
      assert.match(relation.get("governed_subject_relation_source_ref_check") ?? "", /c:CHECK.*source_ref_namespace.*source_ref_uuid IS NOT NULL.*source_ref_sha256 IS NULL.*source_ref_uuid IS NULL.*source_ref_sha256 IS NOT NULL/i);
      assert.match(relation.get("governed_subject_relation_source_namespace_check") ?? "", /c:CHECK.*source_ref_namespace.*\[a-z\].*a-z0-9_/i);
      assert.match(relation.get("governed_subject_relation_digest_check") ?? "", /c:CHECK.*contract_sha256.*\[0-9a-f\].*64/i);
      assert.match(relation.get("governed_subject_relation_kind_check") ?? "", /c:CHECK.*MATERIALIZED_CHILD.*DERIVED_FROM/i);
      assert.match(relation.get("governed_subject_relation_generation_check") ?? "", /c:CHECK.*operation_generation >= 1/i);
      assert.match(relation.get("governed_subject_relation_distinct_subjects_check") ?? "", /c:CHECK.*parent_subject_id.*child_subject_id/i);
    }
  });

  it("locks required index column order for DSR, operation root and reachability", () => {
    const expected = new Map([
      ["governed_subject_workspace_dsr_idx", "(workspace_id, dsr_subject_type, dsr_subject_id)"],
      ["tool_operation_subject_authority_operation_idx", "(scope_key, authority_id, account_id, operation_id, operation_generation)"],
      ["governed_subject_relation_operation_parent_idx", "(workspace_id, operation_id, parent_subject_id)"],
      ["governed_subject_relation_operation_child_idx", "(workspace_id, operation_id, child_subject_id)"],
      ["governed_subject_tombstone_workspace_time_idx", "(workspace_id, tombstoned_at)"],
      ["governed_subject_tombstone_audit_subject_idx", "(workspace_id, governed_subject_id, tombstoned_at)"],
    ]);
    for (const database of DATABASES) {
      const indexes = new Map(lines(psql(database, `
        SELECT indexname || E'\\t' || indexdef FROM pg_indexes
        WHERE schemaname='public' AND tablename IN (${TABLES.map((table) => `'${table}'`).join(",")});
      `)).map((row) => row.split("\t")));
      for (const [name, columns] of expected) assert.ok((indexes.get(name) ?? "").includes(columns), `${database}:${name}`);
    }
  });

  it("forces exact USING and WITH CHECK workspace policies on every table", () => {
    for (const database of DATABASES) {
      const rls = lines(psql(database, `
        SELECT relname || ':' || relrowsecurity || ':' || relforcerowsecurity
        FROM pg_class WHERE relnamespace='public'::regnamespace
          AND relname IN (${TABLES.map((table) => `'${table}'`).join(",")}) ORDER BY relname;
      `));
      assert.deepEqual(rls, [...TABLES].sort().map((table) => `${table}:t:t`));
      for (const table of TABLES) {
        const expressions = policy(database, table);
        assert.ok(exactWorkspaceExpression(expressions.using), `${database}:${table}:USING`);
        assert.ok(exactWorkspaceExpression(expressions.check), `${database}:${table}:WITH CHECK`);
      }
    }
  });

  it("mutation-kills same-named wrong constraints and USING true policies through pg_catalog", () => {
    const database = FRESH_DATABASE;
    const result = lines(psql(database, `
      BEGIN;
      CREATE SCHEMA gsr_mutation;
      CREATE TABLE gsr_mutation.constraint_probe(
        id uuid, workspace_id uuid, subject_type text, subject_id uuid,
        CONSTRAINT governed_subject_workspace_subject_key UNIQUE(id)
      );
      CREATE TABLE gsr_mutation.rls_probe(workspace_id uuid);
      ALTER TABLE gsr_mutation.rls_probe ENABLE ROW LEVEL SECURITY;
      ALTER TABLE gsr_mutation.rls_probe FORCE ROW LEVEL SECURITY;
      CREATE POLICY governed_subject_workspace_isolation ON gsr_mutation.rls_probe
        USING(true) WITH CHECK(true);
      SELECT pg_get_constraintdef(oid,true) FROM pg_constraint
        WHERE conrelid='gsr_mutation.constraint_probe'::regclass
          AND conname='governed_subject_workspace_subject_key';
      SELECT qual || E'\\t' || with_check FROM pg_policies
        WHERE schemaname='gsr_mutation' AND tablename='rls_probe';
      ROLLBACK;
    `));
    assert.equal(result[0], "UNIQUE (id)");
    assert.doesNotMatch(result[0], /workspace_id, subject_type, subject_id/);
    const [using, check] = result[1].split("\t");
    assert.equal(exactWorkspaceExpression(using), false);
    assert.equal(exactWorkspaceExpression(check), false);
  });

  it("rejects a distinct operation root and any missing or non-canonical source namespace", () => {
    const digest = "d".repeat(64);
    for (const database of DATABASES) {
      psql(database, `
        SET session_replication_role=replica;
        INSERT INTO tool_operation_subject(
          subject_id,scope_key,workspace_id,authority_id,account_id,operation_id,
          operation_generation,root_subject_id,ack_id,result_digest,created_at
        ) VALUES (
          '90000000-0000-4000-8000-000000000001','${WORKSPACE_A}','${WORKSPACE_A}',
          '${IDS.authorityA}','${IDS.accountA}','90000000-0000-4000-8000-000000000002',
          1,'90000000-0000-4000-8000-000000000003','${digest}','${digest}',now()
        );
      `, { rejects: /tool_operation_subject_root_check/i });
      psql(database, `
        SET session_replication_role=replica;
        INSERT INTO governed_subject_relation(
          id,scope_key,workspace_id,authority_id,account_id,operation_id,
          operation_generation,ack_id,operation_subject_id,parent_subject_id,
          child_subject_id,relation_key,relation_kind,source_ref_namespace,
          source_ref_uuid,source_ref_sha256,contract_sha256,created_at
        ) VALUES (
          '90000000-0000-4000-8000-000000000011','${WORKSPACE_A}','${WORKSPACE_A}',
          '${IDS.authorityA}','${IDS.accountA}','${IDS.physicalOperationA}',1,
          '${digest}','${IDS.operationA}','${IDS.operationA}','${IDS.childA}',
          'negative:missing_source','MATERIALIZED_CHILD',NULL,
          '90000000-0000-4000-8000-000000000012',NULL,'${digest}',now()
        );
      `, { rejects: /source_ref_namespace|null value/i });
      psql(database, `
        SET session_replication_role=replica;
        INSERT INTO governed_subject_relation(
          id,scope_key,workspace_id,authority_id,account_id,operation_id,
          operation_generation,ack_id,operation_subject_id,parent_subject_id,
          child_subject_id,relation_key,relation_kind,source_ref_namespace,
          source_ref_uuid,source_ref_sha256,contract_sha256,created_at
        ) VALUES (
          '90000000-0000-4000-8000-000000000021','${WORKSPACE_A}','${WORKSPACE_A}',
          '${IDS.authorityA}','${IDS.accountA}','${IDS.physicalOperationA}',1,
          '${digest}','${IDS.operationA}','${IDS.operationA}','${IDS.childA}',
          'negative:uppercase_source','MATERIALIZED_CHILD','Not_Canonical',
          '90000000-0000-4000-8000-000000000022',NULL,'${digest}',now()
        );
      `, { rejects: /governed_subject_relation_source_namespace_check/i });
      psql(database, `
        SET session_replication_role=replica;
        INSERT INTO governed_subject_relation(
          id,scope_key,workspace_id,authority_id,account_id,operation_id,
          operation_generation,ack_id,operation_subject_id,parent_subject_id,
          child_subject_id,relation_key,relation_kind,source_ref_namespace,
          source_ref_uuid,source_ref_sha256,contract_sha256,created_at
        ) VALUES (
          '90000000-0000-4000-8000-000000000031','${WORKSPACE_A}','${WORKSPACE_A}',
          '${IDS.authorityA}','${IDS.accountA}','${IDS.physicalOperationA}',1,
          '${digest}','${IDS.operationA}','${IDS.operationA}','${IDS.childA}',
          'negative:empty_source_union','MATERIALIZED_CHILD','record',
          NULL,NULL,'${digest}',now()
        );
      `, { rejects: /governed_subject_relation_source_ref_check/i });
      psql(database, `
        SET session_replication_role=replica;
        INSERT INTO governed_subject_relation(
          id,scope_key,workspace_id,authority_id,account_id,operation_id,
          operation_generation,ack_id,operation_subject_id,parent_subject_id,
          child_subject_id,relation_key,relation_kind,source_ref_namespace,
          source_ref_uuid,source_ref_sha256,contract_sha256,created_at
        ) VALUES (
          '90000000-0000-4000-8000-000000000041','${WORKSPACE_A}','${WORKSPACE_A}',
          '${IDS.authorityA}','${IDS.accountA}','${IDS.physicalOperationA}',1,
          '${digest}','${IDS.operationA}','${IDS.operationA}','${IDS.childA}',
          'negative:double_source_union','MATERIALIZED_CHILD','record',
          '90000000-0000-4000-8000-000000000042','${digest}','${digest}',now()
        );
      `, { rejects: /governed_subject_relation_source_ref_check/i });
    }
  });

  it("attests app_user as an unprivileged no-SET-ROLE session principal", () => {
    for (const database of DATABASES) {
      const principal = psql(database, asApp(`
        SELECT session_user || ':' || current_user || ':' || current_setting('role',true)
          || ':' || rolsuper || ':' || rolbypassrls
        FROM pg_roles WHERE rolname=session_user;
      `));
      assert.equal(principal.split("\n").at(-1), "app_user:app_user:none:false:false");
      psql(database, asApp(`SET ROLE ${OWNER};`), { rejects: /permission denied to set role/i });
    }
  });

  it("keeps app_user non-owner and denies direct table access for every managed principal", () => {
    const privileges = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
    for (const database of DATABASES) {
      assert.equal(psql(database, "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.governed_subject'::regclass;"), OWNER);
      for (const role of ["app_user", "execution_budget_platform_writer", "runtime_api", "runtime_worker", "runtime_outbox_relay"]) {
        for (const table of TABLES) {
          for (const privilege of privileges) {
            assert.equal(psql(database, `SELECT has_table_privilege('${role}','public.${table}','${privilege}');`), "f");
          }
        }
      }
    }
  });

  it("blocks cross-workspace SELECT, INSERT, UPDATE and DELETE on all five tables", () => {
    for (const database of DATABASES) {
      seedRlsRows(database);
      psql(database, `GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE ${TABLES.join(",")} TO app_user;`);
      try {
        for (const table of TABLES) {
          assert.equal(psql(database, asApp(`SELECT count(*) FROM ${table} WHERE workspace_id='${WORKSPACE_B}';`)).split("\n").at(-1), "0");
          psql(database, asApp(crossWorkspaceInsert(table)), { rejects: /new row violates row-level security policy/i });
          psql(database, asApp(`UPDATE ${table} SET workspace_id='${WORKSPACE_B}' WHERE workspace_id='${WORKSPACE_A}';`), { rejects: /new row violates row-level security policy/i });
          assert.equal(psql(database, asApp(`WITH removed AS (DELETE FROM ${table} WHERE workspace_id='${WORKSPACE_B}' RETURNING 1) SELECT count(*) FROM removed;`)).split("\n").at(-1), "0");
        }
      } finally {
        psql(database, `REVOKE SELECT,INSERT,UPDATE,DELETE ON TABLE ${TABLES.join(",")} FROM app_user;`);
      }
    }
  });
});
