import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const expectedFactsMigrationPath = resolve(
  repositoryRoot,
  "packages/db/prisma/migrations/20260822010000_generic_operation_artifact_expected_facts/migration.sql",
);
const validateMigrationPath = resolve(
  repositoryRoot,
  "packages/db/prisma/migrations/20260822011000_generic_operation_artifact_expected_facts_validate/migration.sql",
);
const OWNER_URL = process.env.DATABASE_URL;
const APP_URL = process.env.APP_DATABASE_URL;
const WS_ID = "00000000-0000-4000-8000-0000000000f7";
const CREATED_AT = new Date("2036-08-21T01:02:03.004Z");
const EXPIRES_AT = new Date("2036-08-22T01:02:03.004Z");

function requireDatabaseUrl(name, value) {
  assert.ok(value, `${name} is required`);
  const parsed = new URL(value);
  assert.ok(["postgres:", "postgresql:"].includes(parsed.protocol));
}

function client(url) {
  return new PrismaClient({ datasources: { db: { url } } });
}

function objectKey(sha256) {
  return `generic-operation-results/v1/sha256/${sha256.slice(0, 2)}/${sha256}`;
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

async function rejectsArtifact(callback) {
  await assert.rejects(callback, /GENERIC_OPERATION_ARTIFACT_INVALID/);
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
    `https://artifact-facts-rls-${randomUUID()}.example.test`,
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
    WS_ID,
    `artifact-facts-rls-${randomUUID()}`,
    authorityId,
  );
  await owner.$executeRawUnsafe(
    `INSERT INTO tool_budget_operation (
      id, scope_key, account_id, generation, operation_key,
      reserved_cents, status, created_at
    ) VALUES ($1::uuid, $2, $3::uuid, 1, $4, 0, 'RESERVED', now())`,
    operationId,
    WS_ID,
    accountId,
    `artifact-facts-rls-${randomUUID()}`,
  );
  return { authorityId, operationId };
}

