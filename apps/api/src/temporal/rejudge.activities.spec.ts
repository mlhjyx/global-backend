import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionControlError } from '../execution-budget/execution-control-error';
import { ViesTransientError } from '../adapters/vies';
import {
  needsWebsiteProfileV2Refresh,
  viesAttemptToken,
} from '../discovery/judgment/rejudge-candidates';
import { WEBSITE_PROFILE_PARSER_VERSION } from '../discovery/providers/website-profile.provider';
import { createRejudgeActivities } from './rejudge.activities';

const { recordedAckBatches } = vi.hoisted(() => ({
  recordedAckBatches: [] as Array<readonly { producerId: string; domainAckKey: string }[]>,
}));

vi.mock('../durable-results/domain-ack-consumer-bindings', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../durable-results/domain-ack-consumer-bindings')
  >();
  return {
    ...actual,
    applyDomainAckConsumerTransactions: vi.fn(
      async (input: {
        transaction: unknown;
        acknowledgements: readonly {
          producerId: string;
          receipt?: { resultStrategy: string; resultSchema: string };
          domainAckKey: string;
          domainRevision: string;
        }[];
        apply: (tx: unknown) => Promise<unknown>;
      }) => {
        for (const ack of input.acknowledgements) {
          const binding = actual.getDomainAckProductConsumerBinding(ack.producerId);
          if (
            ack.receipt &&
            (ack.receipt.resultStrategy !== binding.resultStrategy ||
              ack.receipt.resultSchema !== binding.resultSchema)
          ) {
            throw new ExecutionControlError('DOMAIN_ACK_RECEIPT_BINDING_MISMATCH');
          }
        }
        if (input.acknowledgements.length > 0) {
          recordedAckBatches.push(
            input.acknowledgements.map((ack) => ({
              producerId: ack.producerId,
              domainAckKey: ack.domainAckKey,
            })),
          );
        }
        const value = await input.apply(input.transaction);
        return {
          status: input.acknowledgements.length > 0 ? 'APPLIED' : 'UNRECEIPTED',
          acknowledgements: input.acknowledgements.map((ack) => ({
            producerId: ack.producerId,
            status: 'APPLIED',
          })),
          value,
        };
      },
    ),
  };
});

vi.mock('../discovery/judgment/gate-chain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../discovery/judgment/gate-chain')>();
  return {
    ...actual,
    evaluateL0Gates: vi.fn(async () => ({
      verdict: 'PASS',
      evaluation: { verdict: 'PASS', failedGate: null, results: [] },
      sanctions: { hit: false, freshness: 'fresh', staleMarker: null, decision: null },
      domainUnknown: false,
      domainDecision: null,
      enrichmentGates: [],
      staleAlertEmitted: false,
    })),
  };
});

vi.mock('../discovery/fit-judge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../discovery/fit-judge')>();
  return {
    ...actual,
    judgeFitCompany: vi.fn(),
  };
});

import { evaluateL0Gates } from '../discovery/judgment/gate-chain';
import { judgeFitCompany } from '../discovery/fit-judge';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const ICP_ID = '20000000-0000-4000-8000-000000000002';
const REJUDGE_ID = '30000000-0000-4000-8000-000000000003';
const COMPANY_ID = '40000000-0000-4000-8000-000000000004';
const AUTHORITY_ID = '50000000-0000-4000-8000-000000000005';
const REQUEST_SHA256 = 'a'.repeat(64);

const BUDGET_BINDING = Object.freeze({
  authorityId: AUTHORITY_ID,
  replay: false,
  scopeKey: WORKSPACE_ID,
  accountKey: `icp.rejudge:icp:${ICP_ID}:${REQUEST_SHA256}`,
  purpose: 'icp.rejudge' as const,
  subjectType: 'icp',
  subjectId: ICP_ID,
  requestSha256: REQUEST_SHA256,
});

