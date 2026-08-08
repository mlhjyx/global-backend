import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { LeadService } from './lead.service';

const ctx = { workspaceId: 'ws', userId: 'user', roles: [] };

function lead(over: Record<string, unknown> = {}) {
  return {
    id: 'lead-1', workspaceId: 'ws', icpId: 'icp-1', canonicalCompanyId: 'company-1',
    status: 'REVIEW', queue: 'needs_review', fitVerdict: 'match', fitReasons: {}, totalScore: 0.7,
    scores: { fit: 0.8, role: 0.6, intent: 0.5, dataQuality: 0.9, reachability: 0.7, engagement: 0 },
    scoreDetail: {}, version: 2, ...over,
  };
}

function company(over: Record<string, unknown> = {}) {
  return {
    id: 'company-1', name: 'Pump GmbH', domain: 'pump.example', country: 'DE',
    industry: 'pumps', employeeCount: 100, status: 'ENRICHED', attributes: {}, contacts: [], ...over,
  };
}

function harness(over: Record<string, unknown> = {}) {
  const tx = {
    icpDefinition: { findUnique: vi.fn(async () => ({ id: 'icp-1', status: 'ACTIVE', version: 3 })) },
    outboxEvent: { create: vi.fn(async () => ({ eventId: 'event-1' })) },
    lead: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => lead()),
      updateMany: vi.fn(async () => ({ count: 1 })),
      groupBy: vi.fn(async () => []),
    },
    leadDecision: { create: vi.fn(async () => ({})) },
    canonicalCompany: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => company()),
    },
    sanctionsScreeningResult: {
      findFirst: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
    },
    fieldEvidence: { groupBy: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => [{ id: 'company-1' }]),
    ...over,
  };
  const prisma = { withWorkspace: vi.fn(async (_ws: string, work: (x: typeof tx) => unknown) => work(tx)) };
  const dataRights = {
    storageContextForLead: vi.fn(() => ({ operation: 'STORE', dataClass: 'green' })),
    evaluate: vi.fn(() => ({ allowed: true, effect: 'ALLOW', ruleId: 'rule-1' })),
    logDecision: vi.fn(async () => undefined),
    logDecisionForWorkspace: vi.fn(async () => undefined),
  };
  const sanctions = {
    screen: vi.fn(() => ({ status: 'not_screened', matches: [], listVersions: {} })),
  };
  return {
    tx, prisma, dataRights, sanctions,
    service: new LeadService(prisma as never, dataRights as never, sanctions as never),
  };
}

