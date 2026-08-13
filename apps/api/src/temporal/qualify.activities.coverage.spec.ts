import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import type { SanctionsScreeningService } from '../sanctions/sanctions-screening.service';

const { scoreLeadMock } = vi.hoisted(() => ({ scoreLeadMock: vi.fn() }));

vi.mock('../lead/scoring', () => ({ scoreLead: scoreLeadMock }));

import { createQualifyActivities } from './qualify.activities';

const INPUT = { workspaceId: 'ws-1', icpId: 'icp-1' };

const MATCH = {
  externalId: 'entry-1',
  sourceKey: 'ofac_sdn',
  matchedName: 'Acme',
  aliasQuality: 'primary' as const,
  score: 0.96,
  nameScore: 0.96,
  entityCountry: 'DE',
  countryMatch: 'same' as const,
  listVersion: '2026-08-01',
};

function company(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    dedupeKey: `domain:${id}.example`,
    name: id,
    domain: `${id}.example`,
    country: 'DE',
    industry: 'manufacturing',
    employeeCount: 100,
    revenueUsd: 1_000_000,
    attributes: { intent: { events: [] } },
    status: 'ENRICHED',
    contacts: [
      {
        title: 'Procurement Director',
        seniority: 'director',
        contactPoints: [{ type: 'email', status: 'VALID' }],
      },
    ],
    ...overrides,
  };
}

function scoreResult(queue: string) {
  return {
    queue,
    totalScore: 0.8,
    scores: {
      fit: 0.85,
      role: 1,
      intent: 0,
      demandProof: 0,
      dataQuality: 1,
      reachability: 1,
      engagement: 0,
    },
    detail: {
      fitVerdict: 'match',
      ruleEvaluations: [],
      matchedSignals: [],
      intentSignals: [],
      missingFields: [],
      notes: [],
    },
  };
}

beforeEach(() => {
  scoreLeadMock.mockReset();
});

