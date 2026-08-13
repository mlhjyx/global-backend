import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import type { DeletionWorkflowInput, ErasureCounts, LocatedErasureTargets } from '../compliance/deletion.types';
import { createDeletionActivities } from './deletion.activities';

const CONTACT_INPUT: DeletionWorkflowInput = {
  workspaceId: 'ws-1',
  deletionRequestId: 'request-1',
  subjectType: 'contact',
  subjectId: 'contact-1',
};

const COMPANY_INPUT: DeletionWorkflowInput = {
  ...CONTACT_INPUT,
  deletionRequestId: 'request-2',
  subjectType: 'company',
  subjectId: 'company-1',
};

const EMPTY_LOCATED: LocatedErasureTargets = {
  subjectType: 'contact',
  subjectId: 'contact-1',
  contactIds: [],
  contactPointsCount: 0,
  fieldEvidenceCount: 0,
  companyIdsToSuppress: [],
  signalsToRevoke: 0,
  affectedIcpIds: [],
};

function prismaFor(tx: Record<string, unknown>): PrismaService {
  const client = { $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]), ...tx };
  return {
    withWorkspace: vi.fn(async <T>(_workspaceId: string, fn: (value: unknown) => Promise<T>) => fn(client)),
  } as unknown as PrismaService;
}

