import { describe, expect, it, vi } from 'vitest';
import {
  createPrismaUrlContentCache,
  isTenantWorkspaceId,
  urlContentCacheKey,
} from './url-content-cache';

const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

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
  return { db: { withWorkspace }, tx, queries, withWorkspace };
}

describe('urlContentCacheKey', () => {
  it('is stable and ignores the fragment', () => {
    expect(urlContentCacheKey('https://acme.example/about#team')).toBe(
      urlContentCacheKey('https://acme.example/about'),
    );
    expect(urlContentCacheKey('https://acme.example/about')).toMatch(/^[0-9a-f]{64}$/);
    expect(urlContentCacheKey('https://acme.example/a')).not.toBe(
      urlContentCacheKey('https://acme.example/b'),
    );
  });
});

describe('createPrismaUrlContentCache', () => {
  it('treats non-UUID scopes (platform) as no-ops', async () => {
    const { db, withWorkspace } = fakeDb([{ markdown: 'x', content_hash: 'h', etag: null, last_modified: null }]);
    const cache = createPrismaUrlContentCache(db);
    expect(isTenantWorkspaceId('platform')).toBe(false);
    expect(await cache.get('platform', 'https://acme.example/')).toBeNull();
    await cache.put('platform', 'https://acme.example/', {
      markdown: 'x',
      contentHash: 'h',
      etag: null,
      lastModified: null,
    });
    expect(withWorkspace).not.toHaveBeenCalled();
  });

  it('reads only unexpired rows inside a workspace-scoped transaction', async () => {
    const row = {
      markdown: 'cached body',
      content_hash: 'c'.repeat(64),
      etag: '"e"',
      last_modified: 'Mon, 03 Nov 2026 08:00:00 GMT',
    };
    const { db, queries, withWorkspace } = fakeDb([row]);
    const cache = createPrismaUrlContentCache(db);

    const hit = await cache.get(WORKSPACE_ID, 'https://acme.example/about');

    expect(withWorkspace).toHaveBeenCalledWith(WORKSPACE_ID, expect.any(Function));
    expect(hit).toEqual({
      markdown: 'cached body',
      contentHash: 'c'.repeat(64),
      etag: '"e"',
      lastModified: 'Mon, 03 Nov 2026 08:00:00 GMT',
    });
    expect(queries[0]!.text).toContain('FROM url_content_cache');
    expect(queries[0]!.text).toContain('expires_at > statement_timestamp()');
    expect(queries[0]!.values).toContain(WORKSPACE_ID);
    expect(queries[0]!.values).toContain(urlContentCacheKey('https://acme.example/about'));
  });

  it('returns null when no unexpired row exists', async () => {
    const { db } = fakeDb([]);
    const cache = createPrismaUrlContentCache(db);
    expect(await cache.get(WORKSPACE_ID, 'https://acme.example/')).toBeNull();
  });

  it('upserts with a 24h TTL and purges this workspace’s expired rows on write', async () => {
    const fixedNow = new Date('2026-11-08T00:00:00.000Z');
    const { db, queries, withWorkspace } = fakeDb();
    const cache = createPrismaUrlContentCache(db, { now: () => fixedNow });

    await cache.put(WORKSPACE_ID, 'https://acme.example/about', {
      markdown: 'fresh body',
      contentHash: 'd'.repeat(64),
      etag: '"fresh"',
      lastModified: 'Tue, 04 Nov 2026 09:00:00 GMT',
    });

    expect(withWorkspace).toHaveBeenCalledWith(WORKSPACE_ID, expect.any(Function));
    expect(queries).toHaveLength(2);
    expect(queries[0]!.text).toContain('INSERT INTO url_content_cache');
    expect(queries[0]!.text).toContain('ON CONFLICT (workspace_id, url_hash) DO UPDATE');
    expect(queries[0]!.values).toContain('fresh body');
    expect(
      queries[0]!.values.some(
        (value) => value instanceof Date && value.toISOString() === '2026-11-08T00:00:00.000Z',
      ),
    ).toBe(true);
    expect(
      queries[0]!.values.some(
        (value) => value instanceof Date && value.toISOString() === '2026-11-09T00:00:00.000Z',
      ),
    ).toBe(true);
    expect(queries[1]!.text).toContain('DELETE FROM url_content_cache');
    expect(queries[1]!.text).toContain('expires_at <= statement_timestamp()');
  });
});
