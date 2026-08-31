import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { materializePinnedPrismaStage } from "./helpers/pinned-prisma-stage.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const exactMain = "c998ca7f07af0fc8f3a1687c140aa8105c9567a0";
const currentSchemaPath = resolve(
  repositoryRoot,
  "packages/db/prisma/schema.prisma",
);
const adoptionMigrationPath = resolve(
  repositoryRoot,
  "packages/db/prisma/migrations/20260830130500_organization_identity_mainline_constraint_adoption/migration.sql",
);
const topology = Object.freeze({
  container: "codex-task6b-identity-authority-pg-20260830-a",
  containerId:
    "9ea3ae5bc1c34a074452e32d8d75c02c57e1cf1a84857fbe6c210a961776b915",
  network: "codex-task6b-identity-authority-net-20260830-a",
  networkId: "14e022a6f17fd723013d2f73ba879927df097c2c3d383adee3381adda689153a",
  volume:
    "164e3d2bdb7eb4abd0c433ea69076572281db2acd95eb33b0e3d5c288a6fa1e1",
});
const databases = Object.freeze({
  fresh: "task_a7_identity_mainline_fresh",
  upgrade: "task_a7_identity_mainline_upgrade",
  seventh: "task_a7_identity_mainline_seventh",
  drift: "task_a7_identity_mainline_drift",
});
const databaseSet = new Set(Object.values(databases));
const expectedFinalCatalog = [
  "canonical_company_workspace_id_id_key|canonical_company|u|true|true|UNIQUE (workspace_id, id)",
  "discovery_company_materialization_outcome_company_fkey|discovery_company_materialization_outcome|f|true|true|FOREIGN KEY (workspace_id, canonical_company_id) REFERENCES canonical_company(workspace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
  "organization_canonical_mapping_canonical_scope_fkey|organization_canonical_mapping|f|true|true|FOREIGN KEY (workspace_id, canonical_company_id) REFERENCES canonical_company(workspace_id, id) ON DELETE RESTRICT",
  "organization_canonical_mapping_source_scope_fkey|organization_canonical_mapping|f|true|true|FOREIGN KEY (workspace_id, source_company_id) REFERENCES canonical_company(workspace_id, id) ON DELETE RESTRICT",
  "organization_identifier_company_scope_fkey|organization_identifier|f|true|true|FOREIGN KEY (workspace_id, company_id) REFERENCES canonical_company(workspace_id, id) ON DELETE RESTRICT",
  "organization_identity_conflict_party_company_scope_fkey|organization_identity_conflict_party|f|true|true|FOREIGN KEY (workspace_id, company_id) REFERENCES canonical_company(workspace_id, id) ON DELETE RESTRICT",
  "organization_identity_decision_company_scope_fkey|organization_identity_decision|f|true|true|FOREIGN KEY (workspace_id, canonical_company_id) REFERENCES canonical_company(workspace_id, id) ON DELETE RESTRICT",
].join("\n");

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

function psql(database, statement) {
  assert.ok(database === "postgres" || databaseSet.has(database));
  return docker(
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
    statement,
  );
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
  assert.ok(databaseSet.has(database));
  dropDatabase(database);
  psql("postgres", `CREATE DATABASE ${database};`);
}

function databaseUrl(database) {
  assert.ok(databaseSet.has(database));
  return `postgresql://global:global@127.0.0.1:55441/${database}?schema=public`;
}

