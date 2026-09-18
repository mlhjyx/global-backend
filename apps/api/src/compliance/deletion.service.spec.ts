import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { DeletionService } from './deletion.service';

const createdAt = new Date('2026-01-01T00:00:00Z');
const request = {
  id: 'request-1', subjectType: 'contact', subjectId: 'contact-1',
  status: 'RECEIVED', reason: 'erasure', requestRef: null,
  createdAt, completedAt: null, receipt: null,
};
function fixture() {
  const tx = {
    canonicalContact: { count: vi.fn().mockResolvedValue(1) },
    canonicalCompany: { count: vi.fn().mockResolvedValue(1) },
    deletionRequest: {
      findFirst: vi.fn().mockResolvedValue(null),
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
    expect(await service.createRequest('workspace-a', 'actor', dto)).toMatchObject({ id: 'request-1', createdAt: createdAt.toISOString(), completedAt: null, receipt: null });
    expect(tx.deletionRequest.create).toHaveBeenCalledWith({ data: { workspaceId: 'workspace-a', requestedBy: 'actor', ...dto, reason: 'erasure', requestRef: null }, include: { receipt: true } });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({ data: { workspaceId: 'workspace-a', eventType: 'DeletionRequested', aggregateType: 'DeletionRequest', aggregateId: 'request-1', payload: dto } });
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
