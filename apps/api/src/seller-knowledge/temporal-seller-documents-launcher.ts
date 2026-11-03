import { Injectable, Logger } from '@nestjs/common';
import { TemporalClient } from '../temporal/temporal.client';
import { UNDERSTANDING_TASK_QUEUE } from '../temporal/understanding.constants';
import type { SellerDocumentsIngestLauncher } from './seller-documents.service';

/**
 * 资料摄入的 Temporal 实现：workflowId 绑定 documentId（同一文档重复触发时
 * Temporal 以 WorkflowId 去重，服务端 CAS 认领会兜底并发）。
 */
@Injectable()
export class TemporalSellerDocumentsIngestLauncher implements SellerDocumentsIngestLauncher {
  private readonly log = new Logger(TemporalSellerDocumentsIngestLauncher.name);

  constructor(private readonly temporal: TemporalClient) {}

  async launchIngest(input: { workspaceId: string; companyId: string; documentId: string }): Promise<void> {
    try {
      await this.temporal.client.workflow.start('sellerDocumentIngestWorkflow', {
        taskQueue: UNDERSTANDING_TASK_QUEUE,
        workflowId: `seller-document-${input.documentId}`,
        args: [input],
      });
    } catch (error) {
      // 已存在同 workflowId 的运行：视为已入队（retry 端点重复触发是幂等的）。
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('already started')) {
        this.log.log(`ingest already running (${input.documentId})`);
        return;
      }
      throw error;
    }
  }
}
