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
const dbRoot = resolve(repositoryRoot, "packages/db");
const sourceSchema = resolve(dbRoot, "prisma/schema.prisma");
const sourceMigrations = resolve(dbRoot, "prisma/migrations");
const forwardMigrationName =
  "20260821110000_generic_operation_artifact_shared_content";
const forwardMigration = resolve(sourceMigrations, forwardMigrationName);
const OWNER_URL = process.env.DATABASE_URL;
const APP_URL = process.env.APP_DATABASE_URL;
const WS_ID = "00000000-0000-4000-8000-0000000000c3";
const DIGEST = "34".padEnd(64, "0");
const SOURCE_A = "56".padEnd(64, "0");
const SOURCE_B = "78".padEnd(64, "0");
const CREATED_A = new Date("2026-08-21T01:02:03.004Z");
const CREATED_B = new Date("2026-08-21T02:02:03.004Z");
const EXPIRES_A = new Date("2026-08-22T01:02:03.004Z");
const EXPIRES_B = new Date("2026-08-23T02:02:03.004Z");

function requireDatabaseUrl(name, value) {
  assert.ok(value, `${name} is required`);
  const parsed = new URL(value);
  assert.ok(["postgres:", "postgresql:"].includes(parsed.protocol));
  return parsed;
}

function databaseUrl(base, databaseName) {
  const parsed = requireDatabaseUrl("database URL", base);
  parsed.pathname = `/${databaseName}`;
  parsed.search = "";
  return parsed.href;
}

function client(url) {
  return new PrismaClient({ datasources: { db: { url } } });
}

function objectKey(sha256) {
  return `generic-operation-results/v1/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

async function prepareMigrationSet() {
  const root = await mkdtemp(join(tmpdir(), "artifact-migration-test-"));
  const migrations = resolve(root, "migrations");
  await cp(sourceSchema, resolve(root, "schema.prisma"));
  await cp(sourceMigrations, migrations, { recursive: true });
  await rm(resolve(migrations, forwardMigrationName), {
    recursive: true,
    force: true,
  });
  return {
    root,
    schema: resolve(root, "schema.prisma"),
    migrations,
  };
}

async function addForwardMigration(migrationSet) {
  await cp(
    forwardMigration,
    resolve(migrationSet.migrations, forwardMigrationName),
    { recursive: true },
  );
}

function deploy(databaseUrlValue, schema) {
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
      env: { ...process.env, DATABASE_URL: databaseUrlValue },
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

async function seedWorkspaceBinding(owner) {
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
    `https://artifact-upgrade-${randomUUID()}.example.test`,
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
    `artifact-upgrade-account-${randomUUID()}`,
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
    `artifact-upgrade-operation-${randomUUID()}`,
  );
  return { authorityId, operationId };
}

function manifest(binding, overrides = {}) {
  return {
    artifactId: randomUUID(),
    authorityId: binding.authorityId,
    operationId: binding.operationId,
    resultSchema: "http-get/v1",
    objectKey: objectKey(DIGEST),
    sha256: DIGEST,
    sizeBytes: 1_048_576n,
    mediaType: "text/html",
    privacyClass: "CONFIDENTIAL_TENANT",
    sourceDigest: SOURCE_A,
    createdAt: CREATED_A,
    expiresAt: EXPIRES_A,
    ...overrides,
  };
}

async function insertOldManifest(owner, value) {
  await owner.$executeRawUnsafe(
    `INSERT INTO generic_operation_artifact (
      id, scope_key, workspace_id, authority_id, operation_id,
      result_schema, object_key, sha256, size_bytes, media_type,
      privacy_class, source_digest, created_at, expires_at
    ) VALUES (
      $1::uuid, $2, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
      $8::bigint, $9, $10, $11, $12::timestamptz, $13::timestamptz
    )`,
    value.artifactId,
    WS_ID,
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

async function withWorkspace(database, callback) {
  return database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      "SELECT set_config('app.current_workspace_id', $1, true)",
      WS_ID,
    );
    return callback(transaction);
  });
}

