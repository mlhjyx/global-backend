import type { Prisma } from '@prisma/client';
import type { EnrichmentResult } from '../discovery/provider-contract';
import {
  buildSignalRow,
  persistSignalRows,
  type CompanySignalStore,
  type ParsedSignalItem,
} from './company-signals';

export interface LeadPackageCompanySignal {
  readonly providerKey: string;
  readonly signalKind: string;
  readonly sourceUrl: string;
  readonly title: string;
  readonly excerpt: string | null;
  readonly observedAt: Date | string;
}

export interface LeadPackageSignalItem {
  readonly type: string;
  readonly at: string;
  readonly url: string | null;
  readonly title?: string;
  readonly excerpt?: string;
  readonly provider?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function httpsUrlOrNull(value: unknown): string | null {
  const s = nonEmptyString(value);
  return s && s.startsWith('https://') ? s : null;
}

function stringList(value: unknown, max = 8): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, max);
}

function positiveInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

function fallbackUrlForDomain(domain: string | null | undefined): string | null {
  const clean = nonEmptyString(domain);
  return clean ? `https://${clean.replace(/^https?:\/\//iu, '').replace(/\/+$/u, '')}/` : null;
}

/**
 * Maps `digital_footprint` and `structured_harvest` enrichment hits into CHECK-safe
 * `company_signal` rows (`signalKind: 'page_change'`, company-level public facts only).
 */
export function projectEnrichmentHitsToSignals(
  hits: readonly { key: string; result: EnrichmentResult }[],
  observedAt: Date,
  companyDomain?: string | null,
): ParsedSignalItem[] {
  const items: ParsedSignalItem[] = [];
  for (const { key, result } of hits) {
    if (!result.matched) continue;
    const attrs = asRecord(result.attributes);
    const provenanceUrl =
      httpsUrlOrNull(result.provenance?.sourceUrl) ?? fallbackUrlForDomain(companyDomain);

    if (key === 'digital_footprint') {
      if (attrs.is_advertiser === true && provenanceUrl) {
        const pixels = stringList(attrs.ad_pixels, 6);
        items.push({
          providerKey: 'digital_footprint',
          signalKind: 'page_change',
          sourceUrl: provenanceUrl,
          title: '正在投放付费广告（广告像素活跃）',
          excerpt: pixels.length ? `检测到广告像素：${pixels.join(', ')}` : null,
          observedAt,
        });
      }
      const hiring = asRecord(attrs.hiring_signal);
      const openRoles = positiveInt(hiring.open_roles);
      if (openRoles > 0 && provenanceUrl) {
        const titles = stringList(hiring.titles, 6);
        items.push({
          providerKey: 'digital_footprint',
          signalKind: 'page_change',
          sourceUrl: provenanceUrl,
          title: `官网发布招聘岗位（${openRoles} 个开放职位）`,
          excerpt: titles.length ? titles.join(' / ').slice(0, 400) : null,
          observedAt,
        });
      }
    }

    if (key === 'structured_harvest') {
      const hiring = asRecord(attrs.hiring_signal);
      const openRoles = positiveInt(hiring.open_roles);
      const sourceUrl = httpsUrlOrNull(attrs.careers_url) ?? provenanceUrl;
      if (openRoles > 0 && sourceUrl) {
        const titles = stringList(hiring.titles, 6);
        const hasBuyingRole = hiring.has_buying_role === true;
        items.push({
          providerKey: 'structured_harvest',
          signalKind: 'page_change',
          sourceUrl,
          title: hasBuyingRole
            ? `正在招聘采购/供应链相关岗位（${openRoles} 个开放职位）`
            : `官网招聘页面活跃（${openRoles} 个开放职位）`,
          excerpt: titles.length ? titles.join(' / ').slice(0, 400) : null,
          observedAt,
        });
      }
    }
  }
  return items;
}

/**
 * Persists enrichment-derived company signals into `company_signal` inside the caller's
 * tenant-scoped transaction. Idempotent via `(workspace_id, ingest_key)` skipDuplicates.
 */
export async function persistEnrichmentCompanySignals(
  tx: Prisma.TransactionClient,
  args: {
    workspaceId: string;
    companyId: string;
    hits: readonly { key: string; result: EnrichmentResult }[];
    signalTimestamp: Date;
    companyDomain?: string | null;
  },
): Promise<{ inserted: number; skipped: number }> {
  const signalRepo = (tx as unknown as Partial<CompanySignalStore>).companySignal;
  if (typeof signalRepo?.createMany !== 'function') return { inserted: 0, skipped: 0 };
  const items = projectEnrichmentHitsToSignals(args.hits, args.signalTimestamp, args.companyDomain);
  if (items.length === 0) return { inserted: 0, skipped: 0 };
  const rows = items.map((item) => buildSignalRow(item, args.companyId));
  return persistSignalRows(tx as unknown as CompanySignalStore, args.workspaceId, rows);
}

