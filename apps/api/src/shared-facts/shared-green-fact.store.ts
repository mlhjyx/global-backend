import { createHash } from 'node:crypto';
import {
  assertGreenCompanyFactClean,
  isGreenCompanyFactExpired,
  normalizeCompanyDomain,
  sanitizeToGreenCompanyFact,
  type GreenCompanyFact,
  type SanitizeGreenCompanyFactInput,
  type SanitizeGreenCompanyFactResult,
} from './green-company-fact';

export const SHARED_GREEN_FACT_REDIS_PREFIX = '{global:p3:green-fact:';
const MAX_IN_MEMORY_FACTS = 10_000;

export interface SharedFactRepository {
  getByDomain(normalizedDomain: string, nowMs?: number): Promise<GreenCompanyFact | null>;
  upsert(fact: GreenCompanyFact, nowMs?: number): Promise<void>;
  deleteByDomain(normalizedDomain: string): Promise<boolean>;
}

export interface RedisSharedFactClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, pxMode: 'PX', ttlMs: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
}

export function sharedGreenFactRedisKey(normalizedDomain: string): string {
  const digest = createHash('sha256').update(`green-fact:${normalizedDomain}`, 'utf8').digest('hex');
  return `${SHARED_GREEN_FACT_REDIS_PREFIX}${digest}}`;
}

export class InMemorySharedFactRepository implements SharedFactRepository {
  private readonly entries = new Map<string, GreenCompanyFact>();

  constructor(private readonly maxEntries = MAX_IN_MEMORY_FACTS) {}

  async getByDomain(normalizedDomain: string, nowMs = Date.now()): Promise<GreenCompanyFact | null> {
    const existing = this.entries.get(normalizedDomain);
    if (!existing) return null;
    if (isGreenCompanyFactExpired(existing, nowMs)) {
      this.entries.delete(normalizedDomain);
      return null;
    }
    return existing;
  }

  async upsert(fact: GreenCompanyFact): Promise<void> {
    assertGreenCompanyFactClean(fact);
    if (!this.entries.has(fact.domain) && this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.delete(fact.domain);
    this.entries.set(fact.domain, fact);
  }

  async deleteByDomain(normalizedDomain: string): Promise<boolean> {
    return this.entries.delete(normalizedDomain);
  }

  size(): number {
    return this.entries.size;
  }
}

export class RedisSharedFactRepository implements SharedFactRepository {
  constructor(private readonly client: RedisSharedFactClient) {}

  async getByDomain(normalizedDomain: string, nowMs = Date.now()): Promise<GreenCompanyFact | null> {
    const raw = await this.client.get(sharedGreenFactRedisKey(normalizedDomain));
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
      assertGreenCompanyFactClean(parsed);
    } catch {
      return null;
    }
    if (parsed.domain !== normalizedDomain || isGreenCompanyFactExpired(parsed, nowMs)) {
      return null;
    }
    return parsed;
  }

  async upsert(fact: GreenCompanyFact, nowMs = Date.now()): Promise<void> {
    assertGreenCompanyFactClean(fact);
    const expiresMs = Date.parse(fact.expiresAt);
    const ttlMs = Math.max(1_000, expiresMs - nowMs);
    await this.client.set(sharedGreenFactRedisKey(fact.domain), JSON.stringify(fact), 'PX', ttlMs);
  }

  async deleteByDomain(normalizedDomain: string): Promise<boolean> {
    const removed = await this.client.del(sharedGreenFactRedisKey(normalizedDomain));
    return removed > 0;
  }
}

export type SharedFactWriteOutcome =
  | {
      readonly stored: true;
      readonly degraded: boolean;
      readonly fact: GreenCompanyFact;
      readonly strippedPiiCount: number;
      readonly strippedReasons: readonly string[];
    }
  | {
      readonly stored: false;
      readonly degraded: boolean;
      readonly reason: string;
      readonly details: string;
    };

/**
 * Facade over a pluggable `SharedFactRepository` (Redis today, `platform_shared` PG tomorrow).
 * Enforces ADR-003 Layer 1 sanitization + clean assertion on every write and graceful degradation
 * if the backing store is temporarily unavailable.
 */
export class SharedGreenFactStore {
  private degradedErrors = 0;

  constructor(
    private readonly repository: SharedFactRepository,
    private readonly fallbackRepository?: SharedFactRepository,
  ) {}

  async get(rawDomain: string | null | undefined, nowMs = Date.now()): Promise<GreenCompanyFact | null> {
    const domain = normalizeCompanyDomain(rawDomain);
    if (!domain) return null;
    try {
      const hit = await this.repository.getByDomain(domain, nowMs);
      if (hit && !isGreenCompanyFactExpired(hit, nowMs)) {
        assertGreenCompanyFactClean(hit);
        return hit;
      }
      return null;
    } catch {
      this.degradedErrors += 1;
      if (!this.fallbackRepository) return null;
      try {
        const fallback = await this.fallbackRepository.getByDomain(domain, nowMs);
        if (fallback && !isGreenCompanyFactExpired(fallback, nowMs)) {
          assertGreenCompanyFactClean(fallback);
          return fallback;
        }
      } catch {
        // Swallow fallback errors so discovery never breaks on shared-cache outage.
      }
      return null;
    }
  }

  async putFromRaw(
    input: SanitizeGreenCompanyFactInput,
    opts: { now?: Date; ttlDays?: number } = {},
  ): Promise<SharedFactWriteOutcome> {
    const sanitized: SanitizeGreenCompanyFactResult = sanitizeToGreenCompanyFact(input, opts);
    if (!sanitized.accepted) {
      return {
        stored: false,
        degraded: false,
        reason: sanitized.reason,
        details: sanitized.details,
      };
    }
    const nowMs = (opts.now ?? new Date()).getTime();
    try {
      assertGreenCompanyFactClean(sanitized.fact);
      await this.repository.upsert(sanitized.fact, nowMs);
      return {
        stored: true,
        degraded: false,
        fact: sanitized.fact,
        strippedPiiCount: sanitized.strippedPiiCount,
        strippedReasons: sanitized.strippedReasons,
      };
    } catch {
      this.degradedErrors += 1;
      if (this.fallbackRepository) {
        try {
          await this.fallbackRepository.upsert(sanitized.fact, nowMs);
          return {
            stored: true,
            degraded: true,
            fact: sanitized.fact,
            strippedPiiCount: sanitized.strippedPiiCount,
            strippedReasons: sanitized.strippedReasons,
          };
        } catch {
          // Fall through to degraded failure outcome.
        }
      }
      return {
        stored: false,
        degraded: true,
        reason: 'STORE_UNAVAILABLE',
        details: 'Shared green fact repository unavailable; skipped write-back.',
      };
    }
  }

  async delete(rawDomain: string | null | undefined): Promise<boolean> {
    const domain = normalizeCompanyDomain(rawDomain);
    if (!domain) return false;
    try {
      return await this.repository.deleteByDomain(domain);
    } catch {
      this.degradedErrors += 1;
      return false;
    }
  }

  getDegradedErrorCount(): number {
    return this.degradedErrors;
  }
}
