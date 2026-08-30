import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { materializePinnedPrismaStage } from "./helpers/pinned-prisma-stage.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const contractCommit = "400caab2f8d827cc012ee5f928e7af4d6a1d6e08";
const resolverCommit = "94138fc2c516bd1a43cc4344ed7bb5876f52a14b";
const migrationName =
  "20260830090000_organization_identity_v2_resolver_command";
const container = process.env.TASK6B_RESOLVER_PG_CONTAINER;
const port = process.env.TASK6B_RESOLVER_PG_PORT;
const databases = Object.freeze({
  fresh: "task6b_identity_resolver_fresh",
  upgrade: "task6b_identity_resolver_upgrade",
});

const WORKSPACE_A = "21000000-0000-4000-8000-000000000001";
const WORKSPACE_B = "21000000-0000-4000-8000-000000000002";
const SOURCE_ID = "21500000-0000-4000-8000-000000000001";
const SOURCE_ENTITY_ID = "21500000-0000-4000-8000-000000000002";
const RAW_BIND = "22000000-0000-4000-8000-000000000001";
const RAW_LAZY = "22000000-0000-4000-8000-000000000002";
const RAW_CREATE = "22000000-0000-4000-8000-000000000003";
const RAW_CONFLICT = "22000000-0000-4000-8000-000000000004";
const RAW_RACE_A = "22000000-0000-4000-8000-000000000005";
const RAW_RACE_B = "22000000-0000-4000-8000-000000000006";
const RAW_ROLLBACK = "22000000-0000-4000-8000-000000000007";
const RAW_PARTIAL = "22000000-0000-4000-8000-000000000008";
const COMPANY_A = "23000000-0000-4000-8000-000000000001";
const COMPANY_B = "23000000-0000-4000-8000-000000000002";
const COMPANY_CREATE = "23000000-0000-4000-8000-000000000003";
const COMPANY_LAZY = "23000000-0000-4000-8000-000000000004";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const RESOLVER_VERSION = "organization-identity-resolver/v1";
let contractStage;
let resolverStage;
let topology;
let freshFirstDeploy = "";
let freshSecondDeploy = "";
let upgradeDeploy = "";
let freshPrismaDiff = "";
let upgradePrismaDiff = "";
const reviewedPrismaResidual = readFileSync(
  resolve(
    repositoryRoot,
    "packages/db/test/fixtures/organization-identity-v2-contract-prisma-residual.sql",
  ),
  "utf8",
);

function requireTopology() {
  assert.equal(container, "codex-task6b-identity-authority-pg-20260830-a");
  assert.equal(port, "55441");
}

function assertDatabase(database) {
  assert.ok(
    database === "postgres" || Object.values(databases).includes(database),
    `database outside Task 6B.2c scope: ${database}`,
  );
}

