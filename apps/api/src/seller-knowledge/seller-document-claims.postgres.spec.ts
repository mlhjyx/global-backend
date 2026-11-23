import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Prisma, PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { SellerDocumentClaimsService } from './seller-document-claims.service';
import { SellerDocumentCleanupService } from './seller-document-cleanup.service';
import type {
  SellerDocumentEraseProgress,
} from './seller-document-cleanup.types';
import type { DeletionWorkflowInput, LocatedDeletionTargets } from '../compliance/deletion.types';
import { createDeletionActivities } from '../temporal/deletion.activities';
import { ClaimService } from '../claim/claim.service';
import {
  documentClaimBindingHash,
  documentClaimDependenciesStillCurrent,
  documentClaimStatementDigest,
  hasValidDocumentClaimApprovalAudit,
  loadDocumentClaimBindingInTransaction,
} from '../claim/document-claim-basis';
import { effectiveApprovedClaimsInTransaction } from '../claim/document-claim-basis';

const ownerUrl = process.env.SELLER_DOCUMENT_CLAIM_TEST_DATABASE_URL;
const appUrl = process.env.SELLER_DOCUMENT_CLAIM_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) {
  throw new Error('seller document claim tests need both SELLER_DOCUMENT_CLAIM_TEST_DATABASE_URL and SELLER_DOCUMENT_CLAIM_TEST_APP_DATABASE_URL');
}
for (const value of [ownerUrl, appUrl]) {
  if (!value) continue;
  const url = new URL(value);
  if (url.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/global_test' || url.search !== '' || url.hash !== '') {
    throw new Error('seller document claim tests require a loopback /global_test database');
  }
}
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function sqlState(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2010') return null;
  const code = (error.meta as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : null;
}

describe.runIf(Boolean(ownerUrl && appUrl))('seller document typed claim S1a on PostgreSQL as app_user', { timeout: 120_000 }, () => {
  const owner = ownerUrl ? new PrismaClient({ datasources: { db: { url: ownerUrl } } }) : (null as never);
  const app = appUrl ? new PrismaClient({ datasources: { db: { url: appUrl } } }) : (null as never);
  const appPrisma = {
    withWorkspace: <T>(workspaceId: string, work: (tx: Prisma.TransactionClient) => Promise<T>) =>
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
        return work(tx);
      }, { timeout: 30_000 }),
  } as never;
  const claims = new SellerDocumentClaimsService(appPrisma);
  const claimService = new ClaimService(appPrisma);
  const cleanupService = new SellerDocumentCleanupService(appPrisma);
  const ctx = (workspaceId: string, userId = randomUUID()) => ({ workspaceId, userId, roles: [], scopes: [] as const });
  /** The same helper paths under the real restricted principal: app_user + FORCE RLS. */
  const asApp = <T>(workspaceId: string, work: (tx: Prisma.TransactionClient) => Promise<T>) =>
    app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
      return work(tx);
    }, { timeout: 30_000 });
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
  };
  const countsOf = (progress: SellerDocumentEraseProgress) => ({
    chunksErased: progress.chunksErased,
    claimsErased: progress.claimsErased,
    evidenceErased: progress.evidenceErased,
    referencesErased: progress.referencesErased,
    knowledgeSourcesErased: progress.knowledgeSourcesErased,
    blobDeleted: progress.blobDeleted,
    blobFailures: progress.blobFailures,
  });
  const eraseUntilDone = async (
    activities: ReturnType<typeof createDeletionActivities>,
    input: DeletionWorkflowInput,
    located: LocatedDeletionTargets,
  ) => {
    const calls: SellerDocumentEraseProgress[] = [];
    let progress = (await activities.eraseSubject({ input, located })) as SellerDocumentEraseProgress;
    calls.push(progress);
    while (!progress.done) {
      progress = (await activities.eraseSubject({ input, located })) as SellerDocumentEraseProgress;
      calls.push(progress);
      if (calls.length > 200) throw new Error('seller document cleanup did not converge');
    }
    return { final: progress, calls };
  };

  async function seedDocument(workspaceId: string, companyId: string, body: string, overrides: { parseRevision?: number; status?: string } = {}) {
    const documentId = randomUUID();
    await owner.sellerDocument.create({
      data: {
        id: documentId,
        workspaceId,
        companyId,
        uploadedBy: randomUUID(),
        filename: 'synthetic.txt',
        mime: 'text/plain',
        sizeBytes: BigInt(Buffer.byteLength(body, 'utf8')),
        kind: 'txt',
        objectKey: `ws/${workspaceId}/companies/${companyId}/seller-documents/${documentId}/${sha(body)}.txt`,
        contentHash: sha(body),
        status: overrides.status ?? 'ready',
        parseRevision: overrides.parseRevision ?? 1,
        chunkCount: 1,
      },
    });
    await owner.sellerDocumentChunk.create({
      data: { workspaceId, documentId, seq: 0, text: body, meta: { page: 1 } },
    });
    return { documentId, contentHash: sha(body), text: body, chunkTextHash: sha(body) };
  }
  async function seedTenant(body = 'Synthetic seller GmbH 通过 ISO 9001 认证，覆盖汽车零部件。') {
    const workspaceId = randomUUID();
    const companyId = randomUUID();
    await owner.workspace.create({ data: { id: workspaceId, name: 'Synthetic workspace' } });
    await owner.companyProfile.create({ data: { id: companyId, workspaceId, name: 'Synthetic Seller', status: 'REVIEW' } as never });
    const document = await seedDocument(workspaceId, companyId, body);
    return { workspaceId, companyId, document, user: randomUUID() };
  }
  function referenceFor(document: { documentId: string; contentHash: string; chunkTextHash: string; text: string }, start = 0, end = Buffer.byteLength('Synthetic seller GmbH 通过 ISO 9001 认证，覆盖汽车零部件。')) {
    const bytes = Buffer.from(document.text, 'utf8');
    return {
      documentId: document.documentId,
      documentContentHash: document.contentHash,
      parseRevision: 1,
      chunkSeq: 0,
      chunkTextHash: document.chunkTextHash,
      quoteStartByte: start,
      quoteEndByte: Math.min(end, bytes.length),
    };
  }
  const quoteOf = (text: string, needle: string) => {
    const bytes = Buffer.from(text, 'utf8');
    const start = bytes.indexOf(Buffer.from(needle, 'utf8'));
    return { start, end: start + Buffer.byteLength(needle, 'utf8'), quote: needle };
  };
  async function seedCleanupClaims(
    tenant: { workspaceId: string; companyId: string; document: { documentId: string; contentHash: string; chunkTextHash: string } },
    count: number,
  ) {
    const rows = Array.from({ length: count }, (_, index) => ({
      claimId: randomUUID(),
      evidenceId: randomUUID(),
      statement: `legacy statement ${index}`,
      digest: sha(`legacy statement ${index}`),
    }));
    await owner.claim.createMany({
      data: rows.map((row) => ({
        id: row.claimId,
        workspaceId: tenant.workspaceId,
        companyId: tenant.companyId,
        type: 'certification',
        statement: row.statement,
        status: 'NEEDS_REVIEW' as const,
        version: 1,
      })),
    });
    await owner.evidence.createMany({
      data: rows.map((row) => ({
        id: row.evidenceId,
        workspaceId: tenant.workspaceId,
        claimId: row.claimId,
        snippet: row.statement,
      })),
    });
    await owner.claimDocumentEvidence.createMany({
      data: rows.map((row) => ({
        id: randomUUID(),
        workspaceId: tenant.workspaceId,
        companyId: tenant.companyId,
        claimId: row.claimId,
        evidenceId: row.evidenceId,
        documentId: tenant.document.documentId,
        sourceDocumentId: tenant.document.documentId,
        documentContentSha256: tenant.document.contentHash,
        parseRevision: 1,
        chunkSeq: 0,
        chunkTextSha256: tenant.document.chunkTextHash,
        quoteStartByte: 0,
        quoteEndByte: 1,
        claimStatementDigest: row.digest,
        claimType: 'certification',
        bindingSha256: sha(`binding ${row.claimId}`),
        requesterId: randomUUID(),
        requestDigest: sha(`request ${row.claimId}`),
      })),
    });
    return rows;
  }

  it('verifies the delivered migration checksum and the published revision column', async () => {
    const path = fileURLToPath(new URL('../../../../packages/db/prisma/migrations/20261123110000_seller_document_claim_evidence/migration.sql', import.meta.url));
    const expected = sha(readFileSync(path));
    const rows = await owner.$queryRaw<Array<{ checksum: string }>>`SELECT checksum FROM _prisma_migrations WHERE migration_name = '20261123110000_seller_document_claim_evidence'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].checksum).toBe(expected);
    const columns = await owner.$queryRaw<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name = 'claim_document_evidence' ORDER BY column_name`;
    expect(columns.map((row) => row.column_name)).toEqual([
      'binding_sha256', 'chunk_seq', 'chunk_text_sha256', 'claim_id', 'claim_statement_digest', 'claim_type',
      'company_id', 'created_at', 'document_content_sha256', 'document_id', 'evidence_id', 'id', 'parse_revision',
      'quote_end_byte', 'quote_start_byte', 'reference_version', 'request_digest', 'requester_id', 'source_document_id', 'workspace_id',
    ]);
  });

  it('reads bounded chunks and previews the server-rebuilt quote, binding hash and request digest', async () => {
    const tenant = await seedTenant();
    const read = await claims.readChunk(ctx(tenant.workspaceId, tenant.user), tenant.companyId, tenant.document.documentId, 0);
    expect(read).toMatchObject({ parseRevision: 1, chunkSeq: 0, text: tenant.document.text, context: { page: 1 } });
    const { start, end, quote } = quoteOf(tenant.document.text, '通过 ISO 9001 认证');
    const reference = { ...referenceFor(tenant.document), quoteStartByte: start, quoteEndByte: end };
    const preview = await claims.preview(ctx(tenant.workspaceId, tenant.user), tenant.companyId, tenant.document.documentId, {
      reference, type: 'certification', statement: '通过 ISO 9001 认证',
    });
    expect(preview.quote).toBe(quote);
    expect(preview.bindingHash).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    for (const bad of [
      { ...reference, documentContentHash: '0'.repeat(64) },
      { ...reference, parseRevision: 2 },
      { ...reference, chunkTextHash: '0'.repeat(64) },
      { ...reference, quoteStartByte: 1, quoteEndByte: start + 1 },
    ])
      await expect(claims.preview(ctx(tenant.workspaceId, tenant.user), tenant.companyId, tenant.document.documentId, { reference: bad, type: 'certification', statement: '通过 ISO 9001 认证' })).rejects.toMatchObject({ status: 409 });
  });

  it('creates one NEEDS_REVIEW draft atomically and replays the same origin across requesters', async () => {
    const tenant = await seedTenant();
    const { start, end } = quoteOf(tenant.document.text, '通过 ISO 9001 认证');
    const reference = { ...referenceFor(tenant.document), quoteStartByte: start, quoteEndByte: end };
    const first = await claims.createDraft(ctx(tenant.workspaceId, tenant.user), tenant.companyId, tenant.document.documentId, {
      reference, type: 'certification', statement: '通过 ISO 9001 认证', requestDigest: (await claims.preview(ctx(tenant.workspaceId, tenant.user), tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证' })).requestDigest,
    });
    expect(first).toMatchObject({ status: 'NEEDS_REVIEW', claimVersion: 1, replayed: false, available: true });
    const claim = await owner.claim.findUniqueOrThrow({ where: { id: first.claimId }, include: { evidence: true } });
    expect(claim.status).toBe('NEEDS_REVIEW');
    expect(claim.evidence[0]?.snippet).toBe('通过 ISO 9001 认证');
    expect(claim.evidence[0]?.sourceContentHash).toBe(tenant.document.contentHash);
    const referenceRow = await owner.claimDocumentEvidence.findUniqueOrThrow({ where: { claimId: first.claimId } });
    expect(referenceRow).toMatchObject({ parseRevision: 1, chunkSeq: 0, documentId: tenant.document.documentId, sourceDocumentId: tenant.document.documentId });
    expect(referenceRow.quoteStartByte).toBe(start);
    expect(referenceRow.quoteEndByte).toBe(end);
    const reviewer2 = randomUUID();
    const replay = await claims.createDraft(ctx(tenant.workspaceId, reviewer2), tenant.companyId, tenant.document.documentId, {
      reference, type: 'certification', statement: '通过 ISO 9001 认证', requestDigest: (await claims.preview(ctx(tenant.workspaceId, reviewer2), tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证' })).requestDigest,
    });
    expect(replay).toMatchObject({ claimId: first.claimId, evidenceId: first.evidenceId, referenceId: first.referenceId, replayed: true, status: 'NEEDS_REVIEW' });
    await expect(claims.createDraft(ctx(tenant.workspaceId, tenant.user), tenant.companyId, tenant.document.documentId, {
      reference, type: 'certification', statement: '通过 ISO 14001 认证', requestDigest: (await claims.preview(ctx(tenant.workspaceId, tenant.user), tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证' })).requestDigest,
    })).rejects.toMatchObject({ status: 409 });
  });

  it('requires expectedVersion and writes a v4 proof bound to the exact reference', async () => {
    const tenant = await seedTenant();
    const { start, end } = quoteOf(tenant.document.text, '通过 ISO 9001 认证');
    const reference = { ...referenceFor(tenant.document), quoteStartByte: start, quoteEndByte: end };
    const userCtx = ctx(tenant.workspaceId, tenant.user);
    const preview = await claims.preview(userCtx, tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证' });
    const draft = await claims.createDraft(userCtx, tenant.companyId, tenant.document.documentId, {
      reference, type: 'certification', statement: '通过 ISO 9001 认证', requestDigest: preview.requestDigest,
    });
    await expect(claimService.transition(userCtx, draft.claimId, 'APPROVED')).rejects.toMatchObject({ status: 400 });
    const approved = await claimService.transition(userCtx, draft.claimId, 'APPROVED', 1);
    expect(approved).toMatchObject({ status: 'APPROVED', version: 2, verifiedBy: tenant.user });
    const binding = await asApp(tenant.workspaceId, (tx) =>
      loadDocumentClaimBindingInTransaction(tx, { workspaceId: tenant.workspaceId, companyId: tenant.companyId }, approved),
    );
    expect(binding).not.toBeNull();
    expect(hasValidDocumentClaimApprovalAudit(approved, binding!)).toBe(true);
    expect((approved.verificationProof as { proofVersion?: number }).proofVersion).toBe(4);
    const effective = await asApp(tenant.workspaceId, (tx) =>
      effectiveApprovedClaimsInTransaction(tx, userCtx, tenant.companyId, {}, 'icp'),
    );
    expect(effective.claims.map((claim) => claim.id)).toContain(draft.claimId);
    expect(effective.dependencies.get(draft.claimId)).toMatchObject({ referenceId: draft.referenceId, bindingHash: draft.bindingHash });
    await expect(claimService.revoke(userCtx, draft.claimId)).rejects.toMatchObject({ status: 400 });
    const revoked = await claimService.revoke(userCtx, draft.claimId, 2);
    expect(revoked).toMatchObject({ status: 'REVOKED', version: 3 });
  });

  it('rejects a document claim without its expected version and accepts a versioned reject', async () => {
    const tenant = await seedTenant();
    const { start, end } = quoteOf(tenant.document.text, '通过 ISO 9001 认证');
    const reference = { ...referenceFor(tenant.document), quoteStartByte: start, quoteEndByte: end };
    const userCtx = ctx(tenant.workspaceId, tenant.user);
    const preview = await claims.preview(userCtx, tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证' });
    const draft = await claims.createDraft(userCtx, tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证', requestDigest: preview.requestDigest });
    await expect(claimService.transition(userCtx, draft.claimId, 'REVOKED')).rejects.toMatchObject({ status: 400 });
    expect(await claimService.transition(userCtx, draft.claimId, 'REVOKED', 1)).toMatchObject({ status: 'REVOKED', version: 2 });
  });

  it('lists a current NEEDS_REVIEW draft with its quote while approval consumption stays closed', async () => {
    const tenant = await seedTenant();
    const { start, end } = quoteOf(tenant.document.text, '通过 ISO 9001 认证');
    const reference = { ...referenceFor(tenant.document), quoteStartByte: start, quoteEndByte: end };
    const userCtx = ctx(tenant.workspaceId, tenant.user);
    const preview = await claims.preview(userCtx, tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证' });
    const draft = await claims.createDraft(userCtx, tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证', requestDigest: preview.requestDigest });
    const listed = (await claimService.listForCompany(userCtx, tenant.companyId)).find((claim) => claim.id === draft.claimId) as { statement: string | null; status: string; documentSource: { status: string }; evidence: Array<{ snippet: string | null }> };
    expect(listed.status).toBe('NEEDS_REVIEW');
    expect(listed.documentSource.status).toBe('CURRENT');
    expect(listed.statement).toBe('通过 ISO 9001 认证');
    expect(listed.evidence[0]?.snippet).toBe('通过 ISO 9001 认证');
    const effective = await asApp(tenant.workspaceId, (tx) =>
      effectiveApprovedClaimsInTransaction(tx, userCtx, tenant.companyId, {}, 'icp'),
    );
    expect(effective.claims.map((claim) => claim.id)).not.toContain(draft.claimId);
  });

  it('invalidates the binding immediately on reprocess and after document deletion (FK keeps identity)', async () => {
    const tenant = await seedTenant();
    const { start, end } = quoteOf(tenant.document.text, '通过 ISO 9001 认证');
    const reference = { ...referenceFor(tenant.document), quoteStartByte: start, quoteEndByte: end };
    const userCtx = ctx(tenant.workspaceId, tenant.user);
    const preview = await claims.preview(userCtx, tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证' });
    const draft = await claims.createDraft(userCtx, tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证', requestDigest: preview.requestDigest });
    await claimService.transition(userCtx, draft.claimId, 'APPROVED', 1);
    await owner.sellerDocument.update({ where: { id: tenant.document.documentId }, data: { status: 'processing' } });
    const listed = await claimService.listForCompany(userCtx, tenant.companyId);
    const unavailable = listed.find((claim) => claim.id === draft.claimId) as { statement: string | null; documentSource: { status: string }; evidence: Array<{ snippet: string | null }> };
    expect(unavailable.documentSource.status).toBe('UNAVAILABLE');
    expect(unavailable.statement).toBeNull();
    expect(unavailable.evidence[0]?.snippet).toBeNull();
    const effective = await asApp(tenant.workspaceId, (tx) =>
      effectiveApprovedClaimsInTransaction(tx, userCtx, tenant.companyId, {}, 'icp'),
    );
    expect(effective.claims.map((claim) => claim.id)).not.toContain(draft.claimId);
    expect(effective.rejectedDocumentClaimIds).toContain(draft.claimId);
    await owner.sellerDocument.delete({ where: { id: tenant.document.documentId } });
    const afterDelete = (await claimService.listForCompany(userCtx, tenant.companyId)).find((claim) => claim.id === draft.claimId) as { statement: string | null; documentSource: { status: string } };
    expect(afterDelete.documentSource.status).toBe('UNAVAILABLE');
    expect(afterDelete.statement).toBeNull();
    const referenceAfter = await owner.claimDocumentEvidence.findUniqueOrThrow({ where: { claimId: draft.claimId } });
    expect(referenceAfter.documentId).toBeNull();
    expect(referenceAfter.sourceDocumentId).toBe(tenant.document.documentId);
    expect(referenceAfter.workspaceId).toBe(tenant.workspaceId);
    const replay = await claims.createDraft(userCtx, tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证', requestDigest: preview.requestDigest }).catch(() => null);
    expect(replay).toBeNull();
  });

  it('keeps FORCE RLS and SELECT/INSERT-only grants for app_user', async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const { start, end } = quoteOf(tenantA.document.text, '通过 ISO 9001 认证');
    const reference = { ...referenceFor(tenantA.document), quoteStartByte: start, quoteEndByte: end };
    const userCtx = ctx(tenantA.workspaceId, tenantA.user);
    const preview = await claims.preview(userCtx, tenantA.companyId, tenantA.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证' });
    const draft = await claims.createDraft(userCtx, tenantA.companyId, tenantA.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证', requestDigest: preview.requestDigest });
    const hidden = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${tenantB.workspaceId}, true)`;
      return tx.claimDocumentEvidence.findMany({ where: { claimId: draft.claimId } });
    });
    expect(hidden).toHaveLength(0);
    const crossInsert = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${tenantA.workspaceId}, true)`;
      await tx.$executeRaw`INSERT INTO claim_document_evidence (id, workspace_id, company_id, claim_id, evidence_id, source_document_id, document_content_sha256, parse_revision, chunk_seq, chunk_text_sha256, quote_start_byte, quote_end_byte, claim_statement_digest, claim_type, binding_sha256, requester_id, request_digest)
        VALUES (${randomUUID()}::uuid, ${tenantB.workspaceId}::uuid, ${tenantB.companyId}::uuid, ${draft.claimId}::uuid, ${draft.evidenceId}::uuid, ${tenantB.document.documentId}::uuid, ${'a'.repeat(64)}, 1, 0, ${'b'.repeat(64)}, 0, 1, ${'c'.repeat(64)}, 'certification', ${'d'.repeat(64)}, ${randomUUID()}::uuid, ${'e'.repeat(64)})`;
    }).then(() => null).catch((error) => sqlState(error));
    expect(crossInsert).not.toBeNull();
    for (const statement of [
      () => app.$executeRaw`UPDATE claim_document_evidence SET claim_type = 'other' WHERE id = ${draft.referenceId}::uuid`,
      () => app.$executeRaw`DELETE FROM claim_document_evidence WHERE id = ${draft.referenceId}::uuid`,
    ]) {
      const state = await statement().then(() => null).catch((error) => sqlState(error));
      expect(state).toBe('42501');
    }
    const deleteDocument = await app.$executeRaw`DELETE FROM seller_document WHERE id = ${tenantA.document.documentId}::uuid`.then(() => null).catch((error) => sqlState(error));
    expect(deleteDocument).toBe('42501');
  });

  it('runs the internal seller document cleanup as app_user with real item counts and idempotent completion', async () => {
    const tenant = await seedTenant();
    const { start, end } = quoteOf(tenant.document.text, '通过 ISO 9001 认证');
    const reference = { ...referenceFor(tenant.document), quoteStartByte: start, quoteEndByte: end };
    const userCtx = ctx(tenant.workspaceId, tenant.user);
    const preview = await claims.preview(userCtx, tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证' });
    const draft = await claims.createDraft(userCtx, tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证', requestDigest: preview.requestDigest });
    await claimService.transition(userCtx, draft.claimId, 'APPROVED', 1);
    const request = await cleanupService.requestCleanup(userCtx, tenant.companyId, tenant.document.documentId);
    const deleted = { keys: [] as string[] };
    const activities = createDeletionActivities({
      prisma: appPrisma,
      sellerDocumentsStorage: { delete: async (key: string) => { deleted.keys.push(key); } },
    });
    const input = { workspaceId: tenant.workspaceId, deletionRequestId: request.requestId, subjectType: 'seller_document' as const, subjectId: tenant.document.documentId };
    const located = await activities.freezeSubject(input);
    expect(located).toMatchObject({ subjectType: 'seller_document', documentId: tenant.document.documentId, claimCount: 1, evidenceCount: 1, referenceCount: 1, chunkCount: 1 });
    const { final: progress } = await eraseUntilDone(activities, input, located);
    const counts = countsOf(progress);
    expect(counts).toMatchObject({ chunksErased: 1, claimsErased: 1, evidenceErased: 1, referencesErased: 1, blobDeleted: true, blobFailures: 0 });
    expect(deleted.keys).toHaveLength(1);
    expect(await owner.sellerDocumentChunk.count({ where: { documentId: tenant.document.documentId } })).toBe(0);
    expect(await owner.claim.count({ where: { id: draft.claimId } })).toBe(0);
    expect(await owner.evidence.count({ where: { id: draft.evidenceId } })).toBe(0);
    expect(await owner.claimDocumentEvidence.count({ where: { claimId: draft.claimId } })).toBe(0);
    const tombstone = await owner.sellerDocument.findUniqueOrThrow({ where: { id: tenant.document.documentId } });
    expect(tombstone.status).toBe('deleted');
    expect(tombstone.cleanupCompletedAt).toBeNull();
    const completed = await activities.completeDeletion({ input, located });
    expect(completed).toEqual(counts);
    const receipt = await owner.deletionReceipt.findUniqueOrThrow({ where: { deletionRequestId: request.requestId } });
    expect(receipt.subjectType).toBe('seller_document');
    expect(receipt.sellerDocumentDetail).toMatchObject({ documentId: tenant.document.documentId, claimsErased: 1, chunksErased: 1, blobDeleted: true });
    expect((await owner.deletionRequest.findUniqueOrThrow({ where: { id: request.requestId } })).status).toBe('COMPLETED');
    expect((await owner.sellerDocument.findUniqueOrThrow({ where: { id: tenant.document.documentId } })).cleanupCompletedAt).not.toBeNull();
    const events = await owner.outboxEvent.findMany({ where: { aggregateId: request.requestId, eventType: 'SellerDocumentCleanupCompleted' } });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ snapshot_version: 1, document_id: tenant.document.documentId, claims_erased: 1, blob_deleted: true });
    await expect(activities.completeDeletion({ input, located })).resolves.toEqual(counts);
    expect(await owner.outboxEvent.count({ where: { aggregateId: request.requestId, eventType: 'SellerDocumentCleanupCompleted' } })).toBe(1);
  });

  it('keeps ERASING residue on blob failure and completes only after a retry', async () => {
    const tenant = await seedTenant();
    const userCtx = ctx(tenant.workspaceId, tenant.user);
    const request = await cleanupService.requestCleanup(userCtx, tenant.companyId, tenant.document.documentId);
    const input = { workspaceId: tenant.workspaceId, deletionRequestId: request.requestId, subjectType: 'seller_document' as const, subjectId: tenant.document.documentId };
    const failing = createDeletionActivities({ prisma: appPrisma, sellerDocumentsStorage: { delete: async () => { throw new Error('object storage down'); } } });
    const located = await failing.freezeSubject(input);
    const failed = await eraseUntilDone(failing, input, located);
    const counts = countsOf(failed.final);
    expect(counts).toMatchObject({ blobDeleted: false, blobFailures: 1 });
    await expect(failing.completeDeletion({ input, located })).rejects.toThrow(/blob residue/);
    expect((await owner.deletionRequest.findUniqueOrThrow({ where: { id: request.requestId } })).status).toBe('ERASING');
    const healthy = createDeletionActivities({ prisma: appPrisma, sellerDocumentsStorage: { delete: async () => undefined } });
    const retried = countsOf((await eraseUntilDone(healthy, input, located)).final);
    expect(retried).toMatchObject({ chunksErased: 1, blobDeleted: true, blobFailures: 0 });
    await expect(healthy.completeDeletion({ input, located })).resolves.toMatchObject({ blobDeleted: true });
    expect((await owner.deletionReceipt.findUniqueOrThrow({ where: { deletionRequestId: request.requestId } })).sellerDocumentDetail).toMatchObject({ blobDeleted: true });
  });

  it('rejects a foreign cleanup request in the definer path', async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const request = await cleanupService.requestCleanup(ctx(tenantA.workspaceId, tenantA.user), tenantA.companyId, tenantA.document.documentId);
    const foreign = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${tenantB.workspaceId}, true)`;
      return tx.$queryRaw`SELECT erase_seller_document_cleanup_batch_v1(${tenantB.workspaceId}::uuid, ${request.requestId}::uuid, 'claims'::text, NULL::uuid, 100::int) AS counts`;
    }).then(() => null).catch((error) => error);
    expect(foreign).not.toBeNull();
  });

  it('binds the cleanup definer to the caller workspace even with a valid foreign frozen request', async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const requestB = await cleanupService.requestCleanup(ctx(tenantB.workspaceId, tenantB.user), tenantB.companyId, tenantB.document.documentId);
    const inputB = { workspaceId: tenantB.workspaceId, deletionRequestId: requestB.requestId, subjectType: 'seller_document' as const, subjectId: tenantB.document.documentId };
    const activitiesB = createDeletionActivities({ prisma: appPrisma, sellerDocumentsStorage: { delete: async () => undefined } });
    await activitiesB.freezeSubject(inputB);
    const cross = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${tenantA.workspaceId}, true)`;
      return tx.$queryRaw`SELECT erase_seller_document_cleanup_batch_v1(${tenantB.workspaceId}::uuid, ${requestB.requestId}::uuid, 'claims'::text, NULL::uuid, 100::int) AS counts`;
    }).then(() => null).catch((error) => sqlState(error));
    expect(cross).toBe('42501');
    expect(await owner.sellerDocumentChunk.count({ where: { documentId: tenantB.document.documentId } })).toBe(1);
    expect((await owner.deletionRequest.findUniqueOrThrow({ where: { id: requestB.requestId } })).status).toBe('FROZEN');
  });

  it('recovers a FAILED cleanup request that has no erasure counts yet', async () => {
    const tenant = await seedTenant();
    const { start, end } = quoteOf(tenant.document.text, '通过 ISO 9001 认证');
    const reference = { ...referenceFor(tenant.document), quoteStartByte: start, quoteEndByte: end };
    const userCtx = ctx(tenant.workspaceId, tenant.user);
    const preview = await claims.preview(userCtx, tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证' });
    const draft = await claims.createDraft(userCtx, tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证', requestDigest: preview.requestDigest });
    await claimService.transition(userCtx, draft.claimId, 'APPROVED', 1);
    const request = await cleanupService.requestCleanup(userCtx, tenant.companyId, tenant.document.documentId);
    const input = { workspaceId: tenant.workspaceId, deletionRequestId: request.requestId, subjectType: 'seller_document' as const, subjectId: tenant.document.documentId };
    const activities = createDeletionActivities({ prisma: appPrisma, sellerDocumentsStorage: { delete: async () => undefined } });
    await activities.freezeSubject(input);
    await owner.deletionRequest.update({ where: { id: request.requestId }, data: { status: 'FAILED' } });
    const restarted = createDeletionActivities({ prisma: appPrisma, sellerDocumentsStorage: { delete: async () => undefined } });
    const located = await restarted.freezeSubject(input);
    expect((await owner.deletionRequest.findUniqueOrThrow({ where: { id: request.requestId } })).status).toBe('FAILED');
    const counts = countsOf((await eraseUntilDone(restarted, input, located)).final);
    expect(counts).toMatchObject({ chunksErased: 1, claimsErased: 1, evidenceErased: 1, referencesErased: 1, blobDeleted: true });
    await expect(restarted.completeDeletion({ input, located })).resolves.toMatchObject({ blobDeleted: true });
    expect((await owner.deletionRequest.findUniqueOrThrow({ where: { id: request.requestId } })).status).toBe('COMPLETED');
  });

  it('erases a legacy cleanup snapshot with more than 512 claims in bounded batches', async () => {
    const tenant = await seedTenant();
    const claimsToSeed = 513;
    await seedCleanupClaims(tenant, claimsToSeed);
    const userCtx = ctx(tenant.workspaceId, tenant.user);
    const request = await cleanupService.requestCleanup(userCtx, tenant.companyId, tenant.document.documentId);
    const input = { workspaceId: tenant.workspaceId, deletionRequestId: request.requestId, subjectType: 'seller_document' as const, subjectId: tenant.document.documentId };
    const activities = createDeletionActivities({ prisma: appPrisma, sellerDocumentsStorage: { delete: async () => undefined } });
    const located = await activities.freezeSubject(input);
    expect(located).toMatchObject({ claimCount: claimsToSeed, evidenceCount: claimsToSeed, referenceCount: claimsToSeed });
    const first = (await activities.eraseSubject({ input, located })) as SellerDocumentEraseProgress;
    expect(first).toMatchObject({ claimsErased: 100, evidenceErased: 100, referencesErased: 100, done: false });
    // The batch counts and its continuation cursor are committed together, so a
    // restarted process resumes instead of replaying the whole frozen snapshot.
    const committed = await owner.deletionRequest.findUniqueOrThrow({ where: { id: request.requestId } });
    const committedStats = committed.stats as {
      sellerDocumentCounts?: { claimsErased?: number };
      sellerDocumentCursor?: { phase?: string; afterId?: string | null };
    };
    expect(committedStats.sellerDocumentCounts?.claimsErased).toBe(100);
    expect(committedStats.sellerDocumentCursor).toMatchObject({ phase: 'claims' });
    expect(typeof committedStats.sellerDocumentCursor?.afterId).toBe('string');
    const restarted = createDeletionActivities({ prisma: appPrisma, sellerDocumentsStorage: { delete: async () => undefined } });
    const { final, calls } = await eraseUntilDone(restarted, input, located);
    const progress = [first, ...calls];
    const deltas = progress.map((call, index) => call.claimsErased - (index === 0 ? 0 : progress[index - 1].claimsErased));
    expect(Math.max(...deltas)).toBeLessThanOrEqual(100);
    const counts = countsOf(final);
    expect(counts).toMatchObject({ claimsErased: claimsToSeed, evidenceErased: claimsToSeed, referencesErased: claimsToSeed, chunksErased: 1, blobDeleted: true });
    await expect(restarted.completeDeletion({ input, located })).resolves.toMatchObject({ blobDeleted: true });
    expect(await owner.claim.count({ where: { companyId: tenant.companyId } })).toBe(0);
    expect(await owner.claimDocumentEvidence.count({ where: { workspaceId: tenant.workspaceId } })).toBe(0);
  }, 90_000);

  it('keeps the binding digest stable and rejects tampered persisted facts', async () => {
    const tenant = await seedTenant();
    const { start, end } = quoteOf(tenant.document.text, '通过 ISO 9001 认证');
    const reference = { ...referenceFor(tenant.document), quoteStartByte: start, quoteEndByte: end };
    const userCtx = ctx(tenant.workspaceId, tenant.user);
    const preview = await claims.preview(userCtx, tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证' });
    const draft = await claims.createDraft(userCtx, tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证', requestDigest: preview.requestDigest });
    const expected = documentClaimBindingHash({
      documentId: tenant.document.documentId,
      documentContentHash: tenant.document.contentHash,
      parseRevision: 1,
      chunkSeq: 0,
      chunkTextHash: tenant.document.chunkTextHash,
      quoteStartByte: start,
      quoteEndByte: end,
      quoteDigest: sha('通过 ISO 9001 认证'),
      type: 'certification',
      statementDigest: documentClaimStatementDigest('通过 ISO 9001 认证'),
    });
    expect(draft.bindingHash).toBe(expected);
    await expect(owner.claimDocumentEvidence.update({ where: { claimId: draft.claimId }, data: { bindingSha256: '0'.repeat(64) } })).rejects.toThrow();
  });

  it('reports a stale document dependency under app_user after the source reprocesses', async () => {
    const tenant = await seedTenant();
    const { start, end } = quoteOf(tenant.document.text, '通过 ISO 9001 认证');
    const reference = { ...referenceFor(tenant.document), quoteStartByte: start, quoteEndByte: end };
    const userCtx = ctx(tenant.workspaceId, tenant.user);
    const preview = await claims.preview(userCtx, tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证' });
    const draft = await claims.createDraft(userCtx, tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证', requestDigest: preview.requestDigest });
    await claimService.transition(userCtx, draft.claimId, 'APPROVED', 1);
    const effective = await asApp(tenant.workspaceId, (tx) =>
      effectiveApprovedClaimsInTransaction(tx, userCtx, tenant.companyId, {}, 'icp'),
    );
    const dependencies = [...effective.dependencies.values()];
    expect(dependencies).toHaveLength(1);
    expect(
      await asApp(tenant.workspaceId, (tx) =>
        documentClaimDependenciesStillCurrent(tx, { workspaceId: tenant.workspaceId, companyId: tenant.companyId }, dependencies),
      ),
    ).toBe(true);
    await owner.sellerDocument.update({ where: { id: tenant.document.documentId }, data: { status: 'processing' } });
    expect(
      await asApp(tenant.workspaceId, (tx) =>
        documentClaimDependenciesStillCurrent(tx, { workspaceId: tenant.workspaceId, companyId: tenant.companyId }, dependencies),
      ),
    ).toBe(false);
  });

  it('refuses to erase a request that already carries erasure counts', async () => {
    const tenant = await seedTenant();
    const userCtx = ctx(tenant.workspaceId, tenant.user);
    const request = await cleanupService.requestCleanup(userCtx, tenant.companyId, tenant.document.documentId);
    const input = { workspaceId: tenant.workspaceId, deletionRequestId: request.requestId, subjectType: 'seller_document' as const, subjectId: tenant.document.documentId };
    const activities = createDeletionActivities({ prisma: appPrisma, sellerDocumentsStorage: { delete: async () => undefined } });
    await activities.freezeSubject(input);
    const frozen = await owner.deletionRequest.findUniqueOrThrow({ where: { id: request.requestId } });
    await owner.deletionRequest.update({
      where: { id: request.requestId },
      data: {
        status: 'FAILED',
        stats: {
          ...(frozen.stats as Record<string, unknown>),
          sellerDocumentCounts: { chunksErased: 1, claimsErased: 1, evidenceErased: 1, referencesErased: 1, knowledgeSourcesErased: 0, blobDeleted: false, blobFailures: 1 },
        } as Prisma.InputJsonValue,
      },
    });
    const state = await asApp(tenant.workspaceId, (tx) =>
      tx.$queryRaw`SELECT erase_seller_document_cleanup_batch_v1(${tenant.workspaceId}::uuid, ${request.requestId}::uuid, 'claims'::text, NULL::uuid, 100::int) AS counts`,
    ).then(() => null).catch((error) => sqlState(error));
    expect(state).toBe('42501');
    expect(await owner.sellerDocumentChunk.count({ where: { documentId: tenant.document.documentId } })).toBe(1);
    expect((await owner.deletionRequest.findUniqueOrThrow({ where: { id: request.requestId } })).status).toBe('FAILED');
  });

  it('refuses to erase a document that is not soft-deleted', async () => {
    const tenant = await seedTenant();
    const userCtx = ctx(tenant.workspaceId, tenant.user);
    const request = await cleanupService.requestCleanup(userCtx, tenant.companyId, tenant.document.documentId);
    const input = { workspaceId: tenant.workspaceId, deletionRequestId: request.requestId, subjectType: 'seller_document' as const, subjectId: tenant.document.documentId };
    const activities = createDeletionActivities({ prisma: appPrisma, sellerDocumentsStorage: { delete: async () => undefined } });
    await activities.freezeSubject(input);
    await owner.sellerDocument.update({
      where: { id: tenant.document.documentId },
      data: { status: 'ready', deletedAt: null, deletedBy: null },
    });
    const state = await asApp(tenant.workspaceId, (tx) =>
      tx.$queryRaw`SELECT erase_seller_document_cleanup_batch_v1(${tenant.workspaceId}::uuid, ${request.requestId}::uuid, 'claims'::text, NULL::uuid, 100::int) AS counts`,
    ).then(() => null).catch((error) => sqlState(error));
    expect(state).toBe('42501');
    expect(await owner.sellerDocumentChunk.count({ where: { documentId: tenant.document.documentId } })).toBe(1);
    expect((await owner.deletionRequest.findUniqueOrThrow({ where: { id: request.requestId } })).status).toBe('FROZEN');
  });

  it('does not erase a claim that the frozen snapshot does not bind to the document', async () => {
    const tenant = await seedTenant();
    const { start, end } = quoteOf(tenant.document.text, '通过 ISO 9001 认证');
    const reference = { ...referenceFor(tenant.document), quoteStartByte: start, quoteEndByte: end };
    const userCtx = ctx(tenant.workspaceId, tenant.user);
    const preview = await claims.preview(userCtx, tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证' });
    const draft = await claims.createDraft(userCtx, tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证', requestDigest: preview.requestDigest });
    await claimService.transition(userCtx, draft.claimId, 'APPROVED', 1);
    const foreignClaimId = randomUUID();
    const foreignEvidenceId = randomUUID();
    await owner.claim.create({
      data: { id: foreignClaimId, workspaceId: tenant.workspaceId, companyId: tenant.companyId, type: 'certification', statement: 'unrelated legacy claim', status: 'NEEDS_REVIEW', version: 1 },
    });
    await owner.evidence.create({
      data: { id: foreignEvidenceId, workspaceId: tenant.workspaceId, claimId: foreignClaimId, snippet: 'unrelated legacy claim' },
    });
    const request = await cleanupService.requestCleanup(userCtx, tenant.companyId, tenant.document.documentId);
    const input = { workspaceId: tenant.workspaceId, deletionRequestId: request.requestId, subjectType: 'seller_document' as const, subjectId: tenant.document.documentId };
    const activities = createDeletionActivities({ prisma: appPrisma, sellerDocumentsStorage: { delete: async () => undefined } });
    await activities.freezeSubject(input);
    const frozen = await owner.deletionRequest.findUniqueOrThrow({ where: { id: request.requestId } });
    await owner.deletionRequest.update({
      where: { id: request.requestId },
      data: {
        stats: {
          ...(frozen.stats as Record<string, unknown>),
          claimIds: [...(frozen.stats as { claimIds: string[] }).claimIds, foreignClaimId],
          evidenceIds: [...(frozen.stats as { evidenceIds: string[] }).evidenceIds, foreignEvidenceId],
        } as Prisma.InputJsonValue,
      },
    });
    const [row] = await asApp(tenant.workspaceId, (tx) =>
      tx.$queryRaw<Array<{ counts: { claimsErased: number; evidenceErased: number; referencesErased: number } }>>`
        SELECT erase_seller_document_cleanup_batch_v1(${tenant.workspaceId}::uuid, ${request.requestId}::uuid, 'claims'::text, NULL::uuid, 100::int) AS counts`,
    );
    expect(row.counts).toMatchObject({ claimsErased: 1, evidenceErased: 1, referencesErased: 1 });
    expect(await owner.claim.count({ where: { id: draft.claimId } })).toBe(0);
    expect(await owner.claim.count({ where: { id: foreignClaimId } })).toBe(1);
    expect(await owner.evidence.count({ where: { id: foreignEvidenceId } })).toBe(1);
  });

  it('serializes overlapping continuations so committed counts are never overwritten', async () => {
    const tenant = await seedTenant();
    const claimsToSeed = 150;
    await seedCleanupClaims(tenant, claimsToSeed);
    const userCtx = ctx(tenant.workspaceId, tenant.user);
    const request = await cleanupService.requestCleanup(userCtx, tenant.companyId, tenant.document.documentId);
    const input = { workspaceId: tenant.workspaceId, deletionRequestId: request.requestId, subjectType: 'seller_document' as const, subjectId: tenant.document.documentId };
    const activities = createDeletionActivities({ prisma: appPrisma, sellerDocumentsStorage: { delete: async () => undefined } });
    const located = await activities.freezeSubject(input);
    const first = (await activities.eraseSubject({ input, located })) as SellerDocumentEraseProgress;
    expect(first).toMatchObject({ claimsErased: 100, done: false });
    let releaseHolder!: () => void;
    const holderRelease = new Promise<void>((resolve) => (releaseHolder = resolve));
    let holderLocked!: () => void;
    const holderReady = new Promise<void>((resolve) => (holderLocked = resolve));
    let holderIdentity: { pid: number; xid: string } | undefined;
    const holder = owner.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM deletion_request WHERE id = ${request.requestId}::uuid FOR UPDATE`;
      const [identity] = await tx.$queryRaw<Array<{ pid: number; xid: string }>>`
        SELECT pg_backend_pid() AS pid, pg_current_xact_id()::xid::text AS xid`;
      holderIdentity = identity;
      holderLocked();
      await holderRelease;
    }, { timeout: 60_000 });
    await holderReady;
    const waitingBackends = async (queryLike: string) =>
      owner.$queryRaw<Array<{ pid: number; xid: string | null }>>`
        SELECT pid, backend_xid::text AS xid FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ${queryLike}`;
    const blockedBy = async (pid: number) =>
      owner.$queryRaw<Array<{ locktype: string; xid: string | null; relation: string | null }>>`
        SELECT locktype, transactionid::text AS xid, relation::regclass::text AS relation
          FROM pg_locks WHERE pid = ${pid} AND NOT granted`;
    // An unrelated row-lock waiter runs throughout: the barrier must bind to the
    // two target backends and their blocker, never to a global waiter count that
    // another session could satisfy before either continuation has queued.
    const unrelatedCompany = await owner.canonicalCompany.create({
      data: { workspaceId: tenant.workspaceId, name: 'Synthetic overlap unrelated waiter', dedupeKey: randomUUID() },
    });
    const unrelatedHeld = deferred();
    const releaseUnrelated = deferred();
    const unrelatedHolder = owner.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM canonical_company WHERE id = ${unrelatedCompany.id}::uuid FOR UPDATE`;
      unrelatedHeld.resolve();
      await releaseUnrelated.promise;
    }, { timeout: 60_000 });
    await unrelatedHeld.promise;
    const unrelatedWaiter = owner.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM canonical_company WHERE id = ${unrelatedCompany.id}::uuid FOR UPDATE`;
      await releaseUnrelated.promise;
    }, { timeout: 60_000 });
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if ((await waitingBackends('%canonical_company%FOR UPDATE%')).length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(await waitingBackends('%canonical_company%FOR UPDATE%')).toHaveLength(1);
    // Two continuations of the same request overlap. Neither may read progress
    // before the other commits, or one overwrites the other's counts.
    const left = activities.eraseSubject({ input, located }) as Promise<SellerDocumentEraseProgress>;
    const right = activities.eraseSubject({ input, located }) as Promise<SellerDocumentEraseProgress>;
    let progressWaiters: Array<{ pid: number; xid: string | null }> = [];
    for (let attempt = 0; attempt < 400; attempt += 1) {
      progressWaiters = await waitingBackends('%deletion_request%FOR UPDATE%');
      if (progressWaiters.length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(progressWaiters).toHaveLength(2);
    const [heldRow] = await owner.$queryRaw<Array<{ xmax: string }>>`
      SELECT xmax::text AS xmax FROM deletion_request WHERE id = ${request.requestId}::uuid`;
    expect(heldRow.xmax).toBe(holderIdentity?.xid);
    for (const waiter of progressWaiters) {
      const locks = await blockedBy(waiter.pid);
      // The row lock surfaces either as a transactionid wait on the holder's xid
      // or as a tuple wait on the target relation; both bind the real backend to
      // this request row.
      const blockedByHolder = locks.some((lock) => lock.locktype === 'transactionid' && lock.xid === holderIdentity?.xid);
      const blockedOnRequestTuple = locks.some((lock) => lock.locktype === 'tuple' && lock.relation === 'deletion_request');
      expect(blockedByHolder || blockedOnRequestTuple).toBe(true);
    }
    // Both continuations wait on the progress-row lock, not inside the definer.
    expect(await waitingBackends('%erase_seller_document_cleanup_batch_v1%')).toHaveLength(0);
    releaseHolder();
    await holder;
    releaseUnrelated.resolve();
    await Promise.all([unrelatedHolder, unrelatedWaiter]);
    await Promise.all([left, right]);
    const raced = await owner.deletionRequest.findUniqueOrThrow({ where: { id: request.requestId } });
    const racedCounts = (raced.stats as { sellerDocumentCounts?: { claimsErased?: number } }).sellerDocumentCounts;
    expect(racedCounts?.claimsErased ?? 0).toBeGreaterThanOrEqual(100);
    const final = countsOf((await eraseUntilDone(activities, input, located)).final);
    expect(final).toMatchObject({ claimsErased: claimsToSeed, blobDeleted: true });
    await expect(activities.completeDeletion({ input, located })).resolves.toMatchObject({ blobDeleted: true });
  }, 60_000);

  it('completes a legacy cleanup whose erasure finished but carries no cursor', async () => {
    const tenant = await seedTenant();
    const { start, end } = quoteOf(tenant.document.text, '通过 ISO 9001 认证');
    const reference = { ...referenceFor(tenant.document), quoteStartByte: start, quoteEndByte: end };
    const userCtx = ctx(tenant.workspaceId, tenant.user);
    const preview = await claims.preview(userCtx, tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证' });
    const draft = await claims.createDraft(userCtx, tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证', requestDigest: preview.requestDigest });
    await claimService.transition(userCtx, draft.claimId, 'APPROVED', 1);
    const request = await cleanupService.requestCleanup(userCtx, tenant.companyId, tenant.document.documentId);
    const input = { workspaceId: tenant.workspaceId, deletionRequestId: request.requestId, subjectType: 'seller_document' as const, subjectId: tenant.document.documentId };
    const activities = createDeletionActivities({ prisma: appPrisma, sellerDocumentsStorage: { delete: async () => undefined } });
    const located = await activities.freezeSubject(input);
    // Old whole-snapshot erasure had already removed every frozen target; only
    // the blob obligation remained and no cursor was ever written.
    await owner.$executeRaw`DELETE FROM claim_document_evidence WHERE claim_id = ${draft.claimId}::uuid`;
    await owner.$executeRaw`DELETE FROM evidence WHERE claim_id = ${draft.claimId}::uuid`;
    await owner.$executeRaw`DELETE FROM claim WHERE id = ${draft.claimId}::uuid`;
    await owner.$executeRaw`DELETE FROM seller_document_chunk WHERE document_id = ${tenant.document.documentId}::uuid`;
    const frozen = await owner.deletionRequest.findUniqueOrThrow({ where: { id: request.requestId } });
    await owner.deletionRequest.update({
      where: { id: request.requestId },
      data: {
        status: 'ERASING',
        stats: {
          ...(frozen.stats as Record<string, unknown>),
          sellerDocumentCounts: { chunksErased: 1, claimsErased: 1, evidenceErased: 1, referencesErased: 1, knowledgeSourcesErased: 0, blobDeleted: false, blobFailures: 1 },
        } as Prisma.InputJsonValue,
      },
    });
    const result = await eraseUntilDone(activities, input, located);
    expect(countsOf(result.final)).toMatchObject({ claimsErased: 1, blobDeleted: true });
    // Blob-only retry: the erased legacy request never re-enters the definer.
    expect(result.calls).toHaveLength(1);
    await expect(activities.completeDeletion({ input, located })).resolves.toMatchObject({ blobDeleted: true });
    expect((await owner.deletionRequest.findUniqueOrThrow({ where: { id: request.requestId } })).status).toBe('COMPLETED');
  });

  it('refuses legacy counts that disagree with the frozen snapshot', async () => {
    const tenant = await seedTenant();
    const { start, end } = quoteOf(tenant.document.text, '通过 ISO 9001 认证');
    const reference = { ...referenceFor(tenant.document), quoteStartByte: start, quoteEndByte: end };
    const userCtx = ctx(tenant.workspaceId, tenant.user);
    const preview = await claims.preview(userCtx, tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证' });
    const draft = await claims.createDraft(userCtx, tenant.companyId, tenant.document.documentId, { reference, type: 'certification', statement: '通过 ISO 9001 认证', requestDigest: preview.requestDigest });
    await claimService.transition(userCtx, draft.claimId, 'APPROVED', 1);
    const request = await cleanupService.requestCleanup(userCtx, tenant.companyId, tenant.document.documentId);
    const input = { workspaceId: tenant.workspaceId, deletionRequestId: request.requestId, subjectType: 'seller_document' as const, subjectId: tenant.document.documentId };
    const activities = createDeletionActivities({ prisma: appPrisma, sellerDocumentsStorage: { delete: async () => undefined } });
    const located = await activities.freezeSubject(input);
    const frozen = await owner.deletionRequest.findUniqueOrThrow({ where: { id: request.requestId } });
    await owner.deletionRequest.update({
      where: { id: request.requestId },
      data: {
        status: 'ERASING',
        stats: {
          ...(frozen.stats as Record<string, unknown>),
          sellerDocumentCounts: { chunksErased: 0, claimsErased: 0, evidenceErased: 0, referencesErased: 0, knowledgeSourcesErased: 0, blobDeleted: false, blobFailures: 0 },
        } as Prisma.InputJsonValue,
      },
    });
    await expect(activities.eraseSubject({ input, located })).rejects.toThrow(/do not match the frozen snapshot/);
    expect(await owner.claim.count({ where: { id: draft.claimId } })).toBe(1);
  });

  it('rejects a NULL cleanup phase without deleting targets', async () => {
    const tenant = await seedTenant();
    const userCtx = ctx(tenant.workspaceId, tenant.user);
    const request = await cleanupService.requestCleanup(userCtx, tenant.companyId, tenant.document.documentId);
    const input = { workspaceId: tenant.workspaceId, deletionRequestId: request.requestId, subjectType: 'seller_document' as const, subjectId: tenant.document.documentId };
    const activities = createDeletionActivities({ prisma: appPrisma, sellerDocumentsStorage: { delete: async () => undefined } });
    await activities.freezeSubject(input);
    const state = await asApp(tenant.workspaceId, (tx) =>
      tx.$queryRaw`SELECT erase_seller_document_cleanup_batch_v1(${tenant.workspaceId}::uuid, ${request.requestId}::uuid, NULL::text, NULL::uuid, 100::int) AS batch`,
    ).then(() => null).catch((error) => sqlState(error));
    expect(state).toBe('42501');
    expect(await owner.sellerDocumentChunk.count({ where: { documentId: tenant.document.documentId } })).toBe(1);
    expect((await owner.deletionRequest.findUniqueOrThrow({ where: { id: request.requestId } })).status).toBe('FROZEN');
  });

  it('pins the delivered S1a follow-up migration checksums', async () => {
    for (const name of ['20261124020000_seller_document_claim_s1a_followup', '20261124030000_seller_document_cleanup_batch', '20261124040000_seller_document_cleanup_null_phase']) {
      const path = fileURLToPath(new URL(`../../../../packages/db/prisma/migrations/${name}/migration.sql`, import.meta.url));
      const expected = sha(readFileSync(path));
      const rows = await owner.$queryRaw<Array<{ checksum: string }>>`SELECT checksum FROM _prisma_migrations WHERE migration_name = ${name}`;
      expect(rows).toHaveLength(1);
      expect(rows[0].checksum).toBe(expected);
    }
  });
});