describe('LeadService basic operations', () => {
  it('qualifies only an existing ACTIVE ICP and emits the outbox command', async () => {
    const h = harness();
    await expect(h.service.qualify(ctx as never, 'icp-1')).resolves.toEqual({ accepted: true, eventId: 'event-1' });
    expect(h.tx.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ eventType: 'QualifyRequested' }) }),
    );
    h.tx.icpDefinition.findUnique.mockResolvedValue(null);
    await expect(h.service.qualify(ctx as never, 'missing')).rejects.toBeInstanceOf(NotFoundException);
    h.tx.icpDefinition.findUnique.mockResolvedValue({ id: 'icp-1', status: 'DRAFT', version: 1 });
    await expect(h.service.qualify(ctx as never, 'icp-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('lists filtered pages, attaches known companies and returns a cursor only when more exist', async () => {
    const h = harness();
    h.tx.lead.findMany.mockResolvedValue([
      lead({ id: 'lead-1', canonicalCompanyId: 'company-1' }),
      lead({ id: 'lead-2', canonicalCompanyId: 'missing' }),
    ]);
    h.tx.canonicalCompany.findMany.mockResolvedValue([company()]);
    const page = await h.service.list(ctx as never, {
      icpId: 'icp-1', queue: 'recommended', status: 'SCORED', limit: 1, cursor: 'before',
    });
    expect(page).toMatchObject({ hasMore: true, nextCursor: 'lead-1' });
    expect(page.data[0]?.company).toMatchObject({ id: 'company-1' });
    expect(h.tx.lead.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { icpId: 'icp-1', queue: 'recommended', status: 'SCORED' },
        cursor: { id: 'before' }, skip: 1,
      }),
    );

    h.tx.lead.findMany.mockResolvedValue([lead({ canonicalCompanyId: 'missing' })]);
    h.tx.canonicalCompany.findMany.mockResolvedValue([]);
    await expect(h.service.list(ctx as never, { limit: 2 })).resolves.toMatchObject({
      hasMore: false, nextCursor: null, data: [expect.objectContaining({ company: null })],
    });
  });

  it('gets a lead with company details and rejects missing ids', async () => {
    const h = harness();
    await expect(h.service.get(ctx as never, 'lead-1')).resolves.toMatchObject({
      id: 'lead-1', company: { id: 'company-1' },
    });
    h.tx.lead.findUnique.mockResolvedValue(null);
    await expect(h.service.get(ctx as never, 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns a complete queue summary including unknown future queues', async () => {
    const h = harness();
    h.tx.lead.groupBy.mockResolvedValue([
      { queue: 'recommended', _count: { _all: 2 } },
      { queue: 'future_queue', _count: { _all: 1 } },
    ]);
    await expect(h.service.queueSummary(ctx as never, 'icp-1')).resolves.toMatchObject({
      recommended: 2, needs_review: 0, sanctions_hold: 0, future_queue: 1,
    });
  });
});

