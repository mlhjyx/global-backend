import { Injectable, NotFoundException } from '@nestjs/common';
import type { RequestContext } from '../auth/request-context';
import { isIso3166Alpha2 } from '../discovery/iso3166';
import { PrismaService } from '../prisma/prisma.service';
import {
  COMTRADE_HS_CATALOG,
  DEFAULT_FALLBACK_HS_CODE,
  type ComtradeHsCatalogEntry,
} from './comtrade-market-data';
import {
  COMTRADE_MONTHLY_FLOWS,
  COMTRADE_MONTHLY_PERIOD,
  COMTRADE_MONTHLY_PREVIOUS_PERIOD,
} from './comtrade-monthly-2026';

const REGION_NAME_ZH = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
const REGION_NAME_EN = new Intl.DisplayNames(['en'], { type: 'region' });

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
    readonly referencePeriod?: string;
    readonly coverage?: number;
    readonly shareBasis?: 'comparable_reporters';
  };
  readonly recommendations: readonly MarketRecommendationItem[];
  readonly generatedAt: string;
}

interface MatchedEntry {
  readonly entry: Pick<ComtradeHsCatalogEntry, 'code' | 'label' | 'labelZh'>;
  readonly matchedFrom: string;
  readonly score: number;
}

function normalizeHsCode(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/gu, '');
  if (digits.length < 4 || digits.length > 10) return null;
  return digits.slice(0, 6);
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
    if (uniqueCodes.length > 0) {
      // A heading and its child include the same flows. Keep the most specific request.
      const codes = uniqueCodes.filter((code) =>
        !uniqueCodes.some((other) => other !== code && other.startsWith(code)),
      );
      return {
        entries: codes.map((code) => ({
          entry: COMTRADE_HS_CATALOG.find((entry) => entry.code === code) ??
            { code, label: `HS ${code}`, labelZh: `HS ${code}` },
          matchedFrom: `query:${code}`,
          score: 10,
        })),
        inferredFrom: 'query_hs',
      };
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
): { coverage: number; recommendations: MarketRecommendationItem[] } {
  const hsCodes = matched.map(({ entry }) => entry.code);
  const byReporter = new Map<string, { currentUsd: number; previousUsd: number; matchedCodes: number }>();

  for (const hsCode of hsCodes) {
    const flows = COMTRADE_MONTHLY_FLOWS[hsCode];
    if (!flows?.length) return { coverage: 0, recommendations: [] };

    const seenReporters = new Set<string>();
    for (const { code, importValueUsd, previousImportValueUsd } of flows) {
      const reporter = code.trim().toUpperCase();
      // The repository's country helper also accepts XK. This series needs assigned ISO codes.
      if (!isIso3166Alpha2(reporter) || reporter === 'XK' || seenReporters.has(reporter) ||
          !Number.isFinite(importValueUsd) || importValueUsd <= 0 ||
          !Number.isFinite(previousImportValueUsd) || previousImportValueUsd <= 0) continue;

      seenReporters.add(reporter);
      const totals = byReporter.get(reporter) ?? { currentUsd: 0, previousUsd: 0, matchedCodes: 0 };
      totals.currentUsd += importValueUsd;
      totals.previousUsd += previousImportValueUsd;
      totals.matchedCodes += 1;
      byReporter.set(reporter, totals);
    }
  }

  const confidence: 'high' | 'medium' | 'low' =
    inferredFrom === 'query_hs'
      ? 'high'
      : inferredFrom === 'offerings_and_industry'
        ? 'medium'
        : 'low';

  const comparable = [...byReporter].filter(([, totals]) => totals.matchedCodes === hsCodes.length);
  const comparableImportUsd = comparable.reduce((sum, [, totals]) => sum + totals.currentUsd, 0);
  const recommendations = comparable
    .sort(([codeA, a], [codeB, b]) => b.currentUsd - a.currentUsd || codeA.localeCompare(codeB))
    .slice(0, limit)
    .map(([code, totals], idx) => ({
      code,
      name: REGION_NAME_ZH.of(code) ?? code,
      labelEn: REGION_NAME_EN.of(code) ?? code,
      rank: idx + 1,
      hsCodes,
      importVolumeUsd: totals.currentUsd,
      yoyGrowthPct: Number(((totals.currentUsd / totals.previousUsd - 1) * 100).toFixed(1)),
      globalImportSharePct: Number((totals.currentUsd / comparableImportUsd * 100).toFixed(1)),
      rationale: `UN Comtrade ${COMTRADE_MONTHLY_PERIOD} 进口额与 ${COMTRADE_MONTHLY_PREVIOUS_PERIOD} 同月申报对比。`,
      confidence,
      alreadySelected: selectedMarkets.has(code),
    }));
  return { coverage: comparable.length, recommendations };
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
    const { coverage, recommendations } = aggregateRecommendations(entries, inferredFrom, selectedMarkets, limit);

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
        dataSource: 'un_comtrade_live',
        referenceYear: Number(COMTRADE_MONTHLY_PERIOD.slice(0, 4)),
        referencePeriod: COMTRADE_MONTHLY_PERIOD,
        coverage,
        shareBasis: 'comparable_reporters',
      },
      recommendations,
      generatedAt: new Date().toISOString(),
    };
  }
}