function dockerPsql(database, sql, options = {}) {
  requireTopology();
  assertDatabase(database);
  const args = [
    "exec",
    "-i",
    ...(options.appUser ? ["-e", "PGPASSWORD=app_pw"] : []),
    container,
    "psql",
    ...(options.appUser
      ? ["-h", "127.0.0.1", "-U", "app_user"]
      : ["-U", "global"]),
    "-d",
    database,
    "--no-psqlrc",
    "-X",
    "-qAt",
    "-v",
    "ON_ERROR_STOP=1",
  ];
  const result = spawnSync("docker", args, {
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

function inspectTopology() {
  requireTopology();
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
  const [image, running, portsJson] = result.stdout.trim().split("\n");
  return Object.freeze({
    image: JSON.parse(image),
    running: JSON.parse(running),
    ports: JSON.parse(portsJson),
  });
}

function runPrisma(schemaPath, database) {
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
      env: {
        ...process.env,
        DATABASE_URL: `postgresql://global:global@127.0.0.1:${port}/${database}?schema=public`,
      },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`;
}

function runPrismaDiff(schemaPath, database) {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@global/db",
      "exec",
      "prisma",
      "migrate",
      "diff",
      "--script",
      "--from-url",
      `postgresql://global:global@127.0.0.1:${port}/${database}?schema=public`,
      "--to-schema-datamodel",
      schemaPath,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "true" },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, "");
  return result.stdout;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function domainAuthority(providerKey, domain) {
  return {
    providerKey,
    scheme: "domain",
    jurisdiction: "GLOBAL",
    normalizedValue: domain,
    validatorVersion: "domain-v1",
    normalizerVersion: "organization-identity-authority/v1",
    key: `domain:GLOBAL:${domain}`,
  };
}

function registryAuthority(domain) {
  return [
    domainAuthority("registry", domain),
    {
      providerKey: "registry",
      scheme: "registry-id",
      jurisdiction: "DE",
      normalizedValue: "DE1234",
      validatorVersion: "registry-id-v1",
      normalizerVersion: "organization-identity-authority/v1",
      key: "registry-id:DE:DE1234",
    },
  ];
}

function inputFacts({
  rawRecordId,
  payloadHash,
  blocker,
  authorityIdentifiers,
  bindings,
}) {
  return {
    raw: {
      rawRecordId,
      providerKey: authorityIdentifiers[0]?.providerKey ?? "directory",
      payloadHash,
      ingestVersion: "raw-source/v2",
    },
    resolverVersion: RESOLVER_VERSION,
    blocker,
    authorityIdentifiers,
    bindings,
    rootMappings: [],
  };
}

function command({
  rawRecordId,
  payloadHash,
  blocker,
  authorityIdentifiers = [],
  bindings = [],
  plan,
  targetCompanyId = null,
}) {
  const facts = inputFacts({
    rawRecordId,
    payloadHash,
    blocker,
    authorityIdentifiers,
    bindings,
  });
  return {
    schemaVersion: "organization-identity-resolution-command/v1",
    workspaceId: WORKSPACE_A,
    raw: facts.raw,
    blocker,
    authorityIdentifiers,
    existingBindings: bindings,
    rootMappings: [],
    plan: {
      ...plan,
      inputHash: hash(facts),
    },
    targetCompanyId,
  };
}

function appCommand(database, value, options = {}) {
  const json = JSON.stringify(value).replaceAll("'", "''");
  return dockerPsql(
    database,
    `BEGIN;
     ${options.lockTimeout === "100ms" ? "SET LOCAL lock_timeout='100ms';" : ""}
     SELECT set_config('app.current_workspace_id','${options.workspaceId ?? WORKSPACE_A}',true);
     SELECT row_to_json(result)::text
       FROM public.apply_organization_identity_resolution_v1('${json}'::jsonb) AS result;
     ${options.rollback ? "ROLLBACK" : "COMMIT"};`,
    { appUser: true, rejects: options.rejects },
  )
    .split("\n")
    .find((line) => line.startsWith("{"));
}

function twoIdAppCommand(database, workspaceId, rawRecordId, options = {}) {
  const workspaceSetting =
    options.workspaceSetting === false
      ? ""
      : `SELECT set_config('app.current_workspace_id','${options.workspaceSetting ?? workspaceId}',true);`;
  return dockerPsql(
    database,
    `BEGIN;
     ${options.setRole ? "SET ROLE app_user;" : ""}
     ${workspaceSetting}
     SELECT public.resolve_organization_identity_for_raw_v1('${workspaceId}', '${rawRecordId}');
     ROLLBACK;`,
    { appUser: options.appUser, rejects: options.rejects },
  );
}

function runAppResolver(database, rawRecordId) {
  requireTopology();
  assertDatabase(database);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      "pnpm",
      [
        "--filter",
        "@global/api",
        "exec",
        "tsx",
        "test/fixtures/organization-identity-resolver-app-writer.disposable.ts",
        WORKSPACE_A,
        rawRecordId,
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          TASK6B_RESOLVER_APP_DATABASE_URL: `postgresql://app_user:app_pw@127.0.0.1:${port}/${database}?schema=public`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      const line = stdout
        .trim()
        .split("\n")
        .findLast((candidate) => candidate.startsWith("{"));
      if (!line) {
        rejectPromise(
          new Error(`resolver fixture emitted no receipt: ${stderr}`),
        );
        return;
      }
      const value = JSON.parse(line);
      if (code === 0) resolvePromise(value);
      else
        rejectPromise(
          Object.assign(
            new Error(
              `resolver fixture failed:${value.errorCode ?? "UNKNOWN"}:${value.databaseCode ?? "UNKNOWN"}:${value.sqlState ?? "UNKNOWN"}:${value.databaseToken ?? "UNKNOWN"}`,
            ),
            { value },
          ),
        );
    });
  });
}

function collectProcess(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", rejectPromise);
    child.on("close", (code) =>
      code === 0
        ? resolvePromise(stdout.trim())
        : rejectPromise(new Error(stderr)),
    );
  });
}

function rawPayload({ providerKey, domain }) {
  const base = {
    externalId: "company-1",
    name: "Acme GmbH",
    domain,
    country: "DE",
    attributes: { products: ["pump"] },
    provenance: {
      sourceUrl: "https://registry.example/companies/1",
      fetchedAt: "2026-08-25T12:00:00.000Z",
      contentHash: HASH_B,
      parserVersion: "registry/v1",
    },
  };
  return providerKey === "registry"
    ? { ...base, identifier: { scheme: "registry-id", value: "de-12/34" } }
    : {
        ...base,
        externalId: `directory:${domain}`,
        attributes: {
          source_kind: "directory",
          source_directory: "registry.example",
          detail_url: "https://registry.example/company/1",
          source_class: "industry_data",
        },
      };
}

