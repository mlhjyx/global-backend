import { describe, expect, it } from 'vitest';
import { InMemoryExactResultCache, exactResultCacheKey } from './exact-result-cache';
import type { ExactResultCacheIdentity } from './types';

const identity: ExactResultCacheIdentity = {
  workspaceId: 'ws-1',
  buildRunId: 'build-1',
  taskId: 'site_builder.copy',
  taskContractVersion: '2',
  promptVersion: 'copy/v2',
  schemaDigest: 'schema-a',
  inputDigest: 'input-a',
  contextDigest: 'context-a',
  promptDigest: 'prompt-a',
  resolvedAlias: 'gpt-terra',
  protocol: 'openai_responses',
  reasoning: 'medium',
  sampling: { temperature: 0.2 },
  locale: 'en-US',
};

describe('exact result cache', () => {
  it('keys every execution-shaping field and isolates workspaces', async () => {
    expect(exactResultCacheKey(identity)).not.toBe(exactResultCacheKey({ ...identity, reasoning: 'high' }));
    expect(exactResultCacheKey(identity)).not.toBe(exactResultCacheKey({ ...identity, schemaDigest: 'schema-b' }));
    expect(exactResultCacheKey(identity)).not.toBe(exactResultCacheKey({ ...identity, workspaceId: 'ws-2' }));
    expect(exactResultCacheKey(identity)).not.toBe(exactResultCacheKey({ ...identity, promptDigest: 'prompt-b' }));
    expect(exactResultCacheKey(identity)).not.toBe(exactResultCacheKey({
      ...identity,
      priorOutputDigest: 'prior-a',
      findingsDigest: 'findings-a',
    }));

    const cache = new InMemoryExactResultCache();
    const output = { headline: 'A' };
    await cache.put(identity, { output, settlement: 'known', validated: true });
    output.headline = 'mutated';
    await expect(cache.get({ ...identity, workspaceId: 'ws-2' })).resolves.toBeUndefined();
    await expect(cache.get(identity)).resolves.toMatchObject({ output: { headline: 'A' } });
  });

  it('rejects invalid and unknown-settlement results', async () => {
    const cache = new InMemoryExactResultCache();

    await expect(cache.put(identity, { output: {}, settlement: 'unknown', validated: true })).rejects.toThrow(/settlement/);
    await expect(cache.put(identity, { output: {}, settlement: 'known', validated: false })).rejects.toThrow(/validated/);
  });

  it('replays a repaired result through the original identity alias', async () => {
    const cache = new InMemoryExactResultCache();
    const repairIdentity = {
      ...identity,
      priorOutputDigest: 'prior-a',
      findingsDigest: 'findings-a',
    };

    await cache.putRepair(identity, repairIdentity, {
      output: { headline: 'Repaired' },
      settlement: 'known',
      validated: true,
    });

    await expect(cache.get(identity)).resolves.toMatchObject({
      output: { headline: 'Repaired' },
    });
  });
});
