import {
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import type { Readable } from 'node:stream';
import type { RequestContext } from '../auth/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { TemporalClient } from '../temporal/temporal.client';
import { DATA_EXPORT_WORKFLOW } from '../temporal/understanding.constants';
import { formatTenantWorkflowId } from '../temporal/tenant-workflow-id';
import { resolveCustomerTaskQueue } from '../temporal/tenant-task-queues';
import {
  DataExportStorage,
  isDataExportS3NotFoundError,
} from './data-exports.storage';
import {
  DATA_EXPORT_STATUSES,
  type DataExportFormat,
  type DataExportJobRecord,
  type DataExportScope,
  type DataExportStatus,
} from './data-exports.types';
import type { CreateDataExportDto } from './dto/data-exports.dto';

const MAX_ACTIVE_EXPORTS = 2;
const MAX_EXPORTS_PER_24H = 10;
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const STATUS_SET = new Set<string>(DATA_EXPORT_STATUSES);

function mapJob(row: {
  id: string;
  workspaceId: string;
  requestedBy: string;
  scope: string;
  format: string;
  status: string;
  objectKey: string | null;
  contentType: string | null;
  filename: string | null;
  byteSize: bigint | null;
  rowCount: number | null;
  errorCode: string | null;
  expiresAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): DataExportJobRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    requestedBy: row.requestedBy,
    scope: row.scope as DataExportScope,
    format: row.format as DataExportFormat,
    status: row.status as DataExportStatus,
    objectKey: row.objectKey,
    contentType: row.contentType,
    filename: row.filename,
    byteSize: row.byteSize,
    rowCount: row.rowCount,
    errorCode: row.errorCode,
    expiresAt: row.expiresAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function dataExportWorkflowId(exportId: string, workspaceId?: string): string {
  return workspaceId
    ? formatTenantWorkflowId(workspaceId, 'data-export', exportId)
    : `data-export-${exportId}`;
}

@Injectable()
export class DataExportsService {
  private readonly log = new Logger(DataExportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: DataExportStorage,
    private readonly temporal: TemporalClient,
  ) {}

  async createExport(
    ctx: RequestContext,
    dto: CreateDataExportDto,
  ): Promise<DataExportJobRecord> {
    const windowStart = new Date(Date.now() - RATE_WINDOW_MS);
    const created = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('data_export:' || ${ctx.workspaceId}::text))`,
      );
      const activeCount = await tx.dataExportJob.count({
        where: {
          workspaceId: ctx.workspaceId,
          status: { in: ['pending', 'processing'] },
        },
      });
      if (activeCount >= MAX_ACTIVE_EXPORTS) {
        throw new ConflictException({
          error: {
            code: 'DATA_EXPORT_IN_PROGRESS',
            message: '当前已有正在执行的导出任务，请稍后再试',
          },
        });
      }
      const recentCount = await tx.dataExportJob.count({
        where: {
          workspaceId: ctx.workspaceId,
          createdAt: { gte: windowStart },
        },
      });
      if (recentCount >= MAX_EXPORTS_PER_24H) {
        throw new HttpException(
          {
            error: {
              code: 'DATA_EXPORT_RATE_LIMITED',
              message: '24 小时内导出请求次数已达上限',
            },
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      return tx.dataExportJob.create({
        data: {
          workspaceId: ctx.workspaceId,
          requestedBy: ctx.userId,
          scope: dto.scope,
          format: dto.format,
          status: 'pending',
        },
      });
    });

    const job = mapJob(created);
    const ready = this.temporal.client || (await this.temporal.reconnect());
    if (!ready || !this.temporal.client) {
      await this.markLaunchFailed(ctx.workspaceId, job.id);
      throw new ServiceUnavailableException({
        error: {
          code: 'DATA_EXPORT_ORCHESTRATION_UNAVAILABLE',
          message: 'DATA_EXPORT_ORCHESTRATION_UNAVAILABLE',
        },
      });
    }

    try {
      await this.temporal.client.workflow.start(DATA_EXPORT_WORKFLOW, {
        taskQueue: resolveCustomerTaskQueue('batch'),
        workflowId: dataExportWorkflowId(job.id, ctx.workspaceId),
        args: [{ workspaceId: ctx.workspaceId, exportId: job.id }],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('already started') && !message.includes('WorkflowExecutionAlreadyStarted')) {
        this.log.error(`failed to launch data export ${job.id}`);
        await this.markLaunchFailed(ctx.workspaceId, job.id);
        throw new ServiceUnavailableException({
          error: {
            code: 'DATA_EXPORT_ORCHESTRATION_UNAVAILABLE',
            message: 'DATA_EXPORT_ORCHESTRATION_UNAVAILABLE',
          },
        });
      }
    }

    return job;
  }

  private async markLaunchFailed(workspaceId: string, exportId: string): Promise<void> {
    await this.prisma
      .withWorkspace(workspaceId, (tx) =>
        tx.dataExportJob.updateMany({
          where: { id: exportId, status: 'pending' },
          data: {
            status: 'failed',
            errorCode: 'DATA_EXPORT_ORCHESTRATION_UNAVAILABLE',
          },
        }),
      )
      .catch(() => undefined);
  }

  async listExports(
    ctx: RequestContext,
    opts: { limit: number; cursor?: string; status?: string },
  ): Promise<{ data: DataExportJobRecord[]; nextCursor: string | null; hasMore: boolean }> {
    if (opts.cursor !== undefined && !isUUID(opts.cursor)) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'cursor must be a valid UUID' },
      });
    }
    if (opts.status !== undefined && !STATUS_SET.has(opts.status)) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'invalid status filter' },
      });
    }
    const limit = Math.min(Math.max(Math.floor(opts.limit) || 20, 1), 100);
    const rows = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.dataExportJob.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          ...(opts.status ? { status: opts.status } : {}),
        },
        take: limit + 1,
        ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? pageRows[pageRows.length - 1]!.id : null;
    return {
      data: pageRows.map(mapJob),
      nextCursor,
      hasMore,
    };
  }

  async getExport(ctx: RequestContext, exportId: string): Promise<DataExportJobRecord> {
    const row = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.dataExportJob.findUnique({
        where: { id: exportId },
      }),
    );
    if (!row) {
      throw new NotFoundException({
        error: { code: 'DATA_EXPORT_NOT_FOUND', message: '导出任务不存在' },
      });
    }
    return mapJob(row);
  }

  async openDownloadStream(
    ctx: RequestContext,
    exportId: string,
  ): Promise<{
    stream: Readable;
    contentType: string;
    filename: string;
    contentLength?: number;
  }> {
    const job = await this.getExport(ctx, exportId);
    if (job.status === 'expired') {
      throw new GoneException({
        error: { code: 'DATA_EXPORT_EXPIRED', message: '导出文件已过期' },
      });
    }
    if (job.status !== 'ready' || !job.objectKey) {
      throw new ConflictException({
        error: { code: 'DATA_EXPORT_NOT_READY', message: '导出任务尚未就绪' },
      });
    }
    if (job.expiresAt && job.expiresAt.getTime() <= Date.now()) {
      await this.prisma
        .withWorkspace(ctx.workspaceId, (tx) =>
          tx.dataExportJob.updateMany({
            where: { id: exportId, status: 'ready' },
            data: { status: 'expired' },
          }),
        )
        .catch(() => undefined);
      await this.storage.delete(job.objectKey).catch(() => undefined);
      throw new GoneException({
        error: { code: 'DATA_EXPORT_EXPIRED', message: '导出文件已过期' },
      });
    }

    try {
      const opened = await this.storage.getObjectStream(job.objectKey);
      return {
        stream: opened.stream,
        contentType: job.contentType ?? opened.contentType ?? 'application/octet-stream',
        filename: job.filename ?? `export-${job.id}.${job.format}`,
        contentLength:
          opened.contentLength ??
          (job.byteSize !== null ? Number(job.byteSize) : undefined),
      };
    } catch (error) {
      if (isDataExportS3NotFoundError(error)) {
        throw new NotFoundException({
          error: { code: 'DATA_EXPORT_OBJECT_MISSING', message: '导出文件不存在或已清理' },
        });
      }
      throw new ServiceUnavailableException({
        error: {
          code: 'DATA_EXPORT_STORAGE_UNAVAILABLE',
          message: '导出存储暂时不可用，请稍后重试',
        },
      });
    }
  }
}