function seed(database) {
  const registryBindPayload = JSON.stringify(
    rawPayload({ providerKey: "registry", domain: "bind.example" }),
  ).replaceAll("'", "''");
  const registryConflictPayload = JSON.stringify(
    rawPayload({ providerKey: "registry", domain: "conflict.example" }),
  ).replaceAll("'", "''");
  const directoryLazyPayload = JSON.stringify(
    rawPayload({ providerKey: "directory", domain: "lazy.example" }),
  ).replaceAll("'", "''");
  const directoryCreatePayload = JSON.stringify(
    rawPayload({ providerKey: "directory", domain: "create.example" }),
  ).replaceAll("'", "''");
  const directoryRacePayload = JSON.stringify(
    rawPayload({ providerKey: "directory", domain: "race.example" }),
  ).replaceAll("'", "''");
  const directoryRollbackPayload = JSON.stringify(
    rawPayload({ providerKey: "directory", domain: "rollback.example" }),
  ).replaceAll("'", "''");
  const directoryPartialPayload = JSON.stringify(
    rawPayload({ providerKey: "directory", domain: "partial.example" }),
  ).replaceAll("'", "''");
  dockerPsql(
    database,
    `INSERT INTO workspace(id,name,updated_at) VALUES
       ('${WORKSPACE_A}','Task 6B A',now()),('${WORKSPACE_B}','Task 6B B',now());
     INSERT INTO monitored_source(id,provider_key,source_key,label,config,status,created_at,updated_at)
       VALUES ('${SOURCE_ID}','registry','task6b:resolver','Task 6B Resolver','{}'::jsonb,'ACTIVE',now(),now());
     INSERT INTO source_entity(id,source_id,external_id,entity_kind,name,domain,country,cleaned,content_hash,created_at,updated_at)
       VALUES ('${SOURCE_ENTITY_ID}','${SOURCE_ID}','task6b-entity','company','Acme GmbH','acme.example','DE','{}'::jsonb,'${HASH_A}',now(),now());
     INSERT INTO canonical_company(id,workspace_id,name,domain,country,status,dedupe_key,version,created_at,updated_at) VALUES
       ('${COMPANY_A}','${WORKSPACE_A}','Acme Root','root.example','DE','NEW','d:root.example',1,now(),now()),
       ('${COMPANY_B}','${WORKSPACE_A}','Conflict Legacy','conflict.example','DE','NEW','d:conflict.example',1,now(),now()),
       ('${COMPANY_CREATE}','${WORKSPACE_A}','Create Target','create.example','DE','NEW','d:create.example',1,now(),now()),
       ('${COMPANY_LAZY}','${WORKSPACE_A}','Lazy Target','lazy.example','DE','NEW','d:lazy.example',1,now(),now());
     INSERT INTO raw_source_record(id,workspace_id,source_entity_id,provider_key,source_class,payload,source_url,fetched_at,content_hash,parser_version,ingest_key,payload_hash,payload_bytes,ingest_version,ingest_status,retention_days,expires_at,source_policy_snapshot,created_at) VALUES
       ('${RAW_BIND}','${WORKSPACE_A}','${SOURCE_ENTITY_ID}','registry','company_registry','${registryBindPayload}'::jsonb,'https://registry.example/companies/1',now(),'${HASH_B}','registry/v1','task6b:bind','${HASH_A}',1,'raw-source/v2','ACCEPTED',30,now()+interval '30 days','{}'::jsonb,now()),
       ('${RAW_LAZY}','${WORKSPACE_A}','${SOURCE_ENTITY_ID}','directory','industry_data','${directoryLazyPayload}'::jsonb,'https://registry.example/companies/1',now(),'${HASH_B}','registry/v1','task6b:lazy','${HASH_B}',1,'raw-source/v2','ACCEPTED',30,now()+interval '30 days','{}'::jsonb,now()),
       ('${RAW_CREATE}','${WORKSPACE_A}','${SOURCE_ENTITY_ID}','directory','industry_data','${directoryCreatePayload}'::jsonb,'https://registry.example/companies/1',now(),'${HASH_B}','registry/v1','task6b:create','${HASH_C}',1,'raw-source/v2','ACCEPTED',30,now()+interval '30 days','{}'::jsonb,now()),
       ('${RAW_CONFLICT}','${WORKSPACE_A}','${SOURCE_ENTITY_ID}','registry','company_registry','${registryConflictPayload}'::jsonb,'https://registry.example/companies/1',now(),'${HASH_B}','registry/v1','task6b:conflict','${HASH_D}',1,'raw-source/v2','ACCEPTED',30,now()+interval '30 days','{}'::jsonb,now()),
       ('${RAW_RACE_A}','${WORKSPACE_A}','${SOURCE_ENTITY_ID}','directory','industry_data','${directoryRacePayload}'::jsonb,'https://registry.example/companies/1',now(),'${HASH_B}','registry/v1','task6b:race-a','${HASH_A}',1,'raw-source/v2','ACCEPTED',30,now()+interval '30 days','{}'::jsonb,now()),
       ('${RAW_RACE_B}','${WORKSPACE_A}','${SOURCE_ENTITY_ID}','directory','industry_data','${directoryRacePayload}'::jsonb,'https://registry.example/companies/1',now(),'${HASH_B}','registry/v1','task6b:race-b','${HASH_B}',1,'raw-source/v2','ACCEPTED',30,now()+interval '30 days','{}'::jsonb,now()),
       ('${RAW_ROLLBACK}','${WORKSPACE_A}','${SOURCE_ENTITY_ID}','directory','industry_data','${directoryRollbackPayload}'::jsonb,'https://registry.example/companies/1',now(),'${HASH_B}','registry/v1','task6b:rollback','${HASH_C}',1,'raw-source/v2','ACCEPTED',30,now()+interval '30 days','{}'::jsonb,now()),
       ('${RAW_PARTIAL}','${WORKSPACE_A}','${SOURCE_ENTITY_ID}','directory','industry_data','${directoryPartialPayload}'::jsonb,'https://registry.example/companies/1',now(),'${HASH_B}','registry/v1','task6b:partial','${HASH_D}',1,'raw-source/v2','ACCEPTED',30,now()+interval '30 days','{}'::jsonb,now());
     INSERT INTO organization_identifier(workspace_id,company_id,scheme,jurisdiction,normalized_value,authority_provider_key,raw_record_id,confidence,normalizer_version,validator_version,provenance,status)
     VALUES ('${WORKSPACE_A}','${COMPANY_A}','registry-id','DE','DE1234','registry','${RAW_BIND}',1,'organization-identity-authority/v1','registry-id-v1','{"schemaVersion":"organization-identifier-provenance/v1"}'::jsonb,'ACTIVE');`,
  );
}

