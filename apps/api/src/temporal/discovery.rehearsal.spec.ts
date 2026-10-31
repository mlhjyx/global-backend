import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Rehearsal of a full-size discovery run, without Temporal, a database or the network.
 *
 * The real `discoveryWorkflow` drives the real activity code of the per-company stages (website
 * profile, fit, enrichment, signals, watches) over an in-memory workspace of 100 companies. Model
 * calls, page fetches and registry reads advance a simulated clock by latencies measured on xin
 * (acceptance runs 6f2d0871 and c3878e54, 2026-10-12/13), slowest tails included. Each activity
 * call is timed against the startToCloseTimeout of the proxy the workflow calls it through.
 *
 * This is what the acceptance runs kept discovering one image at a time: an activity whose work
 * grows with the company count outruns its timeout, or one isolated failure takes the run down.
 */

vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

const rehearsal = vi.hoisted(() => ({
  clock: { now: 0 },
  fitModel: vi.fn(),
}));

vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  heartbeat: vi.fn(),
}));

vi.mock('../model-runtime/structured-task-runtime-bridge', () => ({
  executeStructuredTaskWithRuntime: rehearsal.fitModel,
}));

vi.mock('../durable-results/domain-ack-consumer-bindings', () => ({
  applyDomainAckConsumerTransactions: async (input: {
    transaction: unknown;
    acknowledgements: Array<{ producerId: string }>;
    apply: (transaction: unknown) => Promise<unknown>;
  }) => ({
    status: 'APPLIED',
    acknowledgements: input.acknowledgements.map(({ producerId }) => ({ producerId, status: 'APPLIED' })),
    value: await input.apply(input.transaction),
  }),
  applyPartitionedDomainAckConsumerTransactions: async (input: {
    transaction: unknown;
    apply: (transaction: unknown, companyFacts: readonly unknown[], auxiliaryFacts: readonly unknown[]) => Promise<unknown>;
  }) => ({
    status: 'APPLIED',
    companyFacts: [],
    auxiliaryFacts: [],
    value: await input.apply(input.transaction, [], []),
  }),
  applyDomainAckConsumerTransaction: async (input: {
    transaction: unknown;
    apply: (transaction: unknown) => Promise<unknown>;
  }) => input.apply(input.transaction),
}));

import { ActivityFailure, ApplicationFailure } from '@temporalio/common';
import { acts, resetActivities } from './testing/temporal-workflow.mock';
import {
  discoveryActivityMaximumAttempts,
  discoveryActivityTimeouts,
  timeoutMilliseconds,
} from './testing/discovery-activity-timeouts';
import { createDiscoveryActivities, FIT_CONCURRENCY } from './discovery.activities';
import { discoveryWorkflow } from './discovery.workflow';
import { ProviderHttpError, ProviderTransportError } from '../model-gateway/providers/provider-output-error';
import { BudgetOperationReplayError } from '../tools/budget-store';

const WS = '10000000-0000-4000-8000-000000000001';
const SHA = 'a'.repeat(64);
const ICP_ID = '30000000-0000-4000-8000-000000000003';
const DISCOVERY_BUDGET = Object.freeze({
  authorityId: '20000000-0000-4000-8000-000000000002',
  replay: false,
  scopeKey: WS,
  accountKey: `discovery.run:discovery_run:request:${SHA}:${SHA}`,
  purpose: 'discovery.run' as const,
  subjectType: 'discovery_run',
  subjectId: `request:${SHA}`,
  requestSha256: SHA,
});

/** Per-call latencies measured on xin, slowest tails included (milliseconds). */
const LATENCY_MS = {
  /** One deepseek-v4-pro fit judgment: mean 26 s (run #22) to 55 s (run #23), slowest 134 s. */
  fit: [21_000, 26_000, 31_000, 37_000, 45_000, 54_000, 62_000, 75_000, 98_000, 134_000],
  /** One website profile: two page fetches and a trade-role classification. */
  profile: [18_000, 25_000, 33_000, 41_000, 52_000, 66_000, 80_000, 112_000],
  /** One GLEIF read: mean 0.66 s, slowest 1.67 s. */
  gleif: [500, 700, 900, 1_200, 1_700],
  /** One signal enricher call: sitemap, careers and footprint reads. */
  signal: [4_000, 9_000, 15_000, 24_000, 32_000],
} as const;

