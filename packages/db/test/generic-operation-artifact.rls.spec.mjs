import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const migrationPath = resolve(
  repositoryRoot,
  "packages/db/prisma/migrations/20260821100000_generic_operation_artifact/migration.sql",
);
const sharedContentMigrationPath = resolve(
  repositoryRoot,
  "packages/db/prisma/migrations/20260821110000_generic_operation_artifact_shared_content/migration.sql",
);

const OWNER_URL = process.env.DATABASE_URL;
const APP_URL = process.env.APP_DATABASE_URL;
const PLATFORM_LOGIN = "generic_operation_artifact_platform_test";
const PLATFORM_PASSWORD = "generic-operation-artifact-platform-test-only";
const WS_A = "00000000-0000-4000-8000-0000000000a1";
const WS_B = "00000000-0000-4000-8000-0000000000b2";
const SHA_A = "ab".padEnd(64, "0");
const SHA_B = "cd".padEnd(64, "0");
const SOURCE_A = "ef".padEnd(64, "0");
const CREATED_AT = new Date("2026-08-21T01:02:03.004Z");
const EXPIRES_AT = new Date("2026-08-22T01:02:03.004Z");

function requireDatabaseUrl(name, value) {
  assert.ok(value, `${name} is required`);
  const parsed = new URL(value);
  assert.ok(["postgres:", "postgresql:"].includes(parsed.protocol));
  return parsed;
}

function client(url) {
  return new PrismaClient({ datasources: { db: { url } } });
}

function platformUrl() {
  const parsed = requireDatabaseUrl("DATABASE_URL", OWNER_URL);
  parsed.username = PLATFORM_LOGIN;
  parsed.password = PLATFORM_PASSWORD;
  return parsed.href;
}

function objectKey(sha256) {
  return `generic-operation-results/v1/sha256/${sha256.slice(0, 2)}/${sha256}`;
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
    assert.match(String(error?.message), new RegExp(marker));
    return true;
  });
}

async function appendWorkspace(transaction, input) {
  return transaction.$queryRawUnsafe(
    `SELECT * FROM append_workspace_generic_operation_artifact_v1(
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
      $8::bigint, $9, $10, $11, $12::timestamptz, $13::timestamptz
    )`,
    input.workspaceId,
    input.artifactId,
    input.authorityId,
    input.operationId,
    input.resultSchema,
    input.objectKey,
    input.sha256,
    input.sizeBytes,
    input.mediaType,
    input.privacyClass,
    input.sourceDigest,
    input.createdAt,
    input.expiresAt,
  );
}

async function appendPlatform(database, input) {
  return database.$queryRawUnsafe(
    `SELECT * FROM append_platform_generic_operation_artifact_v1(
      $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::bigint,
      $8, $9, $10, $11::timestamptz, $12::timestamptz
    )`,
    input.artifactId,
    input.authorityId,
    input.operationId,
    input.resultSchema,
    input.objectKey,
    input.sha256,
    input.sizeBytes,
    input.mediaType,
    input.privacyClass,
    input.sourceDigest,
    input.createdAt,
    input.expiresAt,
  );
}

