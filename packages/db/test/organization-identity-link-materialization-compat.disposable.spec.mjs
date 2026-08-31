import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { materializePinnedPrismaStage } from "./helpers/pinned-prisma-stage.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const exactMain = "c998ca7f07af0fc8f3a1687c140aa8105c9567a0";
const currentSchemaPath = resolve(
  repositoryRoot,
  "packages/db/prisma/schema.prisma",
);
const migrationName =
  "20260830130600_organization_identity_link_materialization_compat";
const migrationPath = resolve(
  repositoryRoot,
  "packages/db/prisma/migrations",
  migrationName,
  "migration.sql",
);
const topology = Object.freeze({
  container: "codex-task6b-identity-authority-pg-20260830-a",
  containerId:
    "9ea3ae5bc1c34a074452e32d8d75c02c57e1cf1a84857fbe6c210a961776b915",
  network: "codex-task6b-identity-authority-net-20260830-a",
  volume:
    "164e3d2bdb7eb4abd0c433ea69076572281db2acd95eb33b0e3d5c288a6fa1e1",
});
const databases = Object.freeze({
  fresh: "task_a7_identity_link_fresh",
  upgrade: "task_a7_identity_link_upgrade",
  matrix: "task_a7_identity_link_matrix",
  multipleActive: "task_a7_identity_link_multiple_active",
  invalidOutcome: "task_a7_identity_link_invalid_outcome",
  catalogDrift: "task_a7_identity_link_catalog_drift",
  unknownDependency: "task_a7_identity_link_unknown_dependency",
});
const databaseSet = new Set(Object.values(databases));
const ids = Object.freeze({
  workspaceA: "a1000000-0000-4000-8000-000000000001",
  workspaceB: "a1000000-0000-4000-8000-000000000002",
  rawA: "a2000000-0000-4000-8000-000000000001",
  rawB: "a2000000-0000-4000-8000-000000000002",
  companyA: "a3000000-0000-4000-8000-000000000001",
  companyB: "a3000000-0000-4000-8000-000000000002",
  companyC: "a3000000-0000-4000-8000-000000000003",
  companyD: "a3000000-0000-4000-8000-000000000004",
  companyE: "a3000000-0000-4000-8000-000000000005",
  conflictA: "a4000000-0000-4000-8000-000000000001",
  conflictB: "a4000000-0000-4000-8000-000000000002",
  pendingA: "a5000000-0000-4000-8000-000000000001",
  pendingB: "a5000000-0000-4000-8000-000000000002",
  activeA: "a5000000-0000-4000-8000-000000000003",
  activeConflict: "a5000000-0000-4000-8000-000000000004",
  revokedA: "a5000000-0000-4000-8000-000000000005",
});

