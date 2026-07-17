export const ASSET_CLEANUP_REASONS = ['commit_succeeded', 'asset_deleted', 'rejected', 'duplicate'] as const;

export type AssetCleanupReason = (typeof ASSET_CLEANUP_REASONS)[number];

interface AssetCleanupCommandBase {
  eventId: string;
  workspaceId: string;
  siteId: string;
  assetId: string;
  reason: AssetCleanupReason;
}

export interface StagingAssetCleanupCommand extends AssetCleanupCommandBase {
  objectKey: string;
  objectClass: 'staging';
  notBefore: string;
}

export interface CanonicalCleanupObject {
  objectKey: string;
  contentHash: string;
}

export interface CanonicalCleanupVariant {
  id: string;
  objectKey: string;
  contentHash: string | null;
  recipeHash: string;
  sourceVariantId: string | null;
  status: 'ready' | 'failed';
}

export interface CanonicalAssetCleanupCommand extends AssetCleanupCommandBase {
  objectClass: 'canonical';
  reason: 'asset_deleted';
  canonical: CanonicalCleanupObject;
  variants: CanonicalCleanupVariant[];
}

export type AssetCleanupCommand = StagingAssetCleanupCommand | CanonicalAssetCleanupCommand;

export class AssetCleanupContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetCleanupContractError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
// A cleanup performs Delete+HEAD twice and then a leaf-to-root DB settle. Keep the accepted plan
// within the proven Temporal/transaction budget; M1-c is expected to create far fewer outputs.
const MAX_VARIANTS = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new AssetCleanupContractError(`${label} has unknown fields: ${unknown.join(',')}`);
  }
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new AssetCleanupContractError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function requireHash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HASH_RE.test(value)) {
    throw new AssetCleanupContractError(`${field} must be a lowercase sha256`);
  }
  return value;
}

function parseBase(value: Record<string, unknown>) {
  const eventId = requireUuid(value.eventId, 'eventId');
  const workspaceId = requireUuid(value.workspaceId, 'workspaceId');
  const siteId = requireUuid(value.siteId, 'siteId');
  const assetId = requireUuid(value.assetId, 'assetId');
  if (typeof value.reason !== 'string' || !(ASSET_CLEANUP_REASONS as readonly string[]).includes(value.reason)) {
    throw new AssetCleanupContractError('invalid cleanup reason');
  }
  return {
    eventId,
    workspaceId,
    siteId,
    assetId,
    reason: value.reason as AssetCleanupReason,
  };
}

function parseStaging(value: Record<string, unknown>): StagingAssetCleanupCommand {
  requireExactKeys(
    value,
    ['eventId', 'workspaceId', 'siteId', 'assetId', 'objectKey', 'objectClass', 'reason', 'notBefore'],
    'staging cleanup command',
  );
  const base = parseBase(value);
  const expectedKey = `ws/${base.workspaceId}/${base.siteId}/uploads/${base.assetId}`;
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
    ...base,
    objectKey: expectedKey,
    objectClass: 'staging',
    notBefore: value.notBefore,
  };
}

