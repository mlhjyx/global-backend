import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import { DiscoveryService } from '../discovery/discovery.service';

const CTX: RequestContext = {
  workspaceId: '00000000-0000-0000-0000-000000000001',
  userId: 'pilot-reviewer',
  roles: ['compliance'],
};
const SUPPRESSION_ID = '00000000-0000-0000-0000-000000000002';

function serviceFor(reason: string) {
  const createDecision = vi.fn(async ({ data }: { data: unknown }) => ({
    id: 'decision-1',
    ...(data as object),
  }));
  const deleteSuppression = vi.fn();
  const tx = {
    suppressionRecord: {
      findUnique: vi.fn(async () => ({
        id: SUPPRESSION_ID,
        workspaceId: CTX.workspaceId,
        reason,
      })),
      delete: deleteSuppression,
    },
    suppressionReleaseDecision: { create: createDecision },
  };
  const prisma = {
    withWorkspace: vi.fn(
      async (_workspaceId: string, fn: (value: typeof tx) => Promise<unknown>) =>
        fn(tx),
    ),
  };
  const service = new DiscoveryService(prisma as never, {} as never);
  return { service, createDecision, deleteSuppression };
}

describe('suppression release service', () => {
  it('writes an immutable pending request with token-derived workspace and actor', async () => {
    const { service, createDecision } = serviceFor('manual');
    await service.requestSuppressionRelease(CTX, SUPPRESSION_ID, {
      requestKind: 'USER_PREFERENCE',
      justification: 'Preference was recorded by mistake.',
      evidenceRef: null,
    });

    expect(createDecision).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: CTX.workspaceId,
        suppressionRecordId: SUPPRESSION_ID,
        requestKind: 'USER_PREFERENCE',
        status: 'PENDING_REVIEW',
        actorId: CTX.userId,
        justification: 'Preference was recorded by mistake.',
        evidenceRef: null,
      }),
    });
  });

  it('does not create a preference request for a legal suppression', async () => {
    const { service, createDecision } = serviceFor('unsubscribe');
    await expect(
      service.requestSuppressionRelease(CTX, SUPPRESSION_ID, {
        requestKind: 'USER_PREFERENCE',
        justification: 'Please release it.',
        evidenceRef: null,
      }),
    ).rejects.toMatchObject({
      response: { error: { code: 'LEGAL_SUPPRESSION_NOT_RELEASABLE' } },
    });
    expect(createDecision).not.toHaveBeenCalled();
  });

  it('keeps the deprecated DELETE path fail-closed and never deletes a row', async () => {
    const { service, deleteSuppression } = serviceFor('manual');
    await expect(
      service.removeSuppression(CTX, SUPPRESSION_ID),
    ).rejects.toMatchObject({
      response: { error: { code: 'SUPPRESSION_DELETE_DEPRECATED' } },
    });
    expect(deleteSuppression).not.toHaveBeenCalled();
  });
});