function makeJudgmentDraft(verdict: 'FIT' | 'NOT_FIT' | 'UNKNOWN' = 'FIT') {
  const leadVerdict = verdict === 'FIT' ? 'match' : verdict === 'NOT_FIT' ? 'mismatch' : 'weak';
  return {
    verdict: leadVerdict as 'match' | 'weak' | 'mismatch',
    fitReasons: {
      material: 'pass',
      role: 'pass',
      process: 'pass',
      business_model: 'pass',
      reasons: ['verified distributor'],
    },
    judgmentRecord: {
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      judgeLevel: 2 as const,
      verdict,
      verdictProposed: verdict,
      criteria: [
        { id: 'C1_MATERIAL', applicable: true, score: 9, label: 'pass', evidence: [], rationale: 'ok' },
        { id: 'C2_ROLE', applicable: true, score: 9, label: 'pass', evidence: [], rationale: 'ok' },
        { id: 'C3_PROCESS', applicable: false, score: null, label: 'not_applicable', evidence: [], rationale: 'ok' },
        { id: 'C4_BUSINESS_MODEL', applicable: true, score: 9, label: 'pass', evidence: [], rationale: 'ok' },
        { id: 'C5_SIZE', applicable: true, score: 10, label: 'pass', evidence: [], rationale: 'ok' },
      ],
      evidenceCompleteness: true,
      rubricVersion: 'fit-v2',
      promptHash: 'b'.repeat(64),
      schemaVersion: 'judge-output/v2',
      inputDigest: 'c'.repeat(64),
      outputDigest: 'd'.repeat(64),
      model: { requested: 'gemini-4-argon-high', resolved: 'gemini-4-argon-high', reported: null },
      sampling: { temperature: 0, k: 1 },
    },
  };
}

