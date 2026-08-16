import { describe, expect, it, vi } from 'vitest';
import { createQualifyActivities } from './qualify.activities';

vi.mock('../discovery/organization-identity-root', () => ({
  organizationMayUseExternalProcessing: vi.fn(async () => true),
}));

function company() {
  return {
    id: 'company-1',
    name: 'Acme GmbH',
    domain: 'acme.example',
    country: 'DE',
    industry: 'manufacturing',
    employeeCount: 50,
    revenueUsd: null,
    attributes: {},
    status: 'NEW',
    contacts: [],
    identityCanonicalMappings: [],
  };
}

function harness(existing: { id: string; status: string; fitVerdict: string | null } | null) {
  const leadUpdate = vi.fn(async () => ({}));
  const leadUpsert = vi.fn(async () => ({}));
  const outboxCreate = vi.fn(async () => ({}));
  const tx = {
    icpDefinition: {
      findUnique: vi.fn(async () => ({
        id: 'icp-1',
        status: 'ACTIVE',
        rules: [],
        roles: [],
        triggerSignals: [],
      })),
    },
    canonicalCompany: { findMany: vi.fn(async () => [company()]) },
    lead: {
      findFirst: vi.fn(async () => existing),
      update: leadUpdate,
      upsert: leadUpsert,
    },
    outboxEvent: { create: outboxCreate },
  };
  const prisma = {
    withWorkspace: async <T>(_workspaceId: string, fn: (client: typeof tx) => Promise<T>): Promise<T> => fn(tx),
  };
  return {
    activities: createQualifyActivities({ prisma } as never),
    leadUpdate,
    leadUpsert,
    outboxCreate,
  };
}

describe('scoreCandidates qualification boundary', () => {
  it('does not create a Lead for a discovered company that has no fit judgment', async () => {
    const h = harness(null);

    await expect(h.activities.scoreCandidates({ workspaceId: 'ws-1', icpId: 'icp-1' })).resolves.toEqual({
      scored: 0,
      queues: { recommended: 0, needs_review: 0, rejected: 0, suppressed: 0, sanctions_hold: 0 },
    });

    expect(h.leadUpdate).not.toHaveBeenCalled();
    expect(h.leadUpsert).not.toHaveBeenCalled();
    expect(h.outboxCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ payload: { scored: 0, queues: expect.any(Object) } }),
    });
  });

  it('scores and updates an existing Lead only after fit has been judged', async () => {
    const h = harness({ id: 'lead-1', status: 'DISCOVERED', fitVerdict: 'match' });

    const result = await h.activities.scoreCandidates({ workspaceId: 'ws-1', icpId: 'icp-1' });

    expect(result.scored).toBe(1);
    expect(h.leadUpdate).toHaveBeenCalledOnce();
    expect(h.leadUpsert).not.toHaveBeenCalled();
  });

  it('replays the committed result for the same activity execution without rescoring or duplicating LeadsScored', async () => {
    const existing = { id: 'lead-1', status: 'DISCOVERED', fitVerdict: 'match', version: 1 };
    const storedIdempotency = new Map<string, { requestHash: string | null; response: unknown }>();
    const leadUpdate = vi.fn(async () => {
      existing.version += 1;
      return existing;
    });
    let failFinalization = true;
    const outboxCreate = vi.fn(async () => {
      if (failFinalization) throw new Error('outbox temporarily unavailable');
      return {};
    });
    const tx = {
      icpDefinition: {
        findUnique: vi.fn(async () => ({
          id: 'icp-1',
          status: 'ACTIVE',
          rules: [],
          roles: [],
          triggerSignals: [],
        })),
      },
      canonicalCompany: { findMany: vi.fn(async () => [company()]) },
      lead: {
        findFirst: vi.fn(async () => existing),
        update: leadUpdate,
      },
      idempotencyKey: {
        findUnique: vi.fn(async ({ where }: { where: { workspaceId_endpoint_key: { key: string } } }) =>
          storedIdempotency.get(where.workspaceId_endpoint_key.key) ?? null),
        create: vi.fn(async ({ data }: { data: { key: string; requestHash: string; response: unknown } }) => {
          storedIdempotency.set(data.key, { requestHash: data.requestHash, response: data.response });
          return data;
        }),
      },
      outboxEvent: { create: outboxCreate },
    };
    const prisma = {
      withWorkspace: async <T>(_workspaceId: string, fn: (client: typeof tx) => Promise<T>): Promise<T> => fn(tx),
    };
    let activityExecutionKey = 'workflow-run-1:scoreCandidates-1';
    const activities = createQualifyActivities({
      prisma,
      activityExecutionKey: () => activityExecutionKey,
    } as never);

    await expect(
      activities.scoreCandidates({ workspaceId: 'ws-1', icpId: 'icp-1' }),
    ).rejects.toThrow('outbox temporarily unavailable');
    expect(existing.version).toBe(2);
    expect(leadUpdate).toHaveBeenCalledTimes(1);

    failFinalization = false;
    const first = await activities.scoreCandidates({ workspaceId: 'ws-1', icpId: 'icp-1' });
    const replayed = await activities.scoreCandidates({ workspaceId: 'ws-1', icpId: 'icp-1' });

    expect(replayed).toEqual(first);
    expect(existing.version).toBe(2);
    expect(leadUpdate).toHaveBeenCalledTimes(1);
    expect(outboxCreate).toHaveBeenCalledTimes(2);

    await expect(
      activities.scoreCandidates({ workspaceId: 'ws-1', icpId: 'icp-1', batchSize: 10 }),
    ).rejects.toThrow('activity execution key was reused with different input');
    expect(existing.version).toBe(2);
    expect(outboxCreate).toHaveBeenCalledTimes(2);

    activityExecutionKey = 'workflow-run-2:scoreCandidates-1';
    await activities.scoreCandidates({ workspaceId: 'ws-1', icpId: 'icp-1' });

    expect(existing.version).toBe(3);
    expect(leadUpdate).toHaveBeenCalledTimes(2);
    expect(outboxCreate).toHaveBeenCalledTimes(3);
  });
});