before(() => {
  requireTopology();
  topology = inspectTopology();
  for (const database of Object.values(databases)) {
    dockerPsql(
      "postgres",
      `DROP DATABASE IF EXISTS ${database}; CREATE DATABASE ${database};`,
    );
  }
  contractStage = materializePinnedPrismaStage({
    repositoryRoot,
    commit: contractCommit,
    prefix: "task6b-identity-resolver-contract-",
  });
  resolverStage = materializePinnedPrismaStage({
    repositoryRoot,
    commit: resolverCommit,
    prefix: "task6b-identity-resolver-green-",
  });
  runPrisma(contractStage.schemaPath, databases.upgrade);
  freshFirstDeploy = runPrisma(resolverStage.schemaPath, databases.fresh);
  freshSecondDeploy = runPrisma(resolverStage.schemaPath, databases.fresh);
  upgradeDeploy = runPrisma(resolverStage.schemaPath, databases.upgrade);
  freshPrismaDiff = runPrismaDiff(resolverStage.schemaPath, databases.fresh);
  upgradePrismaDiff = runPrismaDiff(
    resolverStage.schemaPath,
    databases.upgrade,
  );
  seed(databases.fresh);
  seed(databases.upgrade);
});

after(() => {
  if (contractStage?.root)
    rmSync(contractStage.root, { recursive: true, force: true });
  if (resolverStage?.root)
    rmSync(resolverStage.root, { recursive: true, force: true });
  if (
    container === "codex-task6b-identity-authority-pg-20260830-a" &&
    port === "55441"
  ) {
    for (const database of Object.values(databases)) {
      dockerPsql(
        "postgres",
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${database}' AND pid<>pg_backend_pid(); DROP DATABASE IF EXISTS ${database};`,
      );
    }
  }
});