function makeHarness(options?: {
  company?: Record<string, unknown>;
  lead?: { status: string; queue: string; fitVerdict?: string | null; decisions?: Array<{ id: string }> };
  viesEnrich?: ReturnType<typeof vi.fn>;
  websiteProfile?: { profile: ReturnType<typeof vi.fn> };
  attestError?: Error;
}) {
  const companyState: Record<string, unknown> = {
    id: COMPANY_ID,
    name: 'Effe Energy',
    domain: 'effeenergy.it',
    country: 'IT',
    region: null,
    industry: 'Solar',
    status: 'ENRICHED',
    version: 3,
    attributes: {
      website_profile: {
        _parser_version: WEBSITE_PROFILE_PARSER_VERSION,
        vat_id: 'IT04553650989',
        trade_role: 'distributor',
      },
    },
    ...(options?.company ?? {}),
  };

  const leadState = options?.lead
    ? { ...options.lead }
    : { status: 'REVIEW', queue: 'needs_review', fitVerdict: 'weak', decisions: [] };

  const createdJudgments: Array<Record<string, unknown>> = [];
  const createdOutbox: Array<Record<string, unknown>> = [];
  const leadUpsertCalls: Array<Record<string, unknown>> = [];
  const leadUpdateManyCalls: Array<Record<string, unknown>> = [];
  const companyUpdateManyCalls: Array<Record<string, unknown>> = [];

  const tx = {
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => []),
    suppressionRecord: { findMany: vi.fn(async () => []) },
    dataProvider: { findUnique: vi.fn(async () => ({ status: 'ENABLED' })) },
    icpDefinition: {
      findUnique: vi.fn(async () => ({
        id: ICP_ID,
        name: 'IT Solar',
        companyAttributes: { trade_side: 'distributor', process_required: false },
        exclusions: [],
        targetMarkets: ['IT'],
        company: { name: 'Liansheng', summary: 'Solar' },
      })),
    },
    canonicalCompany: {
      findUnique: vi.fn(async () => ({ ...companyState })),
      updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        companyUpdateManyCalls.push(args);
        if (args.where.version !== undefined && args.where.version !== companyState.version) {
          return { count: 0 };
        }
        if (args.data.attributes !== undefined) {
          companyState.attributes = args.data.attributes;
        }
        companyState.version = (companyState.version as number) + 1;
        return { count: 1 };
      }),
    },
    fieldEvidence: { create: vi.fn(async () => ({ id: 'ev-1' })) },
    judgmentRecord: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        createdJudgments.push(...data);
        return { count: data.length };
      }),
      findUnique: vi.fn(async () => ({
        id: 'jr-1',
        verdict: createdJudgments.at(-1)?.verdict ?? 'FIT',
      })),
    },
    lead: {
      upsert: vi.fn(async (args: { update: Record<string, unknown>; create: Record<string, unknown> }) => {
        leadUpsertCalls.push(args);
        Object.assign(leadState, {
          fitVerdict: args.update.fitVerdict,
          ...(args.update.status !== undefined ? { status: args.update.status } : {}),
          ...(args.update.queue !== undefined ? { queue: args.update.queue } : {}),
        });
        return leadState;
      }),
      updateMany: vi.fn(async (args: { where: { status?: { notIn?: string[] } }; data: Record<string, unknown> }) => {
        leadUpdateManyCalls.push(args);
        const excluded = args.where?.status?.notIn ?? [];
        if (excluded.includes(leadState.status)) {
          return { count: 0 };
        }
        if (args.data.fitVerdict !== undefined) {
          leadState.fitVerdict = args.data.fitVerdict as string;
        }
        return { count: 1 };
      }),
    },
    outboxEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        createdOutbox.push(data);
        return data;
      }),
    },
  };

  const prisma = {
    withWorkspace: vi.fn(async (_workspaceId: string, fn: (t: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
  };

  const viesEnrich =
    options?.viesEnrich ??
    vi.fn(async () => ({
      matched: false,
      confidence: 0,
      attributes: {},
      costCents: 0,
    }));

  const providers = {
    routeEnrichment: vi.fn(async () => [
      { key: 'vies', enrichCompany: viesEnrich },
    ]),
  };

  const budgetStore = {
    attestAuthorized: vi.fn(async () => {
      if (options?.attestError) throw options.attestError;
    }),
  };

  const activities = createRejudgeActivities({
    prisma: prisma as never,
    providers: providers as never,
    gateway: {} as never,
    budgetStore: budgetStore as never,
    ...(options?.websiteProfile ? { websiteProfile: options.websiteProfile as never } : {}),
  });

  return {
    activities,
    companyState,
    leadState,
    createdJudgments,
    createdOutbox,
    leadUpsertCalls,
    leadUpdateManyCalls,
    companyUpdateManyCalls,
    viesEnrich,
    budgetStore,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  recordedAckBatches.length = 0;
});

describe('createRejudgeActivities', () => {
  it('enforces three-way runId isolation: binding.accountKey to judgeFitCompany, run_id=NULL in judgment_record, and no runId key in QualifyRequested', async () => {
    vi.stubEnv('JUDGE_CONTRACT_MODE', 'enforce');
    vi.mocked(judgeFitCompany).mockResolvedValueOnce(makeJudgmentDraft('FIT') as never);

    const harness = makeHarness();
    const res = await harness.activities.rejudgeCompanyOnce({
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      rejudgeId: REJUDGE_ID,
      companyId: COMPANY_ID,
      executionContractVersion: 2,
      budgetBinding: BUDGET_BINDING,
      refreshWebsiteProfile: false,
      refreshCorroboration: false,
    });

    expect(res).toMatchObject({
      processed: true,
      judged: true,
      verdict: 'match',
      fatalBudgetError: false,
    });

    // 1. judgeFitCompany receives binding.accountKey for ledger + PANEL_SEEN isolation
    expect(judgeFitCompany).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      expect.anything(),
      expect.objectContaining({ id: COMPANY_ID }),
      expect.objectContaining({
        runId: BUDGET_BINDING.accountKey,
        judgeContractMode: 'enforce',
      }),
    );

    // 2. judgment_record persists runId: null (avoids discovery_run FK violation)
    expect(harness.createdJudgments).toHaveLength(1);
    expect(harness.createdJudgments[0]!.runId).toBeNull();

    // 3. enqueueRejudgeQualify emits QualifyRequested with ONLY { rejudgeId } and NO runId key
    await harness.activities.enqueueRejudgeQualify({
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      rejudgeId: REJUDGE_ID,
    });
    expect(harness.createdOutbox).toHaveLength(1);
    expect(harness.createdOutbox[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      eventType: 'QualifyRequested',
      aggregateType: 'ICP',
      aggregateId: ICP_ID,
      payload: { rejudgeId: REJUDGE_ID },
    });
    expect(Object.prototype.hasOwnProperty.call(harness.createdOutbox[0]!.payload, 'runId')).toBe(false);
  });

  it('writes _vies_attempted via suppression-safe CAS merge on non-transient VIES miss, and skips it on transient VIES errors', async () => {
    vi.stubEnv('JUDGE_CONTRACT_MODE', 'enforce');
    vi.mocked(judgeFitCompany).mockResolvedValue(makeJudgmentDraft('UNKNOWN') as never);

    // Non-transient miss -> writes _vies_attempted
    const missHarness = makeHarness({
      viesEnrich: vi.fn(async () => ({
        matched: false,
        confidence: 0,
        attributes: {},
        costCents: 0,
      })),
    });
    await missHarness.activities.rejudgeCompanyOnce({
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      rejudgeId: REJUDGE_ID,
      companyId: COMPANY_ID,
      executionContractVersion: 2,
      budgetBinding: BUDGET_BINDING,
      refreshWebsiteProfile: false,
      refreshCorroboration: true,
    });
    const expectedToken = viesAttemptToken('IT04553650989');
    expect(
      (missHarness.companyState.attributes as { website_profile?: { _vies_attempted?: string } })
        .website_profile?._vies_attempted,
    ).toBe(expectedToken);
    expect(missHarness.companyUpdateManyCalls).toContainEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          id: COMPANY_ID,
          workspaceId: WORKSPACE_ID,
          status: { not: 'SUPPRESSED' },
          version: 3,
        }),
      }),
    );

    // Transient rate-limit error -> MUST NOT write _vies_attempted so next rejudge retries
    const transientHarness = makeHarness({
      viesEnrich: vi.fn(async () => {
        throw new ViesTransientError('VIES_RATE_LIMITED', 'IT');
      }),
    });
    await transientHarness.activities.rejudgeCompanyOnce({
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      rejudgeId: REJUDGE_ID,
      companyId: COMPANY_ID,
      executionContractVersion: 2,
      budgetBinding: BUDGET_BINDING,
      refreshWebsiteProfile: false,
      refreshCorroboration: true,
    });
    expect(
      (transientHarness.companyState.attributes as { website_profile?: { _vies_attempted?: string } })
        .website_profile?._vies_attempted,
    ).toBeUndefined();
  });

  it('protects human-decided QUALIFIED and CONTACTED leads from status/queue downgrade during upsertLeadFit and L0 gate block', async () => {
    vi.stubEnv('JUDGE_CONTRACT_MODE', 'enforce');
    vi.mocked(judgeFitCompany).mockResolvedValueOnce(makeJudgmentDraft('NOT_FIT') as never);

    const qualifiedHarness = makeHarness({
      lead: { status: 'QUALIFIED', queue: 'recommended', fitVerdict: 'match', decisions: [] },
    });
    await qualifiedHarness.activities.rejudgeCompanyOnce({
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      rejudgeId: REJUDGE_ID,
      companyId: COMPANY_ID,
      executionContractVersion: 2,
      budgetBinding: BUDGET_BINDING,
      refreshWebsiteProfile: false,
      refreshCorroboration: false,
    });

    // upsertLeadFit update payload must NOT include status or queue
    expect(qualifiedHarness.leadUpsertCalls).toHaveLength(1);
    const updatePayload = qualifiedHarness.leadUpsertCalls[0]!.update as Record<string, unknown>;
    expect(updatePayload).not.toHaveProperty('status');
    expect(updatePayload).not.toHaveProperty('queue');
    expect(qualifiedHarness.leadState.status).toBe('QUALIFIED');
    expect(qualifiedHarness.leadState.queue).toBe('recommended');

    // L0 gate block must NOT downgrade CONTACTED lead
    vi.mocked(evaluateL0Gates).mockResolvedValueOnce({
      verdict: 'FAIL',
      evaluation: {
        verdict: 'FAIL',
        failedGate: { gateId: 'G_COUNTRY', verdict: 'FAIL', reasonCode: 'COUNTRY_OUT_OF_MARKET', facts: {} },
        results: [],
      },
      sanctions: { hit: false, freshness: 'fresh', staleMarker: null, decision: null },
      domainUnknown: false,
      domainDecision: null,
      enrichmentGates: [],
      staleAlertEmitted: false,
    } as never);
    const contactedHarness = makeHarness({
      lead: { status: 'CONTACTED', queue: 'recommended', fitVerdict: 'match', decisions: [] },
    });
    const l0Res = await contactedHarness.activities.rejudgeCompanyOnce({
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      rejudgeId: REJUDGE_ID,
      companyId: COMPANY_ID,
      executionContractVersion: 2,
      budgetBinding: BUDGET_BINDING,
      refreshWebsiteProfile: false,
      refreshCorroboration: false,
    });
    expect(l0Res).toMatchObject({
      processed: true,
      judged: false,
      leadUpdated: false,
      verdict: 'mismatch',
    });
    expect(contactedHarness.leadState.status).toBe('CONTACTED');
    expect(contactedHarness.leadState.fitVerdict).toBe('match');
    expect(contactedHarness.leadUpdateManyCalls[0]!.where).toMatchObject({
      status: { notIn: ['QUALIFIED', 'CONTACTED', 'CONVERTED'] },
    });

    // L0 gate block on a non-human REVIEW lead updates fitVerdict and signals leadUpdated=true so qualifyWorkflow syncs queue/status
    vi.mocked(evaluateL0Gates).mockResolvedValueOnce({
      verdict: 'FAIL',
      evaluation: {
        verdict: 'FAIL',
        failedGate: { gateId: 'G_SANCTIONS', verdict: 'FAIL', reasonCode: 'SANCTIONS_HIT', facts: {} },
        results: [],
      },
      sanctions: { hit: true, freshness: 'fresh', staleMarker: null, decision: null },
      domainUnknown: false,
      domainDecision: null,
      enrichmentGates: [],
      staleAlertEmitted: false,
    } as never);
    const reviewHarness = makeHarness({
      lead: { status: 'REVIEW', queue: 'needs_review', fitVerdict: 'weak', decisions: [] },
    });
    const reviewL0Res = await reviewHarness.activities.rejudgeCompanyOnce({
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      rejudgeId: REJUDGE_ID,
      companyId: COMPANY_ID,
      executionContractVersion: 2,
      budgetBinding: BUDGET_BINDING,
      refreshWebsiteProfile: false,
      refreshCorroboration: false,
    });
    expect(reviewL0Res).toMatchObject({
      processed: true,
      judged: false,
      leadUpdated: true,
      verdict: 'mismatch',
    });
    expect(reviewHarness.leadState.fitVerdict).toBe('mismatch');
  });

  it('returns fatalBudgetError cleanly when authority attestation or model execution fails on budget control', async () => {
    vi.stubEnv('JUDGE_CONTRACT_MODE', 'enforce');
    const exhaustedHarness = makeHarness({
      attestError: new ExecutionControlError('EXECUTION_BUDGET_AUTHORITY_EXHAUSTED'),
    });
    const res = await exhaustedHarness.activities.rejudgeCompanyOnce({
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      rejudgeId: REJUDGE_ID,
      companyId: COMPANY_ID,
      executionContractVersion: 2,
      budgetBinding: BUDGET_BINDING,
      refreshWebsiteProfile: false,
      refreshCorroboration: false,
    });
    expect(res).toMatchObject({ fatalBudgetError: true, judged: false, processed: false });
    expect(judgeFitCompany).not.toHaveBeenCalled();
  });

  it('refreshes website_profile when v1 & missing vat_id and stamps _parser_version=website-profile/v2', async () => {
    vi.stubEnv('JUDGE_CONTRACT_MODE', 'enforce');
    vi.mocked(judgeFitCompany).mockResolvedValueOnce(makeJudgmentDraft('FIT') as never);

    const profileFn = vi.fn(async () => ({
      homepageUrl: 'https://effeenergy.it/',
      impressumUrl: null,
      tradeRole: 'distributor',
      tradeRoleSource: 'rules',
      tradeRoleConfidence: 0.7,
      ownManufacturing: false,
      carriedBrands: [],
      carriesChineseBrand: false,
      carriesForeignBrand: false,
      legalName: null,
      register: null,
      vatId: 'IT04553650989',
      registeredAddress: null,
      evidence: ['Official solar module distributor in Italy'],
    }));
    const harness = makeHarness({
      company: {
        attributes: {
          website_profile: { trade_role: 'distributor' },
        },
      },
      websiteProfile: { profile: profileFn },
    });

    const res = await harness.activities.rejudgeCompanyOnce({
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      rejudgeId: REJUDGE_ID,
      companyId: COMPANY_ID,
      executionContractVersion: 2,
      budgetBinding: BUDGET_BINDING,
      refreshWebsiteProfile: true,
      refreshCorroboration: false,
    });

    expect(profileFn).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({
      processed: true,
      judged: true,
      refreshedProfile: true,
      verdict: 'match',
    });
    expect(
      (harness.companyState.attributes as { website_profile?: Record<string, unknown> })
        .website_profile,
    ).toMatchObject({
      _parser_version: WEBSITE_PROFILE_PARSER_VERSION,
      vat_id: 'IT04553650989',
    });
  });

  it('stamps _parser_version=website-profile/v2 via suppression-safe CAS merge when provider.profile deterministically returns null (convergence without _ts)', async () => {
    vi.stubEnv('JUDGE_CONTRACT_MODE', 'enforce');
    vi.mocked(judgeFitCompany).mockResolvedValueOnce(makeJudgmentDraft('UNKNOWN') as never);

    const profileFn = vi.fn(async () => null);
    const harness = makeHarness({
      company: {
        attributes: {
          website_profile: { trade_role: 'distributor' },
        },
      },
      websiteProfile: { profile: profileFn },
    });

    const res = await harness.activities.rejudgeCompanyOnce({
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      rejudgeId: REJUDGE_ID,
      companyId: COMPANY_ID,
      executionContractVersion: 2,
      budgetBinding: BUDGET_BINDING,
      refreshWebsiteProfile: true,
      refreshCorroboration: false,
    });

    expect(profileFn).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({
      processed: true,
      judged: true,
      refreshedProfile: false,
      verdict: 'weak',
    });
    const wp = (harness.companyState.attributes as { website_profile?: Record<string, unknown> })
      .website_profile;
    expect(wp).toMatchObject({
      trade_role: 'distributor',
      _parser_version: WEBSITE_PROFILE_PARSER_VERSION,
    });
    expect(wp).not.toHaveProperty('_ts');
    expect(
      needsWebsiteProfileV2Refresh({
        domain: 'effeenergy.it',
        attributes: harness.companyState.attributes,
      }),
    ).toBe(false);
    expect(harness.companyUpdateManyCalls).toContainEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          id: COMPANY_ID,
          workspaceId: WORKSPACE_ID,
          status: { not: 'SUPPRESSED' },
          version: 3,
        }),
      }),
    );
  });

  it('still ACKs already-settled crawl4ai.fetch durable receipts on non-fatal profile error without stamping _parser_version', async () => {
    vi.stubEnv('JUDGE_CONTRACT_MODE', 'enforce');
    vi.mocked(judgeFitCompany).mockResolvedValueOnce(makeJudgmentDraft('UNKNOWN') as never);

    const operationId = '80000000-0000-4000-8000-000000000008';
    const profileFn = vi.fn(async (_input: unknown, opts: { onDurableReceipt?: (producerId: string, receipt: unknown) => void }) => {
      opts.onDurableReceipt?.('crawl4ai.fetch', {
        schemaVersion: 'durable-execution-receipt/v1',
        scopeKey: WORKSPACE_ID,
        authorityId: AUTHORITY_ID,
        accountId: '90000000-0000-4000-8000-000000000009',
        operationId,
        operationKey: 'crawl4ai.fetch:effeenergy.it',
        resultStrategy: 'artifact_reference',
        resultSchema: 'crawl4ai-fetch/v1',
        resultDigest: 'e'.repeat(64),
        artifactId: 'a0000000-0000-4000-8000-00000000000a',
        usage: { currency: 'USD', unit: 'microusd', callCount: 1, chargedMicrousd: '0' },
        costBasis: 'not_incurred',
        status: 'SETTLED',
      });
      throw new Error('transient downstream classify failure');
    });

    const harness = makeHarness({
      company: {
        attributes: {
          website_profile: { trade_role: 'distributor' },
        },
      },
      websiteProfile: { profile: profileFn },
    });

    const res = await harness.activities.rejudgeCompanyOnce({
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      rejudgeId: REJUDGE_ID,
      companyId: COMPANY_ID,
      executionContractVersion: 2,
      budgetBinding: BUDGET_BINDING,
      refreshWebsiteProfile: true,
      refreshCorroboration: false,
    });

    expect(res).toMatchObject({
      processed: true,
      judged: true,
      refreshedProfile: false,
      failedSoft: false,
    });
    expect(recordedAckBatches).toContainEqual([
      {
        producerId: 'crawl4ai.fetch',
        domainAckKey: `${COMPANY_ID}:${operationId}:website-profile`,
      },
    ]);
    // Non-fatal failure MUST NOT stamp _parser_version so next rejudge can retry.
    const wp = (harness.companyState.attributes as { website_profile?: Record<string, unknown> })
      .website_profile;
    expect(wp?._parser_version).toBeUndefined();
    expect(
      needsWebsiteProfileV2Refresh({
        domain: 'effeenergy.it',
        attributes: harness.companyState.attributes,
      }),
    ).toBe(true);
  });
});
