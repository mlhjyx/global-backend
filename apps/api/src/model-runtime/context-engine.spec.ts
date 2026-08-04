import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ContextEngine, stableSerialize } from './context-engine';

const digest = (content: unknown): string =>
  createHash('sha256').update(stableSerialize(content)).digest('hex');

describe('ContextEngine', () => {
  it('allows only declared sources, verifies digests and produces stable kind/source ordering', () => {
    const engine = new ContextEngine();
    const facts = { claim: 'ISO certified' };
    const request = { locale: 'de-DE' };

    const first = engine.assemble({
      workspaceId: 'ws-1',
      policy: { version: 'ctx/v1', allowedSourceRefs: ['request:v1', 'claims:v2'] },
      segments: [
        {
          kind: 'request',
          sourceRef: 'request:v1',
          sourceDigest: digest(request),
          sensitivity: 'workspace',
          cacheClass: 'request-local',
          estimatedTokens: 20,
          content: request,
        },
        {
          kind: 'facts',
          sourceRef: 'claims:v2',
          sourceDigest: digest(facts),
          sensitivity: 'workspace',
          cacheClass: 'stable-prefix',
          estimatedTokens: 30,
          content: facts,
        },
      ],
      budget: { contextWindow: 1_000, outputReserve: 100, reasoningReserve: 50 },
    });
    const second = engine.assemble({
      workspaceId: 'ws-1',
      policy: { version: 'ctx/v1', allowedSourceRefs: ['claims:v2', 'request:v1'] },
      segments: [...first.segments].reverse(),
      budget: { contextWindow: 1_000, outputReserve: 100, reasoningReserve: 50 },
    });

    expect(first.segments.map((segment) => segment.kind)).toEqual(['facts', 'request']);
    expect(second.digest).toBe(first.digest);
    expect(first.estimatedTokens).toBe(50);
  });

  it('rejects undeclared sources and content whose digest drifted', () => {
    const engine = new ContextEngine();
    const base = {
      workspaceId: 'ws-1',
      policy: { version: 'ctx/v1', allowedSourceRefs: ['claims:v1'] },
      budget: { contextWindow: 100, outputReserve: 10, reasoningReserve: 10 },
    };

    expect(() =>
      engine.assemble({
        ...base,
        segments: [{
          kind: 'facts', sourceRef: 'other:v1', sourceDigest: digest('x'), sensitivity: 'public',
          cacheClass: 'stable-prefix', estimatedTokens: 1, content: 'x',
        }],
      }),
    ).toThrow(/not allowed/);
    expect(() =>
      engine.assemble({
        ...base,
        segments: [{
          kind: 'facts', sourceRef: 'claims:v1', sourceDigest: digest('before'), sensitivity: 'public',
          cacheClass: 'stable-prefix', estimatedTokens: 1, content: 'after',
        }],
      }),
    ).toThrow(/digest mismatch/);
  });

  it('rejects non-JSON objects instead of collapsing their hidden state into the same digest', () => {
    expect(() => stableSerialize(new Date('2026-08-04T00:00:00.000Z'))).toThrow(/non-plain/);
    expect(() => stableSerialize(new Map([['claim', 'x']]))).toThrow(/non-plain/);
  });

  it('reserves output/reasoning capacity and deterministically drops the least relevant optional segments', () => {
    const engine = new ContextEngine();
    const make = (sourceRef: string, estimatedTokens: number, relevance: number) => ({
      kind: 'facts' as const,
      sourceRef,
      sourceDigest: digest(sourceRef),
      sensitivity: 'workspace' as const,
      cacheClass: 'stable-prefix' as const,
      estimatedTokens,
      relevance,
      content: sourceRef,
    });

    const envelope = engine.assemble({
      workspaceId: 'ws-1',
      policy: { version: 'ctx/v1', allowedSourceRefs: ['high', 'low'] },
      segments: [make('low', 50, 1), make('high', 50, 10)],
      budget: { contextWindow: 120, outputReserve: 20, reasoningReserve: 20 },
    });

    expect(envelope.segments.map((segment) => segment.sourceRef)).toEqual(['high']);
    expect(envelope.droppedSourceRefs).toEqual(['low']);
  });
});
