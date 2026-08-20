import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const migrationDirectory = resolve(
  repositoryRoot,
  "packages/db/prisma/migrations/20260821090000_execution_budget_authority",
);
const migrationPath = resolve(migrationDirectory, "migration.sql");
const migrationsRoot = resolve(repositoryRoot, "packages/db/prisma/migrations");

const OWNER_URL = process.env.DATABASE_URL;
const APP_URL = process.env.APP_DATABASE_URL;
const PLATFORM_LOGIN = "execution_budget_platform_writer_test";
const PLATFORM_PASSWORD = "execution-budget-platform-writer-test-only";
const WS_A = "00000000-0000-4000-8000-0000000000a1";
const WS_B = "00000000-0000-4000-8000-0000000000b2";
const AUDIENCE = "global-backend:execution-budget";
const ISSUER = "https://control.example.test";
const REQUEST_A = "a".repeat(64);
const REQUEST_B = "b".repeat(64);
const TOKEN_A = "c".repeat(64);
const TEST_STARTED_AT = Date.now();
const VALID_TIMES = Object.freeze({
  issuedAt: new Date(TEST_STARTED_AT - 30_000),
  notBefore: new Date(TEST_STARTED_AT - 20_000),
  expiresAt: new Date(TEST_STARTED_AT + 240_000),
});

function requireDatabaseUrl(name, value) {
  assert.ok(value, `${name} is required`);
  const parsed = new URL(value);
  assert.ok(["postgres:", "postgresql:"].includes(parsed.protocol));
  return parsed;
}

function platformUrl() {
  const parsed = requireDatabaseUrl("DATABASE_URL", OWNER_URL);
  parsed.username = PLATFORM_LOGIN;
  parsed.password = PLATFORM_PASSWORD;
  return parsed.href;
}

function databaseUrl(baseUrl, database, username, password) {
  const parsed = requireDatabaseUrl("DATABASE_URL", baseUrl);
  parsed.pathname = `/${database}`;
  if (username !== undefined) parsed.username = username;
  if (password !== undefined) parsed.password = password;
  return parsed.href;
}

function client(url) {
  return new PrismaClient({ datasources: { db: { url } } });
}

async function withWorkspace(database, workspaceId, callback) {
  return database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      "SELECT set_config('app.current_workspace_id', $1, true)",
      workspaceId,
    );
    return callback(transaction);
  });
}

async function rejectsSql(callback, marker) {
  await assert.rejects(callback, (error) => {
    if (marker) assert.match(String(error?.message), new RegExp(marker));
    return true;
  });
}

