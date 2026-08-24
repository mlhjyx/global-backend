import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { PrismaClient } from '@prisma/client';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OWNER_URL = process.env.DATABASE_URL;
const APP_URL = process.env.APP_DATABASE_URL;
const WS_A = '00000000-0000-4000-8000-0000000000a1';
const WS_B = '00000000-0000-4000-8000-0000000000b2';
const SUBJECT_ID = '00000000-0000-4000-8000-0000000000c3';
const CREATED_AT = new Date('2036-08-24T01:02:03.004Z');
const EXPIRES_AT = new Date('2036-08-25T01:02:03.004Z');

function requireDatabaseUrl(name, value) {
  assert.ok(value, `${name} is required`);
  const parsed = new URL(value);
  assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol));
  return value;
}

function client(url) {
  return new PrismaClient({ datasources: { db: { url } } });
}

function objectKey(sha256) {
  return `generic-operation-results/v1/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

function digest() {
  return randomUUID().replaceAll('-', '').repeat(2);
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
      'execution-budget-grant/v1', 'contact.verify', 'contact_point', $6, $7,
      'USD', 'microusd', 5000000, 1,
      statement_timestamp() - interval '10 seconds',
      statement_timestamp() - interval '5 seconds',
      statement_timestamp() + interval '230 seconds', statement_timestamp()
    )`,
    authorityId,
    workspaceId,
    `https://subject-${randomUUID()}.example.test`,
    randomUUID(),
    digest(),
    `contact-point-${randomUUID()}`,
    digest(),
  );
  await owner.$executeRawUnsafe(
    `INSERT INTO tool_budget_account (
      id, scope_key, account_key, generation, cap_cents, reserved_cents,
      charged_cents, exhausted, ref_count, authority_id,
      authorized_cap_microusd, created_at, updated_at
    ) VALUES (
      $1::uuid, $2, $3, 1, 100, 10, 0, false, 1, $4::uuid,
      5000000, statement_timestamp(), statement_timestamp()
    )`,
    accountId,
    workspaceId,
    `subject-account-${randomUUID()}`,
    authorityId,
  );
  await owner.$executeRawUnsafe(
    `INSERT INTO tool_budget_operation (
      id, scope_key, account_id, generation, operation_key,
      reserved_cents, status, created_at
    ) VALUES ($1::uuid, $2, $3::uuid, 1, $4, 10, 'RESERVED', now())`,
    operationId,
    workspaceId,
    accountId,
    `subject-operation-${randomUUID()}`,
  );
  return { workspaceId, authorityId, operationId };
}

function artifactInput(binding, privacyClass, subjectRef = null) {
  const sha256 = digest();
  return {
    ...binding,
    artifactId: randomUUID(),
    resultSchema: 'http-get/v1',
    objectKey: objectKey(sha256),
    sha256,
    sizeBytes: 1024n,
    mediaType: 'text/html',
    privacyClass,
    sourceDigest: null,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    subjectRef,
  };
}

