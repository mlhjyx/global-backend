import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { MarketCandidateSetsService } from './market-candidate-sets.service';
import { documentHash } from './market-candidate-set.document';
import type { RequestContext } from '../auth/request-context';
import { Module, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { AuthGuard } from '../auth/auth.guard';
import { ScopesGuard } from '../auth/scopes.guard';
import { TokenVerifier } from '../auth/token-verifier';
import { createRolesToScopesPolicy, ROLES_TO_SCOPES_POLICY } from '../auth/scopes';
import { GlobalHttpExceptionFilter } from '../common/http-exception.filter';
import { MarketCandidateSetsController } from './market-candidate-sets.controller';
import { ClaimService } from '../claim/claim.service';

const enabled = process.env.MARKET_CANDIDATES_DATABASE_TEST === '1';
const ownerUrl = process.env.MARKET_CANDIDATES_TEST_DATABASE_URL;
const appUrl = process.env.MARKET_CANDIDATES_TEST_APP_DATABASE_URL;
if (enabled && (!ownerUrl || !appUrl)) throw new Error('B1 requires both disposable owner and app_user URLs');
if (Boolean(ownerUrl) !== Boolean(appUrl)) throw new Error('B1 requires paired disposable URLs');
const urls = [ownerUrl, appUrl].flatMap(v => v ? [new URL(v)] : []);
for (const url of urls) {
  if (url.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== '/global_test' || url.search || url.hash) throw new Error('B1 requires a loopback disposable global_test database without URL overrides');
}
if (urls.length === 2 && (urls[0].host !== urls[1].host || urls[1].username !== 'app_user' || urls[0].username === 'app_user')) throw new Error('B1 requires a distinct owner and actual app_user on the same disposable database');

describe.runIf(enabled)('B1 market candidate persistence on restricted PostgreSQL', { timeout: 60_000 }, () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  const workspaceId = randomUUID(), otherWorkspace = randomUUID(), companyId = randomUUID(), otherCompany = randomUUID(), actorId = randomUUID();
  async function tenant<T>(run: (tx: Prisma.TransactionClient) => Promise<T>, workspace = workspaceId): Promise<T> {
    return app.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('app.current_workspace_id',${workspace},true)`;
      return run(tx);
    });
  }
  async function initial(tx: Prisma.TransactionClient, id = randomUUID()) {
    const document = { schemaVersion: 'market-candidate-set/v1', setId: id, companyId, revision: 1,
      basisSnapshot: { company: { companyId, version: 1 }, sources: [] }, generationOutcome: 'COMPLETED_EMPTY', candidates: [] };
    const json = JSON.stringify(document), hash = createHash('sha256').update(json).digest('hex');
    await tx.$executeRaw`INSERT INTO market_candidate_set(id,workspace_id,company_id,current_revision,initial_operation_id,initial_request_hash)
      VALUES (${id}::uuid,${workspaceId}::uuid,${companyId}::uuid,1,${randomUUID()}::uuid,${hash})`;
    await tx.$executeRaw`INSERT INTO market_candidate_set_revision(workspace_id,company_id,set_id,revision,parent_revision,document_json,document_hash,created_by)
      VALUES (${workspaceId}::uuid,${companyId}::uuid,${id}::uuid,1,NULL,${json}::jsonb,${hash},${actorId}::uuid)`;
    return id;
  }
  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    app = new PrismaClient({ datasourceUrl: appUrl });
    await Promise.all([owner.$connect(), app.$connect()]);
    await owner.workspace.createMany({ data: [{ id: workspaceId }, { id: otherWorkspace }] });
    await owner.companyProfile.createMany({ data: [
      { id: companyId, workspaceId, name: 'SYNTHETIC B1 seller' },
      { id: otherCompany, workspaceId: otherWorkspace, name: 'SYNTHETIC other tenant' },
    ] });
  });
  afterAll(async () => {
    if (owner) await owner.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspace] } } });
    await Promise.allSettled([owner?.$disconnect(), app?.$disconnect()]);
  });

  it('schema provides all three FORCE RLS tables under a non-bypass app_user', async () => {
    const tables = await owner.$queryRaw<{ name: string; rls: boolean; force: boolean }[]>`
      SELECT relname AS name, relrowsecurity AS rls, relforcerowsecurity AS force
      FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace
      AND relname IN ('market_candidate_set','market_candidate_set_revision','market_candidate_feedback') ORDER BY relname`;
    expect(tables).toEqual([
      { name: 'market_candidate_feedback', rls: true, force: true },
      { name: 'market_candidate_set', rls: true, force: true },
      { name: 'market_candidate_set_revision', rls: true, force: true },
    ]);
    const [principal] = await app.$queryRaw<{ name: string; super: boolean; bypass: boolean }[]>`
      SELECT current_user AS name, rolsuper AS super, rolbypassrls AS bypass FROM pg_catalog.pg_roles WHERE rolname=current_user`;
    expect(principal).toEqual({ name: 'app_user', super: false, bypass: false });
  });

  it('hides persisted rows without context and from a different workspace', async () => {
    const id = await tenant(tx => initial(tx));
    expect(await app.$queryRaw`SELECT id FROM market_candidate_set WHERE id=${id}::uuid`).toEqual([]);
    expect(await tenant(tx => tx.$queryRaw`SELECT id FROM market_candidate_set WHERE id=${id}::uuid`, otherWorkspace)).toEqual([]);
    expect(await tenant(tx => tx.$queryRaw`SELECT revision FROM market_candidate_set_revision WHERE set_id=${id}::uuid`)).toEqual([{ revision: 1 }]);
    await expect(tenant(tx => initial(tx), otherWorkspace)).rejects.toThrow(/row-level security/u);
    await expect(initial(app as unknown as Prisma.TransactionClient)).rejects.toThrow(/row-level security/u);
  });

  it('rejects a same-workspace header referencing another tenant company through the composite FK', async () => {
    await expect(tenant(tx => tx.$executeRaw`INSERT INTO market_candidate_set(id,workspace_id,company_id,current_revision,initial_operation_id,initial_request_hash)
      VALUES (${randomUUID()}::uuid,${workspaceId}::uuid,${otherCompany}::uuid,1,${randomUUID()}::uuid,${'a'.repeat(64)})`)).rejects.toThrow(/foreign key/u);
  });

  it('refuses app_user UPDATE, DELETE and TRUNCATE on immutable history even when no row matches', async () => {
    await expect(tenant(tx => tx.$executeRaw`UPDATE market_candidate_set_revision SET document_hash=${'b'.repeat(64)} WHERE false`)).rejects.toThrow(/permission denied/u);
    await expect(tenant(tx => tx.$executeRaw`DELETE FROM market_candidate_set_revision WHERE false`)).rejects.toThrow(/permission denied/u);
    await expect(tenant(tx => tx.$executeRaw`TRUNCATE market_candidate_set_revision`)).rejects.toThrow(/permission denied/u);
    await expect(tenant(tx => tx.$executeRaw`UPDATE market_candidate_feedback SET reason='forged' WHERE false`)).rejects.toThrow(/permission denied/u);
    await expect(tenant(tx => tx.$executeRaw`DELETE FROM market_candidate_feedback WHERE false`)).rejects.toThrow(/permission denied/u);
    await expect(tenant(tx => tx.$executeRaw`TRUNCATE market_candidate_feedback`)).rejects.toThrow(/permission denied/u);
    await expect(tenant(tx => tx.$executeRaw`UPDATE market_candidate_set SET company_id=${otherCompany}::uuid WHERE false`)).rejects.toThrow(/permission denied/u);
    await expect(tenant(tx => tx.$executeRaw`DELETE FROM market_candidate_set WHERE false`)).rejects.toThrow(/permission denied/u);
    await expect(tenant(tx => tx.$executeRaw`TRUNCATE market_candidate_set`)).rejects.toThrow(/permission denied/u);
  });

  it('rejects missing initial revisions, jumps and unpaired pointer advances at commit', async () => {
    const incomplete = randomUUID();
    await expect(tenant(tx => tx.$executeRaw`INSERT INTO market_candidate_set(id,workspace_id,company_id,current_revision,initial_operation_id,initial_request_hash)
      VALUES (${incomplete}::uuid,${workspaceId}::uuid,${companyId}::uuid,1,${randomUUID()}::uuid,${'a'.repeat(64)})`)).rejects.toThrow();
    expect(await owner.$queryRaw`SELECT id FROM market_candidate_set WHERE id=${incomplete}::uuid`).toEqual([]);
    const id = await tenant(tx => initial(tx));
    await expect(tenant(tx => tx.$executeRaw`UPDATE market_candidate_set SET current_revision=3 WHERE id=${id}::uuid`)).rejects.toThrow(/MARKET_CANDIDATE_REVISION_STEP/u);
    await expect(tenant(tx => tx.$executeRaw`UPDATE market_candidate_set SET current_revision=2 WHERE id=${id}::uuid`)).rejects.toThrow();
    expect(await tenant(tx => tx.$queryRaw`SELECT current_revision FROM market_candidate_set WHERE id=${id}::uuid`)).toEqual([{ current_revision: 1 }]);
  });

  it('does not permit absent JSON fields to pass a nullable SQL CHECK', async () => {
    const id = randomUUID();
    await expect(tenant(async tx => {
      await tx.$executeRaw`INSERT INTO market_candidate_set(id,workspace_id,company_id,current_revision,initial_operation_id,initial_request_hash)
        VALUES (${id}::uuid,${workspaceId}::uuid,${companyId}::uuid,1,${randomUUID()}::uuid,${'a'.repeat(64)})`;
      await tx.$executeRaw`INSERT INTO market_candidate_set_revision(workspace_id,company_id,set_id,revision,parent_revision,document_json,document_hash,created_by)
        VALUES (${workspaceId}::uuid,${companyId}::uuid,${id}::uuid,1,NULL,'{}'::jsonb,${'a'.repeat(64)},${actorId}::uuid)`;
    })).rejects.toThrow();
    expect(await owner.$queryRaw`SELECT id FROM market_candidate_set WHERE id=${id}::uuid`).toEqual([]);
  });

  const context = (): RequestContext => ({ workspaceId, userId: actorId, roles: [] });
  async function fixture() {
    const company = await owner.companyProfile.create({ data: { workspaceId, name: 'SYNTHETIC B1 isolated seller' } });
    const offering = await owner.offering.create({ data: { workspaceId, companyId: company.id, name: 'SYNTHETIC HJT cells', description: 'SYNTHETIC cells, not equipment', attributes: { synthetic: true } } });
    const claim = await owner.claim.create({ data: { workspaceId, companyId: company.id, type: 'capability', statement: 'SYNTHETIC seller assertion only', status: 'NEEDS_REVIEW' } });
    const evidence = await owner.evidence.create({ data: { workspaceId, claimId: claim.id, sourceContentHash: 'a'.repeat(64), snippet: 'SYNTHETIC123', quoteStart: 0, quoteEnd: 12, fetchedAt: new Date('2026-11-19T00:00:00Z') } });
    const document = await owner.sellerDocument.create({ data: { workspaceId, companyId: company.id, uploadedBy: actorId, filename: 'SYNTHETIC.txt', mime: 'text/plain', sizeBytes: 42n, kind: 'txt', objectKey: `SYNTHETIC/${randomUUID()}`, contentHash: 'b'.repeat(64), status: 'ready', chunkCount: 1 } });
    const chunk = await owner.sellerDocumentChunk.create({ data: { workspaceId, documentId: document.id, seq: 0, text: 'SYNTHETIC source text, never copied into the snapshot', meta: { page: 2, section: 'SYNTHETIC test section' } } });
    const sources = [
      { kind: 'OFFERING', sourceId: offering.id }, { kind: 'CLAIM', sourceId: claim.id },
      { kind: 'EVIDENCE', sourceId: evidence.id }, { kind: 'SELLER_DOCUMENT', sourceId: document.id },
      { kind: 'SELLER_DOCUMENT_CHUNK', sourceId: chunk.id },
    ];
    const statement = (text: string, knowledgeState = 'INFERENCE') => ({ text, knowledgeState, basisKeys: sources.map(s => `${s.kind}:${s.sourceId}`), impact: 'SYNTHETIC purchasing relation unverified' });
    const proposal = { supplyOrCapability: { offeringId: offering.id, description: 'SYNTHETIC HJT cells, not equipment' }, buyerOrganizationCountry: 'DE', projectCountry: 'FR',
      application: statement('SYNTHETIC module assembly'), organizationRole: statement('SYNTHETIC generic job or award alone cannot prove a buyer', 'UNKNOWN'), fitExplanation: statement('SYNTHETIC possible input, not a verified buyer'),
      entryConditions: [statement('SYNTHETIC certification missing', 'UNKNOWN')], support: [statement('SYNTHETIC seller claims supply', 'SELLER_ASSERTION')],
      counterEvidence: [statement('SYNTHETIC conflicting supply limit', 'CONFLICT')], gaps: [statement('SYNTHETIC no independent market evidence', 'UNKNOWN')],
      recommendation: { status: 'CONDITIONAL', reason: 'SYNTHETIC verification required' }, nextVerification: ['SYNTHETIC verify purchasing object'] };
    const alternative = structuredClone(proposal); alternative.projectCountry = null as unknown as string;
    alternative.application = statement('SYNTHETIC agriculture'); alternative.recommendation = { status: 'NOT_RECOMMENDED', reason: 'SYNTHETIC counter-evidence' };
    return { companyId: company.id, offering, claim, evidence, document, chunk,
      draft: { generationOutcome: 'CANDIDATES_PROPOSED', sources, candidates: [{ proposal }, { proposal: alternative }] } };
  }
  async function usingService<T>(run: (service: MarketCandidateSetsService, prisma: PrismaService) => Promise<T>): Promise<T> {
    const prisma = new PrismaService();
    try { return await run(new MarketCandidateSetsService(prisma), prisma); }
    finally { await prisma.$disconnect(); }
  }
  async function seeded() {
    const fx = await fixture();
    const stored = await usingService(service => service.persistInitial(context(), fx.companyId, fx.draft, randomUUID()));
    const read = await usingService(service => service.getCurrent(context(), stored.setId));
    return { ...fx, stored, read, candidateId: read.document.candidates[0].candidateId };
  }

  async function jsonbBytes(value: unknown): Promise<number> {
    const [row] = await owner.$queryRaw<{ bytes: number }[]>`SELECT octet_length(${JSON.stringify(value)}::jsonb::text) AS bytes`;
    return row.bytes;
  }
  async function storageBoundary(fx: Awaited<ReturnType<typeof seeded>>) {
    const proposal = structuredClone(fx.draft.candidates[0].proposal);
    proposal.fitExplanation.text = 'SYNTHETIC'.padEnd(2000, 'x');
    proposal.nextVerification = Array.from({ length: 200 }, () => 'SYNTHETIC verify');
    const documentFor = (draft: typeof fx.draft) => ({ ...fx.read.document, setId: randomUUID(), revision: 1,
      candidates: draft.candidates.map(candidate => ({ ...fx.read.document.candidates[0], candidateId: randomUUID(), proposal: candidate.proposal })) });
    for (let count = 1; count <= 100; count += 1) {
      const draft = { ...fx.draft, candidates: Array.from({ length: count }, () => ({ proposal: structuredClone(proposal) })) };
      const document = documentFor(draft), compactBytes = Buffer.byteLength(JSON.stringify(document), 'utf8');
      if (compactBytes > 262144) break;
      const storedBytes = await jsonbBytes(document);
      if (storedBytes > 262144) return { draft, compactBytes, storedBytes, documentFor };
    }
    throw new Error('SYNTHETIC fixture did not straddle the two JSON size limits');
  }

  it('B1-R1-F1 handles real Claim approval and initial-storage reverse lock competition without a raw database failure', async () => {
    const fx = await fixture(), candidateClient = new PrismaService(), approvalClient = new PrismaService();
    const operation = randomUUID();
    function barrier() {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      return { promise, resolve };
    }
    const companyHeld = barrier(), claimHeld = barrier(), childReached = barrier();
    let candidateCompanyLocks = 0;
    function gated(client: PrismaService, side: 'candidate' | 'approval'): PrismaService {
      return { withWorkspace: <T>(workspace: string, run: (tx: Prisma.TransactionClient) => Promise<T>, options?: { timeout?: number; maxWait?: number }) => client.withWorkspace(workspace, tx => run(new Proxy(tx, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (key === '$queryRaw' && typeof value === 'function') return async (...args: unknown[]) => {
            const template = args[0];
            const sql = Array.isArray(template) ? template.join(' ') : '';
            if (side === 'candidate' && /FROM\s+claim\s/iu.test(sql) && sql.includes('FOR SHARE')) childReached.resolve();
            const result = await Reflect.apply(value, target, args);
            if (side === 'candidate' && sql.includes('FROM company_profile') && sql.includes('FOR UPDATE')) {
              candidateCompanyLocks += 1;
              if (candidateCompanyLocks === 1) { companyHeld.resolve(); await claimHeld.promise; }
            }
            if (side === 'approval' && /FROM\s+"claim"\s/iu.test(sql) && sql.includes('FOR UPDATE')) {
              claimHeld.resolve(); await childReached.promise;
            }
            return result;
          };
          if (key === 'claim' && side === 'candidate') return new Proxy(value, {
            get(delegate, method) {
              const original = Reflect.get(delegate, method, delegate);
              if (method === 'findUnique' && typeof original === 'function') return (...args: unknown[]) => { childReached.resolve(); return Reflect.apply(original, delegate, args); };
              return original;
            },
          });
          return value;
        },
      })), options) } as unknown as PrismaService;
    }
    try {
      const approval = new ClaimService(approvalClient);
      for (let i = 0; i < 2; i += 1) {
        const prior = await owner.claim.create({ data: { workspaceId, companyId: fx.companyId, type: 'capability', statement: `SYNTHETIC prior approval ${i}`, status: 'NEEDS_REVIEW' } });
        await approval.transition(context(), prior.id, 'APPROVED', 1);
      }
      await owner.companyProfile.update({ where: { id: fx.companyId }, data: { status: 'REVIEW' } });
      const storage = new MarketCandidateSetsService(gated(candidateClient, 'candidate'));
      const initialSave = storage.persistInitial(context(), fx.companyId, fx.draft, operation);
      await companyHeld.promise;
      const approvalSave = new ClaimService(gated(approvalClient, 'approval')).transition(context(), fx.claim.id, 'APPROVED', 1);
      const [stored, approved] = await Promise.allSettled([initialSave, approvalSave]);
      expect(approved.status).toBe('fulfilled');
      if (stored.status === 'rejected') expect(stored.reason).toMatchObject({ status: 409 });
      expect(candidateCompanyLocks).toBeLessThanOrEqual(3);
      const recovered = await new MarketCandidateSetsService(candidateClient).persistInitial(context(), fx.companyId, fx.draft, operation);
      expect(await owner.marketCandidateSet.count({ where: { companyId: fx.companyId } })).toBe(1);
      expect((await owner.companyProfile.findUniqueOrThrow({ where: { id: fx.companyId } })).status).toBe('ACTIVE');
      if (stored.status === 'fulfilled') expect(recovered.setId).toBe(stored.value.setId);
    } finally { await Promise.allSettled([candidateClient.$disconnect(), approvalClient.$disconnect()]); }
  });

  it('B1-R1-F2 rejects compact-valid but JSONB-oversized initial documents with a stable 400 and no new set', async () => {
    const fx = await seeded(), boundary = await storageBoundary(fx);
    expect(boundary.compactBytes).toBeLessThanOrEqual(262144); expect(boundary.storedBytes).toBeGreaterThan(262144);
    const before = await owner.marketCandidateSet.count({ where: { companyId: fx.companyId } });
    await expect(usingService(s => s.persistInitial(context(), fx.companyId, boundary.draft, randomUUID()))).rejects.toMatchObject({ status: 400 });
    expect(await owner.marketCandidateSet.count({ where: { companyId: fx.companyId } })).toBe(before);
  });

  it('B1-R1-F2 rejects feedback growth past the JSONB limit without appending a revision or feedback', async () => {
    const fx = await seeded(), boundary = await storageBoundary(fx), fitting = structuredClone(boundary.draft);
    let trim = boundary.storedBytes - (262144 - 3000);
    for (const candidate of fitting.candidates) {
      const removable = candidate.proposal.fitExplanation.text.length - 'SYNTHETIC'.length;
      const take = Math.min(trim, removable);
      candidate.proposal.fitExplanation.text = candidate.proposal.fitExplanation.text.slice(0, candidate.proposal.fitExplanation.text.length - take);
      trim -= take;
    }
    expect(trim).toBe(0); expect(await jsonbBytes(boundary.documentFor(fitting))).toBe(262144 - 3000);
    const stored = await usingService(s => s.persistInitial(context(), fx.companyId, fitting, randomUUID()));
    const before = await usingService(s => s.getCurrent(context(), stored.setId));
    const correction = { application: 'SYNTHETIC'.padEnd(2000, 'a'), organizationRole: 'SYNTHETIC'.padEnd(2000, 'b'),
      fitExplanation: 'SYNTHETIC'.padEnd(2000, 'c'), supplyDescription: 'SYNTHETIC'.padEnd(2000, 'd') };
    const grown = { ...before.document, revision: 2, candidates: before.document.candidates.map((candidate, index) => index === 0
      ? { ...candidate, corrections: correction, feedback: 'CORRECTED', needsReassessment: true, impactScope: 'UNKNOWN' } : candidate) };
    expect(Buffer.byteLength(JSON.stringify(grown), 'utf8')).toBeLessThanOrEqual(262144);
    expect(await jsonbBytes(grown)).toBeGreaterThan(262144);
    await expect(usingService(s => s.recordFeedback(context(), stored.setId, before.document.candidates[0].candidateId,
      { expectedRevision: 1, action: 'CORRECT', correction }, randomUUID()))).rejects.toMatchObject({ status: 400 });
    expect(await owner.marketCandidateSetRevision.count({ where: { setId: stored.setId } })).toBe(1);
    expect(await owner.marketCandidateFeedback.count({ where: { setId: stored.setId } })).toBe(0);
    expect((await owner.marketCandidateSet.findUniqueOrThrow({ where: { id: stored.setId } })).currentRevision).toBe(1);
  });

  type CandidateDocument = Awaited<ReturnType<MarketCandidateSetsService['getCurrent']>>['document'];
  function confirmedRevision(before: CandidateDocument): CandidateDocument {
    return { ...before, revision: before.revision + 1, candidates: before.candidates.map((candidate, index) => index === 0
      ? { ...candidate, feedback: 'CONFIRMED' as const } : candidate) };
  }
  function feedbackLayer(candidate: CandidateDocument['candidates'][number]) {
    return { corrections: candidate.corrections, feedback: candidate.feedback, needsReassessment: candidate.needsReassessment, impactScope: candidate.impactScope };
  }
  async function insertRevision(tx: Prisma.TransactionClient, document: CandidateDocument) {
    return tx.marketCandidateSetRevision.create({ data: { workspaceId, companyId: document.companyId, setId: document.setId,
      revision: document.revision, parentRevision: document.revision - 1, documentJson: document as unknown as Prisma.InputJsonValue,
      documentHash: documentHash(document), createdBy: actorId } });
  }
  async function insertFeedback(tx: Prisma.TransactionClient, before: CandidateDocument, after: CandidateDocument, target = before.candidates[0].candidateId) {
    return tx.marketCandidateFeedback.create({ data: { id: randomUUID(), workspaceId, companyId: before.companyId, setId: before.setId,
      candidateId: target, fromRevision: before.revision, toRevision: after.revision, action: 'CONFIRM', reason: null,
      beforeJson: feedbackLayer(before.candidates[0]) as unknown as Prisma.InputJsonValue,
      afterJson: feedbackLayer(after.candidates[0]) as unknown as Prisma.InputJsonValue,
      actorId, idempotencyKey: randomUUID(), requestHash: 'd'.repeat(64) } });
  }

  it.each(['revision-only','head-without-feedback','feedback-without-head','feedback-only','invalid-target'])('B1-R1-F3 still rejects %s half-states at commit', async kind => {
    const fx = await seeded(), before = fx.read.document, after = confirmedRevision(before);
    await expect(tenant(async tx => {
      if (kind !== 'feedback-only') await insertRevision(tx, after);
      if (['feedback-without-head','feedback-only','invalid-target'].includes(kind)) await insertFeedback(tx, before, after, kind === 'invalid-target' ? randomUUID() : fx.candidateId);
      if (['head-without-feedback','invalid-target'].includes(kind)) await tx.marketCandidateSet.update({ where: { id: before.setId }, data: { currentRevision: after.revision } });
    })).rejects.toThrow();
    expect((await owner.marketCandidateSet.findUniqueOrThrow({ where: { id: before.setId } })).currentRevision).toBe(1);
    expect(await owner.marketCandidateSetRevision.count({ where: { setId: before.setId } })).toBe(1);
    expect(await owner.marketCandidateFeedback.count({ where: { setId: before.setId } })).toBe(0);
  });

  it('B1-R1-F3 preserves the exact parent FK when an intermediate revision is missing', async () => {
    const fx = await seeded(), missingParent = { ...fx.read.document, revision: 3 };
    await expect(tenant(async tx => {
      await insertRevision(tx, missingParent);
      await tx.$executeRaw`SET CONSTRAINTS "market_candidate_revision_parent_fkey" IMMEDIATE`;
    })).rejects.toThrow(/foreign key/u);
    expect(await owner.marketCandidateSetRevision.count({ where: { setId: fx.stored.setId } })).toBe(1);
  });

  it('B1-R1-F3 preserves the same-workspace cross-company composite FK', async () => {
    const fx = await seeded(), unrelated = await fixture();
    const wrong = { ...confirmedRevision(fx.read.document), companyId: unrelated.companyId,
      basisSnapshot: { ...fx.read.document.basisSnapshot, company: { companyId: unrelated.companyId, version: 1 } } };
    await expect(tenant(tx => insertRevision(tx, wrong))).rejects.toThrow(/foreign key.*market_candidate_revision_set_fkey/iu);
    expect(await owner.marketCandidateSetRevision.count({ where: { setId: fx.stored.setId } })).toBe(1);
  });

  it.each([false,true])('B1-R1-F3 checks every event in one transaction with invalid-middle=%s', async invalidMiddle => {
    const fx = await seeded();
    const operation = tenant(async tx => {
      let before = fx.read.document;
      for (let revision = 2; revision <= 4; revision += 1) {
        const after = confirmedRevision(before);
        await insertRevision(tx, after);
        await insertFeedback(tx, before, after, invalidMiddle && revision === 3 ? randomUUID() : fx.candidateId);
        await tx.marketCandidateSet.update({ where: { id: before.setId }, data: { currentRevision: revision } });
        before = after;
      }
    });
    if (invalidMiddle) await expect(operation).rejects.toThrow(/MARKET_CANDIDATE_FEEDBACK_TARGET_INVALID/u);
    else await operation;
    expect((await owner.marketCandidateSet.findUniqueOrThrow({ where: { id: fx.stored.setId } })).currentRevision).toBe(invalidMiddle ? 1 : 4);
    expect(await owner.marketCandidateSetRevision.count({ where: { setId: fx.stored.setId } })).toBe(invalidMiddle ? 1 : 4);
    expect(await owner.marketCandidateFeedback.count({ where: { setId: fx.stored.setId } })).toBe(invalidMiddle ? 0 : 3);
  });

  it('B1-R1-F2 accepts bounded multibyte and escaped text under both JSON representations', async () => {
    const fx = await fixture(), text = 'SYNTHETIC 泵 " \\ \n'.repeat(60);
    fx.draft.candidates[0].proposal.fitExplanation.text = text;
    const stored = await usingService(s => s.persistInitial(context(), fx.companyId, fx.draft, randomUUID()));
    const read = await usingService(s => s.getCurrent(context(), stored.setId));
    expect(read.document.candidates[0].proposal.fitExplanation.text).toBe(text);
    expect(Buffer.byteLength(JSON.stringify(read.document), 'utf8')).toBeLessThanOrEqual(262144);
    expect(await jsonbBytes(read.document)).toBeLessThanOrEqual(262144);
    const feedback = await usingService(s => s.recordFeedback(context(), stored.setId, read.document.candidates[0].candidateId,
      { expectedRevision: 1, action: 'CORRECT', correction: { application: text } }, randomUUID()));
    expect(feedback.recordedRevision).toBe(2);
    expect(feedback.after.corrections.application).toBe(text);
  });

  it('B1-R1-F3 validates only the new revision pair without requiring visibility of unrelated immutable history', async () => {
    const fx = await seeded();
    for (let revision = 1; revision < 6; revision += 1) {
      await usingService(s => s.recordFeedback(context(), fx.stored.setId, fx.candidateId, { expectedRevision: revision, action: 'CONFIRM' }, randomUUID()));
    }
    await owner.$executeRawUnsafe(`CREATE POLICY "b1_history_cost_probe" ON market_candidate_set_revision AS RESTRICTIVE FOR SELECT TO app_user USING (set_id <> '${fx.stored.setId}'::uuid OR revision >= 6)`);
    try {
      const result = await usingService(s => s.recordFeedback(context(), fx.stored.setId, fx.candidateId, { expectedRevision: 6, action: 'KEEP_PENDING' }, randomUUID()));
      expect(result.recordedRevision).toBe(7);
    } finally { await owner.$executeRawUnsafe('DROP POLICY "b1_history_cost_probe" ON market_candidate_set_revision'); }
    expect(await owner.marketCandidateSetRevision.count({ where: { setId: fx.stored.setId } })).toBe(7);
    expect(await owner.marketCandidateFeedback.count({ where: { setId: fx.stored.setId } })).toBe(6);
  });

  it('B1-T01/T02/T12 cold-reads durable identity and distinguishes NOT_ANALYZED from COMPLETED_EMPTY', async () => {
    const fx = await fixture(), operation = randomUUID();
    expect(await usingService(s => s.getLatest(context(), fx.companyId))).toEqual({ status: 'NOT_ANALYZED', result: null });
    const first = await usingService(s => s.persistInitial(context(), fx.companyId, fx.draft, operation));
    const second = await usingService(s => s.persistInitial(context(), fx.companyId, fx.draft, operation));
    expect(second).toEqual({ ...first, replayed: true });
    const cold = await usingService(s => s.getCurrent(context(), first.setId));
    expect(documentHash(cold.document)).toBe(first.documentHash);
    expect(cold.document.basisSnapshot.sources.find(s => s.sourceId === fx.chunk.id)?.contentHash).toBe(createHash('sha256').update(fx.chunk.text, 'utf8').digest('hex'));
    expect(cold.document.candidates[0].proposal.projectCountry).toBe('FR');
    expect(cold.document.candidates[1].proposal.projectCountry).toBeNull();
    expect(cold.document.candidates[0].candidateId).not.toBe(cold.document.candidates[1].candidateId);
    expect(await owner.marketCandidateSet.count({ where: { companyId: fx.companyId } })).toBe(1);
    const changed = structuredClone(fx.draft); changed.candidates[0].proposal.application.text = 'SYNTHETIC changed intention';
    await expect(usingService(s => s.persistInitial(context(), fx.companyId, changed, operation))).rejects.toMatchObject({ status: 409 });
    const empty = await usingService(s => s.persistInitial(context(), fx.companyId, { generationOutcome: 'COMPLETED_EMPTY', sources: [], candidates: [] }, randomUUID()));
    const latest = await usingService(s => s.getLatest(context(), fx.companyId));
    expect(latest.status).toBe('AVAILABLE');
    expect(latest.result?.document).toMatchObject({ setId: empty.setId, generationOutcome: 'COMPLETED_EMPTY', candidates: [] });
  });

  it('B1-T03/T04 records all four feedback actions without rewriting proposals, evidence or the other card', async () => {
    const fx = await seeded();
    const actions = [
      { action: 'CONFIRM', reason: undefined },
      { action: 'CORRECT', reason: ' exact user reason ', correction: { application: 'SYNTHETIC user assertion', projectCountry: null } },
      { action: 'KEEP_PENDING', reason: ' \t ' }, { action: 'REJECT', reason: null }, { action: 'CONFIRM', reason: 'SYNTHETIC later explicit reversal' },
    ];
    await usingService(async s => {
      for (const [index, action] of actions.entries()) {
        const body = { expectedRevision: index + 1, ...action }; if (body.reason === undefined) delete body.reason;
        const result = await s.recordFeedback(context(), fx.stored.setId, fx.candidateId, body, randomUUID());
        expect(result.recordedRevision).toBe(index + 2);
        expect(result.reason).toBe(index === 1 ? ' exact user reason ' : index === 4 ? 'SYNTHETIC later explicit reversal' : null);
        const read = await s.getCurrent(context(), fx.stored.setId);
        expect(read.document.candidates[0].proposal).toEqual(fx.read.document.candidates[0].proposal);
        expect(read.document.basisSnapshot).toEqual(fx.read.document.basisSnapshot);
        expect(read.document.candidates[1]).toEqual(fx.read.document.candidates[1]);
        if (index >= 1) expect(read.document.candidates[0]).toMatchObject({ needsReassessment: true, impactScope: 'UNKNOWN', corrections: { application: 'SYNTHETIC user assertion', projectCountry: null } });
      }
      const original = await s.getRevision(context(), fx.stored.setId, 1);
      expect(original.historical).toBe(true); expect(original.document).toEqual(fx.read.document);
      const page = await s.listRevisions(context(), fx.stored.setId, { limit: 2 });
      expect(page.revisions.map(r => r.revision)).toEqual([6, 5]); expect(page.nextCursor).toBe('5');
      expect((await s.listRevisions(context(), fx.stored.setId, { limit: 2, cursor: page.nextCursor! })).revisions.map(r => r.revision)).toEqual([4, 3]);
    });
  });

  it('B1-T05/T06 commits one concurrent same-key intent and replays its original revision after response loss and a newer head', async () => {
    const fx = await seeded(), key = randomUUID(), input = { expectedRevision: 1, action: 'CONFIRM' };
    await usingService(async s => {
      const results = await Promise.all([s.recordFeedback(context(), fx.stored.setId, fx.candidateId, input, key), s.recordFeedback(context(), fx.stored.setId, fx.candidateId, input, key)]);
      expect(results.map(r => r.replayed).sort()).toEqual([false, true]);
      expect(new Set(results.map(r => r.feedbackId)).size).toBe(1);
      await s.recordFeedback(context(), fx.stored.setId, fx.candidateId, { expectedRevision: 2, action: 'KEEP_PENDING' }, randomUUID());
    });
    const replay = await usingService(s => s.recordFeedback(context(), fx.stored.setId, fx.candidateId, input, key));
    expect(replay).toMatchObject({ recordedRevision: 2, replayed: true });
    await expect(usingService(s => s.recordFeedback(context(), fx.stored.setId, fx.candidateId, { expectedRevision: 1, action: 'REJECT' }, key))).rejects.toMatchObject({ status: 409 });
    expect(await owner.marketCandidateSetRevision.count({ where: { setId: fx.stored.setId } })).toBe(3);
    expect(await owner.marketCandidateFeedback.count({ where: { setId: fx.stored.setId } })).toBe(2);
  });

  it('B1-T05 only one of two independent keys wins a stale revision, with actor-scoped key identities', async () => {
    const fx = await seeded(), key = randomUUID();
    await usingService(async s => {
      const results = await Promise.allSettled([
        s.recordFeedback(context(), fx.stored.setId, fx.candidateId, { expectedRevision: 1, action: 'CONFIRM' }, key),
        s.recordFeedback(context(), fx.stored.setId, fx.candidateId, { expectedRevision: 1, action: 'REJECT' }, randomUUID()),
      ]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason.status)).toEqual([409]);
      const other = { ...context(), userId: randomUUID() };
      const accepted = await s.recordFeedback(other, fx.stored.setId, fx.candidateId, { expectedRevision: 2, action: 'KEEP_PENDING' }, key);
      expect(accepted.replayed).toBe(false); expect(accepted.actorId).toBe(other.userId);
    });
    expect(await owner.marketCandidateSetRevision.count({ where: { setId: fx.stored.setId } })).toBe(3);
  });

  it('B1-T06 rolls back an inserted revision when feedback persistence fails inside the actual transaction', async () => {
    const fx = await seeded();
    await usingService(async (s, prisma) => {
      const failing = prisma.$extends({ query: { marketCandidateFeedback: { create() { throw new Error('SYNTHETIC transaction failure'); } } } });
      const faulty = new MarketCandidateSetsService(failing as unknown as PrismaService);
      await expect(faulty.recordFeedback(context(), fx.stored.setId, fx.candidateId, { expectedRevision: 1, action: 'CONFIRM' }, randomUUID())).rejects.toThrow(/SYNTHETIC transaction failure/u);
      expect((await s.getCurrent(context(), fx.stored.setId)).document.revision).toBe(1);
    });
    expect(await owner.marketCandidateSetRevision.count({ where: { setId: fx.stored.setId } })).toBe(1);
    expect(await owner.marketCandidateFeedback.count({ where: { setId: fx.stored.setId } })).toBe(0);
  });

  it('B1-T07 refuses cross-tenant, cross-company, forged source and candidate identities without writing', async () => {
    const fx = await seeded(), other = { ...context(), workspaceId: otherWorkspace };
    await usingService(async s => {
      await expect(s.getLatest(other, fx.companyId)).rejects.toMatchObject({ status: 404 });
      await expect(s.getCurrent(other, fx.stored.setId)).rejects.toMatchObject({ status: 404 });
      await expect(s.listRevisions(other, fx.stored.setId, {})).rejects.toMatchObject({ status: 404 });
      await expect(s.getRevision(other, fx.stored.setId, 1)).rejects.toMatchObject({ status: 404 });
      await expect(s.recordFeedback(other, fx.stored.setId, fx.candidateId, { expectedRevision: 1, action: 'REJECT' }, randomUUID())).rejects.toMatchObject({ status: 404 });
      await expect(s.recordFeedback(context(), fx.stored.setId, randomUUID(), { expectedRevision: 1, action: 'REJECT' }, randomUUID())).rejects.toMatchObject({ status: 404 });
      const unrelated = await fixture();
      await expect(s.persistInitial(context(), unrelated.companyId, fx.draft, randomUUID())).rejects.toMatchObject({ status: 404 });
      await expect(s.persistInitial(other, fx.companyId, fx.draft, randomUUID())).rejects.toMatchObject({ status: 404 });
    });
    expect(await owner.marketCandidateFeedback.count({ where: { setId: fx.stored.setId } })).toBe(0);
  });

  it('B1-T08 preserves old snapshot/hash and reports offering change, claim revocation and document deletion without new links', async () => {
    const fx = await seeded();
    await owner.offering.update({ where: { id: fx.offering.id }, data: { description: 'SYNTHETIC changed supply' } });
    await owner.claim.update({ where: { id: fx.claim.id }, data: { status: 'REVOKED', version: { increment: 1 } } });
    await owner.sellerDocument.update({ where: { id: fx.document.id }, data: { deletedAt: new Date(), status: 'deleted' } });
    const read = await usingService(s => s.getCurrent(context(), fx.stored.setId));
    expect(read.document).toEqual(fx.read.document); expect(read.documentHash).toBe(fx.read.documentHash);
    expect(read.basisAvailability.find(x => x.key === `OFFERING:${fx.offering.id}`)?.status).toBe('CHANGED');
    expect(read.basisAvailability.find(x => x.key === `CLAIM:${fx.claim.id}`)?.status).toBe('UNAVAILABLE');
    expect(read.basisAvailability.find(x => x.key === `SELLER_DOCUMENT:${fx.document.id}`)?.status).toBe('UNAVAILABLE');
    expect(read.basisAvailability.find(x => x.key === `SELLER_DOCUMENT_CHUNK:${fx.chunk.id}`)?.status).toBe('UNAVAILABLE');
    expect(JSON.stringify(read)).not.toContain(fx.document.objectKey);
    expect(JSON.stringify(read)).not.toContain(fx.chunk.text);
    await usingService(async s => {
      await s.recordFeedback(context(), fx.stored.setId, fx.candidateId, { expectedRevision: 1, action: 'KEEP_PENDING' }, randomUUID());
      await expect(s.persistInitial(context(), fx.companyId, fx.draft, randomUUID())).rejects.toMatchObject({ status: 404 });
    });
  });

  it('B1-T08 never retargets a deleted chunk to new content at the same sequence number', async () => {
    const fx = await seeded();
    await owner.sellerDocumentChunk.delete({ where: { id: fx.chunk.id } });
    await owner.sellerDocumentChunk.create({ data: { workspaceId, documentId: fx.document.id, seq: 0, text: 'SYNTHETIC reparsed new content' } });
    const read = await usingService(s => s.getCurrent(context(), fx.stored.setId));
    expect(read.documentHash).toBe(fx.read.documentHash);
    expect(read.basisAvailability.find(x => x.key === `SELLER_DOCUMENT_CHUNK:${fx.chunk.id}`)?.status).toBe('UNAVAILABLE');
  });

  it('B1-T09 permits original committed key replay after a newer set but rejects new intent on the old set', async () => {
    const fx = await seeded(), key = randomUUID(), body = { expectedRevision: 1, action: 'REJECT' };
    await usingService(async s => {
      const first = await s.recordFeedback(context(), fx.stored.setId, fx.candidateId, body, key);
      await s.persistInitial(context(), fx.companyId, fx.draft, randomUUID());
      expect(await s.recordFeedback(context(), fx.stored.setId, fx.candidateId, body, key)).toMatchObject({ feedbackId: first.feedbackId, recordedRevision: 2, replayed: true });
      await expect(s.recordFeedback(context(), fx.stored.setId, fx.candidateId, { expectedRevision: 2, action: 'CONFIRM' }, randomUUID())).rejects.toMatchObject({ status: 409 });
      expect((await s.getRevision(context(), fx.stored.setId, 1)).historical).toBe(true);
    });
    await owner.companyProfile.update({ where: { id: fx.companyId }, data: { deletedAt: new Date() } });
    await usingService(async s => {
      await expect(s.getCurrent(context(), fx.stored.setId)).rejects.toMatchObject({ status: 404 });
      await expect(s.getLatest(context(), fx.companyId)).rejects.toMatchObject({ status: 404 });
      await expect(s.listRevisions(context(), fx.stored.setId, {})).rejects.toMatchObject({ status: 404 });
      await expect(s.getRevision(context(), fx.stored.setId, 1)).rejects.toMatchObject({ status: 404 });
      await expect(s.recordFeedback(context(), fx.stored.setId, fx.candidateId, body, key)).rejects.toMatchObject({ status: 404 });
    });
  });

  it('B1-T04 stores only feedback overlays rather than duplicating proposal or source content in the feedback ledger', async () => {
    const fx = await seeded();
    await usingService(s => s.recordFeedback(context(), fx.stored.setId, fx.candidateId, { expectedRevision: 1, action: 'CORRECT', correction: { application: 'SYNTHETIC corrected user assertion' } }, randomUUID()));
    const row = await owner.marketCandidateFeedback.findFirstOrThrow({ where: { setId: fx.stored.setId } });
    expect(Object.keys(row.beforeJson as object).sort()).toEqual(['corrections','feedback','impactScope','needsReassessment']);
    expect(Object.keys(row.afterJson as object).sort()).toEqual(['corrections','feedback','impactScope','needsReassessment']);
    expect(row.beforeJson).toMatchObject({ corrections: {}, feedback: 'PENDING', needsReassessment: false });
    expect(row.afterJson).toMatchObject({ corrections: { application: 'SYNTHETIC corrected user assertion' }, feedback: 'CORRECTED', needsReassessment: true });
  });

  it('B1-T08 recomputes availability on committed-key replay rather than caching a formerly live source', async () => {
    const fx = await seeded(), key = randomUUID(), body = { expectedRevision: 1, action: 'CONFIRM' };
    const first = await usingService(s => s.recordFeedback(context(), fx.stored.setId, fx.candidateId, body, key));
    expect(first.basisAvailability.find(x => x.key === `SELLER_DOCUMENT:${fx.document.id}`)?.status).toBe('CURRENT');
    await owner.sellerDocument.update({ where: { id: fx.document.id }, data: { status: 'deleted', deletedAt: new Date() } });
    const replay = await usingService(s => s.recordFeedback(context(), fx.stored.setId, fx.candidateId, body, key));
    expect(replay).toMatchObject({ feedbackId: first.feedbackId, recordedRevision: first.recordedRevision, documentHash: first.documentHash, replayed: true });
    expect(replay.basisAvailability.find(x => x.key === `SELLER_DOCUMENT:${fx.document.id}`)?.status).toBe('UNAVAILABLE');
    expect(await owner.marketCandidateFeedback.count({ where: { setId: fx.stored.setId } })).toBe(1);
  });

  it('B1-T08 distinguishes expired claims, changed document fingerprints and unknown evidence hashes without rewriting a document', async () => {
    const fx = await seeded();
    await owner.claim.update({ where: { id: fx.claim.id }, data: { validUntil: new Date('2020-01-01T00:00:00Z') } });
    await owner.companyProfile.update({ where: { id: fx.companyId }, data: { version: { increment: 1 } } });
    await owner.sellerDocument.update({ where: { id: fx.document.id }, data: { contentHash: 'c'.repeat(64) } });
    const read = await usingService(s => s.getCurrent(context(), fx.stored.setId));
    expect(read.document).toEqual(fx.read.document); expect(read.documentHash).toBe(fx.read.documentHash);
    expect(read.basisAvailability.find(x => x.key === `COMPANY:${fx.companyId}`)?.status).toBe('CHANGED');
    expect(read.basisAvailability.find(x => x.key === `CLAIM:${fx.claim.id}`)?.status).toBe('UNAVAILABLE');
    expect(read.basisAvailability.find(x => x.key === `EVIDENCE:${fx.evidence.id}`)?.status).toBe('UNAVAILABLE');
    expect(read.basisAvailability.find(x => x.key === `SELLER_DOCUMENT:${fx.document.id}`)?.status).toBe('CHANGED');
    expect(read.basisAvailability.find(x => x.key === `SELLER_DOCUMENT_CHUNK:${fx.chunk.id}`)?.status).toBe('CHANGED');
    const unknown = await fixture();
    await owner.evidence.update({ where: { id: unknown.evidence.id }, data: { sourceContentHash: null } });
    const stored = await usingService(s => s.persistInitial(context(), unknown.companyId, unknown.draft, randomUUID()));
    const unknownRead = await usingService(s => s.getCurrent(context(), stored.setId));
    expect(unknownRead.basisAvailability.find(x => x.key === `EVIDENCE:${unknown.evidence.id}`)?.status).toBe('UNKNOWN');
  });

  it('B1-T01 concurrent initial-operation replay preserves the originally committed set and candidate identities', async () => {
    const fx = await fixture(), operation = randomUUID();
    const results = await Promise.all([
      usingService(s => s.persistInitial(context(), fx.companyId, fx.draft, operation)),
      usingService(s => s.persistInitial(context(), fx.companyId, fx.draft, operation)),
    ]);
    expect(results.map(r => r.replayed).sort()).toEqual([false, true]);
    expect(new Set(results.map(r => r.setId)).size).toBe(1);
    expect(new Set(results.map(r => r.documentHash)).size).toBe(1);
    expect(await owner.marketCandidateSet.count({ where: { companyId: fx.companyId } })).toBe(1);
  });

  it('B1-T11/T13 exercises real HTTP through app_user and writes only candidate tables on success, conflict and rejection', async () => {
    const fx = await seeded(), writes: string[] = [];
    const before = await Promise.all([owner.companyProfile.findUnique({ where: { id: fx.companyId } }), owner.claim.findUnique({ where: { id: fx.claim.id } }), owner.outboxEvent.count(), owner.icpDefinition.count(), owner.executionBudgetAuthority.count(), owner.discoveryRun.count()]);
    await usingService(async (_, prisma) => {
      const observed = prisma.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
        if (['create','createMany','update','updateMany','upsert','delete','deleteMany'].includes(operation)) writes.push(`${model}.${operation}`);
        return query(args);
      } } } });
      @Module({ controllers: [MarketCandidateSetsController], providers: [
        { provide: MarketCandidateSetsService, useValue: new MarketCandidateSetsService(observed as unknown as PrismaService) },
        AuthGuard, ScopesGuard,
        { provide: TokenVerifier, useValue: { verify: async (token: string) => ({ workspaceId: token === 'SYNTHETIC_OTHER' ? otherWorkspace : workspaceId, userId: actorId, roles: [token === 'SYNTHETIC_READER' ? 'reader' : 'editor'] }) } },
        { provide: ROLES_TO_SCOPES_POLICY, useValue: createRolesToScopesPolicy({ AUTH_ROLE_SCOPE_MAP_JSON: JSON.stringify({ reader: ['acquisition:read'], editor: ['acquisition:read','acquisition:review'] }) }, 'development') },
      ] })
      class RestrictedApiProbe {}
      const api = await NestFactory.create(RestrictedApiProbe, { logger: false, abortOnError: false });
      api.setGlobalPrefix('api'); api.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
      api.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true })); api.useGlobalFilters(new GlobalHttpExceptionFilter());
      await api.listen(0, '127.0.0.1');
      const origin = `http://127.0.0.1:${(api.getHttpServer().address() as AddressInfo).port}`;
      const path = `/api/v1/market-candidate-sets/${fx.stored.setId}`;
      const feedbackPath = `${path}/candidates/${fx.candidateId}/feedback`;
      const request = (url: string, token: string | null, body?: unknown) => fetch(`${origin}${url}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      try {
        expect((await request(path, null)).status).toBe(401);
        expect((await request(feedbackPath, 'SYNTHETIC_READER', { expectedRevision: 1, action: 'CONFIRM' })).status).toBe(403);
        for (const url of [path, `${path}/revisions`, `${path}/revisions/1`, `/api/v1/companies/${fx.companyId}/market-candidate-sets/latest`]) expect((await request(url, 'SYNTHETIC_READER')).status).toBe(200);
        expect((await request(path, 'SYNTHETIC_OTHER')).status).toBe(404);
        expect((await request(feedbackPath, 'SYNTHETIC_EDITOR', { expectedRevision: 1, action: 'CONFIRM', actorId: randomUUID() })).status).toBe(400);
        const saved = await request(feedbackPath, 'SYNTHETIC_EDITOR', { expectedRevision: 1, action: 'CONFIRM' });
        expect(saved.status).toBe(200); expect((await saved.json()).data).toMatchObject({ actorId, recordedRevision: 2, replayed: false });
        expect((await request(feedbackPath, 'SYNTHETIC_EDITOR', { expectedRevision: 1, action: 'REJECT' })).status).toBe(409);
        expect((await request(feedbackPath, 'SYNTHETIC_OTHER', { expectedRevision: 2, action: 'REJECT' })).status).toBe(404);
      } finally { await api.close(); }
    });
    expect(writes.sort()).toEqual(['MarketCandidateFeedback.create','MarketCandidateSet.updateMany','MarketCandidateSetRevision.create']);
    const after = await Promise.all([owner.companyProfile.findUnique({ where: { id: fx.companyId } }), owner.claim.findUnique({ where: { id: fx.claim.id } }), owner.outboxEvent.count(), owner.icpDefinition.count(), owner.executionBudgetAuthority.count(), owner.discoveryRun.count()]);
    expect(after).toEqual(before);
  });

  it('B1-T11 writes only the three new tables and leaves company, evidence, ICP, budgets and outbox unchanged', async () => {
    const fx = await seeded();
    const before = await Promise.all([owner.companyProfile.findUnique({ where: { id: fx.companyId } }), owner.claim.findUnique({ where: { id: fx.claim.id } }), owner.outboxEvent.count(), owner.icpDefinition.count(), owner.executionBudgetAuthority.count(), owner.discoveryRun.count()]);
    const writes: string[] = [];
    await usingService(async (_, prisma) => {
      const observed = prisma.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
        if (['create','createMany','update','updateMany','upsert','delete','deleteMany'].includes(operation)) writes.push(`${model}.${operation}`);
        return query(args);
      } } } });
      const s = new MarketCandidateSetsService(observed as unknown as PrismaService);
      await s.getLatest(context(), fx.companyId); await s.getCurrent(context(), fx.stored.setId);
      await s.listRevisions(context(), fx.stored.setId, {}); await s.getRevision(context(), fx.stored.setId, 1);
      await s.recordFeedback(context(), fx.stored.setId, fx.candidateId, { expectedRevision: 1, action: 'CONFIRM' }, randomUUID());
      await expect(s.recordFeedback(context(), fx.stored.setId, fx.candidateId, { expectedRevision: 1, action: 'REJECT' }, randomUUID())).rejects.toMatchObject({ status: 409 });
    });
    expect(writes.sort()).toEqual(['MarketCandidateFeedback.create', 'MarketCandidateSet.updateMany', 'MarketCandidateSetRevision.create']);
    const after = await Promise.all([owner.companyProfile.findUnique({ where: { id: fx.companyId } }), owner.claim.findUnique({ where: { id: fx.claim.id } }), owner.outboxEvent.count(), owner.icpDefinition.count(), owner.executionBudgetAuthority.count(), owner.discoveryRun.count()]);
    expect(after).toEqual(before);
  });
});
