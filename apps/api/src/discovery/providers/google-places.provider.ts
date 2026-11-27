import { createHash } from 'node:crypto';
import type { GooglePlaceHit } from '../../adapters/search-providers';
import { isExecutionControlError } from '../../execution-budget/execution-control-error';
import { BudgetOperationReplayError } from '../../tools/budget-store';
import type { GooglePlacesToolInput, GooglePlacesToolOutput } from '../../tools/search-provider-tools';
import { ToolDurableResultProjectionError } from '../../tools/tool-broker';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import {
  DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
  buildDiscoveryCompanyResultLineage,
  createDiscoveryCompanyReceiptCollector,
  isDiscoveryCompanyLineageInvalid,
  type DiscoveryCompanyReceiptObservation,
} from '../company-discovery-lineage';
import { MAX_GOOGLE_PLACES_DISCOVER_SEARCHES_PER_QUERY } from '../execution-envelope';
import { companyIdentity, normalizeDomain } from '../identity';
import {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  DiscoveryOptions,
  DiscoveryResult,
  ExecutionContext,
  ProviderCompanyRecord,
  SourceClass,
} from '../provider-contract';
import { isProviderCompanyName } from '../raw-source-provider-normalizer';
import { targetCountryCodes } from '../search-localization';
import {
  buildGooglePlacesDiscoveryQueries,
  isGooglePlacesNonCompanyDomain,
} from './google-places-grid';

export const GOOGLE_PLACES_PARSER_VERSION = 'google_places/v1' as const;
export const GOOGLE_PLACES_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText' as const;
export const GOOGLE_PLACES_LICENSE = 'GOOGLE_MAPS_PLACE_ID_ONLY' as const;
export const GOOGLE_PLACES_ID_SCHEME = 'google-place-id' as const;
const GOOGLE_PLACE_ID_RE = /^[A-Za-z0-9_-]{1,256}$/u;
const GOOGLE_PLACES_PER_CALL_RESULT_CAP = 20;
const STOP_LOOP_ERROR_RE =
  /GOOGLE_PLACES_(?:DAILY_LIMIT_EXCEEDED|API_KEY_REJECTED|BALANCE_INSUFFICIENT|RATE_LIMITED)/u;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function resolveMaxGooglePlacesDiscoverQueries(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = (env.GOOGLE_PLACES_MAX_SEARCHES_PER_QUERY ?? '').trim();
  if (!/^\d+$/u.test(raw)) return MAX_GOOGLE_PLACES_DISCOVER_SEARCHES_PER_QUERY;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return MAX_GOOGLE_PLACES_DISCOVER_SEARCHES_PER_QUERY;
  }
  return Math.min(parsed, MAX_GOOGLE_PLACES_DISCOVER_SEARCHES_PER_QUERY);
}

/**
 * 严格遵循 Google Maps Platform Terms §3.2.3 的公司发现映射：
 *  1) 仅准入携带有效企业自有官网（websiteUri → domain，剔除社媒/黄页/平台站）的商家实体，
 *     下游由 website_profile 抓取企业官网作为公司事实权威来源；
 *  2) 长期标识仅留存 place_id（Maps Service Specific Terms 豁免长期保存）与内部路由 source_class，
 *     不采集、不落库街道地址、电话、评分、营业时间、坐标或任何用户评论/个人数据；
 *  3) Raw 记录经 source_policy (places.googleapis.com) 强制 retentionDays=1 自动过期。
 */