/** Loads the newest company-level signals from `company_signal` for delivery read models. */
export async function loadCompanySignalsForLead(
  tx: Prisma.TransactionClient,
  companyId: string,
  limit = 10,
): Promise<LeadPackageCompanySignal[]> {
  const repo = tx.companySignal as
    | { findMany?: (input: unknown) => Promise<LeadPackageCompanySignal[]> }
    | undefined;
  if (typeof repo?.findMany !== 'function') return [];
  return repo.findMany({
    where: { companyId },
    orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
    take: limit,
    select: {
      providerKey: true,
      signalKind: true,
      sourceUrl: true,
      title: true,
      excerpt: true,
      observedAt: true,
    },
  });
}

function inferSignalType(row: LeadPackageCompanySignal): string {
  const title = row.title.toLowerCase();
  if (row.providerKey === 'structured_harvest') {
    return /采购|供应链|procurement|buying|sourcing|purchas/iu.test(title)
      ? 'HIRING_BUYING_ROLE'
      : 'HIRING_UP';
  }
  if (row.providerKey === 'digital_footprint') {
    if (/广告|advertis|pixel/iu.test(title)) return 'AD_CAMPAIGN_ACTIVE';
    if (/招聘|hiring|职位|job/iu.test(title)) return 'HIRING_UP';
  }
  if (row.signalKind === 'rss_item' || row.providerKey === 'rss') return 'NEWS_MENTION';
  return 'WEBSITE_CHANGE';
}

function isoString(value: Date | string | unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  return null;
}

/**
 * Projects stored `company_signal` rows and (when absent) existing `attributes.structured_harvest` /
 * `attributes.digital_footprint` enrichment facts into readable `LeadPackage.signals` items.
 */
export function projectStoredAndFallbackSignals(
  attributes: Record<string, unknown>,
  companySignals?: readonly LeadPackageCompanySignal[],
): LeadPackageSignalItem[] {
  const out: LeadPackageSignalItem[] = [];
  for (const row of companySignals ?? []) {
    const at = isoString(row.observedAt);
    if (!at) continue;
    const url = httpsUrlOrNull(row.sourceUrl);
    const title = nonEmptyString(row.title) ?? undefined;
    const excerpt = nonEmptyString(row.excerpt) ?? undefined;
    const provider = nonEmptyString(row.providerKey) ?? undefined;
    out.push({
      type: inferSignalType(row),
      at,
      url,
      ...(title ? { title } : {}),
      ...(excerpt ? { excerpt } : {}),
      ...(provider ? { provider } : {}),
    });
  }

  // Fallback for already-enriched companies whose attributes predate company_signal projection.
  const structured = asRecord(attributes.structured_harvest);
  const shHiring = asRecord(structured.hiring_signal);
  const shOpen = positiveInt(shHiring.open_roles);
  const shAt = isoString(structured._ts);
  if (shOpen > 0 && shAt) {
    const hasBuying = shHiring.has_buying_role === true;
    const titles = stringList(shHiring.titles, 6);
    out.push({
      type: hasBuying ? 'HIRING_BUYING_ROLE' : 'HIRING_UP',
      at: shAt,
      url: httpsUrlOrNull(structured.careers_url),
      title: hasBuying
        ? `正在招聘采购/供应链相关岗位（${shOpen} 个开放职位）`
        : `官网招聘页面活跃（${shOpen} 个开放职位）`,
      ...(titles.length ? { excerpt: titles.join(' / ').slice(0, 400) } : {}),
      provider: 'structured_harvest',
    });
  }

  const footprint = asRecord(attributes.digital_footprint);
  const fpAt = isoString(footprint._ts);
  if (fpAt) {
    const profileUrl = httpsUrlOrNull(asRecord(attributes.website_profile).source_url);
    if (footprint.is_advertiser === true) {
      const pixels = stringList(footprint.ad_pixels, 6);
      out.push({
        type: 'AD_CAMPAIGN_ACTIVE',
        at: fpAt,
        url: profileUrl,
        title: '正在投放付费广告（广告像素活跃）',
        ...(pixels.length ? { excerpt: `检测到广告像素：${pixels.join(', ')}` } : {}),
        provider: 'digital_footprint',
      });
    }
    const fpHiring = asRecord(footprint.hiring_signal);
    const fpOpen = positiveInt(fpHiring.open_roles);
    if (fpOpen > 0) {
      const titles = stringList(fpHiring.titles, 6);
      out.push({
        type: 'HIRING_UP',
        at: fpAt,
        url: profileUrl,
        title: `官网发布招聘岗位（${fpOpen} 个开放职位）`,
        ...(titles.length ? { excerpt: titles.join(' / ').slice(0, 400) } : {}),
        provider: 'digital_footprint',
      });
    }
  }
  return out;
}
