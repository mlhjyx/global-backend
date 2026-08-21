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

async function consumeWorkspaceAtOffsets(
  transaction,
  { issuedAt, notBefore, expiresAt },
  overrides = {},
) {
  return transaction.$queryRawUnsafe(
    `SELECT * FROM consume_workspace_execution_authority(
      $1, $2, $3::uuid, $4, $5, $6::execution_budget_purpose,
      $7::uuid, $8, $9, $10, $11, $12, $13::bigint,
      statement_timestamp() + $14::integer * interval '1 second',
      statement_timestamp() + $15::integer * interval '1 second',
      statement_timestamp() + $16::integer * interval '1 second'
    )`,
    overrideValue(overrides, "issuer", ISSUER),
    overrideValue(overrides, "audience", AUDIENCE),
    overrideValue(overrides, "jti", randomUUID()),
    overrideValue(overrides, "tokenSha256", TOKEN_A),
    overrideValue(overrides, "schemaVersion", "execution-budget-grant/v1"),
    overrideValue(overrides, "purpose", "icp.design"),
    overrideValue(overrides, "workspaceId", WS_A),
    overrideValue(overrides, "subjectType", "company"),
    overrideValue(overrides, "subjectId", `clock-company-${randomUUID()}`),
    overrideValue(overrides, "requestSha256", REQUEST_A),
    overrideValue(overrides, "currency", "USD"),
    overrideValue(overrides, "unit", "microusd"),
    overrideValue(overrides, "capMicrousd", 1n),
    issuedAt,
    notBefore,
    expiresAt,
  );
}

