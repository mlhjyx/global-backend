import Redis, { type RedisOptions } from 'ioredis';
import {
  DEFAULT_COOLDOWN_THRESHOLD,
  DEFAULT_GREEN_FACT_TTL_DAYS,
  DomainCooldownService,
  InMemoryDomainCooldownBackend,
  InMemorySharedFactRepository,
  normalizeCompanyDomain,
  RedisDomainCooldownBackend,
  RedisSharedFactRepository,
  SharedGreenFactStore,
  type DomainCooldownStatus,
  type GreenCompanyFact,
  type SharedFactWriteOutcome,
} from '../../shared-facts';
import type { StreamingCompanyExtraction } from './raw-http-extractor';

export type SharedGreenFactsMode = 'off' | 'readonly' | 'on';

export { normalizeCompanyDomain } from '../../shared-facts';

const REDIS_TIMEOUT_MS = 1_500;
const L0_INSPECT_CONCURRENCY = 8;

const EMPTY_COOLDOWN: DomainCooldownStatus = Object.freeze({
  cooledDown: false,
  distinctWorkspaces30d: 0,
  retryAfterDays: 0,
  advisoryOnly: true,
});

export interface SharedFactsRedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, pxMode: 'PX', ttlMs: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number | string>;
  pexpire(key: string, milliseconds: number): Promise<number>;
  zcard(key: string): Promise<number>;
  zrange(key: string, start: number, stop: number, withScores: 'WITHSCORES'): Promise<string[]>;
  on(event: 'error', listener: () => void): unknown;
  quit(): Promise<unknown>;
  disconnect(): void;
}

export type SharedFactsRedisFactory = (url: string, options: RedisOptions) => SharedFactsRedisLike;

export interface L0DomainAdvisory {
  readonly sharedFactAvailable: boolean;
  readonly cooldown: DomainCooldownStatus;
}

export interface L1PreFetchOutcome {
  readonly hit: boolean;
  readonly fact: GreenCompanyFact | null;
  readonly syntheticExtraction: StreamingCompanyExtraction | null;
  readonly cooldown: DomainCooldownStatus;
}

export function resolveSharedGreenFactsMode(
  env: NodeJS.ProcessEnv = process.env,
): SharedGreenFactsMode {
  const raw = env.ADR003_SHARED_GREEN_FACTS?.trim().toLowerCase();
  if (!raw || raw === 'off' || raw === 'false' || raw === '0') return 'off';
  if (raw === 'on' || raw === 'true' || raw === '1') return 'on';
  if (raw === 'readonly' || raw === 'shadow' || raw === 'observe') return 'readonly';
  return 'off';
}

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveOptionalRedisUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = env.REDIS_URL?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'redis:' || parsed.protocol === 'rediss:') {
      return raw;
    }
  } catch {
    // Ignore malformed optional REDIS_URL; fall back to in-memory store.
  }
  return null;
}

function buildReusableFitTextFromGreenFact(fact: GreenCompanyFact): string {
  const sections: string[] = [];
  if (fact.legalName) sections.push(`Company: ${fact.legalName}`);
  if (fact.country) sections.push(`Country: ${fact.country}`);
  if (fact.tradeRole !== 'unknown') sections.push(`Trade role: ${fact.tradeRole}`);
  if (fact.websiteSummary) sections.push(fact.websiteSummary);
  if (fact.productCategories.length > 0) {
    sections.push(`Products: ${fact.productCategories.join(', ')}`);
  }
  return sections.join('\n').trim();
}

/**
 * Projects a verified zero-PII ADR-003 Layer 1 `GreenCompanyFact` into a synthetic
 * `StreamingCompanyExtraction` so L1 can skip HTTP/Crawl4AI network fetches while
 * preserving `fit-v3` evidence quality and strict zero-PII compliance.
 */
