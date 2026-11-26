import { Logger } from '@nestjs/common';
import { ApplicationFailure } from '@temporalio/activity';
import { randomUUID } from 'node:crypto';
import {
  buildWorkspaceExportPayload,
  DataExportTooLargeError,
} from '../data-exports/data-exports.formatter';
import {
  dataExportObjectKey,
  DataExportStorage,
} from '../data-exports/data-exports.storage';
import type {
  DataExportFormat,
  DataExportScope,
  DataExportStatus,
  DataExportWorkflowInput,
  DataExportWorkflowResult,
} from '../data-exports/data-exports.types';
import type { PrismaService } from '../prisma/prisma.service';

const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

export interface DataExportActivityDeps {
  prisma: PrismaService;
  storage?: Pick<DataExportStorage, 'putExportObject'>;
  now?: () => Date;
}

function dateSlug(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function createDataExportActivities(deps: DataExportActivityDeps) {
  const log = new Logger('DataExportActivities');
  const storage = deps.storage ?? new DataExportStorage();
  const clock = deps.now ?? (() => new Date());

  return {
    async runDataExport(
      input: DataExportWorkflowInput,
    ): Promise<DataExportWorkflowResult> {
      const claimResult = await deps.prisma.withWorkspace(
        input.workspaceId,
        async (tx) => {
          const updated = await tx.dataExportJob.updateMany({
            where: {
              id: input.exportId,
              workspaceId: input.workspaceId,
              status: { in: ['pending', 'processing'] },
            },
            data: { status: 'processing', errorCode: null },
          });
          const job = await tx.dataExportJob.findUnique({
            where: { id: input.exportId },
          });
          return { claimed: updated.count > 0, job };
        },
      );

      const job = claimResult.job;
      if (!job) {
        throw ApplicationFailure.create({
          type: 'DATA_EXPORT_NOT_FOUND',
          message: 'DATA_EXPORT_NOT_FOUND',
          nonRetryable: true,
        });
      }
      if (!claimResult.claimed) {
        if (job.status === 'ready') {
          return {
            status: 'ready',
            rowCount: job.rowCount ?? 0,
            byteSize: Number(job.byteSize ?? 0),
          };
        }
        throw ApplicationFailure.create({
          type: 'DATA_EXPORT_NOT_CLAIMABLE',
          message: `DATA_EXPORT_NOT_CLAIMABLE:${job.status}`,
          nonRetryable: true,
        });
      }

      const now = clock();
      let payload;
      try {
        payload = await deps.prisma.withWorkspace(
          input.workspaceId,
          (tx) =>
            buildWorkspaceExportPayload(
              tx,
              {
                workspaceId: input.workspaceId,
                exportId: job.id,
                scope: job.scope as DataExportScope,
                format: job.format as DataExportFormat,
              },
              now,
            ),
          { timeout: 120_000 },
        );
      } catch (error) {
        if (error instanceof DataExportTooLargeError) {
          throw ApplicationFailure.create({
            type: 'DATA_EXPORT_TOO_LARGE',
            message: 'DATA_EXPORT_TOO_LARGE',
            nonRetryable: true,
          });
        }
        throw error;
      }

      const objectKey = dataExportObjectKey(
        input.workspaceId,
        job.id,
        payload.ext,
      );
      const filename = `export-${job.scope}-${dateSlug(now)}.${payload.ext}`;
      await storage.putExportObject(objectKey, payload.body, payload.contentType);

      const completedAt = clock();
      const expiresAt = new Date(completedAt.getTime() + EXPORT_TTL_MS);

      await deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
        await tx.dataExportJob.updateMany({
          where: {
            id: job.id,
            workspaceId: input.workspaceId,
            status: 'processing',
          },
          data: {
            status: 'ready',
            objectKey,
            contentType: payload.contentType,
            filename,
            byteSize: BigInt(payload.body.byteLength),
            rowCount: payload.rowCount,
            errorCode: null,
            expiresAt,
            completedAt,
          },
        });
        await tx.policyDecisionLog.create({
          data: {
            id: randomUUID(),
            workspaceId: input.workspaceId,
            action: 'EXPORT',
            dataClass: 'amber',
            subjectJurisdiction: '*',
            processorJurisdiction: '*',
            effect: 'ALLOW',
            allowed: true,
            reason: `data_export:${job.scope}`,
            ruleVersion: 'data-export/v1',
            article14Required: false,
            subjectType: 'workspace',
            subjectId: input.workspaceId,
            actorId: job.requestedBy,
            correlationId: job.id,
          },
        });
      });

      log.log(
        `data export ready (${job.id}, scope=${job.scope}, rows=${payload.rowCount}, bytes=${payload.body.byteLength})`,
      );
      return {
        status: 'ready' as DataExportStatus,
        rowCount: payload.rowCount,
        byteSize: payload.body.byteLength,
      };
    },

    async failDataExport(input: {
      workspaceId: string;
      exportId: string;
      errorCode: string;
    }): Promise<void> {
      const code = input.errorCode.trim().slice(0, 120) || 'DATA_EXPORT_FAILED';
      await deps.prisma.withWorkspace(input.workspaceId, (tx) =>
        tx.dataExportJob.updateMany({
          where: {
            id: input.exportId,
            workspaceId: input.workspaceId,
            status: { in: ['pending', 'processing'] },
          },
          data: {
            status: 'failed',
            errorCode: code,
          },
        }),
      );
    },
  };
}

export type DataExportActivities = ReturnType<typeof createDataExportActivities>;
