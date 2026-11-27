import { ConflictException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { TemporalClient } from '../temporal/temporal.client';
import { cancelTenantOrLegacyWorkflow } from '../temporal/tenant-workflow-id';
import { cancelQueuedDiscoveryV3 } from './discovery-v3-terminal';

export async function cancelDiscoveryRun(
  prisma: Pick<PrismaService, 'withWorkspace'>, temporal: TemporalClient | undefined, workspaceId: string, runId: string,
) {
  const run = await prisma.withWorkspace(workspaceId, (tx) =>
    tx.discoveryRun.findUnique({ where: { id: runId }, select: { id: true, status: true, executionContractVersion: true } }),
  );
  if (!run) {
    throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'run not found' } });
  }
  if (!['RUNNING', 'QUEUED'].includes(run.status)) return { runId: run.id, status: run.status };
  if (run.executionContractVersion === 3 && run.status === 'QUEUED') {
    const status = await cancelQueuedDiscoveryV3(prisma, workspaceId, run.id);
    if (status !== 'RUNNING') return { runId: run.id, status };
  }
  if (!temporal) {
    throw new ConflictException({
      error: { code: 'TEMPORAL_UNAVAILABLE', message: 'temporal client is not connected' },
    });
  }
  await cancelTenantOrLegacyWorkflow(temporal.client.workflow, workspaceId, 'discovery', runId);
  return { runId: run.id, status: 'CANCEL_REQUESTED' };
}
