import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  DomainCooldownService,
  InMemoryDomainCooldownBackend,
  RedisDomainCooldownBackend,
  type RedisDomainCooldownClient,
} from './domain-cooldown.service';

const TEST_PEPPER = 'test-adr003-cooldown-secret-pepper-32chars';
const DAY_MS = 24 * 60 * 60 * 1000;

describe('DomainCooldownService (30-day HMAC cross-tenant collision cooldown)', () => {
  it('uses peppered HMAC-SHA256 (never unsalted SHA-256) and never leaks domain or workspaceId', async () => {
    const backend = new InMemoryDomainCooldownBackend();
    const service = new DomainCooldownService({
      pepper: TEST_PEPPER,
      backend,
      fallbackBackend: backend,
      maxDistinctWorkspaces30d: 3,
    });
    const t0 = Date.parse('2026-11-01T00:00:00.000Z');

    const unsaltedDomainSha = createHash('sha256').update('memodo.de', 'utf8').digest('hex');
    const hmac = service.computeDomainHmac('memodo.de');
    expect(hmac).not.toBe(unsaltedDomainSha);

    const key = service.cooldownRedisKey('memodo.de');
    expect(key).toBe(`{global:p3:domain-cooldown:${hmac}}`);
    expect(key).not.toContain('memodo.de');

    // Same workspace touching twice does NOT inflate distinct count
    const first = await service.recordTouch('https://www.Memodo.de/', 'ws-alpha-secret', { nowMs: t0 });
    const dup = await service.recordTouch('memodo.de', 'ws-alpha-secret', { nowMs: t0 + 60_000 });
    expect(first).toEqual({
      cooledDown: false,
      distinctWorkspaces30d: 1,
      retryAfterDays: 0,
      advisoryOnly: true,
    });
    expect(dup.distinctWorkspaces30d).toBe(1);

    // Distinct workspaces accumulate until threshold = 3
    await service.recordTouch('memodo.de', 'ws-beta-secret', { nowMs: t0 + 5 * DAY_MS });
    const third = await service.recordTouch('memodo.de', 'ws-gamma-secret', { nowMs: t0 + 10 * DAY_MS });
    expect(third).toEqual({
      cooledDown: true,
      distinctWorkspaces30d: 3,
      retryAfterDays: 21, // ws-alpha refreshed at t0 + 60s expires at t0 + 30d + 60s => ceil(20d + 60s) = 21d
      advisoryOnly: true,
    });

    // Check from a 4th tenant returns only anonymized aggregate status (no tenant IDs)
    const check = await service.checkCooldown('memodo.de', { nowMs: t0 + 10 * DAY_MS });
    expect(check).toEqual({
      cooledDown: true,
      distinctWorkspaces30d: 3,
      retryAfterDays: 21,
      advisoryOnly: true,
    });
    const responseJson = JSON.stringify(check);
    expect(responseJson).not.toContain('ws-alpha');
    expect(responseJson).not.toContain('ws-beta');
    expect(responseJson).not.toContain('ws-gamma');
    expect(responseJson).not.toContain('memodo.de');

    // Stored backend keys and members contain zero raw workspace IDs or domains
    const storedKeys = backend.storedKeys();
    const storedMembers = backend.storedMembers(key);
    expect(storedKeys).toEqual([key]);
    expect(storedMembers).toHaveLength(3);
    for (const member of storedMembers) {
      expect(member).not.toContain('ws-');
      expect(member).not.toContain('memodo');
    }

    // Same workspace across two domains gets unlinkable HMAC members
    expect(service.computeWorkspaceTouchMember('memodo.de', 'ws-alpha-secret')).not.toBe(
      service.computeWorkspaceTouchMember('rexel.de', 'ws-alpha-secret'),
    );

    // Sliding window expires oldest touch after 30 days -> drops from 3 to 2 -> no longer cooled down
    const afterExpiry = await service.checkCooldown('memodo.de', { nowMs: t0 + 31 * DAY_MS });
    expect(afterExpiry).toEqual({
      cooledDown: false,
      distinctWorkspaces30d: 2,
      retryAfterDays: 0,
      advisoryOnly: true,
    });
  });

  it('works over Redis ZSET commands with sliding window pruning and PEXPIRE', async () => {
    const zsets = new Map<string, Map<string, number>>();
    const redisClient: RedisDomainCooldownClient = {
      zremrangebyscore: vi.fn(async (key: string, _min: string | number, max: string | number) => {
        const bucket = zsets.get(key);
        if (!bucket) return 0;
        const maxNum = Number(max);
        let removed = 0;
        for (const [m, s] of bucket.entries()) {
          if (s <= maxNum) {
            bucket.delete(m);
            removed += 1;
          }
        }
        return removed;
      }),
      zadd: vi.fn(async (key: string, score: number, member: string) => {
        let bucket = zsets.get(key);
        if (!bucket) {
          bucket = new Map();
          zsets.set(key, bucket);
        }
        const existed = bucket.has(member);
        bucket.set(member, score);
        return existed ? 0 : 1;
      }),
      pexpire: vi.fn(async () => 1),
      zcard: vi.fn(async (key: string) => zsets.get(key)?.size ?? 0),
      zrange: vi.fn(async (key: string, start: number, stop: number) => {
        const entries = [...(zsets.get(key)?.entries() ?? [])].sort((a, b) => a[1] - b[1]);
        const sliced = entries.slice(start, stop + 1);
        const flat: string[] = [];
        for (const [m, s] of sliced) flat.push(m, String(s));
        return flat;
      }),
    };

    const service = new DomainCooldownService({
      pepper: TEST_PEPPER,
      backend: new RedisDomainCooldownBackend(redisClient),
      maxDistinctWorkspaces30d: 2,
    });
    const t0 = Date.parse('2026-11-10T00:00:00.000Z');
    await service.recordTouch('ibc-solar.de', 'ws-1', { nowMs: t0 });
    const second = await service.recordTouch('ibc-solar.de', 'ws-2', { nowMs: t0 + 2 * DAY_MS });
    expect(second).toEqual({
      cooledDown: true,
      distinctWorkspaces30d: 2,
      retryAfterDays: 28,
      advisoryOnly: true,
    });
    expect(redisClient.pexpire).toHaveBeenCalledWith(
      service.cooldownRedisKey('ibc-solar.de'),
      30 * DAY_MS,
    );
  });

  it('degrades safely to in-memory fallback on Redis outage and fails closed when pepper is missing', async () => {
    const brokenRedis: RedisDomainCooldownClient = {
      zremrangebyscore: vi.fn(async () => {
        throw new Error('READONLY');
      }),
      zadd: vi.fn(async () => {
        throw new Error('READONLY');
      }),
      pexpire: vi.fn(async () => {
        throw new Error('READONLY');
      }),
      zcard: vi.fn(async () => {
        throw new Error('READONLY');
      }),
      zrange: vi.fn(async () => {
        throw new Error('READONLY');
      }),
    };
    const fallback = new InMemoryDomainCooldownBackend();
    const degradedSvc = new DomainCooldownService({
      pepper: TEST_PEPPER,
      backend: new RedisDomainCooldownBackend(brokenRedis),
      fallbackBackend: fallback,
      maxDistinctWorkspaces30d: 1,
    });
    const t0 = Date.parse('2026-11-26T00:00:00.000Z');
    const touched = await degradedSvc.recordTouch('sun-solar.de', 'ws-1', { nowMs: t0 });
    expect(touched).toEqual({
      cooledDown: true,
      distinctWorkspaces30d: 1,
      retryAfterDays: 30,
      advisoryOnly: true,
      degraded: true,
    });
    expect(degradedSvc.getDegradedErrorCount()).toBe(1);

    // Missing or too-short pepper must NEVER silently use unsalted SHA-256
    const unconfigured = new DomainCooldownService({ pepper: 'too-short' });
    expect(unconfigured.isConfigured()).toBe(false);
    expect(() => unconfigured.computeDomainHmac('sun-solar.de')).toThrow(
      /ADR003_COOLDOWN_PEPPER_NOT_CONFIGURED/,
    );
    const status = await unconfigured.checkCooldown('sun-solar.de');
    expect(status).toEqual({
      cooledDown: false,
      distinctWorkspaces30d: 0,
      retryAfterDays: 0,
      advisoryOnly: true,
      degraded: true,
    });
  });
});