function deploy(schemaPath, database) {
  return run(
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
}

function deploySuccessfully(schemaPath, database) {
  const result = deploy(schemaPath, database);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`;
}

function inspectFinalCatalog(database) {
  const catalog = psql(
    database,
    `WITH main_unique AS (
       SELECT constraint_row.oid, constraint_row.conindid
         FROM pg_constraint AS constraint_row
        WHERE constraint_row.conrelid='public.canonical_company'::regclass
          AND constraint_row.conname='canonical_company_workspace_id_id_key'
          AND constraint_row.contype='u'
     ), expected(name) AS (
       VALUES
         ('canonical_company_workspace_id_id_key'::name),
         ('discovery_company_materialization_outcome_company_fkey'::name),
         ('organization_canonical_mapping_canonical_scope_fkey'::name),
         ('organization_canonical_mapping_source_scope_fkey'::name),
         ('organization_identifier_company_scope_fkey'::name),
         ('organization_identity_conflict_party_company_scope_fkey'::name),
         ('organization_identity_decision_company_scope_fkey'::name)
     )
     SELECT constraint_row.conname||'|'||
            constraint_row.conrelid::regclass::text||'|'||
            constraint_row.contype::text||'|'||
            constraint_row.convalidated||'|'||
            CASE WHEN constraint_row.contype='u'
              THEN constraint_row.conindid=(SELECT conindid FROM main_unique)
              ELSE constraint_row.conindid=(SELECT conindid FROM main_unique)
            END||'|'||
            pg_get_constraintdef(constraint_row.oid,true)
       FROM expected
       JOIN pg_constraint AS constraint_row
         ON constraint_row.conname=expected.name
      ORDER BY constraint_row.conname;
     SELECT 'temporary_index_absent='||
       (to_regclass('public.canonical_company_workspace_id_id_artifact_a_key') IS NULL);
     SELECT 'workspace_id_unique_count='||count(*)
       FROM pg_index AS index_row
      WHERE index_row.indrelid='public.canonical_company'::regclass
        AND index_row.indisunique
        AND index_row.indisvalid
        AND index_row.indisready
        AND index_row.indpred IS NULL
        AND index_row.indexprs IS NULL
        AND (
          SELECT array_agg(attribute_row.attname ORDER BY key_row.ordinality)
            FROM unnest(index_row.indkey) WITH ORDINALITY AS key_row(attnum,ordinality)
            JOIN pg_attribute AS attribute_row
              ON attribute_row.attrelid=index_row.indrelid
             AND attribute_row.attnum=key_row.attnum
           WHERE key_row.ordinality<=index_row.indnkeyatts
        )=ARRAY['workspace_id','id']::name[];`,
  );
  const [constraints, temporaryIndex, uniqueCount] = catalog.split(
    /\ntemporary_index_absent=/u,
  );
  assert.equal(constraints, expectedFinalCatalog);
  const [temporaryValue, uniqueValue] = temporaryIndex.split(
    /\nworkspace_id_unique_count=/u,
  );
  assert.equal(temporaryValue, "true");
  assert.equal(uniqueValue, "1");
}

function inspectMigrationLedger(database) {
  assert.equal(
    psql(
      database,
      `SELECT migration_name||'|'||checksum||'|'||
              (finished_at IS NOT NULL)::text||'|'||
              (rolled_back_at IS NULL)::text
         FROM _prisma_migrations
        WHERE migration_name IN (
          '20260829090000_organization_identity_v2_expand_ddl',
          '20260830130500_organization_identity_mainline_constraint_adoption'
        )
        ORDER BY migration_name;`,
    ),
    [
      "20260829090000_organization_identity_v2_expand_ddl|b4e2a705efa3c1f60a75e2775e444cfd11fca995fb4b8dcd0ec26bd668dfc0d7|true|true",
      "20260830130500_organization_identity_mainline_constraint_adoption|a143a1d88730ec70abc5d1cd957784c92ca98201ff4ba7e4a530c7edb5242004|true|true",
    ].join("\n"),
  );
  assert.equal(
    psql(
      database,
      `SELECT count(*)
         FROM _prisma_migrations
        WHERE checksum IN (
          '2f6bab93bd253dd7ec80d2c94c45f91e2c6bb1fae51127b94e15b0e11b85a119',
          '73929fdc1f3ee4cda303b2726c4918aba6621d93d2234d2a417c79e8cc671f44'
        );`,
    ),
    "0",
  );
}

function prepareMinimalAdoptionCatalog(
  database,
  { drift = false, seventh = false } = {},
) {
  createDatabase(database);
  psql(
    database,
    `CREATE TABLE public.canonical_company (
       workspace_id uuid NOT NULL,
       id uuid NOT NULL
     );
     CREATE UNIQUE INDEX canonical_company_workspace_id_id_artifact_a_key
       ON public.canonical_company(workspace_id,id);
     ALTER TABLE public.canonical_company
       ADD CONSTRAINT canonical_company_workspace_id_id_key
       UNIQUE(workspace_id,id);

     CREATE TABLE public.organization_identity_decision (
       workspace_id uuid NOT NULL,
       canonical_company_id uuid NOT NULL
     );
     CREATE TABLE public.organization_identifier (
       workspace_id uuid NOT NULL,
       company_id uuid NOT NULL
     );
     CREATE TABLE public.organization_canonical_mapping (
       workspace_id uuid NOT NULL,
       source_company_id uuid NOT NULL,
       canonical_company_id uuid NOT NULL
     );
     CREATE TABLE public.organization_identity_conflict_party (
       workspace_id uuid NOT NULL,
       company_id uuid NOT NULL
     );
     CREATE TABLE public.discovery_company_materialization_outcome (
       workspace_id uuid NOT NULL,
       canonical_company_id uuid NOT NULL
     );

     ALTER TABLE public.organization_identity_decision
       ADD CONSTRAINT organization_identity_decision_company_scope_fkey
       FOREIGN KEY(workspace_id,canonical_company_id)
       REFERENCES public.canonical_company(workspace_id,id)
       ON DELETE RESTRICT ON UPDATE NO ACTION;
     ALTER TABLE public.organization_identifier
       ADD CONSTRAINT organization_identifier_company_scope_fkey
       FOREIGN KEY(workspace_id,company_id)
       REFERENCES public.canonical_company(workspace_id,id)
       ON DELETE ${drift ? "CASCADE" : "RESTRICT"} ON UPDATE NO ACTION;
     ALTER TABLE public.organization_canonical_mapping
       ADD CONSTRAINT organization_canonical_mapping_source_scope_fkey
       FOREIGN KEY(workspace_id,source_company_id)
       REFERENCES public.canonical_company(workspace_id,id)
       ON DELETE RESTRICT ON UPDATE NO ACTION,
       ADD CONSTRAINT organization_canonical_mapping_canonical_scope_fkey
       FOREIGN KEY(workspace_id,canonical_company_id)
       REFERENCES public.canonical_company(workspace_id,id)
       ON DELETE RESTRICT ON UPDATE NO ACTION;
     ALTER TABLE public.organization_identity_conflict_party
       ADD CONSTRAINT organization_identity_conflict_party_company_scope_fkey
       FOREIGN KEY(workspace_id,company_id)
       REFERENCES public.canonical_company(workspace_id,id)
       ON DELETE RESTRICT ON UPDATE NO ACTION;
     ALTER TABLE public.discovery_company_materialization_outcome
       ADD CONSTRAINT discovery_company_materialization_outcome_company_fkey
       FOREIGN KEY(workspace_id,canonical_company_id)
       REFERENCES public.canonical_company(workspace_id,id)
       ON UPDATE RESTRICT ON DELETE RESTRICT;

     ${
       seventh
         ? `CREATE TABLE public.task_a7_unexpected_reference (
       workspace_id uuid NOT NULL,
       company_id uuid NOT NULL
     );
     ALTER TABLE public.task_a7_unexpected_reference
       ADD CONSTRAINT task_a7_unexpected_reference_company_fkey
       FOREIGN KEY(workspace_id,company_id)
       REFERENCES public.canonical_company(workspace_id,id)
       ON DELETE RESTRICT ON UPDATE NO ACTION;`
         : ""
     }`,
  );
}

function adoptionFailure(database, expectedCode) {
  const result = run(
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
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: readFileSync(adoptionMigrationPath, "utf8") },
  );
  assert.notEqual(result.status, 0, "adoption migration unexpectedly succeeded");
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    new RegExp(expectedCode, "u"),
  );
  assert.equal(
    psql(
      database,
      `SELECT to_regclass(
        'public.canonical_company_workspace_id_id_artifact_a_key'
      ) IS NOT NULL;`,
    ),
    "t",
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
  const network = JSON.parse(
    docker(["network", "inspect", "--format", "{{json .}}", topology.network]),
  );
  assert.equal(network.Id, topology.networkId);
  assert.deepEqual(Object.keys(network.Containers), [topology.containerId]);
}

before(() => {
  requireExactTopology();
  mainStage = materializePinnedPrismaStage({
    repositoryRoot,
    commit: exactMain,
    prefix: "task-a7-exact-main-stage-",
  });
});

after(() => {
  for (const database of databaseSet) dropDatabase(database);
  if (mainStage?.root) {
    rmSync(mainStage.root, { recursive: true, force: true });
  }
});

describe("Organization Identity mainline constraint adoption", {
  concurrency: 1,
}, () => {
  it("deploys the complete merged chain fresh and is a no-op on second deploy", () => {
    createDatabase(databases.fresh);
    deploySuccessfully(currentSchemaPath, databases.fresh);
    assert.match(
      deploySuccessfully(currentSchemaPath, databases.fresh),
      /No pending migrations to apply/u,
    );
    inspectFinalCatalog(databases.fresh);
    inspectMigrationLedger(databases.fresh);
  });

  it("upgrades an exact fully-migrated current-main database and is a no-op on second deploy", () => {
    createDatabase(databases.upgrade);
    deploySuccessfully(mainStage.schemaPath, databases.upgrade);
    assert.match(
      deploySuccessfully(mainStage.schemaPath, databases.upgrade),
      /No pending migrations to apply/u,
    );
    deploySuccessfully(currentSchemaPath, databases.upgrade);
    assert.match(
      deploySuccessfully(currentSchemaPath, databases.upgrade),
      /No pending migrations to apply/u,
    );
    inspectFinalCatalog(databases.upgrade);
    inspectMigrationLedger(databases.upgrade);
  });

  it("rejects a seventh temporary-index FK dependency before any DDL", () => {
    prepareMinimalAdoptionCatalog(databases.seventh, { seventh: true });
    adoptionFailure(
      databases.seventh,
      "IDENTITY_ARTIFACT_A_TEMP_INDEX_DEPENDENCY_INVALID",
    );
  });

  it("rejects an allowlisted FK definition drift before any DDL", () => {
    prepareMinimalAdoptionCatalog(databases.drift, { drift: true });
    adoptionFailure(
      databases.drift,
      "IDENTITY_ARTIFACT_A_FK_INVENTORY_INVALID",
    );
  });
});
