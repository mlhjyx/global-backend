import { describe, expect, it, vi } from 'vitest';
import { DiscoveryService } from './discovery.service';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const AUTHORITY_ID = '22222222-2222-4222-8222-222222222222';
const PLAN_ID = '33333333-3333-4333-8333-333333333333';
const ATTEMPT_ID = '66666666-6666-4666-8666-666666666666';
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

function baseTx(status: string) {
  return {
    discoveryQueryPlan: {
      findUnique: vi.fn(async () => ({ id: PLAN_ID, icpId: 'icp-1', status })),
    },
    discoveryRun: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: data.id, status: 'RUNNING', ...data })),
    },
    outboxEvent: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data) },
  };
}

describe('P1 execute 重跑：EXECUTED 计划凭新 attemptId（取代独立 rerun 端点）', () => {
  it('keeps the READY first-run path unchanged when no attempt is sent', async () => {
    const tx = baseTx('READY');
    const run = await serviceWith(tx).executePlan(CTX, PLAN_ID, 'grant');

    expect(run).toMatchObject({ status: 'RUNNING' });
    expect(tx.discoveryRun.create).toHaveBeenCalledTimes(1);
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: 'DiscoveryRunRequested', schemaVersion: 2 }),
    });
  });

  it('reruns an EXECUTED plan when a fresh attemptId is provided', async () => {
    const tx = baseTx('EXECUTED');
    const run = await serviceWith(tx).executePlan(CTX, PLAN_ID, 'grant', undefined, ATTEMPT_ID);

    expect(run).toMatchObject({ status: 'RUNNING' });
    expect(tx.discoveryRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ workspaceId: WORKSPACE_ID, planId: PLAN_ID }),
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: 'DiscoveryRunRequested', schemaVersion: 2 }),
    });
  });

  it('rejects an EXECUTED plan without an attemptId with RERUN_REQUIRES_ATTEMPT and creates nothing', async () => {
    const tx = baseTx('EXECUTED');

    await expect(serviceWith(tx).executePlan(CTX, PLAN_ID, 'grant')).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'RERUN_REQUIRES_ATTEMPT' } },
    });
    expect(tx.discoveryRun.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('still rejects a DRAFT plan even when an attemptId is provided', async () => {
    const tx = baseTx('DRAFT');

    await expect(
      serviceWith(tx).executePlan(CTX, PLAN_ID, 'grant', undefined, ATTEMPT_ID),
    ).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'INVALID_STATE' } },
    });
    expect(tx.discoveryRun.create).not.toHaveBeenCalled();
  });
});