const VERDICTS = ['match', 'weak', 'mismatch', 'mismatch', 'mismatch'] as const;

const PROFILE = Object.freeze({
  homepageUrl: 'https://pumpen.example/',
  impressumUrl: 'https://pumpen.example/impressum',
  tradeRole: 'distributor',
  tradeRoleSource: 'rules',
  tradeRoleConfidence: 0.7,
  ownManufacturing: null,
  carriedBrands: [],
  carriesChineseBrand: false,
  carriesForeignBrand: false,
  legalName: null,
  register: null,
  vatId: null,
  evidence: [],
});

/** A seeded generator (mulberry32), so every rehearsal draws the same latencies. */
function sampler(seed: number) {
  let state = seed >>> 0;
  return <T>(values: readonly T[]): T => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const unit = ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    return values[Math.floor(unit * values.length)]!;
  };
}

interface Company {
  id: string;
  name: string;
  domain: string;
  country: string;
  industry: null;
  region: null;
  status: string;
  attributes: Record<string, unknown>;
}

type Where = {
  id: { in: string[]; gt?: string };
  status?: { not: string };
  domain?: { not: null };
  leads?: { some: { icpId: string; fitVerdict: string } };
  NOT?: { leads: { some: { icpId: string } } };
};

/** An in-memory workspace with the rows the per-company stages read and write. */
function workspace(count: number) {
  const companies: Company[] = Array.from({ length: count }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    name: `Pumpen ${i + 1} GmbH`,
    domain: `pumpen-${i + 1}.example`,
    country: 'DE',
    industry: null,
    region: null,
    status: 'NEW',
    attributes: {},
  }));
  const byId = new Map(companies.map((company) => [company.id, company]));
  const leads: Array<{ companyId: string; icpId: string; fitVerdict: string }> = [];
  const verdictOf = (companyId: string, icpId: string) =>
    leads.find((lead) => lead.companyId === companyId && lead.icpId === icpId)?.fitVerdict;
  const tx = {
    $queryRaw: async () => [{ pg_advisory_xact_lock: null }],
    rawSourceRecord: {
      findMany: async () =>
        companies.map((company) => ({
          id: `raw-${company.id}`,
          providerKey: 'registry',
          payload: { externalId: company.id, name: company.name, domain: company.domain, country: company.country },
        })),
    },
    identityLink: { findMany: async () => companies.map((company) => ({ canonicalId: company.id })) },
    canonicalCompany: {
      // Companies were created in id order, so createdAt order and id order agree.
      findMany: async ({ where, take }: { where: Where; take?: number }) => {
        const rows = companies
          .filter((company) => where.id.in.includes(company.id))
          .filter((company) => where.id.gt === undefined || company.id > where.id.gt)
          .filter((company) => where.status === undefined || company.status !== where.status.not)
          .filter((company) => where.domain === undefined || company.domain !== null)
          .filter((company) =>
            where.leads === undefined ||
            verdictOf(company.id, where.leads.some.icpId) === where.leads.some.fitVerdict,
          )
          .filter((company) =>
            where.NOT === undefined || verdictOf(company.id, where.NOT.leads.some.icpId) === undefined,
          )
          .sort((left, right) => (left.id < right.id ? -1 : 1));
        return take === undefined ? rows : rows.slice(0, take);
      },
      findUnique: async ({ where }: { where: { id: string } }) => byId.get(where.id) ?? null,
      updateMany: async ({ where, data }: { where: { id: string }; data: { attributes?: Record<string, unknown> } }) => {
        const company = byId.get(where.id);
        if (company && data.attributes) company.attributes = data.attributes;
        return { count: company ? 1 : 0 };
      },
    },
    lead: {
      upsert: async ({ create }: { create: { canonicalCompanyId: string; icpId: string; fitVerdict: string } }) => {
        leads.push({ companyId: create.canonicalCompanyId, icpId: create.icpId, fitVerdict: create.fitVerdict });
        return {};
      },
    },
    suppressionRecord: { findMany: async () => [] },
    icpDefinition: {
      findUnique: async () => ({ companyAttributes: { industry: 'Pumpen' }, targetMarkets: ['德国'] }),
    },
    dataProvider: {
      findUnique: async ({ where }: { where: { key: string } }) => ({
        status: where.key === 'company_contact' ? 'DISABLED' : 'ENABLED',
      }),
    },
    fieldEvidence: { create: async () => ({}), findMany: async () => [] },
  };
  return { companies, leads, tx };
}


