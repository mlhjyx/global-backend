import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const sourceSchema = resolve(
  repositoryRoot,
  "packages/db/prisma/schema.prisma",
);
const sourceMigrations = resolve(
  repositoryRoot,
  "packages/db/prisma/migrations",
);
const migrationNames = [
  "20260822010000_generic_operation_artifact_expected_facts",
  "20260822011000_generic_operation_artifact_expected_facts_validate",
];
const OWNER_URL = process.env.DATABASE_URL;
const APP_URL = process.env.APP_DATABASE_URL;
const WS_ID = "00000000-0000-4000-8000-0000000000f6";

function requiredUrl(name, value) {
  assert.ok(value, `${name} is required`);
  const parsed = new URL(value);
  assert.ok(["postgres:", "postgresql:"].includes(parsed.protocol));
  return parsed;
}

function databaseUrl(base, databaseName) {
  const parsed = requiredUrl("database URL", base);
  parsed.pathname = `/${databaseName}`;
  parsed.search = "";
  return parsed.href;
}

function client(url) {
  return new PrismaClient({ datasources: { db: { url } } });
}

function deploy(url, schema) {
  return spawnSync(
    "pnpm",
    [
      "--filter",
      "@global/db",
      "exec",
      "prisma",
      "migrate",
      "deploy",
      "--schema",
      schema,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: url },
    },
  );
}

function assertDeploys(result, label) {
  assert.equal(
    result.status,
    0,
    `${label}\n${result.stdout}\n${result.stderr}`,
  );
}

async function migrationSetWithoutExpectedFacts() {
  const root = await mkdtemp(join(tmpdir(), "artifact-facts-migration-"));
  const migrations = resolve(root, "migrations");
  await cp(sourceSchema, resolve(root, "schema.prisma"));
  await cp(sourceMigrations, migrations, { recursive: true });
  for (const migrationName of migrationNames) {
    await rm(resolve(migrations, migrationName), {
      recursive: true,
      force: true,
    });
  }
  return { root, schema: resolve(root, "schema.prisma"), migrations };
}

async function withWorkspace(database, callback) {
  return database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      "SELECT set_config('app.current_workspace_id', $1, true)",
      WS_ID,
    );
    return callback(transaction);
  });
}

