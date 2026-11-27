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

function baseTx(status: string, fenced = false) {
  return {
    $queryRaw: vi.fn()
      .mockResolvedValueOnce([{ id: PLAN_ID }])
      .mockResolvedValueOnce([{ fenced }]),
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

  it('rejects a legacy admission for a plan already bound to v3 before consuming the Grant', async () => {
    const tx = baseTx('READY', true);
    const service = serviceWith(tx);

    await expect(service.executePlan(CTX, PLAN_ID, 'grant')).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'DISCOVERY_LEGACY_ADMISSION_CLOSED' } },
    });
    expect(service['authority'].consumeVerifiedWorkspaceGrantInTransaction).not.toHaveBeenCalled();
    expect(tx.discoveryRun.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });
});

describe('manufacturer execution snapshot admission',()=>{
  it.each(['manufacturer-network/v1','manufacturer-network/v2'] as const)('uses %s and original attempt in Grant scope and outbox snapshot',async(revision)=>{
    const tx=baseTx('READY');const svc=serviceWith(tx);
    await svc.executePlan(CTX,PLAN_ID,'grant',undefined,ATTEMPT_ID,revision);
    const request=await import('../execution-budget/execution-budget-request-scope');
    expect(svc['authority'].verifyWorkspaceGrant).toHaveBeenCalledWith(expect.objectContaining({scope:request.workspaceExecutionBudgetRequestScope({operation:'POST /query-plans/:planId/execute',planId:PLAN_ID,body:{attemptId:ATTEMPT_ID,manufacturerNetworkRevision:revision}})}));
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({data:expect.objectContaining({payload:expect.objectContaining({manufacturerNetworkExecution:{schemaVersion:'manufacturer-network-execution/v1',planId:PLAN_ID,body:{attemptId:ATTEMPT_ID,manufacturerNetworkRevision:revision}}})})});
  });
  it('leaves old outbox commands without a new feature snapshot',async()=>{
    const tx=baseTx('READY');await serviceWith(tx).executePlan(CTX,PLAN_ID,'grant');
    expect((tx.outboxEvent.create.mock.calls[0]![0] as {data:{payload:object}}).data.payload).not.toHaveProperty('manufacturerNetworkExecution');
  });
});
