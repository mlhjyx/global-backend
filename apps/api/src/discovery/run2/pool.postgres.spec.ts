import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadQuickScanPool } from './pool';
import { createRun2Activities } from '../../temporal/discovery.run2.activities';
import { createRun2PipelineActivities } from '../../temporal/discovery.run2.pipeline.activities';

const url = process.env.RUN_EVENTS_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
      !['/global_test', '/run_events_test'].includes(parsed.pathname)) throw new Error('pool recovery requires a loopback test database');
}

describe.runIf(Boolean(url))('provisional recovery on PostgreSQL', () => {
  const owner = new PrismaClient({ datasourceUrl: url });
  afterAll(async () => owner.$disconnect());
  async function fixture() {
    const workspaceId = randomUUID();
    await owner.workspace.create({ data: { id: workspaceId, name: 'pool recovery fixture' } });
    const company = await owner.companyProfile.create({ data: { workspaceId, name: 'fixture seller' } });
    const icp = await owner.icpDefinition.create({ data: { workspaceId, companyId: company.id, name: 'fixture icp' } });
    const plan = await owner.discoveryQueryPlan.create({ data: { workspaceId, icpId: icp.id, queries: [] } });
    const run = await owner.discoveryRun.create({ data: { workspaceId, icpId: icp.id, planId: plan.id,
      materializationContractVersion: 'discovery-company-materialization/v1' } });
    const withWorkspace = async <T>(ws: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
      owner.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$queryRaw`SELECT set_config('app.current_workspace_id', ${ws}, true)`;
        return fn(tx);
      });
    async function canonical(name: string) {
      return owner.canonicalCompany.create({ data: { workspaceId, name, country: 'DE', dedupeKey: randomUUID() } });
    }
    return { workspaceId, icpId: icp.id, runId: run.id, planId: plan.id, withWorkspace, canonical };
  }
  async function clean(workspaceId: string) {
    await owner.runEvent.deleteMany({ where: { workspaceId } });
    await owner.discoveryCompanyJob.deleteMany({ where: { workspaceId } });
    await owner.discoveryRun.deleteMany({ where: { workspaceId } });
    await owner.lead.deleteMany({ where: { workspaceId } });
    await owner.canonicalCompany.deleteMany({ where: { workspaceId } });
    await owner.workspace.deleteMany({ where: { id: workspaceId } });
  }

  it('recovers only exact provisional markers without reopening final, null-reason or human decisions', async () => {
    const f = await fixture();
    try {
      const included: string[] = [];
      for (const [kind, verdict, reasons] of [
        ['no_lead', null, undefined], ['unjudged', null, Prisma.DbNull],
        ['quick_match', 'match', { source: 'quick_scan' }], ['quick_weak', 'weak', { source: 'quick_scan' }],
        ['final_match', 'match', { role: 'final' }], ['final_weak', 'weak', { reasons: ['final'] }],
        ['final_mismatch', 'mismatch', { reasons: ['final'] }], ['sql_null', 'weak', Prisma.DbNull],
        ['json_null', 'weak', Prisma.JsonNull], ['missing_source', 'weak', {}],
        ['other_source', 'weak', { source: 'legacy_judge' }],
      ] as const) {
        const c = await f.canonical(kind);
        if (kind !== 'no_lead') await owner.lead.create({ data: { workspaceId: f.workspaceId,
          icpId: f.icpId, canonicalCompanyId: c.id, fitVerdict: verdict, fitReasons: reasons as never } });
        if (['no_lead', 'unjudged', 'quick_match', 'quick_weak'].includes(kind)) included.push(c.id);
      }
      const human = await f.canonical('human accepted');
      await owner.lead.create({ data: { workspaceId: f.workspaceId, icpId: f.icpId, canonicalCompanyId: human.id,
        status: 'QUALIFIED', fitVerdict: null, fitReasons: Prisma.DbNull } });
      const otherIcp = await f.canonical('other icp');included.push(otherIcp.id);
      await owner.lead.create({ data: { workspaceId: f.workspaceId, icpId: randomUUID(), canonicalCompanyId: otherIcp.id,
        fitVerdict: 'match', fitReasons: { role: 'final' } } });
      const suppressed = await f.canonical('suppressed');
      await owner.canonicalCompany.update({ where: { id: suppressed.id }, data: { status: 'SUPPRESSED' } });
      const result = await f.withWorkspace(f.workspaceId, (tx) => loadQuickScanPool(tx, f, 500));
      expect(result.companies.map((c) => c.id).sort()).toEqual(included.sort());
      expect(result.poolSize).toBe(included.length);
    } finally { await clean(f.workspaceId); }
  }, 60_000);

  it('does not let a stale quick job overwrite a final record selected before materialization', async () => {
    const f = await fixture();
    try {
      const company = await f.canonical('final race');
      await owner.discoveryCompanyJob.create({ data: { workspaceId: f.workspaceId, runId: f.runId,
        canonicalCompanyId: company.id, stage: 'quick_judged', verdictQuick: 'weak' } });
      const final = await owner.lead.create({ data: { workspaceId: f.workspaceId, icpId: f.icpId,
        canonicalCompanyId: company.id, fitVerdict: 'match', fitReasons: { role: 'final' }, queue: 'recommended', version: 7 } });
      const hash = 'c'.repeat(64);
      const acts = createRun2Activities({ prisma: { withWorkspace: f.withWorkspace } as never,
        gateway: {} as never, providers: {} as never, budgetStore: { attestAuthorized: vi.fn(async () => ({})) } as never });
      const result = await acts.materializeProvisionalLeads({ ...f, executionContractVersion: 2,
        executionBudget: { authorityId: randomUUID(), replay: false, scopeKey: f.workspaceId,
          accountKey: `discovery.run:discovery_run:request:${hash}:${hash}`, purpose: 'discovery.run',
          subjectType: 'discovery_run', subjectId: `request:${hash}`, requestSha256: hash } });
      expect(result.leads).toBe(0);
      expect(await owner.lead.findUnique({ where: { id: final.id } })).toEqual(final);
    } finally { await clean(f.workspaceId); }
  }, 60_000);

  it('does not let provisional recovery bypass current-run procurement admission', async () => {
    const f = await fixture();
    try {
      await owner.discoveryQueryPlan.update({ where: { id: f.planId }, data: {
        queries: [{ filters: { procurement_scenario: 'factory_direct' } }],
      } });
      const c = await f.canonical('not admitted in this run');
      await owner.lead.create({ data: { workspaceId: f.workspaceId, icpId: f.icpId,
        canonicalCompanyId: c.id, fitVerdict: 'weak', fitReasons: { source: 'quick_scan' } } });
      const result = await f.withWorkspace(f.workspaceId, (tx) =>
        loadQuickScanPool(tx, { ...f, afterProcurementSearch: true }, 500));
      expect(result.requiresProcurementSearch).toBe(true);
      expect(result.poolSize).toBe(0);expect(result.companies).toEqual([]);
    } finally { await clean(f.workspaceId); }
  }, 60_000);

  it('keeps workspace isolation and the 500-row read bound when more candidates are available', async () => {
    const f = await fixture();const foreign = await fixture();
    try {
      await owner.canonicalCompany.createMany({ data: Array.from({ length: 501 }, (_, index) => ({
        workspaceId: f.workspaceId, name: `owned pool fixture ${index}`, dedupeKey: randomUUID(), country: 'DE',
      })) });
      await foreign.canonical('foreign workspace fixture');
      const result = await f.withWorkspace(f.workspaceId, (tx) => loadQuickScanPool(tx, f, 500));
      expect(result.poolSize).toBe(501);expect(result.companies).toHaveLength(500);
      expect(result.companies.every((company) => company.name.startsWith('owned pool fixture'))).toBe(true);
    } finally { await clean(f.workspaceId);await clean(foreign.workspaceId); }
  }, 60_000);
  it('gives later quick matches the first quoted evidence slots while retaining RLS and deterministic ties', async () => {
    const f = await fixture(); const foreign = await fixture();
    try {
      const matches = Array.from({ length: 4 }, () => randomUUID());
      const weak = Array.from({ length: 60 }, () => randomUUID());
      const excluded = [randomUUID(), randomUUID()];
      await owner.canonicalCompany.createMany({ data: [...weak, ...matches, ...excluded].map(id =>
        ({ id, workspaceId: f.workspaceId, name: `priority fixture ${id}`, dedupeKey: id })) });
      await owner.discoveryCompanyJob.createMany({ data: [
        ...weak.map(id => ({ workspaceId: f.workspaceId, runId: f.runId, canonicalCompanyId: id,
          stage: 'quick_judged', verdictQuick: 'weak', createdAt: new Date('2026-01-01T00:00:00Z') })),
        ...matches.map(id => ({ workspaceId: f.workspaceId, runId: f.runId, canonicalCompanyId: id,
          stage: 'quick_judged', verdictQuick: 'match', createdAt: new Date('2026-02-01T00:00:00Z') })),
        { workspaceId: f.workspaceId, runId: f.runId, canonicalCompanyId: excluded[0]!, verdictQuick: 'mismatch' },
        { workspaceId: f.workspaceId, runId: f.runId, canonicalCompanyId: excluded[1]!, verdictQuick: null },
      ] });
      const other = await foreign.canonical('foreign match');
      await owner.discoveryCompanyJob.create({ data: { workspaceId: foreign.workspaceId, runId: foreign.runId,
        canonicalCompanyId: other.id, verdictQuick: 'match' } });
      const acts = createRun2PipelineActivities({ prisma: { withWorkspace: f.withWorkspace } as never,
        gateway: {} as never, providers: {} as never });
      const first = await acts.listDeepTargets({ workspaceId: f.workspaceId, runId: f.runId });
      const second = await acts.listDeepTargets({ workspaceId: f.workspaceId, runId: f.runId });
      expect(first.companyIds).toHaveLength(64);
      expect(first.companyIds.slice(0, 4)).toEqual([...matches].sort());
      expect(first.companyIds.slice(4)).toEqual([...weak].sort());
      expect(first.companyIds.slice(0, 50)).toEqual(expect.arrayContaining(matches));
      for (const id of excluded) expect(first.companyIds).not.toContain(id);
      expect(first.companyIds).not.toContain(other.id);
      expect(second.companyIds).toEqual(first.companyIds);
    } finally { await clean(f.workspaceId); await clean(foreign.workspaceId); }
  }, 60_000);

  it('keeps the 500-target cap without letting earlier weak jobs displace matches', async () => {
    const f = await fixture();
    try {
      const matches = Array.from({ length: 501 }, () => randomUUID());
      const weak = Array.from({ length: 10 }, () => randomUUID());
      await owner.canonicalCompany.createMany({ data: [...weak, ...matches].map(id =>
        ({ id, workspaceId: f.workspaceId, name: `cap fixture ${id}`, dedupeKey: id })) });
      await owner.discoveryCompanyJob.createMany({ data: [...weak.map(id => ({ workspaceId: f.workspaceId,
        runId: f.runId, canonicalCompanyId: id, verdictQuick: 'weak', createdAt: new Date('2026-01-01T00:00:00Z') })),
        ...matches.map(id => ({ workspaceId: f.workspaceId, runId: f.runId, canonicalCompanyId: id,
          verdictQuick: 'match', createdAt: new Date('2026-02-01T00:00:00Z') }))] });
      const acts = createRun2PipelineActivities({ prisma: { withWorkspace: f.withWorkspace } as never,
        gateway: {} as never, providers: {} as never });
      const result = await acts.listDeepTargets({ workspaceId: f.workspaceId, runId: f.runId });
      expect(result.companyIds).toHaveLength(500);
      expect(result.companyIds).toEqual([...matches].sort().slice(0, 500));
    } finally { await clean(f.workspaceId); }
  }, 60_000);

});