function parseCanonical(value: Record<string, unknown>): CanonicalAssetCleanupCommand {
  requireExactKeys(
    value,
    ['eventId', 'workspaceId', 'siteId', 'assetId', 'objectClass', 'reason', 'canonical', 'variants'],
    'canonical cleanup command',
  );
  const base = parseBase(value);
  if (base.reason !== 'asset_deleted') {
    throw new AssetCleanupContractError('canonical cleanup only supports asset_deleted');
  }
  if (!isRecord(value.canonical)) {
    throw new AssetCleanupContractError('canonical cleanup object must be an object');
  }
  requireExactKeys(value.canonical, ['objectKey', 'contentHash'], 'canonical cleanup object');
  const canonicalHash = requireHash(value.canonical.contentHash, 'canonical.contentHash');
  const canonicalPrefix = `ws/${base.workspaceId}/${base.siteId}/`;
  if (
    typeof value.canonical.objectKey !== 'string' ||
    !value.canonical.objectKey.startsWith(canonicalPrefix) ||
    value.canonical.objectKey.includes('/uploads/') ||
    value.canonical.objectKey.includes('/variants/') ||
    !value.canonical.objectKey.includes(`/${canonicalHash}.`)
  ) {
    throw new AssetCleanupContractError('canonical object key does not match command provenance');
  }
  if (!Array.isArray(value.variants) || value.variants.length > MAX_VARIANTS) {
    throw new AssetCleanupContractError('canonical variants must be a bounded array');
  }
  const seen = new Set<string>();
  const variants = value.variants.map((candidate, index): CanonicalCleanupVariant => {
    if (!isRecord(candidate)) throw new AssetCleanupContractError(`variants[${index}] must be an object`);
    requireExactKeys(
      candidate,
      ['id', 'objectKey', 'contentHash', 'recipeHash', 'sourceVariantId', 'status'],
      `variants[${index}]`,
    );
    const id = requireUuid(candidate.id, `variants[${index}].id`);
    if (seen.has(id)) throw new AssetCleanupContractError('canonical variants contain duplicate ids');
    seen.add(id);
    const recipeHash = requireHash(candidate.recipeHash, `variants[${index}].recipeHash`);
    const expectedPrefix = `ws/${base.workspaceId}/${base.siteId}/variants/${base.assetId}/${recipeHash}.`;
    if (typeof candidate.objectKey !== 'string' || !candidate.objectKey.startsWith(expectedPrefix)) {
      throw new AssetCleanupContractError(`variants[${index}] object key does not match provenance`);
    }
    if (candidate.status !== 'ready' && candidate.status !== 'failed') {
      throw new AssetCleanupContractError(`variants[${index}] has an executable status`);
    }
    const contentHash =
      candidate.contentHash === null ? null : requireHash(candidate.contentHash, `variants[${index}].contentHash`);
    if (candidate.status === 'ready' && !contentHash) {
      throw new AssetCleanupContractError(`variants[${index}] ready row lacks content hash`);
    }
    const sourceVariantId =
      candidate.sourceVariantId === null
        ? null
        : requireUuid(candidate.sourceVariantId, `variants[${index}].sourceVariantId`);
    return {
      id,
      objectKey: candidate.objectKey,
      contentHash,
      recipeHash,
      sourceVariantId,
      status: candidate.status,
    };
  });
  const ids = new Set(variants.map((variant) => variant.id));
  if (variants.some((variant) => variant.sourceVariantId && !ids.has(variant.sourceVariantId))) {
    throw new AssetCleanupContractError('canonical variant source is missing from the frozen plan');
  }
  const sources = new Map(variants.map((variant) => [variant.id, variant.sourceVariantId]));
  for (const variant of variants) {
    const visiting = new Set<string>();
    let current: string | null = variant.id;
    while (current) {
      if (visiting.has(current)) {
        throw new AssetCleanupContractError('canonical variant graph contains a cycle');
      }
      visiting.add(current);
      current = sources.get(current) ?? null;
    }
  }
  const sorted = [...variants].sort((left, right) => left.id.localeCompare(right.id));
  if (variants.some((variant, index) => variant.id !== sorted[index]?.id)) {
    throw new AssetCleanupContractError('canonical variants must be sorted by id');
  }
  return {
    ...base,
    reason: 'asset_deleted',
    objectClass: 'canonical',
    canonical: {
      objectKey: value.canonical.objectKey,
      contentHash: canonicalHash,
    },
    variants,
  };
}

/** Strict fail-closed command parser shared by relay, workflow, activity and redrive. */
export function parseAssetCleanupCommand(value: unknown): AssetCleanupCommand {
  if (!isRecord(value)) throw new AssetCleanupContractError('cleanup command must be an object');
  if (value.objectClass === 'staging') return parseStaging(value);
  if (value.objectClass === 'canonical') return parseCanonical(value);
  throw new AssetCleanupContractError('unsupported cleanup objectClass');
}

export function assetCleanupPayload(command: AssetCleanupCommand): Record<string, unknown> {
  if (command.objectClass === 'staging') {
    return {
      assetId: command.assetId,
      siteId: command.siteId,
      objectKey: command.objectKey,
      objectClass: command.objectClass,
      reason: command.reason,
      notBefore: command.notBefore,
    };
  }
  return {
    assetId: command.assetId,
    siteId: command.siteId,
    objectClass: command.objectClass,
    reason: command.reason,
    canonical: command.canonical,
    variants: command.variants,
  };
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key])]),
  );
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

export function matchesAssetCleanupPayload(value: unknown, command: AssetCleanupCommand): boolean {
  return isRecord(value) && deepEqual(value, assetCleanupPayload(command));
}
