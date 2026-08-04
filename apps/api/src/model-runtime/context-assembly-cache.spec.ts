import { describe, expect, it } from 'vitest';
import { canonicalDigest, ContextEngine } from './context-engine';
import {
  contextAssemblyCacheKey,
  InMemoryContextAssemblyCache,
} from './context-assembly-cache';

function envelope(workspaceId = 'ws-1') {
  const content = { claim: 'fact' };
  return new ContextEngine().assemble({
    workspaceId,
    policy: { version: 'copy-context/v1', allowedSourceRefs: ['facts:v1'] },
    segments: [{
      kind: 'facts',
      sourceRef: 'facts:v1',
      sourceDigest: canonicalDigest(content),
      sensitivity: 'workspace',
      cacheClass: 'request-local',
      estimatedTokens: 2,
      content,
    }],
    budget: { contextWindow: 1_000, outputReserve: 100, reasoningReserve: 100 },
  });
}

describe('InMemoryContextAssemblyCache', () => {
  it('isolates workspaces and naturally invalidates source or policy versions', async () => {
    const cache = new InMemoryContextAssemblyCache();
    const identity = {
      workspaceId: 'ws-1',
      sourceVersions: { claims: 'v1', brandProfile: 'v4' },
      contextPolicyVersion: 'copy-context/v1',
      locale: 'en-US',
    };
    await cache.put(identity, envelope());

    await expect(cache.get(identity)).resolves.toMatchObject({ workspaceId: 'ws-1' });
    await expect(cache.get({ ...identity, workspaceId: 'ws-2' })).resolves.toBeUndefined();
    await expect(cache.get({ ...identity, sourceVersions: { ...identity.sourceVersions, claims: 'v2' } })).resolves.toBeUndefined();
    await expect(cache.get({ ...identity, contextPolicyVersion: 'copy-context/v2' })).resolves.toBeUndefined();
    expect(contextAssemblyCacheKey(identity)).not.toBe(contextAssemblyCacheKey({ ...identity, locale: 'de-DE' }));
  });

  it('rejects cross-workspace envelopes and restricted segments', async () => {
    const cache = new InMemoryContextAssemblyCache();
    const identity = {
      workspaceId: 'ws-1',
      sourceVersions: { claims: 'v1' },
      contextPolicyVersion: 'copy-context/v1',
      locale: 'en-US',
    };
    await expect(cache.put(identity, envelope('ws-2'))).rejects.toThrow(/workspace/);
    const restricted = {
      ...envelope(),
      segments: envelope().segments.map((segment) => ({ ...segment, sensitivity: 'restricted' as const })),
    };
    await expect(cache.put(identity, restricted)).rejects.toThrow(/restricted/);
  });
});
