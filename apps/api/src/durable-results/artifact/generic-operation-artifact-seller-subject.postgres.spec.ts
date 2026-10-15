import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArtifactSubjectBindingContract } from './artifact-subject-binding.contract';
import { GenericOperationArtifactSubjectRepository } from './generic-operation-artifact-subject.repository';

/*
 * The seller company_profile as a PERSONAL_DATA artifact subject kind (option A, 2026-10-14), on a
 * migrated PostgreSQL. Explicitly opted-in, disposable databases only. The owner connection (a
 * superuser, which bypasses RLS) plants fixtures and reads the catalog; every subject lookup,
 * settlement, tombstone and cleanup call runs as app_user inside a workspace transaction, exactly
 * as the artifact execution port, the budget store and the cleanup activity do.
 */
const ownerUrl = process.env.ARTIFACT_SELLER_SUBJECT_TEST_DATABASE_URL;
const appUrl = process.env.ARTIFACT_SELLER_SUBJECT_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) {
  throw new Error(
    'artifact seller subject test needs both ARTIFACT_SELLER_SUBJECT_TEST_DATABASE_URL and ARTIFACT_SELLER_SUBJECT_TEST_APP_DATABASE_URL',
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
    throw new Error('artifact seller subject test requires a loopback *_test database');
  }
}

const CREATED_AT = new Date('2036-10-14T16:36:09.000Z');
const EXPIRES_AT = new Date('2036-10-15T16:36:09.000Z');

/**
 * Every routine whose subject-kind list option A widened (migration 20261014120000), as the
 * catalog names it: PostgreSQL keeps the first 63 bytes of an identifier, so the execution hold
 * reader is stored as `…_execution_hol`.
 */
const WIDENED_ROUTINES = [
  'assert_workspace_generic_operation_artifact_subject_v1',
  'bind_workspace_generic_operation_artifact_subject_v1',
  'find_workspace_generic_operation_artifacts_by_subject_v1',
  'tombstone_workspace_generic_operation_artifact_subject_v1',
  'find_workspace_generic_operation_artifact_subject_execution_hold_v1',
  'enforce_tool_budget_expected_artifact_subject_v1',
  'mark_tool_budget_result_unknown_v4',
  'load_tool_budget_result_unknown_artifact_v4',
  'append_workspace_generic_operation_artifact_v3',
  'settle_tool_budget_artifact_manifest_v4',
  'settle_tool_budget_artifact_manifest_with_receipt_v2',
].map((name) => name.slice(0, 63));
/** The grants the replaced routines carried before option A, unchanged by it. */
const APP_CALLABLE = new Set<string>([
  'append_workspace_generic_operation_artifact_v3',
  'bind_workspace_generic_operation_artifact_subject_v1',
  'find_workspace_generic_operation_artifact_subject_execution_hold_v1'.slice(0, 63),
  'find_workspace_generic_operation_artifacts_by_subject_v1',
  'settle_tool_budget_artifact_manifest_with_receipt_v2',
  'tombstone_workspace_generic_operation_artifact_subject_v1',
]);
const PLATFORM_WRITER_CALLABLE = new Set<string>(['settle_tool_budget_artifact_manifest_with_receipt_v2']);
const SUBJECT_KIND_CHECKS = [
  'tool_budget_operation_expected_artifact_subject_check',
  'generic_operation_artifact_subject_type_check',
  'generic_operation_artifact_subject_tombstone_type_check',
  'generic_operation_artifact_subject_tombstone_audit_type_check',
] as const;

function digest(): string {
  return randomUUID().replaceAll('-', '').repeat(2);
}

