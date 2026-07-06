import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface TraceEntry {
  workspaceId: string;
  task: string;
  op: string;
  provider: string;
  model: string;
  status: 'OK' | 'ERROR';
  errorMessage?: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  correlationId?: string;
}

/**
 * AI 可观测性（PRD 9.10）：每次模型调用落 ai_trace + usage_ledger。
 * Fire-and-forget —— 记账失败绝不能影响业务调用本身。
 */
@Injectable()
export class AiTraceSink {
  private readonly logger = new Logger('AiTrace');

  constructor(private readonly prisma: PrismaService) {}

  record(entry: TraceEntry): void {
    void this.prisma
      .withWorkspace(entry.workspaceId, async (tx) => {
        const trace = await tx.aiTrace.create({
          data: {
            workspaceId: entry.workspaceId,
            task: entry.task,
            op: entry.op,
            provider: entry.provider,
            model: entry.model,
            status: entry.status,
            errorMessage: entry.errorMessage?.slice(0, 500) ?? null,
            latencyMs: entry.latencyMs,
            inputTokens: entry.inputTokens ?? null,
            outputTokens: entry.outputTokens ?? null,
            costUsd: entry.costUsd ?? null,
            correlationId: entry.correlationId ?? null,
          },
        });
        const tokens = (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0);
        if (entry.status === 'OK' && tokens > 0) {
          await tx.usageLedger.create({
            data: {
              workspaceId: entry.workspaceId,
              resourceType: 'ai_tokens',
              quantity: tokens,
              costUsd: entry.costUsd ?? null,
              refType: 'ai_trace',
              refId: trace.id,
              meta: { task: entry.task, model: entry.model },
            },
          });
        }
      })
      .catch((err) => this.logger.warn(`trace write failed: ${String(err).slice(0, 200)}`));
  }
}
