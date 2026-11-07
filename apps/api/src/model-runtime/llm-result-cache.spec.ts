import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeLlmResultCache,
  configureLlmResultCache,
  createPrismaLlmResultCache,
  DEFAULT_LLM_CACHE_TTL_HOURS,
  llmResultCacheEnabled,
  llmResultCacheKey,
  llmResultCacheTtlHours,
} from './llm-result-cache';

const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';

const keyMaterial = {
  workspaceId: WORKSPACE_ID,
  task: 'discovery.extract_list',
  contractVersion: 'structured-task-contract/discovery.extract_list/v1',
  promptVersion: 'structured-task-contract/discovery.extract_list/v1/prompt-v1',
  model: 'deepseek-flash',
  requestDigest: 'a'.repeat(64),
  schemaDigest: 'b'.repeat(64),
  reasoning: 'none',
};

afterEach(() => {
  configureLlmResultCache(null);
  vi.unstubAllEnvs();
});

describe('llmResultCacheEnabled', () => {
  it('defaults on and only turns off on explicit off', () => {
    expect(llmResultCacheEnabled({})).toBe(true);
    expect(llmResultCacheEnabled({ ACQ_LLM_CACHE: 'off' })).toBe(false);
    expect(llmResultCacheEnabled({ ACQ_LLM_CACHE: 'OFF ' })).toBe(false);
    expect(llmResultCacheEnabled({ ACQ_LLM_CACHE: 'on' })).toBe(true);
  });
});

describe('llmResultCacheTtlHours', () => {
  it('defaults to 24h, rejects invalid values and clamps to 7 days', () => {
    expect(llmResultCacheTtlHours({})).toBe(DEFAULT_LLM_CACHE_TTL_HOURS);
    expect(llmResultCacheTtlHours({ ACQ_LLM_CACHE_TTL_HOURS: '6' })).toBe(6);
    expect(llmResultCacheTtlHours({ ACQ_LLM_CACHE_TTL_HOURS: '-1' })).toBe(24);
    expect(llmResultCacheTtlHours({ ACQ_LLM_CACHE_TTL_HOURS: 'NaN' })).toBe(24);
    expect(llmResultCacheTtlHours({ ACQ_LLM_CACHE_TTL_HOURS: '10000' })).toBe(24 * 7);
  });
});

describe('llmResultCacheKey', () => {
  it('is stable across field order and changes with every key component', () => {
    const base = llmResultCacheKey(keyMaterial);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(
      llmResultCacheKey({
        reasoning: keyMaterial.reasoning,
        schemaDigest: keyMaterial.schemaDigest,
        requestDigest: keyMaterial.requestDigest,
        model: keyMaterial.model,
        promptVersion: keyMaterial.promptVersion,
        contractVersion: keyMaterial.contractVersion,
        task: keyMaterial.task,
        workspaceId: keyMaterial.workspaceId,
      }),
    ).toBe(base);
    for (const patch of [
      { workspaceId: '44444444-4444-4444-8444-444444444444' },
      { task: 'discovery.extract_company' },
      { contractVersion: 'v2' },
      { promptVersion: 'p2' },
      { model: 'other-model' },
      { requestDigest: 'c'.repeat(64) },
      { schemaDigest: 'd'.repeat(64) },
      { reasoning: 'high' },
    ]) {
      expect(llmResultCacheKey({ ...keyMaterial, ...patch })).not.toBe(base);
    }
  });
});

describe('activeLlmResultCache', () => {
  it('returns the configured store only while enabled', () => {
    const store = { get: vi.fn(async () => null), put: vi.fn(async () => undefined) };
    configureLlmResultCache(store);
    expect(activeLlmResultCache({})).toBe(store);
    expect(activeLlmResultCache({ ACQ_LLM_CACHE: 'off' })).toBeNull();
    configureLlmResultCache(null);
    expect(activeLlmResultCache({})).toBeNull();
  });
});

function fakeDb(rows: unknown[] = []) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ text: strings.join('$'), values });
      return rows;
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ text: strings.join('$'), values });
      return 1;
    }),
  };
  const withWorkspace = vi.fn(
    async (_workspaceId: string, fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  );
  return { db: { withWorkspace }, queries, withWorkspace };
}

describe('createPrismaLlmResultCache', () => {
  it('treats non-UUID scopes (platform) as no-ops', async () => {
    const { db, withWorkspace } = fakeDb();
    const cache = createPrismaLlmResultCache(db);
    expect(await cache.get('platform', 'k')).toBeNull();
    await cache.put('platform', 'k', 'task', { ok: true }, 24);
    expect(withWorkspace).not.toHaveBeenCalled();
  });

  it('reads only unexpired rows in a workspace-scoped transaction', async () => {
    const { db, queries, withWorkspace } = fakeDb([{ result: { is_directory: true } }]);
    const cache = createPrismaLlmResultCache(db);

    const hit = await cache.get(WORKSPACE_ID, 'k'.repeat(64));

    expect(hit).toEqual({ result: { is_directory: true } });
    expect(withWorkspace).toHaveBeenCalledWith(WORKSPACE_ID, expect.any(Function));
    expect(queries[0]!.text).toContain('FROM llm_extraction_cache');
    expect(queries[0]!.text).toContain('expires_at > statement_timestamp()');
    expect(queries[0]!.values).toContain(WORKSPACE_ID);
    expect(queries[0]!.values).toContain('k'.repeat(64));
  });

  it('upserts JSONB results with the requested TTL and purges expired rows', async () => {
    const fixedNow = new Date('2026-11-08T00:00:00.000Z');
    const { db, queries } = fakeDb();
    const cache = createPrismaLlmResultCache(db, { now: () => fixedNow });

    await cache.put(WORKSPACE_ID, 'k'.repeat(64), 'discovery.extract_list', { ok: 1 }, 6);

    expect(queries).toHaveLength(2);
    expect(queries[0]!.text).toContain('INSERT INTO llm_extraction_cache');
    expect(queries[0]!.text).toContain('ON CONFLICT (workspace_id, cache_key) DO UPDATE');
    expect(queries[0]!.values).toContain('{"ok":1}');
    expect(
      queries[0]!.values.some(
        (value) => value instanceof Date && value.toISOString() === '2026-11-08T06:00:00.000Z',
      ),
    ).toBe(true);
    expect(queries[1]!.text).toContain('DELETE FROM llm_extraction_cache');
  });
});