let mainStage;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function docker(args, input = "") {
  const result = run("docker", args, { input });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function psqlResult(database, statement) {
  assert.ok(database === "postgres" || databaseSet.has(database));
  return run(
    "docker",
    [
      "exec",
      "-i",
      topology.container,
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
    { input: statement },
  );
}

function psql(database, statement) {
  const result = psqlResult(database, statement);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function sqlFailure(database, statement, expected) {
  const result = psqlResult(database, statement);
  assert.notEqual(result.status, 0, "SQL unexpectedly succeeded");
  assert.match(`${result.stdout}\n${result.stderr}`, expected);
}

function dropDatabase(database) {
  assert.ok(databaseSet.has(database));
  psql(
    "postgres",
    `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
      WHERE datname='${database}' AND pid<>pg_backend_pid();
     DROP DATABASE IF EXISTS ${database};`,
  );
}

function createDatabase(database) {
  dropDatabase(database);
  psql("postgres", `CREATE DATABASE ${database};`);
}

function databaseUrl(database) {
  assert.ok(databaseSet.has(database));
  return `postgresql://global:global@127.0.0.1:55441/${database}?schema=public`;
}

function deploy(schemaPath, database) {
  const result = run(
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
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl(database),
        PRISMA_HIDE_UPDATE_MESSAGE: "true",
      },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`;
}

function prismaResidual(database) {
  const result = run(
    "pnpm",
    [
      "--filter",
      "@global/db",
      "exec",
      "prisma",
      "migrate",
      "diff",
      "--from-url",
      databaseUrl(database),
      "--to-schema-datamodel",
      currentSchemaPath,
      "--script",
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl(database),
        PRISMA_HIDE_UPDATE_MESSAGE: "true",
      },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(
    result.stdout,
    /identity_link_company_raw_unique|validate_discovery_company_materialization_identity_link_v1|discovery_company_materialization_outcome_identity_link/u,
  );
  return result.stdout;
}

function migrationSql() {
  assert.ok(existsSync(migrationPath), `${migrationName} must exist`);
  return readFileSync(migrationPath, "utf8");
}

function applyMigration(database) {
  const result = psqlResult(database, migrationSql());
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function migrationFailure(database, expected) {
  const result = psqlResult(database, migrationSql());
  assert.notEqual(result.status, 0, "compat migration unexpectedly succeeded");
  assert.match(`${result.stdout}\n${result.stderr}`, expected);
}

function createMinimalCatalog(
  database,
  { predicate = "canonical_type='company'", extensionDependency = false } = {},
) {
  createDatabase(database);
  psql(
    database,
    `CREATE TYPE public.identity_link_status AS ENUM (
       'ACTIVE','PENDING_CONFLICT','REVOKED'
     );
     CREATE TABLE public.identity_link (
       id uuid PRIMARY KEY,
       workspace_id uuid NOT NULL,
       canonical_type text NOT NULL,
       canonical_id uuid NOT NULL,
       raw_record_id uuid NOT NULL,
       status public.identity_link_status NOT NULL,
       conflict_id uuid
     );
     CREATE UNIQUE INDEX identity_link_workspace_canonical_raw_key
       ON public.identity_link(
         workspace_id,canonical_type,canonical_id,raw_record_id
       );
     CREATE UNIQUE INDEX identity_link_company_raw_unique
       ON public.identity_link(workspace_id,raw_record_id)
       WHERE ${predicate};
     CREATE TABLE public.discovery_company_materialization_outcome (
       workspace_id uuid NOT NULL,
       query_item_id uuid NOT NULL,
       outcome varchar(64) NOT NULL,
       identity_link_id uuid,
       identity_canonical_type varchar(32),
       canonical_company_id uuid,
       raw_record_id uuid NOT NULL,
       PRIMARY KEY(workspace_id,query_item_id)
     );
     ${
       extensionDependency
         ? `CREATE TABLE public.task_a7_unknown_dependency(id integer);
     INSERT INTO pg_catalog.pg_depend(
       classid,objid,objsubid,refclassid,refobjid,refobjsubid,deptype
     ) VALUES (
       'pg_class'::regclass,
       'public.identity_link_company_raw_unique'::regclass,
       0,
       'pg_class'::regclass,
       'public.task_a7_unknown_dependency'::regclass,
       0,
       'n'
     );`
         : ""
     }`,
  );
}

function linkValues({
  id,
  workspaceId = ids.workspaceA,
  companyId,
  rawId = ids.rawA,
  status,
  conflictId = null,
}) {
  return `(
    '${id}','${workspaceId}','company','${companyId}','${rawId}',
    '${status}'::identity_link_status,
    ${conflictId === null ? "NULL" : `'${conflictId}'`}
  )`;
}

function insertOutcome(database, {
  queryItemId,
  outcome = "CANONICALIZED",
  workspaceId = ids.workspaceA,
  linkId,
  companyId,
  rawId = ids.rawA,
  canonicalType = "company",
}) {
  return psqlResult(
    database,
    `INSERT INTO public.discovery_company_materialization_outcome(
       workspace_id,query_item_id,outcome,identity_link_id,
       identity_canonical_type,canonical_company_id,raw_record_id
     ) VALUES (
       '${workspaceId}','${queryItemId}','${outcome}',
       ${linkId === null ? "NULL" : `'${linkId}'`},
       ${canonicalType === null ? "NULL" : `'${canonicalType}'`},
       ${companyId === null ? "NULL" : `'${companyId}'`},
       '${rawId}'
     );`,
  );
}

function inspectCompatCatalog(database) {
  assert.equal(
    psql(
      database,
      `SELECT index_row.indisunique||'|'||index_row.indisvalid||'|'||
              index_row.indisready||'|'||index_row.indislive||'|'||
              pg_get_expr(index_row.indpred,index_row.indrelid,true)
         FROM pg_index AS index_row
        WHERE index_row.indexrelid=
          'public.identity_link_company_raw_unique'::regclass;`,
    ),
    "true|true|true|true|(canonical_type = 'company'::text) AND (status = 'ACTIVE'::identity_link_status)",
  );
  assert.equal(
    psql(
      database,
      `SELECT p.prorettype::regtype::text||'|'||
              pg_get_userbyid(p.proowner)||'|'||p.prosecdef||'|'||
              array_to_string(p.proconfig,',')||'|'||
              has_function_privilege('PUBLIC',p.oid,'EXECUTE')||'|'||
              has_function_privilege('app_user',p.oid,'EXECUTE')
         FROM pg_proc AS p
         JOIN pg_namespace AS n ON n.oid=p.pronamespace
        WHERE n.nspname='public'
          AND p.proname=
            'validate_discovery_company_materialization_identity_link_v1'
          AND pg_get_function_identity_arguments(p.oid)='';`,
    ),
    "trigger|global|false|search_path=pg_catalog, public|false|false",
  );
  assert.equal(
    psql(
      database,
      `SELECT tgname||'|'||pg_get_triggerdef(oid,true)
         FROM pg_trigger
        WHERE tgrelid=
          'public.discovery_company_materialization_outcome'::regclass
          AND tgname=
            'discovery_company_materialization_outcome_identity_link'
          AND NOT tgisinternal;`,
    ),
    "discovery_company_materialization_outcome_identity_link|CREATE TRIGGER discovery_company_materialization_outcome_identity_link BEFORE INSERT OR UPDATE ON discovery_company_materialization_outcome FOR EACH ROW EXECUTE FUNCTION validate_discovery_company_materialization_identity_link_v1()",
  );
  assert.equal(
    psql(
      database,
      `SELECT count(*) FROM _prisma_migrations
        WHERE migration_name='${migrationName}'
          AND finished_at IS NOT NULL AND rolled_back_at IS NULL;`,
    ),
    "1",
  );
}

function requireExactTopology() {
  const container = JSON.parse(
    docker(["inspect", "--format", "{{json .}}", topology.container]),
  );
  assert.deepEqual(
    {
      id: container.Id,
      running: container.State.Running,
      ports: container.NetworkSettings.Ports,
      labels: container.Config.Labels,
      mounts: container.Mounts.map((mount) => ({
        type: mount.Type,
        name: mount.Name,
        destination: mount.Destination,
      })),
      networks: Object.keys(container.NetworkSettings.Networks),
    },
    {
      id: topology.containerId,
      running: true,
      ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55441" }] },
      labels: {
        "com.openai.codex.artifact": "identity-authority",
        "com.openai.codex.task": "organization-identity-command-expansion",
      },
      mounts: [
        {
          type: "volume",
          name: topology.volume,
          destination: "/var/lib/postgresql/data",
        },
      ],
      networks: [topology.network],
    },
  );
}

before(() => {
  requireExactTopology();
  mainStage = materializePinnedPrismaStage({
    repositoryRoot,
    commit: exactMain,
    prefix: "task-a7-link-exact-main-stage-",
  });
});

after(() => {
  for (const database of databaseSet) dropDatabase(database);
  if (mainStage?.root) {
    rmSync(mainStage.root, { recursive: true, force: true });
  }
});

describe("Organization Identity link/materialization compatibility", {
  concurrency: 1,
}, () => {
  it("deploys fresh/current-main upgrade twice with identical clean residual and exact catalog", () => {
    createDatabase(databases.fresh);
    deploy(currentSchemaPath, databases.fresh);
    assert.match(
      deploy(currentSchemaPath, databases.fresh),
      /No pending migrations to apply/u,
    );
    inspectCompatCatalog(databases.fresh);

    createDatabase(databases.upgrade);
    deploy(mainStage.schemaPath, databases.upgrade);
    assert.match(
      deploy(mainStage.schemaPath, databases.upgrade),
      /No pending migrations to apply/u,
    );
    deploy(currentSchemaPath, databases.upgrade);
    assert.match(
      deploy(currentSchemaPath, databases.upgrade),
      /No pending migrations to apply/u,
    );
    inspectCompatCatalog(databases.upgrade);

    assert.equal(
      prismaResidual(databases.fresh),
      prismaResidual(databases.upgrade),
    );
  });

  it("preserves party tuple uniqueness while admitting only one ACTIVE company link per Raw", () => {
    createMinimalCatalog(databases.matrix);
    applyMigration(databases.matrix);
    psql(
      databases.matrix,
      `INSERT INTO public.identity_link(
         id,workspace_id,canonical_type,canonical_id,raw_record_id,status,conflict_id
       ) VALUES
       ${linkValues({ id: ids.pendingA, companyId: ids.companyA, status: "PENDING_CONFLICT", conflictId: ids.conflictA })},
       ${linkValues({ id: ids.pendingB, companyId: ids.companyB, status: "PENDING_CONFLICT", conflictId: ids.conflictA })},
       ${linkValues({ id: ids.activeA, companyId: ids.companyC, status: "ACTIVE" })};`,
    );
    assert.equal(
      psql(
        databases.matrix,
        `SELECT string_agg(status::text,',' ORDER BY status::text)
           FROM identity_link WHERE raw_record_id='${ids.rawA}';`,
      ),
      "ACTIVE,PENDING_CONFLICT,PENDING_CONFLICT",
    );
    sqlFailure(
      databases.matrix,
      `INSERT INTO identity_link(
        id,workspace_id,canonical_type,canonical_id,raw_record_id,status,conflict_id
      ) VALUES ${linkValues({ id: ids.revokedA, companyId: ids.companyA, status: "PENDING_CONFLICT", conflictId: ids.conflictB })};`,
      /identity_link_workspace_canonical_raw_key/u,
    );
    sqlFailure(
      databases.matrix,
      `INSERT INTO identity_link(
        id,workspace_id,canonical_type,canonical_id,raw_record_id,status,conflict_id
      ) VALUES ${linkValues({ id: ids.revokedA, companyId: ids.companyD, status: "ACTIVE" })};`,
      /identity_link_company_raw_unique/u,
    );
    psql(
      databases.matrix,
      `UPDATE identity_link SET status='REVOKED'
        WHERE id='${ids.activeA}';
       INSERT INTO identity_link(
         id,workspace_id,canonical_type,canonical_id,raw_record_id,status,conflict_id
       ) VALUES ${linkValues({ id: ids.revokedA, companyId: ids.companyD, status: "ACTIVE" })};`,
    );
    assert.equal(
      psql(
        databases.matrix,
        `SELECT count(*) FILTER (WHERE status='ACTIVE')||'|'||
                count(*) FILTER (WHERE status='PENDING_CONFLICT')||'|'||
                count(*) FILTER (WHERE status='REVOKED')
           FROM identity_link WHERE raw_record_id='${ids.rawA}';`,
      ),
      "1|2|1",
    );
  });

  it("accepts only exact ACTIVE conflict-null CANONICALIZED identity links", () => {
    createMinimalCatalog(databases.matrix);
    applyMigration(databases.matrix);
    psql(
      databases.matrix,
      `INSERT INTO identity_link(
         id,workspace_id,canonical_type,canonical_id,raw_record_id,status,conflict_id
       ) VALUES
       ${linkValues({ id: ids.pendingA, companyId: ids.companyA, status: "PENDING_CONFLICT", conflictId: ids.conflictA })},
       ${linkValues({ id: ids.activeA, companyId: ids.companyB, status: "ACTIVE" })},
       ${linkValues({ id: ids.activeConflict, companyId: ids.companyC, rawId: ids.rawB, status: "ACTIVE", conflictId: ids.conflictB })},
       ${linkValues({ id: ids.revokedA, companyId: ids.companyD, rawId: ids.rawB, status: "REVOKED" })};`,
    );

    assert.equal(
      insertOutcome(databases.matrix, {
        queryItemId: "a6000000-0000-4000-8000-000000000001",
        linkId: ids.activeA,
        companyId: ids.companyB,
      }).status,
      0,
    );
    for (const [label, input] of [
      ["pending", { linkId: ids.pendingA, companyId: ids.companyA }],
      ["conflicted", { linkId: ids.activeConflict, companyId: ids.companyC, rawId: ids.rawB }],
      ["revoked", { linkId: ids.revokedA, companyId: ids.companyD, rawId: ids.rawB }],
      ["cross-workspace", { workspaceId: ids.workspaceB, linkId: ids.activeA, companyId: ids.companyB }],
      ["wrong-raw", { linkId: ids.activeA, companyId: ids.companyB, rawId: ids.rawB }],
      ["wrong-company", { linkId: ids.activeA, companyId: ids.companyE }],
    ]) {
      const result = insertOutcome(databases.matrix, {
        queryItemId: `a6000000-0000-4000-8000-${String(label.length).padStart(12, "0")}`,
        ...input,
      });
      assert.notEqual(result.status, 0, `${label} unexpectedly materialized`);
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /DOMAIN_ACK_DISCOVERY_COMPANY_IDENTITY_CONFLICT/u,
      );
    }
    assert.equal(
      insertOutcome(databases.matrix, {
        queryItemId: "a6000000-0000-4000-8000-000000000099",
        outcome: "SUPPRESSED",
        linkId: null,
        companyId: null,
        canonicalType: null,
      }).status,
      0,
    );
  });

  it("blocks multiple existing ACTIVE links before catalog replacement", () => {
    createMinimalCatalog(databases.multipleActive, {
      predicate: "canonical_type='contact'",
    });
    psql(
      databases.multipleActive,
      `INSERT INTO identity_link(
         id,workspace_id,canonical_type,canonical_id,raw_record_id,status,conflict_id
       ) VALUES
       ${linkValues({ id: ids.activeA, companyId: ids.companyA, status: "ACTIVE" })},
       ${linkValues({ id: ids.activeConflict, companyId: ids.companyB, status: "ACTIVE" })};`,
    );
    migrationFailure(
      databases.multipleActive,
      /IDENTITY_LINK_ACTIVE_DUPLICATE_INVENTORY_INVALID/u,
    );
  });

  it("blocks invalid existing CANONICALIZED outcomes before catalog replacement", () => {
    createMinimalCatalog(databases.invalidOutcome);
    psql(
      databases.invalidOutcome,
      `INSERT INTO identity_link(
         id,workspace_id,canonical_type,canonical_id,raw_record_id,status,conflict_id
       ) VALUES ${linkValues({ id: ids.pendingA, companyId: ids.companyA, status: "PENDING_CONFLICT", conflictId: ids.conflictA })};
       INSERT INTO discovery_company_materialization_outcome(
         workspace_id,query_item_id,outcome,identity_link_id,
         identity_canonical_type,canonical_company_id,raw_record_id
       ) VALUES (
         '${ids.workspaceA}','a7000000-0000-4000-8000-000000000001',
         'CANONICALIZED','${ids.pendingA}','company','${ids.companyA}','${ids.rawA}'
       );`,
    );
    migrationFailure(
      databases.invalidOutcome,
      /DOMAIN_ACK_DISCOVERY_COMPANY_IDENTITY_CONFLICT/u,
    );
  });

  it("blocks index catalog drift before replacement", () => {
    createMinimalCatalog(databases.catalogDrift, {
      predicate: "canonical_type='company' AND status='REVOKED'",
    });
    migrationFailure(
      databases.catalogDrift,
      /IDENTITY_LINK_COMPANY_RAW_INDEX_INVALID/u,
    );
  });

  it("blocks unknown index dependencies before replacement", () => {
    createMinimalCatalog(databases.unknownDependency, {
      extensionDependency: true,
    });
    migrationFailure(
      databases.unknownDependency,
      /IDENTITY_LINK_COMPANY_RAW_INDEX_DEPENDENCY_INVALID/u,
    );
  });
});
