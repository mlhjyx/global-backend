export const ASSET_CLEANUP_REASONS = [
  'commit_succeeded',
  'asset_deleted',
  'rejected',
  'duplicate',
] as const;

export type AssetCleanupReason = (typeof ASSET_CLEANUP_REASONS)[number];

export interface AssetCleanupCommand {
  eventId: string;
  workspaceId: string;
  siteId: string;
  assetId: string;
  objectKey: string;
  objectClass: 'staging';
  reason: AssetCleanupReason;
  notBefore: string;
}

export class AssetCleanupContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetCleanupContractError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMAND_KEYS = [
  'eventId',
  'workspaceId',
  'siteId',
  'assetId',
  'objectKey',
  'objectClass',
  'reason',
  'notBefore',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new AssetCleanupContractError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

/** Strict fail-closed command parser shared by relay, workflow and activity. */
export function parseAssetCleanupCommand(value: unknown): AssetCleanupCommand {
  if (!isRecord(value)) throw new AssetCleanupContractError('cleanup command must be an object');
  const unknownKeys = Object.keys(value).filter(
    (key) => !(COMMAND_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new AssetCleanupContractError(`cleanup command has unknown fields: ${unknownKeys.join(',')}`);
  }

  const eventId = requireUuid(value.eventId, 'eventId');
  const workspaceId = requireUuid(value.workspaceId, 'workspaceId');
  const siteId = requireUuid(value.siteId, 'siteId');
  const assetId = requireUuid(value.assetId, 'assetId');
  if (value.objectClass !== 'staging') {
    throw new AssetCleanupContractError('only staging cleanup is executable before MF-0');
  }
  if (
    typeof value.reason !== 'string' ||
    !(ASSET_CLEANUP_REASONS as readonly string[]).includes(value.reason)
  ) {
    throw new AssetCleanupContractError('invalid cleanup reason');
  }
  const expectedKey = `ws/${workspaceId}/${siteId}/uploads/${assetId}`;
  if (value.objectKey !== expectedKey) {
    throw new AssetCleanupContractError('staging object key does not match command provenance');
  }
  if (typeof value.notBefore !== 'string') {
    throw new AssetCleanupContractError('notBefore must be an ISO timestamp');
  }
  const notBeforeMs = Date.parse(value.notBefore);
  if (!Number.isFinite(notBeforeMs) || new Date(notBeforeMs).toISOString() !== value.notBefore) {
    throw new AssetCleanupContractError('notBefore must be a canonical ISO timestamp');
  }

  return {
    eventId,
    workspaceId,
    siteId,
    assetId,
    objectKey: expectedKey,
    objectClass: 'staging',
    reason: value.reason as AssetCleanupReason,
    notBefore: value.notBefore,
  };
}

export function assetCleanupPayload(command: AssetCleanupCommand): Record<string, unknown> {
  return {
    assetId: command.assetId,
    siteId: command.siteId,
    objectKey: command.objectKey,
    objectClass: command.objectClass,
    reason: command.reason,
    notBefore: command.notBefore,
  };
}

export function matchesAssetCleanupPayload(
  value: unknown,
  command: AssetCleanupCommand,
): boolean {
  if (!isRecord(value)) return false;
  const expected = assetCleanupPayload(command);
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every(
      (key, index) => key === expectedKeys[index] && value[key] === expected[key],
    )
  );
}
