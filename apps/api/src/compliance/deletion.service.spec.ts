import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { DeletionService } from './deletion.service';

const createdAt = new Date('2026-01-01T00:00:00Z');
const request = {
  id: '10000000-0000-4000-8000-000000000001', subjectType: 'contact', subjectId: 'contact-1',
  status: 'RECEIVED', reason: 'erasure', requestRef: null,
  createdAt, completedAt: null, receipt: null,
};
function fixture() {
  const tx = {
    canonicalContact: { count: vi.fn().mockResolvedValue(1) },
    canonicalCompany: { count: vi.fn().mockResolvedValue(1) },
    deletionRequest: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(request),
      create: vi.fn().mockResolvedValue(request),
    },
    outboxEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  const withWorkspace = vi.fn(async (_workspace: string, callback: (value: typeof tx) => unknown) => callback(tx));
  return { tx, withWorkspace, service: new DeletionService({ withWorkspace } as never) };
}
const dto = { subjectType: 'contact' as const, subjectId: 'contact-1' };
function conflict(code = 'P2002') {
  return new Prisma.PrismaClientKnownRequestError('synthetic database conflict', { code, clientVersion: 'test' });
}

describe('DeletionService workspace-scoped acceptance and recovery', () => {
  it.each(['contact', 'company'] as const)('rejects absent %s without accepting or emitting a command', async (subjectType) => {
    const { tx, service, withWorkspace } = fixture();
    tx.canonicalContact.count.mockResolvedValue(0);
    tx.canonicalCompany.count.mockResolvedValue(0);
    await expect(service.createRequest('workspace-a', 'actor', { ...dto, subjectType })).rejects.toBeInstanceOf(NotFoundException);
    expect(withWorkspace).toHaveBeenCalledWith('workspace-a', expect.any(Function));
    expect(tx.deletionRequest.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('accepts a new request and emits only references in the same workspace transaction', async () => {
    const { tx, service, withWorkspace } = fixture();
    expect(await service.createRequest('workspace-a', 'actor', dto)).toMatchObject({ id: request.id, createdAt: createdAt.toISOString(), completedAt: null, receipt: null });
    expect(tx.deletionRequest.create).toHaveBeenCalledWith({ data: { workspaceId: 'workspace-a', requestedBy: 'actor', ...dto, reason: 'erasure', requestRef: null }, include: { receipt: true } });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({ data: { workspaceId: 'workspace-a', eventType: 'DeletionRequested', aggregateType: 'DeletionRequest', aggregateId: request.id, payload: dto } });
    expect(withWorkspace.mock.calls.every(([workspace]) => workspace === 'workspace-a')).toBe(true);
  });

  it('preserves an explicit reason and request reference for company deletion', async () => {
    const { tx, service } = fixture();
    await service.createRequest('workspace-a', 'actor', { subjectType: 'company', subjectId: 'company-1', reason: 'objection', requestRef: 'ticket-1' });
    expect(tx.canonicalContact.count).not.toHaveBeenCalled();
    expect(tx.canonicalCompany.count).toHaveBeenCalledWith({ where: { id: 'company-1' } });
    expect(tx.deletionRequest.create.mock.calls[0][0].data).toMatchObject({ reason: 'objection', requestRef: 'ticket-1' });
  });

  it.each(['RECEIVED', 'FROZEN', 'ERASING'])('reuses an active %s request without a duplicate command', async (status) => {
    const { tx, service } = fixture();
    tx.deletionRequest.findFirst.mockResolvedValue({ ...request, status });
    expect(await service.createRequest('workspace-a', 'actor', dto)).toMatchObject({ id: request.id, status });
    expect(tx.deletionRequest.findFirst.mock.calls[0][0].where).toEqual({ ...dto, status: { in: ['RECEIVED', 'FROZEN', 'ERASING'] } });
    expect(tx.deletionRequest.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('recovers a concurrent unique conflict by re-reading the committed active request', async () => {
    const { tx, service, withWorkspace } = fixture();
    tx.deletionRequest.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(request);
    tx.deletionRequest.create.mockRejectedValue(conflict());
    expect(await service.createRequest('workspace-a', 'actor', dto)).toMatchObject({ id: request.id });
    expect(withWorkspace).toHaveBeenCalledTimes(3);
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it.each([conflict(), conflict('P2024'), new Error('synthetic failure')])('propagates an unrecoverable failure instead of reporting acceptance', async (failure) => {
    const { tx, service } = fixture();
    tx.deletionRequest.create.mockRejectedValue(failure);
    await expect(service.createRequest('workspace-a', 'actor', dto)).rejects.toBe(failure);
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('does not report acceptance when transactional command creation fails', async () => {
    const { tx, service } = fixture();
    const failure = new Error('synthetic outbox failure');
    tx.outboxEvent.create.mockRejectedValue(failure);
    await expect(service.createRequest('workspace-a', 'actor', dto)).rejects.toBe(failure);
  });

  it('returns not found for a request invisible in the selected workspace', async () => {
    const { tx, service, withWorkspace } = fixture();
    tx.deletionRequest.findUnique.mockResolvedValue(null);
    await expect(service.getRequest('workspace-b', request.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(withWorkspace).toHaveBeenCalledWith('workspace-b', expect.any(Function));
  });

  it('returns the completed receipt with stable timestamps and erasure counts', async () => {
    const { tx, service } = fixture();
    const receipt = { contactsErased: 1, contactPointsErased: 2, fieldEvidenceErased: 3, signalsRevoked: 4, companiesSuppressed: 5, leadsRescoreRequested: 6, patentCacheErased: 7, ruleVersion: 'v1', createdAt };
    tx.deletionRequest.findUnique.mockResolvedValue({ ...request, status: 'COMPLETED', completedAt: createdAt, receipt });
    expect(await service.getRequest('workspace-a', request.id)).toMatchObject({ status: 'COMPLETED', completedAt: createdAt.toISOString(), receipt: { ...receipt, createdAt: createdAt.toISOString() } });
  });
});

describe('DeletionService.listRequests', () => {
  it('filters strictly to contact/company inside withWorkspace and paginates with limit + 1', async () => {
    const { tx, service, withWorkspace } = fixture();
    const row1 = { ...request, id: '10000000-0000-4000-8000-000000000011' };
    const row2 = { ...request, id: '10000000-0000-4000-8000-000000000012', subjectType: 'company' };
    const row3 = { ...request, id: '10000000-0000-4000-8000-000000000013' };
    tx.deletionRequest.findMany.mockResolvedValueOnce([row1, row2, row3]);

    const page1 = await service.listRequests('workspace-a', { limit: 2 });
    expect(withWorkspace).toHaveBeenCalledWith('workspace-a', expect.any(Function));
    expect(tx.deletionRequest.findMany).toHaveBeenCalledWith({
      where: { subjectType: { in: ['contact', 'company'] } },
      take: 3,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { receipt: true },
    });
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBe(row2.id);
    expect(page1.data).toHaveLength(2);

    tx.deletionRequest.findMany.mockResolvedValueOnce([row3]);
    const page2 = await service.listRequests('workspace-a', { limit: 2, cursor: row2.id, status: 'COMPLETED' });
    expect(tx.deletionRequest.findMany).toHaveBeenLastCalledWith({
      where: { subjectType: { in: ['contact', 'company'] }, status: 'COMPLETED' },
      take: 3,
      cursor: { id: row2.id },
      skip: 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { receipt: true },
    });
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
    expect(page2.data).toHaveLength(1);
  });

  it('clamps limit to [1, 100] and defaults invalid/NaN limit to 20', async () => {
    const { tx, service } = fixture();
    await service.listRequests('workspace-a', { limit: 500 });
    expect(tx.deletionRequest.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 101 }));

    await service.listRequests('workspace-a', { limit: -5 });
    expect(tx.deletionRequest.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 2 }));
  });

  it('rejects non-UUID cursor with 400 VALIDATION_ERROR without calling Prisma', async () => {
    const { service, withWorkspace } = fixture();
    await expect(service.listRequests('workspace-a', { limit: 20, cursor: 'not-a-uuid' })).rejects.toMatchObject({
      status: 400,
      response: { error: { code: 'VALIDATION_ERROR' } },
    });
    expect(withWorkspace).not.toHaveBeenCalled();
  });

  it('rejects invalid status with 400 VALIDATION_ERROR without calling Prisma', async () => {
    const { service, withWorkspace } = fixture();
    await expect(service.listRequests('workspace-a', { limit: 20, status: 'BOGUS' })).rejects.toMatchObject({
      status: 400,
      response: { error: { code: 'VALIDATION_ERROR' } },
    });
    expect(withWorkspace).not.toHaveBeenCalled();
  });
});
