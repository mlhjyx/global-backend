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
   * Present only when a deployment-approved substitute (D14) answered at
   * least one wire of this call. `model` stays the model whose answer the
   * call returned (or failed on); the requested model and the substitutes
   * that answered are kept beside it.
   */
  modelSubstitution?: {
    requestedModel: string;
    substituteModels: readonly string[];
  };
  /**
   * Set only while substitutes were admitted for the call and the upstream
   * named no model for the answer: `model` is the requested one by fallback,
   * not upstream proof (D14).
   */
  modelIdentityUnproven?: true;
  /**
   * Failed non-paid calls only (D13): the ledger operation the call reserved
   * and what the gateway did with it, so every failure that ends or skips a
   * run item can be traced to its tool_budget_operation row.
   */
  budgetOperationId?: string;
  budgetDisposition?:
    | 'RELEASED_CONTROL_DENIAL'
    | 'RELEASED_DEFINITE_FAILURE'
    | 'SETTLED_NO_RESULT';
}

/** D14 model-identity markers for ai_trace.meta and usage_ledger.meta. */
function modelIdentityMeta(entry: TraceEntry):
  | {
      requestedModel?: string;
      modelSubstituted?: true;
      substituteModels?: string[];
      modelIdentityUnproven?: true;
    }
  | undefined {
  if (!entry.modelSubstitution && !entry.modelIdentityUnproven) {
    return undefined;
  }
  return {
    ...(entry.modelSubstitution
      ? {
          requestedModel: entry.modelSubstitution.requestedModel,
          modelSubstituted: true as const,
          substituteModels: [...entry.modelSubstitution.substituteModels],
        }
      : {}),
    ...(entry.modelIdentityUnproven
      ? { modelIdentityUnproven: true as const }
      : {}),
  };
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
    const identity = modelIdentityMeta(entry);
    const budget =
      entry.budgetOperationId !== undefined && entry.budgetDisposition !== undefined
        ? {
            budgetOperationId: entry.budgetOperationId,
            budgetDisposition: entry.budgetDisposition,
          }
        : undefined;
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
              entry.modelPolicy || identity || budget
                ? ({
                    ...(entry.modelPolicy
                      ? { modelPolicy: entry.modelPolicy }
                      : {}),
                    ...identity,
                    ...budget,
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
              meta: { task: entry.task, model: entry.model, ...identity },
            },
          });
        }
      })
      .catch((err) => this.logger.warn(`trace write failed: ${String(err).slice(0, 200)}`));
  }
}
