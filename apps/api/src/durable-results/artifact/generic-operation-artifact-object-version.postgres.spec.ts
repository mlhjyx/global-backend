import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * Explicitly opted-in, disposable and migrated PostgreSQL only. The owner
 * connection (a superuser, which bypasses RLS) plants the fixtures and reads the
 * ledger; every settlement and cleanup call runs as app_user inside a workspace
 * transaction, exactly as the budget store and the cleanup activity do.
 */
const ownerUrl = process.env.ARTIFACT_OBJECT_VERSION_TEST_DATABASE_URL;
const appUrl = process.env.ARTIFACT_OBJECT_VERSION_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) {
  throw new Error(
    'artifact object version test needs both ARTIFACT_OBJECT_VERSION_TEST_DATABASE_URL and ARTIFACT_OBJECT_VERSION_TEST_APP_DATABASE_URL',
  );
}
for (const value of [ownerUrl, appUrl]) {
  if (!value) continue;
  const url = new URL(value);
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !url.pathname.endsWith('_test') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('artifact object version test requires a loopback *_test database');
  }
}

const CREATED_AT = new Date('2036-10-13T16:36:09.000Z');
const EXPIRES_AT = new Date('2036-10-14T16:36:09.000Z');

function digest(): string {
  return randomUUID().replaceAll('-', '').repeat(2);
}

