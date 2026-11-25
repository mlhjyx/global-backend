import { Injectable, NotFoundException } from '@nestjs/common';
import type { RequestContext } from '../auth/request-context';
import { PrismaService } from '../prisma/prisma.service';
import {
  COMTRADE_HS_CATALOG,
  COMTRADE_REFERENCE_YEAR,
  DEFAULT_FALLBACK_HS_CODE,
  type ComtradeHsCatalogEntry,
} from './comtrade-market-data';

export interface MarketRecommendationHsBasis {
  readonly code: string;
  readonly label: string;
  readonly labelZh: string;
  readonly matchedFrom: string;
}

export interface MarketRecommendationItem {
  readonly code: string;
  readonly name: string;
  readonly labelEn: string;
  readonly rank: number;
  readonly hsCodes: readonly string[];
  readonly importVolumeUsd: number;
  readonly yoyGrowthPct: number;
  readonly globalImportSharePct: number;
  readonly rationale: string;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly alreadySelected: boolean;
}

export interface MarketRecommendationsResponse {
  readonly companyId: string;
  readonly isRecommendationOnly: true;
  readonly basis: {
    readonly hsCodes: readonly MarketRecommendationHsBasis[];
    readonly inferredFrom: 'query_hs' | 'offerings_and_industry' | 'fallback_general';
    readonly dataSource: 'un_comtrade_baseline_v1' | 'un_comtrade_live';
    readonly referenceYear: number;
  };
  readonly recommendations: readonly MarketRecommendationItem[];
  readonly generatedAt: string;
}

interface MatchedEntry {
  readonly entry: ComtradeHsCatalogEntry;
  readonly matchedFrom: string;
  readonly score: number;
}

function normalizeHsCode(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/gu, '');
  if (digits.length < 4 || digits.length > 10) return null;
  return digits.slice(0, 6);
}

function findEntryByHsCode(hsCode: string): ComtradeHsCatalogEntry | null {
  const exact = COMTRADE_HS_CATALOG.find((e) => e.code === hsCode);
  if (exact) return exact;
  const prefix4 = hsCode.slice(0, 4);
  return COMTRADE_HS_CATALOG.find((e) => e.code.startsWith(prefix4)) ?? null;
}

