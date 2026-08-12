import { ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertPublicHttpUrl } from '../adapters/url-guard';
import { CompanyService } from './company.service';

vi.mock('../adapters/url-guard', () => ({
  assertPublicHttpUrl: vi.fn(async () => undefined),
}));

const ctx = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  userId: 'operator-1',
  roles: ['acquisition-operator'],
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'company-1',
    workspaceId: ctx.workspaceId,
    name: 'Pump GmbH',
    website: 'https://pump.example',
    status: 'DRAFT',
    version: 1,
    createdAt: new Date('2026-08-08T00:00:00.000Z'),
    updatedAt: new Date('2026-08-08T00:00:00.000Z'),
    ...overrides,
  };
}

function harness(txOverrides: Record<string, unknown> = {}) {
  const tx = {
    idempotencyKey: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
    },
    workspace: { upsert: vi.fn(async () => ({})) },
    companyProfile: {
      create: vi.fn(async () => row()),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => row()),
      update: vi.fn(async () => row({ status: 'ACTIVE', version: 2 })),
    },
    outboxEvent: { create: vi.fn(async () => ({})) },
    claim: { count: vi.fn(async () => 2) },
    offering: {
      count: vi.fn(async () => 1),
      findMany: vi.fn(async () => [{ id: 'offering-1', name: 'Pumps' }]),
    },
    knowledgeConflict: { count: vi.fn(async () => 0) },
    ...txOverrides,
  } as any;
  const prisma = {
    withWorkspace: vi.fn(async (_workspaceId: string, work: (value: typeof tx) => unknown) => work(tx)),
  };
  return { service: new CompanyService(prisma as any), prisma, tx };
}

describe('CompanyService', () => {
  beforeEach(() => {
    vi.mocked(assertPublicHttpUrl).mockClear();
  });

  it('replays an idempotent create without repeating domain writes', async () => {
    const stored = {
      ...row(),
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:01:00.000Z',
    };
    const { service, tx } = harness();
    tx.idempotencyKey.findUnique.mockResolvedValue({ response: stored });

    const result = await service.create(
      ctx,
      { website: 'https://pump.example', name: 'Pump GmbH' },
      'create-1',
    );

    expect(assertPublicHttpUrl).toHaveBeenCalledWith('https://pump.example');
    expect(result).toMatchObject({ replayed: true, company: { id: 'company-1' } });
    expect(result.company.createdAt).toBeInstanceOf(Date);
    expect(result.company.updatedAt).toBeInstanceOf(Date);
    expect(tx.workspace.upsert).not.toHaveBeenCalled();
    expect(tx.companyProfile.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it.each([
    { key: undefined, name: undefined, expectedName: 'pump.example', persistsKey: false },
    { key: 'create-2', name: 'Named Pump', expectedName: 'Named Pump', persistsKey: true },
  ])('creates a draft profile and its outbox event (%s)', async ({ key, name, expectedName, persistsKey }) => {
    const { service, tx } = harness();

    const result = await service.create(
      ctx,
      { website: 'https://pump.example/catalog', ...(name ? { name } : {}) },
      key,
    );

    expect(result.replayed).toBe(false);
    expect(tx.workspace.upsert).toHaveBeenCalledWith({
      where: { id: ctx.workspaceId },
      update: {},
      create: { id: ctx.workspaceId },
    });
    expect(tx.companyProfile.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: ctx.workspaceId,
        name: expectedName,
        website: 'https://pump.example/catalog',
        status: 'DRAFT',
      }),
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'CompanyProfileCreated',
        aggregateId: 'company-1',
      }),
    });
    expect(tx.idempotencyKey.create).toHaveBeenCalledTimes(persistsKey ? 1 : 0);
  });

  it('paginates companies with and without a cursor', async () => {
    const { service, tx } = harness();
    tx.companyProfile.findMany
      .mockResolvedValueOnce([row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })])
      .mockResolvedValueOnce([row({ id: 'z' })]);

    await expect(service.list(ctx, 2, 'before')).resolves.toMatchObject({
      data: [{ id: 'a' }, { id: 'b' }],
      nextCursor: 'b',
      hasMore: true,
    });
    expect(tx.companyProfile.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ take: 3, cursor: { id: 'before' }, skip: 1 }),
    );
    await expect(service.list(ctx, 2)).resolves.toMatchObject({
      data: [{ id: 'z' }],
      nextCursor: null,
      hasMore: false,
    });
    expect(tx.companyProfile.findMany.mock.calls[1]?.[0]).not.toHaveProperty('cursor');
  });

  it('gets a tenant-scoped company and returns a stable 404 when absent', async () => {
    const { service, tx } = harness();
    await expect(service.get(ctx, 'company-1')).resolves.toMatchObject({ id: 'company-1' });
    tx.companyProfile.findUnique.mockResolvedValueOnce(null);
    await expect(service.get(ctx, 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reports completeness and rejects an unknown company', async () => {
    const { service, tx } = harness();
    await expect(service.completeness(ctx, 'company-1')).resolves.toEqual({
      status: 'DRAFT',
      approvedClaims: 2,
      pendingClaims: 2,
      offerings: 1,
      conflictsOpen: 0,
    });
    expect(tx.claim.count).toHaveBeenCalledTimes(2);

    tx.companyProfile.findUnique.mockResolvedValueOnce(null);
    await expect(service.completeness(ctx, 'missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.claim.count).toHaveBeenCalledTimes(2);
  });

  it('confirms only REVIEW companies', async () => {
    const { service, tx } = harness();
    tx.companyProfile.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row({ status: 'ACTIVE' }))
      .mockResolvedValueOnce(row({ status: 'REVIEW' }));

    await expect(service.confirm(ctx, 'missing')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.confirm(ctx, 'company-1')).rejects.toBeInstanceOf(ConflictException);
    await expect(service.confirm(ctx, 'company-1')).resolves.toMatchObject({
      status: 'ACTIVE',
      version: 2,
    });
    expect(tx.companyProfile.update).toHaveBeenCalledWith({
      where: { id: 'company-1' },
      data: { status: 'ACTIVE', version: { increment: 1 } },
    });
  });

  it('lists ordered offerings only for an existing company', async () => {
    const { service, tx } = harness();
    await expect(service.listOfferings(ctx, 'company-1')).resolves.toEqual([
      { id: 'offering-1', name: 'Pumps' },
    ]);
    expect(tx.offering.findMany).toHaveBeenCalledWith({
      where: { companyId: 'company-1' },
      orderBy: [{ confidence: 'desc' }, { name: 'asc' }],
    });

    tx.companyProfile.findUnique.mockResolvedValueOnce(null);
    await expect(service.listOfferings(ctx, 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});

