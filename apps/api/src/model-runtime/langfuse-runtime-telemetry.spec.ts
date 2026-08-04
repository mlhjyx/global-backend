import { describe, expect, it, vi } from 'vitest';
import { OTelRuntimeTelemetry } from './langfuse-runtime-telemetry';

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
    });
    expect(attributes).not.toHaveProperty('model.runtime.execution_id');
    expect(attributes).not.toHaveProperty('model.runtime.workspace_id');
    expect(JSON.stringify(attributes)).not.toContain('must-not-leak');
    expect(end).toHaveBeenCalledOnce();
  });

  it('is fail-open when the tracer throws', () => {
    const telemetry = new OTelRuntimeTelemetry({
      startSpan: () => {
        throw new Error('collector unavailable');
      },
    });
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
      }),
    ).not.toThrow();
  });
});
