import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { DeletionService } from './deletion.service';

const WS = '11111111-1111-4111-8111-111111111111';
const CREATED = new Date('2026-08-08T00:00:00.000Z');

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'request-1',
    status: 'RECEIVED',
    subjectType: 'company',
    subjectId: 'company-1',
    reason: 'erasure',
    requestRef: null,
    createdAt: CREATED,
    completedAt: null,
    receipt: null,
    ...over,
  };
}

function harness(over: Record<string, unknown> = {}) {
  const tx = {
    canonicalContact: { count: vi.fn(async () => 0) },
    canonicalCompany: { count: vi.fn(async () => 1) },
    deletionRequest: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => row()),
      create: vi.fn(async () => row()),
    },
    outboxEvent: { create: vi.fn(async () => ({})) },
    ...over,
  };
  const prisma = {
    withWorkspace: vi.fn(async (_workspaceId: string, work: (value: typeof tx) => unknown) =>
      work(tx),
    ),
  };
  return { tx, prisma, service: new DeletionService(prisma as never) };
}

describe('DeletionService', () => {
  it('creates a company deletion request and an atomic outbox command with defaults', async () => {
    const { service, tx } = harness();
    const result = await service.createRequest(WS, 'actor-1', {
      subjectType: 'company',
      subjectId: 'company-1',
    });

    expect(result).toMatchObject({ id: 'request-1', reason: 'erasure', receipt: null });
    expect(tx.deletionRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requestedBy: 'actor-1', requestRef: null }),
      }),
    );
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'DeletionRequested',
        aggregateId: 'request-1',
        payload: { subjectType: 'company', subjectId: 'company-1' },
      }),
    });
  });

  it('checks contact existence and rejects an absent subject before creating state', async () => {
    const present = harness();
    present.tx.canonicalContact.count.mockResolvedValue(1);
    await present.service.createRequest(WS, 'actor', {
      subjectType: 'contact',
      subjectId: 'contact-1',
      reason: 'objection',
      requestRef: 'case-1',
    });
    expect(present.tx.canonicalContact.count).toHaveBeenCalled();
    expect(present.tx.deletionRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'objection', requestRef: 'case-1' }),
      }),
    );

    const absent = harness();
    absent.tx.canonicalCompany.count.mockResolvedValue(0);
    await expect(
      absent.service.createRequest(WS, 'actor', {
        subjectType: 'company',
        subjectId: 'missing',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(absent.tx.deletionRequest.create).not.toHaveBeenCalled();
  });

  it('reuses an active request and never emits a duplicate command', async () => {
    const { service, tx } = harness();
    tx.deletionRequest.findFirst.mockResolvedValue(row({ id: 'existing' }));
    const result = await service.createRequest(WS, 'actor', {
      subjectType: 'company',
      subjectId: 'company-1',
    });
    expect(result.id).toBe('existing');
    expect(tx.deletionRequest.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('recovers a concurrent P2002 from the committed active request', async () => {
    const { service, tx } = harness();
    tx.deletionRequest.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row({ id: 'winner' }));
    tx.deletionRequest.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(
      service.createRequest(WS, 'actor', {
        subjectType: 'company',
        subjectId: 'company-1',
      }),
    ).resolves.toMatchObject({ id: 'winner' });
  });

  it('rethrows non-unique failures and an unresolved unique race', async () => {
    const ordinary = harness();
    ordinary.tx.deletionRequest.create.mockRejectedValue(new Error('db unavailable'));
    await expect(
      ordinary.service.createRequest(WS, 'actor', {
        subjectType: 'company',
        subjectId: 'company-1',
      }),
    ).rejects.toThrow('db unavailable');

    const unique = harness();
    unique.tx.deletionRequest.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(
      unique.service.createRequest(WS, 'actor', {
        subjectType: 'company',
        subjectId: 'company-1',
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('returns completed receipts and rejects a missing request', async () => {
    const { service, tx } = harness();
    tx.deletionRequest.findUnique.mockResolvedValue(
      row({
        status: 'COMPLETED',
        completedAt: new Date('2026-08-08T01:00:00.000Z'),
        receipt: {
          contactsErased: 1,
          contactPointsErased: 2,
          fieldEvidenceErased: 3,
          signalsRevoked: 4,
          companiesSuppressed: 5,
          leadsRescoreRequested: 6,
          patentCacheErased: 7,
          ruleVersion: 'v1',
          createdAt: CREATED,
        },
      }),
    );
    await expect(service.getRequest(WS, 'request-1')).resolves.toMatchObject({
      completedAt: '2026-08-08T01:00:00.000Z',
      receipt: { patentCacheErased: 7, createdAt: CREATED.toISOString() },
    });

    tx.deletionRequest.findUnique.mockResolvedValue(null);
    await expect(service.getRequest(WS, 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});

