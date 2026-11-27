/**
 * 本地平台渠道库（`source_channel_record`）确定性查询与记录映射（Batch 1.4-B）：
 *
 * 从当前启用的渠道读取 APPROVED/PENDING 企业记录，再按国家与行业词过滤。
 * 个人联系人字段（contactName/email/phone）留在本表不带入公司级 Raw 记录（遵循数据最小化）。
 */
import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { normalizeCompanyNameTypography } from './company-name-format';
import { normalizeDomain } from './identity';
import { isIso3166Alpha2 } from '../common/iso3166';
import { isStableSafeHttpsUrl } from './raw-source-provider-normalizer';
import { validateRawSourceProviderPayload } from './raw-source-provider-schema';
import { targetCountryCodes } from './search-localization';
import { lookupCountryIso } from './vocab';
import type { ProviderCompanyRecord } from './provider-contract';

export const CHANNEL_CATALOG_DEFAULT_LIMIT = 100;
export const CHANNEL_CATALOG_MAX_LIMIT = 500;
const CHANNEL_ROW_PAGE_SIZE = 100;
const CHANNEL_QUERY_CONCURRENCY = 8;
const REVIEWED_FIRST = ['APPROVED', 'PENDING'] as const;
const PARSER_VERSION = 'channel_catalog/v1';

export interface ChannelCatalogRow {
  readonly id: string;
  readonly channelId: string;
  readonly dedupeKey: string;
  readonly reviewStatus?: string;
  readonly name: string;
  readonly website: string | null;
  readonly country: string | null;
  readonly industry: string | null;
  readonly products: unknown;
  readonly keywords: unknown;
  readonly sourceUrl: string;
  readonly contentHash: string | null;
  readonly lastSeenAt: Date;
  readonly channel?: { name: string; category: string; license: string | null } | null;
}

export interface ChannelCatalogQueryInput {
  readonly countries: readonly string[];
  readonly terms: readonly string[];
  readonly limit: number;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }
  if (typeof value === 'string' && value.trim().length > 0) return [value.trim()];
  return [];
}

function normalizeCountryToIso2(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (isIso3166Alpha2(trimmed)) return trimmed.toUpperCase();
  const mapped = lookupCountryIso(trimmed);
  if (mapped && isIso3166Alpha2(mapped)) return mapped.toUpperCase();
  const codes = targetCountryCodes({ filters: { country: trimmed } });
  return codes.length === 1 ? codes[0]!.toUpperCase() : undefined;
}

/** 从发现查询提取受控过滤条件（国家 ISO2 列表 + 行业/关键词小写词元）。 */
export function buildChannelCatalogQueryInput(input: {
  filters?: Record<string, unknown>;
  keywords?: readonly string[];
  limit?: number;
}): ChannelCatalogQueryInput {
  const filters = input.filters ?? {};
  const countrySet = new Set<string>();
  for (const code of targetCountryCodes({ filters })) {
    countrySet.add(code.toUpperCase());
  }
  for (const raw of [...asStringArray(filters.country), ...asStringArray(filters._countryCode)]) {
    const iso = normalizeCountryToIso2(raw);
    if (iso) countrySet.add(iso);
  }
  const terms = [
    ...asStringArray(filters.industry),
    ...asStringArray(filters.sub_industry),
    ...asStringArray(filters.product),
    ...(input.keywords ?? []),
  ]
    .flatMap((text) => text.split(/[,/;、，；\s]+/u))
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 2)
    .slice(0, 12);

  const rawLimit = typeof input.limit === 'number' && Number.isSafeInteger(input.limit)
    ? input.limit
    : CHANNEL_CATALOG_DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(rawLimit, CHANNEL_CATALOG_MAX_LIMIT));
  return { countries: [...countrySet], terms: [...new Set(terms)], limit };
}

function rowMatchesFilters(row: ChannelCatalogRow, query: ChannelCatalogQueryInput): boolean {
  if (query.countries.length > 0) {
    const rowCountry = normalizeCountryToIso2(row.country);
    if (!rowCountry || !query.countries.includes(rowCountry)) return false;
  }
  if (query.terms.length === 0) return true;
  const haystack = [
    row.name,
    row.industry ?? '',
    ...asStringArray(row.products),
    ...asStringArray(row.keywords),
    row.channel?.name ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return query.terms.some((term) => haystack.includes(term));
}

function safeProvenanceUrl(raw: string): string | undefined {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return undefined;
    parsed.search = '';
    parsed.hash = '';
    const candidate = parsed.toString();
    return isStableSafeHttpsUrl(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/u;

function resolveRecordContentHash(row: ChannelCatalogRow, sourceUrl: string): string {
  const raw = typeof row.contentHash === 'string' ? row.contentHash.trim().toLowerCase() : '';
  if (SHA256_HEX_RE.test(raw)) return raw;
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.channelId,
        row.dedupeKey,
        row.name,
        row.website ?? null,
        row.country ?? null,
        row.industry ?? null,
        sourceUrl,
      ]),
      'utf8',
    )
    .digest('hex');
}