export function greenFactToStreamingExtraction(fact: GreenCompanyFact): StreamingCompanyExtraction {
  const socialLinks = fact.linkedinCompanyUrl ? [fact.linkedinCompanyUrl] : [];
  return {
    domain: fact.domain,
    homepageUrl: fact.homepageUrl,
    fetchMethod: 'skipped',
    usedCrawl4aiFallback: false,
    usedWwwRetry: false,
    pdfSkipped: false,
    robotsBlocked: false,
    title: fact.legalName,
    metaDescription: fact.websiteSummary,
    visibleText: buildReusableFitTextFromGreenFact(fact),
    jsonLd: {
      organizationNames: fact.legalName ? [fact.legalName] : [],
      descriptions: fact.websiteSummary ? [fact.websiteSummary] : [],
      emails: [...fact.roleEmails],
      phones: [...fact.switchboardPhones],
      socialLinks,
      products: [...fact.productCategories],
      jobPostings: [],
    },
    channels: {
      roleEmails: [...fact.roleEmails],
      otherEmails: [],
      phones: [...fact.switchboardPhones],
      socialLinks,
      hasInquiryForm: Boolean(fact.inquiryFormUrl),
      contactFormUrl: fact.inquiryFormUrl,
      contactPageUrl: fact.contactPageUrl,
      impressumUrl: fact.impressumUrl,
      careersPageUrl: null,
    },
    pagesFetched: [fact.homepageUrl],
    failureReason: null,
  };
}

export interface SharedFactsStreamingHookOptions {
  readonly mode: SharedGreenFactsMode;
  readonly factStore: SharedGreenFactStore;
  readonly cooldownService: DomainCooldownService;
  readonly defaultTtlDays?: number;
  readonly closeClient?: () => Promise<void>;
}

export class SharedFactsStreamingHook {
  private readonly mode: SharedGreenFactsMode;
  private readonly factStore: SharedGreenFactStore;
  private readonly cooldownService: DomainCooldownService;
  private readonly defaultTtlDays: number;
  private readonly closeClient?: () => Promise<void>;

  constructor(options: SharedFactsStreamingHookOptions) {
    this.mode = options.mode;
    this.factStore = options.factStore;
    this.cooldownService = options.cooldownService;
    this.defaultTtlDays = options.defaultTtlDays ?? DEFAULT_GREEN_FACT_TTL_DAYS;
    this.closeClient = options.closeClient;
  }

  getMode(): SharedGreenFactsMode {
    return this.mode;
  }

  isEnabled(): boolean {
    return this.mode !== 'off';
  }

  canWrite(): boolean {
    return this.mode === 'on';
  }

  async inspectL0Domains(
    domains: readonly (string | null | undefined)[],
    nowMs = Date.now(),
  ): Promise<Map<string, L0DomainAdvisory>> {
    const out = new Map<string, L0DomainAdvisory>();
    if (!this.isEnabled()) return out;

    const normalized = [...new Set(domains.map((d) => normalizeCompanyDomain(d)).filter((d): d is string => d !== null))];
    for (let i = 0; i < normalized.length; i += L0_INSPECT_CONCURRENCY) {
      const batch = normalized.slice(i, i + L0_INSPECT_CONCURRENCY);
      const settled = await Promise.all(
        batch.map(async (domain) => {
          const [fact, cooldown] = await Promise.all([
            this.factStore.get(domain, nowMs),
            this.cooldownService.checkCooldown(domain, { nowMs }),
          ]);
          return { domain, sharedFactAvailable: fact !== null, cooldown };
        }),
      );
      for (const item of settled) {
        out.set(item.domain, {
          sharedFactAvailable: item.sharedFactAvailable,
          cooldown: item.cooldown,
        });
      }
    }
    return out;
  }

  async lookupL1PreFetch(input: {
    domain: string | null | undefined;
    nowMs?: number;
  }): Promise<L1PreFetchOutcome> {
    if (!this.isEnabled()) {
      return {
        hit: false,
        fact: null,
        syntheticExtraction: null,
        cooldown: EMPTY_COOLDOWN,
      };
    }
    const domain = normalizeCompanyDomain(input.domain);
    if (!domain) {
      return {
        hit: false,
        fact: null,
        syntheticExtraction: null,
        cooldown: EMPTY_COOLDOWN,
      };
    }
    const nowMs = input.nowMs ?? Date.now();
    const [fact, cooldown] = await Promise.all([
      this.factStore.get(domain, nowMs),
      this.cooldownService.checkCooldown(domain, { nowMs }),
    ]);
    if (!fact) {
      return {
        hit: false,
        fact: null,
        syntheticExtraction: null,
        cooldown,
      };
    }
    return {
      hit: true,
      fact,
      syntheticExtraction: greenFactToStreamingExtraction(fact),
      cooldown,
    };
  }

