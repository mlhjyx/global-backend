import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { Readable } from 'node:stream';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import { piiExtension } from '../compliance/pii-crypto.extension';
import type { PrismaService } from '../prisma/prisma.service';
import { createDataExportActivities } from '../temporal/data-export.activities';
import type { TemporalClient } from '../temporal/temporal.client';
import { DataExportsService } from './data-exports.service';
import type { DataExportStorage } from './data-exports.storage';

const ownerUrl = process.env.DATA_EXPORTS_TEST_DATABASE_URL;
const appUrl = process.env.DATA_EXPORTS_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) {
  throw new Error(
    'data-exports tests need both DATA_EXPORTS_TEST_DATABASE_URL and DATA_EXPORTS_TEST_APP_DATABASE_URL',
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
    throw new Error('data-exports tests require a loopback *_test database');
  }
}

describe.runIf(Boolean(ownerUrl && appUrl))(
  'Async tenant data exports on PostgreSQL as app_user (RLS + piiExtension)',
  { timeout: 120_000 },
  () => {
    let owner: PrismaClient;
    let appRaw: PrismaClient;
    let app: ReturnType<PrismaClient['$extends']>;
    const wsA = randomUUID();
    const wsB = randomUUID();
    const userA = randomUUID();
    const userB = randomUUID();
    const origPiiKey = process.env.PII_ENCRYPTION_KEY;
    const origPiiKeyring = process.env.PII_KEYRING_JSON;

    function appPrismaService(): PrismaService {
      return {
        withWorkspace: <T>(
          workspaceId: string,
          fn: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: { timeout?: number },
        ) =>
          (app as unknown as PrismaService).withWorkspace(workspaceId, fn, options),
      } as unknown as PrismaService;
    }

    function ctxFor(workspaceId: string, userId: string): RequestContext {
      return {
        workspaceId,
        userId,
        roles: ['ADMIN'],
        scopes: ['acquisition:read', 'acquisition:export'],
      };
    }

    beforeAll(async () => {
      process.env.PII_KEYRING_JSON = JSON.stringify({
        activeKeyId: 'k1',
        keys: { k1: 'ab'.repeat(32) },
      });
      owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
      appRaw = new PrismaClient({ datasources: { db: { url: appUrl } } });
      app = appRaw.$extends(piiExtension);
    });

    afterAll(async () => {
      if (origPiiKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
      else process.env.PII_ENCRYPTION_KEY = origPiiKey;
      if (origPiiKeyring === undefined) delete process.env.PII_KEYRING_JSON;
      else process.env.PII_KEYRING_JSON = origPiiKeyring;

      if (owner) {
        await owner.$executeRaw`DELETE FROM data_export_job WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM policy_decision_log WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM lead_outreach_draft WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM lead WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM suppression_record WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM contact_point WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM canonical_contact WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM canonical_company WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM discovery_run WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM discovery_query_plan WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM icp_definition WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM seller_document WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM company_profile WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
        await owner.$executeRaw`DELETE FROM workspace WHERE id IN (${wsA}::uuid, ${wsB}::uuid)`;
      }
      await Promise.all([owner?.$disconnect(), appRaw?.$disconnect()]);
    });

    it('isolates data_export_job via FORCE RLS, decrypts PII in exports, packs ZIP archives, and enforces TTL', async () => {
      const prismaSvc = appPrismaService();
      const ctxA = ctxFor(wsA, userA);
      const ctxB = ctxFor(wsB, userB);

      // Seed wsA + wsB tenant rows using app + piiExtension so PII is encrypted at rest.
      const sellerCoA = randomUUID();
      const icpA = randomUUID();
      const planA = randomUUID();
      const canonCoA = randomUUID();
      const contactA = randomUUID();
      const canonCoB = randomUUID();
      const contactB = randomUUID();

      await prismaSvc.withWorkspace(wsA, async (tx) => {
        await tx.workspace.create({
          data: { id: wsA, name: 'Workspace Alpha' },
        });
        await tx.companyProfile.create({
          data: { id: sellerCoA, workspaceId: wsA, name: 'Seller Alpha', status: 'ACTIVE' },
        });
        await tx.sellerDocument.create({
          data: {
            workspaceId: wsA,
            companyId: sellerCoA,
            uploadedBy: userA,
            filename: 'brochure.pdf',
            mime: 'application/pdf',
            sizeBytes: 2048n,
            kind: 'pdf',
            objectKey: `ws/${wsA}/doc/1`,
            status: 'ready',
          },
        });
        await tx.icpDefinition.create({
          data: { id: icpA, workspaceId: wsA, companyId: sellerCoA, name: 'EU Pumps', status: 'ACTIVE' },
        });
        await tx.discoveryQueryPlan.create({
          data: { id: planA, workspaceId: wsA, icpId: icpA, status: 'READY', queries: [] },
        });
        await tx.discoveryRun.create({
          data: {
            workspaceId: wsA,
            planId: planA,
            icpId: icpA,
            status: 'DONE',
            mode: 'full',
            materializationContractVersion: 'discovery-company-materialization/v1',
          },
        });
        await tx.canonicalCompany.create({
          data: {
            id: canonCoA,
            workspaceId: wsA,
            name: 'Alpha Buyer GmbH',
            domain: 'alpha-buyer.de',
            country: 'DE',
            dedupeKey: 'domain:alpha-buyer.de',
          },
        });
        await tx.canonicalContact.create({
          data: {
            id: contactA,
            workspaceId: wsA,
            companyId: canonCoA,
            fullName: 'Alice Mueller',
            title: 'VP Procurement',
            dedupeKey: 'ck-alice',
          },
        });
        await tx.contactPoint.create({
          data: {
            workspaceId: wsA,
            contactId: contactA,
            type: 'email',
            value: 'alice@alpha-buyer.de',
            sourceType: 'contact_page',
            status: 'VALID',
            verifiedAt: new Date(),
            validSince: new Date(),
            verificationState: 'VALID',
            verificationMethod: 'operator',
            verificationProvider: 'operator',
          },
        });
        const leadA = await tx.lead.create({
          data: {
            workspaceId: wsA,
            icpId: icpA,
            canonicalCompanyId: canonCoA,
            status: 'QUALIFIED',
            queue: 'recommended',
            fitVerdict: 'match',
            totalScore: 88,
          },
        });
        await tx.leadOutreachDraft.create({
          data: {
            workspaceId: wsA,
            leadId: leadA.id,
            version: 1,
            language: 'de',
            subject: 'Anfrage Pumpen',
            body: 'Guten Tag',
            bodyZh: '您好',
            usedFacts: ['company.name'],
            model: 'gpt-test',
          },
        });
        await tx.suppressionRecord.create({
          data: {
            workspaceId: wsA,
            type: 'email',
            value: 'blocked@alpha-buyer.de',
            reason: 'unsubscribe',
            protectionClass: 'LEGAL',
          },
        });
      });

      await prismaSvc.withWorkspace(wsB, async (tx) => {
        await tx.canonicalCompany.create({
          data: {
            id: canonCoB,
            workspaceId: wsB,
            name: 'Beta Secret Corp',
            dedupeKey: 'domain:beta-secret.com',
          },
        });
        await tx.canonicalContact.create({
          data: {
            id: contactB,
            workspaceId: wsB,
            companyId: canonCoB,
            fullName: 'Bob Secret',
            dedupeKey: 'ck-bob',
          },
        });
        await tx.contactPoint.create({
          data: {
            workspaceId: wsB,
            contactId: contactB,
            type: 'email',
            value: 'bob@beta-secret.com',
            sourceType: 'contact_page',
          },
        });
      });

      // Confirm PII is encrypted in raw DB column with v2 per-workspace ciphertext
      const [rawContact] = await owner.$queryRaw<Array<{ full_name: string }>>`
        SELECT full_name FROM canonical_contact WHERE id = ${contactA}::uuid
      `;
      expect(rawContact?.full_name.startsWith('enc:v2:k1:')).toBe(true);

      const storedObjects = new Map<string, { body: Buffer; contentType: string }>();
      const mockStorage = {
        putExportObject: vi.fn(async (key: string, body: Buffer, contentType: string) => {
          storedObjects.set(key, { body, contentType });
        }),
        getObjectStream: vi.fn(async (key: string) => {
          const item = storedObjects.get(key);
          if (!item) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
          return {
            stream: Readable.from([item.body]),
            contentLength: item.body.length,
            contentType: item.contentType,
          };
        }),
        delete: vi.fn(async (key: string) => {
          storedObjects.delete(key);
        }),
      } as unknown as DataExportStorage;

      const mockTemporal = {
        client: { workflow: { start: vi.fn(async () => undefined) } },
        reconnect: async () => true,
      } as unknown as TemporalClient;

      const service = new DataExportsService(prismaSvc, mockStorage, mockTemporal);
      const contactsJob = await service.createExport(ctxA, { scope: 'contacts', format: 'csv' });
      const archiveJob = await service.createExport(ctxA, { scope: 'full_archive', format: 'jsonl' });

      // Concurrency bound: 3rd active export fails with 409 DATA_EXPORT_IN_PROGRESS
      await expect(service.createExport(ctxA, { scope: 'leads', format: 'csv' })).rejects.toMatchObject({
        status: 409,
      });

      // Cross-tenant RLS: wsB cannot read wsA export jobs
      await expect(service.getExport(ctxB, contactsJob.id)).rejects.toMatchObject({ status: 404 });
      const listB = await service.listExports(ctxB, { limit: 20 });
      expect(listB.data).toEqual([]);

      // Download before ready fails with 409 DATA_EXPORT_NOT_READY
      await expect(service.openDownloadStream(ctxA, contactsJob.id)).rejects.toMatchObject({
        status: 409,
      });

      const acts = createDataExportActivities({ prisma: prismaSvc, storage: mockStorage });
      const contactsRes = await acts.runDataExport({ workspaceId: wsA, exportId: contactsJob.id });
      expect(contactsRes.status).toBe('ready');
      expect(contactsRes.rowCount).toBe(1);

      const openedCsv = await service.openDownloadStream(ctxA, contactsJob.id);
      const chunks: Buffer[] = [];
      for await (const c of openedCsv.stream) chunks.push(Buffer.from(c));
      const csvText = Buffer.concat(chunks).toString('utf8');
      expect(csvText).toContain('Alice Mueller');
      expect(csvText).toContain('alice@alpha-buyer.de');
      expect(csvText).not.toContain('enc:v1:');
      expect(csvText).not.toContain('enc:v2:');
      expect(csvText).not.toContain('Bob Secret');
      expect(csvText).not.toContain('bob@beta-secret.com');

      const archiveRes = await acts.runDataExport({ workspaceId: wsA, exportId: archiveJob.id });
      expect(archiveRes.status).toBe('ready');
      const archiveObj = storedObjects.get(`ws/${wsA}/exports/${archiveJob.id}.zip`);
      expect(archiveObj).toBeDefined();
      const zipBuf = archiveObj!.body;
      expect(zipBuf.readUInt32LE(0)).toBe(0x04034b50);
      // Verify first entry inflates cleanly and manifest.json is included
      const firstNameLen = zipBuf.readUInt16LE(26);
      const firstCompLen = zipBuf.readUInt32LE(18);
      const firstInflated = inflateRawSync(zipBuf.subarray(30 + firstNameLen, 30 + firstNameLen + firstCompLen)).toString('utf8');
      expect(firstInflated).toContain('Alpha Buyer GmbH');
      expect(zipBuf.toString('utf8')).toContain('manifest.json');

      // Verify PolicyDecisionLog audit entry recorded
      const [audit] = await owner.$queryRaw<Array<{ action: string; reason: string }>>`
        SELECT action, reason FROM policy_decision_log
        WHERE workspace_id = ${wsA}::uuid AND correlation_id = ${contactsJob.id}
      `;
      expect(audit).toEqual({ action: 'EXPORT', reason: 'data_export:contacts' });

      // Simulate expiry -> download fails with 410 DATA_EXPORT_EXPIRED and transitions status to expired
      await owner.$executeRaw`
        UPDATE data_export_job SET expires_at = now() - interval '1 minute' WHERE id = ${contactsJob.id}::uuid
      `;
      await expect(service.openDownloadStream(ctxA, contactsJob.id)).rejects.toMatchObject({
        status: 410,
      });
      const afterExpiry = await service.getExport(ctxA, contactsJob.id);
      expect(afterExpiry.status).toBe('expired');
    });
  },
);
