import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { validateIntegrationEvent } from '../relay/event-registry';
import { createDeletionActivities } from './deletion.activities';

const ownerUrl = process.env.DELETION_COMPANY_ERASURE_TEST_DATABASE_URL;
const appUrl = process.env.DELETION_COMPANY_ERASURE_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) {
  throw new Error(
    'deletion company erasure tests need both DELETION_COMPANY_ERASURE_TEST_DATABASE_URL and DELETION_COMPANY_ERASURE_TEST_APP_DATABASE_URL',
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
    throw new Error(
      'deletion company erasure tests require a loopback *_test database',
    );
  }
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

function loadDeletionCompletedValidator() {
  const schemaPath = path.resolve(
    __dirname,
    '../../../../packages/contracts/events/payloads/deletion-completed.v1.schema.json',
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(JSON.parse(fs.readFileSync(schemaPath, 'utf8')));
}

describe.runIf(Boolean(ownerUrl && appUrl))(
  'company-subject DSR erasure gaps on PostgreSQL as app_user',
  { timeout: 120_000 },
  () => {
    let owner: PrismaClient;
    let app: PrismaClient;
    const wsA = randomUUID();
    const wsB = randomUUID();

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

    beforeAll(async () => {
      owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
      app = new PrismaClient({ datasources: { db: { url: appUrl } } });
      await owner.$executeRaw`
        INSERT INTO workspace (id, name, created_at, updated_at) VALUES
          (${wsA}::uuid, 'DSR Erasure WS A', now(), now()),
          (${wsB}::uuid, 'DSR Erasure WS B', now(), now())
      `;
    });

    afterAll(async () => {
      if (owner) {
        const wsIds = [wsA, wsB];
        await owner.$executeRaw`DELETE FROM personal_artifact_cleanup_command WHERE workspace_id = ANY(${wsIds}::uuid[])`;
        await owner.$executeRaw`DELETE FROM generic_operation_artifact_subject_tombstone_audit WHERE workspace_id = ANY(${wsIds}::uuid[])`;
        await owner.$executeRaw`DELETE FROM generic_operation_artifact_subject_tombstone WHERE workspace_id = ANY(${wsIds}::uuid[])`;
        await owner.$executeRaw`DELETE FROM outbox_event WHERE workspace_id = ANY(${wsIds}::uuid[])`;
        await owner.$executeRaw`DELETE FROM deletion_receipt WHERE workspace_id = ANY(${wsIds}::uuid[])`;
        await owner.$executeRaw`DELETE FROM deletion_request WHERE workspace_id = ANY(${wsIds}::uuid[])`;
        await owner.$executeRaw`DELETE FROM suppression_record WHERE workspace_id = ANY(${wsIds}::uuid[])`;
        await owner.$executeRaw`DELETE FROM lead_outreach_draft WHERE workspace_id = ANY(${wsIds}::uuid[])`;
        await owner.$executeRaw`DELETE FROM lead WHERE workspace_id = ANY(${wsIds}::uuid[])`;
        await owner.$executeRaw`DELETE FROM field_evidence WHERE workspace_id = ANY(${wsIds}::uuid[])`;
        await owner.$executeRaw`DELETE FROM contact_point WHERE workspace_id = ANY(${wsIds}::uuid[])`;
        await owner.$executeRaw`DELETE FROM canonical_contact WHERE workspace_id = ANY(${wsIds}::uuid[])`;
        await owner.$executeRaw`DELETE FROM canonical_company WHERE workspace_id = ANY(${wsIds}::uuid[])`;
        await owner.$executeRaw`DELETE FROM icp_definition WHERE workspace_id = ANY(${wsIds}::uuid[])`;
        await owner.$executeRaw`DELETE FROM company_profile WHERE workspace_id = ANY(${wsIds}::uuid[])`;
        await owner.$executeRaw`DELETE FROM workspace WHERE id = ANY(${wsIds}::uuid[])`;
      }
      await Promise.all([owner?.$disconnect(), app?.$disconnect()]);
    });

    it('keeps direct DELETE on lead_outreach_draft denied to app_user and guards purge_workspace_company_outreach_drafts_v1', async () => {
      const privs = await owner.$queryRaw<
        Array<{ draft_del: boolean; fn_exec: boolean }>
      >`
        SELECT
          has_table_privilege('app_user', 'public.lead_outreach_draft', 'DELETE') AS draft_del,
          has_function_privilege(
            'app_user',
            'public.purge_workspace_company_outreach_drafts_v1(uuid, uuid[], uuid)',
            'EXECUTE'
          ) AS fn_exec
      `;
      expect(privs[0]).toEqual({ draft_del: false, fn_exec: true });

      let directDeleteState: string | null = null;
      try {
        await app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${wsA}, true)`;
          await tx.$executeRaw`DELETE FROM public.lead_outreach_draft WHERE false`;
        });
      } catch (err) {
        directDeleteState = sqlState(err);
      }
      expect(directDeleteState).toBe('42501');

      const dummyCo = randomUUID();
      const dummyReq = randomUUID();
      let crossWsState: string | null = null;
      try {
        await app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${wsB}, true)`;
          await tx.$queryRaw`
            SELECT public.purge_workspace_company_outreach_drafts_v1(
              ${wsA}::uuid, ARRAY[${dummyCo}::uuid]::uuid[], ${dummyReq}::uuid
            )
          `;
        });
      } catch (err) {
        crossWsState = sqlState(err);
      }
      expect(crossWsState).toBe('42501');

      // Contact-type or COMPLETED deletion request must be rejected by state guard.
      const contactReqId = randomUUID();
      await owner.$executeRaw`
        INSERT INTO deletion_request (
          id, workspace_id, subject_type, subject_id, status, requested_by, reason, created_at, updated_at
        ) VALUES (
          ${contactReqId}::uuid, ${wsA}::uuid, 'contact', ${dummyCo}::uuid, 'FROZEN', 'dsr-test', 'erasure', now(), now()
        )
      `;
      let wrongTypeState: string | null = null;
      try {
        await app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${wsA}, true)`;
          await tx.$queryRaw`
            SELECT public.purge_workspace_company_outreach_drafts_v1(
              ${wsA}::uuid, ARRAY[${dummyCo}::uuid]::uuid[], ${contactReqId}::uuid
            )
          `;
        });
      } catch (err) {
        wrongTypeState = sqlState(err);
      }
      expect(wrongTypeState).toBe('42501');
    });

    it('erases lead_outreach_draft, scrubs canonical_company.attributes, cleans red company field_evidence, and emits erased_contact_refs including post-freeze stragglers', async () => {
      const sellerA = randomUUID();
      const sellerB = randomUUID();
      const icpA = randomUUID();
      const icpB = randomUUID();
      const companyA = randomUUID();
      const companyB = randomUUID();
      const leadA = randomUUID();
      const leadB = randomUUID();
      const contactPre = randomUUID();
      const contactStraggler = randomUUID();
      const delReqId = randomUUID();

      await owner.$executeRaw`
        INSERT INTO company_profile (id, workspace_id, name, created_at, updated_at) VALUES
          (${sellerA}::uuid, ${wsA}::uuid, 'Seller A', now(), now()),
          (${sellerB}::uuid, ${wsB}::uuid, 'Seller B', now(), now())
      `;
      await owner.$executeRaw`
        INSERT INTO icp_definition (id, workspace_id, company_id, name, status, created_at, updated_at) VALUES
          (${icpA}::uuid, ${wsA}::uuid, ${sellerA}::uuid, 'ICP A', 'ACTIVE', now(), now()),
          (${icpB}::uuid, ${wsB}::uuid, ${sellerB}::uuid, 'ICP B', 'ACTIVE', now(), now())
      `;
      const dirtyAttrs = {
        contact_email: 'leak@buyer-a.invalid',
        phone: '+49123456',
        gleif: { lei: '529900T8BM49AURSDO55', contact: 'John Doe', person: 'Jane Doe' },
        products: ['hydraulic valve'],
        legacy_pii: { email: 'legacy@buyer-a.invalid' },
      };
      await owner.$executeRaw`
        INSERT INTO canonical_company (id, workspace_id, name, domain, status, dedupe_key, attributes, created_at, updated_at) VALUES
          (${companyA}::uuid, ${wsA}::uuid, 'Buyer A GmbH', 'buyer-a.invalid', 'ENRICHED', 'domain:buyer-a.invalid', ${JSON.stringify(dirtyAttrs)}::jsonb, now(), now()),
          (${companyB}::uuid, ${wsB}::uuid, 'Buyer B GmbH', 'buyer-b.invalid', 'ENRICHED', 'domain:buyer-b.invalid', '{"contact_email":"keep-b@buyer-b.invalid"}'::jsonb, now(), now())
      `;
      await owner.$executeRaw`
        INSERT INTO canonical_contact (id, workspace_id, company_id, full_name, dedupe_key, created_at) VALUES
          (${contactPre}::uuid, ${wsA}::uuid, ${companyA}::uuid, 'Pre Freeze Contact', 'pre-freeze-k', now())
      `;
      await owner.$executeRaw`
        INSERT INTO lead (id, workspace_id, icp_id, canonical_company_id, created_at, updated_at) VALUES
          (${leadA}::uuid, ${wsA}::uuid, ${icpA}::uuid, ${companyA}::uuid, now(), now()),
          (${leadB}::uuid, ${wsB}::uuid, ${icpB}::uuid, ${companyB}::uuid, now(), now())
      `;
      await owner.$executeRaw`
        INSERT INTO lead_outreach_draft (id, workspace_id, lead_id, version, language, subject, body, body_zh, used_facts, model, created_at) VALUES
          (${randomUUID()}::uuid, ${wsA}::uuid, ${leadA}::uuid, 1, 'de', 'Hello A', 'Body A', '正文 A', '["fact1"]'::jsonb, 'deepseek-v4-pro', now()),
          (${randomUUID()}::uuid, ${wsB}::uuid, ${leadB}::uuid, 1, 'de', 'Hello B', 'Body B', '正文 B', '["fact1"]'::jsonb, 'deepseek-v4-pro', now())
      `;
      await owner.$executeRaw`
        INSERT INTO field_evidence (id, workspace_id, entity_type, entity_id, field, value, provider_key, data_class, confidence, fetched_at) VALUES
          (${randomUUID()}::uuid, ${wsA}::uuid, 'company', ${companyA}::uuid, 'legacy_email', '"leak@buyer-a.invalid"'::jsonb, 'web', 'red', 0.9, now()),
          (${randomUUID()}::uuid, ${wsA}::uuid, 'company', ${companyA}::uuid, 'industry', '"Hydraulics"'::jsonb, 'web', 'green', 0.9, now())
      `;
      await owner.$executeRaw`
        INSERT INTO deletion_request (id, workspace_id, subject_type, subject_id, status, requested_by, reason, created_at, updated_at)
        VALUES (${delReqId}::uuid, ${wsA}::uuid, 'company', ${companyA}::uuid, 'RECEIVED', 'dsr-pg-test', 'erasure', now(), now())
      `;

      const activities = createDeletionActivities({ prisma: appPrismaService() });
      const input = {
        workspaceId: wsA,
        deletionRequestId: delReqId,
        subjectType: 'company' as const,
        subjectId: companyA,
      };

      const located = await activities.freezeSubject(input);

      // Simulate a post-freeze straggler contact committed before eraseSubject acquires FOR UPDATE.
      await owner.$executeRaw`
        INSERT INTO canonical_contact (id, workspace_id, company_id, full_name, dedupe_key, created_at)
        VALUES (${contactStraggler}::uuid, ${wsA}::uuid, ${companyA}::uuid, 'Straggler Contact', 'straggler-k', now())
      `;

      const counts = await activities.eraseSubject({ input, located });
      expect(counts).toMatchObject({ contactsErased: 2, companiesSuppressed: 1 });

      await activities.completeDeletion({ input, located });

      // 1. lead_outreach_draft purged for wsA, untouched for wsB.
      const draftsA = await owner.$queryRaw<Array<{ id: string }>>`
        SELECT id::text FROM lead_outreach_draft WHERE workspace_id = ${wsA}::uuid
      `;
      const draftsB = await owner.$queryRaw<Array<{ id: string }>>`
        SELECT id::text FROM lead_outreach_draft WHERE workspace_id = ${wsB}::uuid
      `;
      expect(draftsA).toHaveLength(0);
      expect(draftsB).toHaveLength(1);

      // 2. canonical_company.attributes scrubbed + status SUPPRESSED.
      const [coA] = await owner.$queryRaw<
        Array<{ status: string; attributes: Record<string, unknown> }>
      >`
        SELECT status, attributes FROM canonical_company WHERE id = ${companyA}::uuid
      `;
      expect(coA?.status).toBe('SUPPRESSED');
      expect(coA?.attributes).toEqual({
        gleif: { lei: '529900T8BM49AURSDO55' },
        products: ['hydraulic valve'],
      });

      // 3. legacy red company field_evidence deleted, green retained.
      const feA = await owner.$queryRaw<Array<{ data_class: string }>>`
        SELECT data_class FROM field_evidence WHERE workspace_id = ${wsA}::uuid AND entity_type = 'company' AND entity_id = ${companyA}::uuid
      `;
      expect(feA.map((r) => r.data_class)).toEqual(['green']);

      // 4. DeletionCompleted outbox event contains exact sorted erased_contact_refs (including straggler).
      const [ev] = await owner.$queryRaw<
        Array<{
          event_type: string;
          schema_version: number;
          aggregate_type: string;
          aggregate_id: string;
          payload: Record<string, unknown>;
        }>
      >`
        SELECT event_type, schema_version, aggregate_type, aggregate_id::text, payload
        FROM outbox_event
        WHERE workspace_id = ${wsA}::uuid
          AND event_type = 'DeletionCompleted'
          AND aggregate_id = ${delReqId}
      `;
      expect(ev).toBeDefined();
      const expectedRefs = [contactPre, contactStraggler].sort();
      expect(ev?.payload.erased_contact_refs).toEqual(expectedRefs);
      expect(
        validateIntegrationEvent({
          eventId: randomUUID(),
          eventType: ev!.event_type,
          schemaVersion: ev!.schema_version,
          workspaceId: wsA,
          aggregateType: ev!.aggregate_type,
          aggregateId: ev!.aggregate_id,
          payload: ev!.payload,
        }),
      ).toBe(true);
      const validateSchema = loadDeletionCompletedValidator();
      expect(validateSchema(ev!.payload), JSON.stringify(validateSchema.errors)).toBe(
        true,
      );
    });
  },
);