function artifactInput(binding, overrides = {}) {
  const sha256 = overrides.sha256 ?? randomUUID().replaceAll("-", "").repeat(2);
  return {
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

async function append(transaction, input) {
  return transaction.$queryRawUnsafe(
    `SELECT * FROM append_workspace_generic_operation_artifact_v2(
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
      $8::bigint, $9, $10, $11, $12::timestamptz, $13::timestamptz,
      $14::smallint, $15::boolean, $16, $17, $18, $19::boolean
    )`,
    WS_ID, input.artifactId, input.authorityId, input.operationId,
    input.resultSchema, input.objectKey, input.sha256, input.sizeBytes,
    input.mediaType, input.privacyClass, input.sourceDigest, input.createdAt,
    input.expiresAt, input.expectedHttpStatus, input.expectedHttpOk,
    input.expectedSanitizedUrl, input.expectedContentHash,
    input.expectedBlockedCode, input.expectedRobotsBlocked,
  );
}

describe("generic operation artifact expected-facts PostgreSQL", () => {
  let owner;
  let app;

  before(async () => {
    requireDatabaseUrl("DATABASE_URL", OWNER_URL);
    requireDatabaseUrl("APP_DATABASE_URL", APP_URL);
    owner = client(OWNER_URL);
    const deployment = spawnSync(
      "pnpm",
      ["--filter", "@global/db", "exec", "prisma", "migrate", "deploy"],
      { cwd: repositoryRoot, encoding: "utf8", env: { ...process.env, DATABASE_URL: OWNER_URL } },
    );
    assert.equal(deployment.status, 0, `${deployment.stdout}\n${deployment.stderr}`);
    await owner.$executeRawUnsafe(
      `INSERT INTO workspace (id, name, created_at, updated_at)
       VALUES ($1::uuid, 'Artifact facts RLS', now(), now())
       ON CONFLICT (id) DO NOTHING`,
      WS_ID,
    );
    app = client(APP_URL);
  });

  after(async () => {
    await Promise.allSettled([app?.$disconnect(), owner?.$disconnect()]);
  });

  it("binds all four exact result-schema branches", async () => {
    const cases = [
      { resultSchema: "sanctions-download/v1", expectedHttpStatus: null,
        expectedHttpOk: null, expectedSanitizedUrl: null,
        expectedContentHash: null, expectedBlockedCode: null,
        expectedRobotsBlocked: null },
      { resultSchema: "http-get/v1", expectedHttpStatus: 0,
        expectedHttpOk: false, expectedSanitizedUrl: null,
        expectedContentHash: null, expectedBlockedCode: "non_global_address",
        expectedRobotsBlocked: null },
      { resultSchema: "crawl4ai-fetch/v1", expectedHttpStatus: null,
        expectedHttpOk: null, expectedSanitizedUrl: "https://example.com/final",
        expectedContentHash: "a".repeat(24), expectedBlockedCode: null,
        expectedRobotsBlocked: null },
      { resultSchema: "crawl4ai-render/v1", expectedHttpStatus: null,
        expectedHttpOk: null, expectedSanitizedUrl: "https://example.com/final",
        expectedContentHash: null, expectedBlockedCode: null,
        expectedRobotsBlocked: true },
    ];
    for (const expected of cases) {
      const input = artifactInput(await seedBinding(owner), expected);
      const [stored] = await withWorkspace(app, (tx) => append(tx, input));
      assert.deepEqual(
        {
          resultSchema: stored.result_schema,
          expectedHttpStatus: stored.expected_http_status,
          expectedHttpOk: stored.expected_http_ok,
          expectedSanitizedUrl: stored.expected_sanitized_url,
          expectedContentHash: stored.expected_content_hash,
          expectedBlockedCode: stored.expected_blocked_code,
          expectedRobotsBlocked: stored.expected_robots_blocked,
        },
        expected,
      );
    }
  });

  it("rejects NULL, cross-schema and raw sensitive URLs with transaction rollback", async () => {
    const invalidFacts = [
      { expectedHttpStatus: null },
      { expectedHttpOk: false },
      { expectedSanitizedUrl: null },
      { expectedSanitizedUrl: "https://user:password@example.com/path" },
      { expectedSanitizedUrl: "https://example.com/?token=secret" },
      { expectedSanitizedUrl: "https://example.com/?to%6ben=secret" },
      { expectedSanitizedUrl: "https://example.com/?ｔｏｋｅｎ=secret" },
      { expectedSanitizedUrl: "https://example.com/?page=1" },
      { expectedSanitizedUrl: "https://EXAMPLE.com" },
      { expectedSanitizedUrl: "https://example.com" },
      { expectedSanitizedUrl: "https://%zz" },
      { expectedSanitizedUrl: "https://-bad.example.com/" },
      { expectedSanitizedUrl: "https://127.0.0.1/" },
      { expectedSanitizedUrl: "https://example.com/a/../b" },
      { expectedSanitizedUrl: "https://example.com/person@example.com" },
      { expectedSanitizedUrl: "https://example.com/customer/13800138000" },
      { expectedHttpStatus: 0, expectedHttpOk: false,
        expectedSanitizedUrl: null, expectedBlockedCode: null },
      { resultSchema: "crawl4ai-fetch/v1", expectedHttpStatus: null,
        expectedHttpOk: null, expectedContentHash: "ABC" },
      { resultSchema: "crawl4ai-render/v1", expectedHttpStatus: null,
        expectedHttpOk: null, expectedRobotsBlocked: null },
      { resultSchema: "sanctions-download/v1",
        expectedSanitizedUrl: "https://example.com/final" },
    ];
    for (const facts of invalidFacts) {
      const binding = await seedBinding(owner);
      const input = artifactInput(binding, facts);
      await rejectsArtifact(() => withWorkspace(app, (tx) => append(tx, input)));
      const [{ count }] = await owner.$queryRawUnsafe(
        `SELECT count(*)::int AS count FROM generic_operation_artifact
         WHERE scope_key=$1 AND operation_id=$2::uuid`,
        WS_ID,
        binding.operationId,
      );
      assert.equal(count, 0);
    }
  });

  it("keeps the metadata schema closed and the two forward migrations bounded", async () => {
    const columns = await owner.$queryRawUnsafe(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='generic_operation_artifact'
       ORDER BY ordinal_position`,
    );
    assert.deepEqual(columns.map(({ column_name }) => column_name), [
      "id", "scope_key", "workspace_id", "authority_id", "operation_id",
      "result_schema", "object_key", "sha256", "size_bytes", "media_type",
      "privacy_class", "source_digest", "created_at", "expires_at",
      "expected_http_status", "expected_http_ok", "expected_sanitized_url",
      "expected_content_hash", "expected_blocked_code",
      "expected_robots_blocked",
    ]);
    const sql = await readFile(expectedFactsMigrationPath, "utf8");
    const validateSql = await readFile(validateMigrationPath, "utf8");
    assert.match(sql, /^BEGIN;/m);
    assert.match(sql, /COMMIT;\s*$/);
    assert.match(sql, /\) NOT VALID;/g);
    assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
    assert.doesNotMatch(sql, /GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)/i);
    assert.match(validateSql, /^BEGIN;/m);
    assert.match(validateSql, /COMMIT;\s*$/);
    assert.match(validateSql, /VALIDATE CONSTRAINT/g);
  });
});
