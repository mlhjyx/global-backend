import { PrismaClient } from '@prisma/client';
import Redis, { type RedisOptions } from 'ioredis';
import {
  DEFAULT_COOLDOWN_THRESHOLD,
  DEFAULT_GREEN_FACT_TTL_DAYS,
  DomainCooldownService,
  InMemoryDomainCooldownBackend,
  InMemorySharedFactRepository,
  normalizeCompanyDomain,
  PostgresDomainCooldownBackend,
  PostgresSharedFactRepository,
  RedisDomainCooldownBackend,
  RedisSharedFactRepository,
  SharedGreenFactStore,
  type DomainCooldownBackend,
  type DomainCooldownStatus,
  type GreenCompanyFact,
  type PlatformSharedSqlClient,
  type SharedFactRepository,
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

export type SharedFactsBackendKind = 'postgres' | 'redis' | 'memory';

export interface SharedFactsDiagnostics {
  readonly mode: SharedGreenFactsMode;
  readonly backendKind: SharedFactsBackendKind;
  readonly pgReaderConfigured: boolean;
  readonly pgWriterConfigured: boolean;
  readonly redisFallbackConfigured: boolean;
  readonly cooldownConfigured: boolean;
}

export interface CreateSharedFactsHookOptions {
  readonly redisFactory?: SharedFactsRedisFactory;
  readonly pgReader?: PlatformSharedSqlClient;
  readonly pgWriter?: PlatformSharedSqlClient;
  readonly pgClientFactory?: (datasourceUrl: string) => PlatformSharedSqlClient & { $disconnect(): Promise<void> };
}

export interface SharedFactsStreamingHookOptions {
  readonly mode: SharedGreenFactsMode;
  readonly factStore: SharedGreenFactStore;
  readonly cooldownService: DomainCooldownService;
  readonly defaultTtlDays?: number;
  readonly backendKind?: SharedFactsBackendKind;
  readonly pgReaderConfigured?: boolean;
  readonly pgWriterConfigured?: boolean;
  readonly redisFallbackConfigured?: boolean;
  readonly closeClient?: () => Promise<void>;
}

export class SharedFactsStreamingHook {
  private readonly mode: SharedGreenFactsMode;
  private readonly factStore: SharedGreenFactStore;
  private readonly cooldownService: DomainCooldownService;
  private readonly defaultTtlDays: number;
  private readonly backendKind: SharedFactsBackendKind;
  private readonly pgReaderConfigured: boolean;
  private readonly pgWriterConfigured: boolean;
  private readonly redisFallbackConfigured: boolean;
  private readonly closeClient?: () => Promise<void>;

  constructor(options: SharedFactsStreamingHookOptions) {
    this.mode = options.mode;
    this.factStore = options.factStore;
    this.cooldownService = options.cooldownService;
    this.defaultTtlDays = options.defaultTtlDays ?? DEFAULT_GREEN_FACT_TTL_DAYS;
    this.backendKind = options.backendKind ?? 'memory';
    this.pgReaderConfigured = options.pgReaderConfigured ?? false;
    this.pgWriterConfigured = options.pgWriterConfigured ?? false;
    this.redisFallbackConfigured = options.redisFallbackConfigured ?? false;
    this.closeClient = options.closeClient;
  }

  getMode(): SharedGreenFactsMode {
    return this.mode;
  }

  getDiagnostics(): SharedFactsDiagnostics {
    return {
      mode: this.mode,
      backendKind: this.backendKind,
      pgReaderConfigured: this.pgReaderConfigured,
      pgWriterConfigured: this.pgWriterConfigured,
      redisFallbackConfigured: this.redisFallbackConfigured,
      cooldownConfigured: this.cooldownService.isConfigured(),
    };
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
    category?: string | null,
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
            this.cooldownService.checkCooldown(domain, { nowMs, category }),
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
    category?: string | null;
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
      this.cooldownService.checkCooldown(domain, { nowMs, category: input.category }),
    ]);
    if (!fact || (fact.sourceKind !== 'public_web' && fact.sourceKind !== 'public_web_streaming')) {
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
    if (input.extraction.fetchMethod === 'skipped' || input.extraction.pagesFetched.length === 0) {
      return null;
    }
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
    category?: string | null;
  }): Promise<DomainCooldownStatus | null> {
    if (!this.canWrite() || input.isImportedBuyer) return null;
    return this.cooldownService.recordTouch(input.domain, input.workspaceId, {
      nowMs: input.nowMs,
      category: input.category,
    });
  }

  async close(): Promise<void> {
    if (this.closeClient) await this.closeClient();
  }
}

type OwnedDisconnectableClient = { $disconnect(): Promise<void> };

const FORBIDDEN_SCOPED_USERNAMES = new Set(['global', 'app_user', 'postgres']);

function resolveOptionalPostgresUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') return null;
    if (!parsed.hostname || !parsed.pathname || parsed.pathname === '/') return null;
    return trimmed;
  } catch {
    return null;
  }
}

function resolveOptionalScopedPostgresUrl(raw: string | undefined): string | null {
  const url = resolveOptionalPostgresUrl(raw);
  if (!url) return null;
  try {
    const username = decodeURIComponent(new URL(url).username);
    if (!username || FORBIDDEN_SCOPED_USERNAMES.has(username)) return null;
    return url;
  } catch {
    return null;
  }
}

