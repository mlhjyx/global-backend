import { describe, expect, it, vi } from 'vitest';
import type { LocatedErasureTargets } from '../compliance/deletion.types';
import { createDeletionActivities } from './deletion.activities';

const WORKSPACE_ID = 'e03abddd-1307-47cb-a731-7e7a786615a0';
const COMPANY_ID = 'b8b3ee5c-fbb8-42ef-a382-9c10c16dca72';
const DELETION_REQUEST_ID = '11d5ac4e-451e-4a89-b19f-c2f59e632dc9';
const CONTACT_PRE = '5d0e9b8e-7f0a-4a55-9a3e-3b2f9f6b1c21';
const CONTACT_STRAGGLER = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

function makeCompanyWorld(opts: {
  attributes?: Record<string, unknown>;
  contacts?: Array<{ id: string; fullName: string; contactPoints: Array<{ type: string; value: string }> }>;
  reqStatus?: string;
  reqStats?: unknown;
} = {}) {
  const rpcCalls: Array<{ sql: string; values: unknown[] }> = [];
  const tx = {
    $queryRaw: vi.fn(async (query: { strings?: TemplateStringsArray; values?: unknown[] } | TemplateStringsArray) => {
      const sql = Array.isArray(query) ? query.join('?') : (query.strings?.join('?') ?? '');
      const values = Array.isArray(query) ? [] : (query.values ?? []);
      if (sql.includes('purge_workspace_company_outreach_drafts_v1')) {
        rpcCalls.push({ sql, values });
        return [{ deleted: 2 }];
      }
      return [];
    }),
    $executeRaw: vi.fn(async () => 0),
    deletionRequest: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => ({
        status: opts.reqStatus ?? 'ERASING',
        stats: opts.reqStats ?? null,
      })),
    },
    deletionReceipt: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
    },
    canonicalContact: {
      findMany: vi.fn(async (args?: { where?: { id?: { not?: string } } }) => {
        const list = opts.contacts ?? [];
        const excluded = args?.where?.id?.not;
        return excluded ? list.filter((c) => c.id !== excluded) : list;
      }),
      findUnique: vi.fn(async () => null),
      deleteMany: vi.fn(async () => ({ count: opts.contacts?.length ?? 0 })),
    },
    fieldEvidence: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    companyContactPoint: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    companyContactChannel: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    canonicalCompany: {
      findMany: vi.fn(async () => [
        {
          id: COMPANY_ID,
          attributes: opts.attributes ?? {
            contact_email: 'ceo@acme.invalid',
            phone: '+49123456',
            gleif: { lei: '529900T8BM49AURSDO55', contact: 'John Doe', person: 'Jane Doe' },
            products: ['industrial pump'],
            unknown_legacy_pii: { email: 'leak@acme.invalid' },
          },
        },
      ]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    outboxEvent: {
      create: vi.fn(async () => ({})),
    },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_workspaceId: string, cb: (client: unknown) => unknown) => cb(tx)),
  };
  return {
    tx,
    rpcCalls,
    activities: createDeletionActivities({ prisma: prisma as never }),
  };
}

const LOCATED_COMPANY: LocatedErasureTargets = {
  subjectType: 'company',
  subjectId: COMPANY_ID,
  contactIds: [CONTACT_PRE],
  contactPointsCount: 0,
  fieldEvidenceCount: 0,
  companyIdsToSuppress: [COMPANY_ID],
  signalsToRevoke: 0,
  affectedIcpIds: [],
};

