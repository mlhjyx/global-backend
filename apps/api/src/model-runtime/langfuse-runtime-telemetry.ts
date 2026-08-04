import { trace, type Attributes, type Tracer } from '@opentelemetry/api';
import { createHash } from 'node:crypto';
import type { RuntimeTelemetry, RuntimeTelemetryEvent } from './types';

interface SpanHandle {
  end(): void;
}

interface RuntimeTracer {
  startSpan(
    name: string,
    options: { attributes: Attributes },
  ): SpanHandle;
}

const SAFE_DETAIL_ATTRIBUTES = Object.freeze({
  cacheHit: 'model.runtime.cache_hit',
  transportAttempt: 'model.runtime.transport_attempt',
  repairAttempt: 'model.runtime.repair_attempt',
  reportedModel: 'model.runtime.reported_model',
  inputTokens: 'model.runtime.input_tokens',
  outputTokens: 'model.runtime.output_tokens',
  settlement: 'model.runtime.settlement',
} as const);

function identifierDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isLoopbackCollector(value: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(
      new URL(value).hostname.toLowerCase(),
    );
  } catch {
    return false;
  }
}

export class OTelRuntimeTelemetry implements RuntimeTelemetry {
  constructor(
    private readonly tracer: RuntimeTracer = trace.getTracer(
      '@global/model-execution-runtime',
    ) as Tracer,
  ) {}

  emit(event: RuntimeTelemetryEvent): void {
    try {
      const attributes: Attributes = {
        'model.runtime.execution_id_digest': identifierDigest(event.executionId),
        'model.runtime.state': event.state,
        'model.runtime.task_id': event.taskId,
        'model.runtime.task_version': event.taskVersion,
        'model.runtime.workspace_id_digest': identifierDigest(event.workspaceId),
        'model.runtime.context_digest': event.contextDigest,
        'model.runtime.requested_alias': event.requestedAlias,
        'model.runtime.resolved_alias': event.resolvedAlias,
        'model.runtime.protocol': event.protocol,
      };
      const requestId = event.detail?.requestId;
      if (typeof requestId === 'string') {
        attributes['model.runtime.request_id_digest'] = identifierDigest(requestId);
      }
      for (const [key, attribute] of Object.entries(SAFE_DETAIL_ATTRIBUTES)) {
        const value = event.detail?.[key];
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        ) {
          attributes[attribute] = value;
        }
      }
      this.tracer.startSpan('model.runtime.state', { attributes }).end();
    } catch {
      // Observability is a side channel and cannot change execution outcome.
    }
  }
}

export interface LangfuseTelemetryLifecycle {
  telemetry: RuntimeTelemetry;
  shutdown(): Promise<void>;
}

export async function startLangfuseRuntimeTelemetry(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LangfuseTelemetryLifecycle> {
  const disabled = env.LANGFUSE_TRACING_ENABLED?.trim().toLowerCase() === 'false';
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
  const baseUrl = env.LANGFUSE_BASE_URL?.trim();
  if (disabled || !publicKey || !secretKey || !baseUrl) {
    return {
      telemetry: { emit: () => undefined },
      shutdown: async () => undefined,
    };
  }
  const remoteAllowed = env.LANGFUSE_ALLOW_REMOTE_EXPORT?.trim().toLowerCase() === 'true';
  if (!isLoopbackCollector(baseUrl) && !remoteAllowed) {
    return {
      telemetry: { emit: () => undefined },
      shutdown: async () => undefined,
    };
  }

  try {
    const [{ NodeSDK }, { LangfuseSpanProcessor }] = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@langfuse/otel'),
    ]);
    const sdk = new NodeSDK({
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey,
          secretKey,
          baseUrl,
          environment: env.LANGFUSE_TRACING_ENVIRONMENT ?? 'development',
          shouldExportSpan: ({ otelSpan }) => otelSpan.name === 'model.runtime.state',
        }),
      ],
    });
    sdk.start();
    return {
      telemetry: new OTelRuntimeTelemetry(),
      shutdown: async () => {
        try {
          await sdk.shutdown();
        } catch {
          // A failed flush is observable locally but never changes BuildRun state.
        }
      },
    };
  } catch {
    return {
      telemetry: { emit: () => undefined },
      shutdown: async () => undefined,
    };
  }
}
