import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TemporalClient } from '../temporal/temporal.client';
import {
  UNDERSTANDING_TASK_QUEUE,
  WORKSPACE_PURGE_WORKFLOW,
} from '../temporal/understanding.constants';
import type { RequestWorkspacePurgeDto } from './dto/workspace-purge.dto';
import type {
  WorkspacePurgeReceiptRecord,
  WorkspacePurgeStatus,
  WorkspacePurgeStorageCounts,
} from './workspace-purge.types';

type BeginPurgeRow = {
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

function asNullableNumberRecord(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function asStorageCounts(value: unknown): WorkspacePurgeStorageCounts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  return {
    sellerDocuments: Number(r.sellerDocuments ?? 0),
    siteBuilder: Number(r.siteBuilder ?? 0),
    operationArtifacts: Number(r.operationArtifacts ?? 0),
  };
}

function mapBeginRow(row: BeginPurgeRow): WorkspacePurgeReceiptRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    idempotencyKey: row.idempotency_key,
    status: row.status as WorkspacePurgeStatus,
    requestedBy: row.requested_by,
    cleanupManifest: asRecord(row.cleanup_manifest),
    dbRowsDeleted: asNullableNumberRecord(row.db_rows_deleted),
    minioObjectsDeleted: asStorageCounts(row.minio_objects_deleted),
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

export function workspacePurgeWorkflowId(workspaceId: string): string {
  return `workspace-purge-${workspaceId}`;
}

@Injectable()
export class WorkspacePurgeService {
  private readonly log = new Logger(WorkspacePurgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly temporal: TemporalClient,
  ) {}

  async requestPurge(
    workspaceId: string,
    dto: RequestWorkspacePurgeDto,
  ): Promise<WorkspacePurgeReceiptRecord> {
    const requestedBy = dto.requestedBy ?? null;
    const rows = await this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.$queryRaw<BeginPurgeRow[]>(Prisma.sql`
        SELECT
          "id", "workspace_id", "idempotency_key", "status", "requested_by",
          "cleanup_manifest", "db_rows_deleted", "minio_objects_deleted",
          "redis_keys_deleted", "temporal_workflows_cancelled", "error_code",
          "rule_version", "started_at", "completed_at", "created_at", "updated_at"
        FROM public.begin_workspace_purge_v1(
          ${workspaceId}::uuid,
          ${dto.idempotencyKey}::varchar,
          ${requestedBy}::uuid
        )
      `),
    );

    const row = rows[0];
    if (!row) {
      throw new Error('WORKSPACE_PURGE_RECEIPT_CREATE_FAILED');
    }
    const receipt = mapBeginRow(row);
    if (receipt.status === 'COMPLETED') {
      return receipt;
    }

    const ready = this.temporal.client || (await this.temporal.reconnect());
    if (!ready || !this.temporal.client) {
      throw new ServiceUnavailableException({
        error: {
          code: 'WORKSPACE_PURGE_ORCHESTRATION_UNAVAILABLE',
          message: 'WORKSPACE_PURGE_ORCHESTRATION_UNAVAILABLE',
        },
      });
    }

    try {
      await this.temporal.client.workflow.start(WORKSPACE_PURGE_WORKFLOW, {
        taskQueue: UNDERSTANDING_TASK_QUEUE,
        workflowId: workspacePurgeWorkflowId(workspaceId),
        args: [
          {
            workspaceId,
            idempotencyKey: receipt.idempotencyKey,
            campaignPlanJobIds: dto.campaignPlanJobIds ?? [],
          },
        ],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('already started') || message.includes('WorkflowExecutionAlreadyStarted')) {
        this.log.log(`workspace purge workflow already started (${workspaceId})`);
        return receipt;
      }
      this.log.error(`workspace purge launch failed (${workspaceId})`);
      throw new ServiceUnavailableException({
        error: {
          code: 'WORKSPACE_PURGE_ORCHESTRATION_UNAVAILABLE',
          message: 'WORKSPACE_PURGE_ORCHESTRATION_UNAVAILABLE',
        },
      });
    }

    return receipt;
  }

  async getReceipt(workspaceId: string): Promise<WorkspacePurgeReceiptRecord> {
    const row = await this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.workspacePurgeReceipt.findUnique({
        where: { workspaceId },
      }),
    );
    if (!row) {
      throw new NotFoundException({
        error: {
          code: 'WORKSPACE_PURGE_NOT_FOUND',
          message: 'WORKSPACE_PURGE_NOT_FOUND',
        },
      });
    }
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      idempotencyKey: row.idempotencyKey,
      status: row.status as WorkspacePurgeStatus,
      requestedBy: row.requestedBy,
      cleanupManifest: asRecord(row.cleanupManifest),
      dbRowsDeleted: asNullableNumberRecord(row.dbRowsDeleted),
      minioObjectsDeleted: asStorageCounts(row.minioObjectsDeleted),
      redisKeysDeleted: row.redisKeysDeleted,
      temporalWorkflowsCancelled: row.temporalWorkflowsCancelled,
      errorCode: row.errorCode,
      ruleVersion: row.ruleVersion,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
