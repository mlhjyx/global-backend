import { createHmac } from 'node:crypto';
import { normalizeCompanyDomain } from './green-company-fact';

export const DEFAULT_COOLDOWN_WINDOW_DAYS = 30;
export const DEFAULT_COOLDOWN_THRESHOLD = 3;
export const MIN_COOLDOWN_PEPPER_LENGTH = 16;
export const DOMAIN_COOLDOWN_REDIS_PREFIX = '{global:p3:domain-cooldown:';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_IN_MEMORY_COOLDOWN_DOMAINS = 50_000;

export interface DomainCooldownStatus {
  readonly cooledDown: boolean;
  readonly distinctWorkspaces30d: number;
  readonly retryAfterDays: number;
  readonly advisoryOnly: true;
  readonly degraded?: boolean;
}

export interface CooldownWindowSnapshot {
  readonly count: number;
  readonly pivotTimestampMs: number | null;
}

export interface DomainCooldownBackend {
  pruneAndInspect(
    key: string,
    windowStartMs: number,
    threshold: number,
  ): Promise<CooldownWindowSnapshot>;
  recordAndInspect(
    key: string,
    member: string,
    nowMs: number,
    windowMs: number,
    threshold: number,
  ): Promise<CooldownWindowSnapshot>;
}

export interface RedisDomainCooldownClient {
  zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number | string>;
  pexpire(key: string, milliseconds: number): Promise<number>;
  zcard(key: string): Promise<number>;
  zrange(key: string, start: number, stop: number, withScores: 'WITHSCORES'): Promise<string[]>;
}

function parsePivotScoreFromZrange(
  entries: readonly string[],
  targetOrdinal: number,
): number | null {
  const scoreIndex = targetOrdinal * 2 + 1;
  const rawScore = entries[scoreIndex];
  if (rawScore === undefined) return null;
  const parsed = Number(rawScore);
  return Number.isFinite(parsed) ? parsed : null;
}

export class RedisDomainCooldownBackend implements DomainCooldownBackend {
  constructor(private readonly client: RedisDomainCooldownClient) {}

  async pruneAndInspect(
    key: string,
    windowStartMs: number,
    threshold: number,
  ): Promise<CooldownWindowSnapshot> {
    await this.client.zremrangebyscore(key, '-inf', windowStartMs);
    const count = await this.client.zcard(key);
    if (count < threshold) {
      return { count, pivotTimestampMs: null };
    }
    const pivotOrdinal = Math.max(0, count - threshold);
    const withScores = await this.client.zrange(key, 0, pivotOrdinal, 'WITHSCORES');
    return {
      count,
      pivotTimestampMs: parsePivotScoreFromZrange(withScores, pivotOrdinal),
    };
  }

  async recordAndInspect(
    key: string,
    member: string,
    nowMs: number,
    windowMs: number,
    threshold: number,
  ): Promise<CooldownWindowSnapshot> {
    const windowStartMs = nowMs - windowMs;
    await this.client.zremrangebyscore(key, '-inf', windowStartMs);
    await this.client.zadd(key, nowMs, member);
    await this.client.pexpire(key, windowMs);
    const count = await this.client.zcard(key);
    if (count < threshold) {
      return { count, pivotTimestampMs: null };
    }
    const pivotOrdinal = Math.max(0, count - threshold);
    const withScores = await this.client.zrange(key, 0, pivotOrdinal, 'WITHSCORES');
    return {
      count,
      pivotTimestampMs: parsePivotScoreFromZrange(withScores, pivotOrdinal),
    };
  }
}

export class InMemoryDomainCooldownBackend implements DomainCooldownBackend {
  private readonly buckets = new Map<string, Map<string, number>>();

  constructor(private readonly maxDomains = MAX_IN_MEMORY_COOLDOWN_DOMAINS) {}

  private pruneBucket(key: string, windowStartMs: number): Map<string, number> | null {
    const bucket = this.buckets.get(key);
    if (!bucket) return null;
    for (const [member, ts] of bucket.entries()) {
      if (ts <= windowStartMs) bucket.delete(member);
    }
    if (bucket.size === 0) {
      this.buckets.delete(key);
      return null;
    }
    return bucket;
  }

