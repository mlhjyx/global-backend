import { describe, expect, it } from 'vitest';
import {
  InMemoryDomainResolutionStore,
  InMemoryDomainReviewTaskStore,
} from '../registry/domain/domain-stores.test-fixture';
import type { DomainCandidate } from '../registry/domain/domain-resolver';
import {
  DOMAIN_RESOLUTION_DISABLED,
  createDomainResolutionActivities,
  type DomainResolutionCompanyInput,
  type VerifyDomainCandidatesActivityResult,
} from './domain-resolution.activities';

const WS = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';

const company = (overrides: Partial<DomainResolutionCompanyInput> = {}): DomainResolutionCompanyInput => ({
  companyId: COMPANY,
  scheme: 'fr_siren',
  regNumber: '529990001',
  name: 'POMPES MARTIN SAS',
  country: 'FR',
  city: 'Lyon',
  postalCode: '69003',
  website: 'https://pompes-martin.fr',
  ...overrides,
});

const candidate = (domain: string): DomainCandidate => ({
  domain,
  route: 'source_field',
  routeRank: 0,
  evidence: {},
});

function storesFixture() {
  let id = 0;
  const resolutions = new InMemoryDomainResolutionStore(() => `res-${++id}`);
  const reviewTasks = new InMemoryDomainReviewTaskStore(() => `task-${++id}`);
  const prisma = {
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
  };
  const activities = createDomainResolutionActivities({
    prisma: prisma as never,
    enabled: true,
    storeFactory: () => ({ resolutions, reviewTasks }),
  });
  return { resolutions, reviewTasks, activities };
}

const verification = (
  overrides: Partial<VerifyDomainCandidatesActivityResult> = {},
): VerifyDomainCandidatesActivityResult => ({
  companyId: COMPANY,
  results: [
    {
      candidateDomain: 'pompes-martin.fr',
      verdict: 'VERIFIED',
      score: 95,
      matchType: 'register_number',
      signals: {
        registerNumberExact: true,
        registerMismatch: false,
        multipleRegisters: false,
        vatExactAndViesValid: null,
        postalCodeAndCityMatch: false,
        nameSimilarity: 0.9,
        domainTokenMatchesBrand: true,
        parkedDomain: false,
        noLegalPage: false,
      },
      rejectReasons: [],
      evidenceUrls: ['https://pompes-martin.fr/mentions-legales'],
    },
  ],
  selectedDomain: 'pompes-martin.fr',
  nameCollision: false,
  pagesAvailable: true,
  ...overrides,
});

describe('domain resolution activities gate', () => {
  it('refuses every activity when DOMAIN_RESOLUTION_WORKFLOW_ENABLED is off (default)', async () => {
    const activities = createDomainResolutionActivities({
      prisma: { withWorkspace: async () => undefined } as never,
      enabled: false,
    });
    for (const call of [
      activities.resolveRegistryDomainCandidates(company()),
      activities.verifyRegistryDomainCandidates({ company: company(), candidates: [candidate('x.example')] }),
      activities.persistDomainResolution({
        workspaceId: WS,
        companyId: COMPANY,
        candidates: [candidate('x.example')],
        verification: verification(),
      }),
    ]) {
      await expect(call).rejects.toMatchObject({ code: DOMAIN_RESOLUTION_DISABLED });
    }
  });
});

describe('resolveRegistryDomainCandidates', () => {
  it('offers the website as a source_field candidate', async () => {
    const { activities } = storesFixture();
    const result = await activities.resolveRegistryDomainCandidates(company());
    expect(result.status).toBe('CANDIDATES');
    expect(result.candidates).toEqual([
      { domain: 'pompes-martin.fr', route: 'source_field', routeRank: 0, evidence: {} },
    ]);
  });

  it('drops noise domains and companies without a website', async () => {
    const { activities } = storesFixture();
    const noise = await activities.resolveRegistryDomainCandidates(
      company({ website: 'https://www.linkedin.com/company/pompes' }),
    );
    expect(noise).toMatchObject({ status: 'NOT_FOUND', candidates: [] });
    const none = await activities.resolveRegistryDomainCandidates(company({ website: null }));
    expect(none).toMatchObject({ status: 'NOT_FOUND', candidates: [], notFoundReason: 'NO_PROVIDERS' });
  });
});

