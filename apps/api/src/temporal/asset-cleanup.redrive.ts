import {
  AssetCleanupCommand,
  assetCleanupPayload,
  parseAssetCleanupCommand,
} from './asset-cleanup.contract';

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

