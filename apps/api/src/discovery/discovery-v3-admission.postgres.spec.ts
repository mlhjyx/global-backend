import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { discoveryV3Attempt, discoveryV3RequestSha256 } from '../auth/discovery-v3-admission-contract';
import { parseDiscoveryV3Dispatch } from '../runtime/discovery-v3-dispatch-contract';
import { formatTenantWorkflowId } from '../temporal/tenant-workflow-id';
import { claimDiscoveryV3Dispatch } from '../temporal/discovery-v3.worker-activities';
import { admitDiscoveryV3 } from './discovery-v3-admission';
import { DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_VERSION } from './discovery-company-materialization-ctx';

const adminUrl = process.env.DISCOVERY_V3_TEST_ADMIN_URL;
const relayUrl = process.env.DISCOVERY_V3_TEST_RELAY_URL;
const enabled = Boolean(adminUrl && relayUrl && process.env.APP_DATABASE_URL);

describe.skipIf(!enabled)('discovery v3 PostgreSQL admission and Worker fencing', () => {
  it('admits one run, replays the same intent, verifies Relay role and claims the Worker dispatch once', async () => {
    const owner = new PrismaClient({ datasourceUrl: adminUrl });
    const relay = new PrismaClient({ datasourceUrl: relayUrl });
    const app = new PrismaService();
    try {
      const workspaceId = randomUUID();
      const ctx = { workspaceId, userId: randomUUID(), roles: ['saas-admin'] };
      await owner.workspace.create({ data: { id: workspaceId, name: 'V3 admission fixture' } });
      const company = await owner.companyProfile.create({ data: { workspaceId, name: 'Test seller' } });
      const icp = await owner.icpDefinition.create({ data: { workspaceId, companyId: company.id, name: 'Test ICP' } });
      const makePlan = () => owner.discoveryQueryPlan.create({ data: {
        workspaceId, icpId: icp.id, status: 'READY', queries: [],
      } });
      const plan = await makePlan();
      const options = { taskQueue: 'batch-discovery', runtime: { readyForNewAdmission: async () => true } };
      await expect(admitDiscoveryV3(app, ctx, plan.id, {}, { taskQueue: 'batch-discovery' }))
        .rejects.toMatchObject({ response: { error: { code: 'RUNTIME_ADMISSION_CLOSED' } } });
      await expect(owner.discoveryRun.count({ where: { workspaceId } })).resolves.toBe(0);
      const attemptId = discoveryV3Attempt(workspaceId, plan.id);
      const task = { taskId: randomUUID(), taskRunId: randomUUID() };
      const requestSha256 = discoveryV3RequestSha256({ workspaceId, actorId: ctx.userId, planId: plan.id, attemptId, task });
      const claim = { ...task, workspaceId, planId: plan.id, attemptId, requestSha256, expectedIcpId: icp.id };
      await expect(admitDiscoveryV3(app, { ...ctx, discoveryV3Task: { ...claim, expectedIcpId: randomUUID() } }, plan.id, {}, options))
        .rejects.toMatchObject({ response: { error: { code: 'DISCOVERY_V3_TASK_BINDING_MISMATCH' } } });
      const caller = { ...ctx, discoveryV3Task: claim };
      const replies = await Promise.all([
        admitDiscoveryV3(app, caller, plan.id, {}, options),
        admitDiscoveryV3(app, caller, plan.id, {}, options),
      ]);
      expect(replies[0].runId).toBe(replies[1].runId);
      expect(replies.map((row) => row.replayed).sort()).toEqual([false, true]);
      await expect(admitDiscoveryV3(app, caller, plan.id, {}, { taskQueue: 'understanding' }))
        .resolves.toMatchObject({ runId: replies[0].runId, status: 'QUEUED', replayed: true });
      await expect(admitDiscoveryV3(app, ctx, plan.id, {}, options))
        .rejects.toMatchObject({ response: { error: { code: 'DISCOVERY_ATTEMPT_REQUEST_CONFLICT' } } });
      await expect(admitDiscoveryV3(app, { ...ctx, workspaceId: randomUUID() }, plan.id, {}, options))
        .rejects.toMatchObject({ response: { error: { code: 'NOT_FOUND' } } });

      const events = await owner.outboxEvent.findMany({ where: { workspaceId, eventType: 'DiscoveryRunRequested' } });
      expect(events).toHaveLength(1);
      expect(events[0].schemaVersion).toBe(3);
      expect(events[0].payload).not.toHaveProperty('executionBudget');
      const command = parseDiscoveryV3Dispatch(events[0].payload);
      const [proof] = await relay.$queryRaw<Array<{ admitted: boolean }>>`
        SELECT public.attest_discovery_v3_outbox(${events[0].eventId}::uuid) AS admitted
      `;
      expect(proof.admitted).toBe(true);
      await expect(relay.discoveryRun.count()).rejects.toThrow();
      const workflowId = formatTenantWorkflowId(workspaceId, 'discovery', command.runId);
      await expect(claimDiscoveryV3Dispatch(app, command, 'wrong-workflow-id', true)).rejects.toMatchObject({
        type: 'DISCOVERY_V3_WRONG_WORKFLOW',
      });
      await expect(claimDiscoveryV3Dispatch(app, command, workflowId, false)).rejects.toMatchObject({
        type: 'DISCOVERY_V3_EXECUTOR_UNAVAILABLE',
      });
      const workerResults = await Promise.all([
        claimDiscoveryV3Dispatch(app, command, workflowId, true),
        claimDiscoveryV3Dispatch(app, command, workflowId, true),
      ]);
      expect(workerResults.sort()).toEqual([false, true]);
      expect(await owner.discoveryRun.findUniqueOrThrow({ where: { id: command.runId } }))
        .toMatchObject({ status: 'RUNNING', v3WorkerAcceptedAt: expect.any(Date) });

      const interruptedPlan = await makePlan();
      const failingStore = {
        withWorkspace: <T>(id: string, work: (tx: Prisma.TransactionClient) => Promise<T>) =>
          app.withWorkspace(id, (tx) => work(new Proxy(tx, {
            get(target, property, receiver) {
              if (property === 'outboxEvent') return { create: async () => { throw new Error('test aborted outbox insert'); } };
              return Reflect.get(target, property, receiver);
            },
          }))),
      };
      await expect(admitDiscoveryV3(failingStore, ctx, interruptedPlan.id, {}, options))
        .rejects.toThrow('test aborted outbox insert');
      await expect(owner.discoveryRun.count({ where: { workspaceId, planId: interruptedPlan.id } })).resolves.toBe(0);

      const expiredPlan = await makePlan();
      const now = new Date();
      const expiringAttempt = discoveryV3Attempt(workspaceId, expiredPlan.id);
      const expirySha = discoveryV3RequestSha256({ workspaceId, actorId: ctx.userId, planId: expiredPlan.id, attemptId: expiringAttempt });
      const expired = await owner.discoveryRun.create({ data: {
        workspaceId, planId: expiredPlan.id, icpId: icp.id, status: 'QUEUED', executionContractVersion: 3,
        materializationContractVersion: DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_VERSION,
        v3AttemptId: expiringAttempt, v3RequestSha256: expirySha, v3TaskQueue: 'batch-discovery',
        v3RequestedBy: ctx.userId, v3FirstAdmission: true,
        v3AdmittedAt: new Date(now.getTime() - 180 * 60_000), v3DispatchExpiresAt: now,
      } });
      const expiredCommand = parseDiscoveryV3Dispatch({
        executionContractVersion: 3, workspaceId, runId: expired.id, planId: expiredPlan.id,
        icpId: icp.id, attemptId: expiringAttempt, requestSha256: expirySha,
        taskQueue: 'batch-discovery', dispatchExpiresAt: now.toISOString(),
      });
      const expiredWorkflowId = formatTenantWorkflowId(workspaceId, 'discovery', expired.id);
      await expect(claimDiscoveryV3Dispatch(app, expiredCommand, expiredWorkflowId, true)).resolves.toBe(false);
      await expect(claimDiscoveryV3Dispatch(app, expiredCommand, expiredWorkflowId, true)).resolves.toBe(false);
      const completions = await owner.outboxEvent.findMany({ where: { aggregateId: expired.id, eventType: 'DiscoveryRunCompleted' } });
      expect(completions).toHaveLength(1);
      expect(completions[0].payload).toMatchObject({ executionContractVersion: 3, status: 'FAILED', cost: 0 });
    } finally {
      await Promise.all([owner.$disconnect(), relay.$disconnect(), app.onModuleDestroy()]);
    }
  }, 60_000);
});
