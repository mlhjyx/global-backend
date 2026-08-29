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
const contractMigrationName =
  "20260829092000_organization_identity_v2_contract_ddl";
const contractMigrationPath = resolve(
  repositoryRoot,
  "packages/db/prisma/migrations",
  contractMigrationName,
  "migration.sql",
);
const liveContractStage = Object.freeze({
  migrationRoot: resolve(repositoryRoot, "packages/db/prisma/migrations"),
  schemaPath: resolve(repositoryRoot, "packages/db/prisma/schema.prisma"),
});
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
const POLICY = "17000000-0000-4000-8000-000000000001";
const MISSING_TARGET = "18000000-0000-4000-8000-000000000001";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

let backfillTree;
let contractStage = liveContractStage;
let topologyInventory;
let contractSql = "";
let firstFreshDeployOutput = "";
let secondFreshDeployOutput = "";
let upgradeDeployOutput = "";
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
  return dockerPsql(
    database,
    `SELECT jsonb_build_object(
      'columns', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.column_name) FROM (
        SELECT column_name,is_nullable,column_default
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name='identity_link'
      ) x),
      'constraints', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.conname) FROM (
        SELECT conname,pg_get_constraintdef(oid,true) AS definition
        FROM pg_constraint WHERE conrelid='public.identity_link'::regclass
      ) x),
      'indexes', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.indexname) FROM (
        SELECT indexname,indexdef FROM pg_indexes
        WHERE schemaname='public' AND tablename='identity_link'
      ) x),
      'triggers', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.tgname) FROM (
        SELECT tgname,pg_get_triggerdef(oid,true) AS definition
        FROM pg_trigger WHERE tgrelid='public.identity_link'::regclass
          AND NOT tgisinternal
      ) x),
      'functions', (SELECT jsonb_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text)
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname LIKE 'enforce_%identity%')
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

  assert.ok(
    existsSync(contractMigrationPath),
    "exact contract migration is absent after disposable PostgreSQL baseline setup",
  );
  contractSql = readFileSync(contractMigrationPath, "utf8");

  firstFreshDeployOutput = migrateDeploy(
    databases.fresh,
    contractStage.schemaPath,
  );
  secondFreshDeployOutput = migrateDeploy(
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
  if (contractStage !== liveContractStage && contractStage?.root) {
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

  it("deploys fresh/upgrade once, makes second deploy a no-op and has zero same-stage diff", () => {
    assert.match(
      firstFreshDeployOutput,
      new RegExp(contractMigrationName, "u"),
    );
    assert.match(upgradeDeployOutput, new RegExp(contractMigrationName, "u"));
    assert.match(secondFreshDeployOutput, /No pending migrations to apply/u);
    assert.equal(schemaDiffResult.status, 0, schemaDiffResult.output);
    assert.equal(schemaDiffResult.stdout.trim(), "");
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
        "20260829090000_organization_identity_v2_expand_ddl:2f6bab93bd253dd7ec80d2c94c45f91e2c6bb1fae51127b94e15b0e11b85a119",
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

    for (const sql of [
      `INSERT INTO identity_link(id,workspace_id,canonical_type,canonical_id,raw_record_id,match_rule,confidence,status)
       VALUES (gen_random_uuid(),'${WORKSPACE_A}','company','${COMPANY_A4}','${RAW_A}','acl',0.3,'ACTIVE');`,
      `UPDATE identity_link SET status='REVOKED' WHERE id='${LINK_APP_COMPANY}';`,
      `DELETE FROM identity_link WHERE id='${LINK_APP_COMPANY}';`,
      "TRUNCATE identity_link;",
    ]) {
      dockerPsql(databases.upgrade, asApp(WORKSPACE_A, sql), {
        rejects: /permission denied for table identity_link/u,
      });
    }
  });

  it("allows only the complete IdentityLink status graph and immutable/no-delete rules", () => {
    const conflictId = "21000000-0000-4000-8000-000000000001";
    dockerPsql(
      databases.upgrade,
      asOwner(WORKSPACE_A, insertConflictSql({ id: conflictId })),
    );
    for (const [id, status] of [
      [LINK_PENDING_ACTIVE, "PENDING_CONFLICT"],
      [LINK_PENDING_REVOKED, "PENDING_CONFLICT"],
      [LINK_ACTIVE_INVALID, "ACTIVE"],
    ]) {
      dockerPsql(
        databases.upgrade,
        asOwner(
          WORKSPACE_A,
          `INSERT INTO identity_link(
            id,workspace_id,canonical_type,canonical_id,raw_record_id,match_rule,
            confidence,status,resolver_version,input_hash,conflict_id
          ) VALUES (
            '${id}','${WORKSPACE_A}','company','${COMPANY_A4}','${RAW_A}',
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
    dockerPsql(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        `${insertConflictSql({ id: legal })}
         ${insertConflictSql({ id: illegal })}
         UPDATE organization_identity_conflict SET status='RESOLVING',revision=2
           WHERE id='${legal}';
         UPDATE organization_identity_conflict
           SET status='RESOLVED',revision=3,resolved_at='2026-08-29T04:00:00Z'
           WHERE id='${legal}';
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
        `DELETE FROM organization_identity_conflict_party WHERE id='${party}';`,
        /ORGANIZATION_IDENTITY_CONFLICT_PARTY_DELETE_FORBIDDEN/u,
      ],
      [
        `UPDATE organization_identity_decision SET note='rewrite' WHERE id='${decision}';`,
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
    dockerPsql(
      databases.upgrade,
      asOwner(
        WORKSPACE_A,
        `${insertConflictSql({ id: conflict })}
         ${insertDecisionSql({ id: merge, requestId: "map-merge", action: "MERGE", conflictId: conflict, canonicalCompanyId: COMPANY_A2 })}
         ${insertDecisionSql({ id: wrongAction, requestId: "map-wrong-action", action: "KEEP_SEPARATE", conflictId: conflict })}
         ${insertDecisionSql({ id: wrongTarget, requestId: "map-wrong-target", action: "MERGE", conflictId: conflict, canonicalCompanyId: COMPANY_A3 })}
         ${insertDecisionSql({ id: split, requestId: "map-split", action: "SPLIT" })}`,
      ),
    );
    for (const [decisionId, expected] of [
      [wrongAction, /ORGANIZATION_CANONICAL_MAPPING_DECISION_INVALID/u],
      [wrongTarget, /ORGANIZATION_CANONICAL_MAPPING_DECISION_INVALID/u],
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

  it("keeps all six new tables SELECT-only for app_user", () => {
    assert.equal(
      dockerPsql(
        databases.upgrade,
        `SELECT string_agg(table_name || ':' ||
          has_table_privilege('app_user',format('public.%I',table_name),'SELECT')::text || ':' ||
          has_table_privilege('app_user',format('public.%I',table_name),'INSERT')::text || ':' ||
          has_table_privilege('app_user',format('public.%I',table_name),'UPDATE')::text || ':' ||
          has_table_privilege('app_user',format('public.%I',table_name),'DELETE')::text,
          E'\\n' ORDER BY table_name)
         FROM (VALUES
           ('organization_identifier'),
           ('organization_identity_conflict'),
           ('organization_identity_conflict_party'),
           ('organization_identity_decision'),
           ('organization_canonical_mapping'),
           ('organization_identity_replay')
         ) tables(table_name);`,
      ),
      [
        "organization_canonical_mapping:true:false:false:false",
        "organization_identifier:true:false:false:false",
        "organization_identity_conflict:true:false:false:false",
        "organization_identity_conflict_party:true:false:false:false",
        "organization_identity_decision:true:false:false:false",
        "organization_identity_replay:true:false:false:false",
      ].join("\n"),
    );
  });
});