interface Faults {
  /** Fit calls (1-based) whose stream is cut after the gateway settled them. */
  fitCuts?: number[];
  /**
   * Fit calls (1-based) whose stream breaks in a way the activity does not absorb. The activity
   * fails; its retry then meets that company's call again, which cannot be replayed.
   */
  fitBreaks?: number[];
  /** Plan queries (0-based) whose first attempt breaks and whose retries meet the unreplayable call. */
  queryBreaks?: number[];
  /** Plan queries (0-based) whose every attempt fails on a plain error, so they end without a receipt. */
  queryFails?: number[];
  /** Website profiles (1-based) whose operation cannot be replayed. */
  profileUnreplayable?: number[];
  /** Website profiles (1-based) the model upstream cannot answer (an outage during the stage). */
  profileUpstreamDown?: number[];
  /** Signal enricher calls (1-based) whose operation cannot be replayed; 'all' for an outage. */
  signalUnreplayable?: number[] | 'all';
}

const QUERY_COUNT = 4;

/** The company a fit call judges, read from the prompt it was given. */
function companyOf(request: unknown): string {
  const prompt = (request as { prompt?: string }).prompt ?? '';
  return /"name": "([^"]+)"/u.exec(prompt)?.[1] ?? 'unknown';
}

function queryReceipt(queryOrdinal: number) {
  return {
    rawCount: 25,
    quarantinedCount: 0,
    rejectedCount: 0,
    duplicateCount: 0,
    queryReceipt: {
      schemaVersion: 'discovery-query-receipt/v1',
      queryKey: String(queryOrdinal).repeat(64).slice(0, 64),
      queryOrdinal,
      sourceClass: 'public_intelligence',
      providers: ['public_web'],
      accepted: 25,
      quarantined: 0,
      rejected: 0,
      governanceDenied: 0,
      duplicate: 0,
      usageQuantity: 25,
      costCents: 0,
    },
    provider: 'public_web',
    budgetTruncated: false,
  };
}

/** A query whose provider was lost to an unreplayable operation: routed, nothing to show, flagged. */
function lostQueryReceipt(queryOrdinal: number) {
  const answered = queryReceipt(queryOrdinal);
  return {
    ...answered,
    rawCount: 0,
    unreplayable: true,
    queryReceipt: { ...answered.queryReceipt, accepted: 0, usageQuantity: 0 },
  };
}

const MATERIALIZATION_HOLD = 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD';

/**
 * Wires the workflow's activities: plan loading, canonicalization, patent enqueue and
 * finalization answer at once; queries answer with receipts (or break, as configured); the
 * per-company stages run the real activity code. Every activity is retried as its proxy says.
 */
