import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { ExecutionBudgetAuthorityRepository } from './execution-budget-authority.repository';
import type { ExecutionBudgetPurpose, VerifiedExecutionBudgetAuthority } from './execution-budget-authority.types';

const REQUESTED = process.env.MARKET_CANDIDATE_GENERATION_DATABASE_TEST === '1';
const OWNER = process.env.MARKET_CANDIDATE_GENERATION_TEST_DATABASE_URL;
const APP = process.env.MARKET_CANDIDATE_GENERATION_TEST_APP_DATABASE_URL;
if (REQUESTED) {
  if (!OWNER || !APP || process.env.APP_DATABASE_URL !== APP) throw new Error('B2_EXPLICIT_TEST_URL_PAIR_REQUIRED');
  const [owner, app] = [new URL(OWNER), new URL(APP)];
  if ([owner, app].some(url => url.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== '/global_test' || url.search || url.hash) || owner.host !== app.host || app.username !== 'app_user') {
    throw new Error('B2_DISPOSABLE_LOOPBACK_GLOBAL_TEST_ONLY');
  }
}
const suite = REQUESTED ? describe : describe.skip;
const PAIRS = [
  ['understanding.run', 'company', 1800, 'UNDERSTANDING_RUN'],
  ['icp.design', 'company', 1800, 'ICP_DESIGN'],
  ['icp.query_plan', 'icp', 1800, 'ICP_QUERY_PLAN'],
  ['icp.rejudge', 'icp', 3600, 'ICP_REJUDGE'],
  ['discovery.run', 'discovery_run', 10800, 'DISCOVERY_RUN'],
  ['discovery.run', 'company', null, 'DISCOVERY_RUN'],
  ['contact.verify', 'contact_point', null, 'CONTACT_VERIFY'],
  ['contact.enrich', 'company', null, 'CONTACT_ENRICH'],
  ['outreach.draft', 'lead', null, 'OUTREACH_DRAFT'],
  ['campaign.plan', 'campaign', null, 'CAMPAIGN_PLAN'],
  ['market.candidates.generate', 'market_candidate_generation', 1800, 'MARKET_CANDIDATES_GENERATE'],
] as const;
const WRONG_PAIRS = [...new Set(PAIRS.map(([purpose]) => purpose))].flatMap(purpose =>
  [...new Set(PAIRS.map(([, subject]) => subject))]
    .filter(subject => !PAIRS.some(([allowedPurpose, allowedSubject]) => allowedPurpose === purpose && allowedSubject === subject))
    .map(subject => [purpose, subject] as const),
);