/** 单行 `source_channel_record` → `ProviderCompanyRecord`（零 PII，稳定 ASCII externalId）。 */
export function mapChannelCatalogRowToRecord(row: ChannelCatalogRow): ProviderCompanyRecord | null {
  const name = normalizeCompanyNameTypography(row.name);
  if (!name) return null;
  const domain = row.website ? normalizeDomain(row.website) : undefined;
  const country = normalizeCountryToIso2(row.country);
  const safeExternalId = `channel_catalog:${row.channelId}:${row.id}`.slice(0, 200);
  const sourceUrl = safeProvenanceUrl(row.sourceUrl);
  if (!sourceUrl) return null;
  return {
    externalId: safeExternalId,
    name,
    ...(domain ? { domain } : {}),
    ...(country ? { country } : {}),
    ...(row.industry?.trim() ? { industry: row.industry.trim().slice(0, 200) } : {}),
    attributes: {
      channel_id: row.channelId,
      record_id: row.id,
      source_class: 'industry_data',
    },
    provenance: {
      sourceUrl,
      fetchedAt: row.lastSeenAt.toISOString(),
      contentHash: resolveRecordContentHash(row, sourceUrl),
      parserVersion: PARSER_VERSION,
    },
  };
}

const CHANNEL_CATALOG_ROW_SELECT = {
  id: true,
  channelId: true,
  dedupeKey: true,
  reviewStatus: true,
  name: true,
  website: true,
  country: true,
  industry: true,
  products: true,
  keywords: true,
  sourceUrl: true,
  contentHash: true,
  lastSeenAt: true,
  channel: { select: { name: true, category: true, license: true } },
} as const;

/** Read matching rows lazily in key order. The page size bounds each database read, not recall. */
async function* findChannelMatches(
  prisma: PrismaClient,
  channelId: string,
  reviewedRecordFilter: Prisma.SourceChannelRecordWhereInput,
  input: ChannelCatalogQueryInput,
  requireCurrentApproval: boolean,
): AsyncGenerator<ProviderCompanyRecord> {
  let after: string | undefined;
  while (true) {
    const page = await prisma.sourceChannelRecord.findMany({
      where: {
        channelId,
        ...reviewedRecordFilter,
        channel: { status: 'ENABLED' },
        ...(input.countries.length > 0 ? { country: { not: null } } : {}),
        ...(after === undefined ? {} : { dedupeKey: { gt: after } }),
      },
      orderBy: { dedupeKey: 'asc' },
      take: CHANNEL_ROW_PAGE_SIZE,
      select: CHANNEL_CATALOG_ROW_SELECT,
    });
    for (const row of page) {
      // Keep the same matching rules for legacy countries, localized names and JSON list fields.
      if (!rowMatchesFilters(row, input)) continue;
      const mapped = mapChannelCatalogRowToRecord(row);
      if (!mapped) continue;
      if (!requireCurrentApproval) {
        yield mapped;
        continue;
      }
      // Legacy rows can use an inferred hash, while v3 only uses the approved bytes.
      if (!row.contentHash || !SHA256_HEX_RE.test(row.contentHash)) continue;
      const { industry: _industry, ...company } = mapped;
      if (validateRawSourceProviderPayload('channel_catalog', company).ok) yield company;
    }
    if (page.length < CHANNEL_ROW_PAGE_SIZE) return;
    after = page[page.length - 1]!.dedupeKey;
  }
}

/** Choose an eligible match per enabled channel per round, with all APPROVED before any PENDING. */
export async function queryChannelCatalogRecords(
  prisma: PrismaClient,
  input: ChannelCatalogQueryInput,
  requireCurrentApproval = false,
): Promise<ProviderCompanyRecord[]> {
  const records: ProviderCompanyRecord[] = [];
  const seen = new Set<string>();
  const statuses = requireCurrentApproval ? ['APPROVED'] : REVIEWED_FIRST;
  for (const reviewStatus of statuses) {
    const reviewedRecordFilter = {
      reviewStatus,
      ...(requireCurrentApproval ? { contentHash: { equals: prisma.sourceChannelRecord.fields.reviewedContentHash } } : {}),
    } satisfies Prisma.SourceChannelRecordWhereInput;
    const channels = await prisma.sourceChannel.findMany({
      where: {
        status: 'ENABLED',
        records: { some: {
          ...reviewedRecordFilter,
          ...(input.countries.length > 0 ? { country: { not: null } } : {}),
        } },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    let active = channels.map(({ id }) => findChannelMatches(prisma, id, reviewedRecordFilter, input, requireCurrentApproval));
    while (active.length > 0) {
      const nextRound: typeof active = [];
      for (let offset = 0; offset < active.length; offset += CHANNEL_QUERY_CONCURRENCY) {
        const batch = active.slice(offset, offset + CHANNEL_QUERY_CONCURRENCY);
        const results = await Promise.all(batch.map((source) => source.next()));
        for (const [index, result] of results.entries()) {
          if (result.done) continue;
          nextRound.push(batch[index]!);
          const row = result.value;
          const key = row.domain ?? row.externalId;
          if (seen.has(key)) continue;
          seen.add(key);
          records.push(row);
          if (records.length >= input.limit) return records;
        }
      }
      active = nextRound;
    }
  }
  return records;
}
