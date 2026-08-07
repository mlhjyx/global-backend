import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import {
  LeadQualityLabelLearningConsumer,
  LeadQualityLabelRepository,
} from './lead-quality-label.repository';
import type { NormalizedLeadQualityLabelRequest } from './lead-quality-label.domain';

const CTX: RequestContext = {
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  userId: 'user-from-token',
  roles: ['member'],
};
const LEAD_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';

const REQUEST: NormalizedLeadQualityLabelRequest = {
  sourceEventId: 'crm:event:1001',
  leadId: LEAD_ID,
  leadQualifiedEventId: EVENT_ID,
  label: 'QGO_CREATED',
  occurredAt: new Date('2026-08-07T12:00:00.000Z'),
  sourceSystem: 'growth-saas',
  externalObjectRef: null,
  reasonCode: null,
  commercialResult: null,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    workspaceId: CTX.workspaceId,
    sourceEventId: REQUEST.sourceEventId,
    leadId: REQUEST.leadId,
    leadQualifiedEventId: REQUEST.leadQualifiedEventId,
    label: REQUEST.label,
    occurredAt: REQUEST.occurredAt,
    sourceSystem: REQUEST.sourceSystem,
    externalObjectRef: null,
    reasonCode: null,
    commercialResult: null,
    disposition: 'ACCEPTED',
    heldReason: null,
    actorId: CTX.userId,
    createdAt: new Date('2026-08-07T12:01:00.000Z'),
    ...overrides,
  };
}

function harness(options: { existing?: ReturnType<typeof row> | null; accepted?: unknown[]; event?: unknown } = {}) {
  let existingCalls = 0;
  const findFirst = vi.fn(async () => {
    existingCalls += 1;
    return options.existing ?? null;
  });
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => row(data));
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: LEAD_ID }]),
    outboxEvent: {
      findFirst: vi.fn(async () =>
        options.event === undefined ? { eventId: EVENT_ID } : options.event,
      ),
    },
    leadQualityLabel: {
      findFirst,
      findMany: vi.fn(async () => options.accepted ?? []),
      create,
    },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_workspaceId: string, work: (value: typeof tx) => unknown) => work(tx)),
  } as unknown as PrismaService;
  return { repository: new LeadQualityLabelRepository(prisma), prisma, tx, create, existingCalls: () => existingCalls };
}

describe('LeadQualityLabelRepository.append', () => {
  it('serializes on the workspace lead, binds actor/workspace only from RequestContext, and never mutates Lead state', async () => {
    const h = harness();
    const result = await h.repository.append(CTX, REQUEST);

    expect(result.replayed).toBe(false);
    expect(result.record).toMatchObject({ disposition: 'ACCEPTED', heldReason: null });
    expect(h.prisma.withWorkspace).toHaveBeenCalledWith(CTX.workspaceId, expect.any(Function));
    expect(h.tx.$queryRaw).toHaveBeenCalledOnce();
    expect(h.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: CTX.workspaceId,
        actorId: CTX.userId,
        leadId: LEAD_ID,
        label: 'QGO_CREATED',
      }),
    });
    expect(h.tx).not.toHaveProperty('lead.update');
    expect(h.tx).not.toHaveProperty('opportunity');
  });

  it('persists an out-of-order label as HELD instead of discarding or later flipping it', async () => {
    const h = harness();
    const result = await h.repository.append(CTX, { ...REQUEST, label: 'SALES_ACCEPTED' });

    expect(result.record).toMatchObject({
      label: 'SALES_ACCEPTED',
      disposition: 'HELD',
      heldReason: 'MISSING_QGO_CREATED',
    });
    expect(h.create).toHaveBeenCalledOnce();
  });

  it('returns an identical source replay and rejects a conflicting replay with 409', async () => {
    const identical = row();
    const replay = harness({ existing: identical });
    await expect(replay.repository.append(CTX, REQUEST)).resolves.toMatchObject({
      replayed: true,
      record: identical,
    });
    expect(replay.create).not.toHaveBeenCalled();

    const conflict = harness({ existing: row({ label: 'SALES_ACCEPTED' }) });
    await expect(conflict.repository.append(CTX, REQUEST)).rejects.toBeInstanceOf(ConflictException);
    await expect(conflict.repository.append(CTX, REQUEST)).rejects.toMatchObject({
      response: { error: { code: 'SOURCE_EVENT_CONFLICT' } },
    });
  });

  it('fails closed before insert when the LeadQualified event does not match this workspace/lead', async () => {
    const h = harness({ event: null });
    await expect(h.repository.append(CTX, REQUEST)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.create).not.toHaveBeenCalled();
  });
});

describe('LeadQualityLabelLearningConsumer', () => {
  it('queries only ACCEPTED rows, so HELD facts cannot enter learning batches', async () => {
    const accepted = [row()];
    const h = harness({ accepted });
    const consumer = new LeadQualityLabelLearningConsumer(h.prisma);

    await expect(consumer.listForLead(CTX, LEAD_ID)).resolves.toEqual(accepted);
    expect(h.tx.leadQualityLabel.findMany).toHaveBeenCalledWith({
      where: { workspaceId: CTX.workspaceId, leadId: LEAD_ID, disposition: 'ACCEPTED' },
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
  });
});
