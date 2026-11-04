import { describe, expect, it, vi } from 'vitest';
import { DiscoveryService } from './discovery.service';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const AUTHORITY_ID = '22222222-2222-4222-8222-222222222222';
const PLAN_ID = '33333333-3333-4333-8333-333333333333';
const TASK_ID = '44444444-4444-4444-8444-444444444444';
const TASK_RUN_ID = '55555555-5555-4555-8555-555555555555';
const CTX = { workspaceId: WORKSPACE_ID, userId: 'user-1', roles: [] } as never;

function serviceWith(tx: Record<string, unknown>) {
  const binding = {
    authorityId: AUTHORITY_ID,
    replay: false,
    scopeKey: WORKSPACE_ID,
    accountKey: `discovery.run:discovery_run:request:${'c'.repeat(64)}:${'c'.repeat(64)}`,
    purpose: 'discovery.run' as const,
    subjectType: 'discovery_run',
    subjectId: `request:${'c'.repeat(64)}`,
    requestSha256: 'c'.repeat(64),
  };
  const authority = {
    verifyWorkspaceGrant: vi.fn(async () => ({})),
    consumeVerifiedWorkspaceGrantInTransaction: vi.fn(async () => binding),
  };
  const prisma = {
    withWorkspace: vi.fn(async (_workspaceId: string, callback: (client: unknown) => Promise<unknown>) =>
      callback(tx),
    ),
  };
  return new DiscoveryService(prisma as never, {} as never, authority as never);
}

function baseTx(overrides: Record<string, unknown> = {}) {
  return {
    discoveryQueryPlan: {
      findUnique: vi.fn(async () => ({ id: PLAN_ID, icpId: 'icp-1', status: 'READY' })),
    },
    discoveryRun: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: data.id, status: 'RUNNING', ...data })) },
    outboxEvent: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data) },
    ...overrides,
  };
}

describe('M0② executePlan taskRef 透传', () => {
  it('stores the task reference on the run and the DiscoveryRunRequested payload', async () => {
    const tx = baseTx();
    const run = await serviceWith(tx).executePlan(CTX, PLAN_ID, 'grant', {
      taskId: TASK_ID,
      taskRunId: TASK_RUN_ID,
    });

    expect(run).toMatchObject({ status: 'RUNNING' });
    expect(tx.discoveryRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        planId: PLAN_ID,
        taskRef: { taskId: TASK_ID, taskRunId: TASK_RUN_ID },
      }),
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'DiscoveryRunRequested',
        payload: expect.objectContaining({
          taskRef: { taskId: TASK_ID, taskRunId: TASK_RUN_ID },
        }),
      }),
    });
  });

  it('omits the field entirely when the caller sends no task reference (old callers)', async () => {
    const tx = baseTx();
    await serviceWith(tx).executePlan(CTX, PLAN_ID, 'grant');

    const data = tx.discoveryRun.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty('taskRef');
    const payload = tx.outboxEvent.create.mock.calls[0]![0].data.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty('taskRef');
  });

  it('rejects a malformed task reference before any grant consumption', async () => {
    const tx = baseTx();
    const service = serviceWith(tx);
    const authority = (service as unknown as { authority: { consumeVerifiedWorkspaceGrantInTransaction: ReturnType<typeof vi.fn> } }).authority;

    await expect(
      service.executePlan(CTX, PLAN_ID, 'grant', { taskId: 'not-a-uuid', taskRunId: TASK_RUN_ID }),
    ).rejects.toMatchObject({
      status: 400,
      response: { error: { code: 'TASK_REF_INVALID' } },
    });
    expect(authority.consumeVerifiedWorkspaceGrantInTransaction).not.toHaveBeenCalled();
    expect(tx.discoveryRun.create).not.toHaveBeenCalled();
  });
});