async function captureSqlError(callback, marker) {
  let caught;
  try {
    await callback();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected SQL to fail with ${marker}`);
  const message = String(caught.message);
  assert.match(message, new RegExp(marker));
  return message;
}

function overrideValue(overrides, name, fallback) {
  return Object.hasOwn(overrides, name) ? overrides[name] : fallback;
}

function authorityTimes(overrides = {}) {
  return {
    issuedAt: overrideValue(overrides, "issuedAt", VALID_TIMES.issuedAt),
    notBefore: overrideValue(overrides, "notBefore", VALID_TIMES.notBefore),
    expiresAt: overrideValue(overrides, "expiresAt", VALID_TIMES.expiresAt),
  };
}

async function consumeWorkspace(transaction, overrides = {}) {
  const times = authorityTimes(overrides);
  return transaction.$queryRawUnsafe(
    `SELECT * FROM consume_workspace_execution_authority(
      $1, $2, $3::uuid, $4, $5, $6::execution_budget_purpose,
      $7::uuid, $8, $9, $10, $11, $12, $13::bigint,
      $14::timestamptz, $15::timestamptz, $16::timestamptz
    )`,
    overrideValue(overrides, "issuer", ISSUER),
    overrideValue(overrides, "audience", AUDIENCE),
    overrideValue(overrides, "jti", randomUUID()),
    overrideValue(overrides, "tokenSha256", TOKEN_A),
    overrideValue(overrides, "schemaVersion", "execution-budget-grant/v1"),
    overrideValue(overrides, "purpose", "icp.design"),
    overrideValue(overrides, "workspaceId", WS_A),
    overrideValue(overrides, "subjectType", "company"),
    overrideValue(overrides, "subjectId", "company-a"),
    overrideValue(overrides, "requestSha256", REQUEST_A),
    overrideValue(overrides, "currency", "USD"),
    overrideValue(overrides, "unit", "microusd"),
    overrideValue(overrides, "capMicrousd", 5_000_000n),
    times.issuedAt,
    times.notBefore,
    times.expiresAt,
  );
}

async function ingestPlatform(transaction, overrides = {}) {
  const times = authorityTimes(overrides);
  return transaction.$queryRawUnsafe(
    `SELECT * FROM ingest_platform_execution_authority(
      $1, $2, $3::uuid, $4, $5, $6::execution_budget_purpose,
      $7, $8, $9, $10, $11, $12::bigint, $13::bigint, $14::bigint,
      $15::timestamptz, $16::timestamptz, $17::timestamptz
    )`,
    overrideValue(overrides, "issuer", ISSUER),
    overrideValue(overrides, "audience", AUDIENCE),
    overrideValue(overrides, "jti", randomUUID()),
    overrideValue(overrides, "tokenSha256", TOKEN_A),
    overrideValue(overrides, "schemaVersion", "execution-budget-grant/v1"),
    overrideValue(overrides, "purpose", "platform.acquisition"),
    overrideValue(overrides, "subjectType", "schedule"),
    overrideValue(overrides, "subjectId", "acquisition-schedule"),
    overrideValue(overrides, "scheduleId", "acquisition-schedule"),
    overrideValue(overrides, "currency", "USD"),
    overrideValue(overrides, "unit", "microusd"),
    overrideValue(overrides, "capPerRunMicrousd", 1_000_000n),
    overrideValue(overrides, "campaignCapMicrousd", 5_000_000n),
    overrideValue(overrides, "maxRuns", 5n),
    times.issuedAt,
    times.notBefore,
    times.expiresAt,
  );
}

async function insertWorkspaceAuthority(database, overrides = {}) {
  const times = authorityTimes(overrides);
  return database.$queryRawUnsafe(
    `INSERT INTO execution_budget_authority(
      scope_key, authority_kind, workspace_id, issuer, audience, jti,
      token_sha256, schema_version, purpose, subject_type, subject_id,
      request_sha256, currency, unit, cap_microusd, issued_at, not_before,
      expires_at, consumed_at
    ) VALUES (
      $1, 'WORKSPACE_GRANT', $2::uuid, $3, $4, $5::uuid, $6, $7,
      'icp.design', 'company', 'direct-shape-company', $8, 'USD', 'microusd',
      $9::bigint, $10::timestamptz, $11::timestamptz, $12::timestamptz, now()
    ) RETURNING id`,
    WS_A,
    overrideValue(overrides, "workspaceId", WS_A),
    ISSUER,
    AUDIENCE,
    randomUUID(),
    "7".repeat(64),
    "execution-budget-grant/v1",
    overrideValue(overrides, "requestSha256", REQUEST_A),
    overrideValue(overrides, "capMicrousd", 1n),
    times.issuedAt,
    times.notBefore,
    times.expiresAt,
  );
}

async function insertPlatformAuthority(database, overrides = {}) {
  const times = authorityTimes(overrides);
  return database.$queryRawUnsafe(
    `INSERT INTO execution_budget_authority(
      scope_key, authority_kind, issuer, audience, jti, token_sha256,
      schema_version, purpose, subject_type, subject_id, schedule_id, currency,
      unit, cap_per_run_microusd, campaign_cap_microusd, max_runs, issued_at,
      not_before, expires_at
    ) VALUES (
      'platform', 'PLATFORM_GRANT', $1, $2, $3::uuid, $4, $5,
      'platform.acquisition', 'schedule', 'direct-shape-schedule', $6, 'USD',
      'microusd', $7::bigint, $8::bigint, $9::bigint, $10::timestamptz,
      $11::timestamptz, $12::timestamptz
    ) RETURNING id`,
    ISSUER,
    AUDIENCE,
    randomUUID(),
    "8".repeat(64),
    "execution-budget-grant/v1",
    overrideValue(overrides, "scheduleId", "direct-shape-schedule"),
    overrideValue(overrides, "capPerRunMicrousd", 1n),
    overrideValue(overrides, "campaignCapMicrousd", 2n),
    overrideValue(overrides, "maxRuns", 2n),
    times.issuedAt,
    times.notBefore,
    times.expiresAt,
  );
}

async function migrationObjects(database) {
  const [state] = await database.$queryRawUnsafe(`
    SELECT
      to_regtype('public.execution_budget_authority_kind')::text AS kind_type,
      to_regclass('public.execution_budget_authority')::text AS authority_table,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='tool_budget_account'
          AND column_name='authority_id'
      ) AS account_column
  `);
  return state;
}

async function exerciseMigrationRolePreconditions(ownerDatabase) {
  const scenarioDatabase = "authority_task3_preflight";
  const noCreateLogin = "execution_budget_no_create_test";
  const noCreatePassword = "execution-budget-no-create-test-only";
  const scenarioUrl = databaseUrl(OWNER_URL, scenarioDatabase);
  let scenario;

  await ownerDatabase.$executeRawUnsafe(`CREATE DATABASE ${scenarioDatabase}`);
  try {
    const migrationEntries = (
      await readdir(migrationsRoot, { withFileTypes: true })
    )
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name !== "20260821090000_execution_budget_authority",
      )
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of migrationEntries) {
      const deployed = spawnSync(
        "psql",
        [
          scenarioUrl,
          "--no-psqlrc",
          "--single-transaction",
          "--set",
          "ON_ERROR_STOP=1",
          "--file",
          resolve(migrationsRoot, entry.name, "migration.sql"),
        ],
        { encoding: "utf8" },
      );
      assert.equal(
        deployed.status,
        0,
        `preflight setup migration ${entry.name} failed\n${deployed.stdout}\n${deployed.stderr}`,
      );
    }

    scenario = client(scenarioUrl);
    await ownerDatabase.$executeRawUnsafe(`
      CREATE ROLE ${noCreateLogin}
        LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS PASSWORD '${noCreatePassword}'
    `);
    const noCreate = spawnSync(
      "psql",
      [
        databaseUrl(
          OWNER_URL,
          scenarioDatabase,
          noCreateLogin,
          noCreatePassword,
        ),
        "--no-psqlrc",
        "--set",
        "ON_ERROR_STOP=1",
        "--file",
        migrationPath,
      ],
      { encoding: "utf8" },
    );
    const afterNoCreate = await migrationObjects(scenario);
    await ownerDatabase.$executeRawUnsafe(`DROP ROLE ${noCreateLogin}`);

    await ownerDatabase.$executeRawUnsafe(`
      CREATE ROLE execution_budget_platform_writer
        LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    `);
    const unsafeRole = spawnSync(
      "psql",
      [
        scenarioUrl,
        "--no-psqlrc",
        "--set",
        "ON_ERROR_STOP=1",
        "--file",
        migrationPath,
      ],
      { encoding: "utf8" },
    );
    const afterUnsafeRole = await migrationObjects(scenario);
    await ownerDatabase.$executeRawUnsafe(
      `DROP ROLE execution_budget_platform_writer`,
    );

    return {
      noCreateStatus: noCreate.status,
      noCreateOutput: `${noCreate.stdout}\n${noCreate.stderr}`,
      afterNoCreate,
      unsafeRoleStatus: unsafeRole.status,
      unsafeRoleOutput: `${unsafeRole.stdout}\n${unsafeRole.stderr}`,
      afterUnsafeRole,
    };
  } finally {
    await scenario?.$disconnect();
    await ownerDatabase.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS ${scenarioDatabase} WITH (FORCE)`,
    );
    await ownerDatabase.$executeRawUnsafe(
      `DROP ROLE IF EXISTS ${noCreateLogin}`,
    );
    await ownerDatabase.$executeRawUnsafe(
      `DROP ROLE IF EXISTS execution_budget_platform_writer`,
    );
  }
}

async function openAuthorized(
  transaction,
  { scopeKey, authorityId, accountKey, replayScope = false },
) {
  return transaction.$queryRawUnsafe(
    `SELECT * FROM open_authorized_tool_budget_v1(
      $1, $2::uuid, $3, $4::boolean
    )`,
    scopeKey,
    authorityId,
    accountKey,
    replayScope,
  );
}

