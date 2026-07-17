import { ApplicationFailure, Context } from '@temporalio/activity';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../site-builder/storage.service';
import {
  AssetCleanupCommand,
  CanonicalAssetCleanupCommand,
  StagingAssetCleanupCommand,
  matchesAssetCleanupPayload,
  parseAssetCleanupCommand,
} from './asset-cleanup.contract';

export type { AssetCleanupCommand } from './asset-cleanup.contract';

export interface AssetCleanupActivityDeps {
  prisma: PrismaService;
  storage: Pick<StorageService, 'delete' | 'head'>;
}

function invalidProvenance(message: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message, 'ASSET_CLEANUP_PROVENANCE_INVALID');
}

function cleanupOperationSignal(): AbortSignal {
  const localDeadline = AbortSignal.timeout(110_000);
  try {
    return AbortSignal.any([Context.current().cancellationSignal, localDeadline]);
  } catch {
    // Unit tests call these functions without a Temporal activity context.
    return localDeadline;
  }
}

function assetStateAllowsCleanup(
  command: StagingAssetCleanupCommand,
  asset: {
    objectKey: string;
    processingStatus: string;
    contentHash: string | null;
    deletedAt: Date | null;
  },
): boolean {
  if (command.reason === 'commit_succeeded') {
    const canonicalPrefix = `ws/${command.workspaceId}/${command.siteId}/`;
    return (
      asset.objectKey !== command.objectKey &&
      asset.objectKey.startsWith(canonicalPrefix) &&
      !asset.objectKey.includes('/uploads/') &&
      typeof asset.contentHash === 'string' &&
      /^[0-9a-f]{64}$/.test(asset.contentHash)
    );
  }
  if (command.reason === 'asset_deleted') {
    return (
      asset.objectKey === command.objectKey && asset.processingStatus === 'deleted' && asset.deletedAt instanceof Date
    );
  }
  return asset.objectKey === command.objectKey && asset.processingStatus === command.reason;
}

function attemptKeysFromMetadata(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const value = metadata as Record<string, unknown>;
  const keys = Array.isArray(value.attemptKeys)
    ? value.attemptKeys.filter((key): key is string => typeof key === 'string')
    : [];
  const reservation = value.reservation;
  if (reservation && typeof reservation === 'object' && !Array.isArray(reservation)) {
    const key = (reservation as Record<string, unknown>).attemptKey;
    if (typeof key === 'string') keys.push(key);
  }
  return [...new Set(keys)];
}

function canonicalVariantDeleteOrder(command: CanonicalAssetCleanupCommand) {
  const remaining = new Map(command.variants.map((variant) => [variant.id, variant]));
  const ordered: typeof command.variants = [];
  while (remaining.size > 0) {
    const parentIds = new Set(
      [...remaining.values()]
        .map((variant) => variant.sourceVariantId)
        .filter((value): value is string => value !== null && remaining.has(value)),
    );
    const leaves = [...remaining.values()]
      .filter((variant) => !parentIds.has(variant.id))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (leaves.length === 0) throw invalidProvenance('canonical variant graph contains a cycle');
    for (const leaf of leaves) {
      ordered.push(leaf);
      remaining.delete(leaf.id);
    }
  }
  return ordered;
}

function sameVariantPlan(
  command: CanonicalAssetCleanupCommand,
  rows: Array<{
    id: string;
    objectKey: string;
    contentHash: string | null;
    recipeHash: string;
    sourceVariantId: string | null;
    status: string;
    metadata?: unknown;
  }>,
): boolean {
  return (
    rows.length === command.variants.length &&
    rows.every((row, index) => {
      const expected = command.variants[index];
      return (
        expected !== undefined &&
        row.id === expected.id &&
        row.objectKey === expected.objectKey &&
        row.contentHash === expected.contentHash &&
        row.recipeHash === expected.recipeHash &&
        row.sourceVariantId === expected.sourceVariantId &&
        row.status === expected.status &&
        (expected.attemptKeys === undefined ||
          JSON.stringify(attemptKeysFromMetadata(row.metadata)) === JSON.stringify(expected.attemptKeys))
      );
    })
  );
}