describe('qualify activities — ICP gates', () => {
  it('fails closed when the ICP does not exist', async () => {
    const tx = { icpDefinition: { findUnique: vi.fn().mockResolvedValue(null) } };
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (value: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;

    await expect(createQualifyActivities({ prisma }).scoreCandidates(INPUT)).rejects.toThrow('icp icp-1 not found');
    expect(scoreLeadMock).not.toHaveBeenCalled();
  });

  it('fails closed when the ICP is not ACTIVE', async () => {
    const tx = {
      icpDefinition: {
        findUnique: vi.fn().mockResolvedValue({ status: 'DRAFT', rules: [], roles: [], triggerSignals: [] }),
      },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (value: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;

    await expect(createQualifyActivities({ prisma }).scoreCandidates(INPUT)).rejects.toThrow(
      'icp is DRAFT; qualify requires ACTIVE',
    );
    expect(scoreLeadMock).not.toHaveBeenCalled();
  });
});

describe('qualify activities — batching, reachability, sanctions, and data rights', () => {
  it('threads the id cursor, preserves reachability inputs, honors review state, and emits queue totals', async () => {
    const acme = company('acme');
    const blocked = company('blocked');
    const suppressed = company('suppressed', { status: 'SUPPRESSED', contacts: [] });
    const findCompanies = vi
      .fn()
      .mockResolvedValueOnce([acme, blocked])
      .mockResolvedValueOnce([suppressed]);
    const leadFind = vi.fn(async ({ where }: { where: { workspaceId_icpId_canonicalCompanyId: { canonicalCompanyId: string } } }) => {
      const id = where.workspaceId_icpId_canonicalCompanyId.canonicalCompanyId;
      if (id === 'acme') return { id: 'lead-acme', status: 'QUALIFIED', fitVerdict: 'match' };
      if (id === 'blocked') return { id: 'lead-blocked', status: 'REVIEW', fitVerdict: 'weak' };
      return null;
    });
    const leadUpsert = vi.fn().mockResolvedValue({});
    const screeningUpsert = vi.fn().mockResolvedValue({});
    const screeningFind = vi.fn(async ({ where }: { where: { canonicalCompanyId: string } }) =>
      where.canonicalCompanyId === 'acme'
        ? { reviewState: 'cleared_false_positive', matches: [{ sourceKey: 'ofac_sdn', externalId: 'entry-1' }] }
        : null,
    );
    const outboxCreate = vi.fn().mockResolvedValue({});
    const tx = {
      icpDefinition: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'ACTIVE',
          rules: [{ id: 'rule-1', kind: 'MUST_HAVE', field: 'country', operator: 'eq', value: 'DE', weight: 1 }],
          roles: [{ role: 'economic_buyer', title: 'Procurement Director' }],
          triggerSignals: ['sourcing'],
        }),
      },
      canonicalCompany: { findMany: findCompanies },
      lead: { findUnique: leadFind, upsert: leadUpsert },
      sanctionsScreeningResult: { findFirst: screeningFind, upsert: screeningUpsert },
      outboxEvent: { create: outboxCreate },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (value: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;
    const rebuildIndex = vi.fn().mockRejectedValue(new Error('refresh unavailable'));
    const screen = vi.fn((name: string) =>
      name === 'acme' || name === 'blocked'
        ? { status: 'potential_match', matches: [MATCH], listVersions: { ofac_sdn: '2026-08-01' } }
        : { status: 'clear', matches: [], listVersions: {} },
    );
    const sanctionsScreening = { rebuildIndex, screen } as unknown as SanctionsScreeningService;
    scoreLeadMock.mockImplementation((inputCompany: { name: string }, _icp: unknown, opts: { sanctionsHold: boolean }) => {
      if (opts.sanctionsHold) return scoreResult('sanctions_hold');
      if (inputCompany.name === 'suppressed') return scoreResult('suppressed');
      return scoreResult('recommended');
    });

    const result = await createQualifyActivities({ prisma, sanctionsScreening }).scoreCandidates({
      ...INPUT,
      batchSize: 2,
    });

    expect(rebuildIndex).toHaveBeenCalledTimes(1);
    expect(findCompanies.mock.calls).toEqual([
      [
        expect.objectContaining({
          take: 2,
          orderBy: { id: 'asc' },
        }),
      ],
      [
        expect.objectContaining({
          take: 2,
          where: { id: { gt: 'blocked' } },
          orderBy: { id: 'asc' },
        }),
      ],
    ]);
    expect(scoreLeadMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        name: 'acme',
        status: 'ENRICHED',
        contacts: [
          {
            title: 'Procurement Director',
            seniority: 'director',
            contactPoints: [{ type: 'email', status: 'VALID' }],
          },
        ],
      }),
      expect.objectContaining({ committeeRoles: [{ role: 'economic_buyer', title: 'Procurement Director' }] }),
      { authoritativeFit: 'match', sanctionsHold: false },
    );
    expect(scoreLeadMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: 'blocked' }),
      expect.any(Object),
      { authoritativeFit: 'weak', sanctionsHold: true },
    );
    expect(scoreLeadMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ name: 'suppressed', status: 'SUPPRESSED', contacts: [] }),
      expect.any(Object),
      { authoritativeFit: null, sanctionsHold: false },
    );

    const acmeUpdate = leadUpsert.mock.calls[0]?.[0]?.update;
    expect(acmeUpdate).not.toHaveProperty('status');
    expect(acmeUpdate).not.toHaveProperty('queue');
    expect(acmeUpdate.scoreDetail.fitVerdict).toBe('match');
    expect(leadUpsert.mock.calls[1]?.[0]).toMatchObject({
      update: { status: 'REVIEW', queue: 'sanctions_hold' },
      create: { status: 'REVIEW', queue: 'sanctions_hold' },
    });
    expect(leadUpsert.mock.calls[2]?.[0]).toMatchObject({
      update: { status: 'SUPPRESSED', queue: 'suppressed' },
      create: { status: 'SUPPRESSED', queue: 'suppressed' },
    });
    expect(screeningUpsert).toHaveBeenCalledTimes(2);
    expect(screeningUpsert.mock.calls[0]?.[0]?.update.reviewState).toBe('cleared_false_positive');
    expect(screeningUpsert.mock.calls[1]?.[0]?.create.reviewState).toBe('open');
    expect(result).toEqual({
      scored: 3,
      queues: {
        recommended: 1,
        needs_review: 0,
        rejected: 0,
        suppressed: 1,
        sanctions_hold: 1,
      },
    });
    expect(outboxCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'ws-1',
        eventType: 'LeadsScored',
        aggregateId: 'icp-1',
        payload: result,
      }),
    });
  });

  it('emits a zero-count completion when there are no candidates', async () => {
    const outboxCreate = vi.fn().mockResolvedValue({});
    const tx = {
      icpDefinition: {
        findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE', rules: [], roles: [], triggerSignals: null }),
      },
      canonicalCompany: { findMany: vi.fn().mockResolvedValue([]) },
      outboxEvent: { create: outboxCreate },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (value: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;

    const result = await createQualifyActivities({ prisma }).scoreCandidates(INPUT);

    expect(result).toEqual({
      scored: 0,
      queues: { recommended: 0, needs_review: 0, rejected: 0, suppressed: 0, sanctions_hold: 0 },
    });
    expect(outboxCreate).toHaveBeenCalledTimes(1);
    expect(scoreLeadMock).not.toHaveBeenCalled();
  });
});
