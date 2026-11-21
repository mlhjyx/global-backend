import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_VERSION } from '../discovery/discovery-company-materialization-ctx';
import { EVIDENCE } from '../discovery/manufacturer-network.test-fixture';
import { loadManufacturerProofExpiries } from './manufacturer-proof-validity';
import { LeadService } from './lead.service';

// Reuse the existing CI PG pair; the dedicated pair is for a separate local TTL database.
const ownerUrl = process.env.MANUFACTURER_VALIDITY_TEST_DATABASE_URL ?? process.env.LEAD_QUEUE_BASIS_TEST_DATABASE_URL;
const appUrl = process.env.MANUFACTURER_VALIDITY_TEST_APP_DATABASE_URL ?? process.env.LEAD_QUEUE_BASIS_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) throw new Error('MANUFACTURER_VALIDITY_TEST_URL_PAIR_REQUIRED');
for (const value of [ownerUrl, appUrl]) if (value) {
  const u = new URL(value);
  if (u.protocol !== 'postgresql:' || u.hostname !== '127.0.0.1' || u.port === '15433' ||
    !(u.pathname === '/global_test' || /^\/manufacturer_ttl_test_[a-f0-9]{8}$/u.test(u.pathname))) {
    throw new Error('MANUFACTURER_VALIDITY_DISPOSABLE_DATABASE_REQUIRED');
  }
}

if (ownerUrl && appUrl) {
  const owner = new URL(ownerUrl), app = new URL(appUrl);
  if (owner.hostname !== app.hostname || owner.port !== app.port || owner.pathname !== app.pathname) {
    throw new Error('MANUFACTURER_VALIDITY_SAME_TEST_DATABASE_REQUIRED');
  }
}