export function mapGooglePlaceHitToRecord(
  place: GooglePlaceHit,
  opts: Readonly<{ fetchedAt: string; fallbackCountry?: string; sourceClass?: SourceClass }>,
): ProviderCompanyRecord | null {
  const placeId = place.placeId.trim();
  if (!placeId || !GOOGLE_PLACE_ID_RE.test(placeId)) return null;

  const domain = place.websiteUri ? normalizeDomain(place.websiteUri) : null;
  if (!domain || isGooglePlacesNonCompanyDomain(domain)) return null;

  const rawName = (place.name ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const safeName = rawName && rawName.length <= 160 && isProviderCompanyName(rawName) ? rawName : '';
  if (!safeName) return null;

  const countryCandidate = (place.countryCode ?? opts.fallbackCountry ?? '').trim().toUpperCase();
  const country = /^[A-Z]{2}$/u.test(countryCandidate) ? countryCandidate : undefined;

  return {
    externalId: `google_places:${sha256(placeId)}`,
    name: safeName,
    domain,
    ...(country ? { country } : {}),
    identifier: {
      scheme: GOOGLE_PLACES_ID_SCHEME,
      value: placeId,
    },
    license: GOOGLE_PLACES_LICENSE,
    attributes: {
      google_places: {
        place_id: placeId,
        source_class: opts.sourceClass ?? 'industry_data',
      },
    },
    provenance: {
      sourceUrl: GOOGLE_PLACES_SEARCH_URL,
      fetchedAt: opts.fetchedAt,
      contentHash: sha256(`google_places:${placeId}:${domain}`),
      parserVersion: GOOGLE_PLACES_PARSER_VERSION,
    },
  };
}

function invokeGooglePlacesDiscover(
  broker: ExecutionBroker,
  input: GooglePlacesToolInput,
  ctx: ToolContext,
) {
  return broker.invoke<GooglePlacesToolInput, GooglePlacesToolOutput>(
    'google_places.discover',
    input,
    ctx,
  );
}

/**
 * Google Maps Places API 公司发现源（industry_data 类）。
 *
 * 按「目标国重点城市 × 行业类目」（光伏安装商、光伏 EPC、电气分销商及通用行业回退）
 * 通过受治理工具 `google_places.discover` 发现候选企业。
 *
 * 治理与合规护栏：
 *  - `data_provider.google_places` seed 默认 DISABLED，由运维开启；
 *  - 紧急环境开关 `GOOGLE_PLACES_PROVIDER=off` 可立即摘除血缘声明与路由；
 *  - 工具层强制 `sourcePolicy: 'required'` (`places.googleapis.com`, `retentionDays=1`)、
 *    `sourceKey: 'google_places'`（source_compliance_matrix）以及每日调用上限；
 *  - 单次查询上限 3 次调用，接入 ToolBroker 成本记账与受治理公司血缘。
 */
export class GooglePlacesDiscoveryProvider implements CompanyDiscoveryAdapter {
  readonly key = 'google_places';
  readonly classes: SourceClass[] = ['industry_data'];
  readonly companyResultLineage?: typeof DISCOVERY_COMPANY_RESULT_LINEAGE_V1;
  private readonly maxQueriesPerQuery: number;

  constructor(
    private readonly deps?: {
      broker?: ExecutionBroker;
      env?: NodeJS.ProcessEnv;
      lineageEnabled?: boolean;
      maxQueriesPerQuery?: number;
    },
  ) {
    const env = deps?.env ?? process.env;
    const enabled =
      deps?.lineageEnabled ?? (env.GOOGLE_PLACES_PROVIDER ?? '').trim().toLowerCase() !== 'off';
    if (enabled) this.companyResultLineage = DISCOVERY_COMPANY_RESULT_LINEAGE_V1;
    this.maxQueriesPerQuery = Math.min(
      MAX_GOOGLE_PLACES_DISCOVER_SEARCHES_PER_QUERY,
      Math.max(1, Math.trunc(deps?.maxQueriesPerQuery ?? resolveMaxGooglePlacesDiscoverQueries(env))),
    );
  }

  private enabled(): boolean {
    return this.companyResultLineage === DISCOVERY_COMPANY_RESULT_LINEAGE_V1;
  }

  private emptyLineage(): DiscoveryResult {
    return {
      records: [],
      costCents: 0,
      lineage: buildDiscoveryCompanyResultLineage({
        providerKey: 'google_places',
        recordCount: 0,
        observations: [],
      }),
    };
  }

  async discoverCompanies(
    query: CompanyDiscoveryQuery,
    ctx: ExecutionContext,
    opts?: DiscoveryOptions,
  ): Promise<DiscoveryResult> {
    if (!this.enabled()) return { records: [], costCents: 0 };

    const broker = this.deps?.broker;
    if (!broker) {
      console.warn('[google_places] broker unavailable, fail-closed (no raw egress)');
      return this.emptyLineage();
    }

    const grid = buildGooglePlacesDiscoveryQueries(query, this.maxQueriesPerQuery);
    if (grid.length === 0) return this.emptyLineage();

    const blocked = new Set((opts?.blockedDomains ?? []).map((domain) => domain.toLowerCase()));
    const fallbackCountry = targetCountryCodes(query)[0]?.toUpperCase();
    const recordCap = Math.max(1, query.limit ?? GOOGLE_PLACES_PER_CALL_RESULT_CAP);
    const perCallLimit = Math.min(GOOGLE_PLACES_PER_CALL_RESULT_CAP, recordCap);

    const dedup = new Map<string, ProviderCompanyRecord>();
    const observations: DiscoveryCompanyReceiptObservation[] = [];
    let totalCostCents = 0;

    for (const item of grid) {
      if (dedup.size >= recordCap) break;
      const collector = createDiscoveryCompanyReceiptCollector({
        providerKey: 'google_places',
        producerId: 'google_places.discover',
        parentOnDurableReceipt: ctx.onDurableReceipt,
      });
      collector.markExpectedInvocation();
      let places: GooglePlaceHit[];
      let degraded = false;
      try {
        const res = await invokeGooglePlacesDiscover(
          broker,
          {
            textQuery: item.textQuery,
            maxResultCount: perCallLimit,
            ...(item.regionCode ? { regionCode: item.regionCode } : {}),
            languageCode: item.languageCode,
          },
          { ...ctx, onDurableReceipt: collector.onDurableReceipt, purpose: 'discovery' },
        );
        places = res.data?.places ?? [];
        totalCostCents += Number.isSafeInteger(res.costCents) && res.costCents > 0 ? res.costCents : 0;
        degraded = res.degraded === true;
      } catch (err) {
        if (
          collector.isForwardingFailure(err) ||
          isDiscoveryCompanyLineageInvalid(err) ||
          err instanceof BudgetOperationReplayError ||
          isExecutionControlError(err)
        ) {
          throw err;
        }
        if (err instanceof ToolDurableResultProjectionError || err instanceof Error) {
          collector.markInvocationFailed();
        }
        const message = String(err);
        console.warn(`[google_places] discover failed: ${message.slice(0, 150)}`);
        observations.push(collector.finish([]));
        if (STOP_LOOP_ERROR_RE.test(message)) break;
        continue;
      }

      const fetchedAt = new Date().toISOString();
      const recordIndexes: number[] = [];
      for (const place of places) {
        if (dedup.size >= recordCap) break;
        const rec = mapGooglePlaceHitToRecord(place, {
          fetchedAt,
          fallbackCountry,
          sourceClass: query.sourceClass,
        });
        if (!rec || (rec.domain && blocked.has(rec.domain))) continue;
        const dedupeKey = companyIdentity({
          name: rec.name,
          domain: rec.domain,
          country: rec.country,
          identifier: rec.identifier,
        }).dedupeKey;
        if (!dedup.has(dedupeKey)) {
          recordIndexes.push(dedup.size);
          dedup.set(dedupeKey, rec);
        }
      }
      observations.push(collector.finish(recordIndexes));
      if (degraded) break;
    }

    const records = [...dedup.values()];
    const lineage = buildDiscoveryCompanyResultLineage({
      providerKey: 'google_places',
      recordCount: records.length,
      observations,
    });
    return {
      records,
      costCents: totalCostCents,
      ...(lineage ? { lineage } : {}),
    };
  }
}