async function appendWorkspaceV3(transaction, input) {
  return transaction.$queryRawUnsafe(
    `SELECT * FROM append_workspace_generic_operation_artifact_v3(
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
      $8::bigint, $9, $10, $11, $12::timestamptz, $13::timestamptz,
      $14::smallint, $15::boolean, $16, $17, $18, $19::boolean,
      $20, $21::uuid
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
    200,
    true,
    'https://example.com/final',
    null,
    null,
    null,
    input.subjectRef?.subjectType ?? null,
    input.subjectRef?.subjectId ?? null,
  );
}

async function findBySubject(transaction, workspaceId, subjectType, subjectId) {
  return transaction.$queryRawUnsafe(
    `SELECT * FROM find_workspace_generic_operation_artifacts_by_subject_v1(
      $1::uuid, $2, $3::uuid
    )`,
    workspaceId,
    subjectType,
    subjectId,
  );
}

async function findExact(transaction, input) {
  return transaction.$queryRawUnsafe(
    `SELECT * FROM find_exact_workspace_generic_operation_artifact_v2(
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6,
      $7::bigint, $8, $9::timestamptz
    )`,
    input.workspaceId,
    input.artifactId,
    input.authorityId,
    input.operationId,
    input.resultSchema,
    input.sha256,
    input.sizeBytes,
    input.mediaType,
    input.expiresAt,
  );
}

describe('generic operation PERSONAL_DATA subject index and DSR tombstone RLS', () => {
  let owner;
  let app;
  let personalA;
  let personalB;
  let nonPersonalA;
  let deletionRequestId;

  before(async () => {
    owner = client(requireDatabaseUrl('DATABASE_URL', OWNER_URL));
    app = client(requireDatabaseUrl('APP_DATABASE_URL', APP_URL));
    const deployment = spawnSync(
      'pnpm',
      ['--filter', '@global/db', 'exec', 'prisma', 'migrate', 'deploy'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: OWNER_URL },
      },
    );
    assert.equal(
      deployment.status,
      0,
      `fresh migrations must deploy\n${deployment.stdout}\n${deployment.stderr}`,
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO workspace (id, name, created_at, updated_at) VALUES
       ($1::uuid, 'Subject WS A', now(), now()),
       ($2::uuid, 'Subject WS B', now(), now())`,
      WS_A,
      WS_B,
    );

    const bindingA = await seedWorkspaceBinding(owner, WS_A);
    const bindingB = await seedWorkspaceBinding(owner, WS_B);
    const nonPersonalBinding = await seedWorkspaceBinding(owner, WS_A);
    personalA = artifactInput(bindingA, 'PERSONAL_DATA', {
      subjectType: 'contact', subjectId: SUBJECT_ID,
    });
    personalB = artifactInput(bindingB, 'PERSONAL_DATA', {
      subjectType: 'contact', subjectId: SUBJECT_ID,
    });
    nonPersonalA = artifactInput(nonPersonalBinding, 'CONFIDENTIAL_TENANT');

    await withWorkspace(app, WS_A, (tx) => appendWorkspaceV3(tx, personalA));
    await withWorkspace(app, WS_B, (tx) => appendWorkspaceV3(tx, personalB));
    await withWorkspace(app, WS_A, (tx) => appendWorkspaceV3(tx, nonPersonalA));
    deletionRequestId = randomUUID();
    await owner.$executeRawUnsafe(
      `INSERT INTO deletion_request (
        id, workspace_id, subject_type, subject_id, status, requested_by,
        reason, created_at, updated_at
      ) VALUES ($1::uuid, $2::uuid, 'contact', $3::uuid, 'RECEIVED',
        'subject-test', 'erasure', now(), now())`,
      deletionRequestId,
      WS_A,
      SUBJECT_ID,
    );
  });

  after(async () => {
    await Promise.allSettled([app?.$disconnect(), owner?.$disconnect()]);
  });

  it('creates two FORCE RLS append-only relations with no body or identity fields', async () => {
    const relations = await owner.$queryRawUnsafe(`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname IN (
        'generic_operation_artifact_subject',
        'generic_operation_artifact_subject_tombstone'
      ) ORDER BY relname
    `);
    assert.deepEqual(relations, [
      {
        relname: 'generic_operation_artifact_subject',
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      {
        relname: 'generic_operation_artifact_subject_tombstone',
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
    ]);
    const forbiddenColumns = await owner.$queryRawUnsafe(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN (
        'generic_operation_artifact_subject',
        'generic_operation_artifact_subject_tombstone'
      ) AND column_name IN (
        'body', 'email', 'name', 'prompt', 'credential', 'credentials'
      )
    `);
    assert.deepEqual(forbiddenColumns, []);
  });

  it('indexes only PERSONAL_DATA by exact workspace and subject', async () => {
    const exactA = await withWorkspace(app, WS_A, (tx) =>
      findBySubject(tx, WS_A, 'contact', SUBJECT_ID));
    assert.deepEqual(exactA.map((row) => row.artifact_id), [personalA.artifactId]);
    const wrongType = await withWorkspace(app, WS_A, (tx) =>
      findBySubject(tx, WS_A, 'company', SUBJECT_ID));
    assert.deepEqual(wrongType, []);
    const crossWorkspace = await withWorkspace(app, WS_B, (tx) =>
      findBySubject(tx, WS_A, 'contact', SUBJECT_ID));
    assert.deepEqual(crossWorkspace, []);
    const [{ count }] = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS count FROM generic_operation_artifact_subject
       WHERE artifact_id=$1::uuid`,
      nonPersonalA.artifactId,
    );
    assert.equal(count, 0);
  });

  it('tombstones the exact DSR subject, denies raw lookup and preserves other scope/data', async () => {
    const [tombstone] = await withWorkspace(app, WS_A, (tx) =>
      tx.$queryRawUnsafe(
        `SELECT * FROM tombstone_workspace_generic_operation_artifact_subject_v1(
          $1::uuid, $2, $3::uuid, $4::uuid
        )`,
        WS_A,
        'contact',
        SUBJECT_ID,
        deletionRequestId,
      ));
    assert.equal(tombstone.artifact_count, 1);
    assert.equal(tombstone.replay, false);
    assert.deepEqual(await withWorkspace(app, WS_A, (tx) => findExact(tx, personalA)), []);
    assert.equal((await withWorkspace(app, WS_B, (tx) => findExact(tx, personalB))).length, 1);
    assert.equal((await withWorkspace(app, WS_A, (tx) => findExact(tx, nonPersonalA))).length, 1);
  });

  it('prevents PERSONAL_DATA rematerialization for the tombstoned subject', async () => {
    const binding = await seedWorkspaceBinding(owner, WS_A);
    const replacement = artifactInput(binding, 'PERSONAL_DATA', {
      subjectType: 'contact', subjectId: SUBJECT_ID,
    });
    await rejectsSql(
      () => withWorkspace(app, WS_A, (tx) => appendWorkspaceV3(tx, replacement)),
      'GENERIC_OPERATION_ARTIFACT_SUBJECT_TOMBSTONED',
    );
    const [{ count }] = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS count FROM generic_operation_artifact
       WHERE artifact_id=$1::uuid`,
      replacement.artifactId,
    ).catch(async () => owner.$queryRawUnsafe(
      `SELECT count(*)::int AS count FROM generic_operation_artifact
       WHERE id=$1::uuid`,
      replacement.artifactId,
    ));
    assert.equal(count, 0);
  });

  it('rejects missing subjects for personal data and subjects for non-personal data', async () => {
    const personal = artifactInput(await seedWorkspaceBinding(owner, WS_A), 'PERSONAL_DATA');
    const nonPersonal = artifactInput(
      await seedWorkspaceBinding(owner, WS_A),
      'CONFIDENTIAL_TENANT',
      { subjectType: 'company', subjectId: SUBJECT_ID },
    );
    await rejectsSql(
      () => withWorkspace(app, WS_A, (tx) => appendWorkspaceV3(tx, personal)),
      'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID',
    );
    await rejectsSql(
      () => withWorkspace(app, WS_A, (tx) => appendWorkspaceV3(tx, nonPersonal)),
      'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID',
    );
  });

  it('denies direct mutation and conflicting tombstone provenance', async () => {
    await rejectsSql(
      () => withWorkspace(app, WS_A, (tx) => tx.$executeRawUnsafe(
        `DELETE FROM generic_operation_artifact_subject WHERE workspace_id=$1::uuid`,
        WS_A,
      )),
      'permission denied',
    );
    const conflictingRequestId = randomUUID();
    await owner.$executeRawUnsafe(
      `INSERT INTO deletion_request (
        id, workspace_id, subject_type, subject_id, status, requested_by,
        reason, created_at, updated_at
      ) VALUES ($1::uuid, $2::uuid, 'contact', $3::uuid, 'RECEIVED',
        'subject-test-conflict', 'erasure', now(), now())`,
      conflictingRequestId,
      WS_A,
      SUBJECT_ID,
    );
    await rejectsSql(
      () => withWorkspace(app, WS_A, (tx) => tx.$queryRawUnsafe(
        `SELECT * FROM tombstone_workspace_generic_operation_artifact_subject_v1(
          $1::uuid, $2, $3::uuid, $4::uuid
        )`,
        WS_A,
        'contact',
        SUBJECT_ID,
        conflictingRequestId,
      )),
      'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID',
    );
  });
});