  private summarize(bucket: Map<string, number> | null, threshold: number): CooldownWindowSnapshot {
    if (!bucket || bucket.size === 0) return { count: 0, pivotTimestampMs: null };
    const count = bucket.size;
    if (count < threshold) return { count, pivotTimestampMs: null };
    const sortedScores = [...bucket.values()].sort((a, b) => a - b);
    const pivotOrdinal = Math.max(0, count - threshold);
    return { count, pivotTimestampMs: sortedScores[pivotOrdinal] ?? null };
  }

  async pruneAndInspect(
    key: string,
    windowStartMs: number,
    threshold: number,
  ): Promise<CooldownWindowSnapshot> {
    const bucket = this.pruneBucket(key, windowStartMs);
    return this.summarize(bucket, threshold);
  }

  async recordAndInspect(
    key: string,
    member: string,
    nowMs: number,
    windowMs: number,
    threshold: number,
  ): Promise<CooldownWindowSnapshot> {
    const windowStartMs = nowMs - windowMs;
    let bucket = this.pruneBucket(key, windowStartMs);
    if (!bucket) {
      if (this.buckets.size >= this.maxDomains) {
        const oldestKey = this.buckets.keys().next().value;
        if (oldestKey !== undefined) this.buckets.delete(oldestKey);
      }
      bucket = new Map<string, number>();
      this.buckets.set(key, bucket);
    }
    bucket.set(member, nowMs);
    return this.summarize(bucket, threshold);
  }

  /** Test inspection helper: returns raw stored Redis-equivalent keys (must only contain HMACs). */
  storedKeys(): string[] {
    return [...this.buckets.keys()];
  }

  /** Test inspection helper: returns raw stored members for a key (must only contain HMACs). */
  storedMembers(key: string): string[] {
    return [...(this.buckets.get(key)?.keys() ?? [])];
  }
}

export interface DomainCooldownServiceOptions {
  /** Dedicated secret pepper (>= 16 chars). Missing/short pepper disables cooldown rather than using unsalted SHA-256. */
  readonly pepper: string | null | undefined;
  readonly backend?: DomainCooldownBackend;
  readonly fallbackBackend?: DomainCooldownBackend;
  readonly windowDays?: number;
  readonly maxDistinctWorkspaces30d?: number;
}

function clampThreshold(raw: number | undefined): number {
  const value =
    typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_COOLDOWN_THRESHOLD;
  return Math.min(50, Math.max(1, value));
}

function clampWindowDays(raw: number | undefined): number {
  const value =
    typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_COOLDOWN_WINDOW_DAYS;
  return Math.min(90, Math.max(1, value));
}

function emptyAdvisory(degraded = false): DomainCooldownStatus {
  return degraded
    ? { cooledDown: false, distinctWorkspaces30d: 0, retryAfterDays: 0, advisoryOnly: true, degraded: true }
    : { cooledDown: false, distinctWorkspaces30d: 0, retryAfterDays: 0, advisoryOnly: true };
}

/**
 * ADR-003 30-day cross-tenant domain outreach/discovery collision cooldown.
 *
 * Privacy guarantees:
 * - Keys use `HMAC-SHA256(pepper, 'domain:' + normalizedDomain)` under `{global:p3:domain-cooldown:<hmac>}`
 *   (NEVER unsalted SHA-256, NEVER raw domain).
 * - Distinct workspaces are counted via per-domain unlinkable `HMAC-SHA256(pepper, 'ws-touch:' + domain + ':' + workspaceId)`
 *   members (NEVER raw `workspaceId`, never linkable across domains).
 * - Public response returns ONLY `{ cooledDown, distinctWorkspaces30d, retryAfterDays, advisoryOnly }`,
 *   never revealing which tenant touched the buyer.
 */
export class DomainCooldownService {
  private readonly pepper: string | null;
  private readonly backend: DomainCooldownBackend;
  private readonly fallbackBackend: DomainCooldownBackend;
  private readonly windowMs: number;
  private readonly threshold: number;
  private degradedErrors = 0;

  constructor(options: DomainCooldownServiceOptions) {
    const trimmedPepper = typeof options.pepper === 'string' ? options.pepper.trim() : '';
    this.pepper = trimmedPepper.length >= MIN_COOLDOWN_PEPPER_LENGTH ? trimmedPepper : null;
    this.fallbackBackend = options.fallbackBackend ?? new InMemoryDomainCooldownBackend();
    this.backend = options.backend ?? this.fallbackBackend;
    this.windowMs = clampWindowDays(options.windowDays) * MS_PER_DAY;
    this.threshold = clampThreshold(options.maxDistinctWorkspaces30d);
  }