describe("execution budget authority migration integrity", () => {
  it("is additive, forward-only and one explicit bounded-lock transaction", async () => {
    const sql = await readFile(migrationPath, "utf8");
    assert.match(sql, /^--[^]*?\nBEGIN;\n/);
    assert.match(sql.trimEnd(), /COMMIT;$/);
    assert.match(sql, /SET LOCAL lock_timeout = '5s';/);
    assert.doesNotMatch(sql, /CREATE\s+INDEX\s+CONCURRENTLY/i);
    assert.doesNotMatch(sql, /\b(DROP\s+TABLE|DROP\s+COLUMN)\b/i);
    assert.doesNotMatch(sql, /^\s*TRUNCATE\b/im);
  });

  it("adds new functions without replacing the legacy open function", async () => {
    const sql = await readFile(migrationPath, "utf8");
    assert.match(
      sql,
      /CREATE FUNCTION consume_workspace_execution_authority\(/,
    );
    assert.match(sql, /CREATE FUNCTION ingest_platform_execution_authority\(/);
    assert.match(sql, /CREATE FUNCTION open_authorized_tool_budget_v1\(/);
    assert.doesNotMatch(
      sql,
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+open_tool_budget/i,
    );
    assert.doesNotMatch(sql, /DROP\s+FUNCTION\s+open_tool_budget/i);
  });
});

describe("execution budget authority PostgreSQL, RLS and concurrency", () => {
  /** @type {PrismaClient | undefined} */
  let owner;
  /** @type {PrismaClient | undefined} */
  let app;
  /** @type {PrismaClient | undefined} */
  let platform;
  let preflightEvidence;
  const raceClients = [];

  before(async () => {
    requireDatabaseUrl("DATABASE_URL", OWNER_URL);
    requireDatabaseUrl("APP_DATABASE_URL", APP_URL);

    owner = client(OWNER_URL);
    preflightEvidence = await exerciseMigrationRolePreconditions(owner);

    const deployment = spawnSync(
      "pnpm",
      ["--filter", "@global/db", "exec", "prisma", "migrate", "deploy"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: OWNER_URL },
      },
    );
    assert.equal(
      deployment.status,
      0,
      `all migrations must deploy on the fresh database\n${deployment.stdout}\n${deployment.stderr}`,
    );

    await owner.$executeRawUnsafe(`
      DO $role$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = '${PLATFORM_LOGIN}'
        ) THEN
          CREATE ROLE ${PLATFORM_LOGIN}
            LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
            NOREPLICATION NOBYPASSRLS PASSWORD '${PLATFORM_PASSWORD}';
        END IF;
      END
      $role$
    `);
    await owner.$executeRawUnsafe(
      `GRANT execution_budget_platform_writer TO ${PLATFORM_LOGIN}`,
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO workspace (id, name, created_at, updated_at) VALUES
        ('${WS_A}'::uuid, 'Authority WS A', now(), now()),
        ('${WS_B}'::uuid, 'Authority WS B', now(), now())
       ON CONFLICT (id) DO NOTHING`,
    );

    app = client(APP_URL);
    platform = client(platformUrl());
  });

  after(async () => {
    await Promise.allSettled(
      raceClients.map((database) => database.$disconnect()),
    );
    await Promise.allSettled([app?.$disconnect(), platform?.$disconnect()]);
    if (owner) {
      await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${PLATFORM_LOGIN}`);
      await owner.$disconnect();
    }
  });

  it("deployed every migration and keeps both authority tables under FORCE RLS", async () => {
    const migrationDirectories = (
      await readdir(resolve(repositoryRoot, "packages/db/prisma/migrations"), {
        withFileTypes: true,
      })
    ).filter((entry) => entry.isDirectory()).length;
    const [{ count: deployedCount }] = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL`,
    );
    assert.equal(deployedCount, migrationDirectories);

    const rls = await owner.$queryRawUnsafe(`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname IN (
        'execution_budget_authority',
        'execution_budget_authority_revocation'
      )
      ORDER BY relname
    `);
    assert.deepEqual(rls, [
      {
        relname: "execution_budget_authority",
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      {
        relname: "execution_budget_authority_revocation",
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
    ]);
  });

  it("fails role preconditions before any Task 3 schema mutation", () => {
    assert.notEqual(preflightEvidence.noCreateStatus, 0);
    assert.match(
      preflightEvidence.noCreateOutput,
      /EXECUTION_BUDGET_AUTHORITY_MIGRATION_REQUIRES_CREATEROLE/,
    );
    assert.deepEqual(preflightEvidence.afterNoCreate, {
      kind_type: null,
      authority_table: null,
      account_column: false,
    });

    assert.notEqual(preflightEvidence.unsafeRoleStatus, 0);
    assert.match(
      preflightEvidence.unsafeRoleOutput,
      /EXECUTION_BUDGET_PLATFORM_WRITER_ROLE_INVALID/,
    );
    assert.deepEqual(preflightEvidence.afterUnsafeRole, {
      kind_type: null,
      authority_table: null,
      account_column: false,
    });
  });

  it("uses fixed SECURITY DEFINER search paths and narrow role grants", async () => {
    const functions = await owner.$queryRawUnsafe(`
      SELECT proname, prosecdef, proconfig
      FROM pg_proc
      WHERE proname IN (
        'consume_workspace_execution_authority',
        'ingest_platform_execution_authority',
        'mark_execution_budget_authority_revoked',
        'open_authorized_tool_budget_v1'
      )
      ORDER BY proname
    `);
    assert.equal(functions.length, 4);
    for (const entry of functions) {
      assert.equal(entry.prosecdef, true);
      assert.deepEqual(entry.proconfig, ["search_path=pg_catalog, public"]);
    }

    const [privileges] = await owner.$queryRawUnsafe(`
      SELECT
        has_function_privilege(
          'app_user',
          'consume_workspace_execution_authority(text,text,uuid,text,text,execution_budget_purpose,uuid,text,text,text,text,text,bigint,timestamptz,timestamptz,timestamptz)',
          'EXECUTE'
        ) AS app_consume,
        has_function_privilege(
          'app_user',
          'ingest_platform_execution_authority(text,text,uuid,text,text,execution_budget_purpose,text,text,text,text,text,bigint,bigint,bigint,timestamptz,timestamptz,timestamptz)',
          'EXECUTE'
        ) AS app_ingest_platform,
        has_function_privilege(
          'execution_budget_platform_writer',
          'ingest_platform_execution_authority(text,text,uuid,text,text,execution_budget_purpose,text,text,text,text,text,bigint,bigint,bigint,timestamptz,timestamptz,timestamptz)',
          'EXECUTE'
        ) AS platform_ingest,
        has_function_privilege(
          'execution_budget_platform_writer',
          'consume_workspace_execution_authority(text,text,uuid,text,text,execution_budget_purpose,uuid,text,text,text,text,text,bigint,timestamptz,timestamptz,timestamptz)',
          'EXECUTE'
        ) AS platform_consume,
        pg_has_role('app_user', 'execution_budget_platform_writer', 'member') AS app_is_platform_writer
    `);
    assert.deepEqual(privileges, {
      app_consume: true,
      app_ingest_platform: false,
      platform_ingest: true,
      platform_consume: false,
      app_is_platform_writer: false,
    });

    const [platformRole] = await owner.$queryRawUnsafe(`
      SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb,
             rolcreaterole, rolreplication
      FROM pg_roles
      WHERE rolname='execution_budget_platform_writer'
    `);
    assert.deepEqual(platformRole, {
      rolcanlogin: false,
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
    });
    const memberships = await owner.$queryRawUnsafe(`
      SELECT granted.rolname
      FROM pg_auth_members membership
      JOIN pg_roles granted ON granted.oid=membership.roleid
      JOIN pg_roles member ON member.oid=membership.member
      WHERE member.rolname='${PLATFORM_LOGIN}'
      ORDER BY granted.rolname
    `);
    assert.deepEqual(memberships, [
      { rolname: "execution_budget_platform_writer" },
    ]);

    const publicFunctionExecution = await owner.$queryRawUnsafe(`
      SELECT procedure.proname,
             bool_or(privilege.grantee=0 AND privilege.privilege_type='EXECUTE')
               AS public_execute
      FROM pg_proc procedure
      CROSS JOIN LATERAL aclexplode(
        COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
      ) privilege
      WHERE procedure.proname IN (
        'consume_workspace_execution_authority',
        'ingest_platform_execution_authority',
        'mark_execution_budget_authority_revoked',
        'open_authorized_tool_budget_v1'
      )
      GROUP BY procedure.proname
      ORDER BY procedure.proname
    `);
    assert.deepEqual(publicFunctionExecution, [
      {
        proname: "consume_workspace_execution_authority",
        public_execute: false,
      },
      {
        proname: "ingest_platform_execution_authority",
        public_execute: false,
      },
      {
        proname: "mark_execution_budget_authority_revoked",
        public_execute: false,
      },
      {
        proname: "open_authorized_tool_budget_v1",
        public_execute: false,
      },
    ]);

    const [tablePrivileges] = await owner.$queryRawUnsafe(`
      SELECT
        has_table_privilege('app_user', 'execution_budget_authority', 'UPDATE')
          AS app_authority_update,
        has_table_privilege('app_user', 'execution_budget_authority', 'DELETE')
          AS app_authority_delete,
        has_table_privilege(
          'app_user',
          'execution_budget_authority_revocation',
          'UPDATE'
        ) AS app_revocation_update,
        has_table_privilege(
          'app_user',
          'execution_budget_authority_revocation',
          'DELETE'
        ) AS app_revocation_delete,
        has_table_privilege(
          'execution_budget_platform_writer',
          'execution_budget_authority',
          'UPDATE'
        ) AS platform_authority_update,
        has_table_privilege(
          'execution_budget_platform_writer',
          'execution_budget_authority',
          'DELETE'
        ) AS platform_authority_delete
    `);
    assert.deepEqual(tablePrivileges, {
      app_authority_update: false,
      app_authority_delete: false,
      app_revocation_update: false,
      app_revocation_delete: false,
      platform_authority_update: false,
      platform_authority_delete: false,
    });
  });

  it("rejects hostile NULL claims before either authority shape can be stored", async () => {
    const workspaceNulls = [
      ["issuer", { issuer: null }],
      ["audience", { audience: null }],
      ["jti", { jti: null }],
      ["tokenSha256", { tokenSha256: null }],
      ["schemaVersion", { schemaVersion: null }],
      ["purpose", { purpose: null }],
      ["workspaceId", { workspaceId: null }],
      ["subjectType", { subjectType: null }],
      ["subjectId", { subjectId: null }],
      ["requestSha256", { requestSha256: null }],
      ["capMicrousd", { capMicrousd: null }],
      ["currency", { currency: null }],
      ["unit", { unit: null }],
      ["issuedAt", { issuedAt: null }],
      ["notBefore", { notBefore: null }],
      ["expiresAt", { expiresAt: null }],
    ];
    for (const [name, overrides] of workspaceNulls) {
      await rejectsSql(
        () =>
          withWorkspace(app, WS_A, (transaction) =>
            consumeWorkspace(transaction, overrides),
          ),
        "EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH",
      ).catch((error) => {
        error.message = `workspace ${name}: ${error.message}`;
        throw error;
      });
    }

    const platformNulls = [
      ["issuer", { issuer: null }],
      ["audience", { audience: null }],
      ["jti", { jti: null }],
      ["tokenSha256", { tokenSha256: null }],
      ["schemaVersion", { schemaVersion: null }],
      ["purpose", { purpose: null }],
      ["subjectType", { subjectType: null }],
      ["subjectId", { subjectId: null }],
      ["scheduleId", { scheduleId: null }],
      ["capPerRunMicrousd", { capPerRunMicrousd: null }],
      ["campaignCapMicrousd", { campaignCapMicrousd: null }],
      ["maxRuns", { maxRuns: null }],
      ["currency", { currency: null }],
      ["unit", { unit: null }],
      ["issuedAt", { issuedAt: null }],
      ["notBefore", { notBefore: null }],
      ["expiresAt", { expiresAt: null }],
    ];
    for (const [name, overrides] of platformNulls) {
      await rejectsSql(
        () => ingestPlatform(platform, overrides),
        "EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH",
      ).catch((error) => {
        error.message = `platform ${name}: ${error.message}`;
        throw error;
      });
    }

    const [{ count }] = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS count FROM execution_budget_authority`,
    );
    assert.equal(count, 0);
  });

  it("keeps both table authority-shape checks two-valued for nullable columns", async () => {
    for (const overrides of [
      { workspaceId: null },
      { requestSha256: null },
      { capMicrousd: null },
    ]) {
      await rejectsSql(() => insertWorkspaceAuthority(owner, overrides));
    }
    for (const overrides of [
      { scheduleId: null },
      { capPerRunMicrousd: null },
      { campaignCapMicrousd: null },
      { maxRuns: null },
    ]) {
      await rejectsSql(() => insertPlatformAuthority(owner, overrides));
    }

    const [{ count }] = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS count FROM execution_budget_authority`,
    );
    assert.equal(count, 0);
  });

  it("requires Tool budget authority id and authorized cap to form a positive pair", async () => {
    const [authority] = await withWorkspace(app, WS_A, (transaction) =>
      consumeWorkspace(transaction, {
        jti: randomUUID(),
        subjectId: "account-pair-company",
      }),
    );

    await rejectsSql(() =>
      owner.$executeRawUnsafe(
        `INSERT INTO tool_budget_account
          (scope_key, account_key, cap_cents, authority_id,
           authorized_cap_microusd)
         VALUES ($1, $2, 1, $3::uuid, NULL)`,
        WS_A,
        `authority-without-cap-${randomUUID()}`,
        authority.authority_id,
      ),
    );
    await rejectsSql(() =>
      owner.$executeRawUnsafe(
        `INSERT INTO tool_budget_account
          (scope_key, account_key, cap_cents, authority_id,
           authorized_cap_microusd)
         VALUES ($1, $2, 1, NULL, 1)`,
        WS_A,
        `cap-without-authority-${randomUUID()}`,
      ),
    );
    await rejectsSql(() =>
      owner.$executeRawUnsafe(
        `INSERT INTO tool_budget_account
          (scope_key, account_key, cap_cents, authority_id,
           authorized_cap_microusd)
         VALUES ($1, $2, 1, $3::uuid, 0)`,
        WS_A,
        `non-positive-authorized-cap-${randomUUID()}`,
        authority.authority_id,
      ),
    );

    const legacyAccountKey = `legacy-null-pair-${randomUUID()}`;
    await owner.$executeRawUnsafe(
      `INSERT INTO tool_budget_account
        (scope_key, account_key, cap_cents, authority_id,
         authorized_cap_microusd)
       VALUES ($1, $2, 1, NULL, NULL)`,
      WS_A,
      legacyAccountKey,
    );
    const [legacyPair] = await owner.$queryRawUnsafe(
      `SELECT authority_id, authorized_cap_microusd
       FROM tool_budget_account WHERE account_key=$1`,
      legacyAccountKey,
    );
    assert.deepEqual(legacyPair, {
      authority_id: null,
      authorized_cap_microusd: null,
    });
  });

  it("replays an exact JTI after expiry while conflicting reuse remains a conflict", async () => {
    const replayTimes = {
      issuedAt: new Date(Date.now() - 30_000),
      notBefore: new Date(Date.now() - 20_000),
      expiresAt: new Date(Date.now() + 800),
    };
    const workspaceClaims = {
      ...replayTimes,
      jti: randomUUID(),
      tokenSha256: "1".repeat(64),
      subjectId: "expired-replay-company",
      requestSha256: "2".repeat(64),
      capMicrousd: 101n,
    };
    const platformClaims = {
      ...replayTimes,
      jti: randomUUID(),
      tokenSha256: "3".repeat(64),
      subjectId: "expired-replay-schedule",
      scheduleId: "expired-replay-schedule",
      capPerRunMicrousd: 31n,
      campaignCapMicrousd: 93n,
      maxRuns: 3n,
    };

    const [workspaceAuthority] = await withWorkspace(app, WS_A, (transaction) =>
      consumeWorkspace(transaction, workspaceClaims),
    );
    const [platformAuthority] = await ingestPlatform(platform, platformClaims);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_200));

    const workspaceReplay = await withWorkspace(app, WS_A, (transaction) =>
      consumeWorkspace(transaction, workspaceClaims),
    );
    const platformReplay = await ingestPlatform(platform, platformClaims);
    assert.deepEqual(workspaceReplay, [
      { authority_id: workspaceAuthority.authority_id, replay: true },
    ]);
    assert.deepEqual(platformReplay, [
      { authority_id: platformAuthority.authority_id, replay: true },
    ]);

    await rejectsSql(
      () =>
        withWorkspace(app, WS_A, (transaction) =>
          consumeWorkspace(transaction, {
            ...workspaceClaims,
            tokenSha256: "4".repeat(64),
          }),
        ),
      "EXECUTION_BUDGET_GRANT_REUSED",
    );
    await rejectsSql(
      () =>
        withWorkspace(app, WS_A, (transaction) =>
          consumeWorkspace(transaction, {
            ...workspaceClaims,
            requestSha256: "5".repeat(64),
          }),
        ),
      "EXECUTION_BUDGET_GRANT_REUSED",
    );
    await rejectsSql(
      () =>
        ingestPlatform(platform, {
          ...platformClaims,
          tokenSha256: "6".repeat(64),
        }),
      "EXECUTION_BUDGET_GRANT_REUSED",
    );
    await rejectsSql(
      () =>
        ingestPlatform(platform, {
          ...platformClaims,
          scheduleId: "changed-expired-replay-schedule",
        }),
      "EXECUTION_BUDGET_GRANT_REUSED",
    );

    const [{ count }] = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS count
       FROM execution_budget_authority
       WHERE jti IN ($1::uuid, $2::uuid)`,
      workspaceClaims.jti,
      platformClaims.jti,
    );
    assert.equal(count, 2);
  });

  it("atomically consumes one immutable workspace identity in a 20-client same-JTI race", async () => {
    const jti = randomUUID();
    for (let index = 0; index < 20; index += 1)
      raceClients.push(client(APP_URL));

    const results = await Promise.all(
      raceClients.map((database) =>
        withWorkspace(database, WS_A, (transaction) =>
          consumeWorkspace(transaction, { jti }),
        ),
      ),
    );
    const rows = results.flat();
    assert.equal(new Set(rows.map((row) => row.authority_id)).size, 1);
    assert.equal(rows.filter((row) => row.replay === false).length, 1);
    assert.equal(rows.filter((row) => row.replay === true).length, 19);

    const stored = await owner.$queryRawUnsafe(
      `SELECT id, issuer, jti, token_sha256, request_sha256, consumed_at
       FROM execution_budget_authority
       WHERE issuer=$1 AND jti=$2::uuid`,
      ISSUER,
      jti,
    );
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, rows[0].authority_id);
    assert.equal(stored[0].token_sha256, TOKEN_A);
    assert.equal(stored[0].request_sha256, REQUEST_A);
    assert.ok(stored[0].consumed_at instanceof Date);

    const openedAccounts = (
      await Promise.all(
        raceClients.map((database) =>
          withWorkspace(database, WS_A, (transaction) =>
            openAuthorized(transaction, {
              scopeKey: WS_A,
              authorityId: stored[0].id,
              accountKey: `same-jti-account-${jti}`,
            }),
          ),
        ),
      )
    ).flat();
    assert.equal(new Set(openedAccounts.map((row) => row.account_id)).size, 1);
    assert.equal(new Set(openedAccounts.map((row) => row.generation)).size, 1);
    const [identityState] = await owner.$queryRawUnsafe(
      `SELECT
         count(account.id)::int AS accounts,
         min(authority.runs_consumed) AS runs_consumed
       FROM execution_budget_authority authority
       LEFT JOIN tool_budget_account account ON account.authority_id=authority.id
       WHERE authority.id=$1::uuid`,
      stored[0].id,
    );
    assert.deepEqual(identityState, { accounts: 1, runs_consumed: 1n });

    await withWorkspace(app, WS_A, async (transaction) => {
      const replay = await consumeWorkspace(transaction, { jti });
      assert.deepEqual(replay, [{ authority_id: stored[0].id, replay: true }]);
    });
    await rejectsSql(
      () =>
        withWorkspace(app, WS_A, (transaction) =>
          consumeWorkspace(transaction, {
            jti,
            tokenSha256: "d".repeat(64),
          }),
        ),
      "EXECUTION_BUDGET_GRANT_REUSED",
    );
    await rejectsSql(
      () =>
        withWorkspace(app, WS_A, (transaction) =>
          consumeWorkspace(transaction, { jti, requestSha256: REQUEST_B }),
        ),
      "EXECUTION_BUDGET_GRANT_REUSED",
    );

    const [{ count }] = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS count
       FROM execution_budget_authority
       WHERE issuer=$1 AND jti=$2::uuid`,
      ISSUER,
      jti,
    );
    assert.equal(count, 1);
  });

  it("denies direct state mutation and hides cross-workspace and platform rows", async () => {
    const [authority] = await withWorkspace(app, WS_A, (transaction) =>
      consumeWorkspace(transaction, { jti: randomUUID() }),
    );
    const [foreignAuthority] = await withWorkspace(app, WS_B, (transaction) =>
      consumeWorkspace(transaction, {
        jti: randomUUID(),
        workspaceId: WS_B,
        subjectId: "company-b",
        requestSha256: REQUEST_B,
      }),
    );
    const [platformAuthority] = await ingestPlatform(platform, {
      jti: randomUUID(),
      subjectId: "visibility-schedule",
      scheduleId: "visibility-schedule",
    });
    const [platformRevocation] = await owner.$queryRawUnsafe(
      `INSERT INTO execution_budget_authority_revocation
        (scope_key, authority_id, reason)
       VALUES ('platform', $1::uuid, 'platform-policy-readback')
       RETURNING id`,
      platformAuthority.authority_id,
    );

    await rejectsSql(() =>
      withWorkspace(app, WS_A, (transaction) =>
        transaction.$executeRawUnsafe(
          "UPDATE execution_budget_authority SET expires_at=now() WHERE id=$1::uuid",
          authority.authority_id,
        ),
      ),
    );
    await rejectsSql(() =>
      withWorkspace(app, WS_A, (transaction) =>
        transaction.$executeRawUnsafe(
          "DELETE FROM execution_budget_authority WHERE id=$1::uuid",
          authority.authority_id,
        ),
      ),
    );
    await rejectsSql(() =>
      withWorkspace(app, WS_A, (transaction) =>
        transaction.$executeRawUnsafe(
          `INSERT INTO execution_budget_authority
            (scope_key, authority_kind, workspace_id, issuer, audience, jti,
             token_sha256, schema_version, purpose, subject_type, subject_id,
             request_sha256, currency, unit, cap_microusd, issued_at,
             not_before, expires_at, consumed_at)
           VALUES
            ($1, 'WORKSPACE_GRANT', $1::uuid, $2, $3, $4::uuid, $5, $6,
             'icp.design', 'company', 'forged-company', $7, 'USD', 'microusd',
             1, now(), now(), now() + interval '1 minute', now())`,
          WS_A,
          ISSUER,
          AUDIENCE,
          randomUUID(),
          "e".repeat(64),
          "execution-budget-grant/v1",
          REQUEST_A,
        ),
      ),
    );

    await withWorkspace(app, WS_A, async (transaction) => {
      const foreignRows = await transaction.$queryRawUnsafe(
        "SELECT id FROM execution_budget_authority WHERE workspace_id=$1::uuid",
        WS_B,
      );
      assert.deepEqual(foreignRows, []);
      const platformRows = await transaction.$queryRawUnsafe(
        "SELECT id FROM execution_budget_authority WHERE id=$1::uuid",
        platformAuthority.authority_id,
      );
      assert.deepEqual(platformRows, []);
      const platformRevocations = await transaction.$queryRawUnsafe(
        `SELECT id FROM execution_budget_authority_revocation
         WHERE id=$1::uuid`,
        platformRevocation.id,
      );
      assert.deepEqual(platformRevocations, []);
    });

    const missingError = await captureSqlError(
      () =>
        withWorkspace(app, WS_A, (transaction) =>
          openAuthorized(transaction, {
            scopeKey: WS_A,
            authorityId: randomUUID(),
            accountKey: "missing-authority",
          }),
        ),
      "EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH",
    );
    const foreignError = await captureSqlError(
      () =>
        withWorkspace(app, WS_A, (transaction) =>
          openAuthorized(transaction, {
            scopeKey: WS_A,
            authorityId: foreignAuthority.authority_id,
            accountKey: "foreign-authority",
          }),
        ),
      "EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH",
    );
    assert.match(missingError, /EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH/);
    assert.match(foreignError, /EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH/);

    await rejectsSql(
      () =>
        withWorkspace(platform, WS_A, (transaction) =>
          openAuthorized(transaction, {
            scopeKey: WS_A,
            authorityId: authority.authority_id,
            accountKey: `platform-writer-workspace-${randomUUID()}`,
          }),
        ),
      "EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH",
    );

    await rejectsSql(() =>
      withWorkspace(app, WS_A, (transaction) =>
        transaction.$executeRawUnsafe(
          `INSERT INTO execution_budget_authority_revocation
            (scope_key, authority_id, reason)
           VALUES ($1, $2::uuid, 'cross-workspace-attempt')`,
          WS_A,
          foreignAuthority.authority_id,
        ),
      ),
    );
    const [foreignState] = await owner.$queryRawUnsafe(
      "SELECT revoked_at FROM execution_budget_authority WHERE id=$1::uuid",
      foreignAuthority.authority_id,
    );
    assert.equal(foreignState.revoked_at, null);

    await withWorkspace(app, WS_A, (transaction) =>
      transaction.$executeRawUnsafe(
        `INSERT INTO execution_budget_authority_revocation
          (scope_key, authority_id, reason)
         VALUES ($1, $2::uuid, 'workspace-visible-only')`,
        WS_A,
        authority.authority_id,
      ),
    );
    await withWorkspace(platform, WS_A, async (transaction) => {
      const workspaceAuthorities = await transaction.$queryRawUnsafe(
        "SELECT id FROM execution_budget_authority WHERE workspace_id=$1::uuid",
        WS_A,
      );
      const workspaceRevocations = await transaction.$queryRawUnsafe(
        "SELECT id FROM execution_budget_authority_revocation WHERE scope_key=$1",
        WS_A,
      );
      assert.deepEqual(workspaceAuthorities, []);
      assert.deepEqual(workspaceRevocations, []);
    });

    const platformWorkspaceRows = await platform.$queryRawUnsafe(
      "SELECT id FROM execution_budget_authority WHERE workspace_id=$1::uuid",
      WS_A,
    );
    assert.deepEqual(platformWorkspaceRows, []);
    const intendedPlatformRows = await platform.$queryRawUnsafe(
      "SELECT id FROM execution_budget_authority WHERE id=$1::uuid",
      platformAuthority.authority_id,
    );
    assert.deepEqual(intendedPlatformRows, [
      { id: platformAuthority.authority_id },
    ]);
    const intendedPlatformRevocations = await platform.$queryRawUnsafe(
      `SELECT id FROM execution_budget_authority_revocation
       WHERE id=$1::uuid`,
      platformRevocation.id,
    );
    assert.deepEqual(intendedPlatformRevocations, [
      { id: platformRevocation.id },
    ]);
    await rejectsSql(() => ingestPlatform(app, { jti: randomUUID() }));
  });

  it("keeps revocation append-only and blocks an authority before account creation", async () => {
    const [authority] = await withWorkspace(app, WS_A, (transaction) =>
      consumeWorkspace(transaction, {
        jti: randomUUID(),
        subjectId: "revoked-company",
      }),
    );

    await withWorkspace(app, WS_A, async (transaction) => {
      await transaction.$executeRawUnsafe(
        `INSERT INTO execution_budget_authority_revocation
          (scope_key, authority_id, reason)
         VALUES ($1, $2::uuid, $3)`,
        WS_A,
        authority.authority_id,
        "control-plane-revoked",
      );
    });
    await rejectsSql(
      () =>
        withWorkspace(app, WS_A, (transaction) =>
          openAuthorized(transaction, {
            scopeKey: WS_A,
            authorityId: authority.authority_id,
            accountKey: "revoked-account",
          }),
        ),
      "EXECUTION_BUDGET_AUTHORITY_REVOKED",
    );
    await rejectsSql(() =>
      withWorkspace(app, WS_A, (transaction) =>
        transaction.$executeRawUnsafe(
          "UPDATE execution_budget_authority_revocation SET reason=$1 WHERE authority_id=$2::uuid",
          "rewritten",
          authority.authority_id,
        ),
      ),
    );
    await rejectsSql(() =>
      withWorkspace(app, WS_A, (transaction) =>
        transaction.$executeRawUnsafe(
          "DELETE FROM execution_budget_authority_revocation WHERE authority_id=$1::uuid",
          authority.authority_id,
        ),
      ),
    );

    const [state] = await owner.$queryRawUnsafe(
      `SELECT a.revoked_at, count(r.id)::int AS revocations
       FROM execution_budget_authority a
       LEFT JOIN execution_budget_authority_revocation r ON r.authority_id=a.id
       WHERE a.id=$1::uuid
       GROUP BY a.id`,
      authority.authority_id,
    );
    assert.ok(state.revoked_at instanceof Date);
    assert.equal(state.revocations, 1);
  });

  it("rejects not-yet-valid and expired authority without creating an account", async () => {
    const [futureAuthority] = await ingestPlatform(platform, {
      jti: randomUUID(),
      subjectId: "future-schedule",
      scheduleId: "future-schedule",
    });
    const [expiredAuthority] = await ingestPlatform(platform, {
      jti: randomUUID(),
      subjectId: "expired-schedule",
      scheduleId: "expired-schedule",
    });
    await owner.$executeRawUnsafe(
      `UPDATE execution_budget_authority
       SET not_before=clock_timestamp() + interval '1 minute'
       WHERE id=$1::uuid`,
      futureAuthority.authority_id,
    );
    await owner.$executeRawUnsafe(
      `UPDATE execution_budget_authority
       SET expires_at=clock_timestamp() - interval '1 millisecond'
       WHERE id=$1::uuid`,
      expiredAuthority.authority_id,
    );

    await rejectsSql(
      () =>
        openAuthorized(platform, {
          scopeKey: "platform",
          authorityId: futureAuthority.authority_id,
          accountKey: "future-account",
        }),
      "EXECUTION_BUDGET_GRANT_INVALID",
    );
    await rejectsSql(
      () =>
        openAuthorized(platform, {
          scopeKey: "platform",
          authorityId: expiredAuthority.authority_id,
          accountKey: "expired-account",
        }),
      "EXECUTION_BUDGET_GRANT_EXPIRED",
    );

    const [{ count }] = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS count
       FROM tool_budget_account
       WHERE account_key IN ('future-account', 'expired-account')`,
    );
    assert.equal(count, 0);
  });

  it("derives platform caps, binds accounts and consumes each new generation once", async () => {
    const [authority] = await ingestPlatform(platform, {
      jti: randomUUID(),
      subjectId: "bounded-schedule",
      scheduleId: "bounded-schedule",
      capPerRunMicrousd: 60n,
      campaignCapMicrousd: 100n,
      maxRuns: 3n,
    });

    const [first] = await openAuthorized(platform, {
      scopeKey: "platform",
      authorityId: authority.authority_id,
      accountKey: "platform-run-1",
    });
    const [firstReplay] = await openAuthorized(platform, {
      scopeKey: "platform",
      authorityId: authority.authority_id,
      accountKey: "platform-run-1",
    });
    const [second] = await openAuthorized(platform, {
      scopeKey: "platform",
      authorityId: authority.authority_id,
      accountKey: "platform-run-2",
    });

    assert.equal(first.authorized_cap_microusd, 60n);
    assert.equal(firstReplay.account_id, first.account_id);
    assert.equal(firstReplay.generation, first.generation);
    assert.equal(firstReplay.authorized_cap_microusd, 60n);
    assert.equal(second.authorized_cap_microusd, 40n);

    await rejectsSql(
      () =>
        openAuthorized(platform, {
          scopeKey: "platform",
          authorityId: authority.authority_id,
          accountKey: "platform-run-3",
        }),
      "EXECUTION_BUDGET_AUTHORITY_EXHAUSTED",
    );

    const [state] = await owner.$queryRawUnsafe(
      `SELECT runs_consumed, consumed_at
       FROM execution_budget_authority WHERE id=$1::uuid`,
      authority.authority_id,
    );
    assert.equal(state.runs_consumed, 2n);
    assert.ok(state.consumed_at instanceof Date);

    const accounts = await owner.$queryRawUnsafe(
      `SELECT account_key, authority_id, authorized_cap_microusd, cap_cents,
              reserved_cents, charged_cents
       FROM tool_budget_account
       WHERE authority_id=$1::uuid
       ORDER BY account_key`,
      authority.authority_id,
    );
    assert.deepEqual(accounts, [
      {
        account_key: "platform-run-1",
        authority_id: authority.authority_id,
        authorized_cap_microusd: 60n,
        cap_cents: 60n,
        reserved_cents: 0n,
        charged_cents: 0n,
      },
      {
        account_key: "platform-run-2",
        authority_id: authority.authority_id,
        authorized_cap_microusd: 40n,
        cap_cents: 40n,
        reserved_cents: 0n,
        charged_cents: 0n,
      },
    ]);
  });

  it("increments a platform run exactly once when concurrent opens create one new generation", async () => {
    const [authority] = await ingestPlatform(platform, {
      jti: randomUUID(),
      subjectId: "generation-schedule",
      scheduleId: "generation-schedule",
      capPerRunMicrousd: 50n,
      campaignCapMicrousd: 150n,
      maxRuns: 3n,
    });
    const [first] = await openAuthorized(platform, {
      scopeKey: "platform",
      authorityId: authority.authority_id,
      accountKey: "platform-generation-account",
    });
    assert.equal(first.generation, 1);

    await owner.$executeRawUnsafe(`
      DO $close$
      BEGIN
        PERFORM close_tool_budget(
          'platform',
          'platform-generation-account',
          true
        );
      END
      $close$
    `);

    const generationClients = [];
    for (let index = 0; index < 20; index += 1) {
      const database = client(platformUrl());
      generationClients.push(database);
      raceClients.push(database);
    }
    const opened = (
      await Promise.all(
        generationClients.map((database) =>
          openAuthorized(database, {
            scopeKey: "platform",
            authorityId: authority.authority_id,
            accountKey: "platform-generation-account",
          }),
        ),
      )
    ).flat();
    assert.equal(new Set(opened.map((row) => row.account_id)).size, 1);
    assert.equal(new Set(opened.map((row) => row.generation)).size, 1);
    assert.equal(opened[0].generation, 2);

    const [state] = await owner.$queryRawUnsafe(
      `SELECT runs_consumed FROM execution_budget_authority WHERE id=$1::uuid`,
      authority.authority_id,
    );
    assert.equal(state.runs_consumed, 2n);
  });

  it("allows one workspace account identity and preserves legacy unbound traffic", async () => {
    const [authority] = await withWorkspace(app, WS_A, (transaction) =>
      consumeWorkspace(transaction, {
        jti: randomUUID(),
        subjectId: "single-account-company",
        capMicrousd: 77n,
      }),
    );

    await withWorkspace(app, WS_A, async (transaction) => {
      const [opened] = await openAuthorized(transaction, {
        scopeKey: WS_A,
        authorityId: authority.authority_id,
        accountKey: "workspace-authorized-account",
      });
      assert.equal(opened.authorized_cap_microusd, 77n);
    });
    await rejectsSql(
      () =>
        withWorkspace(app, WS_A, (transaction) =>
          openAuthorized(transaction, {
            scopeKey: WS_A,
            authorityId: authority.authority_id,
            accountKey: "workspace-second-account",
          }),
        ),
      "EXECUTION_BUDGET_AUTHORITY_EXHAUSTED",
    );
    await withWorkspace(app, WS_A, async (transaction) => {
      const legacy = await transaction.$queryRawUnsafe(
        `SELECT * FROM open_tool_budget($1, $2, $3::bigint, $4::boolean)`,
        WS_A,
        "legacy-open-account",
        123n,
        false,
      );
      assert.equal(legacy.length, 1);
    });

    const [authorizedAccount] = await owner.$queryRawUnsafe(
      `SELECT authority_id, authorized_cap_microusd, cap_cents
       FROM tool_budget_account WHERE account_key='workspace-authorized-account'`,
    );
    assert.deepEqual(authorizedAccount, {
      authority_id: authority.authority_id,
      authorized_cap_microusd: 77n,
      cap_cents: 77n,
    });
    const [legacyAccount] = await owner.$queryRawUnsafe(
      `SELECT authority_id, authorized_cap_microusd, cap_cents
       FROM tool_budget_account WHERE account_key='legacy-open-account'`,
    );
    assert.deepEqual(legacyAccount, {
      authority_id: null,
      authorized_cap_microusd: null,
      cap_cents: 123n,
    });
  });
});
