import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const OWNER_URL = process.env.DATABASE_URL;
const APP_URL = process.env.APP_DATABASE_URL;
const PLATFORM_LOGIN = "generic_operation_artifact_recovery_platform_test";
const PLATFORM_PASSWORD = "generic-operation-artifact-recovery-test-only";
const WS_ID = "00000000-0000-4000-8000-0000000000d4";
const OTHER_WS_ID = "00000000-0000-4000-8000-0000000000e5";
const CREATED_AT = new Date("2036-08-21T01:02:03.004Z");
const EXPIRES_AT = new Date("2036-08-22T01:02:03.004Z");

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

function artifactInput(binding, overrides = {}) {
  const sha256 = overrides.sha256 ?? randomUUID().replaceAll("-", "").repeat(2);
  return {
    workspaceId: binding.workspaceId,
    artifactId: randomUUID(),
    authorityId: binding.authorityId,
    operationId: binding.operationId,
    resultSchema: "http-get/v1",
    objectKey: objectKey(sha256),
    sha256,
    sizeBytes: 23n,
    mediaType: "text/html",
    privacyClass: "CONFIDENTIAL_TENANT",
    sourceDigest: null,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    expectedHttpStatus: 200,
    expectedHttpOk: true,
    expectedSanitizedUrl: "https://example.com/final",
    expectedContentHash: null,
    expectedBlockedCode: null,
    expectedRobotsBlocked: null,
    ...overrides,
  };
}

function artifactManifest(input) {
  return {
    schemaVersion: "generic-operation-artifact/v1",
    artifactId: input.artifactId,
    scopeKind: input.workspaceId === null ? "platform" : "workspace",
    workspaceId: input.workspaceId,
    authorityId: input.authorityId,
    operationId: input.operationId,
    resultSchema: input.resultSchema,
    objectKey: input.objectKey,
    sha256: input.sha256,
    sizeBytes: input.sizeBytes.toString(),
    mediaType: input.mediaType,
    privacyClass: input.privacyClass,
    sourceDigest: input.sourceDigest,
    createdAt: input.createdAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  };
}

async function markUnknown(transaction, binding, input) {
  return transaction.$queryRawUnsafe(
    `SELECT * FROM mark_tool_budget_result_unknown_v3(
      $1, $2::uuid, $3::jsonb, $4::smallint, $5::boolean,
      $6, $7, $8, $9::boolean
    )`,
    binding.workspaceId ?? "platform",
    binding.operationId,
    input === null ? null : JSON.stringify(artifactManifest(input)),
    input?.expectedHttpStatus ?? null,
    input?.expectedHttpOk ?? null,
    input?.expectedSanitizedUrl ?? null,
    input?.expectedContentHash ?? null,
    input?.expectedBlockedCode ?? null,
    input?.expectedRobotsBlocked ?? null,
  );
}

async function settleManifest(transaction, binding, input, observedCents) {
  return transaction.$queryRawUnsafe(
    `SELECT * FROM settle_tool_budget_artifact_manifest_v3(
      $1, $2::uuid, $3::bigint, $4::jsonb, $5::smallint,
      $6::boolean, $7, $8, $9, $10::boolean
    )`,
    binding.workspaceId ?? "platform",
    binding.operationId,
    observedCents,
    JSON.stringify(artifactManifest(input)),
    input.expectedHttpStatus,
    input.expectedHttpOk,
    input.expectedSanitizedUrl,
    input.expectedContentHash,
    input.expectedBlockedCode,
    input.expectedRobotsBlocked,
  );
}

