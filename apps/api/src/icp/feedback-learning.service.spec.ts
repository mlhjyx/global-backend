import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { FeedbackLearningService } from './feedback-learning.service';

const CTX: RequestContext = {
  userId: 'user-1',
  workspaceId: '10000000-0000-4000-8000-000000000001',
  roles: ['admin'],
  scopes: ['acquisition:read', 'acquisition:write'],
};

const ICP_ID = '20000000-0000-4000-8000-000000000001';
const COMPANY_ID = '30000000-0000-4000-8000-000000000001';
const LEAD_ID = '40000000-0000-4000-8000-000000000001';

interface MockIcpRow {
  id: string;
  name: string;
  version: number;
  exclusions: unknown;
  companyAttributes: Record<string, unknown>;
}

function makePrisma(initialIcp: MockIcpRow | null, companyRow?: { id: string; name: string; domain: string | null; industry: string | null }) {
  let stored = initialIcp ? structuredClone(initialIcp) : null;
  const queryRaw = vi.fn(async () => (stored ? [{ id: stored.id }] : []));
  const tx = {
    $queryRaw: queryRaw,
    icpDefinition: {
      findUnique: vi.fn(async () => (stored ? structuredClone(stored) : null)),
      update: vi.fn(async (args: { data: { companyAttributes: Record<string, unknown>; version: { increment: number } } }) => {
        if (!stored) throw new Error('missing icp');
        stored = {
          ...stored,
          companyAttributes: structuredClone(args.data.companyAttributes),
          version: stored.version + args.data.version.increment,
        };
        return structuredClone(stored);
      }),
    },
    canonicalCompany: {
      findUnique: vi.fn(async () => (companyRow ? { ...companyRow } : null)),
    },
    lead: {
      findUnique: vi.fn(async () => (companyRow ? { id: LEAD_ID, canonicalCompanyId: companyRow.id } : null)),
    },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_wsId: string, fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  return { prisma, tx, getStored: () => stored, queryRaw };
}

describe('FeedbackLearningService', () => {
  it('persists peer rejection into peer_exclusions.excluded_domains, excluded_keywords, and fit_counter_examples with PII scrubbed', async () => {
    const { prisma, getStored } = makePrisma(
      {
        id: ICP_ID,
        name: 'EU Solar Distributors',
        version: 2,
        exclusions: ['同行业组件制造厂'],
        companyAttributes: {
          peer_exclusions: {
            excluded_business_models: ['同行业组件制造厂'],
            excluded_keywords: [],
            excluded_domains: ['my-seller.cn'],
            rationale: '排除同行',
          },
        },
      },
      {
        id: COMPANY_ID,
        name: 'Peer Solar Modules GmbH',
        domain: 'www.peer-solar.de',
        industry: 'solar module manufacturing',
      },
    );

    const svc = new FeedbackLearningService(prisma);
    const res = await svc.recordFeedback(CTX, ICP_ID, {
      leadId: LEAD_ID,
      companyId: COMPANY_ID,
      domain: 'https://www.peer-solar.de/products',
      outcome: 'rejected',
      rejectionReason: 'wrong_role_peer',
      excludedKeywords: ['PV module OEM'],
      note: '同行组件厂，联系人 john.doe@peer-solar.de +49 170 1234567',
    });

    expect(res.icpVersion).toBe(3);
    expect(res.appliedRules.addedExcludedDomain).toBe('peer-solar.de');
    expect(res.appliedRules.addedExcludedKeywords).toContain('PV module OEM');
    expect(res.appliedRules.addedCounterExample).toBe(true);
    expect(res.summary.excludedDomains).toEqual(['my-seller.cn', 'peer-solar.de']);
    expect(res.summary.excludedKeywords).toContain('PV module OEM');
    expect(res.summary.counterExamples).toHaveLength(1);
    expect(res.summary.counterExamples[0]).toMatchObject({
      domain: 'peer-solar.de',
      companyName: 'Peer Solar Modules GmbH',
      outcome: 'rejected',
      reason: 'wrong_role_peer',
    });
    // Zero personal PII persisted into ICP attributes
    const serialized = JSON.stringify(getStored()?.companyAttributes);
    expect(serialized).not.toContain('john.doe@peer-solar.de');
    expect(serialized).not.toContain('170 1234567');
  });

  it('caps fit_counter_examples at 5 most recent high-signal entries', async () => {
    const { prisma } = makePrisma({
      id: ICP_ID,
      name: 'Industrial Pumps',
      version: 1,
      exclusions: [],
      companyAttributes: {},
    });
    const svc = new FeedbackLearningService(prisma);

    for (let i = 1; i <= 7; i++) {
      await svc.recordFeedback(CTX, ICP_ID, {
        domain: `peer-${i}.example`,
        companyName: `Peer Co ${i}`,
        outcome: 'rejected',
        rejectionReason: 'wrong_industry',
        note: `wrong industry case ${i}`,
      });
    }

    const summary = await svc.getSummary(CTX, ICP_ID);
    expect(summary.counterExamples).toHaveLength(5);
    expect(summary.counterExamples[0]?.domain).toBe('peer-7.example');
    expect(summary.counterExamples[4]?.domain).toBe('peer-3.example');
    expect(summary.stats.totalRecorded).toBe(7);
    expect(summary.stats.rejectionReasonCounts.wrong_industry).toBe(7);
  });

  it('excludes opt_out domain without classifying bounced/wrong_contact as peer competitor', async () => {
    const { prisma } = makePrisma({
      id: ICP_ID,
      name: 'HVAC Buyers',
      version: 1,
      exclusions: [],
      companyAttributes: {},
    });
    const svc = new FeedbackLearningService(prisma);

    const bounceRes = await svc.recordFeedback(CTX, ICP_ID, {
      domain: 'good-buyer.de',
      companyName: 'Good Buyer GmbH',
      outcome: 'bounced',
    });
    expect(bounceRes.appliedRules.addedExcludedDomain).toBeNull();
    expect(bounceRes.summary.excludedDomains).toEqual([]);

    const optOutRes = await svc.recordFeedback(CTX, ICP_ID, {
      domain: 'optout-co.de',
      companyName: 'OptOut Co',
      outcome: 'opt_out',
    });
    expect(optOutRes.appliedRules.addedExcludedDomain).toBe('optout-co.de');
    expect(optOutRes.summary.excludedDomains).toContain('optout-co.de');
  });

  it('records positive replies and booked meetings in positiveExamples and stats without adding exclusions', async () => {
    const { prisma } = makePrisma({
      id: ICP_ID,
      name: 'Solar EPCs',
      version: 1,
      exclusions: [],
      companyAttributes: {},
    });
    const svc = new FeedbackLearningService(prisma);

    const res = await svc.recordFeedback(CTX, ICP_ID, {
      domain: 'rhein-epc.de',
      companyName: 'Rhein Solar EPC GmbH',
      industry: 'solar epc',
      outcome: 'booked_meeting',
    });

    expect(res.appliedRules.addedExcludedDomain).toBeNull();
    expect(res.summary.positiveExamples).toHaveLength(1);
    expect(res.summary.positiveExamples[0]).toMatchObject({
      domain: 'rhein-epc.de',
      outcome: 'booked_meeting',
    });
    expect(res.summary.stats.outcomeCounts.booked_meeting).toBe(1);
  });

  it('throws 404 NOT_FOUND when ICP does not exist', async () => {
    const { prisma } = makePrisma(null);
    const svc = new FeedbackLearningService(prisma);
    await expect(svc.getSummary(CTX, ICP_ID)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      svc.recordFeedback(CTX, ICP_ID, { domain: 'x.de', outcome: 'rejected', rejectionReason: 'wrong_role_peer' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('normalizes trailing dots and rejects pathological dot strings in linear time (CodeQL ReDoS fix)', async () => {
    const { prisma } = makePrisma({
      id: ICP_ID,
      name: 'Linear Domain Check',
      version: 1,
      exclusions: [],
      companyAttributes: {},
    });
    const svc = new FeedbackLearningService(prisma);
    const normalized = await svc.recordFeedback(CTX, ICP_ID, {
      domain: 'WWW.Solar-Peer.DE...',
      outcome: 'rejected',
      rejectionReason: 'wrong_role_peer',
    });
    expect(normalized.appliedRules.addedExcludedDomain).toBe('solar-peer.de');

    const pathological = await svc.recordFeedback(CTX, ICP_ID, {
      domain: `${'.'.repeat(5000)}a`,
      outcome: 'rejected',
      rejectionReason: 'wrong_role_peer',
    });
    expect(pathological.appliedRules.addedExcludedDomain).toBeNull();
  });
});