function inferEntriesFromSellerContext(texts: readonly { text: string; source: string }[]): MatchedEntry[] {
  const scored: MatchedEntry[] = [];
  for (const entry of COMTRADE_HS_CATALOG) {
    if (entry.code === DEFAULT_FALLBACK_HS_CODE) continue;
    let bestScore = 0;
    let bestSource = '';
    for (const item of texts) {
      const lower = item.text.toLowerCase();
      if (!lower) continue;
      let hits = 0;
      for (const kw of entry.keywords) {
        if (lower.includes(kw.toLowerCase())) hits += 1;
      }
      if (hits > bestScore) {
        bestScore = hits;
        bestSource = item.source;
      }
    }
    if (bestScore > 0) {
      scored.push({ entry, matchedFrom: bestSource, score: bestScore });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.entry.code.localeCompare(b.entry.code));
  return scored.slice(0, 3);
}

function resolveMatchedEntries(
  queryHsCodes: string | undefined,
  sellerTexts: readonly { text: string; source: string }[],
): {
  entries: MatchedEntry[];
  inferredFrom: 'query_hs' | 'offerings_and_industry' | 'fallback_general';
} {
  if (queryHsCodes && queryHsCodes.trim()) {
    const requested = queryHsCodes
      .split(/[,，;\s]+/u)
      .map(normalizeHsCode)
      .filter((code): code is string => code !== null);
    const uniqueCodes = [...new Set(requested)].slice(0, 5);
    const matched: MatchedEntry[] = [];
    for (const code of uniqueCodes) {
      const entry = findEntryByHsCode(code);
      if (entry) {
        matched.push({ entry, matchedFrom: `query:${code}`, score: 10 });
      }
    }
    if (matched.length > 0) {
      return { entries: matched, inferredFrom: 'query_hs' };
    }
  }

  const inferred = inferEntriesFromSellerContext(sellerTexts);
  if (inferred.length > 0) {
    return { entries: inferred, inferredFrom: 'offerings_and_industry' };
  }

  const fallback = COMTRADE_HS_CATALOG.find((e) => e.code === DEFAULT_FALLBACK_HS_CODE)!;
  return {
    entries: [{ entry: fallback, matchedFrom: 'default_general_b2b', score: 0 }],
    inferredFrom: 'fallback_general',
  };
}

function aggregateRecommendations(
  matched: readonly MatchedEntry[],
  inferredFrom: 'query_hs' | 'offerings_and_industry' | 'fallback_general',
  selectedMarkets: ReadonlySet<string>,
  limit: number,
): MarketRecommendationItem[] {
  const byCountry = new Map<
    string,
    {
      code: string;
      name: string;
      labelEn: string;
      hsCodes: Set<string>;
      totalVolumeUsd: number;
      weightedGrowthSum: number;
      weightedShareSum: number;
      rationale: string;
      topVolume: number;
    }
  >();

  for (const { entry } of matched) {
    for (const flow of entry.markets) {
      const existing = byCountry.get(flow.code);
      if (!existing) {
        byCountry.set(flow.code, {
          code: flow.code,
          name: flow.name,
          labelEn: flow.labelEn,
          hsCodes: new Set([entry.code]),
          totalVolumeUsd: flow.importVolumeUsd,
          weightedGrowthSum: flow.yoyGrowthPct * flow.importVolumeUsd,
          weightedShareSum: flow.globalImportSharePct * flow.importVolumeUsd,
          rationale: flow.rationale,
          topVolume: flow.importVolumeUsd,
        });
      } else {
        existing.hsCodes.add(entry.code);
        existing.totalVolumeUsd += flow.importVolumeUsd;
        existing.weightedGrowthSum += flow.yoyGrowthPct * flow.importVolumeUsd;
        existing.weightedShareSum += flow.globalImportSharePct * flow.importVolumeUsd;
        if (flow.importVolumeUsd > existing.topVolume) {
          existing.topVolume = flow.importVolumeUsd;
          existing.rationale = flow.rationale;
        }
      }
    }
  }

  const confidence: 'high' | 'medium' | 'low' =
    inferredFrom === 'query_hs'
      ? 'high'
      : inferredFrom === 'offerings_and_industry'
        ? 'medium'
        : 'low';

  return [...byCountry.values()]
    .sort((a, b) => b.totalVolumeUsd - a.totalVolumeUsd || a.code.localeCompare(b.code))
    .slice(0, limit)
    .map((item, idx) => ({
      code: item.code,
      name: item.name,
      labelEn: item.labelEn,
      rank: idx + 1,
      hsCodes: [...item.hsCodes],
      importVolumeUsd: Math.round(item.totalVolumeUsd),
      yoyGrowthPct: Number((item.weightedGrowthSum / Math.max(1, item.totalVolumeUsd)).toFixed(1)),
      globalImportSharePct: Number(
        (item.weightedShareSum / Math.max(1, item.totalVolumeUsd)).toFixed(1),
      ),
      rationale: item.rationale,
      confidence,
      alreadySelected: selectedMarkets.has(item.code),
    }));
}

@Injectable()
export class ComtradeMarketRecommendationService {
  constructor(private readonly prisma: PrismaService) {}

  async recommendForCompany(
    ctx: RequestContext,
    companyId: string,
    opts: { hsCodes?: string; limit?: number } = {},
  ): Promise<MarketRecommendationsResponse> {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 8) || 8, 1), 20);
    const { company, offerings } = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.companyProfile.findUnique({ where: { id: companyId } });
      if (!company || company.deletedAt) {
        throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'company not found' } });
      }
      const offerings = await tx.offering.findMany({
        where: { companyId },
        select: { name: true, description: true, attributes: true },
        orderBy: { createdAt: 'asc' },
        take: 30,
      });
      return { company, offerings };
    });

    const selectedOfferings = offerings.filter(
      (o) =>
        !(
          o.attributes &&
          typeof o.attributes === 'object' &&
          !Array.isArray(o.attributes) &&
          (o.attributes as Record<string, unknown>).selectedByUser === false
        ),
    );
    const sellerTexts: { text: string; source: string }[] = [
      ...selectedOfferings.map((o) => ({
        text: `${o.name} ${o.description ?? ''}`.trim(),
        source: `offering:${o.name}`,
      })),
      ...(company.industry ? [{ text: company.industry, source: 'company:industry' }] : []),
      ...(company.summary ? [{ text: company.summary, source: 'company:summary' }] : []),
    ];

    const { entries, inferredFrom } = resolveMatchedEntries(opts.hsCodes, sellerTexts);
    const selectedMarkets = new Set(
      (company.targetMarkets ?? []).map((code) => code.trim().toUpperCase()),
    );
    const recommendations = aggregateRecommendations(entries, inferredFrom, selectedMarkets, limit);

    return {
      companyId: company.id,
      isRecommendationOnly: true,
      basis: {
        hsCodes: entries.map(({ entry, matchedFrom }) => ({
          code: entry.code,
          label: entry.label,
          labelZh: entry.labelZh,
          matchedFrom,
        })),
        inferredFrom,
        dataSource: 'un_comtrade_baseline_v1',
        referenceYear: COMTRADE_REFERENCE_YEAR,
      },
      recommendations,
      generatedAt: new Date().toISOString(),
    };
  }
}