async function appendWorkspace(transaction, input) {
  return transaction.$queryRawUnsafe(
    `SELECT * FROM append_workspace_generic_operation_artifact_v2(
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
      $8::bigint, $9, $10, $11, $12::timestamptz, $13::timestamptz,
      $14::smallint, $15::boolean, $16, $17, $18, $19::boolean
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
    input.expectedHttpStatus,
    input.expectedHttpOk,
    input.expectedSanitizedUrl,
    input.expectedContentHash,
    input.expectedBlockedCode,
    input.expectedRobotsBlocked,
  );
}

async function seedBinding(owner, options = {}) {
  const workspaceId = options.platform ? null : WS_ID;
  const scopeKey = workspaceId ?? "platform";
  const authorityId = randomUUID();
  const accountId = randomUUID();
  const operationId = randomUUID();
  const capCents = options.capCents ?? 0n;
  const reservedCents = options.reservedCents ?? 0n;
  const authorizedCapMicrousd = options.platform ? 1_000_000n : 5_000_000n;
  if (workspaceId) {
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
      `https://artifact-recovery-${randomUUID()}.example.test`,
      randomUUID(),
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `company-${randomUUID()}`,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
    );
  } else {
    const scheduleId = `artifact-recovery-${randomUUID()}`;
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
      `https://artifact-recovery-${randomUUID()}.example.test`,
      randomUUID(),
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      scheduleId,
    );
  }
  await owner.$executeRawUnsafe(
    `INSERT INTO tool_budget_account (
      id, scope_key, account_key, generation, cap_cents, reserved_cents,
      charged_cents, exhausted, ref_count, authority_id,
      authorized_cap_microusd, created_at, updated_at
    ) VALUES (
      $1::uuid, $2, $3, 1, $5::bigint, $6::bigint, 0,
      false, 1, $4::uuid, $7::bigint,
      statement_timestamp(), statement_timestamp()
    )`,
    accountId,
    scopeKey,
    `artifact-recovery-account-${randomUUID()}`,
    authorityId,
    capCents,
    reservedCents,
    authorizedCapMicrousd,
  );
  await owner.$executeRawUnsafe(
    `INSERT INTO tool_budget_operation (
      id, scope_key, account_id, generation, operation_key,
      reserved_cents, status, created_at
    ) VALUES ($1::uuid, $2, $3::uuid, 1, $4, $5::bigint, 'RESERVED', now())`,
    operationId,
    scopeKey,
    accountId,
    `artifact-recovery-operation-${randomUUID()}`,
    reservedCents,
  );
  return { workspaceId, authorityId, accountId, operationId };
}

