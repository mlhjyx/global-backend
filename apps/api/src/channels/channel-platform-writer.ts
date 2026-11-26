import { ServiceUnavailableException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { sourcePolicyAllowsDiscovery } from '../discovery/source-policy-scope';
import { parseChannelConfig } from './channel-config';
import { sourcePolicyDomain } from './channel-source-policy';
import { deriveAllowedHosts, hostAllowed, parseChannelManifest } from './connector/channel-manifest';
import {
  assertExecutionBudgetPlatformWriterPrincipal,
  ScopedDatabasePrincipalError,
} from '../execution-budget/execution-budget-platform-writer.database';
import {
  DEFAULT_COOLDOWN_THRESHOLD,
  DEFAULT_GREEN_FACT_TTL_DAYS,
  MIN_GREEN_FACT_TTL_DAYS,
  MAX_GREEN_FACT_TTL_DAYS,
  DomainCooldownService,
  PostgresDomainCooldownBackend,
  PostgresSharedFactRepository,
  SharedGreenFactStore,
  type DomainCooldownStatus,
  type GreenFactSourceKind,
  type PlatformSharedSqlClient,
} from '../shared-facts/index';

export const CHANNEL_PLATFORM_WRITER_UNAVAILABLE =
  'PLATFORM_CHANNEL_WRITER_UNAVAILABLE';

export async function requireChannelPlatformWriter(
  platformWriter: PrismaClient | null | undefined,
): Promise<PrismaClient> {
  if (!platformWriter) {
    throw new ServiceUnavailableException({
      error: {
        code: CHANNEL_PLATFORM_WRITER_UNAVAILABLE,
        message:
          'Platform channel writes require EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL',
      },
    });
  }
  try {
    await assertExecutionBudgetPlatformWriterPrincipal(
      platformWriter,
      'ChannelPlatformWriter',
    );
  } catch (error) {
    if (error instanceof ScopedDatabasePrincipalError) {
      throw new ServiceUnavailableException({
        error: {
          code: CHANNEL_PLATFORM_WRITER_UNAVAILABLE,
          message:
            'Platform channel writes require a valid execution_budget_platform_writer database principal',
        },
      });
    }
    throw error;
  }
  return platformWriter;
}

interface ReviewedChannelRecord {
  readonly name: string;
  readonly website: string | null;
  readonly country: string | null;
  readonly industry: string | null;
  readonly products: unknown;
  readonly keywords: unknown;
  readonly sourceUrl: string;
  readonly lastSeenAt: Date;
}

interface ChannelGreenFactProjectionResult {
  readonly stored: number;
  readonly skipped: number;
  readonly rejected: number;
}

const GREEN_CHANNEL_SOURCE_KIND: Readonly<Record<string, GreenFactSourceKind>> = {
  trade_fair: 'public_directory',
  directory: 'public_directory',
  association: 'public_directory',
  customs: 'public_registry',
  tender: 'public_registry',
};

export function isChannelSharedFactsWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ADR003_SHARED_GREEN_FACTS?.trim().toLowerCase();
  return raw === 'on' || raw === 'true' || raw === '1';
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function recordEvidenceUrl(raw: string, allowedHosts: readonly string[]): URL | null {
  const url = URL.parse(raw);
  if (!url || url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  return hostAllowed(url.hostname, allowedHosts) ? url : null;
}

function policyAllowsPath(path: string, allowed: unknown, disallowed: unknown): boolean {
  const prefixes = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.startsWith('/'));
  try {
    if (/%(?:25|2f|5c)/iu.test(path)) return false;
    const decoded = decodeURIComponent(path);
    return (allowed === null || (prefixes(allowed) && allowed.some((prefix) => decoded.startsWith(prefix))))
      && (disallowed === null || (prefixes(disallowed) && !disallowed.some((prefix) => decoded.startsWith(prefix))));
  } catch {
    return false;
  }
}

function recordStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((entry): entry is string => typeof entry === 'string');
}