export function createAssetCleanupActivities({ prisma, storage }: AssetCleanupActivityDeps) {
  async function validateCanonicalCleanupTx(
    tx: Parameters<Parameters<PrismaService['withWorkspace']>[1]>[0],
    command: CanonicalAssetCleanupCommand,
  ): Promise<{ completed: boolean }> {
    const [event, asset, variants, foreignAsset, foreignVariant] = await Promise.all([
      tx.outboxEvent.findUnique({
        where: { eventId: command.eventId },
        select: {
          eventId: true,
          workspaceId: true,
          eventType: true,
          schemaVersion: true,
          aggregateType: true,
          aggregateId: true,
          payload: true,
        },
      }),
      tx.asset.findUnique({
        where: { id: command.assetId },
        select: {
          id: true,
          siteId: true,
          objectKey: true,
          contentHash: true,
          processingStatus: true,
          deletedAt: true,
          cleanupEventId: true,
          cleanupCompletedAt: true,
        },
      }),
      tx.assetVariant.findMany({
        where: { assetId: command.assetId },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          objectKey: true,
          contentHash: true,
          recipeHash: true,
          sourceVariantId: true,
          status: true,
          metadata: true,
        },
      }),
      tx.asset.findFirst({
        where: {
          objectKey: command.canonical.objectKey,
          deletedAt: null,
          NOT: { id: command.assetId },
        },
        select: { id: true },
      }),
      command.variants.length === 0
        ? Promise.resolve(null)
        : tx.assetVariant.findFirst({
            where: {
              objectKey: {
                in: command.variants.map((variant) => variant.objectKey),
              },
              NOT: { assetId: command.assetId },
            },
            select: { id: true },
          }),
    ]);
    if (
      !event ||
      event.workspaceId !== command.workspaceId ||
      event.eventType !== 'AssetObjectCleanupRequested' ||
      event.schemaVersion !== 2 ||
      event.aggregateType !== 'Asset' ||
      event.aggregateId !== command.assetId ||
      !matchesAssetCleanupPayload(event.payload, command)
    ) {
      throw invalidProvenance('canonical cleanup Outbox event does not match command');
    }
    if (
      !asset ||
      asset.siteId !== command.siteId ||
      asset.cleanupEventId !== command.eventId ||
      asset.processingStatus !== 'deleted' ||
      !(asset.deletedAt instanceof Date)
    ) {
      throw invalidProvenance('canonical cleanup Asset ownership is missing or inconsistent');
    }
    if (asset.cleanupCompletedAt instanceof Date) return { completed: true };
    if (
      asset.objectKey !== command.canonical.objectKey ||
      asset.contentHash !== command.canonical.contentHash ||
      foreignAsset ||
      foreignVariant ||
      !sameVariantPlan(command, variants)
    ) {
      throw invalidProvenance('canonical cleanup frozen object plan no longer matches DB provenance');
    }
    return { completed: false };
  }

  return {
    async cleanupStagingAssetObject(input: AssetCleanupCommand): Promise<{
      eventId: string;
      objectKey: string;
      deleted: true;
    }> {
      let command: AssetCleanupCommand;
      try {
        command = parseAssetCleanupCommand(input);
      } catch (error) {
        throw invalidProvenance(error instanceof Error ? error.message : String(error));
      }
      if (command.objectClass !== 'staging') {
        throw invalidProvenance('staging activity received a canonical command');
      }
      const signal = cleanupOperationSignal();

      await prisma.withWorkspace(command.workspaceId, async (tx) => {
        const [event, asset, foreignOwner] = await Promise.all([
          tx.outboxEvent.findUnique({
            where: { eventId: command.eventId },
            select: {
              eventId: true,
              workspaceId: true,
              eventType: true,
              schemaVersion: true,
              aggregateType: true,
              aggregateId: true,
              payload: true,
            },
          }),
          tx.asset.findUnique({
            where: { id: command.assetId },
            select: {
              id: true,
              siteId: true,
              objectKey: true,
              processingStatus: true,
              contentHash: true,
              deletedAt: true,
            },
          }),
          tx.asset.findFirst({
            where: {
              objectKey: command.objectKey,
              NOT: { id: command.assetId },
            },
            select: { id: true },
          }),
        ]);

        if (
          !event ||
          event.eventId !== command.eventId ||
          event.workspaceId !== command.workspaceId ||
          event.eventType !== 'AssetObjectCleanupRequested' ||
          event.schemaVersion !== 1 ||
          event.aggregateType !== 'Asset' ||
          event.aggregateId !== command.assetId ||
          !matchesAssetCleanupPayload(event.payload, command)
        ) {
          throw invalidProvenance('cleanup Outbox event does not match workflow command');
        }
        if (!asset || asset.siteId !== command.siteId || foreignOwner || !assetStateAllowsCleanup(command, asset)) {
          throw invalidProvenance('cleanup Asset provenance is missing, active, or inconsistent');
        }
      });

      // S3 DeleteObject is idempotent for a missing key. HEAD closes the transport-success but
      // object-still-present ambiguity; throwing here lets Temporal retry the same safe command.
      await storage.delete(command.objectKey, signal);
      if (await storage.head(command.objectKey, signal)) {
        throw new Error(`staging object still exists after delete: ${command.eventId}`);
      }
      return {
        eventId: command.eventId,
        objectKey: command.objectKey,
        deleted: true,
      };
    },

    async cleanupCanonicalAssetObjects(input: AssetCleanupCommand): Promise<{
      eventId: string;
      deleted: true;
      alreadySettled: boolean;
    }> {
      let command: CanonicalAssetCleanupCommand;
      try {
        const parsed = parseAssetCleanupCommand(input);
        if (parsed.objectClass !== 'canonical') throw new Error('canonical command required');
        command = parsed;
      } catch (error) {
        throw invalidProvenance(error instanceof Error ? error.message : String(error));
      }
      const signal = cleanupOperationSignal();

      const alreadySettled = await prisma.withWorkspace(
        command.workspaceId,
        async (tx) => (await validateCanonicalCleanupTx(tx, command)).completed,
      );
      if (alreadySettled) {
        // A fenced producer can resume after the original cleanup settled and recreate only its
        // token-scoped attempt object. Redrive those immutable frozen keys, but never touch
        // canonical/variant keys here because a replacement Asset may now own them.
        for (const variant of command.variants) {
          for (const attemptKey of variant.attemptKeys ?? []) {
            await storage.delete(attemptKey, signal);
            if (await storage.head(attemptKey, signal)) {
              throw new Error(`settled cleanup attempt object still exists: ${command.eventId}`);
            }
          }
        }
        return {
          eventId: command.eventId,
          deleted: true,
          alreadySettled: true,
        };
      }

      for (const object of [...canonicalVariantDeleteOrder(command), command.canonical]) {
        for (const attemptKey of ('attemptKeys' in object ? object.attemptKeys ?? [] : [])) {
          await storage.delete(attemptKey, signal);
          if (await storage.head(attemptKey, signal)) {
            throw new Error(`canonical cleanup attempt object still exists: ${command.eventId}`);
          }
        }
        await storage.delete(object.objectKey, signal);
        if (await storage.head(object.objectKey, signal)) {
          throw new Error(`canonical cleanup object still exists: ${command.eventId}`);
        }
      }
      return { eventId: command.eventId, deleted: true, alreadySettled: false };
    },

    async settleCanonicalAssetCleanup(input: AssetCleanupCommand): Promise<{
      eventId: string;
      settled: true;
      variantsDeleted: number;
    }> {
      const parsed = parseAssetCleanupCommand(input);
      if (parsed.objectClass !== 'canonical') {
        throw invalidProvenance('canonical settle received a staging command');
      }
      const command = parsed;
      const signal = cleanupOperationSignal();
      const alreadySettled = await prisma.withWorkspace(
        command.workspaceId,
        async (tx) => (await validateCanonicalCleanupTx(tx, command)).completed,
      );
      if (alreadySettled) {
        return { eventId: command.eventId, settled: true, variantsDeleted: 0 };
      }
      for (const object of [...command.variants, command.canonical]) {
        for (const attemptKey of ('attemptKeys' in object ? object.attemptKeys ?? [] : [])) {
          if (await storage.head(attemptKey, signal)) {
            throw new Error(`canonical cleanup cannot settle while attempt object exists: ${command.eventId}`);
          }
        }
        if (await storage.head(object.objectKey, signal)) {
          throw new Error(`canonical cleanup cannot settle while object exists: ${command.eventId}`);
        }
      }
      return prisma.withWorkspace(
        command.workspaceId,
        async (tx) => {
          const state = await validateCanonicalCleanupTx(tx, command);
          if (state.completed) {
            return {
              eventId: command.eventId,
              settled: true as const,
              variantsDeleted: 0,
            };
          }

          let variantsDeleted = 0;
          for (const variant of canonicalVariantDeleteOrder(command)) {
            const removed = await tx.assetVariant.deleteMany({
              where: { id: variant.id, assetId: command.assetId },
            });
            if (removed.count !== 1) {
              throw invalidProvenance(`canonical settle could not remove Variant ${variant.id}`);
            }
            variantsDeleted += 1;
          }
          const settled = await tx.asset.updateMany({
            where: {
              id: command.assetId,
              cleanupEventId: command.eventId,
              cleanupCompletedAt: null,
              deletedAt: { not: null },
            },
            data: { cleanupCompletedAt: new Date() },
          });
          if (settled.count !== 1) throw invalidProvenance('canonical settle CAS lost ownership');
          return {
            eventId: command.eventId,
            settled: true as const,
            variantsDeleted,
          };
        },
        { timeout: 60_000 },
      );
    },
  };
}