async function seedBinding(owner) {
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
    WS_ID,
    `https://artifact-facts-${randomUUID()}.example.test`,
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
      $1::uuid, $2, $3, 1, 17, 17, 0, false, 1, $4::uuid,
      5000000, statement_timestamp(), statement_timestamp()
    )`,
    accountId,
    WS_ID,
    `artifact-facts-account-${randomUUID()}`,
    authorityId,
  );
  await owner.$executeRawUnsafe(
    `INSERT INTO tool_budget_operation (
      id, scope_key, account_id, generation, operation_key,
      reserved_cents, status, created_at
    ) VALUES ($1::uuid, $2, $3::uuid, 1, $4, 17, 'RESERVED', now())`,
    operationId,
    WS_ID,
    accountId,
    `artifact-facts-operation-${randomUUID()}`,
  );
  return { authorityId, operationId };
}

function artifact(binding) {
  const sha256 = randomUUID().replaceAll("-", "").repeat(2);
  const createdAt = new Date("2036-08-21T01:02:03.004Z");
  const expiresAt = new Date("2036-08-22T01:02:03.004Z");
  return {
    artifactId: randomUUID(),
    authorityId: binding.authorityId,
    operationId: binding.operationId,
    resultSchema: "http-get/v1",
    objectKey: `generic-operation-results/v1/sha256/${sha256.slice(0, 2)}/${sha256}`,
    sha256,
    sizeBytes: 23n,
    mediaType: "text/html",
    privacyClass: "CONFIDENTIAL_TENANT",
    sourceDigest: null,
    createdAt,
    expiresAt,
  };
}

function manifest(value) {
  return {
    schemaVersion: "generic-operation-artifact/v1",
    artifactId: value.artifactId,
    scopeKind: "workspace",
    workspaceId: WS_ID,
    authorityId: value.authorityId,
    operationId: value.operationId,
    resultSchema: value.resultSchema,
    objectKey: value.objectKey,
    sha256: value.sha256,
    sizeBytes: value.sizeBytes.toString(),
    mediaType: value.mediaType,
    privacyClass: value.privacyClass,
    sourceDigest: value.sourceDigest,
    createdAt: value.createdAt.toISOString(),
    expiresAt: value.expiresAt.toISOString(),
  };
}

async function appendV1(transaction, value) {
  return transaction.$queryRawUnsafe(
    `SELECT * FROM append_workspace_generic_operation_artifact_v1(
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
      $8::bigint, $9, $10, $11, $12::timestamptz, $13::timestamptz
    )`,
    WS_ID,
    value.artifactId,
    value.authorityId,
    value.operationId,
    value.resultSchema,
    value.objectKey,
    value.sha256,
    value.sizeBytes,
    value.mediaType,
    value.privacyClass,
    value.sourceDigest,
    value.createdAt,
    value.expiresAt,
  );
}

describe("generic operation artifact expected-facts forward migration", () => {
  let clusterOwner;

  before(() => {
    requiredUrl("DATABASE_URL", OWNER_URL);
    requiredUrl("APP_DATABASE_URL", APP_URL);
    clusterOwner = client(OWNER_URL);
  });

  after(async () => {
    await clusterOwner?.$disconnect();
  });

  it("keeps historical rows nullable while new replay paths fail closed and roll back", async () => {
    const databaseName = `artifact_facts_${randomUUID().replaceAll("-", "")}`;
    assert.match(databaseName, /^artifact_facts_[0-9a-f]{32}$/);
    await clusterOwner.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    const migrationSet = await migrationSetWithoutExpectedFacts();
    let owner;
    let app;
    try {
      const ownerUrl = databaseUrl(OWNER_URL, databaseName);
      const appUrl = databaseUrl(APP_URL, databaseName);
      assertDeploys(
        deploy(ownerUrl, migrationSet.schema),
        "predecessor deploy failed",
      );
      owner = client(ownerUrl);
      app = client(appUrl);
      await owner.$executeRawUnsafe(
        `INSERT INTO workspace (id, name, created_at, updated_at)
         VALUES ($1::uuid, 'Artifact facts migration', now(), now())`,
        WS_ID,
      );

      const historicalBinding = await seedBinding(owner);
      const historical = artifact(historicalBinding);
      await withWorkspace(app, (transaction) =>
        appendV1(transaction, historical),
      );

      const unknownBinding = await seedBinding(owner);
      const unknown = artifact(unknownBinding);
      await withWorkspace(app, (transaction) =>
        transaction.$queryRawUnsafe(
          `SELECT * FROM mark_tool_budget_result_unknown_v2(
            $1, $2::uuid, $3::jsonb
          )`,
          WS_ID,
          unknownBinding.operationId,
          JSON.stringify(manifest(unknown)),
        ),
      );

      for (const migrationName of migrationNames) {
        await cp(
          resolve(sourceMigrations, migrationName),
          resolve(migrationSet.migrations, migrationName),
          { recursive: true },
        );
      }
      assertDeploys(
        deploy(ownerUrl, migrationSet.schema),
        "expected-facts deploy failed",
      );

      const [stored] = await owner.$queryRawUnsafe(
        `SELECT expected_http_status, expected_http_ok,
                expected_sanitized_url, expected_content_hash,
                expected_blocked_code, expected_robots_blocked
         FROM generic_operation_artifact
         WHERE scope_key=$1 AND operation_id=$2::uuid`,
        WS_ID,
        historicalBinding.operationId,
      );
      assert.deepEqual(stored, {
        expected_http_status: null,
        expected_http_ok: null,
        expected_sanitized_url: null,
        expected_content_hash: null,
        expected_blocked_code: null,
        expected_robots_blocked: null,
      });

      const [read] = await withWorkspace(app, (transaction) =>
        transaction.$queryRawUnsafe(
          `SELECT * FROM find_workspace_generic_operation_artifact_by_operation_v2(
            $1::uuid, $2::uuid, $3::uuid, $4
          )`,
          WS_ID,
          historicalBinding.authorityId,
          historicalBinding.operationId,
          historical.resultSchema,
        ),
      );
      assert.equal(read.expected_http_status, null);
      await assert.rejects(
        () =>
          withWorkspace(app, (transaction) =>
            transaction.$queryRawUnsafe(
              `SELECT * FROM load_tool_budget_result_unknown_artifact_v3(
              $1, $2::uuid, $3::uuid
            )`,
              WS_ID,
              unknownBinding.operationId,
              unknownBinding.authorityId,
            ),
          ),
        /GENERIC_OPERATION_ARTIFACT_INVALID/,
      );

      const newBinding = await seedBinding(owner);
      const incomplete = artifact(newBinding);
      await assert.rejects(
        () =>
          withWorkspace(app, (transaction) =>
            appendV1(transaction, incomplete),
          ),
        /GENERIC_OPERATION_ARTIFACT_INVALID/,
      );
      const [{ count }] = await owner.$queryRawUnsafe(
        `SELECT count(*)::int AS count FROM generic_operation_artifact
         WHERE scope_key=$1 AND operation_id=$2::uuid`,
        WS_ID,
        newBinding.operationId,
      );
      assert.equal(count, 0);

      const legacyUnknownBinding = await seedBinding(owner);
      const legacyUnknown = artifact(legacyUnknownBinding);
      await assert.rejects(
        () =>
          withWorkspace(app, (transaction) =>
            transaction.$queryRawUnsafe(
              `SELECT * FROM mark_tool_budget_result_unknown_v2(
                $1, $2::uuid, $3::jsonb
              )`,
              WS_ID,
              legacyUnknownBinding.operationId,
              JSON.stringify(manifest(legacyUnknown)),
            ),
          ),
        /GENERIC_OPERATION_ARTIFACT_INVALID/,
      );
      const [rolledBackUnknown] = await owner.$queryRawUnsafe(
        `SELECT status, expected_artifact FROM tool_budget_operation
         WHERE scope_key=$1 AND id=$2::uuid`,
        WS_ID,
        legacyUnknownBinding.operationId,
      );
      assert.deepEqual(rolledBackUnknown, {
        status: "RESERVED",
        expected_artifact: null,
      });
    } finally {
      await Promise.allSettled([app?.$disconnect(), owner?.$disconnect()]);
      await rm(migrationSet.root, { recursive: true, force: true });
      await clusterOwner.$executeRawUnsafe(
        `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
      );
    }
  });
});
