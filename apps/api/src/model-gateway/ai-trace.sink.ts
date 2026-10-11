import { Injectable, Logger } from '@nestjs/common';
import type { ModelExecutionTrace } from '@global/contracts';
import type { Prisma } from '@prisma/client';
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
  /** Site Builder resolved policy + selected fallback position, when applicable. */
  modelPolicy?: ModelExecutionTrace;
  /**
   * Present only when `model` is a deployment-approved substitute (D14): the
   * row names the model that answered and keeps the requested one beside it.
   */
  modelSubstitution?: { requestedModel: string };
}

function substitutionMeta(
  entry: TraceEntry,
): { requestedModel: string; modelSubstituted: true } | undefined {
  return entry.modelSubstitution
    ? {
        requestedModel: entry.modelSubstitution.requestedModel,
        modelSubstituted: true,
      }
    : undefined;
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
    const substitution = substitutionMeta(entry);
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
            meta:
              entry.modelPolicy || substitution
                ? ({
                    ...(entry.modelPolicy
                      ? { modelPolicy: entry.modelPolicy }
                      : {}),
                    ...substitution,
                  } as unknown as Prisma.InputJsonObject)
                : undefined,
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
              meta: { task: entry.task, model: entry.model, ...substitution },
            },
          });
        }
      })
      .catch((err) => this.logger.warn(`trace write failed: ${String(err).slice(0, 200)}`));
  }
}
