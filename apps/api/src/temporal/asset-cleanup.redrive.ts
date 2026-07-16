import {
  AssetCleanupCommand,
  assetCleanupPayload,
  parseAssetCleanupCommand,
} from './asset-cleanup.contract';
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

function shallowEqual(left: unknown, right: Record<string, unknown>): boolean {
  if (!left || typeof left !== 'object' || Array.isArray(left)) return false;
  const record = left as Record<string, unknown>;
  const leftKeys = Object.keys(record).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && record[key] === right[key])
  );
}

/** Fail-closed validation shared by the operator script and its tests. */
export function validateAssetCleanupRedriveEvent(
  event: AssetCleanupRedriveEvent,
): AssetCleanupCommand {
  if (
    event.eventType !== 'AssetObjectCleanupRequested' ||
    event.schemaVersion !== 1 ||
    event.aggregateType !== 'Asset'
  ) {
    throw new Error('event is not a supported asset cleanup command');
  }
  const payload = event.payload as Record<string, unknown> | null;
  const command = parseAssetCleanupCommand({
    eventId: event.eventId,
    workspaceId: event.workspaceId,
    assetId: event.aggregateId,
    siteId: payload?.siteId,
    objectKey: payload?.objectKey,
    objectClass: payload?.objectClass,
    reason: payload?.reason,
    notBefore: payload?.notBefore,
  });
  if (payload?.assetId !== event.aggregateId || !shallowEqual(payload, assetCleanupPayload(command))) {
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
    const command = validateAssetCleanupRedriveEvent(event);
    const previousStatus = await input.executionStatus();
    assertAssetCleanupRedrivable(previousStatus);

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