function artifactInput(binding, overrides = {}) {
  const sha256 = overrides.sha256 ?? SHA_A;
  return {
    workspaceId: binding.workspaceId,
    artifactId: randomUUID(),
    authorityId: binding.authorityId,
    operationId: binding.operationId,
    resultSchema: "http-get/v1",
    objectKey: objectKey(sha256),
    sha256,
    sizeBytes: 1_048_576n,
    mediaType: "text/html",
    privacyClass: "CONFIDENTIAL_TENANT",
    sourceDigest: SOURCE_A,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

async function seedWorkspaceBinding(owner, workspaceId) {
  const authorityId = randomUUID();
  const accountId = randomUUID();
  const operationId = randomUUID();
  await owner.$executeRawUnsafe(
    `INSERT INTO execution_budget_authority (
      id, scope_key, authority_kind, workspace_id, issuer, audience, jti,
      token_sha256, schema_version, purpose, subject_type, subject_id,
      request_sha256, currency, unit, cap_microusd, runs_consumed,
      issued_at, not_before, expires_at, consumed_at
    ) VALUES (
      $1::uuid, $2, 'WORKSPACE_GRANT', $2::uuid, $3,
      'global-backend:execution-budget', $4::uuid, $5,
      'execution-budget-grant/v1', 'icp.design', 'company', $6, $7,
      'USD', 'microusd', 5000000, 1,
      statement_timestamp() - interval '10 seconds',
      statement_timestamp() - interval '5 seconds',
      statement_timestamp() + interval '230 seconds', statement_timestamp()
    )`,
    authorityId,
    workspaceId,
    `https://artifact-${randomUUID()}.example.test`,
    randomUUID(),
    randomUUID().replaceAll("-", "").padEnd(64, "0"),
    `company-${randomUUID()}`,
    randomUUID().replaceAll("-", "").padEnd(64, "0"),
  );
  await owner.$executeRawUnsafe(
    `INSERT INTO tool_budget_account (
      id, scope_key, account_key, generation, cap_cents, reserved_cents,
      charged_cents, exhausted, ref_count, authority_id,
      authorized_cap_microusd, created_at, updated_at
    ) VALUES (
      $1::uuid, $2, $3, 1, 0, 0, 0, false, 1, $4::uuid,
      5000000, statement_timestamp(), statement_timestamp()
    )`,
    accountId,
    workspaceId,
    `artifact-account-${randomUUID()}`,
    authorityId,
  );
  await owner.$executeRawUnsafe(
    `INSERT INTO tool_budget_operation (
      id, scope_key, account_id, generation, operation_key,
      reserved_cents, status, created_at
    ) VALUES ($1::uuid, $2, $3::uuid, 1, $4, 0, 'RESERVED', now())`,
    operationId,
    workspaceId,
    accountId,
    `artifact-operation-${randomUUID()}`,
  );
  return { workspaceId, authorityId, accountId, operationId };
}

async function seedPlatformBinding(owner) {
  const authorityId = randomUUID();
  const accountId = randomUUID();
  const operationId = randomUUID();
  const scheduleId = `artifact-schedule-${randomUUID()}`;
  await owner.$executeRawUnsafe(
    `INSERT INTO execution_budget_authority (
      id, scope_key, authority_kind, issuer, audience, jti, token_sha256,
      schema_version, purpose, subject_type, subject_id, schedule_id,
      currency, unit, cap_per_run_microusd, campaign_cap_microusd,
      max_runs, runs_consumed, issued_at, not_before, expires_at, consumed_at
    ) VALUES (
      $1::uuid, 'platform', 'PLATFORM_GRANT', $2,
      'global-backend:execution-budget', $3::uuid, $4,
      'execution-budget-grant/v1', 'platform.sanctions', 'schedule', $5, $5,
      'USD', 'microusd', 1000000, 5000000, 5, 1,
      statement_timestamp() - interval '10 seconds',
      statement_timestamp() - interval '5 seconds',
      statement_timestamp() + interval '230 seconds', statement_timestamp()
    )`,
    authorityId,
    `https://artifact-${randomUUID()}.example.test`,
    randomUUID(),
    randomUUID().replaceAll("-", "").padEnd(64, "0"),
    scheduleId,
  );
  await owner.$executeRawUnsafe(
    `INSERT INTO tool_budget_account (
      id, scope_key, account_key, generation, cap_cents, reserved_cents,
      charged_cents, exhausted, ref_count, authority_id,
      authorized_cap_microusd, created_at, updated_at
    ) VALUES (
      $1::uuid, 'platform', $2, 1, 0, 0, 0, false, 1, $3::uuid,
      1000000, statement_timestamp(), statement_timestamp()
    )`,
    accountId,
    `artifact-account-${randomUUID()}`,
    authorityId,
  );
  await owner.$executeRawUnsafe(
    `INSERT INTO tool_budget_operation (
      id, scope_key, account_id, generation, operation_key,
      reserved_cents, status, created_at
    ) VALUES ($1::uuid, 'platform', $2::uuid, 1, $3, 0, 'RESERVED', now())`,
    operationId,
    accountId,
    `artifact-operation-${randomUUID()}`,
  );
  return {
    workspaceId: null,
    authorityId,
    accountId,
    operationId,
  };
}

describe("generic operation artifact PostgreSQL and FORCE RLS", () => {
  let owner;
  let app;
  let platform;
  let workspaceA;
  let workspaceB;
  let platformBinding;

  before(async () => {
    requireDatabaseUrl("DATABASE_URL", OWNER_URL);
    requireDatabaseUrl("APP_DATABASE_URL", APP_URL);
    owner = client(OWNER_URL);

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
      `fresh migrations must deploy\n${deployment.stdout}\n${deployment.stderr}`,
    );
    await owner.$executeRawUnsafe("TRUNCATE TABLE generic_operation_artifact");

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
        ('${WS_A}'::uuid, 'Artifact WS A', now(), now()),
        ('${WS_B}'::uuid, 'Artifact WS B', now(), now())
       ON CONFLICT (id) DO NOTHING`,
    );

    workspaceA = await seedWorkspaceBinding(owner, WS_A);
    workspaceB = await seedWorkspaceBinding(owner, WS_B);
    platformBinding = await seedPlatformBinding(owner);
    app = client(APP_URL);
    platform = client(platformUrl());
  });

  after(async () => {
    await Promise.allSettled([app?.$disconnect(), platform?.$disconnect()]);
    if (owner) {
      await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${PLATFORM_LOGIN}`);
      await owner.$disconnect();
    }
  });

  it("deploys the immutable manifest relation, object metadata relation and all six narrow functions", async () => {
    const relations = await owner.$queryRawUnsafe(`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE relname IN (
        'generic_operation_artifact', 'generic_operation_artifact_object'
      ) ORDER BY relname
    `);
    assert.deepEqual(relations, [
      {
        relname: "generic_operation_artifact",
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      {
        relname: "generic_operation_artifact_object",
        relrowsecurity: false,
        relforcerowsecurity: false,
      },
    ]);

    const functions = await owner.$queryRawUnsafe(`
      SELECT proname, prosecdef, proconfig
      FROM pg_proc
      WHERE proname IN (
        'append_workspace_generic_operation_artifact_v1',
        'append_platform_generic_operation_artifact_v1',
        'find_exact_workspace_generic_operation_artifact_v1',
        'find_exact_platform_generic_operation_artifact_v1',
        'find_workspace_generic_operation_artifact_by_operation_v1',
        'find_platform_generic_operation_artifact_by_operation_v1'
      ) ORDER BY proname
    `);
    assert.equal(functions.length, 6);
    for (const routine of functions) {
      assert.equal(routine.prosecdef, true);
      assert.deepEqual(routine.proconfig, ["search_path=pg_catalog, public"]);
    }
  });

  it("appends and reads a workspace manifest with byte-identical idempotency", async () => {
    const input = artifactInput(workspaceA);
    const first = await withWorkspace(app, WS_A, (transaction) =>
      appendWorkspace(transaction, input),
    );
    await owner.$executeRawUnsafe(
      `UPDATE tool_budget_operation
       SET status='SETTLED', observed_cents=0, charged_cents=0,
           settled_at=statement_timestamp()
       WHERE scope_key=$1 AND id=$2::uuid`,
      WS_A,
      input.operationId,
    );
    const replay = await withWorkspace(app, WS_A, (transaction) =>
      appendWorkspace(transaction, input),
    );
    assert.equal(first.length, 1);
    assert.equal(first[0].replay, false);
    assert.equal(replay.length, 1);
    assert.equal(replay[0].replay, true);
    assert.equal(first[0].object_key, objectKey(SHA_A));

    const exact = await withWorkspace(app, WS_A, (transaction) =>
      transaction.$queryRawUnsafe(
        `SELECT * FROM find_exact_workspace_generic_operation_artifact_v1(
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6,
          $7::bigint, $8, $9::timestamptz
        )`,
        WS_A,
        input.artifactId,
        input.authorityId,
        input.operationId,
        input.resultSchema,
        input.sha256,
        input.sizeBytes,
        input.mediaType,
        input.expiresAt,
      ),
    );
    assert.equal(exact.length, 1);
    assert.equal(exact[0].artifact_id, input.artifactId);
  });

  it("retains RESULT_UNKNOWN reservation, blocks a new generation, then recovers and settles the exact reference", async () => {
    const binding = await seedWorkspaceBinding(owner, WS_A);
    const digest = randomUUID().replaceAll("-", "").repeat(2);
    const input = artifactInput(binding, {
      sha256: digest,
      objectKey: objectKey(digest),
      sourceDigest: null,
    });
    const [unknown] = await withWorkspace(app, WS_A, (transaction) =>
      transaction.$queryRawUnsafe(
        `SELECT * FROM mark_tool_budget_result_unknown_v1($1, $2::uuid)`,
        WS_A,
        binding.operationId,
      ),
    );
    assert.deepEqual(unknown, {
      reserved_cents: 0n,
      status: "RESULT_UNKNOWN",
      replay: false,
    });
    const [unknownState] = await owner.$queryRawUnsafe(
      `SELECT operation.status::text AS status,
              operation.reserved_cents AS operation_reserved,
              account.reserved_cents AS account_reserved,
              account.charged_cents AS account_charged,
              account.authorized_cap_microusd AS authorized_cap
       FROM tool_budget_operation operation
       JOIN tool_budget_account account ON account.id=operation.account_id
       WHERE operation.scope_key=$1 AND operation.id=$2::uuid`,
      WS_A,
      binding.operationId,
    );
    assert.deepEqual(unknownState, {
      status: "RESULT_UNKNOWN",
      operation_reserved: 0n,
      account_reserved: 0n,
      account_charged: 0n,
      authorized_cap: 5_000_000n,
    });
    await rejectsSql(
      () => owner.$executeRawUnsafe(
        `UPDATE tool_budget_account SET generation=generation+1
         WHERE scope_key=$1 AND id=$2::uuid`,
        WS_A,
        binding.accountId,
      ),
      "TOOL_BUDGET_UNSETTLED_OPERATIONS",
    );

    const [appended] = await withWorkspace(app, WS_A, (transaction) =>
      appendWorkspace(transaction, input),
    );
    assert.equal(appended.operation_id, binding.operationId);
    const reference = {
      schemaVersion: "generic-operation-artifact-ref/v1",
      artifactId: input.artifactId,
      operationId: input.operationId,
      resultSchema: input.resultSchema,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes.toString(),
      mediaType: input.mediaType,
      expiresAt: input.expiresAt.toISOString(),
    };
    const [settled] = await withWorkspace(app, WS_A, (transaction) =>
      transaction.$queryRawUnsafe(
        `SELECT * FROM settle_tool_budget_artifact_reference_v1(
          $1, $2::uuid, $3::bigint, $4::jsonb
        )`,
        WS_A,
        binding.operationId,
        13n,
        JSON.stringify(reference),
      ),
    );
    assert.deepEqual(settled, {
      charged_cents: 0n,
      observed_cents: 13n,
      cap_variance: true,
      status: "SETTLED",
      replay: false,
    });
    const [settledState] = await owner.$queryRawUnsafe(
      `SELECT operation.status::text AS status,
              operation.result_json AS result,
              account.reserved_cents AS account_reserved,
              account.charged_cents AS account_charged
       FROM tool_budget_operation operation
       JOIN tool_budget_account account ON account.id=operation.account_id
       WHERE operation.scope_key=$1 AND operation.id=$2::uuid`,
      WS_A,
      binding.operationId,
    );
    assert.equal(settledState.status, "SETTLED");
    assert.deepEqual(settledState.result, reference);
    assert.equal(settledState.account_reserved, 0n);
    assert.equal(settledState.account_charged, 0n);
  });

  it("makes conflicting size, media, source digest, digest, id and expiry non-idempotent", async () => {
    const input = artifactInput(workspaceB, { sha256: SHA_B });
    await withWorkspace(app, WS_B, (transaction) =>
      appendWorkspace(transaction, input),
    );
    for (const conflict of [
      { sizeBytes: input.sizeBytes + 1n },
      { mediaType: "application/json" },
      { privacyClass: "PERSONAL_DATA" },
      { sourceDigest: null },
      { sha256: SHA_A, objectKey: objectKey(SHA_A) },
      { objectKey: objectKey("ff".padEnd(64, "0")) },
      { artifactId: randomUUID() },
      { resultSchema: "crawl4ai-fetch/v1" },
      { expiresAt: new Date("2026-08-23T01:02:03.004Z") },
    ]) {
      await rejectsSql(
        () =>
          withWorkspace(app, WS_B, (transaction) =>
            appendWorkspace(transaction, { ...input, ...conflict }),
          ),
        "GENERIC_OPERATION_ARTIFACT_INVALID",
      );
    }
  });

  it("serializes concurrent identical appends into one row and one replay", async () => {
    const binding = await seedWorkspaceBinding(owner, WS_A);
    const digest = randomUUID().replaceAll("-", "").repeat(2);
    const input = artifactInput(binding, {
      sha256: digest,
      objectKey: objectKey(digest),
      sourceDigest: null,
    });
    const concurrentApp = client(APP_URL);
    try {
      const results = await Promise.all([
        withWorkspace(app, WS_A, (transaction) =>
          appendWorkspace(transaction, input),
        ),
        withWorkspace(concurrentApp, WS_A, (transaction) =>
          appendWorkspace(transaction, input),
        ),
      ]);
      assert.deepEqual(results.map(([result]) => result.replay).sort(), [
        false,
        true,
      ]);
      const [{ count }] = await owner.$queryRawUnsafe(
        `SELECT count(*)::int AS count FROM generic_operation_artifact
         WHERE scope_key=$1 AND operation_id=$2::uuid`,
        WS_A,
        input.operationId,
      );
      assert.equal(count, 1);
    } finally {
      await concurrentApp.$disconnect();
    }
  });

  it("lets distinct operation and authority bindings share one immutable content object", async () => {
    const firstBinding = await seedWorkspaceBinding(owner, WS_A);
    const secondBinding = await seedWorkspaceBinding(owner, WS_A);
    const digest = randomUUID().replaceAll("-", "").repeat(2);
    const firstInput = artifactInput(firstBinding, {
      sha256: digest,
      objectKey: objectKey(digest),
    });
    const secondInput = artifactInput(secondBinding, {
      sha256: digest,
      objectKey: objectKey(digest),
    });
    const concurrentApp = client(APP_URL);
    let results;
    try {
      results = await Promise.all([
        withWorkspace(app, WS_A, (transaction) =>
          appendWorkspace(transaction, firstInput),
        ),
        withWorkspace(concurrentApp, WS_A, (transaction) =>
          appendWorkspace(transaction, secondInput),
        ),
      ]);
    } finally {
      await concurrentApp.$disconnect();
    }
    assert.deepEqual(
      results.map(([row]) => row.object_key),
      [objectKey(digest), objectKey(digest)],
    );

    const readByOperation = (workspaceId, binding) =>
      withWorkspace(app, workspaceId, (transaction) =>
        transaction.$queryRawUnsafe(
          `SELECT * FROM find_workspace_generic_operation_artifact_by_operation_v1(
            $1::uuid, $2::uuid, $3::uuid, $4
          )`,
          workspaceId,
          binding.authorityId,
          binding.operationId,
          "http-get/v1",
        ),
      );
    const [firstRead, secondRead] = await Promise.all([
      readByOperation(WS_A, firstBinding),
      readByOperation(WS_A, secondBinding),
    ]);
    assert.deepEqual(
      firstRead.map(({ artifact_id }) => artifact_id),
      [firstInput.artifactId],
    );
    assert.deepEqual(
      secondRead.map(({ artifact_id }) => artifact_id),
      [secondInput.artifactId],
    );
    assert.deepEqual(await readByOperation(WS_B, firstBinding), []);

    const [counts] = await owner.$queryRawUnsafe(
      `SELECT
         (SELECT count(*)::int FROM generic_operation_artifact
          WHERE sha256=$1) AS manifests,
         (SELECT count(*)::int FROM generic_operation_artifact_object
          WHERE sha256=$1) AS objects`,
      digest,
    );
    assert.deepEqual(counts, { manifests: 2, objects: 1 });
  });

  it("keeps another workspace absent and indistinguishable", async () => {
    const result = await withWorkspace(app, WS_B, (transaction) =>
      transaction.$queryRawUnsafe(
        `SELECT * FROM find_workspace_generic_operation_artifact_by_operation_v1(
          $1::uuid, $2::uuid, $3::uuid, $4
        )`,
        WS_B,
        workspaceA.authorityId,
        workspaceA.operationId,
        "http-get/v1",
      ),
    );
    assert.deepEqual(result, []);
  });

  it("binds scope, authority and operation before any manifest insert", async () => {
    const wrongAuthority = artifactInput(workspaceA, {
      artifactId: randomUUID(),
      authorityId: workspaceB.authorityId,
    });
    const wrongOperation = artifactInput(workspaceA, {
      artifactId: randomUUID(),
      operationId: workspaceB.operationId,
    });
    for (const input of [wrongAuthority, wrongOperation]) {
      await rejectsSql(
        () =>
          withWorkspace(app, WS_A, (transaction) =>
            appendWorkspace(transaction, input),
          ),
        "GENERIC_OPERATION_ARTIFACT_INVALID",
      );
    }
  });

  it("requires the fixed platform role and denies arbitrary workspace sessions", async () => {
    const digest = randomUUID().replaceAll("-", "").repeat(2);
    const input = artifactInput(platformBinding, {
      artifactId: randomUUID(),
      sha256: digest,
      objectKey: objectKey(digest),
      privacyClass: "PUBLIC_ORGANIZATION",
      sourceDigest: null,
    });
    const appended = await appendPlatform(platform, input);
    assert.equal(appended.length, 1);
    const [unknown] = await platform.$queryRawUnsafe(
      `SELECT * FROM mark_tool_budget_result_unknown_v1('platform', $1::uuid)`,
      input.operationId,
    );
    assert.equal(unknown.status, "RESULT_UNKNOWN");
    const reference = {
      schemaVersion: "generic-operation-artifact-ref/v1",
      artifactId: input.artifactId,
      operationId: input.operationId,
      resultSchema: input.resultSchema,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes.toString(),
      mediaType: input.mediaType,
      expiresAt: input.expiresAt.toISOString(),
    };
    const [settled] = await platform.$queryRawUnsafe(
      `SELECT * FROM settle_tool_budget_artifact_reference_v1(
        'platform', $1::uuid, 0, $2::jsonb
      )`,
      input.operationId,
      JSON.stringify(reference),
    );
    assert.equal(settled.status, "SETTLED");

    await rejectsSql(
      () => appendPlatform(app, { ...input, artifactId: randomUUID() }),
      "permission denied|PRINCIPAL_INVALID",
    );
    await rejectsSql(
      () => app.$queryRawUnsafe(
        `SELECT * FROM mark_tool_budget_result_unknown_v1('platform', $1::uuid)`,
        input.operationId,
      ),
      "permission denied|PRINCIPAL_INVALID",
    );
    const hidden = await withWorkspace(app, WS_A, (transaction) =>
      transaction.$queryRawUnsafe(
        `SELECT * FROM find_workspace_generic_operation_artifact_by_operation_v1(
          $1::uuid, $2::uuid, $3::uuid, $4
        )`,
        WS_A,
        input.authorityId,
        input.operationId,
        input.resultSchema,
      ),
    );
    assert.deepEqual(hidden, []);
  });

  it("denies PUBLIC and direct app/platform DML on manifests and object metadata", async () => {
    const privileges = await owner.$queryRawUnsafe(`
      WITH principal(name) AS (
        VALUES ('PUBLIC'::text), ('app_user'::text),
               ('execution_budget_platform_writer'::text)
      ), requested(name) AS (
        VALUES ('SELECT'::text), ('INSERT'::text),
               ('UPDATE'::text), ('DELETE'::text)
      ), relation AS (
        SELECT oid, relname, relacl, relowner FROM pg_class
        WHERE relname IN (
          'generic_operation_artifact', 'generic_operation_artifact_object'
        )
      )
      SELECT relation.relname AS relation, principal.name AS principal,
        requested.name AS privilege,
        CASE WHEN principal.name='PUBLIC' THEN EXISTS (
          SELECT 1 FROM aclexplode(
            COALESCE(relation.relacl, acldefault('r', relation.relowner))
          ) acl WHERE acl.grantee=0
            AND acl.privilege_type=requested.name
        ) ELSE has_table_privilege(
          principal.name, relation.oid, requested.name
        ) END AS allowed
      FROM principal CROSS JOIN requested CROSS JOIN relation
      ORDER BY relation.relname, principal.name, requested.name
    `);
    assert.equal(privileges.length, 24);
    assert.ok(privileges.every(({ allowed }) => allowed === false));

    const routinePrivileges = await owner.$queryRawUnsafe(`
      WITH principal(name) AS (
        VALUES ('PUBLIC'::text), ('app_user'::text),
               ('execution_budget_platform_writer'::text)
      ), routine AS (
        SELECT oid, proname, proacl, proowner FROM pg_proc
        WHERE proname IN (
          'append_generic_operation_artifact_internal_v1',
          'append_workspace_generic_operation_artifact_v1',
          'append_platform_generic_operation_artifact_v1',
          'find_exact_workspace_generic_operation_artifact_v1',
          'find_exact_platform_generic_operation_artifact_v1',
          'find_workspace_generic_operation_artifact_by_operation_v1',
          'find_platform_generic_operation_artifact_by_operation_v1',
          'guard_tool_budget_unresolved_generation_v1',
          'mark_tool_budget_result_unknown_v1',
          'settle_tool_budget_artifact_reference_v1'
        )
      )
      SELECT routine.proname AS routine, principal.name AS principal,
        CASE WHEN principal.name='PUBLIC' THEN EXISTS (
          SELECT 1 FROM aclexplode(
            COALESCE(routine.proacl, acldefault('f', routine.proowner))
          ) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
        ) ELSE has_function_privilege(
          principal.name, routine.oid, 'EXECUTE'
        ) END AS allowed
      FROM routine CROSS JOIN principal
      ORDER BY routine.proname, principal.name
    `);
    const expected = {
      append_generic_operation_artifact_internal_v1: [],
      append_workspace_generic_operation_artifact_v1: ["app_user"],
      append_platform_generic_operation_artifact_v1: [
        "execution_budget_platform_writer",
      ],
      find_exact_workspace_generic_operation_artifact_v1: ["app_user"],
      find_exact_platform_generic_operation_artifact_v1: [
        "execution_budget_platform_writer",
      ],
      find_workspace_generic_operation_artifact_by_operation_v1: ["app_user"],
      find_platform_generic_operation_artifact_by_operation_v1: [
        "execution_budget_platform_writer",
      ],
      guard_tool_budget_unresolved_generation_v1: [],
      mark_tool_budget_result_unknown_v1: [
        "app_user",
        "execution_budget_platform_writer",
      ],
      settle_tool_budget_artifact_reference_v1: [
        "app_user",
        "execution_budget_platform_writer",
      ],
    };
    assert.equal(routinePrivileges.length, 30);
    for (const privilege of routinePrivileges) {
      assert.equal(
        privilege.allowed,
        expected[privilege.routine].includes(privilege.principal),
        `${privilege.principal} EXECUTE ${privilege.routine}`,
      );
    }

    await rejectsSql(
      () => app.$queryRawUnsafe("SELECT * FROM generic_operation_artifact"),
      "permission denied",
    );
    await rejectsSql(
      () =>
        app.$queryRawUnsafe("SELECT * FROM generic_operation_artifact_object"),
      "permission denied",
    );
    await rejectsSql(
      () =>
        app.$executeRawUnsafe(
          `INSERT INTO generic_operation_artifact (
            id, scope_key, workspace_id, authority_id, operation_id,
            result_schema, object_key, sha256, size_bytes, media_type,
            privacy_class, created_at, expires_at
          ) VALUES (
            gen_random_uuid(), '${WS_A}', '${WS_A}'::uuid,
            gen_random_uuid(), gen_random_uuid(), 'http-get/v1',
            '${objectKey(SHA_A)}', '${SHA_A}', 1, 'text/html',
            'CONFIDENTIAL_TENANT', now(), now() + interval '1 hour'
          )`,
        ),
      "permission denied",
    );
    await rejectsSql(
      () =>
        app.$executeRawUnsafe(
          "UPDATE generic_operation_artifact SET size_bytes=1",
        ),
      "permission denied",
    );
    await rejectsSql(
      () => app.$executeRawUnsafe("DELETE FROM generic_operation_artifact"),
      "permission denied",
    );
  });

  it("rejects hostile NULLs instead of accepting SQL three-valued bypasses", async () => {
    const input = artifactInput(workspaceB, {
      artifactId: randomUUID(),
      sha256: "12".padEnd(64, "0"),
      objectKey: objectKey("12".padEnd(64, "0")),
    });
    for (const field of [
      "workspaceId",
      "artifactId",
      "authorityId",
      "operationId",
      "resultSchema",
      "objectKey",
      "sha256",
      "sizeBytes",
      "mediaType",
      "privacyClass",
      "createdAt",
      "expiresAt",
    ]) {
      await rejectsSql(
        () =>
          withWorkspace(app, WS_B, (transaction) =>
            appendWorkspace(transaction, { ...input, [field]: null }),
          ),
        "GENERIC_OPERATION_ARTIFACT_INVALID",
      );
    }
  });

  it("keeps bodies, headers, prompts, tokens and emails out of database metadata", async () => {
    const columns = await owner.$queryRawUnsafe(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='generic_operation_artifact'
      ORDER BY ordinal_position
    `);
    assert.deepEqual(
      columns.map(({ column_name }) => column_name),
      [
        "id",
        "scope_key",
        "workspace_id",
        "authority_id",
        "operation_id",
        "result_schema",
        "object_key",
        "sha256",
        "size_bytes",
        "media_type",
        "privacy_class",
        "source_digest",
        "created_at",
        "expires_at",
      ],
    );
  });

  it("uses an explicit transaction and leaves no PUBLIC or broad grant in migration SQL", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const sharedContentSql = await readFile(sharedContentMigrationPath, "utf8");
    assert.match(sql, /^BEGIN;/m);
    assert.match(sql, /COMMIT;\s*$/);
    assert.match(
      sql,
      /ALTER TABLE "generic_operation_artifact" FORCE ROW LEVEL SECURITY/,
    );
    assert.match(sql, /SECURITY DEFINER/g);
    assert.match(sql, /SET search_path = pg_catalog, public/g);
    assert.match(sql, /REVOKE ALL ON TABLE[\s\S]*FROM PUBLIC/);
    assert.doesNotMatch(
      sql,
      /GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)[\s\S]*generic_operation_artifact[\s\S]*TO\s+(?:app_user|execution_budget_platform_writer)/i,
    );
    assert.match(sharedContentSql, /^BEGIN;/m);
    assert.match(sharedContentSql, /COMMIT;\s*$/);
    assert.match(
      sharedContentSql,
      /DROP CONSTRAINT "generic_operation_artifact_scope_digest_schema_key"/,
    );
    assert.match(
      sharedContentSql,
      /REVOKE ALL ON TABLE "generic_operation_artifact_object" FROM PUBLIC/,
    );
    assert.doesNotMatch(
      sharedContentSql,
      /GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)[\s\S]*generic_operation_artifact_object[\s\S]*TO\s+(?:app_user|execution_budget_platform_writer)/i,
    );
  });
});