function rehearse(options: { companies: number; slowdown?: number; faults?: Faults; seed?: number }) {
  const slowdown = options.slowdown ?? 1;
  const faults = options.faults ?? {};
  const pick = sampler(options.seed ?? 20261013);
  const advance = (latencies: readonly number[]) => {
    rehearsal.clock.now += pick(latencies) * slowdown;
  };
  const { tx, leads } = workspace(options.companies);

  let fitCalls = 0;
  // The sum of every fit call's latency: what the fit stage would take one company at a time.
  let fitLatencyTotal = 0;
  // Fit calls in flight settle by simulated end time, earliest first, so a call that started later
  // but runs shorter settles first, as on the real gateway. One settles per macrotask, after the
  // microtasks of the one before have started whatever the activity starts next.
  const fitInFlight: Array<{ end: number; settle: () => void }> = [];
  let fitPeak = 0;
  let fitTickScheduled = false;
  const settleNextFit = () => {
    if (fitTickScheduled) return;
    fitTickScheduled = true;
    setImmediate(() => {
      fitTickScheduled = false;
      fitInFlight.sort((a, b) => a.end - b.end);
      const next = fitInFlight.shift();
      if (!next) return;
      rehearsal.clock.now = Math.max(rehearsal.clock.now, next.end);
      next.settle();
      if (fitInFlight.length > 0) settleNextFit();
    });
  };
  // Companies whose fit call broke: the gateway has their operation, without a durable result.
  const unreplayableCompanies = new Set<string>();
  rehearsal.fitModel.mockImplementation(async (_gateway: unknown, request: unknown) => {
    const company = companyOf(request);
    if (unreplayableCompanies.has(company)) throw new BudgetOperationReplayError(`fit-${company}`, "remnant");
    // Numbered when the call starts: siblings in flight start their own calls while this one waits.
    fitCalls += 1;
    const call = fitCalls;
    // Judgments in flight together overlap: each ends at its own start plus its latency.
    const latency = pick(LATENCY_MS.fit) * slowdown;
    fitLatencyTotal += latency;
    await new Promise<void>((resolve) => {
      fitInFlight.push({ end: rehearsal.clock.now + latency, settle: resolve });
      fitPeak = Math.max(fitPeak, fitInFlight.length);
      settleNextFit();
    });
    if (faults.fitCuts?.includes(call)) {
      throw new ProviderTransportError('CHAT_COMPLETIONS_STREAM_TRUNCATED', { inputTokens: 520 });
    }
    if (faults.fitBreaks?.includes(call)) {
      unreplayableCompanies.add(company);
      throw new ProviderTransportError('CHAT_COMPLETIONS_STREAM_UPSTREAM_ERROR', { inputTokens: 520 });
    }
    const verdict = pick(VERDICTS);
    return {
      provider: 'rehearsal',
      data: {
        verdict,
        material_gate: verdict,
        role_gate: verdict,
        process_gate: verdict,
        business_model_gate: verdict,
        reasons: ['rehearsal'],
      },
    };
  });
  let profiles = 0;
  const websiteProfile = {
    profile: vi.fn(async () => {
      profiles += 1;
      advance(LATENCY_MS.profile);
      if (faults.profileUnreplayable?.includes(profiles)) {
        throw new BudgetOperationReplayError(`profile-${profiles}`, "remnant");
      }
      if (faults.profileUpstreamDown?.includes(profiles)) {
        throw new ProviderHttpError({ status: 521, provider: 'gateway', model: 'deepseek-v4-pro' });
      }
      return PROFILE;
    }),
  };
  const gleif = {
    key: 'gleif',
    enrichCompany: vi.fn(async () => {
      // A search, a name-only retry and both parent reads.
      for (let read = 0; read < 4; read += 1) advance(LATENCY_MS.gleif);
      return { matched: false };
    }),
  };
  let signalCalls = 0;
  const signal = (key: string) => ({
    key,
    enrichCompany: vi.fn(async () => {
      signalCalls += 1;
      advance(LATENCY_MS.signal);
      if (
        faults.signalUnreplayable === 'all' ||
        faults.signalUnreplayable?.includes(signalCalls)
      ) {
        throw new BudgetOperationReplayError(`signal-${signalCalls}`, "remnant");
      }
      return { matched: false };
    }),
  });
  const activities = createDiscoveryActivities({
    prisma: {
      withWorkspace: async <T>(_workspaceId: string, callback: (client: typeof tx) => Promise<T>) => callback(tx),
      sourcePolicy: { findMany: async () => [] },
    },
    providers: {
      routeEnrichment: async () => [gleif],
      routeSignalEnrichment: async () => [signal('digital_footprint'), signal('structured_harvest')],
    },
    gateway: {},
    budgetStore: {
      attestAuthorized: async (input: { authorityId: string }) => ({
        accountId: '40000000-0000-4000-8000-000000000004',
        authorityId: input.authorityId,
        authorizedCapMicrousd: 1_000_000n,
        generation: 1,
      }),
      status: async () => ({ exhausted: false }),
    },
    websiteProfile,
    now: () => rehearsal.clock.now,
  } as never);

  // The query stage answers at once. A configured query breaks on its first attempt; its retries
  // meet the call that attempt left behind and, as the activity does, end the query with a zero
  // receipt — in a row or not.
  const receipts = new Set<number>();
  const queryAttempts = new Map<number, number>();
  const executeQuery = async (args: { queryOrdinal: number; previousQueryUnreplayable?: boolean }) => {
    const attempt = (queryAttempts.get(args.queryOrdinal) ?? 0) + 1;
    queryAttempts.set(args.queryOrdinal, attempt);
    advance(LATENCY_MS.fit);
    if (faults.queryFails?.includes(args.queryOrdinal)) throw new Error('rehearsal query failure');
    if (faults.queryBreaks?.includes(args.queryOrdinal)) {
      if (attempt === 1) {
        throw new ProviderTransportError('CHAT_COMPLETIONS_STREAM_UPSTREAM_ERROR', { inputTokens: 520 });
      }
      receipts.add(args.queryOrdinal);
      return lostQueryReceipt(args.queryOrdinal);
    }
    receipts.add(args.queryOrdinal);
    return queryReceipt(args.queryOrdinal);
  };

  const timeouts = discoveryActivityTimeouts();
  const maximumAttempts = discoveryActivityMaximumAttempts();
  const calls: Array<{ activity: string; attempt: number; elapsedMs: number }> = [];
  const timed = (activity: string, run: (args: never) => Promise<unknown>) =>
    acts[activity]!.mockImplementation(async (args: never) => {
      const attempts = maximumAttempts.get(activity)![0]!;
      let lastError: unknown;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const startedAt = rehearsal.clock.now;
        try {
          return await run(args);
        } catch (error) {
          lastError = error;
          if (error instanceof ApplicationFailure && error.nonRetryable) break;
        } finally {
          calls.push({ activity, attempt, elapsedMs: rehearsal.clock.now - startedAt });
        }
      }
      // What Temporal hands the workflow once the activity's attempts are used up.
      throw new ActivityFailure(
        'Activity task failed',
        activity,
        '1',
        'MAXIMUM_ATTEMPTS_REACHED',
        'rehearsal-worker',
        new ApplicationFailure(
          lastError instanceof Error ? lastError.message : String(lastError),
          lastError instanceof Error ? lastError.name : 'Error',
          false,
        ),
      );
    });
  for (const activity of [
    'profileWebsitesForRun',
    'qualifyFitForRun',
    'enrichRun',
    'enrichSignalsRun',
    'registerWatchesForRun',
  ] as const) {
    timed(activity, activities[activity] as (args: never) => Promise<unknown>);
  }
  timed('executeQuery', executeQuery as (args: never) => Promise<unknown>);

  acts.resetRunBudget.mockResolvedValue(undefined);
  acts.loadPlanQueries.mockResolvedValue({
    queries: Array.from({ length: QUERY_COUNT }, (_, i) => ({
      source_class: 'public_intelligence',
      filters: {},
      keywords: [`Pumpen Großhandel ${i + 1}`],
      priority: i + 1,
    })),
  });
  // The materialization admission (`admit_discovery_company_materialization_v1`) holds the run
  // unless every plan query ended with its receipt.
  acts.canonicalizeRun.mockImplementation(async () => {
    for (let ordinal = 0; ordinal < QUERY_COUNT; ordinal += 1) {
      if (!receipts.has(ordinal)) throw ApplicationFailure.nonRetryable(MATERIALIZATION_HOLD, MATERIALIZATION_HOLD);
    }
    return { companies: options.companies, suppressed: 0 };
  });
  acts.enqueuePatentLookupsForRun.mockResolvedValue({ candidates: 0, enqueued: 0 });
  acts.finalizeRun.mockResolvedValue(undefined);

  const input = {
    workspaceId: WS,
    runId: 'rehearsal-run',
    planId: 'rehearsal-plan',
    icpId: ICP_ID,
    executionContractVersion: 2 as const,
    executionBudget: DISCOVERY_BUDGET,
  };
  const overruns = () =>
    calls.filter(({ activity, elapsedMs }) => elapsedMs > timeoutMilliseconds(timeouts.get(activity)![0]!));
  const callsOf = (activity: string) => calls.filter((call) => call.activity === activity);
  const finalized = () => acts.finalizeRun.mock.calls[0]![0] as { status: string; stats: Record<string, unknown> };
  /** Companies with a fit verdict stored for the ICP, whichever attempt judged them. */
  const judgedCompanies = () => new Set(leads.filter((lead) => lead.icpId === ICP_ID).map((lead) => lead.companyId)).size;
  /** Wall-clock time the fit activities took, all attempts included. */
  const fitWallClock = () => callsOf('qualifyFitForRun').reduce((sum, call) => sum + call.elapsedMs, 0);
  return {
    run: () => discoveryWorkflow(input),
    overruns,
    callsOf,
    finalized,
    judgedCompanies,
    fitWallClock,
    fitLatencyTotal: () => fitLatencyTotal,
    fitPeak: () => fitPeak,
    /** Fit calls that reached the model, the ones that broke included; a replay sends nothing. */
    fitCallsSent: () => fitCalls,
  };
}

