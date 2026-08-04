import { describe, expect, it, vi } from 'vitest';
import {
  isLangfuseCollectorAllowed,
  isLangfuseProjectKeyPair,
  OTelRuntimeTelemetry,
  startLangfuseRuntimeTelemetry,
  WarningSpanExporter,
} from './langfuse-runtime-telemetry';
import { ExportResultCode } from '@opentelemetry/core';

describe('OTelRuntimeTelemetry', () => {
  it('exports only bounded metadata and never prompt, output, or context content', () => {
    const end = vi.fn();
    const startSpan = vi.fn(() => ({ end }));
    const telemetry = new OTelRuntimeTelemetry({ startSpan });

    telemetry.emit({
      executionId: 'execution-1',
      state: 'repaired',
      taskId: 'site_builder.copy',
      taskVersion: 'v1',
      workspaceId: 'workspace-1',
      contextDigest: 'a'.repeat(64),
      requestedAlias: 'gpt-5.6-terra',
      resolvedAlias: 'gpt-5.6-terra',
      protocol: 'openai_responses',
      reasoning: 'high',
      fallbackIndex: 2,
      detail: {
        repairAttempt: 1,
        prompt: 'must-not-leak',
        output: 'must-not-leak',
      },
    });

    const attributes = startSpan.mock.calls[0]![1]!.attributes;
    expect(attributes).toMatchObject({
      'model.runtime.execution_id_digest': expect.stringMatching(/^[0-9a-f]{64}$/),
      'model.runtime.task_id': 'site_builder.copy',
      'model.runtime.context_digest': 'a'.repeat(64),
      'model.runtime.repair_attempt': 1,
      'model.runtime.reasoning': 'high',
      'model.runtime.fallback_index': 2,
    });
    expect(attributes).not.toHaveProperty('model.runtime.execution_id');
    expect(attributes).not.toHaveProperty('model.runtime.workspace_id');
    expect(JSON.stringify(attributes)).not.toContain('must-not-leak');
    expect(end).toHaveBeenCalledOnce();
  });

  it('is fail-open when the tracer throws', () => {
    const warn = vi.fn();
    const telemetry = new OTelRuntimeTelemetry({
      startSpan: () => {
        throw new Error('collector unavailable');
      },
    }, { warn });
    expect(() =>
      telemetry.emit({
        executionId: 'execution-1',
        state: 'completed',
        taskId: 'site_builder.copy',
        taskVersion: 'v1',
        workspaceId: 'workspace-1',
        contextDigest: 'a'.repeat(64),
        requestedAlias: 'claude-sonnet-5',
        resolvedAlias: 'claude-sonnet-5',
        protocol: 'anthropic_messages',
        reasoning: 'medium',
        fallbackIndex: 0,
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('telemetry span dropped'));
  });

  it('rate limits local drop warnings while remaining fail-open', () => {
    const warn = vi.fn();
    const telemetry = new OTelRuntimeTelemetry(
      { startSpan: () => { throw new Error('offline'); } },
      { warn, now: () => 10_000, warningIntervalMs: 60_000 },
    );
    const event = {
      executionId: 'execution-1',
      state: 'completed' as const,
      taskId: 'site_builder.copy',
      taskVersion: 'v1',
      workspaceId: 'workspace-1',
      contextDigest: 'a'.repeat(64),
      requestedAlias: 'gpt-5.6-sol',
      resolvedAlias: 'gpt-5.6-sol',
      protocol: 'openai_responses' as const,
      reasoning: 'high' as const,
      fallbackIndex: 1,
    };

    telemetry.emit(event);
    telemetry.emit(event);

    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('Langfuse collector admission', () => {
  it('allows loopback HTTP and requires HTTPS for remote export', () => {
    expect(isLangfuseCollectorAllowed('http://127.0.0.1:3002', false)).toBe(true);
    expect(isLangfuseCollectorAllowed('http://localhost:3002', false)).toBe(true);
    expect(isLangfuseCollectorAllowed('http://collector.example', true)).toBe(false);
    expect(isLangfuseCollectorAllowed('https://collector.example', false)).toBe(false);
    expect(isLangfuseCollectorAllowed('https://collector.example', true)).toBe(true);
  });

  it('accepts only the Langfuse project key prefixes', () => {
    expect(isLangfuseProjectKeyPair('pk-lf-public', 'sk-lf-secret')).toBe(true);
    expect(isLangfuseProjectKeyPair('random-public', 'random-secret')).toBe(false);
  });

  it('warns when tracing is explicitly enabled with incomplete configuration', async () => {
    const warn = vi.fn();

    const lifecycle = await startLangfuseRuntimeTelemetry(
      { LANGFUSE_TRACING_ENABLED: 'true', LANGFUSE_PUBLIC_KEY: 'pk-lf-public' },
      { warn },
    );

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('incomplete'));
    expect(() => lifecycle.telemetry.emit({} as never)).not.toThrow();
  });
});

describe('WarningSpanExporter', () => {
  it('surfaces asynchronous collector failures without changing export completion', () => {
    const warn = vi.fn();
    const callback = vi.fn();
    const inner = {
      export: (_spans: never[], done: (result: { code: ExportResultCode }) => void) => {
        done({ code: ExportResultCode.FAILED });
      },
      shutdown: async () => undefined,
    };
    const exporter = new WarningSpanExporter(inner, { warn });

    exporter.export([], callback);
    exporter.export([], callback);

    expect(callback).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('export failed'));
  });
});
