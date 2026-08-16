import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { conflictEtag, mappingEtag, OrganizationIdentityService, parseRevisionEtag } from './organization-identity.service';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CONFLICT_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const COMPANY_ID = '44444444-4444-4444-8444-444444444444';
const CTX = {
  workspaceId: WORKSPACE_ID,
  userId: 'reviewer',
  roles: [],
  scopes: [],
};

describe('organization identity review preconditions', () => {
  it('rejects a non-UUID cursor with a stable 400 before Prisma sees it', () => {
    const withWorkspace = vi.fn();
    const service = new OrganizationIdentityService({ withWorkspace } as never);

    let caught: unknown;
    try {
      service.listConflicts(CTX, { cursor: 'not-a-uuid', limit: 20 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      status: 400,
      response: { error: { code: 'VALIDATION_ERROR' } },
    });
    expect(withWorkspace).not.toHaveBeenCalled();
  });

  it('requires If-Match with 428 and rejects malformed values with 400', () => {
    for (const [raw, status] of [
      [undefined, 428],
      ['"wrong"', 400],
    ] as const) {
      try {
        parseRevisionEtag(raw, 'conflict', CONFLICT_ID);
        throw new Error('expected precondition failure');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(status);
        expect((error as HttpException).getResponse()).toMatchObject({
          error: {
            code: status === 428 ? 'PRECONDITION_REQUIRED' : 'VALIDATION_ERROR',
          },
        });
      }
    }
  });

  it('round-trips the strong conflict ETag revision', () => {
    expect(parseRevisionEtag(conflictEtag(CONFLICT_ID, 17), 'conflict', CONFLICT_ID)).toBe(17);
  });

  it('returns tenant-hidden 404 and stale ETag 412', async () => {
    const makeService = (conflict: unknown) => {
      const tx = {
        $executeRaw: async () => 1,
        $queryRaw: async () => [],
        organizationIdentityDecision: { findUnique: async () => null },
        organizationIdentityConflict: { findUnique: async () => conflict },
      };
      return new OrganizationIdentityService({
        withWorkspace: async (_ws: string, fn: (arg: typeof tx) => unknown) => fn(tx),
      } as never);
    };
    await expect(
      makeService(null).decideConflict(CTX, CONFLICT_ID, conflictEtag(CONFLICT_ID, 1), {
        requestId: REQUEST_ID,
        decision: 'keep_separate',
        reasonCode: 'LEGAL_ENTITIES_DIFFER',
      }),
    ).rejects.toMatchObject({
      status: 404,
      response: { error: { code: 'NOT_FOUND' } },
    });
    await expect(
      makeService({
        id: CONFLICT_ID,
        revision: 2,
        status: 'OPEN',
        parties: [],
        facts: {},
      }).decideConflict(CTX, CONFLICT_ID, conflictEtag(CONFLICT_ID, 1), {
        requestId: REQUEST_ID,
        decision: 'keep_separate',
        reasonCode: 'LEGAL_ENTITIES_DIFFER',
      }),
    ).rejects.toMatchObject({
      status: 412,
      response: { error: { code: 'IDENTITY_REVISION_CONFLICT' } },
    });
  });

  it('replays the same requestId idempotently and rejects changed content', async () => {
    let storedDecision: Record<string, unknown> | null = null;
    let storedReplay: Record<string, unknown> | null = null;
    const decisionCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      storedDecision = { id: 'decision-1', ...data };
      return storedDecision;
    });
    const outboxCreate = vi.fn(async () => ({}));
    const tx = {
      $executeRaw: async () => 1,
      $queryRaw: async () => [],
      organizationIdentityDecision: {
        findUnique: async () => storedDecision,
        create: decisionCreate,
      },
      organizationIdentityConflict: {
        findUnique: async () => ({
          id: CONFLICT_ID,
          revision: 1,
          status: 'OPEN',
          facts: { candidates: [COMPANY_ID] },
          parties: [{ companyId: COMPANY_ID }],
        }),
        update: async () => ({}),
      },
      organizationIdentityReplay: {
        findUnique: async () => storedReplay,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          storedReplay = { id: 'replay-1', ...data };
          return storedReplay;
        },
      },
      outboxEvent: { create: outboxCreate },
    };
    const service = new OrganizationIdentityService({
      withWorkspace: async (_ws: string, fn: (arg: typeof tx) => unknown) => fn(tx),
    } as never);
    const request = {
      requestId: REQUEST_ID,
      decision: 'keep_separate' as const,
      reasonCode: 'LEGAL_ENTITIES_DIFFER',
    };
    await service.decideConflict(CTX, CONFLICT_ID, conflictEtag(CONFLICT_ID, 1), request);
    await service.decideConflict(CTX, CONFLICT_ID, conflictEtag(CONFLICT_ID, 1), request);
    expect(decisionCreate).toHaveBeenCalledTimes(1);
    expect(outboxCreate).toHaveBeenCalledTimes(1);
    await expect(
      service.decideConflict(CTX, CONFLICT_ID, conflictEtag(CONFLICT_ID, 1), {
        ...request,
        note: 'different payload',
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'IDEMPOTENCY_CONFLICT' } },
    });
  });

  it('does not pretend a one-company enrichment disagreement can be merged', async () => {
    const tx = {
      $executeRaw: async () => 1,
      $queryRaw: async () => [],
      organizationIdentityDecision: { findUnique: async () => null },
      organizationIdentityConflict: {
        findUnique: async () => ({
          id: CONFLICT_ID,
          revision: 1,
          status: 'OPEN',
          facts: { source: 'company_enrichment' },
          parties: [{ companyId: COMPANY_ID }],
        }),
      },
    };
    const service = new OrganizationIdentityService({
      withWorkspace: async (_ws: string, fn: (arg: typeof tx) => unknown) => fn(tx),
    } as never);

    await expect(service.decideConflict(CTX, CONFLICT_ID, conflictEtag(CONFLICT_ID, 1), {
      requestId: REQUEST_ID,
      decision: 'merge',
      canonicalCompanyId: COMPANY_ID,
      reasonCode: 'SAME_ENTITY',
    })).rejects.toMatchObject({ status: 409 });
  });

  it('blocks merge after a candidate has a terminal commercial lead', async () => {
    const otherCompanyId = '55555555-5555-4555-8555-555555555555';
    const decisionCreate = vi.fn(async () => ({}));
    const tx = {
      $executeRaw: async () => 1,
      $queryRaw: async () => [],
      organizationIdentityDecision: { findUnique: async () => null, create: decisionCreate },
      organizationIdentityConflict: {
        findUnique: async () => ({
          id: CONFLICT_ID,
          revision: 1,
          status: 'OPEN',
          facts: {},
          parties: [{ companyId: COMPANY_ID }, { companyId: otherCompanyId }],
        }),
      },
      organizationCanonicalMapping: {
        findFirst: async () => null,
        findMany: async () => [],
      },
      lead: {
        findMany: async () => [{
          id: 'lead-1',
          icpId: 'icp-1',
          canonicalCompanyId: COMPANY_ID,
          status: 'QUALIFIED',
        }],
      },
      outboxEvent: { count: async () => 0 },
    };
    const service = new OrganizationIdentityService({
      withWorkspace: async (_ws: string, fn: (arg: typeof tx) => unknown) => fn(tx),
    } as never);

    await expect(service.decideConflict(CTX, CONFLICT_ID, conflictEtag(CONFLICT_ID, 1), {
      requestId: REQUEST_ID,
      decision: 'merge',
      canonicalCompanyId: COMPANY_ID,
      reasonCode: 'SAME_ENTITY',
    })).rejects.toMatchObject({ status: 409 });
    expect(decisionCreate).not.toHaveBeenCalled();
  });

  it('blocks split after LeadQualified was already delivered', async () => {
    const mappingId = '66666666-6666-4666-8666-666666666666';
    const decisionCreate = vi.fn(async () => ({}));
    const tx = {
      $executeRaw: async () => 1,
      $queryRaw: async () => [],
      organizationIdentityDecision: { findUnique: async () => null, create: decisionCreate },
      organizationIdentityReplay: { findFirst: async () => null },
        organizationCanonicalMapping: {
          findUnique: async () => ({
          id: mappingId,
          revision: 1,
          status: 'ACTIVE',
            sourceCompanyId: COMPANY_ID,
            canonicalCompanyId: '55555555-5555-4555-8555-555555555555',
            mergeDecision: {
              replay: { status: 'SUCCEEDED' },
              conflict: { status: 'RESOLVED' },
            },
          }),
        findMany: async () => [],
      },
      lead: {
        findMany: async () => [{
          id: 'lead-1',
          icpId: 'icp-1',
          canonicalCompanyId: COMPANY_ID,
          status: 'DISCOVERED',
        }],
      },
      outboxEvent: { count: async () => 1 },
    };
    const service = new OrganizationIdentityService({
      withWorkspace: async (_ws: string, fn: (arg: typeof tx) => unknown) => fn(tx),
    } as never);

    await expect(service.splitMapping(CTX, mappingId, mappingEtag(mappingId, 1), {
      requestId: REQUEST_ID,
      reasonCode: 'WRONG_MERGE',
    })).rejects.toMatchObject({ status: 409 });
    expect(decisionCreate).not.toHaveBeenCalled();
  });

  it('accepts a split request without making the active mapping disappear before replay succeeds', async () => {
    const mappingId = '66666666-6666-4666-8666-666666666666';
    const mappingUpdate = vi.fn(async () => ({}));
    const decisionCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'decision-1', ...data }));
    const replayCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'replay-1', ...data }));
    const outboxCreate = vi.fn(async () => ({}));
    const tx = {
      $executeRaw: async () => 1,
      $queryRaw: async () => [],
      organizationIdentityDecision: { findUnique: async () => null, create: decisionCreate },
      organizationCanonicalMapping: {
        findUnique: async () => ({
          id: mappingId,
          revision: 1,
          status: 'ACTIVE',
        sourceCompanyId: COMPANY_ID,
        canonicalCompanyId: '55555555-5555-4555-8555-555555555555',
        mergeDecision: {
          replay: { status: 'SUCCEEDED' },
          conflict: { status: 'RESOLVED' },
        },
        }),
        findMany: async () => [],
        update: mappingUpdate,
      },
      lead: { findMany: async () => [] },
      outboxEvent: { count: async () => 0, create: outboxCreate },
      organizationIdentityReplay: { findFirst: async () => null, create: replayCreate },
    };
    const service = new OrganizationIdentityService({
      withWorkspace: async (_ws: string, fn: (arg: typeof tx) => unknown) => fn(tx),
    } as never);

    await expect(service.splitMapping(CTX, mappingId, mappingEtag(mappingId, 1), {
      requestId: REQUEST_ID,
      reasonCode: 'WRONG_MERGE',
    })).resolves.toMatchObject({
      decision: { action: 'SPLIT' },
      replay: { id: 'replay-1' },
    });

    expect(mappingUpdate).not.toHaveBeenCalled();
    expect(decisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'SPLIT',
        factSnapshot: expect.objectContaining({ mappingId }),
      }),
    });
    expect(outboxCreate).toHaveBeenCalledOnce();
  });

  it('rejects split while the merge replay has not settled and creates no split history', async () => {
    const mappingId = '66666666-6666-4666-8666-666666666666';
    const decisionCreate = vi.fn(async () => ({}));
    const replayCreate = vi.fn(async () => ({}));
    const outboxCreate = vi.fn(async () => ({}));
    const tx = {
      $executeRaw: async () => 1,
      $queryRaw: async () => [],
      organizationIdentityDecision: { findUnique: async () => null, create: decisionCreate },
      organizationIdentityReplay: { findFirst: async () => null, create: replayCreate },
      organizationCanonicalMapping: {
        findUnique: async () => ({
          id: mappingId,
          revision: 1,
          status: 'ACTIVE',
          sourceCompanyId: COMPANY_ID,
          canonicalCompanyId: '55555555-5555-4555-8555-555555555555',
          mergeDecision: {
            replay: { status: 'PENDING' },
            conflict: { status: 'RESOLVING' },
          },
        }),
      },
      outboxEvent: { create: outboxCreate },
    };
    const service = new OrganizationIdentityService({
      withWorkspace: async (_ws: string, fn: (arg: typeof tx) => unknown) => fn(tx),
    } as never);

    await expect(service.splitMapping(CTX, mappingId, mappingEtag(mappingId, 1), {
      requestId: REQUEST_ID,
      reasonCode: 'WRONG_MERGE',
    })).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'IDENTITY_MERGE_PROJECTION_UNSETTLED' } },
    });
    expect(decisionCreate).not.toHaveBeenCalled();
    expect(replayCreate).not.toHaveBeenCalled();
    expect(outboxCreate).not.toHaveBeenCalled();
  });

  it('rejects a second split request while the first replay still owns the active mapping', async () => {
    const mappingId = '66666666-6666-4666-8666-666666666666';
    const decisionCreate = vi.fn(async () => ({}));
    const tx = {
      $executeRaw: async () => 1,
      $queryRaw: async () => [],
      organizationIdentityDecision: { findUnique: async () => null, create: decisionCreate },
      organizationIdentityReplay: { findFirst: async () => ({ id: 'pending-replay' }) },
      organizationCanonicalMapping: {
        findUnique: async () => ({
          id: mappingId,
          revision: 1,
          status: 'ACTIVE',
          sourceCompanyId: COMPANY_ID,
          canonicalCompanyId: '55555555-5555-4555-8555-555555555555',
          mergeDecision: {
            replay: { status: 'SUCCEEDED' },
            conflict: { status: 'RESOLVED' },
          },
        }),
      },
    };
    const service = new OrganizationIdentityService({
      withWorkspace: async (_ws: string, fn: (arg: typeof tx) => unknown) => fn(tx),
    } as never);

    await expect(service.splitMapping(CTX, mappingId, mappingEtag(mappingId, 1), {
      requestId: REQUEST_ID,
      reasonCode: 'WRONG_MERGE',
    })).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'IDENTITY_SPLIT_ALREADY_PENDING' } },
    });
    expect(decisionCreate).not.toHaveBeenCalled();
  });
});
