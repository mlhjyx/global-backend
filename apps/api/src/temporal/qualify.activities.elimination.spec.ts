import { describe, expect, it, vi } from 'vitest';
import { createQualifyActivities } from './qualify.activities';

const WS = '10000000-0000-4000-8000-000000000001';
const ICP = '20000000-0000-4000-8000-000000000002';

function makeQualifyHarness(opts: {
  companies: Array<{
    id: string;
    name: string;
    contactPoints?: Array<{
      type: string;
      status: string;
      sourceType?: string | null;
      verificationMethod?: string | null;
    }>;
  }>;
  existingLeads?: Record<string, { id: string; status: string; fitVerdict: string | null; fitReasons?: unknown }>;
  jobs?: Array<{
    canonicalCompanyId: string;
    stage: string;
    verdictQuick: string | null;
    verdictDeep: string | null;
    lastErrorCode: string | null;
    createdAt: Date;
  }>;
  judgments?: Array<{
    canonicalCompanyId: string;
    verdict: string;
    createdAt: Date;
  }>;
}) {
  const leadUpsert = vi.fn(async (args: { create: { canonicalCompanyId: string; queue: string } }) => ({
    id: `lead:${args.create.canonicalCompanyId}`,
  }));
  const companies = opts.companies.map((c) => ({
    id: c.id,
    name: c.name,
    domain: `${c.id}.example`,
    country: 'IT',
    industry: 'solar',
    employeeCount: 50,
    revenueUsd: null,
    attributes: {},
    status: 'ENRICHED',
    contacts: c.contactPoints
      ? [{ id: `ct-${c.id}`, title: 'Procurement Director', seniority: 'director', contactPoints: c.contactPoints }]
      : [],
    companyContactPoints: [],
  }));
  const tx = {
    icpDefinition: {
      findUnique: vi.fn(async () => ({ status: 'ACTIVE', rules: [], roles: [], triggerSignals: [] })),
    },
    canonicalCompany: {
      findMany: vi.fn(async (args?: { where?: { id?: { gt?: string } } }) =>
        args?.where?.id?.gt ? [] : companies,
      ),
    },
    suppressionRecord: { findMany: vi.fn(async () => []) },
    fieldEvidence: { findMany: vi.fn(async () => []) },
    sanctionsScreeningResult: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    discoveryCompanyJob: {
      findMany: vi.fn(async () => opts.jobs ?? []),
    },
    judgmentRecord: {
      findMany: vi.fn(async () => opts.judgments ?? []),
    },
    lead: {
      findUnique: vi.fn(
        async (args: { where: { workspaceId_icpId_canonicalCompanyId: { canonicalCompanyId: string } } }) => {
          const cid = args.where.workspaceId_icpId_canonicalCompanyId.canonicalCompanyId;
          const existing = opts.existingLeads?.[cid];
          return existing ? { ...existing, decisions: [] } : null;
        },
      ),
      upsert: leadUpsert,
    },
    outboxEvent: { create: vi.fn(async () => ({})) },
    discoveryRun: { findUnique: vi.fn(async () => null) },
    runEvent: { findFirst: vi.fn(async () => null), aggregate: vi.fn(async () => ({ _max: { seq: 0n } })), create: vi.fn(async () => ({})) },
    $queryRaw: vi.fn(async () => []),
  };
  const activities = createQualifyActivities({
    prisma: {
      withWorkspace: async <T>(_ws: string, cb: (client: typeof tx) => Promise<T>) => cb(tx),
    } as never,
  });
  return { activities, leadUpsert };
}

describe('Phase 1: scoreCandidates does not resurrect eliminated companies and rejects pattern_guess reachability', () => {
  it('skips creating leads for prefiltered_out, quick_scan=mismatch, deep=mismatch, gate-blocked, and NOT_FIT companies', async () => {
    const t = new Date('2026-11-25T10:00:00Z');
    const h = makeQualifyHarness({
      companies: [
        { id: 'c-prefilter', name: 'Prefiltered Junk Ltd' },
        { id: 'c-quick-mismatch', name: 'Quick Mismatch Ltd' },
        { id: 'c-deep-mismatch', name: 'Deep Mismatch Ltd' },
        { id: 'c-gate-blocked', name: 'Gate Blocked Ltd' },
        { id: 'c-not-fit', name: 'Not Fit Judgment Ltd' },
        { id: 'c-valid-match', name: 'Real Solar Buyer Srl' },
      ],
      jobs: [
        { canonicalCompanyId: 'c-prefilter', stage: 'prefiltered_out', verdictQuick: null, verdictDeep: null, lastErrorCode: null, createdAt: t },
        { canonicalCompanyId: 'c-quick-mismatch', stage: 'quick_judged', verdictQuick: 'mismatch', verdictDeep: null, lastErrorCode: null, createdAt: t },
        { canonicalCompanyId: 'c-deep-mismatch', stage: 'done', verdictQuick: 'weak', verdictDeep: 'mismatch', lastErrorCode: null, createdAt: t },
        { canonicalCompanyId: 'c-gate-blocked', stage: 'skipped', verdictQuick: null, verdictDeep: null, lastErrorCode: 'GATE_SANCTIONS_FAIL', createdAt: t },
        { canonicalCompanyId: 'c-valid-match', stage: 'done', verdictQuick: 'match', verdictDeep: 'match', lastErrorCode: null, createdAt: t },
      ],
      judgments: [
        { canonicalCompanyId: 'c-not-fit', verdict: 'NOT_FIT', createdAt: t },
      ],
      existingLeads: {
        'c-valid-match': { id: 'lead-ok', status: 'DISCOVERED', fitVerdict: 'match' },
      },
    });

    const res = await h.activities.scoreCandidates({ workspaceId: WS, icpId: ICP });

    expect(res.scored).toBe(1);
    expect(h.leadUpsert).toHaveBeenCalledTimes(1);
    const upsertedIds = h.leadUpsert.mock.calls.map(
      (call) => (call[0] as { create: { canonicalCompanyId: string } }).create.canonicalCompanyId,
    );
    expect(upsertedIds).toEqual(['c-valid-match']);
  });

  it('passes sourceType/verificationMethod into scoreLead so blind pattern_guess/RISKY contact points score 0 reachability', async () => {
    const h = makeQualifyHarness({
      companies: [
        {
          id: 'c-guess-only',
          name: 'Blind Guess Solar Srl',
          contactPoints: [
            { type: 'email', status: 'RISKY', sourceType: 'pattern_guess', verificationMethod: 'pattern_guess' },
            { type: 'email', status: 'UNVERIFIED', sourceType: 'pattern_guess', verificationMethod: 'pattern_guess' },
          ],
        },
      ],
      existingLeads: {
        'c-guess-only': { id: 'lead-guess', status: 'DISCOVERED', fitVerdict: 'match' },
      },
    });

    await h.activities.scoreCandidates({ workspaceId: WS, icpId: ICP });

    expect(h.leadUpsert).toHaveBeenCalledTimes(1);
    const update = (h.leadUpsert.mock.calls[0]![0] as { update: { queue: string; scores: { reachability: number } } }).update;
    expect(update.scores.reachability).toBe(0);
    expect(update.queue).toBe('needs_review');
  });
});