function objectKey(sha256: string): string {
  return `generic-operation-results/v1/final/personal-data/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

/** The SQLSTATE and message PostgreSQL raised through a Prisma raw query, or null. */
function raised(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2010') return null;
  const meta = error.meta as { code?: unknown; message?: unknown } | undefined;
  return typeof meta?.message === 'string' ? meta.message : null;
}

interface Binding {
  readonly workspaceId: string;
  readonly authorityId: string;
  readonly operationId: string;
}

interface ArtifactFixture extends Binding {
  readonly artifactId: string;
  readonly sha256: string;
  readonly subjectId: string;
}

describe.runIf(Boolean(ownerUrl && appUrl))(
  'generic operation artifact object versions on PostgreSQL as app_user',
  { timeout: 90_000 },
  () => {
    // Created only when the suite runs: collecting a skipped suite still executes this body.
    let owner: PrismaClient;
    let app: PrismaClient;
    const workspaceId = randomUUID();
    const companyId = randomUUID();
    const subjectId = randomUUID();
    const sha256 = digest();

    async function withWorkspace<T>(
      run: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> {
      return app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
        return run(tx);
      });
    }

    /** One reserved budget operation under a consumed workspace Grant, as the budget store leaves it. */
    async function seedBinding(): Promise<Binding> {
      const authorityId = randomUUID();
      const accountId = randomUUID();
      const operationId = randomUUID();
      await owner.$executeRaw`
        INSERT INTO execution_budget_authority (
          id, scope_key, authority_kind, workspace_id, issuer, audience, jti,
          token_sha256, schema_version, purpose, subject_type, subject_id,
          request_sha256, currency, unit, cap_microusd, runs_consumed,
          issued_at, not_before, expires_at, consumed_at
        ) VALUES (
          ${authorityId}::uuid, ${workspaceId}, 'WORKSPACE_GRANT', ${workspaceId}::uuid,
          ${`https://subject-${randomUUID()}.example.test`},
          'global-backend:execution-budget', ${randomUUID()}::uuid, ${digest()},
          'execution-budget-grant/v1', 'contact.verify', 'contact_point',
          ${`contact-point-${randomUUID()}`}, ${digest()},
          'USD', 'microusd', 5000000, 1,
          statement_timestamp() - interval '10 seconds',
          statement_timestamp() - interval '5 seconds',
          statement_timestamp() + interval '230 seconds', statement_timestamp()
        )`;
      await owner.$executeRaw`
        INSERT INTO tool_budget_account (
          id, scope_key, account_key, generation, cap_cents, reserved_cents,
          charged_cents, reserved_microusd, charged_microusd,
          exhausted, ref_count, authority_id,
          authorized_cap_microusd, created_at, updated_at
        ) VALUES (
          ${accountId}::uuid, ${workspaceId}, ${`account-${randomUUID()}`}, 1, 0, 0, 0, 10, 0,
          false, 1, ${authorityId}::uuid, 5000000, statement_timestamp(), statement_timestamp()
        )`;
      await owner.$executeRaw`
        INSERT INTO tool_budget_operation (
          id, scope_key, account_id, generation, operation_key,
          amount_unit, reserved_cents, reserved_microusd, status, created_at
        ) VALUES (
          ${operationId}::uuid, ${workspaceId}, ${accountId}::uuid, 1, ${`operation-${randomUUID()}`},
          'microusd', 0, 10, 'RESERVED', now()
        )`;
      // The generation-reset trigger zeroes the microusd counters on account insert.
      await owner.$executeRaw`
        UPDATE tool_budget_account
        SET reserved_microusd = 10, updated_at = statement_timestamp()
        WHERE id = ${accountId}::uuid AND scope_key = ${workspaceId}`;
      return { workspaceId, authorityId, operationId };
    }

    function manifest(fixture: ArtifactFixture): string {
      return JSON.stringify({
        schemaVersion: 'generic-operation-artifact/v1',
        artifactId: fixture.artifactId,
        scopeKind: 'workspace',
        workspaceId: fixture.workspaceId,
        authorityId: fixture.authorityId,
        operationId: fixture.operationId,
        resultSchema: 'http-get/v1',
        objectKey: objectKey(fixture.sha256),
        sha256: fixture.sha256,
        sizeBytes: '1024',
        mediaType: 'text/html',
        privacyClass: 'PERSONAL_DATA',
        sourceDigest: null,
        createdAt: CREATED_AT.toISOString(),
        expiresAt: EXPIRES_AT.toISOString(),
      });
    }

    /** Exactly the statement PostgresBudgetStore.settleArtifactManifest issues. */
    function settle(
      tx: Prisma.TransactionClient,
      version: 'v3' | 'v4',
      fixture: ArtifactFixture,
      objectVersionId: string,
    ): Promise<unknown> {
      const call =
        version === 'v4'
          ? Prisma.sql`SELECT * FROM settle_tool_budget_artifact_manifest_with_receipt_v4(`
          : Prisma.sql`SELECT * FROM settle_tool_budget_artifact_manifest_with_receipt_v3(`;
      return tx.$queryRaw(Prisma.sql`${call}
        ${fixture.workspaceId}, ${fixture.operationId}::uuid,
        ${10n}, ${manifest(fixture)}::jsonb,
        ${200}::smallint, ${true},
        ${'https://example.com/final'}, ${null}, ${null}, ${null},
        ${JSON.stringify({ currency: 'USD', unit: 'microusd', callCount: 1, upperBoundMicrousd: '10' })}::jsonb,
        ${'estimated_upper_bound'}, ${'contact'}, ${fixture.subjectId}::uuid,
        ${objectVersionId}
      )`);
    }

    async function settledFixture(): Promise<ArtifactFixture> {
      return { ...(await seedBinding()), artifactId: randomUUID(), sha256, subjectId };
    }

    async function pinnedVersion(): Promise<string | null> {
      const rows = await owner.$queryRaw<{ object_version_id: string | null }[]>`
        SELECT object_version_id FROM generic_operation_artifact_object
        WHERE sha256 = ${sha256} AND privacy_class = 'PERSONAL_DATA'`;
      return rows[0]?.object_version_id ?? null;
    }

    async function ledger(): Promise<string[]> {
      const rows = await owner.$queryRaw<{ object_version_id: string }[]>`
        SELECT object_version_id FROM generic_operation_artifact_object_version
        WHERE sha256 = ${sha256} AND privacy_class = 'PERSONAL_DATA'
        ORDER BY first_settled_at, object_version_id`;
      return rows.map((row) => row.object_version_id);
    }

    beforeAll(async () => {
      owner = new PrismaClient({ datasourceUrl: ownerUrl });
      app = new PrismaClient({ datasourceUrl: appUrl });
      const [principal] = await app.$queryRaw<{ session: string; superuser: string; bypass: boolean }[]>`
        SELECT session_user::text AS session, current_setting('is_superuser') AS superuser,
               (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`;
      if (principal?.session !== 'app_user' || principal.superuser !== 'off' || principal.bypass !== false) {
        throw new Error('ARTIFACT_OBJECT_VERSION_TEST_APP_DATABASE_URL must log in as app_user, which RLS binds');
      }
      await owner.$executeRaw`
        INSERT INTO workspace (id, name, created_at, updated_at)
        VALUES (${workspaceId}::uuid, 'Artifact version ledger WS', now(), now())`;
      await owner.$executeRaw`
        INSERT INTO canonical_company (id, workspace_id, name, dedupe_key, created_at, updated_at)
        VALUES (${companyId}::uuid, ${workspaceId}::uuid, 'Ledger Company', ${`ledger-company-${workspaceId}`}, now(), now())`;
      await owner.$executeRaw`
        INSERT INTO canonical_contact (id, workspace_id, company_id, full_name, dedupe_key, created_at)
        VALUES (${subjectId}::uuid, ${workspaceId}::uuid, ${companyId}::uuid, 'Ledger Subject', ${`ledger-subject-${subjectId}`}, now())`;
    });

    afterAll(async () => {
      await Promise.all([owner?.$disconnect(), app?.$disconnect()]);
    });

    it('settlement v4 pins the version it verified and records every version in the ledger', async () => {
      const first = await settledFixture();
      await withWorkspace((tx) => settle(tx, 'v4', first, 'version-first-write'));
      expect(await pinnedVersion()).toBe('version-first-write');
      expect(await ledger()).toEqual(['version-first-write']);

      // A reuse that refreshed the object: a different current version for the same bytes.
      const refreshed = await settledFixture();
      await withWorkspace((tx) => settle(tx, 'v4', refreshed, 'version-refreshed-copy'));
      expect(await pinnedVersion()).toBe('version-refreshed-copy');
      expect(await ledger()).toEqual(['version-first-write', 'version-refreshed-copy']);

      // A settlement whose version is already known (concurrent order) only moves the pin.
      const concurrent = await settledFixture();
      await withWorkspace((tx) => settle(tx, 'v4', concurrent, 'version-first-write'));
      expect(await pinnedVersion()).toBe('version-first-write');
      expect(await ledger()).toEqual(['version-first-write', 'version-refreshed-copy']);
    });

    it('settlement v3, which v4 replaces, still refuses a version that differs from the pin', async () => {
      const fixture = await settledFixture();
      let message: string | null = null;
      try {
        await withWorkspace((tx) => settle(tx, 'v3', fixture, 'version-unknown-to-v3'));
      } catch (error) {
        message = raised(error);
      }
      expect(message).toBe('ERROR: GENERIC_OPERATION_ARTIFACT_INVALID');
    });

    it('the version writer is not callable as app_user', async () => {
      let message: string | null = null;
      try {
        await withWorkspace((tx) =>
          tx.$queryRaw`SELECT record_generic_operation_artifact_object_version_v1(${sha256}, 'PERSONAL_DATA', 'version-direct')`,
        );
      } catch (error) {
        message = raised(error);
      }
      expect(message).toMatch(/permission denied for function record_generic_operation_artifact_object_version_v1/);
      expect(await ledger()).not.toContain('version-direct');
    });

    it('erasure enqueues one exact-version command per known version and claims each in turn', async () => {
      const deletionRequestId = randomUUID();
      await owner.$executeRaw`
        INSERT INTO deletion_request (
          id, workspace_id, subject_type, subject_id, status, requested_by, reason, created_at, updated_at
        ) VALUES (${deletionRequestId}::uuid, ${workspaceId}::uuid, 'contact', ${subjectId}::uuid,
          'RECEIVED', 'ledger-test', 'erasure', now(), now())`;
      const tombstone = await withWorkspace((tx) =>
        tx.$queryRaw<{ artifact_count: number; replay: boolean }[]>`
          SELECT artifact_count, replay FROM tombstone_workspace_generic_operation_artifact_subject_v1(
            ${workspaceId}::uuid, 'contact', ${subjectId}::uuid, ${deletionRequestId}::uuid)`,
      );
      expect(tombstone[0]).toMatchObject({ artifact_count: 3, replay: false });

      const enqueued = await withWorkspace((tx) =>
        tx.$queryRaw<{ command_count: number; shared_hold_count: number; version_hold_count: number }[]>`
          SELECT * FROM enqueue_workspace_personal_artifact_cleanup_v1(
            ${workspaceId}::uuid, ${deletionRequestId}::uuid)`,
      );
      expect(enqueued[0]).toEqual({ command_count: 2, shared_hold_count: 0, version_hold_count: 0 });
      const commands = await owner.$queryRaw<{ object_version_id: string; status: string }[]>`
        SELECT object_version_id, status FROM personal_artifact_cleanup_command
        WHERE deletion_request_id = ${deletionRequestId}::uuid ORDER BY object_version_id`;
      expect(commands).toEqual([
        { object_version_id: 'version-first-write', status: 'PENDING' },
        { object_version_id: 'version-refreshed-copy', status: 'PENDING' },
      ]);

      // The workflow claims and completes one command per activity call until none is left.
      const claimed: string[] = [];
      for (let round = 0; round < 2; round += 1) {
        const [command] = await withWorkspace((tx) =>
          tx.$queryRaw<{ command_id: string; object_version_id: string; attempt: number; status: string }[]>`
            SELECT command_id, object_version_id, attempt, status
            FROM claim_workspace_personal_artifact_cleanup_v1(${workspaceId}::uuid, ${deletionRequestId}::uuid)`,
        );
        expect(command?.status).toBe('CLAIMED');
        claimed.push(command!.object_version_id);
        const [completed] = await withWorkspace((tx) =>
          tx.$queryRaw<{ status: string; object_status: string }[]>`
            SELECT status, object_status FROM complete_workspace_personal_artifact_cleanup_v1(
              ${workspaceId}::uuid, ${command!.command_id}::uuid, ${command!.attempt}::integer, 'DELETED')`,
        );
        expect(completed).toEqual({ status: 'COMPLETED', object_status: 'DELETED' });
      }
      expect(claimed.sort()).toEqual(['version-first-write', 'version-refreshed-copy']);

      const [replay] = await withWorkspace((tx) =>
        tx.$queryRaw<{ status: string }[]>`
          SELECT status FROM claim_workspace_personal_artifact_cleanup_v1(${workspaceId}::uuid, ${deletionRequestId}::uuid)`,
      );
      expect(replay?.status).toBe('COMPLETED');
    });
  },
);
