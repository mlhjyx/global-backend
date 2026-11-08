import { describe, expect, it, vi } from 'vitest';
import type { LocatedErasureTargets } from '../compliance/deletion.types';
import { createDeletionActivities } from './deletion.activities';

const WORKSPACE_ID = 'e03abddd-1307-47cb-a731-7e7a786615a0';
const COMPANY_ID = 'b8b3ee5c-fbb8-42ef-a382-9c10c16dca72';
const CONTACT_ID = '5d0e9b8e-7f0a-4a55-9a3e-3b2f9f6b1c21';
const DELETION_REQUEST_ID = '11d5ac4e-451e-4a89-b19f-c2f59e632dc9';

function makeTx(companyPoints: number, companyChannels = 0) {
  const order: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      order.push(strings.join('?').includes('FOR UPDATE') ? 'company-for-update' : 'policy-lock');
      return [];
    }),
    $executeRaw: vi.fn(async () => 1),
    deletionRequest: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => null),
    },
    canonicalContact: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    fieldEvidence: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    companyContactPoint: {
      deleteMany: vi.fn(async () => {
        order.push('company-contact-points');
        return { count: companyPoints };
      }),
    },
    companyContactChannel: {
      deleteMany: vi.fn(async () => {
        order.push('company-contact-channels');
        return { count: companyChannels };
      }),
    },
    canonicalCompany: { updateMany: vi.fn(async () => ({ count: 1 })) },
    outboxEvent: { create: vi.fn(async () => ({})) },
  };
  const prisma = { withWorkspace: vi.fn(async (_workspaceId: string, callback: (client: unknown) => unknown) => callback(tx)) };
  return { tx, order, activities: createDeletionActivities({ prisma: prisma as never }) };
}

const LOCATED: LocatedErasureTargets = {
  subjectType: 'company',
  subjectId: COMPANY_ID,
  contactIds: [],
  contactPointsCount: 0,
  fieldEvidenceCount: 0,
  companyIdsToSuppress: [COMPANY_ID],
  signalsToRevoke: 0,
  affectedIcpIds: [],
};

describe('company-subject erasure of company contact points (BI-14)', () => {
  it("deletes the company's contact points under the company row lock and counts them as erased contact points", async () => {
    const { tx, order, activities } = makeTx(4);

    const counts = await activities.eraseSubject({
      input: {
        workspaceId: WORKSPACE_ID,
        deletionRequestId: DELETION_REQUEST_ID,
        subjectType: 'company',
        subjectId: COMPANY_ID,
      },
      located: LOCATED,
    });

    expect(tx.companyContactPoint.deleteMany).toHaveBeenCalledWith({
      where: { companyId: { in: [COMPANY_ID] } },
    });
    // A4：公司级联系方式层同样显式擦除（公司行只标 SUPPRESSED，FK 级联不触发）。
    expect(tx.companyContactChannel.deleteMany).toHaveBeenCalledWith({
      where: { companyId: { in: [COMPANY_ID] } },
    });
    expect(order).toEqual(['policy-lock', 'company-for-update', 'company-contact-points', 'company-contact-channels']);
    expect(counts).toMatchObject({ contactsErased: 0, contactPointsErased: 4, companiesSuppressed: 1 });
    // The persisted stats carry the same count, so the receipt and DeletionCompleted match.
    expect(tx.deletionRequest.updateMany).toHaveBeenLastCalledWith({
      where: { id: DELETION_REQUEST_ID, status: 'ERASING' },
      data: { stats: expect.objectContaining({ contactPointsErased: 4 }) },
    });
    // PR-B：DSR 按 workspace 擦除两张缓存表（页面正文/抽取结果可能含个人信息）。
    const purgeStatements = tx.$executeRaw.mock.calls.map(([strings]) =>
      (strings as TemplateStringsArray).join('?'),
    );
    expect(
      purgeStatements.some((sql) => sql.includes('DELETE FROM url_content_cache')),
    ).toBe(true);
    expect(
      purgeStatements.some((sql) => sql.includes('DELETE FROM llm_extraction_cache')),
    ).toBe(true);
  });

  it('counts erased company-level channels into contactPointsErased', async () => {
    const { tx, activities } = makeTx(2, 3);

    const counts = await activities.eraseSubject({
      input: {
        workspaceId: WORKSPACE_ID,
        deletionRequestId: DELETION_REQUEST_ID,
        subjectType: 'company',
        subjectId: COMPANY_ID,
      },
      located: LOCATED,
    });

    expect(counts).toMatchObject({ contactPointsErased: 5 });
    expect(tx.deletionRequest.updateMany).toHaveBeenLastCalledWith({
      where: { id: DELETION_REQUEST_ID, status: 'ERASING' },
      data: { stats: expect.objectContaining({ contactPointsErased: 5 }) },
    });
  });

  it('leaves company contact points alone when the subject is a contact', async () => {
    const { tx, activities } = makeTx(4);

    await activities.eraseSubject({
      input: {
        workspaceId: WORKSPACE_ID,
        deletionRequestId: DELETION_REQUEST_ID,
        subjectType: 'contact',
        subjectId: CONTACT_ID,
      },
      located: {
        ...LOCATED,
        subjectType: 'contact',
        subjectId: CONTACT_ID,
        contactIds: [CONTACT_ID],
        companyIdsToSuppress: [],
      },
    });

    expect(tx.companyContactPoint.deleteMany).not.toHaveBeenCalled();
    expect(tx.companyContactChannel.deleteMany).not.toHaveBeenCalled();
    // 联系人主体同样按 workspace 擦除缓存（个人数据可能经 Impressum/决策人抽取进入缓存）。
    const purgeStatements = tx.$executeRaw.mock.calls.map(([strings]) =>
      (strings as TemplateStringsArray).join('?'),
    );
    expect(purgeStatements.some((sql) => sql.includes('DELETE FROM url_content_cache'))).toBe(true);
    expect(purgeStatements.some((sql) => sql.includes('DELETE FROM llm_extraction_cache'))).toBe(true);
  });
});