describe("Organization Identity resolver command on disposable PostgreSQL 16", () => {
  it("attests the exact controller-owned loopback topology", () => {
    assert.deepEqual(topology, {
      image: "pgvector/pgvector:pg16",
      running: true,
      ports: {
        "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55441" }],
      },
    });
  });

  it("deploys fresh and upgrade exactly once and makes the second deploy a no-op", () => {
    assert.match(freshFirstDeploy, new RegExp(migrationName, "u"));
    assert.match(upgradeDeploy, new RegExp(migrationName, "u"));
    assert.match(freshSecondDeploy, /No pending migrations to apply/u);
    assert.equal(freshPrismaDiff, reviewedPrismaResidual);
    assert.equal(upgradePrismaDiff, reviewedPrismaResidual);
    assert.equal(
      dockerPsql(
        databases.fresh,
        `SELECT count(*) FROM "_prisma_migrations" WHERE migration_name='${migrationName}' AND finished_at IS NOT NULL AND rolled_back_at IS NULL;`,
      ),
      "1",
    );
  });

  it("stores public-command timeouts and the exact non-owner EXECUTE ACL in catalog", () => {
    assert.equal(
      dockerPsql(
        databases.fresh,
        `BEGIN;
         CREATE TEMP TABLE task6b_identity_command_catalog ON COMMIT DROP AS
         SELECT p.oid, p.proacl, p.proconfig, p.proowner
         FROM pg_proc AS p
         JOIN pg_namespace AS n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = 'resolve_organization_identity_for_raw_v1'
           AND pg_get_function_identity_arguments(p.oid) = 'text, text';
         SELECT count(*) FROM task6b_identity_command_catalog;
         SELECT count(*)
         FROM task6b_identity_command_catalog AS c
         CROSS JOIN LATERAL unnest(coalesce(c.proconfig, '{}'::text[])) AS setting
         WHERE setting = 'lock_timeout=5s';
         SELECT count(*)
         FROM task6b_identity_command_catalog AS c
         CROSS JOIN LATERAL unnest(coalesce(c.proconfig, '{}'::text[])) AS setting
         WHERE setting = 'statement_timeout=60s';
         SELECT coalesce(min(pg_get_userbyid(proowner)), '') FROM task6b_identity_command_catalog;
         SELECT count(*)
         FROM task6b_identity_command_catalog
         WHERE has_function_privilege('app_user', oid, 'EXECUTE');
         SELECT count(*)
         FROM task6b_identity_command_catalog
         WHERE has_function_privilege('public', oid, 'EXECUTE');
         SELECT count(*)
         FROM task6b_identity_command_catalog AS c
         CROSS JOIN LATERAL aclexplode(
           coalesce(c.proacl, acldefault('f', c.proowner))
         ) AS acl
         WHERE acl.privilege_type = 'EXECUTE'
           AND acl.grantee <> 0
           AND acl.grantee <> c.proowner
           AND pg_get_userbyid(acl.grantee) <> 'app_user';
         SELECT count(*)
         FROM task6b_identity_command_catalog AS c
         CROSS JOIN LATERAL aclexplode(
           coalesce(c.proacl, acldefault('f', c.proowner))
         ) AS acl
         WHERE acl.privilege_type = 'EXECUTE'
           AND pg_get_userbyid(acl.grantee) = 'app_user';
         SELECT count(*)
         FROM task6b_identity_command_catalog AS c
         CROSS JOIN LATERAL aclexplode(
           coalesce(c.proacl, acldefault('f', c.proowner))
         ) AS acl
         WHERE acl.privilege_type = 'EXECUTE'
           AND pg_get_userbyid(acl.grantee) = 'app_user'
           AND acl.is_grantable;
         SELECT count(*)
         FROM task6b_identity_command_catalog
         WHERE has_function_privilege(proowner, oid, 'EXECUTE');
         ROLLBACK;`,
      ),
      ["1", "1", "1", "global", "1", "0", "0", "1", "0", "1"].join(
        "\n",
      ),
    );
  });

  it("admits only the app_user two-ID principal without caller-injected timeouts", () => {
    assert.equal(
      dockerPsql(
        databases.fresh,
        `SELECT rolname||':'||rolsuper||':'||rolbypassrls FROM pg_roles WHERE rolname='app_user';
         SELECT has_table_privilege('app_user','organization_identifier','INSERT,UPDATE,DELETE');`,
      ),
      ["app_user:false:false", "f"].join("\n"),
    );
    assert.doesNotThrow(() =>
      twoIdAppCommand(databases.fresh, WORKSPACE_A, RAW_BIND, {
        appUser: true,
      }),
    );
  });

  it("denies owner, SET ROLE, unset, and wrong-workspace invocations", () => {
    twoIdAppCommand(databases.fresh, WORKSPACE_A, RAW_BIND, {
      rejects: /IDENTITY_RESOLUTION_COMMAND_DENIED/u,
    });
    twoIdAppCommand(databases.fresh, WORKSPACE_A, RAW_BIND, {
      setRole: true,
      rejects: /IDENTITY_RESOLUTION_COMMAND_DENIED/u,
    });
    twoIdAppCommand(databases.fresh, WORKSPACE_A, RAW_BIND, {
      appUser: true,
      workspaceSetting: false,
      rejects: /IDENTITY_RESOLUTION_COMMAND_DENIED/u,
    });
    twoIdAppCommand(databases.fresh, WORKSPACE_A, RAW_BIND, {
      appUser: true,
      workspaceSetting: WORKSPACE_B,
      rejects: /IDENTITY_RESOLUTION_COMMAND_DENIED/u,
    });
  });

  it("removes the JSON signature and rejects malformed text UUIDs without echoing them", () => {
    assert.equal(
      dockerPsql(
        databases.fresh,
        `SELECT to_regprocedure('public.apply_organization_identity_resolution_v1(jsonb)') IS NULL;`,
      ),
      "t",
    );
    const marker = "not-a-uuid-task6b-marker";
    const output = twoIdAppCommand(databases.fresh, WORKSPACE_A, marker, {
      appUser: true,
      rejects: /IDENTITY_RESOLUTION_INPUT_INVALID/u,
    });
    assert.doesNotMatch(output, new RegExp(marker, "u"));
  });

  it("persists bind, lazy, create and conflict variants with exact match rules", () => {
    const authority = registryAuthority("bind.example");
    const binding = [
      { identifierKey: "registry-id:DE:DE1234", companyId: COMPANY_A },
    ];
    const bindBlocker = {
      blockerKey: "n:unbound:de",
      matchRule: "name_country",
      legacyCandidateCompanyId: null,
    };
    const bindFacts = inputFacts({
      rawRecordId: RAW_BIND,
      payloadHash: HASH_A,
      blocker: bindBlocker,
      authorityIdentifiers: authority,
      bindings: binding,
    });
    const bind = command({
      rawRecordId: RAW_BIND,
      payloadHash: HASH_A,
      blocker: bindBlocker,
      authorityIdentifiers: authority,
      bindings: binding,
      targetCompanyId: COMPANY_A,
      plan: {
        kind: "bind_existing",
        companyId: COMPANY_A,
        matchRule: "identity_v2",
        identifiers: authority,
        inputHash: hash(bindFacts),
      },
    });
    const lazyBlocker = {
      blockerKey: "d:lazy.example",
      matchRule: "domain_exact",
      legacyCandidateCompanyId: COMPANY_LAZY,
    };
    const lazyAuthority = [domainAuthority("directory", "lazy.example")];
    const lazy = command({
      rawRecordId: RAW_LAZY,
      payloadHash: HASH_B,
      blocker: lazyBlocker,
      authorityIdentifiers: lazyAuthority,
      targetCompanyId: COMPANY_LAZY,
      plan: {
        kind: "lazy_upgrade",
        companyId: COMPANY_LAZY,
        matchRule: "identity_v2",
        identifiers: lazyAuthority,
      },
    });
    const createBlocker = {
      blockerKey: "d:create.example",
      matchRule: "domain_exact",
      legacyCandidateCompanyId: null,
    };
    const createAuthority = [domainAuthority("directory", "create.example")];
    const create = command({
      rawRecordId: RAW_CREATE,
      payloadHash: HASH_C,
      blocker: createBlocker,
      authorityIdentifiers: createAuthority,
      targetCompanyId: COMPANY_CREATE,
      plan: {
        kind: "create_new",
        matchRule: "identity_v2",
        identifiers: createAuthority,
      },
    });
    const conflictAuthority = registryAuthority("conflict.example");
    const conflictBindings = binding;
    const conflictBlocker = {
      blockerKey: "d:conflict.example",
      matchRule: "domain_exact",
      legacyCandidateCompanyId: COMPANY_B,
    };
    const conflictFacts = inputFacts({
      rawRecordId: RAW_CONFLICT,
      payloadHash: HASH_D,
      blocker: conflictBlocker,
      authorityIdentifiers: conflictAuthority,
      bindings: conflictBindings,
    });
    const companyIds = [COMPANY_A, COMPANY_B].sort();
    const identifierKeys = conflictAuthority.map((item) => item.key).sort();
    const fingerprint = hash({
      resolverVersion: RESOLVER_VERSION,
      blocker: {
        blockerKey: conflictBlocker.blockerKey,
        matchRule: conflictBlocker.matchRule,
      },
      conflictType: "blocking_key_disagreement",
      companyIds,
      identifierKeys,
    });
    const conflict = command({
      rawRecordId: RAW_CONFLICT,
      payloadHash: HASH_D,
      blocker: conflictBlocker,
      authorityIdentifiers: conflictAuthority,
      bindings: conflictBindings,
      plan: {
        kind: "conflict",
        matchRule: "identity_conflict",
        conflictType: "blocking_key_disagreement",
        companyIds,
        identifierKeys,
        inputHash: hash(conflictFacts),
        conflictFingerprint: fingerprint,
      },
    });

    const receipts = [bind, lazy, create, conflict].map((value) =>
      JSON.parse(appCommand(databases.fresh, value)),
    );
    assert.deepEqual(
      receipts.map((value) => [value.outcome_kind, value.match_rule]),
      [
        ["bound", "identity_v2"],
        ["bound", "identity_v2"],
        ["bound", "identity_v2"],
        ["conflict", "identity_conflict"],
      ],
    );
    assert.equal(
      dockerPsql(
        databases.fresh,
        `SELECT count(*) FROM identity_link WHERE workspace_id='${WORKSPACE_A}'; SELECT count(*) FROM organization_identity_conflict WHERE workspace_id='${WORKSPACE_A}';`,
      ),
      "5\n1",
    );
  });

  it("replays exact input, rejects drift/cross-workspace and leaves bottom-table DML denied", () => {
    const blocker = {
      blockerKey: "d:create.example",
      matchRule: "domain_exact",
      legacyCandidateCompanyId: null,
    };
    const authorityIdentifiers = [
      domainAuthority("directory", "create.example"),
    ];
    const value = command({
      rawRecordId: RAW_CREATE,
      payloadHash: HASH_C,
      blocker,
      authorityIdentifiers,
      targetCompanyId: COMPANY_CREATE,
      plan: {
        kind: "create_new",
        matchRule: "identity_v2",
        identifiers: authorityIdentifiers,
      },
    });
    const replay = JSON.parse(appCommand(databases.fresh, value));
    assert.equal(replay.replayed, true);
    const driftedReplay = structuredClone(value);
    driftedReplay.blocker.blockerKey = "d:drifted.example";
    appCommand(databases.fresh, driftedReplay, {
      rejects: /IDENTITY_RESOLUTION_INPUT_INVALID/u,
    });
    appCommand(databases.fresh, value, {
      workspaceId: WORKSPACE_B,
      rejects: /IDENTITY_RESOLUTION_COMMAND_DENIED/u,
    });
    dockerPsql(
      databases.fresh,
      `BEGIN; SELECT set_config('app.current_workspace_id','${WORKSPACE_A}',true); INSERT INTO organization_identity_conflict(workspace_id,conflict_type,fingerprint,facts) VALUES ('${WORKSPACE_A}','forged','${HASH_A}','{}'); ROLLBACK;`,
      { appUser: true, rejects: /permission denied/u },
    );
  });

  it("rejects a conflict command that omits a live authority binding", () => {
    const authorityIdentifiers = registryAuthority("conflict.example");
    const blocker = {
      blockerKey: "d:conflict.example",
      matchRule: "domain_exact",
      legacyCandidateCompanyId: COMPANY_B,
    };
    const companyIds = [COMPANY_A, COMPANY_B].sort();
    const identifierKeys = authorityIdentifiers.map((item) => item.key).sort();
    const fingerprint = hash({
      resolverVersion: RESOLVER_VERSION,
      blocker: {
        blockerKey: blocker.blockerKey,
        matchRule: blocker.matchRule,
      },
      conflictType: "blocking_key_disagreement",
      companyIds,
      identifierKeys,
    });
    const forged = command({
      rawRecordId: RAW_CONFLICT,
      payloadHash: HASH_D,
      blocker,
      authorityIdentifiers,
      bindings: [],
      plan: {
        kind: "conflict",
        matchRule: "identity_conflict",
        conflictType: "blocking_key_disagreement",
        companyIds,
        identifierKeys,
        conflictFingerprint: fingerprint,
      },
    });
    appCommand(databases.upgrade, forged, {
      rollback: true,
      rejects: /IDENTITY_RESOLUTION_PLAN_STALE/u,
    });
  });

  it("rejects multiple ACTIVE resolver links instead of replaying an arbitrary company", () => {
    const authorityIdentifiers = [
      domainAuthority("directory", "partial.example"),
    ];
    const blocker = {
      blockerKey: "d:partial.example",
      matchRule: "domain_exact",
      legacyCandidateCompanyId: null,
    };
    const value = command({
      rawRecordId: RAW_PARTIAL,
      payloadHash: HASH_D,
      blocker,
      authorityIdentifiers,
      targetCompanyId: COMPANY_CREATE,
      plan: {
        kind: "create_new",
        matchRule: "identity_v2",
        identifiers: authorityIdentifiers,
      },
    });
    dockerPsql(
      databases.upgrade,
      `INSERT INTO identity_link(id,workspace_id,canonical_type,canonical_id,raw_record_id,match_rule,confidence,status,resolver_version,input_hash)
       VALUES
       ('25000000-0000-4000-8000-000000000001','${WORKSPACE_A}','company','${COMPANY_A}','${RAW_PARTIAL}','identity_v2',1,'ACTIVE','${RESOLVER_VERSION}','${value.plan.inputHash}'),
       ('25000000-0000-4000-8000-000000000002','${WORKSPACE_A}','company','${COMPANY_B}','${RAW_PARTIAL}','identity_v2',1,'ACTIVE','${RESOLVER_VERSION}','${value.plan.inputHash}');`,
    );
    appCommand(databases.upgrade, value, {
      rejects: /IDENTITY_RESOLUTION_STATE_INVALID/u,
    });
  });

  it("uses two physical app_user connections to converge same-authority Raw rows on one company", async () => {
    const [first, second] = await Promise.all([
      runAppResolver(databases.fresh, RAW_RACE_A),
      runAppResolver(databases.fresh, RAW_RACE_B),
    ]);
    assert.notEqual(first.backendPid, second.backendPid);
    assert.equal(first.receipt.kind, "bound");
    assert.equal(second.receipt.kind, "bound");
    assert.equal(first.receipt.companyId, second.receipt.companyId);
    assert.equal(first.receipt.matchRule, "identity_v2");
    assert.equal(second.receipt.matchRule, "identity_v2");
    assert.equal(
      dockerPsql(
        databases.fresh,
        `SELECT count(DISTINCT company_id) FROM organization_identifier
         WHERE workspace_id='${WORKSPACE_A}' AND scheme='domain'
           AND jurisdiction='GLOBAL' AND normalized_value='race.example'
           AND status='ACTIVE';
         SELECT count(*) FROM identity_link
         WHERE workspace_id='${WORKSPACE_A}'
           AND raw_record_id IN ('${RAW_RACE_A}','${RAW_RACE_B}');`,
      ),
      "1\n2",
    );
  });

  it("rolls back the source-created company and every identity write on link failure", async () => {
    dockerPsql(
      databases.fresh,
      `CREATE FUNCTION task6b_identity_resolver_fail_link()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.raw_record_id='${RAW_ROLLBACK}'::uuid THEN
           RAISE EXCEPTION 'TASK6B_TEST_LINK_FAILURE';
         END IF;
         RETURN NEW;
       END $$;
       CREATE TRIGGER task6b_identity_resolver_fail_link
       BEFORE INSERT ON identity_link FOR EACH ROW
       EXECUTE FUNCTION task6b_identity_resolver_fail_link();`,
    );
    try {
      await assert.rejects(
        runAppResolver(databases.fresh, RAW_ROLLBACK),
        (error) =>
          error?.value?.errorCode === "IDENTITY_RESOLUTION_STATE_INVALID",
      );
      assert.equal(
        dockerPsql(
          databases.fresh,
          `SELECT count(*) FROM canonical_company
           WHERE workspace_id='${WORKSPACE_A}' AND dedupe_key='d:rollback.example';
           SELECT count(*) FROM organization_identifier
           WHERE workspace_id='${WORKSPACE_A}' AND raw_record_id='${RAW_ROLLBACK}';
           SELECT count(*) FROM identity_link
           WHERE workspace_id='${WORKSPACE_A}' AND raw_record_id='${RAW_ROLLBACK}';`,
        ),
        "0\n0\n0",
      );
    } finally {
      dockerPsql(
        databases.fresh,
        `DROP TRIGGER IF EXISTS task6b_identity_resolver_fail_link ON identity_link;
         DROP FUNCTION IF EXISTS task6b_identity_resolver_fail_link();`,
      );
    }
  });

  it("bounds lock wait timeout and leaves zero partial identity state", async () => {
    const holder = spawn(
      "docker",
      [
        "exec",
        "-i",
        container,
        "psql",
        "-U",
        "global",
        "-d",
        databases.upgrade,
        "--no-psqlrc",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const holderResultPromise = collectProcess(holder);
    holder.stdin.end(
      `BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('acquisition-suppression-policy:${WORKSPACE_A}',0)); SELECT pg_sleep(0.5); COMMIT; SELECT 'holder-done';`,
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    const authorityIdentifiers = [domainAuthority("directory", "lazy.example")];
    const blocker = {
      blockerKey: "d:lazy.example",
      matchRule: "domain_exact",
      legacyCandidateCompanyId: COMPANY_LAZY,
    };
    const value = command({
      rawRecordId: RAW_LAZY,
      payloadHash: HASH_B,
      blocker,
      authorityIdentifiers,
      targetCompanyId: COMPANY_LAZY,
      plan: {
        kind: "lazy_upgrade",
        companyId: COMPANY_LAZY,
        matchRule: "identity_v2",
        identifiers: authorityIdentifiers,
      },
    });
    appCommand(databases.upgrade, value, {
      lockTimeout: "100ms",
      rejects: /lock timeout/u,
    });
    assert.match(await holderResultPromise, /holder-done/u);
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT count(*) FROM identity_link
         WHERE workspace_id='${WORKSPACE_A}' AND raw_record_id='${RAW_LAZY}';
         SELECT count(*) FROM organization_identifier
         WHERE workspace_id='${WORKSPACE_A}' AND raw_record_id='${RAW_LAZY}';`,
      ),
      "0\n0",
    );
  });

  it("waits behind a committed suppression and then performs zero identity writes", async () => {
    const writer = spawn(
      "docker",
      [
        "exec",
        "-i",
        container,
        "psql",
        "-U",
        "global",
        "-d",
        databases.upgrade,
        "--no-psqlrc",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const writerResultPromise = collectProcess(writer);
    writer.stdin.end(
      `BEGIN;
       SELECT pg_advisory_xact_lock(hashtextextended('acquisition-suppression-policy:${WORKSPACE_A}',0));
       INSERT INTO suppression_record(id,workspace_id,type,value,reason,protection_class)
       VALUES ('24000000-0000-4000-8000-000000000001','${WORKSPACE_A}','domain','create.example','legal','LEGAL');
       SELECT pg_sleep(0.4);
       COMMIT;
       SELECT 'suppression-done';`,
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    await assert.rejects(
      runAppResolver(databases.upgrade, RAW_CREATE),
      (error) => error?.value?.errorCode === "IDENTITY_RESOLUTION_SUPPRESSED",
    );
    const writerResult = await writerResultPromise;
    assert.match(writerResult, /suppression-done/u);
    assert.doesNotMatch(writerResult, /40P01/u);
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT count(*) FROM identity_link
         WHERE workspace_id='${WORKSPACE_A}' AND raw_record_id='${RAW_CREATE}';
         SELECT count(*) FROM organization_identifier
         WHERE workspace_id='${WORKSPACE_A}' AND raw_record_id='${RAW_CREATE}';`,
      ),
      "0\n0",
    );
  });

  it("serializes the suppression lock before identity without deadlock", async () => {
    const first = spawn(
      "docker",
      [
        "exec",
        "-i",
        container,
        "psql",
        "-U",
        "global",
        "-d",
        databases.fresh,
        "--no-psqlrc",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const firstResultPromise = collectProcess(first);
    first.stdin.end(
      `BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('acquisition-suppression-policy:${WORKSPACE_A}',0)); SELECT pg_sleep(0.4); COMMIT; SELECT 'first-done';`,
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    const second = dockerPsql(
      databases.fresh,
      `BEGIN; SET LOCAL lock_timeout='5s'; SELECT pg_advisory_xact_lock(hashtextextended('acquisition-suppression-policy:${WORKSPACE_A}',0)); SELECT pg_advisory_xact_lock(hashtextextended('organization-identity:${WORKSPACE_A}',0)); COMMIT; SELECT 'second-done';`,
    );
    const firstOutput = await firstResultPromise;
    assert.match(firstOutput, /first-done/u);
    assert.match(second, /second-done/u);
  });
});
