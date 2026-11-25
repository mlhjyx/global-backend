/**
 * 本地平台渠道库（`source_channel_record`）确定性查询与记录映射（Batch 1.4-B）：
 *
 * 零出网、零成本：仅读取 `reviewStatus = 'APPROVED'` 且所属 `source_channel.status = 'ENABLED'`
 * 的已审展会/协会/名录企业记录，按国家与行业/关键词确定性过滤后映射为 `ProviderCompanyRecord`。
 * 个人联系人字段（contactName/email/phone）留在本表不带入公司级 Raw 记录（遵循数据最小化）。
 */
import type { PrismaClient } from '@prisma/client';
import { normalizeCompanyNameTypography } from '../discovery/company-name-format';
import { normalizeDomain } from '../discovery/identity';
import { isIso3166Alpha2 } from '../discovery/iso3166';
import { isStableSafeHttpsUrl } from '../discovery/raw-source-provider-normalizer';
import { targetCountryCodes } from '../discovery/search-localization';
import { lookupCountryIso } from '../discovery/vocab';
import type { ProviderCompanyRecord } from '../discovery/provider-contract';

export const CHANNEL_CATALOG_DEFAULT_LIMIT = 100;
export const CHANNEL_CATALOG_MAX_LIMIT = 500;
const PARSER_VERSION = 'channel_catalog/v1';

export interface ChannelCatalogRow {
  readonly id: string;
  readonly channelId: string;
  readonly dedupeKey: string;
  readonly name: string;
  readonly website: string | null;
  readonly country: string | null;
  readonly industry: string | null;
  readonly products: unknown;
  readonly keywords: unknown;
  readonly sourceUrl: string;
  readonly contentHash: string;
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

/** 单行 `source_channel_record` → `ProviderCompanyRecord`（零 PII，稳定 ASCII externalId）。 */
export function mapChannelCatalogRowToRecord(row: ChannelCatalogRow): ProviderCompanyRecord | null {
  const name = normalizeCompanyNameTypography(row.name);
  if (!name) return null;
  const domain = row.website ? normalizeDomain(row.website) : undefined;
  const country = normalizeCountryToIso2(row.country);
  const safeExternalId = `channel_catalog:${row.channelId}:${row.id}`.slice(0, 200);
  const sourceUrl = safeProvenanceUrl(row.sourceUrl) ?? (domain ? `https://${domain}/` : undefined);
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
      contentHash: row.contentHash,
      parserVersion: PARSER_VERSION,
    },
  };
}

/** 读平台表 `source_channel_record`（仅 APPROVED 记录 + ENABLED 渠道；确定性排序）。 */
export async function queryChannelCatalogRecords(
  prisma: PrismaClient,
  input: ChannelCatalogQueryInput,
): Promise<ProviderCompanyRecord[]> {
  const rows = (await prisma.sourceChannelRecord.findMany({
    where: {
      reviewStatus: 'APPROVED',
      channel: { status: 'ENABLED' },
    },
    orderBy: [{ channelId: 'asc' }, { dedupeKey: 'asc' }],
    take: Math.min(2_000, input.limit * 4),
    select: {
      id: true,
      channelId: true,
      dedupeKey: true,
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
    },
  })) as ChannelCatalogRow[];

  const records: ProviderCompanyRecord[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!rowMatchesFilters(row, input)) continue;
    const mapped = mapChannelCatalogRowToRecord(row);
    if (!mapped) continue;
    const key = mapped.domain ?? mapped.externalId;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(mapped);
    if (records.length >= input.limit) break;
  }
  return records;
}