  async writeBackFromStreamingExtraction(input: {
    domain: string | null | undefined;
    legalName?: string | null;
    country?: string | null;
    tradeRole?: string | null;
    extraction: StreamingCompanyExtraction;
    isImportedBuyer: boolean;
    channelExternalRefs?: readonly string[];
    companyAttributes?: Record<string, unknown> | null;
    now?: Date;
  }): Promise<SharedFactWriteOutcome | null> {
    if (!this.canWrite()) return null;
    if (input.extraction.pagesFetched.length === 0) return null;
    return this.factStore.putFromRaw(
      {
        domain: input.domain,
        homepageUrl: input.extraction.homepageUrl,
        legalName: input.legalName ?? input.extraction.title,
        country: input.country ?? null,
        tradeRole: input.tradeRole ?? 'unknown',
        title: input.extraction.title,
        metaDescription: input.extraction.metaDescription,
        descriptionSnippets: input.extraction.jsonLd.descriptions,
        // Explicitly forward ONLY roleEmails (sanitizer still independently enforces strict role-email filtering).
        emails: input.extraction.channels.roleEmails,
        phones: input.extraction.channels.phones,
        inquiryFormUrl: input.extraction.channels.contactFormUrl,
        contactPageUrl: input.extraction.channels.contactPageUrl,
        impressumUrl: input.extraction.channels.impressumUrl,
        socialLinks: input.extraction.channels.socialLinks,
        productCategories: input.extraction.jsonLd.products,
        sourceKind: 'public_web_streaming',
        isImportedBuyer: input.isImportedBuyer,
        channelExternalRefs: input.channelExternalRefs,
        companyAttributes: input.companyAttributes ?? null,
      },
      { now: input.now, ttlDays: this.defaultTtlDays },
    );
  }

  async recordQualifiedTouch(input: {
    domain: string | null | undefined;
    workspaceId: string;
    isImportedBuyer: boolean;
    nowMs?: number;
  }): Promise<DomainCooldownStatus | null> {
    if (!this.canWrite() || input.isImportedBuyer) return null;
    return this.cooldownService.recordTouch(input.domain, input.workspaceId, {
      nowMs: input.nowMs,
    });
  }

  async close(): Promise<void> {
    if (this.closeClient) await this.closeClient();
  }
}

export function createSharedFactsHookFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  redisFactory: SharedFactsRedisFactory = (url, options) => new Redis(url, options),
): SharedFactsStreamingHook {
  const mode = resolveSharedGreenFactsMode(env);
  const ttlDays = parsePositiveIntEnv(env.ADR003_GREEN_FACT_TTL_DAYS, DEFAULT_GREEN_FACT_TTL_DAYS);
  const threshold = parsePositiveIntEnv(
    env.ADR003_DOMAIN_COOLDOWN_THRESHOLD,
    DEFAULT_COOLDOWN_THRESHOLD,
  );
  const pepper = env.ADR003_DOMAIN_COOLDOWN_PEPPER ?? null;
  const fallbackFactRepo = new InMemorySharedFactRepository();
  const fallbackCooldownBackend = new InMemoryDomainCooldownBackend();

  if (mode === 'off') {
    return new SharedFactsStreamingHook({
      mode: 'off',
      factStore: new SharedGreenFactStore(fallbackFactRepo),
      cooldownService: new DomainCooldownService({
        pepper,
        backend: fallbackCooldownBackend,
        fallbackBackend: fallbackCooldownBackend,
        maxDistinctWorkspaces30d: threshold,
      }),
      defaultTtlDays: ttlDays,
    });
  }

  const redisUrl = resolveOptionalRedisUrl(env);
  if (!redisUrl) {
    return new SharedFactsStreamingHook({
      mode,
      factStore: new SharedGreenFactStore(fallbackFactRepo),
      cooldownService: new DomainCooldownService({
        pepper,
        backend: fallbackCooldownBackend,
        fallbackBackend: fallbackCooldownBackend,
        maxDistinctWorkspaces30d: threshold,
      }),
      defaultTtlDays: ttlDays,
    });
  }

  const client = redisFactory(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: REDIS_TIMEOUT_MS,
    commandTimeout: REDIS_TIMEOUT_MS,
    enableOfflineQueue: false,
    ...(redisUrl.startsWith('rediss:') ? { tls: { rejectUnauthorized: true } } : {}),
  });
  client.on('error', () => {});

  return new SharedFactsStreamingHook({
    mode,
    factStore: new SharedGreenFactStore(new RedisSharedFactRepository(client), fallbackFactRepo),
    cooldownService: new DomainCooldownService({
      pepper,
      backend: new RedisDomainCooldownBackend(client),
      fallbackBackend: fallbackCooldownBackend,
      maxDistinctWorkspaces30d: threshold,
    }),
    defaultTtlDays: ttlDays,
    closeClient: async () => {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    },
  });
}