function objectKey(sha256: string): string {
  return `generic-operation-results/v1/final/personal-data/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

/** The message PostgreSQL raised through a Prisma raw query, or null. */
function raised(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2010') return null;
  const meta = error.meta as { message?: unknown } | undefined;
  return typeof meta?.message === 'string' ? meta.message : null;
}

/** The outcome of a statement: 'ok' or the error PostgreSQL raised. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (error) {
    return raised(error) ?? (error instanceof Error ? error.message : String(error));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Binding {
  readonly workspaceId: string;
  readonly authorityId: string;
  readonly operationId: string;
}

interface ArtifactFixture extends Binding {
  readonly artifactId: string;
  readonly sha256: string;
  readonly subjectType: string;
  readonly subjectId: string;
}

describe.runIf(Boolean(ownerUrl && appUrl))(
  'seller company_profile artifact subject on PostgreSQL as app_user',
  { timeout: 120_000 },
  () => {
    // Created only when the suite runs: collecting a skipped suite still executes this body.
    let owner: PrismaClient;
    let app: PrismaClient;
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const profileA = randomUUID();
    const profileB = randomUUID();
    const companyA = randomUUID();
    const repository = new GenericOperationArtifactSubjectRepository();

    async function withWorkspace<T>(
      workspaceId: string,
      run: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> {
      return app.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
          return run(tx);
        },
        { timeout: 60_000, maxWait: 30_000 },
      );
    }

    async function seedProfile(workspaceId: string, id: string, name: string): Promise<void> {
      await owner.$executeRaw`
        INSERT INTO company_profile (id, workspace_id, name, status, created_at, updated_at)
        VALUES (${id}::uuid, ${workspaceId}::uuid, ${name}, 'ENRICHING', now(), now())`;
    }

    /** One reserved budget operation under a consumed workspace Grant, as the budget store leaves it. */
    async function seedBinding(workspaceId: string): Promise<Binding> {
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

    async function fixture(
      workspaceId: string,
      subjectType: string,
      subjectId: string,
    ): Promise<ArtifactFixture> {
      return { ...(await seedBinding(workspaceId)), artifactId: randomUUID(), sha256: digest(), subjectType, subjectId };
    }

    /** The understanding homepage crawl's manifest: crawl4ai-fetch/v1, PERSONAL_DATA. */
    function manifest(artifact: ArtifactFixture): string {
      return JSON.stringify({
        schemaVersion: 'generic-operation-artifact/v1',
        artifactId: artifact.artifactId,
        scopeKind: 'workspace',
        workspaceId: artifact.workspaceId,
        authorityId: artifact.authorityId,
        operationId: artifact.operationId,
        resultSchema: 'crawl4ai-fetch/v1',
        objectKey: objectKey(artifact.sha256),
        sha256: artifact.sha256,
        sizeBytes: '1024',
        mediaType: 'text/markdown',
        privacyClass: 'PERSONAL_DATA',
        sourceDigest: null,
        createdAt: CREATED_AT.toISOString(),
        expiresAt: EXPIRES_AT.toISOString(),
      });
    }

    /** Exactly the statement PostgresBudgetStore.settleArtifactManifest issues for a crawl4ai fetch. */
    function settle(tx: Prisma.TransactionClient, artifact: ArtifactFixture): Promise<unknown> {
      return tx.$queryRaw`SELECT * FROM settle_tool_budget_artifact_manifest_with_receipt_v4(
        ${artifact.workspaceId}, ${artifact.operationId}::uuid,
        ${10n}, ${manifest(artifact)}::jsonb,
        ${null}::smallint, ${null}::boolean,
        ${'https://acme.example/'}, ${'0123456789abcdef01234567'}, ${null}, ${null}::boolean,
        ${JSON.stringify({ currency: 'USD', unit: 'microusd', callCount: 1, upperBoundMicrousd: '10' })}::jsonb,
        ${'estimated_upper_bound'}, ${artifact.subjectType}, ${artifact.subjectId}::uuid,
        ${`version-${artifact.artifactId}`}
      )`;
    }

    async function boundArtifacts(workspaceId: string, subjectType: string, subjectId: string) {
      return withWorkspace(workspaceId, (tx) =>
        tx.$queryRaw<{ artifact_id: string; subject_type: string }[]>`
          SELECT artifact_id, subject_type FROM find_workspace_generic_operation_artifacts_by_subject_v1(
            ${workspaceId}::uuid, ${subjectType}, ${subjectId}::uuid)`,
      );
    }

    async function requestDeletion(workspaceId: string, subjectType: string, subjectId: string): Promise<string> {
      const id = randomUUID();
      await owner.$executeRaw`
        INSERT INTO deletion_request (
          id, workspace_id, subject_type, subject_id, status, requested_by, reason, created_at, updated_at
        ) VALUES (${id}::uuid, ${workspaceId}::uuid, ${subjectType}, ${subjectId}::uuid,
          'RECEIVED', 'seller-subject-test', 'manual', now(), now())`;
      return id;
    }

    beforeAll(async () => {
      owner = new PrismaClient({ datasourceUrl: ownerUrl });
      app = new PrismaClient({ datasourceUrl: appUrl });
      const [principal] = await app.$queryRaw<{ session: string; superuser: string; bypass: boolean }[]>`
        SELECT session_user::text AS session, current_setting('is_superuser') AS superuser,
               (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`;
      if (principal?.session !== 'app_user' || principal.superuser !== 'off' || principal.bypass !== false) {
        throw new Error('ARTIFACT_SELLER_SUBJECT_TEST_APP_DATABASE_URL must log in as app_user, which RLS binds');
      }
      for (const [id, name] of [[workspaceA, 'Seller subject WS A'], [workspaceB, 'Seller subject WS B']]) {
        await owner.$executeRaw`
          INSERT INTO workspace (id, name, created_at, updated_at) VALUES (${id}::uuid, ${name}, now(), now())`;
      }
      await seedProfile(workspaceA, profileA, 'Seller A');
      await seedProfile(workspaceB, profileB, 'Seller B');
      await owner.$executeRaw`
        INSERT INTO canonical_company (id, workspace_id, name, dedupe_key, created_at, updated_at)
        VALUES (${companyA}::uuid, ${workspaceA}::uuid, 'Buyer A', ${`seller-subject-buyer-${companyA}`}, now(), now())`;
    });

    afterAll(async () => {
      await Promise.all([owner?.$disconnect(), app?.$disconnect()]);
    });

    it('every subject-kind CHECK and subject routine admits company_profile, with owner, definer rights, search_path and grants kept', async () => {
      const checks = await owner.$queryRaw<{ name: string; definition: string }[]>`
        SELECT conname AS name, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conname = ANY(${[...SUBJECT_KIND_CHECKS]}::text[]) ORDER BY conname`;
      expect(checks.map(({ name }) => name)).toEqual([...SUBJECT_KIND_CHECKS].sort());
      for (const { definition } of checks) expect(definition).toContain("'company_profile'");

      const routines = await owner.$queryRaw<
        {
          name: string;
          source: string;
          definer: boolean;
          config: string[] | null;
          owner: string;
          app: boolean;
          writer: boolean;
        }[]
      >`
        SELECT p.proname::text AS name, p.prosrc AS source, p.prosecdef AS definer, p.proconfig AS config,
          pg_get_userbyid(p.proowner) AS owner,
          has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
          has_function_privilege('execution_budget_platform_writer', p.oid, 'EXECUTE') AS writer
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname::text = ANY(${WIDENED_ROUTINES}::text[])
        ORDER BY p.proname`;
      expect(routines.map(({ name }) => name)).toEqual([...WIDENED_ROUTINES].sort());
      const [reference] = await owner.$queryRaw<{ owner: string }[]>`
        SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc
        WHERE proname = 'append_workspace_generic_operation_artifact_v2'`;
      for (const routine of routines) {
        expect(routine.source, routine.name).toContain("'company_profile'");
        expect(routine.definer, routine.name).toBe(true);
        expect(routine.config, routine.name).toEqual(['search_path=pg_catalog, public, pg_temp']);
        expect(routine.owner, routine.name).toBe(reference?.owner);
        expect(routine.app, routine.name).toBe(APP_CALLABLE.has(routine.name));
        expect(routine.writer, routine.name).toBe(PLATFORM_WRITER_CALLABLE.has(routine.name));
      }

      // No routine anywhere still closes the artifact subject kinds at contact | company.
      const stale = await owner.$queryRaw<{ name: string }[]>`
        SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosrc ~ '''contact'',\\s*''company''\\s*\\)'`;
      expect(stale).toEqual([]);

      const [guard] = await owner.$queryRaw<{ definer: boolean; config: string[] | null; app: boolean }[]>`
        SELECT p.prosecdef AS definer, p.proconfig AS config,
          has_function_privilege('app_user', p.oid, 'EXECUTE') AS app
        FROM pg_proc p WHERE p.proname = 'guard_company_profile_artifact_subject_delete_v1'`;
      expect(guard).toEqual({ definer: true, config: ['search_path=pg_catalog, public, pg_temp'], app: false });
    });

    it('resolves a seller profile only in its own workspace and only under its own kind', async () => {
      const profileRef = { subjectType: 'company_profile', subjectId: profileA } as const;
      await withWorkspace(workspaceA, async (tx) => {
        await expect(
          repository.resolveExistingSubject(tx, { workspaceId: workspaceA, subjectRef: profileRef }),
        ).resolves.toEqual({ workspaceId: workspaceA, ...profileRef });
        for (const subjectRef of [
          { subjectType: 'company_profile', subjectId: profileB },
          { subjectType: 'company_profile', subjectId: randomUUID() },
          { subjectType: 'company_profile', subjectId: companyA },
          { subjectType: 'company', subjectId: profileA },
        ] as const) {
          await expect(
            repository.resolveExistingSubject(tx, { workspaceId: workspaceA, subjectRef }),
            JSON.stringify(subjectRef),
          ).resolves.toBeNull();
        }
        await expect(
          repository.findExecutionHold(tx, { workspaceId: workspaceA, subjectRef: profileRef }),
        ).resolves.toBeNull();
        await expect(
          new ArtifactSubjectBindingContract().resolveForExecution(tx, {
            resultSchema: 'crawl4ai-fetch/v1',
            scopeKind: 'workspace',
            workspaceId: workspaceA,
            subjectRef: profileRef,
          }),
        ).resolves.toEqual({ status: 'BOUND', subjectRef: profileRef });
      });
      // The guarded reader answers nothing for another workspace's session (fail closed).
      const rows = await withWorkspace(workspaceB, (tx) =>
        tx.$queryRaw<unknown[]>`
          SELECT * FROM find_workspace_generic_operation_artifact_subject_execution_hold_v1(
            ${workspaceA}::uuid, 'company_profile', ${profileA}::uuid)`,
      );
      expect(rows).toEqual([]);
    });

    it('settles a crawl bound to the seller profile, and refuses another workspace profile or an unknown id', async () => {
      const crawl = await fixture(workspaceA, 'company_profile', profileA);
      await withWorkspace(workspaceA, (tx) => settle(tx, crawl));
      expect(await boundArtifacts(workspaceA, 'company_profile', profileA)).toEqual([
        { artifact_id: crawl.artifactId, subject_type: 'company_profile' },
      ]);

      for (const subjectId of [profileB, randomUUID(), companyA]) {
        const refused = await fixture(workspaceA, 'company_profile', subjectId);
        expect(await outcome(() => withWorkspace(workspaceA, (tx) => settle(tx, refused)))).toBe(
          'ERROR: GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID',
        );
      }
      // The profile id does not resolve as a buyer company either.
      const wrongKind = await fixture(workspaceA, 'company', profileA);
      expect(await outcome(() => withWorkspace(workspaceA, (tx) => settle(tx, wrongKind)))).toBe(
        'ERROR: GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID',
      );
    });

    it('a delete that waits on a binding in flight is refused once the binding commits', async () => {
      const profile = randomUUID();
      await seedProfile(workspaceA, profile, 'Seller racing a delete');
      const crawl = await fixture(workspaceA, 'company_profile', profile);
      let markBound!: () => void;
      let releaseBinding!: () => void;
      const bound = new Promise<void>((resolve) => { markBound = resolve; });
      const gate = new Promise<void>((resolve) => { releaseBinding = resolve; });
      const binding = withWorkspace(workspaceA, async (tx) => {
        try {
          await settle(tx, crawl);
        } finally {
          markBound();
        }
        await gate;
      });
      // A settlement that fails surfaces here instead of leaving the test waiting.
      await Promise.race([bound, binding]);
      const deletion = outcome(() => owner.$executeRaw`DELETE FROM company_profile WHERE id = ${profile}::uuid`);
      await delay(500);
      releaseBinding();
      await binding;
      expect(await deletion).toBe('ERROR: GENERIC_OPERATION_ARTIFACT_SUBJECT_NOT_TOMBSTONED');
      expect(await boundArtifacts(workspaceA, 'company_profile', profile)).toHaveLength(1);
    });

    it('a binding that waits on a profile delete in flight is refused once the delete commits', async () => {
      const profile = randomUUID();
      await seedProfile(workspaceA, profile, 'Seller deleted first');
      const crawl = await fixture(workspaceA, 'company_profile', profile);
      let markDeleted!: () => void;
      let releaseDelete!: () => void;
      const deleted = new Promise<void>((resolve) => { markDeleted = resolve; });
      const gate = new Promise<void>((resolve) => { releaseDelete = resolve; });
      const deletion = owner.$transaction(
        async (tx) => {
          try {
            await tx.$executeRaw`DELETE FROM company_profile WHERE id = ${profile}::uuid`;
          } finally {
            markDeleted();
          }
          await gate;
        },
        { timeout: 60_000, maxWait: 30_000 },
      );
      await Promise.race([deleted, deletion]);
      const settlement = outcome(() => withWorkspace(workspaceA, (tx) => settle(tx, crawl)));
      await delay(500);
      releaseDelete();
      await deletion;
      expect(await settlement).toBe('ERROR: GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID');
      expect(await boundArtifacts(workspaceA, 'company_profile', profile)).toEqual([]);
    });

    it('keeps a bound seller profile until its subject is tombstoned; the tombstone holds new crawls and hands the objects to cleanup', async () => {
      // Bound by the settlement test above.
      expect(await boundArtifacts(workspaceA, 'company_profile', profileA)).toHaveLength(1);
      expect(await outcome(() => owner.$executeRaw`DELETE FROM company_profile WHERE id = ${profileA}::uuid`)).toBe(
        'ERROR: GENERIC_OPERATION_ARTIFACT_SUBJECT_NOT_TOMBSTONED',
      );
      expect(
        await outcome(() =>
          withWorkspace(workspaceA, (tx) => tx.$executeRaw`DELETE FROM company_profile WHERE id = ${profileA}::uuid`),
        ),
      ).toBe('ERROR: GENERIC_OPERATION_ARTIFACT_SUBJECT_NOT_TOMBSTONED');
      // Nor can the workspace go while any subject row names it.
      expect(await outcome(() => owner.$executeRaw`DELETE FROM workspace WHERE id = ${workspaceA}::uuid`)).not.toBe('ok');

      // A tombstone names a deletion_request for the exact subject; another kind is refused.
      const wrongKindRequest = await requestDeletion(workspaceA, 'company', profileA);
      expect(
        await outcome(() =>
          withWorkspace(workspaceA, (tx) =>
            repository.tombstoneSubject(tx, {
              workspaceId: workspaceA,
              deletionRequestId: wrongKindRequest,
              subjectRef: { subjectType: 'company_profile', subjectId: profileA },
            }),
          ),
        ),
      ).toBe('ERROR: GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID');

      const deletionRequestId = await requestDeletion(workspaceA, 'company_profile', profileA);
      const tombstone = await withWorkspace(workspaceA, (tx) =>
        repository.tombstoneSubject(tx, {
          workspaceId: workspaceA,
          deletionRequestId,
          subjectRef: { subjectType: 'company_profile', subjectId: profileA },
        }),
      );
      expect(tombstone).toMatchObject({
        workspaceId: workspaceA,
        subjectType: 'company_profile',
        subjectId: profileA,
        deletionRequestId,
        artifactCount: 1,
        replay: false,
      });

      const profileRef = { subjectType: 'company_profile', subjectId: profileA } as const;
      await withWorkspace(workspaceA, async (tx) => {
        await expect(
          repository.findExecutionHold(tx, { workspaceId: workspaceA, subjectRef: profileRef }),
        ).resolves.toBe('TOMBSTONED');
        await expect(
          new ArtifactSubjectBindingContract().resolveForExecution(tx, {
            resultSchema: 'crawl4ai-fetch/v1',
            scopeKind: 'workspace',
            workspaceId: workspaceA,
            subjectRef: profileRef,
          }),
        ).resolves.toEqual({ status: 'DENIED', reason: 'SUBJECT_TOMBSTONED' });
      });
      const late = await fixture(workspaceA, 'company_profile', profileA);
      expect(await outcome(() => withWorkspace(workspaceA, (tx) => settle(tx, late)))).toBe(
        'ERROR: GENERIC_OPERATION_ARTIFACT_SUBJECT_TOMBSTONED',
      );

      const [enqueued] = await withWorkspace(workspaceA, (tx) =>
        tx.$queryRaw<{ command_count: number; shared_hold_count: number; version_hold_count: number }[]>`
          SELECT * FROM enqueue_workspace_personal_artifact_cleanup_v1(${workspaceA}::uuid, ${deletionRequestId}::uuid)`,
      );
      expect(enqueued).toEqual({ command_count: 1, shared_hold_count: 0, version_hold_count: 0 });

      // Tombstoned: the profile may now be deleted, and its binding stays as the audit trail.
      await expect(owner.$executeRaw`DELETE FROM company_profile WHERE id = ${profileA}::uuid`).resolves.toBe(1);
      expect(await boundArtifacts(workspaceA, 'company_profile', profileA)).toHaveLength(1);
    });

    it('an unbound seller profile is deleted as before', async () => {
      const profile = randomUUID();
      await seedProfile(workspaceB, profile, 'Seller never crawled');
      await expect(owner.$executeRaw`DELETE FROM company_profile WHERE id = ${profile}::uuid`).resolves.toBe(1);
    });
  },
);