suite('workspace purpose compatibility on the actual isolated app_user consumer', () => {
  let owner: PrismaClient;
  let app: PrismaService;
  let repository: ExecutionBudgetAuthorityRepository;
  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: OWNER });
    app = new PrismaService();
    const [principal] = await app.$queryRaw<Array<{ database: string; session: string; current: string; superuser: boolean; bypass: boolean }>>`
      SELECT current_database() AS database, session_user AS session, current_user AS current,
             rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user`;
    expect(principal).toEqual({ database: 'global_test', session: 'app_user', current: 'app_user', superuser: false, bypass: false });
    repository = new ExecutionBudgetAuthorityRepository(app);
  });
  afterAll(async () => { await app?.$disconnect(); await owner?.$disconnect(); });

  async function fixture(purpose: string, subjectType: string): Promise<VerifiedExecutionBudgetAuthority> {
    const workspaceId = randomUUID(), now = Math.floor(Date.now() / 1000);
    await owner.workspace.create({ data: { id: workspaceId, name: 'Synthetic B2 compatibility fixture only' } });
    return { schemaVersion: 'execution-budget-grant/v1', authorityKind: 'WORKSPACE_GRANT',
      issuer: 'https://synthetic-control.example.test', audience: 'global-backend:execution-budget',
      jti: randomUUID(), tokenSha256: randomBytes(32).toString('hex'), purpose: purpose as ExecutionBudgetPurpose,
      workspaceId, subjectType, subjectId: randomUUID(), requestSha256: 'c'.repeat(64), scheduleId: null,
      currency: 'USD', unit: 'microusd', capMicrousd: 800_000n, capPerRunMicrousd: null,
      campaignCapMicrousd: null, maxRuns: null, issuedAt: now - 5, notBefore: now - 5, expiresAt: now + 240 };
  }

  function consumeRaw(tx: Prisma.TransactionClient, grant: VerifiedExecutionBudgetAuthority) {
    return tx.$queryRaw<Array<{ authority_id: string; replay: boolean }>>`
      SELECT * FROM consume_workspace_execution_authority(${grant.issuer}, ${grant.audience}, ${grant.jti}::uuid,
        ${grant.tokenSha256}, ${grant.schemaVersion}, ${grant.purpose}::execution_budget_purpose,
        ${grant.workspaceId}::uuid, ${grant.subjectType}, ${grant.subjectId}, ${grant.requestSha256},
        ${grant.currency}, ${grant.unit}, ${grant.capMicrousd},
        ${new Date(grant.issuedAt * 1000)}, ${new Date(grant.notBefore * 1000)}, ${new Date(grant.expiresAt * 1000)})`;
  }

  it.each(PAIRS)('admits %s / %s with its exact old-or-new lease and readable Prisma mapping', async (purpose, subjectType, leaseSeconds, mappedPurpose) => {
    const grant = await fixture(purpose, subjectType), key = `${purpose}:${subjectType}:${grant.subjectId}:${grant.requestSha256}`;
    const binding = await repository.consumeWorkspaceAndOpen(grant, key);
    expect(binding.authorizedCapMicrousd).toBe(800_000n);
    const [stored] = await app.withWorkspace(grant.workspaceId!, tx => tx.$queryRaw<Array<{ purpose: string; subject: string; leaseSeconds: number | null }>>`
      SELECT purpose::text AS purpose, subject_type AS subject,
        extract(epoch FROM admission_lease_expires_at-consumed_at)::integer AS "leaseSeconds"
      FROM execution_budget_authority WHERE id=${binding.authorityId}::uuid`);
    expect(stored).toEqual({ purpose, subject: subjectType, leaseSeconds });
    const typed = await app.withWorkspace(grant.workspaceId!, tx => tx.executionBudgetAuthority.findUnique({ where: { id: binding.authorityId } }));
    expect(typed?.purpose).toBe(mappedPurpose);
  });

  it.each(WRONG_PAIRS)('refuses undeclared %s / %s without leaving an authority or account', async (purpose, subjectType) => {
    const grant = await fixture(purpose, subjectType);
    await expect(repository.consumeWorkspaceAndOpen(grant, `synthetic:${randomUUID()}`)).rejects.toThrow('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');
    const [count] = await app.withWorkspace(grant.workspaceId!, tx => tx.$queryRaw<Array<{ authorities: number; accounts: number }>>`
      SELECT (SELECT count(*)::int FROM execution_budget_authority) AS authorities,
             (SELECT count(*)::int FROM tool_budget_account) AS accounts`);
    expect(count).toEqual({ authorities: 0, accounts: 0 });
  });

  it.each(['platform.acquisition', 'platform.intent_watch', 'platform.sanctions', 'platform.channel_crawl'])(
    'keeps %s out of the workspace consumer', async purpose => {
      const grant = await fixture(purpose, 'market_candidate_generation');
      await expect(repository.consumeWorkspaceAndOpen(grant, `synthetic:${randomUUID()}`)).rejects.toThrow('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');
    },
  );

  it('binds SQL consumption to the transaction-local workspace, not the supplied UUID alone', async () => {
    const grant = await fixture('icp.design', 'company');
    const foreign = await fixture('icp.design', 'company');
    await expect(app.withWorkspace(foreign.workspaceId!, tx => consumeRaw(tx, grant))).rejects.toThrow(/EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH/u);
  });

  it('replays the same authority tuple but rejects a changed request under the same JTI', async () => {
    const grant = await fixture('icp.design', 'company');
    const first = await repository.consumeWorkspace(grant);
    expect(first.replay).toBe(false);
    await expect(repository.consumeWorkspace(grant)).resolves.toEqual({ authorityId: first.authorityId, replay: true });
    await expect(repository.consumeWorkspace({ ...grant, requestSha256: 'd'.repeat(64) })).rejects.toThrow('EXECUTION_BUDGET_GRANT_REUSED');
  });

  it('does not let a new admission exceed the original five-minute JWT span', async () => {
    const grant = await fixture('icp.design', 'company');
    await expect(repository.consumeWorkspace({ ...grant, expiresAt: grant.issuedAt + 301 })).rejects.toThrow('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');
  });

  it('refuses an actually expired first admission without converting expiry into a lease', async () => {
    const grant = await fixture('icp.design', 'company');
    await expect(repository.consumeWorkspace({ ...grant, issuedAt: grant.issuedAt - 600, notBefore: grant.notBefore - 600, expiresAt: grant.expiresAt - 600 })).rejects.toThrow('EXECUTION_BUDGET_GRANT_EXPIRED');
  });

  it.each([0n, -1n])('refuses nonpositive cap %s before opening an account', async capMicrousd => {
    const grant = await fixture('icp.design', 'company');
    await expect(repository.consumeWorkspaceAndOpen({ ...grant, capMicrousd }, `synthetic:${randomUUID()}`)).rejects.toThrow('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');
  });
});