describe('verifyRegistryDomainCandidates', () => {
  it('runs with zero pages by default: deterministic NO_LEGAL_PAGE rejection, no external calls', async () => {
    const { activities } = storesFixture();
    const result = await activities.verifyRegistryDomainCandidates({
      company: company(),
      candidates: [candidate('pompes-martin.fr')],
    });
    expect(result.pagesAvailable).toBe(false);
    expect(result.results).toEqual([
      expect.objectContaining({
        candidateDomain: 'pompes-martin.fr',
        verdict: 'REJECTED',
        rejectReasons: ['NO_LEGAL_PAGE'],
      }),
    ]);
    expect(result.selectedDomain).toBeNull();
  });

  it('threads injected page evidence into the verifier', async () => {
    const seen: string[] = [];
    const activities = createDomainResolutionActivities({
      prisma: { withWorkspace: async () => undefined } as never,
      enabled: true,
      ports: {
        fetchLegalPages: async (domain) => {
          seen.push(domain);
          // 与 domain-verifier.spec 的 FR 样本一致：SIREN 精确 + 地址 + 名称 = 95 分 VERIFIED。
          return [{
            kind: 'mentions-legales',
            url: `https://${domain}/mentions-legales`,
            text: `POMPES MARTIN SAS
Mentions légales
SIREN : 529 990 001
Siège social : 12 rue des Puits, 69003 Lyon
Directeur de la publication : M. Martin`,
          }];
        },
      },
    });
    const result = await activities.verifyRegistryDomainCandidates({
      company: company(),
      candidates: [candidate('pompes-martin.fr')],
    });
    expect(seen).toEqual(['pompes-martin.fr']);
    expect(result.pagesAvailable).toBe(true);
    expect(result.results[0]).toMatchObject({ candidateDomain: 'pompes-martin.fr', verdict: 'VERIFIED' });
  });

  it('treats a throwing fetcher as unavailable pages, not as an activity failure', async () => {
    const activities = createDomainResolutionActivities({
      prisma: { withWorkspace: async () => undefined } as never,
      enabled: true,
      ports: { fetchLegalPages: async () => Promise.reject(new Error('network down')) },
    });
    const result = await activities.verifyRegistryDomainCandidates({
      company: company(),
      candidates: [candidate('pompes-martin.fr')],
    });
    expect(result.pagesAvailable).toBe(false);
    expect(result.results[0]?.verdict).toBe('REJECTED');
  });
});

