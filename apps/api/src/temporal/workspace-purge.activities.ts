import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { S3PersonalArtifactCleanupAdapter } from '../durable-results/artifact/personal-artifact-cleanup.store';
import type { PrismaService } from '../prisma/prisma.service';
import { DataExportStorage } from '../data-exports/data-exports.storage';
import { SellerDocumentsStorage } from '../seller-knowledge/seller-documents.storage';
import type { StorageService } from '../site-builder/storage.service';
import { purgeWorkspaceRedisKeys } from '../workspace/workspace-purge-redis';
import type {
  WorkspacePurgePersonalObjectTarget,
  WorkspacePurgeReceiptRecord,
  WorkspacePurgeStatus,
  WorkspacePurgeStorageCounts,
  WorkspacePurgeTargets,
} from '../workspace/workspace-purge.types';
import { TemporalClient } from './temporal.client';
import {
  expandPurgeWorkflowIds,
  formatLegacyWorkflowId,
  formatTenantWorkflowId,
} from './tenant-workflow-id';

export interface WorkspacePurgeActivityDeps {
  prisma: PrismaService;
  siteBuilderStorage: Pick<StorageService, 'deletePrefix'>;
  personalArtifactCleanupPort: Pick<S3PersonalArtifactCleanupAdapter, 'eraseFinalObject'>;
  sellerDocumentsStorage?: Pick<SellerDocumentsStorage, 'deletePrefix'> & {
    readonly bucket?: string;
  };
  dataExportStorage?: Pick<DataExportStorage, 'delete'> & {
    readonly bucket?: string;
    readonly deletePrefix?: (prefix: string, signal?: AbortSignal) => Promise<number>;
  };
  temporal?: Pick<TemporalClient, 'client' | 'reconnect'>;
  redisPurger?: (workspaceId: string) => Promise<number>;
}

type SnapshotRow = {
  workflow_ids: string[] | null;
  site_ids: string[] | null;
  legacy_release_prefixes: string[] | null;
  export_object_keys: string[] | null;
};

type PurgeDbRow = {
  db_rows_deleted: unknown;
  personal_objects_to_erase: unknown;
};

type CompletePurgeRow = {
  id: string;
  workspace_id: string;
  idempotency_key: string;
  status: string;
  requested_by: string | null;
  cleanup_manifest: unknown;
  db_rows_deleted: unknown;
  minio_objects_deleted: unknown;
  redis_keys_deleted: number;
  temporal_workflows_cancelled: number;
  error_code: string | null;
  rule_version: string;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNumberRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function parsePersonalObjects(value: unknown): WorkspacePurgePersonalObjectTarget[] {
  if (!Array.isArray(value)) return [];
  const targets: WorkspacePurgePersonalObjectTarget[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (
      typeof rec.objectKey === 'string' &&
      typeof rec.sha256 === 'string' &&
      typeof rec.versionId === 'string' &&
      (rec.objectScope === 'workspace' || rec.objectScope === 'legacy_global')
    ) {
      targets.push({
        objectKey: rec.objectKey,
        sha256: rec.sha256,
        versionId: rec.versionId,
        objectScope: rec.objectScope,
      });
    }
  }
  return targets;
}

function normalizePrefix(prefix: string): string | null {
  const trimmed = prefix.trim();
  if (!trimmed || trimmed.includes('..')) return null;
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function isIgnorableTemporalCancelError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    msg.includes('not found') ||
    msg.includes('already completed') ||
    msg.includes('workflow execution already') ||
    msg.includes('workflow not found')
  );
}