  isConfigured(): boolean {
    return this.pepper !== null;
  }

  computeDomainHmac(normalizedDomain: string): string {
    if (!this.pepper) {
      throw new Error('ADR003_COOLDOWN_PEPPER_NOT_CONFIGURED');
    }
    return createHmac('sha256', this.pepper)
      .update(`domain:${normalizedDomain}`, 'utf8')
      .digest('hex');
  }

  computeWorkspaceTouchMember(normalizedDomain: string, workspaceId: string): string {
    if (!this.pepper) {
      throw new Error('ADR003_COOLDOWN_PEPPER_NOT_CONFIGURED');
    }
    return createHmac('sha256', this.pepper)
      .update(`ws-touch:${normalizedDomain}:${workspaceId}`, 'utf8')
      .digest('hex');
  }

  cooldownRedisKey(normalizedDomain: string): string {
    return `${DOMAIN_COOLDOWN_REDIS_PREFIX}${this.computeDomainHmac(normalizedDomain)}}`;
  }

  private toStatus(snapshot: CooldownWindowSnapshot, nowMs: number, degraded: boolean): DomainCooldownStatus {
    const cooledDown = snapshot.count >= this.threshold;
    let retryAfterDays = 0;
    if (cooledDown && snapshot.pivotTimestampMs !== null) {
      const remainingMs = snapshot.pivotTimestampMs + this.windowMs - nowMs;
      retryAfterDays = Math.max(1, Math.ceil(remainingMs / MS_PER_DAY));
    }
    return degraded
      ? {
          cooledDown,
          distinctWorkspaces30d: snapshot.count,
          retryAfterDays,
          advisoryOnly: true,
          degraded: true,
        }
      : {
          cooledDown,
          distinctWorkspaces30d: snapshot.count,
          retryAfterDays,
          advisoryOnly: true,
        };
  }

  async checkCooldown(
    rawDomain: string | null | undefined,
    opts: { nowMs?: number } = {},
  ): Promise<DomainCooldownStatus> {
    if (!this.pepper) return emptyAdvisory(true);
    const domain = normalizeCompanyDomain(rawDomain);
    if (!domain) return emptyAdvisory(false);

    const nowMs = opts.nowMs ?? Date.now();
    const windowStartMs = nowMs - this.windowMs;
    const key = this.cooldownRedisKey(domain);
    try {
      const snapshot = await this.backend.pruneAndInspect(key, windowStartMs, this.threshold);
      return this.toStatus(snapshot, nowMs, false);
    } catch {
      this.degradedErrors += 1;
      if (this.fallbackBackend !== this.backend) {
        try {
          const snapshot = await this.fallbackBackend.pruneAndInspect(key, windowStartMs, this.threshold);
          return this.toStatus(snapshot, nowMs, true);
        } catch {
          // Fall through to safe advisory.
        }
      }
      return emptyAdvisory(true);
    }
  }

  async recordTouch(
    rawDomain: string | null | undefined,
    workspaceId: string,
    opts: { nowMs?: number } = {},
  ): Promise<DomainCooldownStatus> {
    if (!this.pepper) return emptyAdvisory(true);
    const domain = normalizeCompanyDomain(rawDomain);
    const ws = workspaceId.trim();
    if (!domain || !ws) return emptyAdvisory(false);

    const nowMs = opts.nowMs ?? Date.now();
    const key = this.cooldownRedisKey(domain);
    const member = this.computeWorkspaceTouchMember(domain, ws);
    try {
      const snapshot = await this.backend.recordAndInspect(
        key,
        member,
        nowMs,
        this.windowMs,
        this.threshold,
      );
      return this.toStatus(snapshot, nowMs, false);
    } catch {
      this.degradedErrors += 1;
      if (this.fallbackBackend !== this.backend) {
        try {
          const snapshot = await this.fallbackBackend.recordAndInspect(
            key,
            member,
            nowMs,
            this.windowMs,
            this.threshold,
          );
          return this.toStatus(snapshot, nowMs, true);
        } catch {
          // Fall through to safe advisory.
        }
      }
      return emptyAdvisory(true);
    }
  }

  getDegradedErrorCount(): number {
    return this.degradedErrors;
  }
}