async function readByOperation(app, value) {
  return withWorkspace(app, (transaction) =>
    transaction.$queryRawUnsafe(
      `SELECT * FROM find_workspace_generic_operation_artifact_by_operation_v1(
        $1::uuid, $2::uuid, $3::uuid, $4
      )`,
      WS_ID,
      value.authorityId,
      value.operationId,
      value.resultSchema,
    ),
  );
}

async function replay(app, value) {
  return withWorkspace(app, (transaction) =>
    transaction.$queryRawUnsafe(
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
    ),
  );
}

async function storedManifests(owner) {
  return owner.$queryRawUnsafe(`
    SELECT id, scope_key, workspace_id, authority_id, operation_id,
      result_schema, object_key, sha256, size_bytes, media_type,
      privacy_class, source_digest, created_at, expires_at
    FROM generic_operation_artifact ORDER BY id
  `);
}

describe("generic operation artifact forward migration", () => {
  let clusterOwner;

  before(() => {
    requireDatabaseUrl("DATABASE_URL", OWNER_URL);
    requireDatabaseUrl("APP_DATABASE_URL", APP_URL);
    clusterOwner = client(OWNER_URL);
  });

  after(async () => {
    await clusterOwner?.$disconnect();
  });

  async function withTemporaryDatabase(callback) {
    const databaseName = `artifact_upgrade_${randomUUID().replaceAll("-", "")}`;
    assert.match(databaseName, /^artifact_upgrade_[0-9a-f]{32}$/);
    await clusterOwner.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    try {
      await callback({
        ownerUrl: databaseUrl(OWNER_URL, databaseName),
        appUrl: databaseUrl(APP_URL, databaseName),
      });
    } finally {
      await clusterOwner.$executeRawUnsafe(
        `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
      );
    }
  }

  it("backfills non-empty old manifests into one object without changing operation lineage", async () => {
    await withTemporaryDatabase(async ({ ownerUrl, appUrl }) => {
      const migrationSet = await prepareMigrationSet();
      let owner;
      let app;
      try {
        assertDeploys(
          deploy(ownerUrl, migrationSet.schema),
          "old deploy failed",
        );
        owner = client(ownerUrl);
        await owner.$executeRawUnsafe(
          `INSERT INTO workspace (id, name, created_at, updated_at)
           VALUES ($1::uuid, 'Artifact upgrade', now(), now())`,
          WS_ID,
        );
        const first = manifest(await seedWorkspaceBinding(owner));
        const second = manifest(await seedWorkspaceBinding(owner), {
          resultSchema: "crawl4ai-fetch/v1",
          sourceDigest: SOURCE_B,
          createdAt: CREATED_B,
          expiresAt: EXPIRES_B,
        });
        await insertOldManifest(owner, first);
        await insertOldManifest(owner, second);
        const beforeRows = await storedManifests(owner);

        await addForwardMigration(migrationSet);
        assertDeploys(
          deploy(ownerUrl, migrationSet.schema),
          "forward deploy failed",
        );

        const afterRows = await storedManifests(owner);
        assert.deepEqual(afterRows, beforeRows);
        const [counts] = await owner.$queryRawUnsafe(`
          SELECT
            (SELECT count(*)::int FROM generic_operation_artifact) AS manifests,
            (SELECT count(*)::int FROM generic_operation_artifact_object)
              AS objects
        `);
        assert.deepEqual(counts, { manifests: 2, objects: 1 });
        const constraints = await owner.$queryRawUnsafe(`
          SELECT conname, contype, convalidated FROM pg_constraint
          WHERE conname IN (
            'generic_operation_artifact_scope_operation_key',
            'generic_operation_artifact_scope_digest_schema_key',
            'generic_operation_artifact_object_metadata_fkey',
            'generic_operation_artifact_object_metadata_key'
          ) ORDER BY conname
        `);
        assert.deepEqual(
          constraints.map(({ conname }) => conname),
          [
            "generic_operation_artifact_object_metadata_fkey",
            "generic_operation_artifact_object_metadata_key",
            "generic_operation_artifact_scope_operation_key",
          ],
        );
        assert.ok(constraints.every(({ convalidated }) => convalidated));
        const objectColumns = await owner.$queryRawUnsafe(`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema='public'
            AND table_name='generic_operation_artifact_object'
          ORDER BY ordinal_position
        `);
        assert.deepEqual(
          objectColumns.map(({ column_name }) => column_name),
          [
            "sha256",
            "object_key",
            "size_bytes",
            "media_type",
            "privacy_class",
            "created_at",
          ],
        );

        app = client(appUrl);
        const [firstRead, secondRead] = await Promise.all([
          readByOperation(app, first),
          readByOperation(app, second),
        ]);
        assert.deepEqual(
          firstRead.map(({ artifact_id }) => artifact_id),
          [first.artifactId],
        );
        assert.deepEqual(
          secondRead.map(({ artifact_id }) => artifact_id),
          [second.artifactId],
        );
        assert.deepEqual(
          await readByOperation(app, {
            ...second,
            authorityId: first.authorityId,
          }),
          [],
        );
        const [firstReplay, secondReplay] = await Promise.all([
          replay(app, first),
          replay(app, second),
        ]);
        assert.equal(firstReplay[0].replay, true);
        assert.equal(secondReplay[0].replay, true);
        for (const physicalConflict of [
          { sizeBytes: first.sizeBytes + 1n },
          { mediaType: "application/json" },
          { privacyClass: "PERSONAL_DATA" },
        ]) {
          const conflicting = manifest(await seedWorkspaceBinding(owner), {
            ...physicalConflict,
          });
          await assert.rejects(
            () => replay(app, conflicting),
            /GENERIC_OPERATION_ARTIFACT_INVALID/,
          );
        }
      } finally {
        await Promise.allSettled([app?.$disconnect(), owner?.$disconnect()]);
        await rm(migrationSet.root, { recursive: true, force: true });
      }
    });
  });

  it("rolls back every forward DDL change when old object metadata conflicts", async () => {
    await withTemporaryDatabase(async ({ ownerUrl }) => {
      const migrationSet = await prepareMigrationSet();
      let owner;
      try {
        assertDeploys(
          deploy(ownerUrl, migrationSet.schema),
          "old deploy failed",
        );
        owner = client(ownerUrl);
        await owner.$executeRawUnsafe(
          `INSERT INTO workspace (id, name, created_at, updated_at)
           VALUES ($1::uuid, 'Artifact conflict', now(), now())`,
          WS_ID,
        );
        const first = manifest(await seedWorkspaceBinding(owner));
        const conflicting = manifest(await seedWorkspaceBinding(owner), {
          resultSchema: "crawl4ai-fetch/v1",
          sizeBytes: first.sizeBytes + 1n,
        });
        await insertOldManifest(owner, first);
        await insertOldManifest(owner, conflicting);

        await addForwardMigration(migrationSet);
        const failed = deploy(ownerUrl, migrationSet.schema);
        assert.notEqual(
          failed.status,
          0,
          `conflicting old metadata must fail\n${failed.stdout}\n${failed.stderr}`,
        );

        const [state] = await owner.$queryRawUnsafe(`
          SELECT
            to_regclass('public.generic_operation_artifact_object')::text
              AS object_table,
            to_regclass(
              'public.generic_operation_artifact_scope_digest_schema_idx'
            )::text AS replacement_index,
            EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conname=
                'generic_operation_artifact_scope_digest_schema_key'
            ) AS old_digest_constraint,
            EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conname='generic_operation_artifact_object_metadata_fkey'
            ) AS new_object_fkey
        `);
        assert.deepEqual(state, {
          object_table: null,
          replacement_index: null,
          old_digest_constraint: true,
          new_object_fkey: false,
        });
        assert.equal((await storedManifests(owner)).length, 2);
      } finally {
        await owner?.$disconnect();
        await rm(migrationSet.root, { recursive: true, force: true });
      }
    });
  });
});