function mapReceiptRow(row: CompletePurgeRow): WorkspacePurgeReceiptRecord {
  const rawStorage = asRecord(row.minio_objects_deleted);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    idempotencyKey: row.idempotency_key,
    status: row.status as WorkspacePurgeStatus,
    requestedBy: row.requested_by,
    cleanupManifest: asRecord(row.cleanup_manifest),
    dbRowsDeleted: row.db_rows_deleted ? asNumberRecord(row.db_rows_deleted) : null,
    minioObjectsDeleted: row.minio_objects_deleted
      ? {
          sellerDocuments: Number(rawStorage.sellerDocuments ?? 0),
          siteBuilder: Number(rawStorage.siteBuilder ?? 0),
          operationArtifacts: Number(rawStorage.operationArtifacts ?? 0),
        }
      : null,
    redisKeysDeleted: Number(row.redis_keys_deleted ?? 0),
    temporalWorkflowsCancelled: Number(row.temporal_workflows_cancelled ?? 0),
    errorCode: row.error_code,
    ruleVersion: row.rule_version,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createWorkspacePurgeActivities(deps: WorkspacePurgeActivityDeps) {
  const log = new Logger('WorkspacePurgeActivities');
  const sellerDocuments = deps.sellerDocumentsStorage ?? new SellerDocumentsStorage();
  const dataExportStorage = deps.dataExportStorage ?? new DataExportStorage();
  const sellerBucket =
    sellerDocuments.bucket ??
    (process.env.SELLER_DOCUMENTS_S3_BUCKET?.trim() || 'global-seller-documents');
  const purgeRedis = deps.redisPurger ?? ((workspaceId: string) => purgeWorkspaceRedisKeys(workspaceId));

  return {
    async markWorkspacePurgeRunning(input: {
      workspaceId: string;
      campaignPlanJobIds?: readonly string[];
    }): Promise<boolean> {
      const manifest = {
        campaignPlanJobIds: [...(input.campaignPlanJobIds ?? [])],
      };
      const rows = await deps.prisma.withWorkspace(input.workspaceId, (tx) =>
        tx.$queryRaw<Array<{ running: boolean }>>(Prisma.sql`
          SELECT public.mark_workspace_purge_running_v1(
            ${input.workspaceId}::uuid,
            ${manifest}::jsonb
          ) AS running
        `),
      );
      return rows[0]?.running === true;
    },

    async getWorkspacePurgeReceipt(input: {
      workspaceId: string;
    }): Promise<WorkspacePurgeReceiptRecord> {
      const row = await deps.prisma.withWorkspace(input.workspaceId, (tx) =>
        tx.workspacePurgeReceipt.findUniqueOrThrow({
          where: { workspaceId: input.workspaceId },
        }),
      );
      return mapReceiptRow({
        id: row.id,
        workspace_id: row.workspaceId,
        idempotency_key: row.idempotencyKey,
        status: row.status,
        requested_by: row.requestedBy,
        cleanup_manifest: row.cleanupManifest,
        db_rows_deleted: row.dbRowsDeleted,
        minio_objects_deleted: row.minioObjectsDeleted,
        redis_keys_deleted: row.redisKeysDeleted,
        temporal_workflows_cancelled: row.temporalWorkflowsCancelled,
        error_code: row.errorCode,
        rule_version: row.ruleVersion,
        started_at: row.startedAt,
        completed_at: row.completedAt,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      });
    },

    async snapshotWorkspacePurgeTargets(input: {
      workspaceId: string;
      campaignPlanJobIds?: readonly string[];
    }): Promise<WorkspacePurgeTargets> {
      const rows = await deps.prisma.withWorkspace(input.workspaceId, (tx) =>
        tx.$queryRaw<SnapshotRow[]>(Prisma.sql`
          SELECT "workflow_ids", "site_ids", "legacy_release_prefixes", "export_object_keys"
          FROM public.snapshot_workspace_purge_targets_v1(${input.workspaceId}::uuid)
        `),
      );
      const row = rows[0];
      const rawIds = [
        ...(row?.workflow_ids ?? []),
        ...(input.campaignPlanJobIds ?? []).map((jobId) => `campaign-plan-${jobId}`),
      ];
      return {
        workflowIds: expandPurgeWorkflowIds(input.workspaceId, rawIds),
        siteIds: row?.site_ids ?? [],
        legacyReleasePrefixes: row?.legacy_release_prefixes ?? [],
        exportObjectKeys: row?.export_object_keys ?? [],
      };
    },

    async cancelWorkspaceWorkflows(input: {
      workspaceId: string;
      workflowIds: readonly string[];
    }): Promise<number> {
      if (input.workflowIds.length === 0) return 0;

      let localTemporal: TemporalClient | null = null;
      const clientHolder = deps.temporal ?? (localTemporal = new TemporalClient());
      try {
        const ready = clientHolder.client || (await clientHolder.reconnect());
        if (!ready || !clientHolder.client) {
          throw new Error('TEMPORAL_CLIENT_UNAVAILABLE');
        }
        const selfLegacy = formatLegacyWorkflowId('workspace-purge', input.workspaceId);
        const selfPrefixed = formatTenantWorkflowId(
          input.workspaceId,
          'workspace-purge',
          input.workspaceId,
        );
        let cancelled = 0;
        for (const workflowId of input.workflowIds) {
          if (workflowId === selfLegacy || workflowId === selfPrefixed) continue;
          try {
            await clientHolder.client.workflow.getHandle(workflowId).cancel();
            cancelled += 1;
          } catch (error) {
            if (isIgnorableTemporalCancelError(error)) continue;
            log.warn(`failed to cancel workflow ${workflowId} for ${input.workspaceId}`);
            throw error;
          }
        }
        return cancelled;
      } finally {
        if (localTemporal) {
          await localTemporal.onModuleDestroy().catch(() => undefined);
        }
      }
    },

    async purgeWorkspaceDatabase(input: { workspaceId: string }): Promise<{
      dbRowsDeleted: Record<string, number>;
      personalObjectsToErase: WorkspacePurgePersonalObjectTarget[];
    }> {
      const rows = await deps.prisma.withWorkspace(
        input.workspaceId,
        (tx) =>
          tx.$queryRaw<PurgeDbRow[]>(Prisma.sql`
            SELECT "db_rows_deleted", "personal_objects_to_erase"
            FROM public.purge_workspace_tenant_data_v1(${input.workspaceId}::uuid)
          `),
        { timeout: 60_000 },
      );
      const row = rows[0];
      return {
        dbRowsDeleted: asNumberRecord(row?.db_rows_deleted),
        personalObjectsToErase: parsePersonalObjects(row?.personal_objects_to_erase),
      };
    },

    async purgeWorkspaceStorage(input: {
      workspaceId: string;
      siteIds: readonly string[];
      legacyReleasePrefixes: readonly string[];
      exportObjectKeys?: readonly string[];
      personalObjects: readonly WorkspacePurgePersonalObjectTarget[];
    }): Promise<WorkspacePurgeStorageCounts> {
      const workspacePrefix = `ws/${input.workspaceId}/`;
      let sellerDocumentsDeleted = await sellerDocuments.deletePrefix(workspacePrefix);

      const separateExportBucket = dataExportStorage.bucket !== sellerBucket;
      if (separateExportBucket && typeof dataExportStorage.deletePrefix === 'function') {
        sellerDocumentsDeleted += await dataExportStorage.deletePrefix(workspacePrefix);
      }
      const seenExportKeys = new Set<string>();
      for (const rawKey of input.exportObjectKeys ?? []) {
        const key = rawKey.trim();
        if (!key || key.includes('..') || seenExportKeys.has(key)) continue;
        seenExportKeys.add(key);
        const coveredBySellerPrefix = !separateExportBucket && key.startsWith(workspacePrefix);
        const coveredByExportPrefix =
          separateExportBucket &&
          typeof dataExportStorage.deletePrefix === 'function' &&
          key.startsWith(workspacePrefix);
        if (coveredBySellerPrefix || coveredByExportPrefix) continue;
        await dataExportStorage.delete(key);
        sellerDocumentsDeleted += 1;
      }

      const siteBuilderPrefixes = new Set<string>([`ws/${input.workspaceId}/`]);
      for (const siteId of input.siteIds) {
        siteBuilderPrefixes.add(`sites/${siteId}/`);
      }
      for (const prefix of input.legacyReleasePrefixes) {
        const normalized = normalizePrefix(prefix);
        if (normalized) siteBuilderPrefixes.add(normalized);
      }
      let siteBuilderDeleted = 0;
      for (const prefix of siteBuilderPrefixes) {
        siteBuilderDeleted += await deps.siteBuilderStorage.deletePrefix(prefix);
      }

      let operationArtifactsDeleted = 0;
      const seenKeys = new Set<string>();
      for (const target of input.personalObjects) {
        if (seenKeys.has(target.objectKey)) continue;
        seenKeys.add(target.objectKey);
        const status = await deps.personalArtifactCleanupPort.eraseFinalObject({
          workspaceId: input.workspaceId,
          sha256: target.sha256,
          versionId: target.versionId,
          objectScope: target.objectScope,
        });
        if (status === 'DELETED') operationArtifactsDeleted += 1;
      }

      return {
        sellerDocuments: sellerDocumentsDeleted,
        siteBuilder: siteBuilderDeleted,
        operationArtifacts: operationArtifactsDeleted,
      };
    },

    async purgeWorkspaceRedis(input: { workspaceId: string }): Promise<number> {
      return purgeRedis(input.workspaceId);
    },

    async completeWorkspacePurge(input: {
      workspaceId: string;
      dbRowsDeleted: Record<string, number>;
      minioObjectsDeleted: WorkspacePurgeStorageCounts;
      redisKeysDeleted: number;
      temporalWorkflowsCancelled: number;
    }): Promise<WorkspacePurgeReceiptRecord> {
      const rows = await deps.prisma.withWorkspace(input.workspaceId, (tx) =>
        tx.$queryRaw<CompletePurgeRow[]>(Prisma.sql`
          SELECT
            "id", "workspace_id", "idempotency_key", "status", "requested_by",
            "cleanup_manifest", "db_rows_deleted", "minio_objects_deleted",
            "redis_keys_deleted", "temporal_workflows_cancelled", "error_code",
            "rule_version", "started_at", "completed_at", "created_at", "updated_at"
          FROM public.complete_workspace_purge_v1(
            ${input.workspaceId}::uuid,
            ${input.dbRowsDeleted}::jsonb,
            ${input.minioObjectsDeleted}::jsonb,
            ${input.redisKeysDeleted}::integer,
            ${input.temporalWorkflowsCancelled}::integer
          )
        `),
      );
      const row = rows[0];
      if (!row) throw new Error('WORKSPACE_PURGE_RECEIPT_MISSING');
      return mapReceiptRow(row);
    },

    async failWorkspacePurge(input: {
      workspaceId: string;
      errorCode: string;
    }): Promise<void> {
      await deps.prisma.withWorkspace(input.workspaceId, (tx) =>
        tx.$executeRaw(Prisma.sql`
          SELECT public.fail_workspace_purge_v1(
            ${input.workspaceId}::uuid,
            ${input.errorCode}::varchar
          )
        `),
      );
    },
  };
}

export type WorkspacePurgeActivities = ReturnType<typeof createWorkspacePurgeActivities>;