async function ingestPlatformAtOffsets(
  transaction,
  { issuedAt, notBefore, expiresAt },
  overrides = {},
) {
  const scheduleId = overrideValue(
    overrides,
    "scheduleId",
    `clock-schedule-${randomUUID()}`,
  );
  return transaction.$queryRawUnsafe(
    `SELECT * FROM ingest_platform_execution_authority(
      $1, $2, $3::uuid, $4, $5, $6::execution_budget_purpose,
      $7, $8, $9, $10, $11, $12::bigint, $13::bigint, $14::bigint,
      statement_timestamp() + $15::integer * interval '1 second',
      statement_timestamp() + $16::integer * interval '1 second',
      statement_timestamp() + $17::integer * interval '1 second'
    )`,
    overrideValue(overrides, "issuer", ISSUER),
    overrideValue(overrides, "audience", AUDIENCE),
    overrideValue(overrides, "jti", randomUUID()),
    overrideValue(overrides, "tokenSha256", TOKEN_A),
    overrideValue(overrides, "schemaVersion", "execution-budget-grant/v1"),
    overrideValue(overrides, "purpose", "platform.acquisition"),
    overrideValue(overrides, "subjectType", "schedule"),
    overrideValue(overrides, "subjectId", scheduleId),
    scheduleId,
    overrideValue(overrides, "currency", "USD"),
    overrideValue(overrides, "unit", "microusd"),
    overrideValue(overrides, "capPerRunMicrousd", 1n),
    overrideValue(overrides, "campaignCapMicrousd", 2n),
    overrideValue(overrides, "maxRuns", 2n),
    issuedAt,
    notBefore,
    expiresAt,
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
      $8::execution_budget_purpose, $9, $10, $11, $12, $13,
      $14::bigint, $15::timestamptz, $16::timestamptz, $17::timestamptz, now()
    ) RETURNING id`,
    WS_A,
    overrideValue(overrides, "workspaceId", WS_A),
    overrideValue(overrides, "issuer", ISSUER),
    overrideValue(overrides, "audience", AUDIENCE),
    overrideValue(overrides, "jti", randomUUID()),
    overrideValue(overrides, "tokenSha256", "7".repeat(64)),
    overrideValue(overrides, "schemaVersion", "execution-budget-grant/v1"),
    overrideValue(overrides, "purpose", "icp.design"),
    overrideValue(overrides, "subjectType", "company"),
    overrideValue(overrides, "subjectId", "direct-shape-company"),
    overrideValue(overrides, "requestSha256", REQUEST_A),
    overrideValue(overrides, "currency", "USD"),
    overrideValue(overrides, "unit", "microusd"),
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
      $6::execution_budget_purpose, $7, $8, $9, $10, $11,
      $12::bigint, $13::bigint, $14::bigint, $15::timestamptz,
      $16::timestamptz, $17::timestamptz
    ) RETURNING id`,
    overrideValue(overrides, "issuer", ISSUER),
    overrideValue(overrides, "audience", AUDIENCE),
    overrideValue(overrides, "jti", randomUUID()),
    overrideValue(overrides, "tokenSha256", "8".repeat(64)),
    overrideValue(overrides, "schemaVersion", "execution-budget-grant/v1"),
    overrideValue(overrides, "purpose", "platform.acquisition"),
    overrideValue(overrides, "subjectType", "schedule"),
    overrideValue(overrides, "subjectId", "direct-shape-schedule"),
    overrideValue(overrides, "scheduleId", "direct-shape-schedule"),
    overrideValue(overrides, "currency", "USD"),
    overrideValue(overrides, "unit", "microusd"),
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

async function openWorkspaceAuthorizedAtOffsets(
  database,
  { authorityId, accountKey, issuedAt, notBefore, expiresAt },
) {
  return database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      "SELECT set_config('app.current_workspace_id', $1, true)",
      WS_A,
    );
    return transaction.$queryRawUnsafe(
      `WITH updated AS MATERIALIZED (
         UPDATE execution_budget_authority
            SET issued_at=statement_timestamp()
                  + $4::integer * interval '1 second',
                not_before=statement_timestamp()
                  + $5::integer * interval '1 second',
                expires_at=statement_timestamp()
                  + $6::integer * interval '1 second'
          WHERE id=$1::uuid
          RETURNING id
       )
       SELECT opened.*
         FROM updated
         CROSS JOIN LATERAL open_authorized_tool_budget_v1(
           $2, updated.id, $3, false
         ) opened`,
      authorityId,
      WS_A,
      accountKey,
      issuedAt,
      notBefore,
      expiresAt,
    );
  });
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

  it("adds authority primitives and replaces legacy lifecycle functions only with bound-account fences", async () => {
    const sql = await readFile(migrationPath, "utf8");
    assert.match(
      sql,
      /CREATE FUNCTION consume_workspace_execution_authority\(/,
    );
    assert.match(sql, /CREATE FUNCTION ingest_platform_execution_authority\(/);
    assert.match(sql, /CREATE FUNCTION open_authorized_tool_budget_v1\(/);
    assert.ok(
      /CREATE FUNCTION assert_execution_budget_platform_writer_principal\(/.test(
        sql,
      ),
      "migration must define the reusable principal attestation helper",
    );
    assert.ok(
      /CREATE FUNCTION revoke_platform_execution_authority_v1\(/.test(sql),
      "migration must define the narrow platform revocation primitive",
    );
    assert.ok(
      /CREATE FUNCTION inspect_platform_execution_authority_freshness_v1\(/.test(
        sql,
      ),
      "migration must define the deterministic platform freshness primitive",
    );
    for (const routine of [
      "open_tool_budget",
      "reserve_tool_budget",
      "settle_tool_budget",
      "release_tool_budget",
      "tool_budget_status",
      "close_tool_budget",
    ]) {
      assert.ok(
        new RegExp(
          `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+${routine}\\(`,
          "i",
        ).test(sql),
        `migration must fence legacy ${routine}`,
      );
    }
    assert.match(
      sql,
      /EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE/,
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
        'assert_execution_budget_platform_writer_principal',
        'consume_workspace_execution_authority',
        'ingest_platform_execution_authority',
        'mark_execution_budget_authority_revoked',
        'open_authorized_tool_budget_v1',
        'revoke_platform_execution_authority_v1',
        'inspect_platform_execution_authority_freshness_v1'
      )
      ORDER BY proname
    `);
    assert.equal(functions.length, 7);
    for (const entry of functions) {
      assert.equal(entry.prosecdef, true);
      assert.deepEqual(entry.proconfig, ["search_path=pg_catalog, public"]);
    }

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
    const [appMembership] = await owner.$queryRawUnsafe(`
      SELECT pg_has_role(
        'app_user',
        'execution_budget_platform_writer',
        'member'
      ) AS app_is_platform_writer
    `);
    assert.deepEqual(appMembership, { app_is_platform_writer: false });
  });

  it("enforces the complete routine EXECUTE privilege matrix", async () => {
    const routinePrivileges = await owner.$queryRawUnsafe(`
      WITH principal(name) AS (
        VALUES
          ('PUBLIC'::text),
          ('app_user'::text),
          ('execution_budget_platform_writer'::text)
      ), routine AS (
        SELECT oid, proname, proacl, proowner
        FROM pg_proc
        WHERE proname IN (
          'assert_execution_budget_platform_writer_principal',
          'consume_workspace_execution_authority',
          'ingest_platform_execution_authority',
          'inspect_platform_execution_authority_freshness_v1',
          'mark_execution_budget_authority_revoked',
          'open_authorized_tool_budget_v1',
          'revoke_platform_execution_authority_v1'
        )
      )
      SELECT routine.proname AS routine,
             principal.name AS principal,
             CASE
               WHEN principal.name='PUBLIC' THEN EXISTS (
                 SELECT 1
                 FROM aclexplode(
                   COALESCE(routine.proacl, acldefault('f', routine.proowner))
                 ) privilege
                 WHERE privilege.grantee=0
                   AND privilege.privilege_type='EXECUTE'
               )
               ELSE has_function_privilege(
                 principal.name,
                 routine.oid,
                 'EXECUTE'
               )
             END AS allowed
      FROM routine CROSS JOIN principal
      ORDER BY routine.proname, principal.name
    `);
    const expectedRoutinePrivileges = {
      assert_execution_budget_platform_writer_principal: {
        PUBLIC: false,
        app_user: false,
        execution_budget_platform_writer: false,
      },
      consume_workspace_execution_authority: {
        PUBLIC: false,
        app_user: true,
        execution_budget_platform_writer: false,
      },
      ingest_platform_execution_authority: {
        PUBLIC: false,
        app_user: false,
        execution_budget_platform_writer: true,
      },
      inspect_platform_execution_authority_freshness_v1: {
        PUBLIC: false,
        app_user: false,
        execution_budget_platform_writer: true,
      },
      mark_execution_budget_authority_revoked: {
        PUBLIC: false,
        app_user: false,
        execution_budget_platform_writer: false,
      },
      open_authorized_tool_budget_v1: {
        PUBLIC: false,
        app_user: true,
        execution_budget_platform_writer: true,
      },
      revoke_platform_execution_authority_v1: {
        PUBLIC: false,
        app_user: false,
        execution_budget_platform_writer: true,
      },
    };
    assert.equal(routinePrivileges.length, 21);
    for (const entry of routinePrivileges) {
      assert.equal(
        entry.allowed,
        expectedRoutinePrivileges[entry.routine][entry.principal],
        `${entry.principal} EXECUTE ${entry.routine}`,
      );
    }
  });

  it("enforces the complete table DML privilege matrix", async () => {
    const tablePrivileges = await owner.$queryRawUnsafe(`
      WITH principal(name) AS (
        VALUES
          ('PUBLIC'::text),
          ('app_user'::text),
          ('execution_budget_platform_writer'::text)
      ), target_table(name, oid, relacl, relowner) AS (
        SELECT relation.relname, relation.oid, relation.relacl, relation.relowner
        FROM pg_class relation
        WHERE relation.relname IN (
          'execution_budget_authority',
          'execution_budget_authority_revocation'
        )
      ), requested_privilege(name) AS (
        VALUES ('DELETE'::text), ('INSERT'::text), ('SELECT'::text), ('UPDATE'::text)
      )
      SELECT target_table.name AS table_name,
             principal.name AS principal,
             requested_privilege.name AS privilege,
             CASE
               WHEN principal.name='PUBLIC' THEN EXISTS (
                 SELECT 1
                 FROM aclexplode(
                   COALESCE(
                     target_table.relacl,
                     acldefault('r', target_table.relowner)
                   )
                 ) privilege
                 WHERE privilege.grantee=0
                   AND privilege.privilege_type=requested_privilege.name
               )
               ELSE has_table_privilege(
                 principal.name,
                 target_table.oid,
                 requested_privilege.name
               )
             END AS allowed
      FROM target_table CROSS JOIN principal CROSS JOIN requested_privilege
      ORDER BY target_table.name, principal.name, requested_privilege.name
    `);
    const expectedTablePrivileges = {
      execution_budget_authority: {
        PUBLIC: { DELETE: false, INSERT: false, SELECT: false, UPDATE: false },
        app_user: { DELETE: false, INSERT: false, SELECT: true, UPDATE: false },
        execution_budget_platform_writer: {
          DELETE: false,
          INSERT: false,
          SELECT: true,
          UPDATE: false,
        },
      },
      execution_budget_authority_revocation: {
        PUBLIC: { DELETE: false, INSERT: false, SELECT: false, UPDATE: false },
        app_user: { DELETE: false, INSERT: true, SELECT: true, UPDATE: false },
        execution_budget_platform_writer: {
          DELETE: false,
          INSERT: false,
          SELECT: true,
          UPDATE: false,
        },
      },
    };
    assert.equal(tablePrivileges.length, 24);
    for (const entry of tablePrivileges) {
      assert.equal(
        entry.allowed,
        expectedTablePrivileges[entry.table_name][entry.principal][
          entry.privilege
        ],
        `${entry.principal} ${entry.privilege} ${entry.table_name}`,
      );
    }
  });

  it("attests the exact platform LOGIN, direct membership and safe NOLOGIN group in the database", async () => {
    const issuer = `https://principal-attestation-${randomUUID()}.example.test`;
    const safe = await ingestPlatform(platform, {
      issuer,
      jti: randomUUID(),
      subjectId: "safe-principal-schedule",
      scheduleId: "safe-principal-schedule",
    });
    assert.equal(safe.length, 1);

    await rejectsSql(
      () =>
        ingestPlatform(owner, {
          issuer,
          jti: randomUUID(),
          subjectId: "owner-substitution-schedule",
          scheduleId: "owner-substitution-schedule",
        }),
      "EXECUTION_BUDGET_PLATFORM_WRITER_PRINCIPAL_INVALID",
    );

    await rejectsSql(
      () =>
        platform.$transaction(async (transaction) => {
          await transaction.$executeRawUnsafe(
            "SET LOCAL ROLE execution_budget_platform_writer",
          );
          return ingestPlatform(transaction, {
            issuer,
            jti: randomUUID(),
            subjectId: "current-user-substitution-schedule",
            scheduleId: "current-user-substitution-schedule",
          });
        }),
      "EXECUTION_BUDGET_PLATFORM_WRITER_PRINCIPAL_INVALID",
    );

    const extraRole = "execution_budget_platform_extra_test";
    await owner.$executeRawUnsafe(`
      CREATE ROLE ${extraRole}
        NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS
    `);
    await owner.$executeRawUnsafe(`GRANT ${extraRole} TO ${PLATFORM_LOGIN}`);
    try {
      await rejectsSql(
        () =>
          ingestPlatform(platform, {
            issuer,
            jti: randomUUID(),
            subjectId: "extra-membership-schedule",
            scheduleId: "extra-membership-schedule",
          }),
        "EXECUTION_BUDGET_PLATFORM_WRITER_PRINCIPAL_INVALID",
      );
    } finally {
      await owner.$executeRawUnsafe(`REVOKE ${extraRole} FROM ${PLATFORM_LOGIN}`);
      await owner.$executeRawUnsafe(`DROP ROLE ${extraRole}`);
    }

    await owner.$executeRawUnsafe(`ALTER ROLE ${PLATFORM_LOGIN} SUPERUSER`);
    try {
      await rejectsSql(
        () =>
          ingestPlatform(platform, {
            issuer,
            jti: randomUUID(),
            subjectId: "privileged-writer-schedule",
            scheduleId: "privileged-writer-schedule",
          }),
        "EXECUTION_BUDGET_PLATFORM_WRITER_PRINCIPAL_INVALID",
      );
    } finally {
      await owner.$executeRawUnsafe(`ALTER ROLE ${PLATFORM_LOGIN} NOSUPERUSER`);
    }

    const outerRole = "execution_budget_platform_outer_test";
    await owner.$executeRawUnsafe(`
      CREATE ROLE ${outerRole}
        NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS
    `);
    await owner.$executeRawUnsafe(
      `GRANT ${outerRole} TO execution_budget_platform_writer`,
    );
    try {
      await rejectsSql(
        () =>
          ingestPlatform(platform, {
            issuer,
            jti: randomUUID(),
            subjectId: "nested-group-schedule",
            scheduleId: "nested-group-schedule",
          }),
        "EXECUTION_BUDGET_PLATFORM_WRITER_PRINCIPAL_INVALID",
      );
    } finally {
      await owner.$executeRawUnsafe(
        `REVOKE ${outerRole} FROM execution_budget_platform_writer`,
      );
      await owner.$executeRawUnsafe(`DROP ROLE ${outerRole}`);
    }

    await owner.$executeRawUnsafe(
      "ALTER ROLE execution_budget_platform_writer CREATEDB",
    );
    try {
      await rejectsSql(
        () =>
          ingestPlatform(platform, {
            issuer,
            jti: randomUUID(),
            subjectId: "unsafe-group-schedule",
            scheduleId: "unsafe-group-schedule",
          }),
        "EXECUTION_BUDGET_PLATFORM_WRITER_PRINCIPAL_INVALID",
      );
    } finally {
      await owner.$executeRawUnsafe(
        "ALTER ROLE execution_budget_platform_writer NOCREATEDB",
      );
    }

    const [{ count }] = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS count
       FROM execution_budget_authority
       WHERE issuer=$1`,
      issuer,
    );
    assert.equal(count, 1);
  });

  it("rejects hostile NULL claims before either authority shape can be stored", async () => {
    const [{ count: beforeCount }] = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS count FROM execution_budget_authority`,
    );
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
    assert.equal(count, beforeCount);
  });

  it("keeps both table authority-shape checks two-valued for nullable columns", async () => {
    const [{ count: beforeCount }] = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS count FROM execution_budget_authority`,
    );
    for (const overrides of [
      { workspaceId: null },
      { requestSha256: null },
      { capMicrousd: null },
    ]) {
      await rejectsSql(() => insertWorkspaceAuthority(owner, overrides));
    }
    for (const overrides of [
      { scheduleId: null },
      { subjectType: "campaign" },
      { subjectId: "different-schedule" },
      { capPerRunMicrousd: null },
      { campaignCapMicrousd: null },
      { maxRuns: null },
    ]) {
      await rejectsSql(() => insertPlatformAuthority(owner, overrides));
    }

    const [{ count }] = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS count FROM execution_budget_authority`,
    );
    assert.equal(count, beforeCount);
  });

  it("requires platform subject_type=schedule and subject_id=schedule_id at the ingest boundary", async () => {
    const issuer = `https://subject-shape-${randomUUID()}.example.test`;
    await rejectsSql(
      () =>
        ingestPlatform(platform, {
          issuer,
          jti: randomUUID(),
          subjectType: "campaign",
          subjectId: "subject-shape-schedule",
          scheduleId: "subject-shape-schedule",
        }),
      "EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH",
    );
    await rejectsSql(
      () =>
        ingestPlatform(platform, {
          issuer,
          jti: randomUUID(),
          subjectId: "different-subject",
          scheduleId: "subject-shape-schedule",
        }),
      "EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH",
    );

    const [{ count }] = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS count
       FROM execution_budget_authority
       WHERE issuer=$1`,
      issuer,
    );
    assert.equal(count, 0);
  });

  it("requires a positive microusd authority pair with a zero legacy-cents sentinel", async () => {
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
         VALUES ($1, $2, 0, $3::uuid, NULL)`,
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
         VALUES ($1, $2, 0, $3::uuid, 0)`,
        WS_A,
        `non-positive-authorized-cap-${randomUUID()}`,
        authority.authority_id,
      ),
    );
    await rejectsSql(() =>
      owner.$executeRawUnsafe(
        `INSERT INTO tool_budget_account
          (scope_key, account_key, cap_cents, authority_id,
           authorized_cap_microusd)
         VALUES ($1, $2, 1, $3::uuid, 1)`,
        WS_A,
        `bound-account-with-spendable-cents-${randomUUID()}`,
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

  it("rejects absent expired Workspace and Platform identities without inserting rows", async () => {
    const expiredTimes = {
      issuedAt: new Date(TEST_STARTED_AT - 130_000),
      notBefore: new Date(TEST_STARTED_AT - 120_000),
      expiresAt: new Date(TEST_STARTED_AT - 10_000),
    };
    const workspaceClaims = {
      ...expiredTimes,
      issuer: `https://expired-workspace-${randomUUID()}.example.test`,
      jti: randomUUID(),
      tokenSha256: "9".repeat(64),
      subjectId: "absent-expired-company",
      requestSha256: "a".repeat(64),
      capMicrousd: 19n,
    };
    const platformClaims = {
      ...expiredTimes,
      issuer: `https://expired-platform-${randomUUID()}.example.test`,
      jti: randomUUID(),
      tokenSha256: "b".repeat(64),
      subjectId: "absent-expired-schedule",
      scheduleId: "absent-expired-schedule",
      capPerRunMicrousd: 23n,
      campaignCapMicrousd: 46n,
      maxRuns: 2n,
    };

    await rejectsSql(
      () =>
        withWorkspace(app, WS_A, (transaction) =>
          consumeWorkspace(transaction, workspaceClaims),
        ),
      "EXECUTION_BUDGET_GRANT_EXPIRED",
    );
    await rejectsSql(
      () => ingestPlatform(platform, platformClaims),
      "EXECUTION_BUDGET_GRANT_EXPIRED",
    );

    const [{ count }] = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS count
       FROM execution_budget_authority
       WHERE (issuer=$1 AND jti=$2::uuid)
          OR (issuer=$3 AND jti=$4::uuid)`,
      workspaceClaims.issuer,
      workspaceClaims.jti,
      platformClaims.issuer,
      platformClaims.jti,
    );
    assert.equal(count, 0);
  });

  it("ingests new current Workspace and Platform identities before replay", async () => {
    const workspaceClaims = {
      issuer: `https://current-workspace-${randomUUID()}.example.test`,
      jti: randomUUID(),
      tokenSha256: "c".repeat(64),
      subjectId: "current-company",
      requestSha256: "d".repeat(64),
      capMicrousd: 29n,
    };
    const platformClaims = {
      issuer: `https://current-platform-${randomUUID()}.example.test`,
      jti: randomUUID(),
      tokenSha256: "e".repeat(64),
      subjectId: "current-schedule",
      scheduleId: "current-schedule",
      capPerRunMicrousd: 31n,
      campaignCapMicrousd: 62n,
      maxRuns: 2n,
    };

    const workspaceResult = await withWorkspace(app, WS_A, (transaction) =>
      consumeWorkspace(transaction, workspaceClaims),
    );
    const platformResult = await ingestPlatform(platform, platformClaims);
    assert.equal(workspaceResult.length, 1);
    assert.equal(workspaceResult[0].replay, false);
    assert.equal(platformResult.length, 1);
    assert.equal(platformResult[0].replay, false);

    const [{ count }] = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS count
       FROM execution_budget_authority
       WHERE (issuer=$1 AND jti=$2::uuid)
          OR (issuer=$3 AND jti=$4::uuid)`,
      workspaceClaims.issuer,
      workspaceClaims.jti,
      platformClaims.issuer,
      platformClaims.jti,
    );
    assert.equal(count, 2);
  });

  it("uses the same exact 60-second iat, nbf and exp tolerance for workspace and platform ingestion", async () => {
    const cases = [
      {
        name: "not-before +60",
        offsets: { issuedAt: 0, notBefore: 60, expiresAt: 120 },
        accepted: true,
      },
      {
        name: "not-before +61",
        offsets: { issuedAt: 0, notBefore: 61, expiresAt: 120 },
        accepted: false,
        marker: "EXECUTION_BUDGET_GRANT_INVALID",
      },
      {
        name: "expiry -60",
        offsets: { issuedAt: -120, notBefore: -119, expiresAt: -60 },
        accepted: true,
      },
      {
        name: "expiry -61",
        offsets: { issuedAt: -120, notBefore: -119, expiresAt: -61 },
        accepted: false,
        marker: "EXECUTION_BUDGET_GRANT_EXPIRED",
      },
      {
        name: "issued-at +60",
        offsets: { issuedAt: 60, notBefore: 60, expiresAt: 120 },
        accepted: true,
      },
      {
        name: "issued-at +61",
        offsets: { issuedAt: 61, notBefore: 61, expiresAt: 120 },
        accepted: false,
        marker: "EXECUTION_BUDGET_GRANT_INVALID",
      },
    ];
    const issuer = `https://clock-ingest-${randomUUID()}.example.test`;
    let acceptedRows = 0;

    for (const entry of cases) {
      const workspaceCall = () =>
        withWorkspace(app, WS_A, (transaction) =>
          consumeWorkspaceAtOffsets(transaction, entry.offsets, {
            issuer,
            jti: randomUUID(),
            tokenSha256: randomUUID().replaceAll("-", "").padEnd(64, "0"),
          }),
        );
      const platformCall = () =>
        ingestPlatformAtOffsets(platform, entry.offsets, {
          issuer,
          jti: randomUUID(),
          tokenSha256: randomUUID().replaceAll("-", "").padEnd(64, "0"),
        });

      if (entry.accepted) {
        assert.equal((await workspaceCall()).length, 1, entry.name);
        assert.equal((await platformCall()).length, 1, entry.name);
        acceptedRows += 2;
      } else {
        await rejectsSql(workspaceCall, entry.marker).catch((error) => {
          error.message = `workspace ${entry.name}: ${error.message}`;
          throw error;
        });
        await rejectsSql(platformCall, entry.marker).catch((error) => {
          error.message = `platform ${entry.name}: ${error.message}`;
          throw error;
        });
      }
    }

    const [{ count }] = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS count
       FROM execution_budget_authority
       WHERE issuer=$1`,
      issuer,
    );
    assert.equal(count, acceptedRows);
  });

  it("deterministically replays committed expired identities and conflicts on mismatch", async () => {
    const expiredFixtureTimes = {
      issuedAt: new Date(TEST_STARTED_AT - 130_000),
      notBefore: new Date(TEST_STARTED_AT - 120_000),
      expiresAt: new Date(TEST_STARTED_AT - 10_000),
    };
    const workspaceClaims = {
      ...expiredFixtureTimes,
      issuer: `https://fixture-workspace-${randomUUID()}.example.test`,
      jti: randomUUID(),
      tokenSha256: "1".repeat(64),
      subjectId: "fixture-expired-company",
      requestSha256: "2".repeat(64),
      capMicrousd: 101n,
    };
    const platformClaims = {
      ...expiredFixtureTimes,
      issuer: `https://fixture-platform-${randomUUID()}.example.test`,
      jti: randomUUID(),
      tokenSha256: "3".repeat(64),
      subjectId: "fixture-expired-schedule",
      scheduleId: "fixture-expired-schedule",
      capPerRunMicrousd: 31n,
      campaignCapMicrousd: 93n,
      maxRuns: 3n,
    };

    const [workspaceAuthority] = await insertWorkspaceAuthority(
      owner,
      workspaceClaims,
    );
    const [platformAuthority] = await insertPlatformAuthority(
      owner,
      platformClaims,
    );

    const workspaceReplay = await withWorkspace(app, WS_A, (transaction) =>
      consumeWorkspace(transaction, workspaceClaims),
    );
    const platformReplay = await ingestPlatform(platform, platformClaims);
    assert.deepEqual(workspaceReplay, [
      { authority_id: workspaceAuthority.id, replay: true },
    ]);
    assert.deepEqual(platformReplay, [
      { authority_id: platformAuthority.id, replay: true },
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
          scheduleId: "changed-fixture-expired-schedule",
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

  it("provides one attested append-only platform revocation primitive without owner fallback", async () => {
    const [authority] = await ingestPlatform(platform, {
      jti: randomUUID(),
      subjectId: "platform-revocation-schedule",
      scheduleId: "platform-revocation-schedule",
    });
    const revokedAt = new Date();
    const revoke = (database) =>
      database.$queryRawUnsafe(
        `SELECT * FROM revoke_platform_execution_authority_v1(
          $1::uuid, $2, $3::timestamptz
        )`,
        authority.authority_id,
        "CONTROL_PLANE_REVOKED",
        revokedAt,
      );

    const first = await revoke(platform);
    const replay = await revoke(platform);
    assert.equal(first.length, 1);
    assert.equal(first[0].replay, false);
    assert.deepEqual(replay, [
      { revocation_id: first[0].revocation_id, replay: true },
    ]);

    await rejectsSql(
      () =>
        openAuthorized(platform, {
          scopeKey: "platform",
          authorityId: authority.authority_id,
          accountKey: "revoked-platform-account",
        }),
      "EXECUTION_BUDGET_AUTHORITY_REVOKED",
    );
    await rejectsSql(
      () => revoke(owner),
      "EXECUTION_BUDGET_PLATFORM_WRITER_PRINCIPAL_INVALID",
    );
    await rejectsSql(() => revoke(app));
    await rejectsSql(() =>
      platform.$executeRawUnsafe(
        `UPDATE execution_budget_authority_revocation
         SET reason='rewritten'
         WHERE authority_id=$1::uuid`,
        authority.authority_id,
      ),
    );
    await rejectsSql(() =>
      platform.$executeRawUnsafe(
        `DELETE FROM execution_budget_authority_revocation
         WHERE authority_id=$1::uuid`,
        authority.authority_id,
      ),
    );

    const [state] = await owner.$queryRawUnsafe(
      `SELECT authority.revoked_at, count(revocation.id)::int AS revocations
       FROM execution_budget_authority authority
       LEFT JOIN execution_budget_authority_revocation revocation
         ON revocation.authority_id=authority.id
       WHERE authority.id=$1::uuid
       GROUP BY authority.id`,
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

  it("applies exact 60-second clock tolerance again during authorized open", async () => {
    const cases = [
      {
        name: "not-before +60",
        offsets: { issuedAt: 0, notBefore: 60, expiresAt: 120 },
        accepted: true,
      },
      {
        name: "not-before +61",
        offsets: { issuedAt: 0, notBefore: 61, expiresAt: 120 },
        accepted: false,
        marker: "EXECUTION_BUDGET_GRANT_INVALID",
      },
      {
        name: "expiry -60",
        offsets: { issuedAt: -120, notBefore: -119, expiresAt: -60 },
        accepted: true,
      },
      {
        name: "expiry -61",
        offsets: { issuedAt: -120, notBefore: -119, expiresAt: -61 },
        accepted: false,
        marker: "EXECUTION_BUDGET_GRANT_EXPIRED",
      },
      {
        name: "issued-at +60",
        offsets: { issuedAt: 60, notBefore: 60, expiresAt: 120 },
        accepted: true,
      },
      {
        name: "issued-at +61",
        offsets: { issuedAt: 61, notBefore: 61, expiresAt: 120 },
        accepted: false,
        marker: "EXECUTION_BUDGET_GRANT_INVALID",
      },
    ];

    await owner.$executeRawUnsafe(
      "GRANT UPDATE ON execution_budget_authority TO app_user",
    );
    try {
      for (const entry of cases) {
        const [authority] = await withWorkspace(app, WS_A, (transaction) =>
          consumeWorkspace(transaction, {
            jti: randomUUID(),
            subjectId: `open-clock-${entry.name}`,
          }),
        );
        const accountKey = `open-clock-${randomUUID()}`;
        const call = () =>
          openWorkspaceAuthorizedAtOffsets(app, {
            authorityId: authority.authority_id,
            accountKey,
            ...entry.offsets,
          });

        if (entry.accepted) {
          const opened = await call();
          assert.equal(opened.length, 1, entry.name);
        } else {
          await rejectsSql(call, entry.marker).catch((error) => {
            error.message = `${entry.name}: ${error.message}`;
            throw error;
          });
          const [{ count }] = await owner.$queryRawUnsafe(
            `SELECT count(*)::int AS count
             FROM tool_budget_account
             WHERE account_key=$1`,
            accountKey,
          );
          assert.equal(count, 0, entry.name);
        }
      }
    } finally {
      await owner.$executeRawUnsafe(
        "REVOKE UPDATE ON execution_budget_authority FROM app_user",
      );
    }
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
        cap_cents: 0n,
        reserved_cents: 0n,
        charged_cents: 0n,
      },
      {
        account_key: "platform-run-2",
        authority_id: authority.authority_id,
        authorized_cap_microusd: 40n,
        cap_cents: 0n,
        reserved_cents: 0n,
        charged_cents: 0n,
      },
    ]);
  });

  it("fences every legacy cents lifecycle path for authority-bound app and owner accounts", async () => {
    const [workspaceAuthority] = await withWorkspace(
      app,
      WS_A,
      (transaction) =>
        consumeWorkspace(transaction, {
          jti: randomUUID(),
          subjectId: "legacy-fence-workspace-company",
          capMicrousd: 500_000n,
        }),
    );
    const workspaceAccountKey = `legacy-fence-workspace-${randomUUID()}`;
    const [workspaceAccount] = await withWorkspace(
      app,
      WS_A,
      (transaction) =>
        openAuthorized(transaction, {
          scopeKey: WS_A,
          authorityId: workspaceAuthority.authority_id,
          accountKey: workspaceAccountKey,
        }),
    );

    const appCalls = [
      () =>
        withWorkspace(app, WS_A, (transaction) =>
          transaction.$queryRawUnsafe(
            `SELECT * FROM open_tool_budget($1, $2, 999, false)`,
            WS_A,
            workspaceAccountKey,
          ),
        ),
      () =>
        withWorkspace(app, WS_A, (transaction) =>
          transaction.$queryRawUnsafe(
            `SELECT * FROM reserve_tool_budget($1, $2, $3, 1)`,
            WS_A,
            workspaceAccountKey,
            `legacy-fence-reserve-${randomUUID()}`,
          ),
        ),
      () =>
        withWorkspace(app, WS_A, (transaction) =>
          transaction.$queryRawUnsafe(
            `SELECT * FROM tool_budget_status($1, $2)`,
            WS_A,
            workspaceAccountKey,
          ),
        ),
      () =>
        withWorkspace(app, WS_A, (transaction) =>
          transaction.$executeRawUnsafe(
            `SELECT close_tool_budget($1, $2, true)`,
            WS_A,
            workspaceAccountKey,
          ),
        ),
    ];
    for (const call of appCalls) {
      await rejectsSql(
        call,
        "EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE",
      );
    }

    const [workspaceOperation] = await owner.$queryRawUnsafe(
      `INSERT INTO tool_budget_operation(
         scope_key, account_id, generation, operation_key, reserved_cents
       ) VALUES ($1, $2::uuid, $3, $4, 0)
       RETURNING id`,
      WS_A,
      workspaceAccount.account_id,
      workspaceAccount.generation,
      `legacy-fence-seeded-${randomUUID()}`,
    );
    for (const call of [
      () =>
        withWorkspace(app, WS_A, (transaction) =>
          transaction.$queryRawUnsafe(
            `SELECT * FROM settle_tool_budget(
              $1, $2::uuid, 0, NULL, NULL, NULL, NULL
            )`,
            WS_A,
            workspaceOperation.id,
          ),
        ),
      () =>
        withWorkspace(app, WS_A, (transaction) =>
          transaction.$queryRawUnsafe(
            `SELECT * FROM release_tool_budget($1, $2::uuid)`,
            WS_A,
            workspaceOperation.id,
          ),
        ),
    ]) {
      await rejectsSql(
        call,
        "EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE",
      );
    }

    const [platformAuthority] = await ingestPlatform(platform, {
      jti: randomUUID(),
      subjectId: "legacy-fence-platform-schedule",
      scheduleId: "legacy-fence-platform-schedule",
      capPerRunMicrousd: 60n,
      campaignCapMicrousd: 60n,
      maxRuns: 1n,
    });
    const platformAccountKey = `legacy-fence-platform-${randomUUID()}`;
    const [platformAccount] = await openAuthorized(platform, {
      scopeKey: "platform",
      authorityId: platformAuthority.authority_id,
      accountKey: platformAccountKey,
    });
    for (const call of [
      () =>
        owner.$queryRawUnsafe(
          `SELECT * FROM reserve_tool_budget('platform', $1, $2, 1)`,
          platformAccountKey,
          `owner-reserve-${randomUUID()}`,
        ),
      () =>
        owner.$queryRawUnsafe(
          `SELECT * FROM tool_budget_status('platform', $1)`,
          platformAccountKey,
        ),
      () =>
        owner.$executeRawUnsafe(
          `SELECT close_tool_budget('platform', $1, true)`,
          platformAccountKey,
        ),
    ]) {
      await rejectsSql(
        call,
        "EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE",
      );
    }
    const [platformOperation] = await owner.$queryRawUnsafe(
      `INSERT INTO tool_budget_operation(
         scope_key, account_id, generation, operation_key, reserved_cents
       ) VALUES ('platform', $1::uuid, $2, $3, 0)
       RETURNING id`,
      platformAccount.account_id,
      platformAccount.generation,
      `owner-seeded-${randomUUID()}`,
    );
    for (const call of [
      () =>
        owner.$queryRawUnsafe(
          `SELECT * FROM settle_tool_budget(
            'platform', $1::uuid, 0, NULL, NULL, NULL, NULL
          )`,
          platformOperation.id,
        ),
      () =>
        owner.$queryRawUnsafe(
          `SELECT * FROM release_tool_budget('platform', $1::uuid)`,
          platformOperation.id,
        ),
    ]) {
      await rejectsSql(
        call,
        "EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE",
      );
    }

    const [{ injectedOperations }] = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS "injectedOperations"
       FROM tool_budget_operation
       WHERE account_id IN ($1::uuid, $2::uuid)
         AND operation_key LIKE '%reserve%'`,
      workspaceAccount.account_id,
      platformAccount.account_id,
    );
    assert.equal(injectedOperations, 0);
    const boundAccounts = await owner.$queryRawUnsafe(
      `SELECT cap_cents, reserved_cents, charged_cents, ref_count
       FROM tool_budget_account
       WHERE id IN ($1::uuid, $2::uuid)
       ORDER BY id`,
      workspaceAccount.account_id,
      platformAccount.account_id,
    );
    for (const account of boundAccounts) {
      assert.equal(account.cap_cents, 0n);
      assert.equal(account.reserved_cents, 0n);
      assert.equal(account.charged_cents, 0n);
      assert.equal(account.ref_count, 1);
    }
  });

  it("preserves the complete legacy unbound cents lifecycle", async () => {
    const accountKey = `legacy-unbound-${randomUUID()}`;
    const operationKey = `legacy-unbound-operation-${randomUUID()}`;
    await withWorkspace(app, WS_A, async (transaction) => {
      const opened = await transaction.$queryRawUnsafe(
        `SELECT * FROM open_tool_budget($1, $2, 10, false)`,
        WS_A,
        accountKey,
      );
      assert.equal(opened.length, 1);
      const [reserved] = await transaction.$queryRawUnsafe(
        `SELECT * FROM reserve_tool_budget($1, $2, $3, 3)`,
        WS_A,
        accountKey,
        operationKey,
      );
      assert.equal(reserved.kind, "EXECUTE");
      assert.equal(reserved.reserved_cents, 3n);
      const [released] = await transaction.$queryRawUnsafe(
        `SELECT * FROM release_tool_budget($1, $2::uuid)`,
        WS_A,
        reserved.operation_id,
      );
      assert.equal(released.status, "RELEASED");
      const [status] = await transaction.$queryRawUnsafe(
        `SELECT * FROM tool_budget_status($1, $2)`,
        WS_A,
        accountKey,
      );
      assert.equal(status.remaining_cents, 10n);
      await transaction.$executeRawUnsafe(
        `SELECT close_tool_budget($1, $2, false)`,
        WS_A,
        accountKey,
      );
    });

    const [account] = await owner.$queryRawUnsafe(
      `SELECT authority_id, authorized_cap_microusd, cap_cents,
              reserved_cents, charged_cents, ref_count
       FROM tool_budget_account
       WHERE scope_key=$1 AND account_key=$2`,
      WS_A,
      accountKey,
    );
    assert.deepEqual(account, {
      authority_id: null,
      authorized_cap_microusd: null,
      cap_cents: 10n,
      reserved_cents: 0n,
      charged_cents: 0n,
      ref_count: 0,
    });
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

    await rejectsSql(
      () =>
        owner.$executeRawUnsafe(
          `SELECT close_tool_budget(
            'platform',
            'platform-generation-account',
            true
          )`,
        ),
      "EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE",
    );
    await owner.$executeRawUnsafe(
      `UPDATE tool_budget_account
          SET ref_count=0,
              closed_at=clock_timestamp(),
              updated_at=clock_timestamp()
        WHERE id=$1::uuid`,
      first.account_id,
    );

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
      cap_cents: 0n,
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

  it("classifies campaign exhaustion and exact clock boundaries through the real freshness primitive", async () => {
    await owner.$executeRawUnsafe(
      `UPDATE execution_budget_authority
          SET revoked_at=GREATEST(statement_timestamp(), issued_at)
        WHERE authority_kind='PLATFORM_GRANT'`,
    );
    const verificationTime = new Date(
      Math.floor(Date.now() / 1_000) * 1_000,
    );
    const currentTimes = {
      issuedAt: new Date(verificationTime.getTime() - 1_000),
      notBefore: new Date(verificationTime.getTime() - 1_000),
      expiresAt: new Date(verificationTime.getTime() + 120_000),
    };
    const [acquisition] = await ingestPlatform(platform, {
      ...currentTimes,
      jti: randomUUID(),
      purpose: "platform.acquisition",
      subjectId: "freshness-acquisition",
      scheduleId: "freshness-acquisition",
      capPerRunMicrousd: 60n,
      campaignCapMicrousd: 100n,
      maxRuns: 3n,
    });
    await openAuthorized(platform, {
      scopeKey: "platform",
      authorityId: acquisition.authority_id,
      accountKey: `freshness-acquisition-1-${randomUUID()}`,
    });
    await openAuthorized(platform, {
      scopeKey: "platform",
      authorityId: acquisition.authority_id,
      accountKey: `freshness-acquisition-2-${randomUUID()}`,
    });
    const [intent] = await ingestPlatform(platform, {
      ...currentTimes,
      jti: randomUUID(),
      purpose: "platform.intent_watch",
      subjectId: "freshness-intent",
      scheduleId: "freshness-intent",
    });
    const [sanctions] = await ingestPlatform(platform, {
      ...currentTimes,
      jti: randomUUID(),
      purpose: "platform.sanctions",
      subjectId: "freshness-sanctions",
      scheduleId: "freshness-sanctions",
    });

    await owner.$executeRawUnsafe(
      `UPDATE execution_budget_authority
          SET issued_at=$2::timestamptz,
              not_before=$2::timestamptz + interval '60 seconds',
              expires_at=$2::timestamptz + interval '120 seconds'
        WHERE id=$1::uuid`,
      intent.authority_id,
      verificationTime,
    );
    await owner.$executeRawUnsafe(
      `UPDATE execution_budget_authority
          SET issued_at=$2::timestamptz - interval '120 seconds',
              not_before=$2::timestamptz - interval '119 seconds',
              expires_at=$2::timestamptz - interval '60 seconds'
        WHERE id=$1::uuid`,
      sanctions.authority_id,
      verificationTime,
    );

    const boundary = await platform.$queryRawUnsafe(
      `SELECT * FROM inspect_platform_execution_authority_freshness_v1(
        $1::timestamptz
      )`,
      verificationTime,
    );
    assert.deepEqual(boundary, [
      { purpose: "platform.acquisition", state: "exhausted" },
      { purpose: "platform.intent_watch", state: "active" },
      { purpose: "platform.sanctions", state: "active" },
    ]);

    await owner.$executeRawUnsafe(
      `UPDATE execution_budget_authority
          SET not_before=$2::timestamptz + interval '61 seconds'
        WHERE id=$1::uuid`,
      intent.authority_id,
      verificationTime,
    );
    await owner.$executeRawUnsafe(
      `UPDATE execution_budget_authority
          SET expires_at=$2::timestamptz - interval '61 seconds'
        WHERE id=$1::uuid`,
      sanctions.authority_id,
      verificationTime,
    );
    const outsideBoundary = await platform.$queryRawUnsafe(
      `SELECT * FROM inspect_platform_execution_authority_freshness_v1(
        $1::timestamptz
      )`,
      verificationTime,
    );
    assert.deepEqual(outsideBoundary, [
      { purpose: "platform.acquisition", state: "exhausted" },
      { purpose: "platform.intent_watch", state: "not_yet_valid" },
      { purpose: "platform.sanctions", state: "expired" },
    ]);
  });
});
