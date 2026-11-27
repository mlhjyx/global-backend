import type { DiscoveryRun, Prisma } from '@prisma/client';
import type { DiscoveryV3Dispatch } from '../runtime/discovery-v3-dispatch-contract';

export const DISCOVERY_V3_FINALIZATION_RESERVE_MS = 10 * 60_000;
const V3_WATCHDOG_AGE_MS = 215 * 60_000;

export function isDiscoveryV3DispatchExpired(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && now.getTime() >= expiresAt.getTime() - DISCOVERY_V3_FINALIZATION_RESERVE_MS;
}

export function discoveryV3RunMatchesDispatch(run: DiscoveryRun | null, command: DiscoveryV3Dispatch): run is DiscoveryRun {
  return Boolean(run && run.executionContractVersion === 3 && run.id === command.runId &&
    run.workspaceId === command.workspaceId && run.planId === command.planId && run.icpId === command.icpId &&
    run.v3AttemptId === command.attemptId && run.v3RequestSha256 === command.requestSha256 &&
    run.v3TaskQueue === command.taskQueue && run.v3ManufacturerRevision === (command.manufacturerNetworkRevision ?? null) &&
    run.v3DispatchExpiresAt?.toISOString() === command.dispatchExpiresAt);
}

export function discoveryV3WatchdogReason(run: DiscoveryRun, now: Date): 'DISCOVERY_V3_DISPATCH_EXPIRED' | 'DISCOVERY_RUN_STALE' | null {
  if (run.status === 'QUEUED' && isDiscoveryV3DispatchExpired(run.v3DispatchExpiresAt, now)) {
    return 'DISCOVERY_V3_DISPATCH_EXPIRED';
  }
  if (run.status === 'RUNNING' && now.getTime() - run.createdAt.getTime() >= V3_WATCHDOG_AGE_MS) {
    return 'DISCOVERY_RUN_STALE';
  }
  return null;
}

export async function readDiscoveryV3RunForUpdate(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  runId: string,
): Promise<DiscoveryRun | null> {
  await tx.$queryRaw`SELECT id FROM public.discovery_run WHERE workspace_id=${workspaceId}::uuid AND id=${runId}::uuid FOR UPDATE`;
  return tx.discoveryRun.findUnique({ where: { id: runId, workspaceId } });
}