describe("generic operation artifact atomic recovery PostgreSQL", () => {
  let owner;
  let app;
  let platform;

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
    await owner.$executeRawUnsafe(`
      DO $role$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${PLATFORM_LOGIN}') THEN
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
        ('${WS_ID}'::uuid, 'Artifact Recovery WS', now(), now()),
        ('${OTHER_WS_ID}'::uuid, 'Artifact Recovery Other WS', now(), now())
       ON CONFLICT (id) DO NOTHING`,
    );
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

  it("atomically binds expected facts and settles nonzero arithmetic without changing either cap", async () => {
    const binding = await seedBinding(owner, {
      capCents: 100n,
      reservedCents: 17n,
    });
    const input = artifactInput(binding);
    const [unknown] = await withWorkspace(app, WS_ID, (tx) =>
      markUnknown(tx, binding, input),
    );
    assert.deepEqual(unknown, {
      reserved_cents: 17n,
      status: "RESULT_UNKNOWN",
      replay: false,
      recoverable: true,
    });
    const [bound] = await owner.$queryRawUnsafe(
      `SELECT operation.expected_artifact, operation.generation,
              operation.expected_http_status,
              operation.expected_http_ok,
              operation.expected_sanitized_url,
              operation.expected_content_hash,
              operation.expected_blocked_code,
              operation.expected_robots_blocked,
              account.account_key, account.cap_cents,
              account.reserved_cents, account.charged_cents,
              account.authorized_cap_microusd
       FROM tool_budget_operation operation
       JOIN tool_budget_account account ON account.id=operation.account_id
       WHERE operation.scope_key=$1 AND operation.id=$2::uuid`,
      WS_ID,
      binding.operationId,
    );
    assert.equal(bound.expected_artifact.accountId, binding.accountId);
    assert.equal(bound.expected_artifact.accountKey, bound.account_key);
    assert.equal(bound.expected_artifact.authorityId, binding.authorityId);
    assert.equal(bound.expected_artifact.operationId, binding.operationId);
    assert.deepEqual(bound.expected_artifact.manifest, artifactManifest(input));
    assert.equal(bound.cap_cents, 100n);
    assert.equal(bound.reserved_cents, 17n);
    assert.equal(bound.charged_cents, 0n);
    assert.equal(bound.authorized_cap_microusd, 5_000_000n);
    assert.equal(bound.generation, 1);
    assert.equal(bound.expected_http_status, 200);
    assert.equal(bound.expected_http_ok, true);
    assert.equal(bound.expected_sanitized_url, "https://example.com/final");
    assert.equal(bound.expected_content_hash, null);
    assert.equal(bound.expected_blocked_code, null);
    assert.equal(bound.expected_robots_blocked, null);
    const [loaded] = await withWorkspace(app, WS_ID, (tx) =>
      tx.$queryRawUnsafe(
        `SELECT * FROM load_tool_budget_result_unknown_artifact_v3(
          $1, $2::uuid, $3::uuid
        )`,
        WS_ID,
        binding.operationId,
        binding.authorityId,
      ),
    );
    assert.deepEqual(loaded.expected_manifest, artifactManifest(input));
    assert.equal(loaded.expected_http_status, 200);
    assert.equal(loaded.expected_http_ok, true);
    assert.equal(loaded.expected_sanitized_url, "https://example.com/final");

    const substitute = artifactInput(binding);
    await rejectsSql(
      () =>
        withWorkspace(app, WS_ID, (tx) =>
          settleManifest(tx, binding, substitute, 13n),
        ),
      "GENERIC_OPERATION_ARTIFACT_INVALID",
    );
    await rejectsSql(
      () =>
        withWorkspace(app, WS_ID, (tx) =>
          settleManifest(
            tx,
            binding,
            {
              ...input,
              expectedSanitizedUrl:
                "https://user:password@example.com/?token=secret",
            },
            13n,
          ),
        ),
      "GENERIC_OPERATION_ARTIFACT_INVALID",
    );
    const [settled] = await withWorkspace(app, WS_ID, (tx) =>
      settleManifest(tx, binding, input, 13n),
    );
    assert.deepEqual(settled, {
      charged_cents: 17n,
      observed_cents: 13n,
      cap_variance: false,
      status: "SETTLED",
      replay: false,
    });
    const [replay] = await withWorkspace(app, WS_ID, (tx) =>
      settleManifest(tx, binding, input, 13n),
    );
    assert.equal(replay.replay, true);
    const [final] = await owner.$queryRawUnsafe(
      `SELECT account.cap_cents, account.reserved_cents,
              account.charged_cents, account.authorized_cap_microusd,
              operation.expected_artifact,
              artifact.expected_http_status,
              artifact.expected_http_ok,
              artifact.expected_sanitized_url,
              (SELECT count(*)::int FROM generic_operation_artifact artifact
               WHERE artifact.scope_key=operation.scope_key
                 AND artifact.operation_id=operation.id) AS manifests
       FROM tool_budget_operation operation
       JOIN tool_budget_account account ON account.id=operation.account_id
       JOIN generic_operation_artifact artifact
         ON artifact.scope_key=operation.scope_key
        AND artifact.operation_id=operation.id
       WHERE operation.scope_key=$1 AND operation.id=$2::uuid`,
      WS_ID,
      binding.operationId,
    );
    assert.equal(final.cap_cents, 100n);
    assert.equal(final.reserved_cents, 0n);
    assert.equal(final.charged_cents, 17n);
    assert.equal(final.authorized_cap_microusd, 5_000_000n);
    assert.deepEqual(final.expected_artifact, bound.expected_artifact);
    assert.equal(final.expected_http_status, 200);
    assert.equal(final.expected_http_ok, true);
    assert.equal(final.expected_sanitized_url, "https://example.com/final");
    assert.equal(final.manifests, 1);
  });

  it("keeps stage ACK unknown unrecoverable and rejects later substitute facts", async () => {
    const binding = await seedBinding(owner, {
      capCents: 50n,
      reservedCents: 9n,
    });
    const [unknown] = await withWorkspace(app, WS_ID, (tx) =>
      markUnknown(tx, binding, null),
    );
    assert.equal(unknown.recoverable, false);
    await rejectsSql(
      () =>
        withWorkspace(app, WS_ID, (tx) =>
          tx.$queryRawUnsafe(
            `SELECT * FROM load_tool_budget_result_unknown_artifact_v3(
            $1, $2::uuid, $3::uuid
          )`,
            WS_ID,
            binding.operationId,
            binding.authorityId,
          ),
        ),
      "GENERIC_OPERATION_ARTIFACT_INVALID",
    );
    await rejectsSql(
      () =>
        withWorkspace(app, WS_ID, (tx) =>
          markUnknown(tx, binding, artifactInput(binding)),
        ),
      "GENERIC_OPERATION_ARTIFACT_INVALID",
    );
    const [{ count }] = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS count FROM generic_operation_artifact
       WHERE scope_key=$1 AND operation_id=$2::uuid`,
      WS_ID,
      binding.operationId,
    );
    assert.equal(count, 0);
  });

  it("rejects expired settlement with the trusted database clock", async () => {
    const binding = await seedBinding(owner, {
      capCents: 50n,
      reservedCents: 11n,
    });
    const input = artifactInput(binding, {
      createdAt: new Date(Date.now() - 2_000),
      expiresAt: new Date(Date.now() - 1_000),
    });
    await rejectsSql(
      () =>
        withWorkspace(app, WS_ID, (tx) =>
          settleManifest(tx, binding, input, 7n),
        ),
      "GENERIC_OPERATION_ARTIFACT_INVALID",
    );
    const [state] = await owner.$queryRawUnsafe(
      `SELECT operation.status::text AS status,
              account.cap_cents, account.reserved_cents,
              account.charged_cents,
              (SELECT count(*)::int FROM generic_operation_artifact artifact
               WHERE artifact.scope_key=operation.scope_key
                 AND artifact.operation_id=operation.id) AS manifests
       FROM tool_budget_operation operation
       JOIN tool_budget_account account ON account.id=operation.account_id
       WHERE operation.scope_key=$1 AND operation.id=$2::uuid`,
      WS_ID,
      binding.operationId,
    );
    assert.deepEqual(state, {
      status: "RESERVED",
      cap_cents: 50n,
      reserved_cents: 11n,
      charged_cents: 0n,
      manifests: 0,
    });
  });

  it("records cap variance while charging only the full reservation", async () => {
    const binding = await seedBinding(owner, {
      capCents: 100n,
      reservedCents: 17n,
    });
    const input = artifactInput(binding);
    await withWorkspace(app, WS_ID, (tx) => markUnknown(tx, binding, input));
    const [settled] = await withWorkspace(app, WS_ID, (tx) =>
      settleManifest(tx, binding, input, 19n),
    );
    assert.equal(settled.charged_cents, 17n);
    assert.equal(settled.cap_variance, true);
    const [state] = await owner.$queryRawUnsafe(
      `SELECT cap_cents, reserved_cents, charged_cents, exhausted,
              authorized_cap_microusd
       FROM tool_budget_account WHERE scope_key=$1 AND id=$2::uuid`,
      WS_ID,
      binding.accountId,
    );
    assert.deepEqual(state, {
      cap_cents: 100n,
      reserved_cents: 0n,
      charged_cents: 17n,
      exhausted: true,
      authorized_cap_microusd: 5_000_000n,
    });
  });

  it("settles an exact existing manifest and rolls back a new append on later account failure", async () => {
    const existing = await seedBinding(owner, {
      capCents: 40n,
      reservedCents: 8n,
    });
    const existingInput = artifactInput(existing);
    await withWorkspace(app, WS_ID, (tx) => appendWorkspace(tx, existingInput));
    const [settled] = await withWorkspace(app, WS_ID, (tx) =>
      settleManifest(tx, existing, existingInput, 8n),
    );
    assert.equal(settled.status, "SETTLED");

    const rollback = await seedBinding(owner, {
      capCents: 100n,
      reservedCents: 17n,
    });
    const rollbackInput = artifactInput(rollback);
    await owner.$executeRawUnsafe(
      `UPDATE tool_budget_account SET reserved_cents=0
       WHERE scope_key=$1 AND id=$2::uuid`,
      WS_ID,
      rollback.accountId,
    );
    await rejectsSql(
      () =>
        withWorkspace(app, WS_ID, (tx) =>
          settleManifest(tx, rollback, rollbackInput, 13n),
        ),
      "tool_budget_account_amounts_check",
    );
    const [state] = await owner.$queryRawUnsafe(
      `SELECT operation.status::text AS status, operation.result_json,
              (SELECT count(*)::int FROM generic_operation_artifact artifact
               WHERE artifact.scope_key=operation.scope_key
                 AND artifact.operation_id=operation.id) AS manifests
       FROM tool_budget_operation operation
       WHERE operation.scope_key=$1 AND operation.id=$2::uuid`,
      WS_ID,
      rollback.operationId,
    );
    assert.deepEqual(state, {
      status: "RESERVED",
      result_json: null,
      manifests: 0,
    });
  });

  it("serializes predecessor append and v2 settle without reversing lock order", async () => {
    const binding = await seedBinding(owner, {
      capCents: 40n,
      reservedCents: 8n,
    });
    const input = artifactInput(binding);
    const concurrentApp = client(APP_URL);
    try {
      const [appended, settled] = await Promise.all([
        withWorkspace(app, WS_ID, (tx) => appendWorkspace(tx, input)),
        withWorkspace(concurrentApp, WS_ID, (tx) =>
          settleManifest(tx, binding, input, 8n),
        ),
      ]);
      assert.equal(appended.length, 1);
      assert.equal(settled.length, 1);
      assert.equal(settled[0].status, "SETTLED");
    } finally {
      await concurrentApp.$disconnect();
    }
  });

  it("enforces workspace scope and the fixed platform writer principal", async () => {
    const workspace = await seedBinding(owner);
    await rejectsSql(
      () =>
        withWorkspace(app, OTHER_WS_ID, (tx) =>
          markUnknown(tx, workspace, artifactInput(workspace)),
        ),
      "GENERIC_OPERATION_ARTIFACT_INVALID",
    );

    const unsafePlatform = await seedBinding(owner, { platform: true });
    await rejectsSql(
      () =>
        markUnknown(
          platform,
          unsafePlatform,
          artifactInput(unsafePlatform, {
            expectedSanitizedUrl:
              "https://example.com/person@example.com",
          }),
        ),
      "GENERIC_OPERATION_ARTIFACT_INVALID",
    );

    const binding = await seedBinding(owner, { platform: true });
    const input = artifactInput(binding, {
      privacyClass: "PUBLIC_ORGANIZATION",
    });
    const [unknown] = await markUnknown(platform, binding, input);
    assert.equal(unknown.status, "RESULT_UNKNOWN");
    const [settled] = await settleManifest(platform, binding, input, 0n);
    assert.equal(settled.status, "SETTLED");
    await rejectsSql(
      () =>
        app.$queryRawUnsafe(
          `SELECT * FROM mark_tool_budget_result_unknown_v3(
          'platform', $1::uuid, $2::jsonb, 200::smallint, true,
          'https://example.com/final', NULL, NULL, NULL
        )`,
          binding.operationId,
          JSON.stringify(artifactManifest(input)),
        ),
      "permission denied|PRINCIPAL_INVALID",
    );
  });
});
