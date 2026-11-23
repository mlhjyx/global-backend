import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { SellerDocumentClaimsService } from './seller-document-claims.service';
import { SellerDocumentsService } from './seller-documents.service';
import { ClaimService } from '../claim/claim.service';
import { IcpService } from '../icp/icp.service';
import { OutreachDraftService } from '../lead/outreach-draft.service';
import { createCampaignPlanningActivities } from '../temporal/campaign-planning.activities';
import { UnderstandingPreviewService } from '../company/understanding-preview.service';
import { executeStructuredTaskWithRuntime } from '../model-runtime/structured-task-runtime-bridge';

vi.mock('../model-runtime/structured-task-runtime-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../model-runtime/structured-task-runtime-bridge')>();
  return { ...actual, executeStructuredTaskWithRuntime: vi.fn() };
});

const ownerUrl = process.env.SELLER_DOCUMENT_CLAIM_TEST_DATABASE_URL;
const appUrl = process.env.SELLER_DOCUMENT_CLAIM_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) {
  throw new Error('document claim consumer tests need both SELLER_DOCUMENT_CLAIM_TEST_DATABASE_URL and SELLER_DOCUMENT_CLAIM_TEST_APP_DATABASE_URL');
}
for (const value of [ownerUrl, appUrl]) {
  if (!value) continue;
  const url = new URL(value);
  if (url.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/global_test' || url.search !== '' || url.hash !== '') {
    throw new Error('document claim consumer tests require a loopback /global_test database');
  }
}
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function sqlState(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2010') return null;
  const code = (error.meta as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : null;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe.runIf(Boolean(ownerUrl && appUrl))('document-claim gates at the real consumer entry points (app_user)', { timeout: 120_000 }, () => {
  const owner = ownerUrl ? new PrismaClient({ datasources: { db: { url: ownerUrl } } }) : (null as never);
  const app = appUrl ? new PrismaClient({ datasources: { db: { url: appUrl } } }) : (null as never);
  const workspacePrisma = (client: PrismaClient) => ({
    withWorkspace: <T>(workspaceId: string, work: (tx: Prisma.TransactionClient) => Promise<T>) =>
      client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
        return work(tx);
      }, { timeout: 60_000 }),
  });
  const appPrisma = workspacePrisma(app) as never;
  const claims = new SellerDocumentClaimsService(appPrisma);
  const claimService = new ClaimService(appPrisma);
  const ctx = (workspaceId: string, userId: string = randomUUID()) => ({ workspaceId, userId, roles: [], scopes: [] as const });

  async function seedTenantWithClaims(statements: readonly string[], approvedCount: number) {
    const workspaceId = randomUUID();
    const companyId = randomUUID();
    const userId = randomUUID();
    await owner.workspace.create({ data: { id: workspaceId, name: 'Synthetic gated consumer workspace' } });
    await owner.companyProfile.create({
      data: { id: companyId, workspaceId, name: 'Synthetic gate seller', website: 'https://synthetic.example.test', status: 'REVIEW' } as never,
    });
    const body = `Synthetic seller profile. ${statements.join(' ')}`;
    const documentId = randomUUID();
    await owner.sellerDocument.create({
      data: {
        id: documentId,
        workspaceId,
        companyId,
        uploadedBy: userId,
        filename: 'synthetic.txt',
        mime: 'text/plain',
        sizeBytes: BigInt(Buffer.byteLength(body, 'utf8')),
        kind: 'txt',
        objectKey: `ws/${workspaceId}/companies/${companyId}/seller-documents/${documentId}/${sha(body)}.txt`,
        contentHash: sha(body),
        status: 'ready',
        parseRevision: 1,
        chunkCount: 1,
      },
    });
    await owner.sellerDocumentChunk.create({ data: { workspaceId, documentId, seq: 0, text: body, meta: { page: 1 } } });
    const bytes = Buffer.from(body, 'utf8');
    const docClaimIds: string[] = [];
    for (const [index, statement] of statements.entries()) {
      const start = bytes.indexOf(Buffer.from(statement, 'utf8'));
      if (start < 0) throw new Error(`statement is not inside the seeded document: ${statement}`);
      const end = start + Buffer.byteLength(statement, 'utf8');
      const userCtx = ctx(workspaceId, userId);
      const reference = {
        documentId,
        documentContentHash: sha(body),
        parseRevision: 1,
        chunkSeq: 0,
        chunkTextHash: sha(body),
        quoteStartByte: start,
        quoteEndByte: end,
      };
      const preview = await claims.preview(userCtx, companyId, documentId, { reference, type: 'market', statement });
      const draft = await claims.createDraft(userCtx, companyId, documentId, {
        reference,
        type: 'market',
        statement,
        requestDigest: preview.requestDigest,
      });
      if (index < approvedCount) await claimService.transition(userCtx, draft.claimId, 'APPROVED', 1);
      docClaimIds.push(draft.claimId);
    }
    return { workspaceId, companyId, userId, documentId, body, docClaimIds };
  }
  async function seedTenant(statement: string) {
    const tenant = await seedTenantWithClaims([statement], 1);
    return { ...tenant, docClaimId: tenant.docClaimIds[0] };
  }

  async function legacyClaim(tenant: { workspaceId: string; companyId: string; userId: string }, statement: string): Promise<string> {
    const row = await owner.claim.create({
      data: { workspaceId: tenant.workspaceId, companyId: tenant.companyId, type: 'market', statement, status: 'NEEDS_REVIEW', version: 1 },
    });
    const approved = await claimService.transition(ctx(tenant.workspaceId, tenant.userId), row.id, 'APPROVED', 1);
    return approved.id;
  }

  it('excludes a document claim from the outreach prompt while keeping legacy claims', async () => {
    const statement = 'DOCUMENT-ONLY certified lab in Germany';
    const tenant = await seedTenant(statement);
    const legacyId = await legacyClaim(tenant, 'Legacy seller runs an EU service network');
    const icp = await owner.icpDefinition.create({
      data: { workspaceId: tenant.workspaceId, companyId: tenant.companyId, name: 'Synthetic ICP', status: 'ACTIVE' },
    });
    const buyer = await owner.canonicalCompany.create({
      data: { workspaceId: tenant.workspaceId, name: 'Synthetic buyer', country: 'DE', dedupeKey: randomUUID() },
    });
    const lead = await owner.lead.create({
      data: { workspaceId: tenant.workspaceId, icpId: icp.id, canonicalCompanyId: buyer.id, queue: 'recommended' },
    });
    await owner.leadDecision.create({
      data: { workspaceId: tenant.workspaceId, leadId: lead.id, action: 'accept', decidedBy: tenant.userId },
    });
    const prompts: string[] = [];
    vi.mocked(executeStructuredTaskWithRuntime).mockImplementation(async (_gateway, input) => {
      prompts.push((input as { prompt: string }).prompt);
      return {
        data: { subject: 'Hello', body: 'Intro without signature.', body_zh: '介绍正文。', used_facts: [`seller.claim:${legacyId}`] },
        provider: 'mock',
        model: 'mock-model',
      } as never;
    });
    const service = new OutreachDraftService(appPrisma, {} as never, {} as never, {
      verifyWorkspaceGrant: async () => ({}),
      consumeVerifiedWorkspaceGrant: async () => ({ authorityId: randomUUID(), scopeKey: tenant.workspaceId, accountKey: 'mock-account', replay: false }),
    } as never, { attestAuthorized: async () => undefined } as never);
    const draft = await service.generate(ctx(tenant.workspaceId, tenant.userId), lead.id);
    expect(draft.subject).toBe('Hello');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`seller.claim:${legacyId}`);
    expect(prompts[0]).not.toContain(statement);
    expect(prompts[0]).not.toContain(`seller.claim:${tenant.docClaimId}`);
  });

  it('excludes a document claim from the campaign plan inputs while keeping legacy claims', async () => {
    const statement = 'DOCUMENT-ONLY campaign certification';
    const tenant = await seedTenant(statement);
    const legacyId = await legacyClaim(tenant, 'Legacy campaign claim statement');
    const icp = await owner.icpDefinition.create({
      data: { workspaceId: tenant.workspaceId, companyId: tenant.companyId, name: 'Synthetic campaign ICP', status: 'ACTIVE' },
    });
    const legacy = await owner.claim.findUniqueOrThrow({ where: { id: legacyId } });
    const docClaim = await owner.claim.findUniqueOrThrow({ where: { id: tenant.docClaimId } });
    const activities = createCampaignPlanningActivities({
      prisma: appPrisma,
      gateway: {} as never,
      memory: { buildMemoryBrief: async () => 'synthetic brief' } as never,
    });
    const bundle = await activities.assembleCampaignPlanInputs({
      workspaceId: tenant.workspaceId,
      objective: 'Synthetic expansion objective',
      icpId: icp.id,
    } as never);
    const statements = (bundle.seller?.approvedClaims ?? []).map((claim) => claim.statement);
    expect(statements).toContain(legacy.statement);
    expect(statements).not.toContain(docClaim.statement);
  });

  it('excludes a document claim from the understanding preview markets while site claims still suggest', async () => {
    const statement = 'We serve customers in Germany';
    const tenant = await seedTenant(statement);
    await owner.canonicalTaxonomy.upsert({
      where: { kind_code: { kind: 'country', code: 'DE' } },
      create: { kind: 'country', scheme: 'ISO3166_1', code: 'DE', labelEn: 'Germany', labels: { zh: '德国', de: 'Deutschland' } },
      update: {},
    });
    await owner.termAlias.upsert({
      where: { kind_term: { kind: 'country', term: 'germany' } },
      create: { kind: 'country', term: 'germany', code: 'DE', source: 'manual' },
      update: { code: 'DE' },
    });
    const service = new UnderstandingPreviewService(appPrisma);
    const withoutLegacy = await service.get(ctx(tenant.workspaceId, tenant.userId), tenant.companyId);
    expect(withoutLegacy.markets.map((market) => market.code)).not.toContain('DE');
    const legacyId = await legacyClaim(tenant, 'We serve customers in Germany');
    await owner.evidence.create({
      data: {
        workspaceId: tenant.workspaceId,
        claimId: legacyId,
        snippet: 'We serve customers in Germany',
        sourceUrl: 'https://synthetic.example.test/about',
      },
    });
    const withLegacy = await new UnderstandingPreviewService(appPrisma).get(ctx(tenant.workspaceId, tenant.userId), tenant.companyId);
    expect(withLegacy.markets.map((market) => market.code)).toContain('DE');
    expect(withLegacy.markets.find((market) => market.code === 'DE')?.evidence).toContain('Germany');
  });

  it('blocks a concurrent soft delete until the ICP apply transaction commits', async () => {
    const statement = 'DOCUMENT-ONLY ICP serialization evidence';
    const tenant = await seedTenant(statement);
    const hit = deferred();
    const release = deferred();
    const gated = {
      withWorkspace: <T>(workspaceId: string, work: (tx: Prisma.TransactionClient) => Promise<T>) =>
        app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
          const proxied = new Proxy(tx, {
            get(target, property, receiver) {
              if (property === 'icpDefinition') {
                const delegate = Reflect.get(target, property, receiver) as object;
                return new Proxy(delegate, {
                  get(model, key) {
                    if (key !== 'create') return Reflect.get(model, key);
                    return async (...args: unknown[]) => {
                      hit.resolve();
                      await release.promise;
                      return (Reflect.get(model, key) as (...inner: unknown[]) => Promise<unknown>)(...args);
                    };
                  },
                });
              }
              const value = Reflect.get(target, property, receiver);
              return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
            },
          }) as Prisma.TransactionClient;
          return work(proxied);
        }, { timeout: 60_000 }),
    } as never;
    vi.mocked(executeStructuredTaskWithRuntime).mockImplementation(async () => ({
      data: {
        name: 'Synthetic serialized ICP',
        target_markets: ['DE'],
        company_attributes: {},
        pain_points: [],
        trigger_signals: [],
        exclusions: [],
        value_props: [],
        personas: [],
        buying_committee: [],
        qualification_rules: [],
      },
      provider: 'mock',
      model: 'mock-model',
    }) as never);
    const icpService = new IcpService(gated, {} as never, {} as never, {
      verifyWorkspaceGrant: async () => ({}),
      consumeVerifiedWorkspaceGrant: async () => ({ authorityId: randomUUID(), scopeKey: tenant.workspaceId, accountKey: 'mock-account', replay: false }),
    } as never, {} as never, { attestAuthorized: async () => undefined } as never);
    const running = icpService.generateFromCompany(ctx(tenant.workspaceId, tenant.userId), tenant.companyId);
    await hit.promise;
    const lockBounded = {
      withWorkspace: <T>(workspaceId: string, work: (tx: Prisma.TransactionClient) => Promise<T>) =>
        app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '250ms'`);
          return work(tx);
        }, { timeout: 30_000 }),
    } as never;
    const softDelete = new SellerDocumentsService(lockBounded, {} as never, {} as never, {} as never);
    const contender = await softDelete.softDelete(ctx(tenant.workspaceId, tenant.userId), tenant.documentId).then(() => null).catch((error) => error);
    expect(sqlState(contender)).toBe('55P03');
    release.resolve();
    const created = await running;
    expect(created).toMatchObject({ name: 'Synthetic serialized ICP', companyId: tenant.companyId });
    expect(await owner.icpDefinition.count({ where: { companyId: tenant.companyId } })).toBe(1);
    expect(await owner.sellerDocument.findUniqueOrThrow({ where: { id: tenant.documentId } })).toMatchObject({ deletedAt: null });
  });

  it('rejects the ICP apply with a stale-source conflict when the document is deleted first', async () => {
    const statement = 'DOCUMENT-ONLY ICP stale evidence';
    const tenant = await seedTenant(statement);
    const reachedApply = deferred();
    const release = deferred();
    let calls = 0;
    const prepareThenPause = {
      withWorkspace: <T>(workspaceId: string, work: (tx: Prisma.TransactionClient) => Promise<T>) => {
        calls += 1;
        if (calls === 2) {
          reachedApply.resolve();
          return release.promise.then(() => workspacePrisma(app).withWorkspace(workspaceId, work));
        }
        return workspacePrisma(app).withWorkspace(workspaceId, work);
      },
    } as never;
    vi.mocked(executeStructuredTaskWithRuntime).mockImplementation(async () => ({
      data: {
        name: 'Synthetic stale ICP',
        target_markets: ['DE'],
        company_attributes: {},
        pain_points: [],
        trigger_signals: [],
        exclusions: [],
        value_props: [],
        personas: [],
        buying_committee: [],
        qualification_rules: [],
      },
      provider: 'mock',
      model: 'mock-model',
    }) as never);
    const icpService = new IcpService(prepareThenPause, {} as never, {} as never, {
      verifyWorkspaceGrant: async () => ({}),
      consumeVerifiedWorkspaceGrant: async () => ({ authorityId: randomUUID(), scopeKey: tenant.workspaceId, accountKey: 'mock-account', replay: false }),
    } as never, {} as never, { attestAuthorized: async () => undefined } as never);
    const running = icpService.generateFromCompany(ctx(tenant.workspaceId, tenant.userId), tenant.companyId);
    await reachedApply.promise;
    await new SellerDocumentsService(appPrisma, {} as never, {} as never, {} as never)
      .softDelete(ctx(tenant.workspaceId, tenant.userId), tenant.documentId);
    release.resolve();
    const error = await running.then(() => null).catch((thrown) => thrown as { status?: number; getResponse?: () => unknown });
    expect(error?.status).toBe(409);
    expect(error?.getResponse?.()).toMatchObject({ error: { code: 'ICP_DOCUMENT_SOURCE_STALE' } });
    expect(await owner.icpDefinition.count({ where: { companyId: tenant.companyId } })).toBe(0);
  });

  it('does not deadlock when a third same-document claim activation overlaps the ICP apply', async () => {
    const tenant = await seedTenantWithClaims(
      ['Synthetic claim alpha.', 'Synthetic claim beta.', 'Synthetic claim gamma.'],
      2,
    );
    const pendingClaimId = tenant.docClaimIds[2];
    vi.mocked(executeStructuredTaskWithRuntime).mockImplementation(async () => ({
      data: {
        name: 'Synthetic activation-overlap ICP',
        target_markets: ['DE'],
        company_attributes: {},
        pain_points: [],
        trigger_signals: [],
        exclusions: [],
        value_props: [],
        personas: [],
        buying_committee: [],
        qualification_rules: [],
      },
      provider: 'mock',
      model: 'mock-model',
    }) as never);
    const icpService = new IcpService(appPrisma, {} as never, {} as never, {
      verifyWorkspaceGrant: async () => ({}),
      consumeVerifiedWorkspaceGrant: async () => ({ authorityId: randomUUID(), scopeKey: tenant.workspaceId, accountKey: 'mock-account', replay: false }),
    } as never, {} as never, { attestAuthorized: async () => undefined } as never);
    const waitingBackend = async (queryLike: string) => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const rows = await owner.$queryRaw<Array<{ pid: number; xid: string | null }>>`
          SELECT pid, backend_xid::text AS xid FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ${queryLike}`;
        if (rows.length === 1) return rows[0];
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`no waiting backend matched ${queryLike}`);
    };
    const blockedBy = async (pid: number) => {
      return owner.$queryRaw<Array<{ locktype: string; xid: string | null }>>`
        SELECT locktype, transactionid::text AS xid FROM pg_locks
         WHERE pid = ${pid} AND NOT granted`;
    };
    // An unrelated row-lock waiter runs throughout the interleaving: the barrier
    // must bind to the two target backends and their blockers, never to a global
    // waiter count that any other session could satisfy.
    const unrelatedCompany = await owner.canonicalCompany.create({
      data: { workspaceId: tenant.workspaceId, name: 'Synthetic unrelated waiter', dedupeKey: randomUUID() },
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
    await waitingBackend('%canonical_company%FOR UPDATE%');
    const documentHeld = deferred();
    const releaseDocument = deferred();
    let holderIdentity: { pid: number; xid: string } | undefined;
    const holder = owner.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM seller_document WHERE id = ${tenant.documentId}::uuid FOR UPDATE`;
      const [identity] = await tx.$queryRaw<Array<{ pid: number; xid: string }>>`
        SELECT pg_backend_pid() AS pid, pg_current_xact_id()::xid::text AS xid`;
      holderIdentity = identity;
      documentHeld.resolve();
      await releaseDocument.promise;
    }, { timeout: 60_000 });
    await documentHeld.promise;
    const approval = claimService
      .transition(ctx(tenant.workspaceId, tenant.userId), pendingClaimId, 'APPROVED', 1)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));
    const approvalWaiter = await waitingBackend('%seller_document%FOR UPDATE%');
    expect(approvalWaiter.xid).not.toBeNull();
    expect(await blockedBy(approvalWaiter.pid)).toContainEqual({
      locktype: 'transactionid',
      xid: holderIdentity?.xid,
    });
    const consumption = icpService
      .generateFromCompany(ctx(tenant.workspaceId, tenant.userId), tenant.companyId)
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error }));
    const icpWaiter = await waitingBackend('%company_profile%FOR NO KEY UPDATE%');
    expect(await blockedBy(icpWaiter.pid)).toContainEqual({
      locktype: 'transactionid',
      xid: approvalWaiter.xid,
    });
    releaseDocument.resolve();
    await holder;
    releaseUnrelated.resolve();
    await Promise.all([unrelatedHolder, unrelatedWaiter]);
    const [approvedResult, consumedResult] = await Promise.all([approval, consumption]);
    expect(approvedResult).toEqual({ ok: true });
    expect(consumedResult).toMatchObject({ ok: true, value: { name: 'Synthetic activation-overlap ICP', companyId: tenant.companyId } });
    expect(await owner.companyProfile.findUniqueOrThrow({ where: { id: tenant.companyId } })).toMatchObject({ status: 'ACTIVE' });
    expect(await owner.icpDefinition.count({ where: { companyId: tenant.companyId } })).toBe(1);
  });
});
