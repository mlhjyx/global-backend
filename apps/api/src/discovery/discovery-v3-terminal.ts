import type { DiscoveryRun, Prisma } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { parseDiscoveryV3TaskClaim } from '../auth/discovery-v3-admission-contract';
import { projectDiscoveryCompletedStats } from '../temporal/discovery-run-final-stats';
import { appendRunEvent } from './run2/run-events';
import { parkDiscoveryV3OpenOperations } from './discovery-v3-operations';
import { readDiscoveryV3RunForUpdate } from './discovery-v3-run-state';

export { discoveryV3WatchdogReason, readDiscoveryV3RunForUpdate } from './discovery-v3-run-state';

export function cancelQueuedDiscoveryV3(
  prisma: Pick<PrismaService, 'withWorkspace'>, workspaceId: string, runId: string,
): Promise<string> {
  return prisma.withWorkspace(workspaceId, async (tx) => {
    const run = await readDiscoveryV3RunForUpdate(tx, workspaceId, runId);
    if (!run) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'run not found' } });
    if (run.status !== 'QUEUED') return run.status;
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT statement_timestamp()::timestamptz(3) AS now`;
    await finalizeDiscoveryV3(tx, run, clock.now, 'CANCELLED', 'DISCOVERY_V3_CANCELLED_BEFORE_DISPATCH');
    return 'CANCELLED';
  });
}

export async function finalizeDiscoveryV3(
  tx: Prisma.TransactionClient,
  run: DiscoveryRun,
  now: Date,
  status: 'DONE' | 'PARTIAL' | 'FAILED' | 'CANCELLED',
  reason?: string,
  summary?: Prisma.InputJsonObject,
): Promise<boolean> {
  if (run.executionContractVersion !== 3 || (run.status !== 'QUEUED' && run.status !== 'RUNNING')) return false;
  const binding = run.taskRef ? parseDiscoveryV3TaskClaim(run.taskRef) : null;
  const priorStats = run.stats && typeof run.stats === 'object' && !Array.isArray(run.stats) ? run.stats : {};
  const completed = status === 'DONE' || status === 'PARTIAL';
  if (completed && run.status !== 'RUNNING') return false;
  const stage = run.status === 'QUEUED' ? 'admission' : reason === 'DISCOVERY_RUN_STALE' ? 'watchdog' : 'execution';
  const stats = { ...priorStats, ...summary, ...(reason ? { failure: { stage, errorType: reason } } : {}) } as Prisma.InputJsonObject;
  const result = await tx.discoveryRun.updateMany({
    where: { id: run.id, workspaceId: run.workspaceId, status: run.status, executionContractVersion: 3 },
    data: { status, stats, completedAt: now },
  });
  if (!result.count) return false;
  if (completed) {
    await tx.discoveryQueryPlan.updateMany({
      where: { id: run.planId, workspaceId: run.workspaceId, status: 'READY' },
      data: { status: 'EXECUTED', version: { increment: 1 } },
    });
  }

  let cost = 0;
  if (run.v3WorkerAcceptedAt) {
    await parkDiscoveryV3OpenOperations(tx, { workspaceId: run.workspaceId, runId: run.id }, now);
    const [sum] = await tx.$queryRaw<Array<{ cost: number }>>`
      SELECT COALESCE(SUM(cost_usd), 0)::double precision AS cost
      FROM public.usage_ledger WHERE workspace_id=${run.workspaceId}::uuid
        AND ref_type='ai_trace' AND meta->>'runId'=${run.id}
    `;
    if (sum && Number.isFinite(sum.cost) && sum.cost >= 0) cost = sum.cost;
  }
  await appendRunEvent(tx as never, {
    workspaceId: run.workspaceId, runId: run.id, type: 'run_finished', payload: { status, ...(reason ? { reason } : {}) },
  });
  await tx.outboxEvent.create({ data: {
    workspaceId: run.workspaceId, eventType: 'DiscoveryRunCompleted', schemaVersion: 1,
    aggregateType: 'DiscoveryRun', aggregateId: run.id,
    payload: {
      executionContractVersion: 3, executionOrigin: binding ? 'SAAS_TASK' : 'DIRECT',
      planId: run.planId, icpId: run.icpId, status,
      stats: projectDiscoveryCompletedStats(stats) as Prisma.InputJsonObject,
      cost, costBasis: 'usage_ledger-runid/v1',
      ...(binding ? { taskRef: {
        taskId: binding.taskId, taskRunId: binding.taskRunId, workspaceId: binding.workspaceId,
        planId: binding.planId, attemptId: binding.attemptId, requestSha256: binding.requestSha256,
      } } : {}),
    },
  } });
  return true;
}
