import { describe, expect, it, vi } from 'vitest';
import { createOrganizationIdentityReplayActivities } from './organization-identity-replay.activities';

const INPUT = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  replayId: 'replay-1',
};

function prismaFor(tx: Record<string, unknown>) {
  const transaction = { $queryRaw: async () => [], ...tx };
  return {
    withWorkspace: async (_workspaceId: string, fn: (value: typeof transaction) => unknown) => fn(transaction),
  } as never;
}

describe('organization identity deterministic replay', () => {
  it('merge revokes candidate links, activates the selected root and resolves the conflict', async () => {
    const linkCreate = vi.fn(async () => ({}));
    const conflictUpdate = vi.fn(async () => ({}));
    const replayUpdate = vi.fn(async () => ({}));
    const identifierUpdate = vi.fn(async () => ({}));
    const tx = {
      $executeRaw: async () => 1,
      organizationIdentityReplay: {
        findUnique: async () => ({
          id: INPUT.replayId,
          status: 'PENDING',
          decision: {
            id: 'decision-1',
            action: 'MERGE',
            conflictId: 'conflict-1',
            canonicalCompanyId: 'root-1',
          },
        }),
        update: replayUpdate,
        updateMany: async () => ({ count: 1 }),
      },
      identityLink: {
        findMany: async () => [
          {
            rawRecordId: 'raw-1',
            resolverVersion: 'organization-identity-v2',
            inputHash: 'a'.repeat(64),
          },
        ],
        updateMany: async () => ({}),
        findFirst: async () => null,
        create: linkCreate,
      },
      organizationIdentityConflict: { update: conflictUpdate },
      organizationIdentityConflictParty: {
        findMany: async () => [{ companyId: 'root-1' }],
      },
      organizationIdentifier: {
        findMany: async () => [{
          id: 'identifier-1',
          companyId: 'root-1',
          scheme: 'lei',
          jurisdiction: 'GLOBAL',
          normalizedValue: '529900T8BM49AURSDO55',
        }],
        findFirst: async () => null,
        update: identifierUpdate,
        updateMany: async () => ({}),
      },
      organizationCanonicalMapping: { findFirst: async () => null, findMany: async () => [] },
      lead: { findMany: async () => [] },
      outboxEvent: { count: async () => 0 },
    };
    const result = await createOrganizationIdentityReplayActivities({
      prisma: prismaFor(tx),
    }).processOrganizationIdentityReplay(INPUT);
    expect(result.status).toBe('SUCCEEDED');
    expect(linkCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        canonicalId: 'root-1',
        rawRecordId: 'raw-1',
        matchRule: 'manual_merge',
        status: 'ACTIVE',
      }),
    });
    expect(conflictUpdate).toHaveBeenCalledWith({
      where: { id: 'conflict-1' },
      data: expect.objectContaining({ status: 'RESOLVED' }),
    });
    expect(identifierUpdate).toHaveBeenCalledWith({
      where: { id: 'identifier-1' },
      data: expect.objectContaining({ status: 'ACTIVE', revokedAt: null }),
    });
    expect(replayUpdate).toHaveBeenLastCalledWith({
      where: { id: INPUT.replayId },
      data: expect.objectContaining({ status: 'SUCCEEDED' }),
    });
  });

  it('preserves the conflict edge when the selected root already owns a pending link so split can restore it', async () => {
    const existingUpdate = vi.fn(async () => ({}));
    const tx = {
      $executeRaw: async () => 1,
      organizationIdentityReplay: {
        findUnique: async () => ({
          id: INPUT.replayId,
          status: 'PENDING',
          decision: {
            id: 'decision-1',
            action: 'MERGE',
            conflictId: 'conflict-1',
            canonicalCompanyId: 'root-1',
          },
        }),
        update: async () => ({}),
        updateMany: async () => ({ count: 1 }),
      },
      identityLink: {
        findMany: async () => [{
          id: 'pending-root-link',
          rawRecordId: 'raw-root',
          resolverVersion: 'organization-identity-v2',
          inputHash: 'a'.repeat(64),
        }],
        updateMany: async () => ({}),
        findFirst: async () => ({
          id: 'pending-root-link',
          conflictId: 'conflict-1',
          status: 'REVOKED',
        }),
        update: existingUpdate,
        create: async () => ({}),
      },
      organizationIdentityConflict: { update: async () => ({}) },
      organizationIdentityConflictParty: {
        findMany: async () => [{ companyId: 'root-1' }],
      },
      organizationIdentifier: { findMany: async () => [] },
      organizationCanonicalMapping: { findFirst: async () => null, findMany: async () => [] },
      lead: { findMany: async () => [] },
      outboxEvent: { count: async () => 0 },
    };

    await createOrganizationIdentityReplayActivities({ prisma: prismaFor(tx) })
      .processOrganizationIdentityReplay(INPUT);

    expect(existingUpdate).toHaveBeenCalledWith({
      where: { id: 'pending-root-link' },
      data: { status: 'ACTIVE' },
    });
  });

  it('split revokes the manual merge projection and reopens the original conflict', async () => {
    const linkUpdateMany = vi.fn(async () => ({}));
    const conflictUpdate = vi.fn(async () => ({}));
    const identifierUpdateMany = vi.fn(async () => ({}));
    const mappingUpdateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      $executeRaw: async () => 1,
      $queryRaw: async () => [],
      organizationIdentityReplay: {
        findUnique: async () => ({
          id: INPUT.replayId,
          status: 'PENDING',
          decision: {
            id: 'split-1',
            action: 'SPLIT',
            conflictId: null,
            canonicalCompanyId: null,
            expectedRevision: 1,
            factSnapshot: { mappingId: 'mapping-1' },
          },
        }),
        update: async () => ({}),
        updateMany: async () => ({ count: 1 }),
      },
      identityLink: {
        findMany: async () => [{ rawRecordId: 'raw-1' }],
        updateMany: linkUpdateMany,
        findFirst: async () => null,
        create: async () => ({}),
      },
      organizationIdentityConflict: { update: conflictUpdate },
      organizationIdentifier: { updateMany: identifierUpdateMany },
      organizationCanonicalMapping: {
        findUnique: async () => ({
          id: 'mapping-1',
          sourceCompanyId: 'alias-1',
          canonicalCompanyId: 'root-1',
          status: 'ACTIVE',
          revision: 1,
          splitDecisionId: null,
          mergeDecision: {
            conflictId: 'conflict-1',
            replay: { status: 'SUCCEEDED' },
            conflict: { status: 'RESOLVED' },
          },
        }),
        findMany: async () => [{ sourceCompanyId: 'alias-1', canonicalCompanyId: 'root-1' }],
        updateMany: mappingUpdateMany,
      },
      lead: { findMany: async () => [] },
      outboxEvent: { count: async () => 0 },
    };
    await createOrganizationIdentityReplayActivities({
      prisma: prismaFor(tx),
    }).processOrganizationIdentityReplay(INPUT);
    expect(linkUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        rawRecordId: { in: ['raw-1'] },
        matchRule: 'manual_merge',
        status: 'ACTIVE',
      }),
      data: { status: 'REVOKED' },
    });
    expect(conflictUpdate).toHaveBeenCalledWith({
      where: { id: 'conflict-1' },
      data: expect.objectContaining({ status: 'OPEN', resolvedAt: null }),
    });
    expect(identifierUpdateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: INPUT.workspaceId,
        OR: [
          { conflictId: 'conflict-1' },
          { conflictId: null, rawRecordId: { in: ['raw-1'] } },
        ],
        status: { in: ['ACTIVE', 'REVOKED'] },
      },
      data: { status: 'PENDING_CONFLICT', revokedAt: null },
    });
    expect(mappingUpdateMany).toHaveBeenCalledWith({
      where: { id: 'mapping-1', status: 'ACTIVE', revision: 1 },
      data: {
        status: 'REVOKED',
        revision: { increment: 1 },
        splitDecisionId: 'split-1',
        revokedAt: expect.any(Date),
      },
    });
    expect(mappingUpdateMany.mock.invocationCallOrder[0]).toBeGreaterThan(
      conflictUpdate.mock.invocationCallOrder[0],
    );
  });

  it('fails closed before split projection writes when commercial facts appeared after the request', async () => {
    const linkUpdateMany = vi.fn(async () => ({}));
    const identifierUpdateMany = vi.fn(async () => ({}));
    const conflictUpdate = vi.fn(async () => ({}));
    const mappingUpdateMany = vi.fn(async () => ({ count: 1 }));
    const failedReplayUpdate = vi.fn(async () => ({}));
    let transactions = 0;
    const prisma = {
      withWorkspace: async (_workspaceId: string, fn: (value: unknown) => unknown) => {
        transactions += 1;
        if (transactions > 1) {
          return fn({ organizationIdentityReplay: { updateMany: failedReplayUpdate } });
        }
        return fn({
          $executeRaw: async () => 1,
          $queryRaw: async () => [],
          organizationIdentityReplay: {
            findUnique: async () => ({
              id: INPUT.replayId,
              status: 'PENDING',
              decision: {
                id: 'split-1',
                action: 'SPLIT',
                expectedRevision: 1,
                factSnapshot: { mappingId: 'mapping-1' },
              },
            }),
            update: async () => ({}),
            updateMany: async () => ({ count: 1 }),
          },
          organizationCanonicalMapping: {
            findUnique: async () => ({
              id: 'mapping-1',
              workspaceId: INPUT.workspaceId,
              sourceCompanyId: 'alias-1',
              canonicalCompanyId: 'root-1',
              status: 'ACTIVE',
              revision: 1,
              splitDecisionId: null,
              mergeDecision: {
                conflictId: 'conflict-1',
                replay: { status: 'SUCCEEDED' },
                conflict: { status: 'RESOLVED' },
              },
            }),
            findMany: async () => [{ sourceCompanyId: 'alias-1', canonicalCompanyId: 'root-1' }],
            updateMany: mappingUpdateMany,
          },
          lead: {
            findMany: async () => [{
              id: 'lead-qualified',
              icpId: 'icp-1',
              canonicalCompanyId: 'root-1',
              status: 'QUALIFIED',
            }],
          },
          outboxEvent: { count: async () => 0 },
          identityLink: { findMany: async () => [], updateMany: linkUpdateMany },
          organizationIdentifier: { updateMany: identifierUpdateMany },
          organizationIdentityConflict: { update: conflictUpdate },
        });
      },
    } as never;

    await expect(createOrganizationIdentityReplayActivities({ prisma })
      .processOrganizationIdentityReplay(INPUT)).rejects.toMatchObject({
      code: 'COMMERCIAL_FACTS_IMMUTABLE',
    });

    expect(linkUpdateMany).not.toHaveBeenCalled();
    expect(identifierUpdateMany).not.toHaveBeenCalled();
    expect(conflictUpdate).not.toHaveBeenCalled();
    expect(mappingUpdateMany).not.toHaveBeenCalled();
    expect(failedReplayUpdate).toHaveBeenCalledWith({
      where: { id: INPUT.replayId, status: { in: ['PENDING', 'FAILED'] } },
      data: expect.objectContaining({
        status: 'FAILED',
        attempt: { increment: 1 },
        errorCode: 'COMMERCIAL_FACTS_IMMUTABLE',
      }),
    });
  });

  it('fails closed before split projection writes when the merge replay is not settled', async () => {
    const mappingUpdateMany = vi.fn(async () => ({ count: 1 }));
    const linkUpdateMany = vi.fn(async () => ({}));
    const failedReplayUpdate = vi.fn(async () => ({}));
    let transactions = 0;
    const prisma = {
      withWorkspace: async (_workspaceId: string, fn: (value: unknown) => unknown) => {
        transactions += 1;
        if (transactions > 1) {
          return fn({ organizationIdentityReplay: { updateMany: failedReplayUpdate } });
        }
        return fn({
          $executeRaw: async () => 1,
          $queryRaw: async () => [],
          organizationIdentityReplay: {
            findUnique: async () => ({
              id: INPUT.replayId,
              status: 'PENDING',
              decision: {
                id: 'split-1',
                action: 'SPLIT',
                expectedRevision: 1,
                factSnapshot: { mappingId: 'mapping-1' },
              },
            }),
            update: async () => ({}),
            updateMany: async () => ({ count: 1 }),
          },
          organizationCanonicalMapping: {
            findUnique: async () => ({
              id: 'mapping-1',
              sourceCompanyId: 'alias-1',
              canonicalCompanyId: 'root-1',
              status: 'ACTIVE',
              revision: 1,
              splitDecisionId: null,
              mergeDecision: {
                conflictId: 'conflict-1',
                replay: { status: 'PENDING' },
                conflict: { status: 'RESOLVING' },
              },
            }),
            updateMany: mappingUpdateMany,
          },
          identityLink: { updateMany: linkUpdateMany },
        });
      },
    } as never;

    await expect(createOrganizationIdentityReplayActivities({ prisma })
      .processOrganizationIdentityReplay(INPUT)).rejects.toMatchObject({
      code: 'IDENTITY_MERGE_PROJECTION_UNSETTLED',
    });
    expect(mappingUpdateMany).not.toHaveBeenCalled();
    expect(linkUpdateMany).not.toHaveBeenCalled();
    expect(failedReplayUpdate).toHaveBeenCalledWith({
      where: { id: INPUT.replayId, status: { in: ['PENDING', 'FAILED'] } },
      data: expect.objectContaining({
        status: 'FAILED',
        attempt: { increment: 1 },
        errorCode: 'IDENTITY_MERGE_PROJECTION_UNSETTLED',
      }),
    });
  });

  it('rolls back split projection changes and keeps the mapping active when replay throws', async () => {
    const original = {
      mapping: { status: 'ACTIVE', revision: 1, splitDecisionId: null as string | null },
      manualLinkStatus: 'ACTIVE',
      conflictLinkStatus: 'REVOKED',
      identifierStatus: 'ACTIVE',
      conflictStatus: 'RESOLVED',
    };
    let state = structuredClone(original);
    let calls = 0;
    const failedReplayUpdate = vi.fn(async () => ({}));
    const prisma = {
      withWorkspace: async (_workspaceId: string, fn: (value: unknown) => unknown) => {
        calls += 1;
        if (calls > 1) {
          return fn({ organizationIdentityReplay: { updateMany: failedReplayUpdate } });
        }
        const draft = structuredClone(state);
        const tx = {
          $queryRaw: async () => [],
          $executeRaw: async () => 1,
          organizationIdentityReplay: {
            findUnique: async () => ({
              id: INPUT.replayId,
              status: 'PENDING',
              decision: {
                id: 'split-1',
                action: 'SPLIT',
                expectedRevision: 1,
                factSnapshot: { mappingId: 'mapping-1' },
              },
            }),
            update: async () => ({}),
            updateMany: async () => ({ count: 1 }),
          },
          organizationCanonicalMapping: {
            findUnique: async () => ({
              id: 'mapping-1',
              ...draft.mapping,
              sourceCompanyId: 'alias-1',
              canonicalCompanyId: 'root-1',
              mergeDecision: {
                conflictId: 'conflict-1',
                replay: { status: 'SUCCEEDED' },
                conflict: { status: 'RESOLVED' },
              },
            }),
            findMany: async () => [{ sourceCompanyId: 'alias-1', canonicalCompanyId: 'root-1' }],
            updateMany: async () => {
              draft.mapping = { status: 'REVOKED', revision: 2, splitDecisionId: 'split-1' };
              return { count: 1 };
            },
          },
          identityLink: {
            findMany: async () => [{ rawRecordId: 'raw-1' }],
            updateMany: async ({
              where,
              data,
            }: {
              where: { matchRule?: string; conflictId?: string };
              data: { status: string };
            }) => {
              if (where.matchRule === 'manual_merge') draft.manualLinkStatus = data.status;
              if (where.conflictId) draft.conflictLinkStatus = data.status;
              return {};
            },
          },
          organizationIdentifier: {
            updateMany: async ({ data }: { data: { status: string } }) => {
              draft.identifierStatus = data.status;
              return {};
            },
          },
          organizationIdentityConflict: {
            update: async () => {
              draft.conflictStatus = 'OPEN';
              throw new Error('projection failed');
            },
          },
          lead: { findMany: async () => [] },
          outboxEvent: { count: async () => 0 },
        };
        const result = await fn(tx);
        state = draft;
        return result;
      },
    } as never;

    await expect(createOrganizationIdentityReplayActivities({ prisma })
      .processOrganizationIdentityReplay(INPUT)).rejects.toThrow('projection failed');

    expect(state).toEqual(original);
    expect(failedReplayUpdate).toHaveBeenCalledWith({
      where: { id: INPUT.replayId, status: { in: ['PENDING', 'FAILED'] } },
      data: expect.objectContaining({
        status: 'FAILED',
        attempt: { increment: 1 },
        errorCode: 'IDENTITY_REPLAY_FAILED',
      }),
    });
  });

  it('returns an already succeeded replay without touching mapping or projection state', async () => {
    const replayLock = vi.fn(async () => 1);
    const mappingFind = vi.fn(async () => null);
    const linkUpdate = vi.fn(async () => ({}));
    const replayUpdate = vi.fn(async () => ({}));
    const replayFind = vi.fn(async () => ({
      id: INPUT.replayId,
      status: 'SUCCEEDED',
      decision: {
        id: 'split-1',
        action: 'SPLIT',
        expectedRevision: 1,
        factSnapshot: { mappingId: 'mapping-1' },
      },
    }));
    const tx = {
      $executeRaw: replayLock,
      organizationIdentityReplay: {
        findUnique: replayFind,
        update: replayUpdate,
      },
      organizationCanonicalMapping: { findUnique: mappingFind },
      identityLink: { updateMany: linkUpdate },
    };

    await expect(createOrganizationIdentityReplayActivities({ prisma: prismaFor(tx) })
      .processOrganizationIdentityReplay(INPUT)).resolves.toEqual({
      status: 'SUCCEEDED',
      replayId: INPUT.replayId,
    });
    expect(mappingFind).not.toHaveBeenCalled();
    expect(linkUpdate).not.toHaveBeenCalled();
    expect(replayUpdate).not.toHaveBeenCalled();
    expect(replayLock.mock.invocationCallOrder[0]).toBeLessThan(replayFind.mock.invocationCallOrder[0]);
  });

  it('does not redo projection or overwrite state when the locked reread is already RUNNING', async () => {
    const projectionUpdate = vi.fn(async () => ({}));
    const replayUpdate = vi.fn(async () => ({}));
    const failureUpdate = vi.fn(async () => ({ count: 0 }));
    let calls = 0;
    const prisma = {
      withWorkspace: async (_workspaceId: string, fn: (value: Record<string, unknown>) => unknown) => {
        calls += 1;
        if (calls === 1) {
          return fn({
            $queryRaw: async () => [],
            $executeRaw: async () => 1,
            organizationIdentityReplay: {
              findUnique: async () => ({
                id: INPUT.replayId,
                status: 'RUNNING',
                decision: { id: 'decision-1', action: 'MERGE' },
              }),
              update: replayUpdate,
              updateMany: async () => ({ count: 0 }),
            },
            identityLink: { updateMany: projectionUpdate },
          });
        }
        return fn({ organizationIdentityReplay: { updateMany: failureUpdate } });
      },
    } as never;

    await expect(createOrganizationIdentityReplayActivities({ prisma })
      .processOrganizationIdentityReplay(INPUT)).rejects.toMatchObject({
      code: 'IDENTITY_REPLAY_ALREADY_RUNNING',
    });
    expect(replayUpdate).not.toHaveBeenCalled();
    expect(projectionUpdate).not.toHaveBeenCalled();
    expect(failureUpdate).toHaveBeenCalledWith({
      where: { id: INPUT.replayId, status: { in: ['PENDING', 'FAILED'] } },
      data: expect.objectContaining({ status: 'FAILED' }),
    });
  });

  it('keep-separate revokes pending identifier claims and leaves the raw unbound', async () => {
    const identifierUpdateMany = vi.fn(async () => ({}));
    const linkCreate = vi.fn(async () => ({}));
    const tx = {
      $executeRaw: async () => 1,
      organizationIdentityReplay: {
        findUnique: async () => ({
          id: INPUT.replayId,
          status: 'PENDING',
          decision: {
            id: 'decision-keep',
            action: 'KEEP_SEPARATE',
            conflictId: 'conflict-1',
            canonicalCompanyId: null,
          },
        }),
        update: async () => ({}),
        updateMany: async () => ({ count: 1 }),
      },
      identityLink: {
        findMany: async () => [{ rawRecordId: 'raw-1' }],
        updateMany: async () => ({}),
        findFirst: async () => null,
        create: linkCreate,
      },
      organizationIdentifier: {
        findMany: async () => [{ id: 'identifier-1' }],
        updateMany: identifierUpdateMany,
      },
      organizationIdentityConflict: { update: async () => ({}) },
      organizationCanonicalMapping: { findFirst: async () => null },
    };

    await createOrganizationIdentityReplayActivities({ prisma: prismaFor(tx) })
      .processOrganizationIdentityReplay(INPUT);

    expect(linkCreate).not.toHaveBeenCalled();
    expect(identifierUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['identifier-1'] }, status: 'PENDING_CONFLICT' },
      data: { status: 'REVOKED', revokedAt: expect.any(Date) },
    });
  });

  it('projects enrichment-only pending claims even when the conflict has no Raw link', async () => {
    const identifierUpdate = vi.fn(async () => ({}));
    const tx = {
      $executeRaw: async () => 1,
      organizationIdentityReplay: {
        findUnique: async () => ({
          id: INPUT.replayId,
          status: 'PENDING',
          decision: {
            id: 'decision-enrichment',
            action: 'MERGE',
            conflictId: 'conflict-enrichment',
            canonicalCompanyId: 'root-1',
          },
        }),
        update: async () => ({}),
        updateMany: async () => ({ count: 1 }),
      },
      identityLink: {
        findMany: async () => [],
        updateMany: async () => ({}),
      },
      organizationIdentityConflict: { update: async () => ({}) },
      organizationIdentityConflictParty: {
        findMany: async () => [{ companyId: 'root-1' }, { companyId: 'alias-1' }],
      },
      organizationIdentifier: {
        findMany: async ({ where }: any) =>
          where.conflictId === undefined && where.OR?.some((item: any) => item.conflictId === 'conflict-enrichment')
            ? [{
                id: 'pending-enrichment',
                companyId: 'alias-1',
                scheme: 'wikidata-qid',
                jurisdiction: 'GLOBAL',
                normalizedValue: 'Q100',
              }]
            : [],
        findFirst: async () => null,
        update: identifierUpdate,
      },
      organizationCanonicalMapping: {
        findFirst: async ({ where }: any) =>
          where.sourceCompanyId === 'alias-1' ? { canonicalCompanyId: 'root-1' } : null,
        findMany: async () => [],
      },
      lead: { findMany: async () => [] },
      outboxEvent: { count: async () => 0 },
    };

    await createOrganizationIdentityReplayActivities({ prisma: prismaFor(tx) })
      .processOrganizationIdentityReplay(INPUT);

    expect(identifierUpdate).toHaveBeenCalledWith({
      where: { id: 'pending-enrichment' },
      data: expect.objectContaining({ status: 'ACTIVE', revokedAt: null }),
    });
  });

  it('split restores enrichment-only claims to pending without requiring a Raw link', async () => {
    const identifierUpdateMany = vi.fn(async () => ({ count: 1 }));
    const linkUpdateMany = vi.fn(async () => ({ count: 0 }));
    const conflictUpdate = vi.fn(async () => ({}));
    const tx = {
      $executeRaw: async () => 1,
      $queryRaw: async () => [],
      organizationIdentityReplay: {
        findUnique: async () => ({
          id: INPUT.replayId,
          status: 'PENDING',
          decision: {
            id: 'split-enrichment',
            action: 'SPLIT',
            expectedRevision: 1,
            factSnapshot: { mappingId: 'mapping-enrichment' },
          },
        }),
        update: async () => ({}),
        updateMany: async () => ({ count: 1 }),
      },
      organizationCanonicalMapping: {
        findUnique: async () => ({
          id: 'mapping-enrichment',
          sourceCompanyId: 'alias-1',
          canonicalCompanyId: 'root-1',
          status: 'ACTIVE',
          revision: 1,
          splitDecisionId: null,
          mergeDecision: {
            conflictId: 'conflict-enrichment',
            replay: { status: 'SUCCEEDED' },
            conflict: { status: 'RESOLVED' },
          },
        }),
        findMany: async () => [{ sourceCompanyId: 'alias-1', canonicalCompanyId: 'root-1' }],
        updateMany: async () => ({ count: 1 }),
      },
      identityLink: {
        findMany: async () => [],
        updateMany: linkUpdateMany,
      },
      organizationIdentifier: { updateMany: identifierUpdateMany },
      organizationIdentityConflict: { update: conflictUpdate },
      lead: { findMany: async () => [] },
      outboxEvent: { count: async () => 0 },
    };

    await createOrganizationIdentityReplayActivities({ prisma: prismaFor(tx) })
      .processOrganizationIdentityReplay(INPUT);

    expect(identifierUpdateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: INPUT.workspaceId,
        OR: [{ conflictId: 'conflict-enrichment' }],
        status: { in: ['ACTIVE', 'REVOKED'] },
      },
      data: { status: 'PENDING_CONFLICT', revokedAt: null },
    });
    expect(conflictUpdate).toHaveBeenCalledWith({
      where: { id: 'conflict-enrichment' },
      data: expect.objectContaining({ status: 'OPEN', resolvedAt: null }),
    });
    expect(linkUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('records FAILED and leaves the review state unresolved when projection fails', async () => {
    const failedUpdate = vi.fn(async () => ({}));
    let calls = 0;
    const prisma = {
      withWorkspace: async (_workspaceId: string, fn: (value: Record<string, unknown>) => unknown) => {
        calls += 1;
        if (calls === 1) {
          return fn({
            $queryRaw: async () => [],
            $executeRaw: async () => 1,
            organizationIdentityReplay: {
              findUnique: async () => ({
                id: INPUT.replayId,
                status: 'PENDING',
                decision: {
                  id: 'decision-1',
                  action: 'MERGE',
                  conflictId: null,
                  canonicalCompanyId: 'root-1',
                },
              }),
              update: async () => ({}),
              updateMany: async () => ({ count: 1 }),
            },
          });
        }
        return fn({ organizationIdentityReplay: { updateMany: failedUpdate } });
      },
    } as never;
    await expect(
      createOrganizationIdentityReplayActivities({
        prisma,
      }).processOrganizationIdentityReplay(INPUT),
    ).rejects.toThrow('merge/keep-separate decision has no conflict');
    expect(failedUpdate).toHaveBeenCalledWith({
      where: { id: INPUT.replayId, status: { in: ['PENDING', 'FAILED'] } },
      data: expect.objectContaining({
        status: 'FAILED',
        errorCode: 'IDENTITY_REPLAY_FAILED',
      }),
    });
    expect(JSON.stringify(failedUpdate.mock.calls)).not.toContain('merge/keep-separate decision has no conflict');
  });
});