describe('deletion activities — locate and freeze', () => {
  it('locates a contact, writes email/person suppression, and returns a PII-free snapshot', async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const requestUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      canonicalContact: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'contact-1',
          companyId: 'company-1',
          fullName: 'Ada Lovelace',
          company: { dedupeKey: 'acme.example' },
          contactPoints: [
            { type: 'email', value: 'Ada@Example.test' },
            { type: 'phone', value: '+1 555 0100' },
          ],
        }),
      },
      fieldEvidence: { count: vi.fn().mockResolvedValue(3) },
      lead: { findMany: vi.fn().mockResolvedValue([{ icpId: 'icp-active' }, { icpId: 'icp-paused' }]) },
      icpDefinition: { findMany: vi.fn().mockResolvedValue([{ id: 'icp-active' }]) },
      suppressionRecord: { upsert },
      canonicalCompany: { updateMany: vi.fn() },
      deletionRequest: { updateMany: requestUpdate },
    };

    const result = await createDeletionActivities({ prisma: prismaFor(tx) }).freezeSubject(CONTACT_INPUT);

    expect(result).toEqual({
      ...EMPTY_LOCATED,
      contactIds: ['contact-1'],
      contactPointsCount: 2,
      fieldEvidenceCount: 3,
      affectedIcpIds: ['icp-active'],
    });
    expect(JSON.stringify(result)).not.toContain('Ada');
    expect(JSON.stringify(result)).not.toContain('@');
    const written = upsert.mock.calls.map((call) => call[0].create) as Array<{
      type: string;
      value: string;
      reason: string;
    }>;
    expect(written).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workspaceId: 'ws-1', type: 'email', value: 'ada@example.test', reason: 'legal' }),
        expect.objectContaining({ workspaceId: 'ws-1', type: 'contact_key', value: expect.stringMatching(/^bi:v1:/) }),
      ]),
    );
    expect(requestUpdate).toHaveBeenCalledWith({
      where: { id: 'request-1', status: 'RECEIVED' },
      data: { status: 'FROZEN' },
    });
  });

  it('locates a company, freezes domain/name/email, and suppresses the company before erasure', async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const companyUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      canonicalCompany: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'company-1',
          name: 'Acme GmbH',
          domain: 'Acme.Example',
          contacts: [
            { id: 'contact-1', contactPoints: [{ type: 'email', value: 'one@acme.example' }] },
            { id: 'contact-2', contactPoints: [{ type: 'phone', value: '+49 12345678' }] },
          ],
        }),
        updateMany: companyUpdate,
      },
      fieldEvidence: { count: vi.fn().mockResolvedValue(4) },
      lead: { findMany: vi.fn().mockResolvedValue([{ icpId: 'icp-1' }]) },
      icpDefinition: { findMany: vi.fn().mockResolvedValue([{ id: 'icp-1' }]) },
      suppressionRecord: { upsert },
      deletionRequest: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };

    const result = await createDeletionActivities({ prisma: prismaFor(tx) }).freezeSubject(COMPANY_INPUT);

    expect(result).toMatchObject({
      subjectType: 'company',
      contactIds: ['contact-1', 'contact-2'],
      contactPointsCount: 2,
      fieldEvidenceCount: 4,
      companyIdsToSuppress: ['company-1'],
      affectedIcpIds: ['icp-1'],
    });
    expect(upsert.mock.calls.map((call) => call[0].create)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'domain', value: 'acme.example' }),
        expect.objectContaining({ type: 'company_name', value: 'acme gmbh' }),
        expect.objectContaining({ type: 'email', value: 'one@acme.example' }),
      ]),
    );
    expect(companyUpdate).toHaveBeenCalledWith({
      where: { id: { in: ['company-1'] } },
      data: { status: 'SUPPRESSED' },
    });
  });

  it('returns an empty snapshot for a missing subject without inventing suppression entries', async () => {
    const upsert = vi.fn();
    const tx = {
      canonicalContact: { findUnique: vi.fn().mockResolvedValue(null) },
      suppressionRecord: { upsert },
      canonicalCompany: { updateMany: vi.fn() },
      deletionRequest: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };

    await expect(createDeletionActivities({ prisma: prismaFor(tx) }).freezeSubject(CONTACT_INPUT)).resolves.toEqual(
      EMPTY_LOCATED,
    );
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('deletion activities — erase', () => {
  it('returns persisted erasure stats on a retry and performs no deletion side effects', async () => {
    const persisted: ErasureCounts = {
      contactsErased: 2,
      contactPointsErased: 3,
      fieldEvidenceErased: 4,
      signalsRevoked: 0,
      companiesSuppressed: 1,
      leadsRescoreRequested: 2,
      patentCacheErased: 1,
    };
    const deleteMany = vi.fn();
    const tx = {
      deletionRequest: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue({ stats: persisted }),
      },
      canonicalContact: { deleteMany },
    };
    const located: LocatedErasureTargets = {
      ...EMPTY_LOCATED,
      subjectType: 'company',
      subjectId: 'company-1',
      companyIdsToSuppress: ['company-1'],
    };

    await expect(
      createDeletionActivities({ prisma: prismaFor(tx) }).eraseSubject({ input: COMPANY_INPUT, located }),
    ).resolves.toEqual(persisted);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('re-reads a company erase set, suppresses late email, deletes PII/cache, and persists real counts', async () => {
    const requestUpdate = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const suppressionCreate = vi.fn().mockResolvedValue({ count: 1 });
    const evidenceDelete = vi.fn().mockResolvedValue({ count: 3 });
    const contactDelete = vi.fn().mockResolvedValue({ count: 2 });
    const tombstoneCreate = vi.fn().mockResolvedValue({ count: 2 });
    const cacheDelete = vi.fn().mockResolvedValue({ count: 1 });
    const outboxCreate = vi.fn().mockResolvedValue({});
    const tx = {
      deletionRequest: { updateMany: requestUpdate },
      $queryRaw: vi.fn().mockResolvedValue([]),
      canonicalContact: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'contact-1',
            fullName: 'Ada Lovelace',
            contactPoints: [
              { type: 'email', value: 'late@acme.example' },
              { type: 'phone', value: '+1 555 0100' },
            ],
          },
          { id: 'contact-2', fullName: 'Grace Hopper', contactPoints: [{ type: 'email', value: 'grace@acme.example' }] },
        ]),
        deleteMany: contactDelete,
      },
      suppressionRecord: { upsert: suppressionCreate },
      fieldEvidence: { deleteMany: evidenceDelete },
      patentInventorTombstone: { createMany: tombstoneCreate },
      patentInventorCache: { deleteMany: cacheDelete },
      canonicalCompany: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      outboxEvent: { create: outboxCreate },
    };
    const located: LocatedErasureTargets = {
      ...EMPTY_LOCATED,
      subjectType: 'company',
      subjectId: 'company-1',
      contactIds: ['snapshot-contact'],
      contactPointsCount: 1,
      fieldEvidenceCount: 1,
      companyIdsToSuppress: ['company-1'],
      affectedIcpIds: ['icp-1', 'icp-2'],
    };

    const result = await createDeletionActivities({ prisma: prismaFor(tx) }).eraseSubject({
      input: COMPANY_INPUT,
      located,
    });

    expect(result).toEqual({
      contactsErased: 2,
      contactPointsErased: 3,
      fieldEvidenceErased: 3,
      signalsRevoked: 0,
      companiesSuppressed: 1,
      leadsRescoreRequested: 2,
      patentCacheErased: 1,
    });
    expect(suppressionCreate.mock.calls.map((call) => call[0].create)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'email', value: 'late@acme.example' }),
        expect.objectContaining({ type: 'email', value: 'grace@acme.example' }),
      ]),
    );
    expect(evidenceDelete).toHaveBeenCalledWith({
      where: { entityType: 'contact', entityId: { in: ['contact-1', 'contact-2'] } },
    });
    expect(contactDelete).toHaveBeenCalledWith({ where: { id: { in: ['contact-1', 'contact-2'] } } });
    expect(tombstoneCreate).toHaveBeenCalledWith({
      data: expect.arrayContaining([expect.objectContaining({ inventorNameKey: expect.stringMatching(/^bi:v1:/) })]),
      skipDuplicates: true,
    });
    expect(outboxCreate).toHaveBeenCalledTimes(2);
    expect(requestUpdate.mock.calls[1]?.[0]).toEqual({
      where: { id: 'request-2', status: 'ERASING' },
      data: { stats: result },
    });
  });

  it('reconciles a contact re-materialized after request creation into the final erase set', async () => {
    const since = new Date('2026-08-01T00:00:00.000Z');
    const contactFindMany = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 'contact-rematerialized', fullName: 'Lovelace, Ada', createdAt: new Date('2026-08-02T00:00:00.000Z') },
        { id: 'contact-old', fullName: 'Ada Lovelace', createdAt: new Date('2026-07-01T00:00:00.000Z') },
      ])
      .mockResolvedValueOnce([
        { id: 'contact-1', fullName: 'Ada Lovelace', contactPoints: [] },
        { id: 'contact-rematerialized', fullName: 'Lovelace, Ada', contactPoints: [] },
      ]);
    const requestUpdate = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const tx = {
      deletionRequest: {
        updateMany: requestUpdate,
        findUnique: vi.fn().mockResolvedValue({ createdAt: since }),
      },
      canonicalContact: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'contact-1',
          fullName: 'Ada Lovelace',
          companyId: 'company-1',
          company: { dedupeKey: 'acme.example' },
        }),
        findMany: contactFindMany,
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
      fieldEvidence: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      suppressionRecord: { createMany: vi.fn() },
      patentInventorTombstone: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
      patentInventorCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      canonicalCompany: { updateMany: vi.fn() },
      outboxEvent: { create: vi.fn() },
    };
    const located: LocatedErasureTargets = { ...EMPTY_LOCATED, contactIds: ['contact-1'] };

    const result = await createDeletionActivities({ prisma: prismaFor(tx) }).eraseSubject({
      input: CONTACT_INPUT,
      located,
    });

    expect(result.contactsErased).toBe(2);
    expect(contactFindMany.mock.calls[1]?.[0]?.where).toEqual({
      id: { in: ['contact-1', 'contact-rematerialized'] },
    });
  });
});