describe('company DSR erasure gaps (M7a-PR1)', () => {
  it('scrubs canonical_company.attributes, purges lead_outreach_draft via RPC, deletes red company field_evidence, and persists straggler erasedContactRefs', async () => {
    const { tx, rpcCalls, activities } = makeCompanyWorld({
      contacts: [
        { id: CONTACT_STRAGGLER, fullName: 'Straggler Person', contactPoints: [] },
        { id: CONTACT_PRE, fullName: 'Pre Freeze Person', contactPoints: [] },
      ],
    });

    const counts = await activities.eraseSubject({
      input: {
        workspaceId: WORKSPACE_ID,
        deletionRequestId: DELETION_REQUEST_ID,
        subjectType: 'company',
        subjectId: COMPANY_ID,
      },
      located: LOCATED_COMPANY,
    });

    expect(counts.contactsErased).toBe(2);
    expect(tx.canonicalCompany.updateMany).toHaveBeenCalledWith({
      where: { id: COMPANY_ID },
      data: {
        status: 'SUPPRESSED',
        attributes: {
          gleif: { lei: '529900T8BM49AURSDO55' },
          products: ['industrial pump'],
        },
        version: { increment: 1 },
      },
    });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.values).toEqual([WORKSPACE_ID, [COMPANY_ID], DELETION_REQUEST_ID]);
    expect(tx.fieldEvidence.deleteMany).toHaveBeenCalledWith({
      where: {
        entityType: 'company',
        entityId: { in: [COMPANY_ID] },
        dataClass: 'red',
      },
    });
    expect(tx.deletionRequest.updateMany).toHaveBeenLastCalledWith({
      where: { id: DELETION_REQUEST_ID, status: 'ERASING' },
      data: {
        stats: expect.objectContaining({
          contactsErased: 2,
          erasedContactRefs: [CONTACT_STRAGGLER, CONTACT_PRE],
        }),
      },
    });
  });

  it('emits persisted erasedContactRefs (including stragglers) from completeDeletion without needing them in located', async () => {
    const { tx, activities } = makeCompanyWorld({
      reqStatus: 'FAILED',
      reqStats: {
        contactsErased: 2,
        contactPointsErased: 0,
        fieldEvidenceErased: 0,
        signalsRevoked: 0,
        companiesSuppressed: 1,
        leadsRescoreRequested: 0,
        patentCacheErased: 0,
        erasedContactRefs: [CONTACT_STRAGGLER, CONTACT_PRE],
      },
    });

    await activities.completeDeletion({
      input: {
        workspaceId: WORKSPACE_ID,
        deletionRequestId: DELETION_REQUEST_ID,
        subjectType: 'company',
        subjectId: COMPANY_ID,
      },
      located: LOCATED_COMPANY,
    });

    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'DeletionCompleted',
        payload: expect.objectContaining({
          subject_type: 'company',
          subject_ref: COMPANY_ID,
          erased_contact_refs: [CONTACT_STRAGGLER, CONTACT_PRE],
        }),
      }),
    });
  });

  it('omits erasedContactRefs for contact-subject DSR', async () => {
    const { tx, rpcCalls, activities } = makeCompanyWorld({
      contacts: [{ id: CONTACT_PRE, fullName: 'Contact Subject', contactPoints: [] }],
    });
    tx.canonicalContact.findUnique = vi.fn(async () => ({
      id: CONTACT_PRE,
      fullName: 'Contact Subject',
      companyId: COMPANY_ID,
      company: { dedupeKey: 'domain:acme.invalid' },
    }));
    tx.deletionRequest.findUnique = vi.fn(async () => ({
      createdAt: new Date('2026-11-26T00:00:00.000Z'),
      status: 'ERASING',
      stats: null,
    })) as never;

    await activities.eraseSubject({
      input: {
        workspaceId: WORKSPACE_ID,
        deletionRequestId: DELETION_REQUEST_ID,
        subjectType: 'contact',
        subjectId: CONTACT_PRE,
      },
      located: {
        ...LOCATED_COMPANY,
        subjectType: 'contact',
        subjectId: CONTACT_PRE,
        companyIdsToSuppress: [],
      },
    });

    expect(rpcCalls).toHaveLength(0);
    const updateArg = (tx.deletionRequest.updateMany.mock.calls.at(-1)?.[0] ?? {}) as {
      data?: { stats?: Record<string, unknown> };
    };
    expect(updateArg.data?.stats?.erasedContactRefs).toBeUndefined();
  });
});
