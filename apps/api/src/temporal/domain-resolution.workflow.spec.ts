import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `domainResolutionWorkflow` 编排单测（hermetic proxyActivities mock：无 Temporal 运行时、
 * 无出网、无 DB）。守：输入护栏、确定性次序（按 companyId 排序）、计数与活动入参传递、
 * 灰度门错误原样冒泡。
 */
vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

import { acts, resetActivities } from './testing/temporal-workflow.mock';
import { DOMAIN_RESOLUTION_MAX_COMPANIES, domainResolutionWorkflow } from './domain-resolution.workflow';
import type { DomainResolutionCompanyInput } from './domain-resolution.activities';

const WS = '11111111-1111-4111-8111-111111111111';

const company = (overrides: Partial<DomainResolutionCompanyInput> = {}): DomainResolutionCompanyInput => ({
  companyId: '22222222-2222-4222-8222-222222222222',
  scheme: 'fr_siren',
  regNumber: '529990001',
  name: 'POMPES MARTIN SAS',
  country: 'FR',
  city: 'Mâcon',
  website: 'https://pompes-martin.fr',
  ...overrides,
});

const candidate = (domain: string) => ({
  domain,
  route: 'source_field' as const,
  routeRank: 0,
  evidence: {},
});

const verifiedResult = (domain: string, over: Record<string, unknown> = {}) => ({
  candidateDomain: domain,
  verdict: 'VERIFIED' as const,
  score: 95,
  matchType: 'register_number' as const,
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
  rejectReasons: [] as string[],
  evidenceUrls: [`https://${domain}/mentions-legales`],
  ...over,
});

beforeEach(() => {
  resetActivities();
});

describe('domainResolutionWorkflow', () => {
  it('resolves, verifies and persists each company in companyId order and aggregates the report', async () => {
    const a = company({ companyId: 'cccccccc-0000-4000-8000-000000000003', name: 'A SAS' });
    const b = company({ companyId: 'bbbbbbbb-0000-4000-8000-000000000002', name: 'B SAS', website: null });
    acts.resolveRegistryDomainCandidates.mockImplementation(async (c: DomainResolutionCompanyInput) =>
      c.companyId === a.companyId
        ? { companyId: c.companyId, status: 'CANDIDATES', candidates: [candidate('a.example')] }
        : { companyId: c.companyId, status: 'NOT_FOUND', candidates: [], notFoundReason: 'NO_PROVIDERS' },
    );
    acts.verifyRegistryDomainCandidates.mockResolvedValue({
      companyId: a.companyId,
      results: [verifiedResult('a.example')],
      selectedDomain: 'a.example',
      nameCollision: false,
      pagesAvailable: true,
    });
    acts.persistDomainResolution.mockResolvedValue({
      companyId: a.companyId,
      resolutionIds: { 'a.example': 'res-1' },
      selectedDomain: 'a.example',
      reviewTasksOpened: 1,
    });

    const result = await domainResolutionWorkflow({ workspaceId: WS, companies: [a, b] });

    // 排序后的命令序列：b（companyId 前缀更小）先于 a；b 无候选直接跳过 verify/persist。
    expect(acts.resolveRegistryDomainCandidates.mock.calls.map((call) => call[0].companyId)).toEqual([
      b.companyId,
      a.companyId,
    ]);
    expect(acts.verifyRegistryDomainCandidates).toHaveBeenCalledTimes(1);
    expect(acts.verifyRegistryDomainCandidates).toHaveBeenCalledWith({
      company: a,
      candidates: [candidate('a.example')],
    });
    expect(acts.persistDomainResolution).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, companyId: a.companyId, auditSampleRate: undefined }),
    );
    expect(result).toMatchObject({
      workspaceId: WS,
      companies: 2,
      candidates: 1,
      verified: 1,
      ambiguous: 0,
      rejected: 0,
      notFound: 1,
      selected: [{ companyId: a.companyId, domain: 'a.example' }],
      reviewTasksOpened: 1,
      notFoundCompanies: [b.companyId],
    });
  });

  it('counts each verdict class from the verification results', async () => {
    const c = company();
    acts.resolveRegistryDomainCandidates.mockResolvedValue({
      companyId: c.companyId,
      status: 'CANDIDATES',
      candidates: [candidate('x.example'), candidate('y.example'), candidate('z.example')],
    });
    acts.verifyRegistryDomainCandidates.mockResolvedValue({
      companyId: c.companyId,
      results: [
        verifiedResult('x.example', { verdict: 'AMBIGUOUS', score: 70 }),
        verifiedResult('y.example', { verdict: 'REJECTED', score: 10 }),
        verifiedResult('z.example'),
      ],
      selectedDomain: 'z.example',
      nameCollision: true,
      pagesAvailable: true,
    });
    acts.persistDomainResolution.mockResolvedValue({
      companyId: c.companyId,
      resolutionIds: {},
      selectedDomain: 'z.example',
      reviewTasksOpened: 2,
    });

    const result = await domainResolutionWorkflow({ workspaceId: WS, companies: [c], auditSampleRate: 0.1 });
    expect(result).toMatchObject({ candidates: 3, verified: 1, ambiguous: 1, rejected: 1, reviewTasksOpened: 2 });
    expect(acts.persistDomainResolution).toHaveBeenCalledWith(
      expect.objectContaining({ auditSampleRate: 0.1 }),
    );
  });

  it('fails closed on bad input before calling any activity', async () => {
    await expect(domainResolutionWorkflow({ workspaceId: 'not-a-uuid', companies: [company()] })).rejects.toThrow(/UUID/u);
    await expect(domainResolutionWorkflow({ workspaceId: WS, companies: [] })).rejects.toThrow(/不能为空/u);
    await expect(
      domainResolutionWorkflow({ workspaceId: WS, companies: [company(), company()] }),
    ).rejects.toThrow(/重复 companyId/u);
    await expect(
      domainResolutionWorkflow({ workspaceId: WS, companies: [company()], auditSampleRate: 1.5 }),
    ).rejects.toThrow(/auditSampleRate/u);
    const many = Array.from({ length: DOMAIN_RESOLUTION_MAX_COMPANIES + 1 }, (_, index) =>
      company({ companyId: `33333333-0000-4000-8000-${String(index).padStart(12, '0')}` }),
    );
    await expect(domainResolutionWorkflow({ workspaceId: WS, companies: many })).rejects.toThrow(/上限/u);
    expect(acts.resolveRegistryDomainCandidates).not.toHaveBeenCalled();
  });

  it('propagates the disabled gate instead of swallowing it', async () => {
    const disabled = Object.assign(new Error('DOMAIN_RESOLUTION_WORKFLOW_ENABLED 未开启（默认关）'), {
      name: 'DomainResolutionWorkflowError',
      code: 'DOMAIN_RESOLUTION_DISABLED',
    });
    acts.resolveRegistryDomainCandidates.mockRejectedValue(disabled);
    await expect(
      domainResolutionWorkflow({ workspaceId: WS, companies: [company()] }),
    ).rejects.toThrow(/默认关/u);
  });
});
