import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import { CompanyUnderstandingRecomputeService } from '../company/company-understanding-recompute.service';
import type { PrismaService } from '../prisma/prisma.service';
import { SellerDocumentClaimsService } from '../seller-knowledge/seller-document-claims.service';
import { WorkspaceService } from './workspace.service';

const ownerUrl = process.env.WORKSPACE_USAGE_TEST_DATABASE_URL;
const appUrl = process.env.WORKSPACE_USAGE_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) {
  throw new Error(
    'workspace usage tests need both WORKSPACE_USAGE_TEST_DATABASE_URL and WORKSPACE_USAGE_TEST_APP_DATABASE_URL',
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
    throw new Error('workspace usage tests require a loopback *_test database');
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sqlState(error: unknown): string | null {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2010'
  ) {
    return null;
  }
  const code = (error.meta as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : null;
}

describe.runIf(Boolean(ownerUrl && appUrl))(
  'workspace sync, usage-summary RPC, and understanding recompute on PostgreSQL as app_user',
  { timeout: 120_000 },
  () => {
    let owner: PrismaClient;
    let app: PrismaClient;
    const wsA = randomUUID();
    const wsB = randomUUID();
    const userA = randomUUID();
    const userB = randomUUID();
    const companyA = randomUUID();
    const companyADraft = randomUUID();
    const companyADeleted = randomUUID();
    const companyB = randomUUID();

    function appPrismaService(): PrismaService {
      return {
        withWorkspace: <T>(
          workspaceId: string,
          fn: (tx: Prisma.TransactionClient) => Promise<T>,
        ) =>
          app.$transaction(
            async (tx) => {
              await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
              return fn(tx);
            },
            { timeout: 30_000 },
          ),
      } as unknown as PrismaService;
    }

    function makeCtx(workspaceId: string, userId: string): RequestContext {
      return {
        workspaceId,
        userId,
        roles: ['ADMIN'],
        scopes: ['acquisition:read', 'acquisition:write'],
      };
    }

    async function seedArtifact(
      workspaceId: string,
      privacyClass: 'PERSONAL_DATA' | 'PUBLIC_ORGANIZATION',
      sizeBytes: bigint,
      companySubjectId?: string,
    ): Promise<void> {
      const authorityId = randomUUID();
      const accountId = randomUUID();
      const operationId = randomUUID();
      const artifactId = randomUUID();
      const hash = sha256(artifactId);
      const objectKey =
        privacyClass === 'PERSONAL_DATA'
          ? `generic-operation-results/v1/final/personal-data/ws/${workspaceId}/sha256/${hash.slice(0, 2)}/${hash}`
          : `generic-operation-results/v1/final/public-organization/sha256/${hash.slice(0, 2)}/${hash}`;

      await owner.$executeRaw`
        INSERT INTO execution_budget_authority (
          id, scope_key, authority_kind, workspace_id, issuer, audience, jti,
          token_sha256, schema_version, purpose, subject_type, subject_id,
          request_sha256, currency, unit, cap_microusd, runs_consumed,
          issued_at, not_before, expires_at, consumed_at
        ) VALUES (
          ${authorityId}::uuid, ${workspaceId}, 'WORKSPACE_GRANT', ${workspaceId}::uuid,
          'https://issuer.test', 'global-backend:execution-budget', ${randomUUID()}::uuid, ${sha256(`tok-${artifactId}`)},
          'execution-budget-grant/v1', 'contact.verify', 'contact_point',
          ${`sub-${artifactId}`}, ${sha256(`req-${artifactId}`)},
          'USD', 'microusd', 1000000, 1,
          now() - interval '10 seconds', now() - interval '5 seconds', now() + interval '60 seconds', now()
        )
      `;
      await owner.$executeRaw`
        INSERT INTO tool_budget_account (
          id, scope_key, account_key, generation, cap_cents, reserved_cents,
          charged_cents, reserved_microusd, charged_microusd,
          exhausted, ref_count, authority_id, authorized_cap_microusd, created_at, updated_at
        ) VALUES (
          ${accountId}::uuid, ${workspaceId}, ${`acct-${artifactId}`}, 1, 0, 0, 0, 0, 0,
          false, 1, ${authorityId}::uuid, 1000000, now(), now()
        )
      `;
      await owner.$executeRaw`
        INSERT INTO tool_budget_operation (
          id, scope_key, account_id, generation, operation_key,
          amount_unit, reserved_cents, reserved_microusd,
          observed_microusd, charged_microusd, settled_at, status, created_at
        ) VALUES (
          ${operationId}::uuid, ${workspaceId}, ${accountId}::uuid, 1, ${`op-${artifactId}`},
          'microusd', 0, 0,
          0, 0, now(), 'SETTLED', now()
        )
      `;
      const objectVersionId = privacyClass === 'PERSONAL_DATA' ? 'ver-1' : null;
      await owner.$executeRaw`
        INSERT INTO generic_operation_artifact_object (
          sha256, object_key, size_bytes, media_type, privacy_class, object_version_id, created_at
        ) VALUES (
          ${hash}, ${objectKey}, ${sizeBytes}, 'application/json', ${privacyClass}, ${objectVersionId}, now()
        )
      `;
      await owner.$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO generic_operation_artifact (
            id, scope_key, workspace_id, authority_id, operation_id,
            result_schema, object_key, sha256, size_bytes, media_type,
            privacy_class, created_at, expires_at
          ) VALUES (
            ${artifactId}::uuid, ${workspaceId}, ${workspaceId}::uuid, ${authorityId}::uuid, ${operationId}::uuid,
            'sanctions-download/v1', ${objectKey}, ${hash}, ${sizeBytes}, 'application/json',
            ${privacyClass}, now(), now() + interval '7 days'
          )
        `;
        if (privacyClass === 'PERSONAL_DATA' && companySubjectId) {
          await tx.$executeRaw`
            INSERT INTO generic_operation_artifact_subject (
              artifact_id, scope_key, workspace_id, subject_type, subject_id, created_at
            ) VALUES (
              ${artifactId}::uuid, ${workspaceId}, ${workspaceId}::uuid, 'company', ${companySubjectId}::uuid, now()
            )
          `;
        }
      });
    }

    beforeAll(async () => {
      owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
      app = new PrismaClient({ datasources: { db: { url: appUrl } } });
    });

    afterAll(async () => {
      if (owner) {
        const cleanupIds = [wsA, wsB];
        await owner.$executeRaw`DELETE FROM claim_document_evidence WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM evidence WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM claim WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM knowledge_source WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM seller_document_chunk WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM seller_document WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM site_release WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM site_build_run WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM site_version WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM asset_variant WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM asset WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM site WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM canonical_contact WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM canonical_company WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM discovery_run WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM discovery_query_plan WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM icp_definition WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM generic_operation_artifact_subject WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM generic_operation_artifact WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM tool_budget_operation WHERE scope_key IN (${wsA}, ${wsB})`;
        await owner.$executeRaw`DELETE FROM tool_budget_account WHERE scope_key IN (${wsA}, ${wsB})`;
        await owner.$executeRaw`DELETE FROM execution_budget_authority WHERE scope_key IN (${wsA}, ${wsB})`;
        await owner.$executeRaw`DELETE FROM company_profile WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM workspace WHERE id = ANY(${cleanupIds}::uuid[])`;
      }
      await Promise.all([owner?.$disconnect(), app?.$disconnect()]);
    });

    it('keeps generic_operation_artifact direct SELECT denied to app_user, allows summarize_workspace_generic_operation_artifacts_v1, and rejects unset workspace or non-app_user role', async () => {
      const privs = await owner.$queryRaw<
        Array<{ table_sel: boolean; fn_exec: boolean }>
      >`
        SELECT
          has_table_privilege('app_user', 'public.generic_operation_artifact', 'SELECT') AS table_sel,
          has_function_privilege(
            'app_user',
            'public.summarize_workspace_generic_operation_artifacts_v1()',
            'EXECUTE'
          ) AS fn_exec
      `;
      expect(privs[0]).toEqual({ table_sel: false, fn_exec: true });

      let unsetState: string | null = null;
      try {
        await app.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT * FROM public.summarize_workspace_generic_operation_artifacts_v1()`;
        });
      } catch (err) {
        unsetState = sqlState(err);
      }
      expect(unsetState).toBe('42501');

      const hasRole = await owner.$queryRaw<Array<{ present: boolean }>>`
        SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'runtime_customer_worker_ops') AS present
      `;
      if (hasRole[0]?.present) {
        let roleState: string | null = null;
        try {
          await app.$transaction(async (tx) => {
            await tx.$executeRaw`SET LOCAL ROLE runtime_customer_worker_ops`;
            await tx.$queryRaw`SELECT * FROM public.summarize_workspace_generic_operation_artifacts_v1()`;
          });
        } catch (err) {
          roleState = sqlState(err);
        }
        expect(roleState).toBe('42501');
      }
    });

    it('upserts lazily-provisioned workspace name and aggregates multi-table + artifact usage strictly inside workspace RLS', async () => {
      const workspaceService = new WorkspaceService(appPrismaService());
      const ctxA = makeCtx(wsA, userA);
      const ctxB = makeCtx(wsB, userB);

      // Lazily-provisioned workspace A does not exist yet -> upsert creates it.
      const createdA = await workspaceService.update(ctxA, { name: 'Workspace Alpha' });
      expect(createdA.id).toBe(wsA);
      expect(createdA.name).toBe('Workspace Alpha');

      const updatedA = await workspaceService.update(ctxA, { name: 'Workspace Alpha v2' });
      expect(updatedA.name).toBe('Workspace Alpha v2');

      // Workspace B upsert is isolated and cannot touch Workspace A.
      await workspaceService.update(ctxB, { name: 'Workspace Beta' });
      const rowsA = await owner.$queryRaw<Array<{ name: string }>>`
        SELECT name FROM workspace WHERE id = ${wsA}::uuid
      `;
      expect(rowsA[0]?.name).toBe('Workspace Alpha v2');

      // Seed usage fixtures across both workspaces.
      await owner.$executeRaw`
        INSERT INTO company_profile (id, workspace_id, name, status, industry, target_markets, deleted_at, created_at, updated_at)
        VALUES
          (${companyA}::uuid, ${wsA}::uuid, 'Active Co A', 'ACTIVE', 'Industrial Pumps', ARRAY['DE']::text[], NULL, now(), now()),
          (${companyADraft}::uuid, ${wsA}::uuid, 'Draft Co A', 'DRAFT', NULL, ARRAY[]::text[], NULL, now(), now()),
          (${companyADeleted}::uuid, ${wsA}::uuid, 'Deleted Co A', 'DRAFT', NULL, ARRAY[]::text[], now(), now(), now()),
          (${companyB}::uuid, ${wsB}::uuid, 'Active Co B', 'ACTIVE', NULL, ARRAY[]::text[], NULL, now(), now())
      `;
      const docReadyId = randomUUID();
      const docPendingId = randomUUID();
      const docDeletedId = randomUUID();
      const docBId = randomUUID();
      const docReadyText = 'Acme GmbH is ISO 9001 certified with MOQ 50 units and lead time 14 days.';
      await owner.$executeRaw`
        INSERT INTO seller_document (
          id, workspace_id, company_id, uploaded_by, filename, mime, size_bytes, kind, object_key,
          content_hash, status, parse_revision, chunk_count, deleted_at, created_at, updated_at
        ) VALUES
          (${docReadyId}::uuid, ${wsA}::uuid, ${companyA}::uuid, ${userA}::uuid, 'cert.txt', 'text/plain', 2048, 'txt', ${`ws/${wsA}/doc1`}, ${sha256(docReadyText)}, 'ready', 1, 1, NULL, now(), now()),
          (${docPendingId}::uuid, ${wsA}::uuid, ${companyA}::uuid, ${userA}::uuid, 'pending.pdf', 'application/pdf', 4096, 'pdf', ${`ws/${wsA}/doc2`}, NULL, 'pending_upload', NULL, 0, NULL, now(), now()),
          (${docDeletedId}::uuid, ${wsA}::uuid, ${companyA}::uuid, ${userA}::uuid, 'deleted.pdf', 'application/pdf', 99999, 'pdf', ${`ws/${wsA}/doc3`}, NULL, 'deleted', NULL, 0, now(), now(), now()),
          (${docBId}::uuid, ${wsB}::uuid, ${companyB}::uuid, ${userB}::uuid, 'b.pdf', 'application/pdf', 8192, 'pdf', ${`ws/${wsB}/docb`}, NULL, 'ready', 1, 0, NULL, now(), now())
      `;
      await owner.$executeRaw`
        INSERT INTO seller_document_chunk (id, workspace_id, document_id, seq, text, meta, created_at)
        VALUES (${randomUUID()}::uuid, ${wsA}::uuid, ${docReadyId}::uuid, 0, ${docReadyText}, '{"page":1}'::jsonb, now())
      `;

      const icpA = randomUUID();
      const planA = randomUUID();
      const icpB = randomUUID();
      await owner.$executeRaw`
        INSERT INTO icp_definition (id, workspace_id, company_id, name, status, created_at, updated_at)
        VALUES
          (${icpA}::uuid, ${wsA}::uuid, ${companyA}::uuid, 'ICP A', 'ACTIVE', now(), now()),
          (${icpB}::uuid, ${wsB}::uuid, ${companyB}::uuid, 'ICP B', 'ACTIVE', now(), now())
      `;
      await owner.$executeRaw`
        INSERT INTO discovery_query_plan (id, workspace_id, icp_id, status, queries, created_at, updated_at)
        VALUES (${planA}::uuid, ${wsA}::uuid, ${icpA}::uuid, 'READY', '[]'::jsonb, now(), now())
      `;
      await owner.$executeRaw`
        INSERT INTO discovery_run (id, workspace_id, plan_id, icp_id, status, materialization_contract_version, created_at)
        VALUES
          (${randomUUID()}::uuid, ${wsA}::uuid, ${planA}::uuid, ${icpA}::uuid, 'DONE', 'discovery-company-materialization/v1', now()),
          (${randomUUID()}::uuid, ${wsA}::uuid, ${planA}::uuid, ${icpA}::uuid, 'RUNNING', 'discovery-company-materialization/v1', now())
      `;

      const canonCoA1 = randomUUID();
      const canonCoA2 = randomUUID();
      const canonCoB = randomUUID();
      await owner.$executeRaw`
        INSERT INTO canonical_company (id, workspace_id, name, status, dedupe_key, created_at, updated_at)
        VALUES
          (${canonCoA1}::uuid, ${wsA}::uuid, 'Buyer 1', 'NEW', 'domain:buyer1.test', now(), now()),
          (${canonCoA2}::uuid, ${wsA}::uuid, 'Buyer 2', 'SUPPRESSED', 'domain:buyer2.test', now(), now()),
          (${canonCoB}::uuid, ${wsB}::uuid, 'Buyer B', 'NEW', 'domain:buyerb.test', now(), now())
      `;
      await owner.$executeRaw`
        INSERT INTO canonical_contact (id, workspace_id, company_id, full_name, dedupe_key, created_at)
        VALUES
          (${randomUUID()}::uuid, ${wsA}::uuid, ${canonCoA1}::uuid, 'Alice A', 'k1', now()),
          (${randomUUID()}::uuid, ${wsB}::uuid, ${canonCoB}::uuid, 'Bob B', 'k2', now())
      `;

      const siteA = randomUUID();
      const assetA = randomUUID();
      const siteVersionA = randomUUID();
      const buildRunA = randomUUID();
      const releaseA = randomUUID();
      const assetHash = sha256('asset-logo');
      const variantHash = sha256('asset-variant-thumb');
      const recipeHash = sha256('recipe1');
      const variantObjectKey = `ws/${wsA}/${siteA}/variants/${assetA}/${recipeHash}.webp`;
      const releasePrefix = `ws/${wsA}/sites/${siteA}/releases/${releaseA}`;
      const artifactDigest = sha256('release-artifact');
      const releaseManifest = JSON.stringify({
        schemaVersion: 'site-builder-release-manifest/v1',
        releaseId: releaseA,
        siteId: siteA,
        siteVersionId: siteVersionA,
        buildRunId: buildRunA,
        artifactPrefix: releasePrefix,
        artifactDigest,
        files: [],
      });
      const manifestDigest = sha256(releaseManifest);
      await owner.$executeRaw`
        INSERT INTO site (id, workspace_id, company_profile_id, name, slug, status, intake, created_at, updated_at)
        VALUES (${siteA}::uuid, ${wsA}::uuid, ${companyA}::uuid, 'Site A', ${`site-${wsA.slice(0, 8)}`}, 'draft', '{}'::jsonb, now(), now())
      `;
      await owner.$executeRaw`
        INSERT INTO asset (id, workspace_id, site_id, kind, filename, mime, size_bytes, object_key, content_hash, processing_status, created_at, updated_at)
        VALUES (${assetA}::uuid, ${wsA}::uuid, ${siteA}::uuid, 'logo', 'logo.png', 'image/png', 1500, ${`ws/${wsA}/logo.png`}, ${assetHash}, 'ready', now(), now())
      `;
      await owner.$executeRaw`
        INSERT INTO asset_variant (id, workspace_id, site_id, asset_id, variant_type, mime, width, height, size_bytes, object_key, content_hash, pipeline_version, recipe_hash, status, created_at, updated_at)
        VALUES (${randomUUID()}::uuid, ${wsA}::uuid, ${siteA}::uuid, ${assetA}::uuid, 'thumb', 'image/webp', 128, 128, 500, ${variantObjectKey}, ${variantHash}, 'v1', ${recipeHash}, 'ready', now(), now())
      `;
      await owner.$executeRaw`
        INSERT INTO site_version (id, workspace_id, site_id, version, spec, spec_version, created_at)
        VALUES (${siteVersionA}::uuid, ${wsA}::uuid, ${siteA}::uuid, 1, '{}'::jsonb, '1.0.0', now())
      `;
      await owner.$executeRaw`
        INSERT INTO site_build_run (id, workspace_id, site_id, status, created_at)
        VALUES (${buildRunA}::uuid, ${wsA}::uuid, ${siteA}::uuid, 'succeeded', now())
      `;
      await owner.$executeRaw`
        INSERT INTO site_release (id, workspace_id, site_id, site_version_id, build_run_id, release_number, status, artifact_prefix, artifact_digest, manifest, manifest_digest, producer_token, lease_until, ready_at, created_at, updated_at)
        VALUES (${releaseA}::uuid, ${wsA}::uuid, ${siteA}::uuid, ${siteVersionA}::uuid, ${buildRunA}::uuid, 1, 'ready', ${releasePrefix}, ${artifactDigest}, ${releaseManifest}::jsonb, ${manifestDigest}, ${randomUUID()}::uuid, now() + interval '1 hour', now(), now(), now())
      `;

      await seedArtifact(wsA, 'PERSONAL_DATA', 3000n, canonCoA1);
      await seedArtifact(wsA, 'PUBLIC_ORGANIZATION', 7000n);
      await seedArtifact(wsB, 'PERSONAL_DATA', 50000n, canonCoB);

      const summary = await workspaceService.usageSummary(ctxA);
      expect(summary).toMatchObject({
        workspaceId: wsA,
        companies: { total: 2, draft: 1, enriching: 0, review: 0, active: 1 },
        sellerDocuments: {
          total: 2,
          ready: 1,
          pendingUpload: 1,
          processing: 0,
          failed: 0,
          totalBytes: 6144,
          readyBytes: 2048,
          pendingUploadBytes: 4096,
        },
        icps: { total: 1 },
        discoveryRuns: { total: 2, running: 1, completed: 1, failed: 0 },
        canonicalCompanies: { total: 2, suppressed: 1 },
        canonicalContacts: { total: 1 },
        siteAssets: { total: 1, totalBytes: 1500, variants: 1, variantBytes: 500 },
        siteReleases: { total: 1, ready: 1 },
        operationArtifacts: {
          total: 2,
          totalBytes: 10000,
          personalDataCount: 1,
          personalDataBytes: 3000,
        },
      });
      expect(() => JSON.stringify(summary)).not.toThrow();

      // Recompute understanding on PG16 as app_user (preserves ACTIVE status, stamps factsExtractedAt).
      const recomputeService = new CompanyUnderstandingRecomputeService(
        appPrismaService(),
        new SellerDocumentClaimsService(appPrismaService()),
      );
      const first = await recomputeService.recompute(ctxA, companyA, {});
      expect(first.status).toBe('ACTIVE');
      expect(first.documentsScanned).toBe(1);
      expect(first.draftsCreated).toBeGreaterThan(0);
      expect(first.profileDraftsCreated).toBeGreaterThan(0);

      const [docRow] = await owner.$queryRaw<
        Array<{ facts_extracted_at: Date | null }>
      >`
        SELECT facts_extracted_at FROM seller_document WHERE id = ${docReadyId}::uuid
      `;
      expect(docRow?.facts_extracted_at).toBeInstanceOf(Date);

      const second = await recomputeService.recompute(ctxA, companyA, {});
      expect(second.documentsScanned).toBe(0);
      expect(second.draftsCreated).toBe(0);

      // Cross-tenant recompute fails with 404.
      await expect(recomputeService.recompute(ctxB, companyA, {})).rejects.toMatchObject({
        status: 404,
      });
    });
  },
);
