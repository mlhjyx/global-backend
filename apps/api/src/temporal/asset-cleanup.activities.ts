import { ApplicationFailure } from '@temporalio/activity';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../site-builder/storage.service';
import {
  AssetCleanupCommand,
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

function assetStateAllowsCleanup(
  command: AssetCleanupCommand,
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
      asset.objectKey === command.objectKey &&
      asset.processingStatus === 'deleted' &&
      asset.deletedAt instanceof Date
    );
  }
  return asset.objectKey === command.objectKey && asset.processingStatus === command.reason;
}

export function createAssetCleanupActivities({ prisma, storage }: AssetCleanupActivityDeps) {
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
            where: { objectKey: command.objectKey, NOT: { id: command.assetId } },
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
        if (
          !asset ||
          asset.siteId !== command.siteId ||
          foreignOwner ||
          !assetStateAllowsCleanup(command, asset)
        ) {
          throw invalidProvenance('cleanup Asset provenance is missing, active, or inconsistent');
        }
      });

      // S3 DeleteObject is idempotent for a missing key. HEAD closes the transport-success but
      // object-still-present ambiguity; throwing here lets Temporal retry the same safe command.
      await storage.delete(command.objectKey);
      if (await storage.head(command.objectKey)) {
        throw new Error(`staging object still exists after delete: ${command.eventId}`);
      }
      return { eventId: command.eventId, objectKey: command.objectKey, deleted: true };
    },
  };
}