describe('deletion activities — completion and failure', () => {
  const persisted: ErasureCounts = {
    contactsErased: 1,
    contactPointsErased: 2,
    fieldEvidenceErased: 3,
    signalsRevoked: 0,
    companiesSuppressed: 0,
    leadsRescoreRequested: 1,
    patentCacheErased: 1,
  };

  it('refuses to fabricate a receipt when erasure never happened', async () => {
    const tx = {
      deletionRequest: { findUnique: vi.fn().mockResolvedValue({ status: 'FROZEN', stats: null }) },
      deletionReceipt: { findUnique: vi.fn().mockResolvedValue(null) },
    };

    await expect(
      createDeletionActivities({ prisma: prismaFor(tx) }).completeDeletion({
        input: CONTACT_INPUT,
        located: EMPTY_LOCATED,
      }),
    ).rejects.toThrow('refuse to fabricate receipt');
  });

  it('returns persisted counts for an already completed request without duplicating receipt/event', async () => {
    const receiptCreate = vi.fn();
    const tx = {
      deletionRequest: { findUnique: vi.fn().mockResolvedValue({ status: 'COMPLETED', stats: persisted }) },
      deletionReceipt: { create: receiptCreate },
      outboxEvent: { create: vi.fn() },
    };

    await expect(
      createDeletionActivities({ prisma: prismaFor(tx) }).completeDeletion({ input: CONTACT_INPUT, located: EMPTY_LOCATED }),
    ).resolves.toEqual(persisted);
    expect(receiptCreate).not.toHaveBeenCalled();
  });

  it('heals status when a receipt already exists without emitting a duplicate event', async () => {
    const requestUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const outboxCreate = vi.fn();
    const tx = {
      deletionRequest: {
        findUnique: vi.fn().mockResolvedValue({ status: 'FAILED', stats: persisted }),
        updateMany: requestUpdate,
      },
      deletionReceipt: { findUnique: vi.fn().mockResolvedValue({ id: 'receipt-1' }) },
      outboxEvent: { create: outboxCreate },
    };

    await expect(
      createDeletionActivities({ prisma: prismaFor(tx) }).completeDeletion({ input: CONTACT_INPUT, located: EMPTY_LOCATED }),
    ).resolves.toEqual(persisted);
    expect(requestUpdate).toHaveBeenCalledWith({
      where: { id: 'request-1', status: { notIn: ['COMPLETED'] } },
      data: { status: 'COMPLETED', completedAt: expect.any(Date) },
    });
    expect(outboxCreate).not.toHaveBeenCalled();
  });

  it('atomically writes a minimal receipt, restricted event, and completed status', async () => {
    const receiptCreate = vi.fn().mockResolvedValue({ id: 'receipt-1' });
    const outboxCreate = vi.fn().mockResolvedValue({ id: 'event-1' });
    const requestUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      deletionRequest: {
        findUnique: vi.fn().mockResolvedValue({ status: 'ERASING', stats: persisted }),
        updateMany: requestUpdate,
      },
      deletionReceipt: { findUnique: vi.fn().mockResolvedValue(null), create: receiptCreate },
      outboxEvent: { create: outboxCreate },
    };

    const result = await createDeletionActivities({ prisma: prismaFor(tx) }).completeDeletion({
      input: CONTACT_INPUT,
      located: EMPTY_LOCATED,
    });

    expect(result).toEqual(persisted);
    expect(receiptCreate.mock.calls[0]?.[0]?.data).toMatchObject({
      workspaceId: 'ws-1',
      deletionRequestId: 'request-1',
      subjectType: 'contact',
      subjectId: 'contact-1',
      contactsErased: 1,
      patentCacheErased: 1,
    });
    expect(JSON.stringify(receiptCreate.mock.calls[0]?.[0])).not.toContain('@');
    expect(outboxCreate.mock.calls[0]?.[0]?.data).toMatchObject({
      eventType: 'DeletionCompleted',
      privacyClassification: 'RESTRICTED',
      payload: {
        deletion_request_id: 'request-1',
        subject_ref: 'contact-1',
        contacts_erased: 1,
        patent_cache_erased: 1,
      },
    });
    expect(requestUpdate).toHaveBeenCalledWith({
      where: { id: 'request-1', status: { in: ['ERASING', 'FAILED'] } },
      data: { status: 'COMPLETED', completedAt: expect.any(Date) },
    });
  });

  it('throws when the deletion request is missing', async () => {
    const tx = { deletionRequest: { findUnique: vi.fn().mockResolvedValue(null) } };

    await expect(
      createDeletionActivities({ prisma: prismaFor(tx) }).completeDeletion({ input: CONTACT_INPUT, located: EMPTY_LOCATED }),
    ).rejects.toThrow('deletion_request request-1 not found');
  });

  it('marks a nonterminal request failed using only a one-way diagnostic token', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = { deletionRequest: { updateMany } };
    const raw = 'Dana <dana@example.test> client_secret=hidden';

    await createDeletionActivities({ prisma: prismaFor(tx) }).failDeletion({
      workspaceId: 'ws-1',
      deletionRequestId: 'request-1',
      error: raw,
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'request-1', status: { notIn: ['COMPLETED', 'FAILED'] } },
      data: { status: 'FAILED', error: expect.stringMatching(/^ERROR_TEXT_SHA256:[0-9a-f]{64}$/) },
    });
    expect(JSON.stringify(updateMany.mock.calls)).not.toContain(raw);
  });
});