// Owner seeds synthetic metadata under the unchanged migrated schema. This tests
// the readonly SQL/service/ACL, not a new Broker, wire or real company proof.
describe.runIf(Boolean(ownerUrl && appUrl))('manufacturer validity on PostgreSQL', { timeout: 60_000 }, () => {
  let owner: PrismaClient, app: PrismaClient;
  const workspaces: string[] = [], digests: string[] = [];
  const withWorkspace = <T>(workspaceId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    app.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
      return fn(tx);
    });
  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: ownerUrl }); app = new PrismaClient({ datasourceUrl: appUrl });
    const [role] = await app.$queryRaw<{ role: string; superuser: string; bypass: boolean; read: boolean; write: boolean }[]>`
      SELECT current_user AS role,current_setting('is_superuser') AS superuser,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass,
        has_table_privilege(current_user,'public.manufacturer_network_evidence','SELECT') AS read,
        has_table_privilege(current_user,'public.manufacturer_network_evidence','INSERT') AS write`;
    expect(role).toEqual({ role: 'app_user', superuser: 'off', bypass: false, read: true, write: false });
  });
  async function fixture() {
    const workspaceId = randomUUID(); workspaces.push(workspaceId);
    await owner.workspace.create({ data: { id: workspaceId, name: 'manufacturer TTL fixture' } });
    const seller = await owner.companyProfile.create({ data: { workspaceId, name: 'synthetic seller' } });
    const icp = await owner.icpDefinition.create({ data: { workspaceId, companyId: seller.id, name: 'TTL fixture ICP' } });
    const plan = await owner.discoveryQueryPlan.create({ data: { workspaceId, icpId: icp.id, queries: [] } });
    const company = await owner.canonicalCompany.create({ data: { workspaceId, name: EVIDENCE.targetName,
      domain: EVIDENCE.targetDomain, country: 'DE', dedupeKey: randomUUID() } });
    const lead = await owner.lead.create({ data: { workspaceId, icpId: icp.id, canonicalCompanyId: company.id,
      status: 'REVIEW', fitVerdict: 'match' } });
    const authorityId = randomUUID();
    await owner.$executeRaw`INSERT INTO execution_budget_authority(id,scope_key,authority_kind,workspace_id,issuer,audience,jti,token_sha256,schema_version,purpose,subject_type,subject_id,request_sha256,currency,unit,cap_microusd,runs_consumed,issued_at,not_before,expires_at,consumed_at)
      VALUES(${authorityId}::uuid,${workspaceId},'WORKSPACE_GRANT',${workspaceId}::uuid,'https://control.example','global-backend:execution-budget',${randomUUID()}::uuid,${createHash('sha256').update(randomUUID()).digest('hex')},'execution-budget-grant/v1','discovery.run','discovery_run',${'request:' + 'a'.repeat(64)},${'a'.repeat(64)},'USD','microusd',1000000,0,now()-interval '1 minute',now()-interval '1 minute',now()+interval '4 minutes',now())`;
    const account = await owner.toolBudgetAccount.create({ data: { scopeKey: workspaceId, accountKey: `ttl:${randomUUID()}`,
      capCents: 0n, authorityId, authorizedCapMicrousd: 1000000n } });
    async function proof(fetchedAt: Date, expiresAt: Date) {
      const run = await owner.discoveryRun.create({ data: { workspaceId, icpId: icp.id, planId: plan.id,
        materializationContractVersion: DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_VERSION } });
      const op = await owner.toolBudgetOperation.create({ data: { scopeKey: workspaceId, accountId: account.id,
        generation: 1, operationKey: randomUUID(), reservedCents: 0n, reservedMicrousd: 10000n, amountUnit: 'microusd' } });
      const sha = createHash('sha256').update(randomUUID()).digest('hex'); digests.push(sha);
      const object = { sha256: sha, objectKey: `generic-operation-results/v1/final/public-organization/sha256/${sha.slice(0, 2)}/${sha}`,
        sizeBytes: 1n, mediaType: 'text/markdown', privacyClass: 'PUBLIC_ORGANIZATION' };
      await owner.genericOperationArtifactObject.create({ data: object });
      const artifact = await owner.genericOperationArtifact.create({ data: { ...object, scopeKey: workspaceId, workspaceId,
        authorityId, operationId: op.id, resultSchema: 'crawl4ai-fetch/v1', createdAt: fetchedAt, expiresAt,
        expectedSanitizedUrl: EVIDENCE.sourceUrl, expectedContentHash: EVIDENCE.contentHash } });
      const value = { ...EVIDENCE, workspaceId, companyId: company.id, artifactId: artifact.id, operationId: op.id,
        resultDigest: sha, fetchedAt: fetchedAt.toISOString(), expiresAt: expiresAt.toISOString() };
      await owner.manufacturerNetworkEvidence.create({ data: { workspaceId, companyId: company.id, runId: run.id,
        artifactId: artifact.id, searchOperationId: op.id, evidence: value } });
      await owner.fieldEvidence.create({ data: field(value) });
      await owner.canonicalCompany.update({ where: { id: company.id }, data: { attributes: { manufacturer_network: { evidence: value } } } });
      return value;
    }
    function field(value: typeof EVIDENCE) {
      return { workspaceId, entityType: 'company', entityId: company.id, field: 'manufacturer_network.evidence',
        value, providerKey: 'manufacturer_network', license: value.licenseLabel, allowedActions: value.allowedActions,
        sourceUrl: value.sourceUrl, fetchedAt: new Date(value.fetchedAt) };
    }
    const read = () => withWorkspace(workspaceId, async tx => {
      const current = await tx.canonicalCompany.findUniqueOrThrow({ where: { id: company.id } });
      const fields = await tx.fieldEvidence.groupBy({ by: ['entityId', 'field', 'dataClass'],
        where: { entityId: company.id }, _max: { fetchedAt: true } });
      return (await loadManufacturerProofExpiries(tx, workspaceId, [current], fields)).get(company.id);
    });
    const service = new LeadService({ withWorkspace } as never, {} as never, {} as never);
    return { workspaceId, company, lead, proof, field, read, service };
  }
  it('uses the newest field and keeps real expired JSON in GET instead of a future fallback', async () => {
    const f = await fixture(), now = Date.now();
    await f.proof(new Date(now - 7200000), new Date(now - 3600000));
    const current = await f.proof(new Date(now - 1800000), new Date(now + 3600000));
    expect(await f.read()).toBe(current.expiresAt);
    const expired = await f.proof(new Date(now - 300000), new Date(now - 60000));
    expect(await f.read()).toBe(expired.expiresAt);
    const pkg = await f.service.leadPackage({ workspaceId: f.workspaceId } as never, f.lead.id);
    expect(pkg.valid_until).toBe(expired.expiresAt); expect(Date.parse(pkg.valid_until!)).toBeLessThan(now);
  });
  it('enforces app_user RLS and exact current company identity', async () => {
    const f = await fixture(), other = await fixture(), now = Date.now();
    await f.proof(new Date(now - 300000), new Date(now + 3600000));
    const c = await owner.canonicalCompany.findUniqueOrThrow({ where: { id: f.company.id } });
    const fields = [{ entityId: c.id, field: 'manufacturer_network.evidence' }];
    expect(await withWorkspace(other.workspaceId, async tx =>
      (await loadManufacturerProofExpiries(tx, other.workspaceId, [c], fields)).get(c.id))).toBeNull();
    expect(await withWorkspace(f.workspaceId, async tx =>
      (await loadManufacturerProofExpiries(tx, f.workspaceId, [{ ...c, domain: 'other.example' }], fields)).get(c.id))).toBeNull();
    const denied = await f.service.leadPackage({ workspaceId: other.workspaceId } as never, f.lead.id).catch(error => error);
    expect(denied.getStatus()).toBe(404);
    expect(denied.getResponse()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
  it('rejects a writable forged latest FE and denies app_user writes to the authoritative proof table', async () => {
    const f = await fixture(), now = Date.now();
    const valid = await f.proof(new Date(now - 300000), new Date(now + 3600000));
    const forged = { ...valid, fetchedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 7200000).toISOString() };
    await withWorkspace(f.workspaceId, tx => tx.fieldEvidence.create({ data: f.field(forged) }));
    expect(await f.read()).toBeNull();
    expect((await f.service.leadPackage({ workspaceId: f.workspaceId } as never, f.lead.id)).valid_until).toBeNull();
    await expect(withWorkspace(f.workspaceId, tx => tx.manufacturerNetworkEvidence.deleteMany({ where: { companyId: f.company.id } })))
      .rejects.toThrow(/permission denied/iu);
  });
  afterAll(async () => {
    if (!owner) return;
    try {
      await owner.manufacturerNetworkEvidence.deleteMany({ where: { workspaceId: { in: workspaces } } });
      await owner.fieldEvidence.deleteMany({ where: { workspaceId: { in: workspaces } } });
      await owner.genericOperationArtifact.deleteMany({ where: { workspaceId: { in: workspaces } } });
      await owner.toolBudgetOperation.deleteMany({ where: { scopeKey: { in: workspaces } } });
      await owner.toolBudgetAccount.deleteMany({ where: { scopeKey: { in: workspaces } } });
      await owner.executionBudgetAuthority.deleteMany({ where: { workspaceId: { in: workspaces } } });
      await owner.workspace.deleteMany({ where: { id: { in: workspaces } } });
      await owner.genericOperationArtifactObject.deleteMany({ where: { sha256: { in: digests } } });
    } finally { await Promise.all([owner.$disconnect(), app?.$disconnect()]); }
  });
});
