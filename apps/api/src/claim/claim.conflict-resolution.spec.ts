import { describe, expect, it, vi } from 'vitest';

import { ClaimService } from './claim.service';

const CTX = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  userId: 'reviewer-42',
  roles: [],
};
const CONFLICT_ID = '22222222-2222-4222-8222-222222222222';
const CLAIM_A_ID = '33333333-3333-4333-8333-333333333333';
const CLAIM_B_ID = '44444444-4444-4444-8444-444444444444';
const COMPANY_ID = '55555555-5555-4555-8555-555555555555';

function makeService(input: {
  loserStatus?: string;
  conflictCasCount?: number;
  claimCasCount?: number;
  winnerWorkspaceId?: string;
  winnerCompanyId?: string;
  winnerStatus?: string;
  lockedWinnerStatus?: string;
} = {}) {
  const conflictUpdateMany = vi.fn(async () => ({
    count: input.conflictCasCount ?? 1,
  }));
  const claimUpdateMany = vi.fn(async () => ({
    count: input.claimCasCount ?? 1,
  }));
  const eventCreate = vi.fn(async () => ({ id: 'event-1' }));
  const conflict = {
    id: CONFLICT_ID,
    workspaceId: CTX.workspaceId,
    companyId: COMPANY_ID,
    claimAId: CLAIM_A_ID,
    claimBId: CLAIM_B_ID,
    claimType: 'certification',
    status: 'OPEN',
  };
  const loser = {
    id: CLAIM_B_ID,
    workspaceId: CTX.workspaceId,
    companyId: COMPANY_ID,
    factKey: 'quality_certifications',
    type: 'certification',
    status: input.loserStatus ?? 'APPROVED',
    version: 7,
  };
  const winner = {
    id: CLAIM_A_ID,
    workspaceId: input.winnerWorkspaceId ?? CTX.workspaceId,
    companyId: input.winnerCompanyId ?? COMPANY_ID,
    factKey: 'quality_certifications',
    type: 'certification',
    status: input.lockedWinnerStatus ?? input.winnerStatus ?? 'APPROVED',
    version: 3,
  };
  const tx = {
    $queryRaw: vi.fn(async () => [winner, loser]),
    knowledgeConflict: {
      findUnique: vi.fn(async () => conflict),
      updateMany: conflictUpdateMany,
      findUniqueOrThrow: vi.fn(async () => ({
        ...conflict,
        status: 'RESOLVED',
        resolution: 'kept_a',
      })),
    },
    claim: {
      findUnique: vi.fn(async () => loser),
      findMany: vi.fn(async () => [
        { ...winner, status: input.winnerStatus ?? 'APPROVED' },
        loser,
      ]),
      updateMany: claimUpdateMany,
    },
    outboxEvent: { create: eventCreate },
  };
  const prisma = {
    withWorkspace: async (
      workspaceId: string,
      run: (transaction: typeof tx) => Promise<unknown>,
    ) => {
      expect(workspaceId).toBe(CTX.workspaceId);
      return run(tx);
    },
  };
  return {
    service: new ClaimService(prisma as never),
    conflictUpdateMany,
    claimUpdateMany,
    eventCreate,
  };
}

describe('ClaimService.resolveConflict', () => {
  it('CAS-resolves the conflict, versions an approved loser, and emits ClaimRevoked', async () => {
    const {
      service,
      conflictUpdateMany,
      claimUpdateMany,
      eventCreate,
    } = makeService();

    await service.resolveConflict(CTX, CONFLICT_ID, 'a');

    expect(conflictUpdateMany).toHaveBeenCalledWith({
      where: { id: CONFLICT_ID, status: 'OPEN' },
      data: {
        status: 'RESOLVED',
        resolution: 'kept_a',
        resolvedBy: CTX.userId,
        resolvedAt: expect.any(Date),
      },
    });
    expect(claimUpdateMany).toHaveBeenCalledWith({
      where: { id: CLAIM_B_ID, status: 'APPROVED', version: 7 },
      data: { status: 'REVOKED', version: { increment: 1 } },
    });
    expect(eventCreate).toHaveBeenCalledWith({
      data: {
        workspaceId: CTX.workspaceId,
        eventType: 'ClaimRevoked',
        aggregateType: 'Claim',
        aggregateId: CLAIM_B_ID,
        payload: {
          companyId: COMPANY_ID,
          factKey: 'quality_certifications',
          type: 'certification',
        },
      },
    });
  });

  it('fails a second contradictory resolver before touching either Claim', async () => {
    const { service, claimUpdateMany, eventCreate } = makeService({
      conflictCasCount: 0,
    });

    await expect(
      service.resolveConflict(CTX, CONFLICT_ID, 'b'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        error: expect.objectContaining({ code: 'VERSION_CONFLICT' }),
      }),
    });
    expect(claimUpdateMany).not.toHaveBeenCalled();
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it('versions a pending loser without emitting an approved-claim revoke event', async () => {
    const { service, claimUpdateMany, eventCreate } = makeService({
      loserStatus: 'NEEDS_REVIEW',
    });

    await service.resolveConflict(CTX, CONFLICT_ID, 'a');

    expect(claimUpdateMany).toHaveBeenCalledWith({
      where: { id: CLAIM_B_ID, status: 'NEEDS_REVIEW', version: 7 },
      data: { status: 'REVOKED', version: { increment: 1 } },
    });
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it('rolls back through an error when the loser changes after conflict CAS', async () => {
    const { service, eventCreate } = makeService({ claimCasCount: 0 });

    await expect(
      service.resolveConflict(CTX, CONFLICT_ID, 'a'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        error: expect.objectContaining({ code: 'VERSION_CONFLICT' }),
      }),
    });
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it.each([
    { winnerWorkspaceId: '99999999-9999-4999-8999-999999999999' },
    { winnerCompanyId: '88888888-8888-4888-8888-888888888888' },
    { winnerStatus: 'REVOKED' },
    { winnerStatus: 'EXPIRED' },
  ])('fails closed when the kept Claim is outside the conflict identity or terminal: %o', async (override) => {
    const { service, conflictUpdateMany, claimUpdateMany, eventCreate } =
      makeService(override);

    await expect(
      service.resolveConflict(CTX, CONFLICT_ID, 'a'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        error: expect.objectContaining({ code: 'CONFLICT_IDENTITY_MISMATCH' }),
      }),
    });
    expect(conflictUpdateMany).not.toHaveBeenCalled();
    expect(claimUpdateMany).not.toHaveBeenCalled();
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it('uses the locked winner state instead of an earlier unlocked snapshot', async () => {
    const { service, conflictUpdateMany, claimUpdateMany } = makeService({
      winnerStatus: 'APPROVED',
      lockedWinnerStatus: 'REVOKED',
    });

    await expect(
      service.resolveConflict(CTX, CONFLICT_ID, 'a'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        error: expect.objectContaining({ code: 'CONFLICT_IDENTITY_MISMATCH' }),
      }),
    });
    expect(conflictUpdateMany).not.toHaveBeenCalled();
    expect(claimUpdateMany).not.toHaveBeenCalled();
  });
});
