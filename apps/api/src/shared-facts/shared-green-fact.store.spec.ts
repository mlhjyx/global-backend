import { describe, expect, it, vi } from 'vitest';
import {
  InMemorySharedFactRepository,
  RedisSharedFactRepository,
  SharedGreenFactStore,
  sharedGreenFactRedisKey,
  type RedisSharedFactClient,
} from './shared-green-fact.store';

describe('SharedGreenFactStore (Redis + InMemory pluggable repository)', () => {
  it('stores sanitized green facts, expires them cleanly, and blocks imported_buyer writes', async () => {
    const repo = new InMemorySharedFactRepository();
    const store = new SharedGreenFactStore(repo);
    const now = new Date('2026-11-26T00:00:00.000Z');

    const blocked = await store.putFromRaw(
      {
        domain: 'private-list.de',
        legalName: 'Private List GmbH',
        isImportedBuyer: true,
      },
      { now },
    );
    expect(blocked.stored).toBe(false);
    if (!blocked.stored) expect(blocked.reason).toBe('IMPORTED_BUYER_FORBIDDEN');
    expect(await store.get('private-list.de', now.getTime())).toBeNull();

    const stored = await store.putFromRaw(
      {
        workspaceId: 'ws-must-never-leak',
        domain: 'https://www.rexel.de',
        legalName: 'Rexel Germany GmbH',
        country: 'DE',
        tradeRole: 'distributor',
        emails: ['sales@rexel.de', 'alice.smith@rexel.de'],
        socialLinks: ['https://www.linkedin.com/company/rexel-germany'],
      },
      { now, ttlDays: 14 },
    );
    expect(stored.stored).toBe(true);
    const loaded = await store.get('REXEL.DE', now.getTime() + 1000);
    expect(loaded).not.toBeNull();
    expect(loaded?.roleEmails).toEqual(['sales@rexel.de']);
    expect(JSON.stringify(loaded)).not.toContain('ws-must-never-leak');
    expect(JSON.stringify(loaded)).not.toContain('alice.smith');

    // Expired after 15 days
    const afterExpiry = await store.get('rexel.de', now.getTime() + 15 * 24 * 60 * 60 * 1000);
    expect(afterExpiry).toBeNull();
  });

  it('persists to Redis with PX TTL and rejects tampered/PII Redis entries on read', async () => {
    const kv = new Map<string, string>();
    const setSpy = vi.fn(async (key: string, value: string) => {
      kv.set(key, value);
      return 'OK';
    });
    const client: RedisSharedFactClient = {
      get: vi.fn(async (key: string) => kv.get(key) ?? null),
      set: setSpy,
      del: vi.fn(async (...keys: string[]) => {
        let count = 0;
        for (const k of keys) if (kv.delete(k)) count += 1;
        return count;
      }),
    };
    const store = new SharedGreenFactStore(new RedisSharedFactRepository(client));
    const now = new Date('2026-11-26T00:00:00.000Z');

    const res = await store.putFromRaw(
      {
        domain: 'ibc-solar.de',
        legalName: 'IBC SOLAR AG',
        country: 'DE',
        tradeRole: 'distributor',
        emails: ['info@ibc-solar.de'],
      },
      { now, ttlDays: 21 },
    );
    expect(res.stored).toBe(true);
    expect(setSpy).toHaveBeenCalledWith(
      sharedGreenFactRedisKey('ibc-solar.de'),
      expect.any(String),
      'PX',
      21 * 24 * 60 * 60 * 1000,
    );

    const hit = await store.get('ibc-solar.de', now.getTime() + 1_000);
    expect(hit?.legalName).toBe('IBC SOLAR AG');

    // Tamper Redis payload with workspaceId -> fail-closed read returns null
    const key = sharedGreenFactRedisKey('ibc-solar.de');
    const tampered = JSON.parse(kv.get(key)!);
    tampered.workspaceId = 'ws-injected';
    kv.set(key, JSON.stringify(tampered));
    expect(await store.get('ibc-solar.de', now.getTime() + 2_000)).toBeNull();
  });

  it('degrades safely to fallback repository when primary Redis fails', async () => {
    const failingRedis: RedisSharedFactClient = {
      get: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      set: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      del: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    };
    const fallback = new InMemorySharedFactRepository();
    const store = new SharedGreenFactStore(new RedisSharedFactRepository(failingRedis), fallback);
    const now = new Date('2026-11-26T00:00:00.000Z');

    const writeRes = await store.putFromRaw(
      { domain: 'fallback-solar.es', legalName: 'Fallback Solar SL' },
      { now },
    );
    expect(writeRes.stored).toBe(true);
    expect(writeRes.degraded).toBe(true);
    expect(store.getDegradedErrorCount()).toBe(1);

    const readHit = await store.get('fallback-solar.es', now.getTime() + 1_000);
    expect(readHit?.legalName).toBe('Fallback Solar SL');
  });
});