describe('LeadService decision guards and handoff', () => {
  it('rejects missing, suppressed and legacy post-decision states', async () => {
    for (const [value, exception] of [
      [null, NotFoundException],
      [lead({ status: 'SUPPRESSED' }), ConflictException],
      [lead({ status: 'CONTACTED' }), ConflictException],
      [lead({ status: 'CONVERTED' }), ConflictException],
    ] as const) {
      const h = harness();
      h.tx.lead.findUnique.mockResolvedValue(value as never);
      await expect(h.service.decide(ctx as never, 'lead-1', 'reject')).rejects.toBeInstanceOf(exception);
    }
  });

  it('short-circuits an idempotent target state and rejects a lost CAS', async () => {
    for (const [action, status] of [['accept', 'QUALIFIED'], ['reject', 'REJECTED']] as const) {
      const h = harness();
      h.tx.lead.findUnique.mockResolvedValue(lead({ status }));
      await expect(h.service.decide(ctx as never, 'lead-1', action)).resolves.toMatchObject({ status });
      expect(h.tx.lead.updateMany).not.toHaveBeenCalled();
    }
    const lost = harness();
    lost.tx.lead.updateMany.mockResolvedValue({ count: 0 });
    await expect(lost.service.decide(ctx as never, 'lead-1', 'reject')).rejects.toBeInstanceOf(ConflictException);
  });

  it('persists a reject decision with queue and optional reason without handoff', async () => {
    const h = harness();
    h.tx.lead.findUnique
      .mockResolvedValueOnce(lead())
      .mockResolvedValueOnce(lead({ status: 'REJECTED', queue: 'rejected' }));
    await expect(h.service.decide(ctx as never, 'lead-1', 'reject', 'not ICP')).resolves.toMatchObject({
      status: 'REJECTED', queue: 'rejected',
    });
    expect(h.tx.leadDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'reject', reason: 'not ICP' }) }),
    );
    expect(h.tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('fails an accept when the locked company disappears', async () => {
    const h = harness();
    h.tx.canonicalCompany.findUnique.mockResolvedValue(null);
    await expect(h.service.decide(ctx as never, 'lead-1', 'accept')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('blocks both persisted and live unresolved sanctions hits', async () => {
    const prior = harness();
    prior.tx.sanctionsScreeningResult.findFirst.mockResolvedValue({
      status: 'potential_match', reviewState: 'open', matches: [], listVersions: {},
    });
    await expect(prior.service.decide(ctx as never, 'lead-1', 'accept')).rejects.toBeInstanceOf(ConflictException);

    const live = harness();
    live.sanctions.screen.mockReturnValue({
      status: 'potential_match', matches: [{ list: 'OFAC', entityId: '1', name: 'Pump GmbH', score: 1 }], listVersions: {},
    });
    await expect(live.service.decide(ctx as never, 'lead-1', 'accept')).rejects.toBeInstanceOf(ConflictException);
  });

  it('audits a denied storage decision after rollback and returns a closed conflict', async () => {
    const h = harness();
    h.dataRights.evaluate.mockReturnValue({ allowed: false, effect: 'DENY', ruleId: 'deny' });
    await expect(h.service.decide(ctx as never, 'lead-1', 'accept')).rejects.toMatchObject({
      response: { error: { code: 'STORAGE_RIGHTS_NOT_GRANTED' } },
    });
    expect(h.dataRights.logDecisionForWorkspace).toHaveBeenCalledTimes(1);
    expect(h.tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('creates a minimized LeadQualified snapshot after allowed rights and clear screening', async () => {
    const h = harness();
    const named = company({
      contacts: [{
        id: 'contact-1', title: 'Procurement', seniority: 'director', department: 'procurement',
        contactPoints: [{ status: 'VALID', type: 'email', value: 'hidden@example.test' }],
      }],
    });
    h.tx.canonicalCompany.findUnique.mockResolvedValue(named);
    h.tx.fieldEvidence.groupBy.mockResolvedValue([
      { dataClass: 'green', _min: { fetchedAt: new Date('2026-08-01T00:00:00Z') } },
      { dataClass: 'red', _min: { fetchedAt: null } },
    ]);
    h.tx.lead.findUnique
      .mockResolvedValueOnce(lead())
      .mockResolvedValueOnce(lead({ status: 'QUALIFIED', queue: 'recommended' }));
    await expect(h.service.decide(ctx as never, 'lead-1', 'accept')).resolves.toMatchObject({ status: 'QUALIFIED' });
    expect(h.dataRights.logDecision).toHaveBeenCalledTimes(1);
    const event = h.tx.outboxEvent.create.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    expect(event.data).toMatchObject({ eventType: 'LeadQualified', privacyClassification: 'RESTRICTED' });
    expect(JSON.stringify(event)).not.toContain('hidden@example.test');
  });
});

describe('LeadService sanctions review', () => {
  it('rejects missing leads/results and makes confirmed hits immutable', async () => {
    const missingLead = harness();
    missingLead.tx.lead.findUnique.mockResolvedValue(null);
    await expect(
      missingLead.service.reviewSanctions(ctx as never, 'missing', 'confirmed_true_hit'),
    ).rejects.toBeInstanceOf(NotFoundException);

    const missingResult = harness();
    await expect(
      missingResult.service.reviewSanctions(ctx as never, 'lead-1', 'confirmed_true_hit'),
    ).rejects.toBeInstanceOf(NotFoundException);

    const immutable = harness();
    immutable.tx.sanctionsScreeningResult.findFirst.mockResolvedValue({ id: 'screen-1', reviewState: 'confirmed_true_hit' });
    await expect(
      immutable.service.reviewSanctions(ctx as never, 'lead-1', 'cleared_false_positive'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('persists either review state and only releases holds for a cleared false positive', async () => {
    for (const decision of ['cleared_false_positive', 'confirmed_true_hit'] as const) {
      const h = harness();
      h.tx.sanctionsScreeningResult.findFirst.mockResolvedValue({ id: 'screen-1', reviewState: 'open' });
      await expect(h.service.reviewSanctions(ctx as never, 'lead-1', decision)).resolves.toEqual({
        leadId: 'lead-1', reviewState: decision,
      });
      expect(h.tx.sanctionsScreeningResult.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ reviewNote: null }) }),
      );
      expect(h.tx.lead.updateMany).toHaveBeenCalledTimes(decision === 'cleared_false_positive' ? 1 : 0);
    }
  });
});