/** Only the reviewed version of an enabled public channel's materialized record can be shared. */
export async function projectApprovedChannelGreenFacts(input: {
  readonly platformWriter: PrismaClient | null | undefined;
  readonly channelId: string;
  readonly env?: NodeJS.ProcessEnv;
} & ({ readonly crawlRunId: string } | { readonly recordIds: readonly string[] })): Promise<ChannelGreenFactProjectionResult | null> {
  const env = input.env ?? process.env;
  if (!isChannelSharedFactsWriteEnabled(env)) return null;
  if ('recordIds' in input && input.recordIds.length === 0) return null;

  try {
    const writer = await requireChannelPlatformWriter(input.platformWriter);
    return await writer.$transaction(async (tx) => {
      const channel = await tx.sourceChannel.findFirst({
        where: { id: input.channelId, status: 'ENABLED', mode: 'crawl', probeRequired: false },
        select: { category: true, name: true, license: true, config: true, manifest: true },
      });
      if (!channel?.license?.trim()) return null;
      const sourceKind = GREEN_CHANNEL_SOURCE_KIND[channel.category];
      if (!sourceKind) return null;
      const config = channel.manifest === null ? parseChannelConfig('crawl', channel.config) : null;
      const allowedHosts = config?.mode === 'crawl'
        ? [new URL(config.list.url).hostname]
        : deriveAllowedHosts(parseChannelManifest(channel.manifest));
      const filter = 'crawlRunId' in input
        ? Prisma.sql`r.crawl_run_id = ${input.crawlRunId}::uuid`
        : Prisma.sql`r.id IN (${Prisma.join(input.recordIds.map((id) => Prisma.sql`${id}::uuid`))})`;
      const records = await tx.$queryRaw<ReviewedChannelRecord[]>`
        SELECT r.name, r.website, r.country, r.industry, r.products, r.keywords,
               r.source_url AS "sourceUrl", r.last_seen_at AS "lastSeenAt"
        FROM public.source_channel_record AS r
        JOIN public.source_channel AS channel ON channel.id = r.channel_id
        WHERE r.channel_id = ${input.channelId}::uuid
          AND ${filter}
          AND channel.status = 'ENABLED' AND channel.mode = 'crawl' AND channel.probe_required = false
          AND r.review_status = 'APPROVED' AND r.content_hash = r.reviewed_content_hash
        ORDER BY r.id
        FOR SHARE OF r, channel
      `;
      const evidence = records.map((record) => ({ record, url: recordEvidenceUrl(record.sourceUrl, allowedHosts) }));
      const domains = [...new Set(evidence.flatMap(({ url }) => url ? [sourcePolicyDomain(url.hostname)] : []))];
      if (domains.length === 0) return { stored: 0, skipped: records.length, rejected: 0 };

      const policies = await tx.sourcePolicy.findMany({
        where: {
          domain: { in: domains },
          sourceType: channel.category,
          accessMode: 'crawl',
          reviewStatus: 'APPROVED',
          termsStatus: 'REVIEWED_OK',
          robotsStatus: 'ALLOWS',
          personalData: false,
          retentionDays: { gte: MIN_GREEN_FACT_TTL_DAYS },
        },
        select: { domain: true, retentionDays: true, allowedPurpose: true, allowedPaths: true, disallowedPaths: true },
      });
      const policyByDomain = new Map(policies.map((policy) => [policy.domain, policy]));
      const store = new SharedGreenFactStore(new PostgresSharedFactRepository(tx, tx));
      const ttlDays = Math.max(
        MIN_GREEN_FACT_TTL_DAYS,
        parsePositiveInt(env.ADR003_GREEN_FACT_TTL_DAYS, DEFAULT_GREEN_FACT_TTL_DAYS),
      );
      const now = Date.now();
      let stored = 0;
      let skipped = 0;
      let rejected = 0;
      for (const { record, url } of evidence) {
        const policy = url ? policyByDomain.get(sourcePolicyDomain(url.hostname)) : undefined;
        const website = record.website?.trim();
        if (!website || !url || !policy || !sourcePolicyAllowsDiscovery(policy.allowedPurpose) ||
            !policyAllowsPath(url.pathname, policy.allowedPaths, policy.disallowedPaths)) {
          skipped += 1;
          continue;
        }
        const retention = Math.min(MAX_GREEN_FACT_TTL_DAYS, ttlDays, policy.retentionDays);
        if (record.lastSeenAt.getTime() + retention * 86_400_000 <= now) {
          skipped += 1;
          continue;
        }
        const summary = record.industry?.trim()
          ? `${channel.name}: ${record.industry.trim()}`
          : channel.name;
        const outcome = await store.putFromRaw(
          {
            domain: website,
            homepageUrl: website,
            legalName: record.name,
            country: record.country,
            websiteSummary: summary,
            productCategories: [...recordStrings(record.products), ...recordStrings(record.keywords)],
            sourceKind,
          },
          { now: record.lastSeenAt, ttlDays: retention },
        );
        if (outcome.degraded) throw new Error('CHANNEL_SHARED_FACT_STORE_UNAVAILABLE');
        if (outcome.stored) stored += 1;
        else if (outcome.reason === 'PREFERRED_FACT_RETAINED') skipped += 1;
        else rejected += 1;
      }
      return { stored, skipped, rejected };
    });
  } catch {
    // The underlying observation/review is durable. A projection failure must not retry crawling.
    console.warn('[channels] CHANNEL_SHARED_FACT_PROJECTION_FAILED', {
      channelId: input.channelId,
      ...('crawlRunId' in input ? { crawlRunId: input.crawlRunId } : { reviewed: input.recordIds.length }),
    });
    return null;
  }
}

export async function recordChannelDomainCooldownTouch(input: {
  readonly reader: PlatformSharedSqlClient;
  readonly platformWriter: PrismaClient | null | undefined;
  readonly domain: string;
  readonly workspaceId: string;
  readonly category?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly nowMs?: number;
}): Promise<DomainCooldownStatus | null> {
  const env = input.env ?? process.env;
  if (!isChannelSharedFactsWriteEnabled(env)) return null;
  const writer = await requireChannelPlatformWriter(input.platformWriter);
  const threshold = parsePositiveInt(
    env.ADR003_DOMAIN_COOLDOWN_THRESHOLD,
    DEFAULT_COOLDOWN_THRESHOLD,
  );
  const cooldown = new DomainCooldownService({
    pepper: env.ADR003_DOMAIN_COOLDOWN_PEPPER ?? null,
    backend: new PostgresDomainCooldownBackend(input.reader, writer),
    maxDistinctWorkspaces30d: threshold,
  });
  if (!cooldown.isConfigured()) return null;
  return cooldown.recordTouch(input.domain, input.workspaceId, {
    nowMs: input.nowMs,
    category: input.category,
  });
}