function createRedisFallbackClient(
  redisUrl: string | null,
  redisFactory: SharedFactsRedisFactory,
): SharedFactsRedisLike | null {
  if (!redisUrl) return null;
  const client = redisFactory(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: REDIS_TIMEOUT_MS,
    commandTimeout: REDIS_TIMEOUT_MS,
    enableOfflineQueue: false,
    ...(redisUrl.startsWith('rediss:') ? { tls: { rejectUnauthorized: true } } : {}),
  });
  client.on('error', () => {});
  return client;
}

function resolvePgClientsFromEnv(
  env: NodeJS.ProcessEnv,
  mode: SharedGreenFactsMode,
  options: CreateSharedFactsHookOptions,
): {
  pgReader?: PlatformSharedSqlClient;
  pgWriter?: PlatformSharedSqlClient;
  ownedClients: OwnedDisconnectableClient[];
} {
  const makeClient =
    options.pgClientFactory ?? ((datasourceUrl: string) => new PrismaClient({ datasourceUrl }));
  const ownedClients: OwnedDisconnectableClient[] = [];

  let pgReader = options.pgReader;
  if (!pgReader) {
    const appUrl = resolveOptionalPostgresUrl(env.APP_DATABASE_URL);
    if (appUrl) {
      const client = makeClient(appUrl);
      pgReader = client;
      ownedClients.push(client);
    }
  }

  let pgWriter = options.pgWriter;
  if (!pgWriter && mode === 'on') {
    // Customer worker admission verifies the scoped ops principal before it can poll.
    const workerOpsUrl = resolveOptionalScopedPostgresUrl(env.CUSTOMER_WORKER_OPS_DATABASE_URL);
    if (workerOpsUrl) {
      const client = makeClient(workerOpsUrl);
      pgWriter = client;
      ownedClients.push(client);
    }
  }

  return { pgReader, pgWriter, ownedClients };
}

export function createSharedFactsHookFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  redisFactoryOrOptions: SharedFactsRedisFactory | CreateSharedFactsHookOptions = {},
): SharedFactsStreamingHook {
  const options: CreateSharedFactsHookOptions =
    typeof redisFactoryOrOptions === 'function'
      ? { redisFactory: redisFactoryOrOptions }
      : redisFactoryOrOptions;
  const redisFactory: SharedFactsRedisFactory =
    options.redisFactory ?? ((url, opts) => new Redis(url, opts));

  const mode = resolveSharedGreenFactsMode(env);
  const ttlDays = parsePositiveIntEnv(env.ADR003_GREEN_FACT_TTL_DAYS, DEFAULT_GREEN_FACT_TTL_DAYS);
  const threshold = parsePositiveIntEnv(
    env.ADR003_DOMAIN_COOLDOWN_THRESHOLD,
    DEFAULT_COOLDOWN_THRESHOLD,
  );
  const pepper = env.ADR003_DOMAIN_COOLDOWN_PEPPER ?? null;
  const inMemoryFactRepo = new InMemorySharedFactRepository();
  const inMemoryCooldown = new InMemoryDomainCooldownBackend();

  if (mode === 'off') {
    return new SharedFactsStreamingHook({
      mode: 'off',
      backendKind: 'memory',
      factStore: new SharedGreenFactStore(inMemoryFactRepo),
      cooldownService: new DomainCooldownService({
        pepper,
        backend: inMemoryCooldown,
        fallbackBackend: inMemoryCooldown,
        maxDistinctWorkspaces30d: threshold,
      }),
      defaultTtlDays: ttlDays,
    });
  }

  const redisClient = createRedisFallbackClient(resolveOptionalRedisUrl(env), redisFactory);
  const fallbackFactRepo: SharedFactRepository = redisClient
    ? new RedisSharedFactRepository(redisClient)
    : inMemoryFactRepo;
  const fallbackCooldownBackend: DomainCooldownBackend = redisClient
    ? new RedisDomainCooldownBackend(redisClient)
    : inMemoryCooldown;

  const { pgReader, pgWriter, ownedClients } = resolvePgClientsFromEnv(env, mode, options);
  const effectiveReader = pgReader ?? pgWriter;
  const backendKind: SharedFactsBackendKind = effectiveReader
    ? 'postgres'
    : redisClient
      ? 'redis'
      : 'memory';

  const primaryFactRepo: SharedFactRepository = effectiveReader
    ? new PostgresSharedFactRepository(effectiveReader, pgWriter)
    : fallbackFactRepo;
  const primaryCooldownBackend: DomainCooldownBackend = effectiveReader
    ? new PostgresDomainCooldownBackend(effectiveReader, pgWriter)
    : fallbackCooldownBackend;

  const closeClient =
    ownedClients.length > 0 || redisClient
      ? async () => {
          const tasks: Promise<unknown>[] = ownedClients.map((c) =>
            c.$disconnect().catch(() => undefined),
          );
          if (redisClient) {
            tasks.push(
              redisClient.quit().catch(() => {
                redisClient.disconnect();
              }),
            );
          }
          await Promise.allSettled(tasks);
        }
      : undefined;

  return new SharedFactsStreamingHook({
    mode,
    backendKind,
    pgReaderConfigured: Boolean(effectiveReader),
    pgWriterConfigured: Boolean(pgWriter),
    redisFallbackConfigured: Boolean(redisClient),
    factStore: new SharedGreenFactStore(
      primaryFactRepo,
      effectiveReader ? fallbackFactRepo : inMemoryFactRepo,
    ),
    cooldownService: new DomainCooldownService({
      pepper,
      backend: primaryCooldownBackend,
      fallbackBackend: effectiveReader ? fallbackCooldownBackend : inMemoryCooldown,
      maxDistinctWorkspaces30d: threshold,
    }),
    defaultTtlDays: ttlDays,
    closeClient,
  });
}
