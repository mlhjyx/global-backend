import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { before, describe, it } from "node:test";

const CONTAINER = process.env.GOVERNED_RELATION_PG_CONTAINER;
const DATABASE = process.env.GOVERNED_RELATION_PG_DATABASE ?? "global_test";
const OWNER = process.env.GOVERNED_RELATION_PG_OWNER ?? "global";
const WORKSPACE_A = "71000000-0000-4000-8000-000000000001";
const WORKSPACE_B = "71000000-0000-4000-8000-000000000002";
const SUBJECT_A = "72000000-0000-4000-8000-000000000001";
const SUBJECT_B = "72000000-0000-4000-8000-000000000002";

const TABLES = Object.freeze([
  "governed_subject",
  "tool_operation_subject",
  "governed_subject_relation",
  "governed_subject_tombstone",
  "governed_subject_tombstone_audit",
]);

function requireContainer() {
  assert.match(CONTAINER ?? "", /^codex-gsr-pg-[a-z0-9-]+$/);
  return CONTAINER;
}

function dockerArgs() {
  return [
    "exec",
    "-i",
    requireContainer(),
    "psql",
    "-U",
    OWNER,
    "-d",
    DATABASE,
    "--no-psqlrc",
    "-X",
    "-qAt",
    "-v",
    "ON_ERROR_STOP=1",
  ];
}

function psql(sql, options = {}) {
  const result = spawnSync("docker", dockerArgs(), {
    encoding: "utf8",
    input: sql,
    maxBuffer: 8 * 1024 * 1024,
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

describe("governed subject relation schema PostgreSQL and RLS", () => {
  before(() => {
    const identity = psql(`SELECT current_database() || ':' || current_user;`);
    assert.equal(identity, `${DATABASE}:${OWNER}`);
    assert.match(DATABASE, /^(?:global_test|codex_gsr_[a-z0-9_]+)$/);
  });

  it("creates exactly the five locked tables with the required composite identities", () => {
    const tables = psql(`
      SELECT relname
      FROM pg_class
      WHERE relnamespace='public'::regnamespace
        AND relkind='r'
        AND relname IN (${TABLES.map((table) => `'${table}'`).join(",")})
      ORDER BY relname;
    `).split("\n").filter(Boolean);
    assert.deepEqual(tables, [...TABLES].sort());

    const requiredConstraints = [
      "governed_subject_workspace_subject_key",
      "governed_subject_workspace_id_key",
      "tool_operation_subject_workspace_operation_key",
      "tool_operation_subject_workspace_generation_subject_key",
      "governed_subject_relation_workspace_operation_relation_key",
      "governed_subject_tombstone_pkey",
      "governed_subject_tombstone_audit_pkey",
    ];
    const constraints = psql(`
      SELECT conname
      FROM pg_constraint
      WHERE connamespace='public'::regnamespace
        AND conname IN (${requiredConstraints.map((name) => `'${name}'`).join(",")})
      ORDER BY conname;
    `).split("\n").filter(Boolean);
    assert.deepEqual(constraints, [...requiredConstraints].sort());
  });

  it("enables and forces workspace RLS on every table", () => {
    const rows = psql(`
      SELECT relname || ':' || relrowsecurity || ':' || relforcerowsecurity
      FROM pg_class
      WHERE relnamespace='public'::regnamespace
        AND relname IN (${TABLES.map((table) => `'${table}'`).join(",")})
      ORDER BY relname;
    `).split("\n").filter(Boolean);
    assert.deepEqual(
      rows,
      [...TABLES].sort().map((table) => `${table}:t:t`),
    );

    const policies = psql(`
      SELECT tablename || ':' || policyname
      FROM pg_policies
      WHERE schemaname='public'
        AND tablename IN (${TABLES.map((table) => `'${table}'`).join(",")})
      ORDER BY tablename,policyname;
    `).split("\n").filter(Boolean);
    assert.deepEqual(
      policies,
      [...TABLES].sort().map((table) => `${table}:${table}_workspace_isolation`),
    );
  });

  it("grants no direct table privilege to app, platform writer or managed runtime roles", () => {
    const principals = [
      "app_user",
      "execution_budget_platform_writer",
      "runtime_api",
      "runtime_worker",
      "runtime_outbox_relay",
    ];
    const privileges = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
    const leaked = psql(`
      SELECT principal || ':' || target || ':' || privilege
      FROM unnest(ARRAY[${principals.map((principal) => `'${principal}'`).join(",")}]) principal
      CROSS JOIN unnest(ARRAY[${TABLES.map((table) => `'public.${table}'`).join(",")}]) target
      CROSS JOIN unnest(ARRAY[${privileges.map((privilege) => `'${privilege}'`).join(",")}]) privilege
      WHERE has_table_privilege(principal,target,privilege)
      ORDER BY 1;
    `);
    assert.equal(leaked, "");

    psql(asApp("SELECT count(*) FROM governed_subject;"), {
      rejects: /permission denied for table governed_subject/i,
    });
  });

  it("keeps every table append-only for app_user", () => {
    for (const table of TABLES) {
      psql(asApp(`UPDATE ${table} SET workspace_id=workspace_id WHERE false;`), {
        rejects: new RegExp(`permission denied for table ${table}`, "i"),
      });
      psql(asApp(`DELETE FROM ${table} WHERE false;`), {
        rejects: new RegExp(`permission denied for table ${table}`, "i"),
      });
    }
  });

  it("isolates workspaces even if a disposable probe temporarily receives SELECT", () => {
    psql(`
      INSERT INTO workspace(id,name,created_at,updated_at) VALUES
        ('${WORKSPACE_A}'::uuid,'GSR A',now(),now()),
        ('${WORKSPACE_B}'::uuid,'GSR B',now(),now())
      ON CONFLICT(id) DO NOTHING;
      INSERT INTO governed_subject(
        id,workspace_id,subject_type,subject_id,data_class,
        dsr_subject_type,dsr_subject_id,created_at
      ) VALUES
        (gen_random_uuid(),'${WORKSPACE_A}'::uuid,'test_subject','${SUBJECT_A}'::uuid,
          'NON_PERSONAL',NULL,NULL,now()),
        (gen_random_uuid(),'${WORKSPACE_B}'::uuid,'test_subject','${SUBJECT_B}'::uuid,
          'NON_PERSONAL',NULL,NULL,now())
      ON CONFLICT(workspace_id,subject_type,subject_id) DO NOTHING;
      GRANT SELECT ON TABLE governed_subject TO app_user;
    `);
    try {
      assert.equal(
        psql(asApp("SELECT subject_id FROM governed_subject ORDER BY subject_id;", WORKSPACE_A))
          .split("\n").filter(Boolean).at(-1),
        SUBJECT_A,
      );
      assert.equal(
        psql(asApp("SELECT subject_id FROM governed_subject ORDER BY subject_id;", WORKSPACE_B))
          .split("\n").filter(Boolean).at(-1),
        SUBJECT_B,
      );
    } finally {
      psql("REVOKE SELECT ON TABLE governed_subject FROM app_user;");
    }
  });
});