beforeEach(() => {
  resetActivities();
  rehearsal.clock.now = 0;
  rehearsal.fitModel.mockReset();
});

describe('discovery run rehearsal at measured latencies', () => {
  it('keeps every activity of a 100-company run inside its timeout and absorbs isolated failures', async () => {
    const rehearsalRun = rehearse({
      companies: 100,
      faults: { fitCuts: [37], profileUnreplayable: [12], signalUnreplayable: [3] },
    });

    await rehearsalRun.run();

    expect(rehearsalRun.overruns()).toEqual([]);
    // The company count no longer decides whether a pass fits: it takes several activities.
    expect(rehearsalRun.callsOf('qualifyFitForRun').length).toBeGreaterThan(1);
    expect(rehearsalRun.callsOf('profileWebsitesForRun').length).toBeGreaterThan(1);
    const { status, stats } = rehearsalRun.finalized();
    expect(status).toBe('PARTIAL');
    expect(stats).toMatchObject({
      fitUnjudged: 1,
      unreplayableSkips: { websiteProfile: 1, signals: 1, watches: 0 },
      websiteProfile: expect.objectContaining({ profiled: 49 }),
    });
    const verdicts = stats.fit as Record<string, number>;
    expect(Object.values(verdicts).reduce((sum, count) => sum + count, 0)).toBe(99);
  });

  it('judges 100 companies in under half the time one at a time would take', async () => {
    const rehearsalRun = rehearse({ companies: 100 });

    await rehearsalRun.run();

    expect(rehearsalRun.overruns()).toEqual([]);
    expect(rehearsalRun.judgedCompanies()).toBe(100);
    expect(rehearsalRun.fitPeak()).toBe(FIT_CONCURRENCY);
    // Replaying xin's measured fit latencies gives 0.37-0.38; each pass's tail keeps it above 1/3.
    expect(rehearsalRun.fitWallClock()).toBeLessThan(rehearsalRun.fitLatencyTotal() * 0.45);
  });

  it('still fits every activity inside its timeout on a day when every call takes twice as long', async () => {
    const rehearsalRun = rehearse({ companies: 100, slowdown: 2, seed: 7 });

    await rehearsalRun.run();

    expect(rehearsalRun.overruns()).toEqual([]);
    expect(rehearsalRun.finalized().status).toBe('DONE');
  });

  it('recovers through the retry when a fit stream breaks in a way the activity does not absorb', async () => {
    const rehearsalRun = rehearse({ companies: 100, faults: { fitBreaks: [23] } });

    await rehearsalRun.run();

    expect(rehearsalRun.overruns()).toEqual([]);
    // The broken call failed one attempt; the retry left that company unjudged and went on.
    expect(rehearsalRun.callsOf('qualifyFitForRun').some(({ attempt }) => attempt > 1)).toBe(true);
    const { status, stats } = rehearsalRun.finalized();
    expect(status).toBe('PARTIAL');
    expect(stats).toMatchObject({ fitUnjudged: 1, unreplayableSkips: { fit: 1 } });
    // Every company but the broken one has a stored verdict. The run stats count only each
    // activity's last attempt, so verdicts stored by the attempt that broke are not in stats.fit.
    expect(rehearsalRun.judgedCompanies()).toBe(99);
  });

  // Review of #675 (LOW, kept as designed): a retry absorbs the calls an earlier attempt lost, so a
  // lasting outage fails fit only while the activity still has new companies to call. On a short
  // list every company ends up lost to replay and the run finishes PARTIAL with none judged.
  it.each([
    [3, 'PARTIAL'],
    [6, 'PARTIAL'],
    [9, 'FAILED'],
  ] as const)('ends a lasting fit outage over %i companies %s, calling each company once', async (companies, status) => {
    const rehearsalRun = rehearse({ companies, faults: { fitBreaks: Array.from({ length: 50 }, (_, call) => call + 1) } });

    if (status === 'FAILED') await expect(rehearsalRun.run()).rejects.toBeInstanceOf(ActivityFailure);
    else await rehearsalRun.run();

    expect(rehearsalRun.judgedCompanies()).toBe(0);
    // A lost call is never sent again (D13): each attempt loses at most FIT_CONCURRENCY new calls.
    expect(rehearsalRun.fitCallsSent()).toBe(companies);
    expect(rehearsalRun.fitCallsSent()).toBeLessThanOrEqual(3 * FIT_CONCURRENCY);
    expect(rehearsalRun.finalized()).toMatchObject(
      status === 'PARTIAL'
        ? { status, stats: { fitUnjudged: companies, unreplayableSkips: { fit: companies } } }
        : { status, stats: { failure: { stage: 'fit', errorType: 'ProviderTransportError', control: false } } },
    );
  });

  it('counts a query whose retries meet an unreplayable call as failed and runs the rest', async () => {
    const rehearsalRun = rehearse({ companies: 100, faults: { queryBreaks: [1] } });

    await rehearsalRun.run();

    expect(rehearsalRun.overruns()).toEqual([]);
    const { status, stats } = rehearsalRun.finalized();
    expect(status).toBe('PARTIAL');
    expect(stats).toMatchObject({ failures: 1, queries: QUERY_COUNT, unreplayableSkips: { queries: 1 } });
  });

  it('counts two queries in a row lost to unreplayable calls and runs the rest', async () => {
    const rehearsalRun = rehearse({ companies: 100, faults: { queryBreaks: [1, 2] } });

    await rehearsalRun.run();

    expect(rehearsalRun.overruns()).toEqual([]);
    expect(rehearsalRun.finalized()).toMatchObject({
      status: 'PARTIAL',
      stats: { failures: 2, unreplayableSkips: { queries: 2 } },
    });
  });

  it('finishes PARTIAL when signal enrichment loses every company to unreplayable operations', async () => {
    const rehearsalRun = rehearse({ companies: 100, faults: { signalUnreplayable: 'all' } });

    await rehearsalRun.run();

    expect(rehearsalRun.overruns()).toEqual([]);
    // Every company the stage reaches (its per-run cap is below the run's 100) is counted.
    expect(rehearsalRun.finalized()).toMatchObject({
      status: 'PARTIAL',
      stats: { unreplayableSkips: { signals: 12 } },
    });
  });

  it('stops the run at the query stage when a query fails on a plain error on every attempt, before the later queries spend', async () => {
    const rehearsalRun = rehearse({ companies: 100, faults: { queryFails: [1] } });

    await expect(rehearsalRun.run()).rejects.toBeInstanceOf(ActivityFailure);

    // Query 1 used its three attempts; queries 2 and 3 never ran, and nothing was materialized:
    // the failed query left no receipt, so the admission would only have held the run later.
    expect(rehearsalRun.callsOf('executeQuery').map(({ attempt }) => attempt)).toEqual([1, 1, 2, 3]);
    expect(acts.canonicalizeRun).not.toHaveBeenCalled();
    expect(rehearsalRun.finalized()).toMatchObject({
      status: 'FAILED',
      stats: { queries: QUERY_COUNT, failures: 0, failure: { stage: 'query', errorType: 'Error', control: false } },
    });
  });

  it('does not report DONE when an upstream outage cuts the website-profile stage short and fit judges without it', async () => {
    // The outage covers the profile stage's two attempts (profiles 12 and 13) and is over by fit.
    const rehearsalRun = rehearse({ companies: 100, faults: { profileUpstreamDown: [12, 13] } });

    await rehearsalRun.run();

    expect(rehearsalRun.callsOf('profileWebsitesForRun').filter(({ attempt }) => attempt > 1)).toHaveLength(1);
    const { status, stats } = rehearsalRun.finalized();
    expect(status).toBe('PARTIAL');
    // The pass that failed recorded no result, so its profiles are not in the counters either.
    expect(stats).toMatchObject({ websiteProfile: expect.objectContaining({ stageFailed: true }) });
    expect(rehearsalRun.judgedCompanies()).toBe(100);
  });
});