describe('persistDomainResolution', () => {
  it('upserts rows, selects the verified candidate and opens review tasks idempotently', async () => {
    const { resolutions, reviewTasks, activities } = storesFixture();
    const input = {
      workspaceId: WS,
      companyId: COMPANY,
      candidates: [candidate('pompes-martin.fr')],
      verification: verification(),
      auditSampleRate: 1, // 唯一 VERIFIED 行全量进抽样复核
    };
    const first = await activities.persistDomainResolution(input);
    expect(first.selectedDomain).toBe('pompes-martin.fr');
    expect(first.reviewTasksOpened).toBe(1);

    const rows = await resolutions.listForCompany(WS, COMPANY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      candidateDomain: 'pompes-martin.fr',
      route: 'source_field',
      status: 'VERIFIED',
      selected: true,
      confidence: 95,
      extractorVersion: 'domain-workflow/v1',
    });
    expect(rows[0]!.evidenceJson).toMatchObject({ rejectReasons: [] });
    const tasks = await reviewTasks.listOpen(WS);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ reason: 'audit_sample', status: 'OPEN' });

    // 重放：同日同结果再落一次 → 行更新不新增、选中不变、工单不重复。
    const second = await activities.persistDomainResolution(input);
    expect(second.reviewTasksOpened).toBe(0);
    expect(await resolutions.listForCompany(WS, COMPANY)).toHaveLength(1);
    expect(await reviewTasks.listOpen(WS)).toHaveLength(1);
  });

  it('keeps all candidates below the verified threshold as AMBIGUOUS and queues low_confidence review', async () => {
    const { resolutions, reviewTasks, activities } = storesFixture();
    const base = verification().results[0]!;
    const result = await activities.persistDomainResolution({
      workspaceId: WS,
      companyId: COMPANY,
      candidates: [candidate('pompes-martin.fr'), candidate('pompes-martin.com')],
      verification: {
        results: [
          { ...base, candidateDomain: 'pompes-martin.fr', verdict: 'AMBIGUOUS', score: 60 },
          { ...base, candidateDomain: 'pompes-martin.com', verdict: 'AMBIGUOUS', score: 58 },
        ],
        selectedDomain: null,
        nameCollision: false,
      },
    });
    expect(result.selectedDomain).toBeNull();
    expect(result.reviewTasksOpened).toBe(2);
    const rows = await resolutions.listForCompany(WS, COMPANY);
    expect(rows.map((row) => row.status)).toEqual(['AMBIGUOUS', 'AMBIGUOUS']);
    expect(rows.every((row) => !row.selected)).toBe(true);
    const tasks = await reviewTasks.listOpen(WS);
    expect(tasks.map((task) => task.reason)).toEqual(['low_confidence', 'low_confidence']);
  });

  it('clears a previously selected row before re-judging it to a non-VERIFIED verdict (DB CHECK safety)', async () => {
    const { resolutions, activities } = storesFixture();
    await activities.persistDomainResolution({
      workspaceId: WS,
      companyId: COMPANY,
      candidates: [candidate('pompes-martin.fr')],
      verification: verification(),
    });
    expect((await resolutions.listForCompany(WS, COMPANY)).filter((row) => row.selected)).toHaveLength(1);

    const downgraded = await activities.persistDomainResolution({
      workspaceId: WS,
      companyId: COMPANY,
      candidates: [candidate('pompes-martin.fr')],
      verification: {
        results: [{ ...verification().results[0]!, verdict: 'AMBIGUOUS', score: 60 }],
        selectedDomain: null,
        nameCollision: false,
      },
    });
    expect(downgraded.selectedDomain).toBeNull();
    const rows = await resolutions.listForCompany(WS, COMPANY);
    expect(rows.filter((row) => row.selected)).toHaveLength(0);
    expect(rows[0]).toMatchObject({ status: 'AMBIGUOUS' });
  });

  it('leaves a previous selection untouched when its candidate is not re-judged this run', async () => {
    const { resolutions, activities } = storesFixture();
    await activities.persistDomainResolution({
      workspaceId: WS,
      companyId: COMPANY,
      candidates: [candidate('pompes-martin.fr')],
      verification: verification(),
    });
    await activities.persistDomainResolution({
      workspaceId: WS,
      companyId: COMPANY,
      candidates: [candidate('ventile.example')],
      verification: {
        results: [{ ...verification().results[0]!, candidateDomain: 'ventile.example', verdict: 'AMBIGUOUS', score: 60 }],
        selectedDomain: null,
        nameCollision: false,
      },
    });
    const rows = await resolutions.listForCompany(WS, COMPANY);
    expect(rows.filter((row) => row.selected).map((row) => row.candidateDomain)).toEqual(['pompes-martin.fr']);
  });

  it('ignores verification results for domains that are not in the candidate set', async () => {
    const { resolutions, activities } = storesFixture();
    await activities.persistDomainResolution({
      workspaceId: WS,
      companyId: COMPANY,
      candidates: [candidate('pompes-martin.fr')],
      verification: verification({
        results: [{ ...verification().results[0]!, candidateDomain: 'other.example' }],
        selectedDomain: null,
      }),
    });
    expect(await resolutions.listForCompany(WS, COMPANY)).toEqual([]);
  });
});
