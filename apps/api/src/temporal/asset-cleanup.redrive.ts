import { AssetCleanupCommand, matchesAssetCleanupPayload, parseAssetCleanupCommand } from './asset-cleanup.contract';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

export interface AssetCleanupRedriveEvent {
  eventId: string;
  workspaceId: string;
  eventType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  publishedAt: Date | null;
  parkedAt: Date | null;
}
export type CleanupExecutionStatus =
  | 'NOT_FOUND'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TERMINATED'
  | 'TIMED_OUT'
  | 'CONTINUED_AS_NEW'
  | 'PAUSED'
  | 'UNKNOWN';

const REDRIVABLE_STATUSES: ReadonlySet<CleanupExecutionStatus> = new Set([
  'NOT_FOUND',
  'FAILED',
  'CANCELLED',
  'TERMINATED',
  'TIMED_OUT',
]);

/** Fail-closed validation shared by the operator script and its tests. */
export function validateAssetCleanupRedriveEvent(event: AssetCleanupRedriveEvent): AssetCleanupCommand {
  if (
    event.eventType !== 'AssetObjectCleanupRequested' ||
    ![1, 2].includes(event.schemaVersion) ||
    event.aggregateType !== 'Asset'
  ) {
    throw new Error('event is not a supported asset cleanup command');
  }
  const payload = event.payload as Record<string, unknown> | null;
  if (
    (payload?.objectClass === 'staging' && event.schemaVersion !== 1) ||
    (payload?.objectClass === 'canonical' && event.schemaVersion !== 2)
  ) {
    throw new Error('cleanup event schemaVersion does not match objectClass');
  }
  const command = parseAssetCleanupCommand({
    eventId: event.eventId,
    workspaceId: event.workspaceId,
    assetId: event.aggregateId,
    siteId: payload?.siteId,
    objectClass: payload?.objectClass,
    reason: payload?.reason,
    ...(payload?.objectClass === 'staging'
      ? { objectKey: payload?.objectKey, notBefore: payload?.notBefore }
      : { canonical: payload?.canonical, variants: payload?.variants }),
  });
  if (payload?.assetId !== event.aggregateId || !matchesAssetCleanupPayload(payload, command)) {
    throw new Error('cleanup event payload does not exactly match its aggregate provenance');
  }
  return command;
}

export function assertAssetCleanupRedrivable(status: CleanupExecutionStatus): void {
  if (!REDRIVABLE_STATUSES.has(status)) {
    throw new Error(`cleanup execution status ${status} is not redrivable`);
  }
}

export async function queueAssetCleanupRedrive(input: {
  prisma: PrismaService;
  workspaceId: string;
  eventId: string;
  executionStatus: () => Promise<CleanupExecutionStatus>;
}): Promise<{ command: AssetCleanupCommand; previousStatus: CleanupExecutionStatus }> {
  // Temporal describe is external I/O; keep it outside the short RLS transaction. Terminal
  // statuses are immutable, and the pending-event check below prevents double requeue.
  const previousStatus = await input.executionStatus();
  assertAssetCleanupRedrivable(previousStatus);
  return input.prisma.withWorkspace(input.workspaceId, async (tx) => {
    const lock = await tx.$queryRaw<{ locked: boolean }[]>(Prisma.sql`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${input.eventId}, 0)) AS locked
    `);
    if (!lock[0]?.locked) throw new Error('cleanup redrive is already being operated');

    const event = await tx.outboxEvent.findUnique({
      where: { eventId: input.eventId },
      select: {
        id: true,
        eventId: true,
        workspaceId: true,
        eventType: true,
        schemaVersion: true,
        aggregateType: true,
        aggregateId: true,
        payload: true,
        publishedAt: true,
        parkedAt: true,
      },
    });
    if (!event) throw new Error('cleanup event is not visible in the requested workspace');
    if (event.publishedAt === null && event.parkedAt === null) {
      throw new Error('cleanup event is already queued for relay');
    }
    const command = validateAssetCleanupRedriveEvent(event);

    const moved = await tx.outboxEvent.updateMany({
      where: {
        id: event.id,
        eventId: event.eventId,
        workspaceId: event.workspaceId,
        eventType: 'AssetObjectCleanupRequested',
        publishedAt: event.publishedAt,
        parkedAt: event.parkedAt,
      },
      data: { publishedAt: null, parkedAt: null },
    });
    if (moved.count !== 1) throw new Error('cleanup event changed before redrive CAS');
    return { command, previousStatus };
  });
}
