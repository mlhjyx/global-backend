import { trace, type Attributes, type Tracer } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
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

interface TelemetryWarningOptions {
  warn(message: string): void;
  now?: () => number;
  warningIntervalMs?: number;
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

const DEFAULT_WARNING_INTERVAL_MS = 60_000;
const DEFAULT_WARNING_OPTIONS: TelemetryWarningOptions = Object.freeze({
  warn: (message: string) => console.warn(`[model-runtime] ${message}`),
});

function warnFailOpen(warning: TelemetryWarningOptions, message: string): void {
  try {
    warning.warn(message);
  } catch {
    // Warning delivery must not become a second failure path.
  }
}

export class WarningSpanExporter implements SpanExporter {
  private lastWarningAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly inner: SpanExporter,
    private readonly warning: TelemetryWarningOptions = DEFAULT_WARNING_OPTIONS,
  ) {}

  private warnDropped(): void {
    const now = this.warning.now?.() ?? Date.now();
    const interval = this.warning.warningIntervalMs ?? DEFAULT_WARNING_INTERVAL_MS;
    if (now - this.lastWarningAt < interval) return;
    this.lastWarningAt = now;
    warnFailOpen(this.warning, 'Langfuse export failed: telemetry spans dropped');
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      this.inner.export(spans, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) this.warnDropped();
        resultCallback(result);
      });
    } catch (error) {
      this.warnDropped();
      resultCallback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  async forceFlush(): Promise<void> {
    try {
      await this.inner.forceFlush?.();
    } catch (error) {
      this.warnDropped();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.inner.shutdown();
    } catch (error) {
      this.warnDropped();
      throw error;
    }
  }
}

function identifierDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parsedCollector(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isLangfuseCollectorAllowed(
  value: string,
  remoteAllowed: boolean,
): boolean {
  const parsed = parsedCollector(value);
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) return false;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(
    parsed.hostname.toLowerCase(),
  );
  if (loopback) return true;
  return remoteAllowed && parsed.protocol === 'https:';
}

export function isLangfuseProjectKeyPair(
  publicKey: string,
  secretKey: string,
): boolean {
  return /^pk-lf-[a-z0-9-]+$/iu.test(publicKey)
    && /^sk-lf-[a-z0-9-]+$/iu.test(secretKey);
}

export class OTelRuntimeTelemetry implements RuntimeTelemetry {
  private lastWarningAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly tracer: RuntimeTracer = trace.getTracer(
      '@global/model-execution-runtime',
    ) as Tracer,
    private readonly warning: TelemetryWarningOptions = DEFAULT_WARNING_OPTIONS,
  ) {}

  private warnDropped(message: string): void {
    const now = this.warning.now?.() ?? Date.now();
    const interval = this.warning.warningIntervalMs ?? DEFAULT_WARNING_INTERVAL_MS;
    if (now - this.lastWarningAt < interval) return;
    this.lastWarningAt = now;
    try {
      this.warning.warn(message);
    } catch {
      // A broken warning sink is also a side channel and remains fail-open.
    }
  }

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
        'model.runtime.reasoning': event.reasoning,
        'model.runtime.fallback_index': event.fallbackIndex,
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
      this.warnDropped('telemetry span dropped: collector unavailable');
    }
  }
}

export interface LangfuseTelemetryLifecycle {
  telemetry: RuntimeTelemetry;
  shutdown(): Promise<void>;
}

export async function startLangfuseRuntimeTelemetry(
  env: NodeJS.ProcessEnv = process.env,
  warning: TelemetryWarningOptions = DEFAULT_WARNING_OPTIONS,
): Promise<LangfuseTelemetryLifecycle> {
  const tracingSetting = env.LANGFUSE_TRACING_ENABLED?.trim().toLowerCase();
  const disabled = tracingSetting === 'false';
  const explicitlyEnabled = tracingSetting === 'true';
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
  const baseUrl = env.LANGFUSE_BASE_URL?.trim();
  if (disabled) {
    return {
      telemetry: { emit: () => undefined },
      shutdown: async () => undefined,
    };
  }
  const hasAnyExporterConfig = Boolean(publicKey || secretKey || baseUrl);
  if (!explicitlyEnabled && !hasAnyExporterConfig) {
    return {
      telemetry: { emit: () => undefined },
      shutdown: async () => undefined,
    };
  }
  if (!publicKey || !secretKey || !baseUrl) {
    warnFailOpen(
      warning,
      'Langfuse exporter disabled: tracing configuration is incomplete',
    );
    return {
      telemetry: { emit: () => undefined },
      shutdown: async () => undefined,
    };
  }
  if (!isLangfuseProjectKeyPair(publicKey, secretKey)) {
    warnFailOpen(warning, 'Langfuse exporter disabled: invalid project key format');
    return {
      telemetry: { emit: () => undefined },
      shutdown: async () => undefined,
    };
  }
  const remoteAllowed = env.LANGFUSE_ALLOW_REMOTE_EXPORT?.trim().toLowerCase() === 'true';
  if (!isLangfuseCollectorAllowed(baseUrl, remoteAllowed)) {
    warnFailOpen(
      warning,
      'Langfuse exporter disabled: remote collectors require HTTPS and explicit authorization',
    );
    return {
      telemetry: { emit: () => undefined },
      shutdown: async () => undefined,
    };
  }

  try {
    const [{ NodeSDK }, { LangfuseSpanProcessor }, { OTLPTraceExporter }] = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@langfuse/otel'),
      import('@opentelemetry/exporter-trace-otlp-http'),
    ]);
    const authorization = Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
    const exporter = new WarningSpanExporter(
      new OTLPTraceExporter({
        url: `${baseUrl}/api/public/otel/v1/traces`,
        headers: {
          Authorization: `Basic ${authorization}`,
          'x-langfuse-public-key': publicKey,
          'x-langfuse-sdk-name': 'global-model-runtime',
        },
      }),
      warning,
    );
    const sdk = new NodeSDK({
      spanProcessors: [
        new LangfuseSpanProcessor({
          exporter,
          publicKey,
          secretKey,
          baseUrl,
          environment: env.LANGFUSE_TRACING_ENVIRONMENT ?? 'development',
          mediaUploadEnabled: false,
          shouldExportSpan: ({ otelSpan }) => otelSpan.name === 'model.runtime.state',
        }),
      ],
    });
    sdk.start();
    return {
      telemetry: new OTelRuntimeTelemetry(undefined, warning),
      shutdown: async () => {
        try {
          await sdk.shutdown();
        } catch {
          warnFailOpen(
            warning,
            'Langfuse exporter shutdown failed: telemetry may have been dropped',
          );
        }
      },
    };
  } catch {
    warnFailOpen(warning, 'Langfuse exporter initialization failed: telemetry disabled');
    return {
      telemetry: { emit: () => undefined },
      shutdown: async () => undefined,
    };
  }
}
