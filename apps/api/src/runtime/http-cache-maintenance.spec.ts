import { describe, expect, it, vi } from 'vitest';
import {
  HTTP_CACHE_MAINTENANCE_INTERVAL_MS,
  HTTP_CACHE_PURGE_BATCH,
  purgeExpiredHttpCaches,
  startHttpCacheMaintenance,
} from './http-cache-maintenance';

function fakeDb(sequences: { urlContent: number[]; llmExtraction: number[] }) {
  const remaining = {
    urlContent: [...sequences.urlContent],
    llmExtraction: [...sequences.llmExtraction],
  };
  const db = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('purge_expired_url_content_cache_v1')) {
        return [{ deleted: remaining.urlContent.shift() ?? 0 }];
      }
      if (sql.includes('purge_expired_llm_extraction_cache_v1')) {
        return [{ deleted: remaining.llmExtraction.shift() ?? 0 }];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
  return db;
}

describe('purgeExpiredHttpCaches', () => {
  it('drains both tables in bounded batches and reports totals', async () => {
    const db = fakeDb({
      urlContent: [HTTP_CACHE_PURGE_BATCH, HTTP_CACHE_PURGE_BATCH, 123],
      llmExtraction: [7],
    });
    const log = vi.fn();

    const result = await purgeExpiredHttpCaches(db, log);

    expect(result).toEqual({ urlContent: HTTP_CACHE_PURGE_BATCH * 2 + 123, llmExtraction: 7 });
    // 3 batches (full, full, short) for url_content + 1 for llm_extraction.
    expect(db.$queryRaw).toHaveBeenCalledTimes(4);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('[http-cache] purged expired rows'),
    );
  });

  it('stops batching at the per-run cap even when more expired rows remain', async () => {
    const db = fakeDb({
      urlContent: Array(10).fill(HTTP_CACHE_PURGE_BATCH),
      llmExtraction: [],
    });

    const result = await purgeExpiredHttpCaches(db, () => {});

    expect(result.urlContent).toBe(HTTP_CACHE_PURGE_BATCH * 10);
    expect(db.$queryRaw).toHaveBeenCalledTimes(11); // 10 url batches + 1 empty llm batch
  });

  it('logs nothing when there is nothing to purge', async () => {
    const db = fakeDb({ urlContent: [0], llmExtraction: [0] });
    const log = vi.fn();
    await purgeExpiredHttpCaches(db, log);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('startHttpCacheMaintenance', () => {
  it('runs once immediately and can be stopped', async () => {
    const db = fakeDb({ urlContent: [0, 0], llmExtraction: [0, 0] });

    const stop = startHttpCacheMaintenance(db, {
      intervalMs: HTTP_CACHE_MAINTENANCE_INTERVAL_MS,
      log: () => {},
      warn: () => {},
    });
    await vi.waitFor(() => expect(db.$queryRaw).toHaveBeenCalledTimes(2));
    stop();
    expect(typeof stop).toBe('function');
  });

  it('keeps the worker alive-on-error: a failing purge only warns', async () => {
    const db = {
      $queryRaw: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    const warn = vi.fn();
    const stop = startHttpCacheMaintenance(db, { log: () => {}, warn });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    stop();
    expect(warn.mock.calls[0]?.[0]).toContain('[http-cache] purge failed');
  });
});
