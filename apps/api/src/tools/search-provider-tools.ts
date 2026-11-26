/**
 * serper.search / exa.search / google_places.search —— L0 实时多引擎搜索 ToolBroker 工具。
 *
 * 治理口径（与 deepseek-tools.ts 保持同一执行权威契约）：
 *  - sourcePolicy=none：三者均为固定官方主机的搜索/地点基础设施，非被抓取的标的站点；
 *  - personalData=false：serper.search 与 exa.search 仅输出 url + title 并丢弃个人主页 URL
 *    （与 searxng.search / deepseek.search 同口径）；google_places.search 仅输出企业地点
 *    placeId / name / websiteUri / countryCode，且 durableReplayResult 仅保留 placeId
 *    （遵循 Google Maps Platform Terms §3.2.3 / D4）；
 *  - 缺 key 时诚实降级返回 degraded=true 空结果、costCents=0，绝不阻断离线/单测或其余源；
 *  - physicalWireObservation="before_each_wire"：每次物理出网前必触发 ctx.beforePhysicalWire。
 */
import { createHash } from 'node:crypto';
import { CATALOG_RESULT_PROJECTION_SCHEMAS } from '../durable-results/catalog-result-projections';
import {
  braveSearch,
  exaFindSimilar,
  exaSearch,
  googlePlacesSearchText,
  resolveBraveSearchApiKey,
  resolveExaApiKey,
  resolveGoogleMapsApiKey,
  resolveSerperApiKey,
  sanitizeSearchProviderUrl,
  serperSearch,
  type GooglePlaceHit,
  type SearchProviderHit,
} from '../adapters/search-providers';
import { assertToolExternalActionAuthorized, type Tool } from './tool-contract';
import { type ToolRegistry } from './tool-registry';
import { durableTitle, isDurableText, isPersonProfileUrl } from './durable-text';

const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 24);
const stableKey = (value: unknown): string => hash(JSON.stringify(value));

export const SEARCH_PROVIDER_MAX_RESULTS = 20;
const QUERY_MAX_CHARS = 300;
const URL_MAX_CHARS = 2048;
const TITLE_MAX_CHARS = 2000;
const PLACE_ID_MAX_CHARS = 256;
const PLACE_NAME_MAX_CHARS = 500;
const SERPER_REQUEST_COST_CENTS = 1;
const BRAVE_REQUEST_COST_CENTS = 1;
const EXA_REQUEST_COST_CENTS = 1;
/** Google Places New Text Search (Enterprise field websiteUri ≈ $0.035/req → ceil 4¢). */
const GOOGLE_PLACES_REQUEST_COST_CENTS = 4;

export type SearchProviderResultItem = { url: string; title?: string };
export type SearchProviderOutput = { results: SearchProviderResultItem[] };

export interface SerperSearchToolInput {
  query: string;
  num?: number;
  gl?: string;
  hl?: string;
}

export interface BraveSearchToolInput {
  query: string;
  count?: number;
  country?: string;
  searchLang?: string;
}

export interface ExaSearchToolInput {
  mode?: 'search' | 'find_similar';
  query?: string;
  similarUrl?: string;
  numResults?: number;
  excludeDomains?: string[];
  includeDomains?: string[];
  category?: 'company';
}

export interface SocialSerperSearchToolInput {
  query: string;
  num?: number;
  gl?: string;
  hl?: string;
}

export interface SocialExaPeopleToolInput {
  query: string;
  numResults?: number;
  includeDomains?: string[];
}

export interface GooglePlacesToolInput {
  textQuery: string;
  maxResultCount?: number;
  regionCode?: string;
  languageCode?: string;
}

export type GooglePlacesToolOutput = {
  places: Array<{
    placeId: string;
    name?: string;
    websiteUri?: string;
    countryCode?: string;
  }>;
};

function publicOrigin(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}/`;
  } catch {
    return null;
  }
}

function durableSearchHits(hits: readonly SearchProviderHit[]): SearchProviderResultItem[] {
  return hits
    .flatMap((hit): SearchProviderResultItem[] => {
      const url = sanitizeSearchProviderUrl(hit.url);
      if (
        !url ||
        url.length > URL_MAX_CHARS ||
        !isDurableText(url) ||
        isPersonProfileUrl(url)
      ) {
        return [];
      }
      const title =
        typeof hit.title === 'string' ? durableTitle(hit.title, TITLE_MAX_CHARS) : null;
      return [title === null ? { url } : { url, title }];
    })
    .slice(0, SEARCH_PROVIDER_MAX_RESULTS);
}

function durablePlaceHits(places: readonly GooglePlaceHit[]): GooglePlacesToolOutput['places'] {
  return places
    .flatMap((place): GooglePlacesToolOutput['places'] => {
      const placeId = place.placeId.trim();
      if (!placeId || placeId.length > PLACE_ID_MAX_CHARS || !isDurableText(placeId)) {
        return [];
      }
      const name =
        typeof place.name === 'string' ? durableTitle(place.name, PLACE_NAME_MAX_CHARS) : null;
      const websiteUri =
        place.websiteUri &&
        place.websiteUri.length <= URL_MAX_CHARS &&
        isDurableText(place.websiteUri) &&
        !isPersonProfileUrl(place.websiteUri)
          ? place.websiteUri
          : undefined;
      const countryCode =
        typeof place.countryCode === 'string' && /^[A-Z]{2}$/u.test(place.countryCode)
          ? place.countryCode
          : undefined;
      return [
        {
          placeId,
          ...(name !== null ? { name } : {}),
          ...(websiteUri ? { websiteUri } : {}),
          ...(countryCode ? { countryCode } : {}),
        },
      ];
    })
    .slice(0, SEARCH_PROVIDER_MAX_RESULTS);
}

function normalizeQueryString(raw: unknown, code: string): string {
  if (typeof raw !== 'string') throw new Error(`${code}: query must be a string`);
  const query = raw.trim();
  if (query.length < 1 || query.length > QUERY_MAX_CHARS) {
    throw new Error(`${code}: query must be 1-${QUERY_MAX_CHARS} characters`);
  }
  return query;
}

function normalizeBoundedCount(raw: unknown, fallback: number, code: string): number {
  const value = raw ?? fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw new Error(`${code}: count must be an integer between 1 and 50`);
  }
  return Math.min(value, SEARCH_PROVIDER_MAX_RESULTS);
}

export interface SerperSearchToolDependencies {
  serperSearch: typeof serperSearch;
  resolveApiKey?: typeof resolveSerperApiKey;
}

export function createSerperSearchTool(
  dependencies: SerperSearchToolDependencies = { serperSearch },
): Tool<SerperSearchToolInput, SearchProviderOutput> {
  const getKey = dependencies.resolveApiKey ?? resolveSerperApiKey;
  return {
    id: "serper.search",
    version: '1.0.0',
    category: 'search',
    sourceClass: 'public_intelligence',
    cost: { unit: 'request', estimatedCents: SERPER_REQUEST_COST_CENTS, external: true },
    rateLimit: { rps: 5, concurrency: 5 },
    compliance: {
      sourcePolicy: 'none',
      respectsRobots: false,
      personalData: false,
      allowedPurpose: ['discovery'],
      reversible: true,
      authRequired: true,
      risk: 'low',
    },
    capabilities: { produces: ['domain'], accepts: ['keywords'] },
    idempotencyKey: (input) => `serper.search:${stableKey(input)}`,
    durableResultStrategy: {
      kind: "typed_projection",
      schema: CATALOG_RESULT_PROJECTION_SCHEMAS["serper.search"],
    },
    durableReplayResult: (result) => ({
      data: {
        results: result.data.results.flatMap((item) => {
          const url = publicOrigin(item.url);
          return url ? [{ url }] : [];
        }),
      },
      costCents: result.costCents,
      ...(result.degraded === undefined ? {} : { degraded: result.degraded }),
    }),
    healthCheck: async () =>
      getKey()
        ? { healthy: true, detail: 'serper' }
        : { healthy: false, detail: 'SERPER_API_KEY not configured' },
    physicalWireObservation: 'before_each_wire',
    execute: async (input, ctx) => {
      if (!input || typeof input !== 'object') {
        throw new Error('SERPER_SEARCH_INPUT_INVALID: input must be an object');
      }
      const query = normalizeQueryString(input.query, 'SERPER_SEARCH_INPUT_INVALID');
      const num = normalizeBoundedCount(input.num, 10, 'SERPER_SEARCH_INPUT_INVALID');
      const apiKey = getKey();
      if (!apiKey) {
        return { data: { results: [] }, costCents: 0, degraded: true };
      }
      await assertToolExternalActionAuthorized(ctx);
      const response = await dependencies.serperSearch(
        { query, num, gl: input.gl, hl: input.hl },
        {
          apiKey,
          beforeRequest: async () => {
            await assertToolExternalActionAuthorized(ctx);
            await ctx.beforePhysicalWire?.();
          },
        },
      );
      return {
        data: { results: durableSearchHits(response.hits) },
        costCents: response.billed ? SERPER_REQUEST_COST_CENTS : 0,
      };
    },
  };
}

export const serperSearchTool = createSerperSearchTool();

export interface ExaSearchToolDependencies {
  exaSearch: typeof exaSearch;
  exaFindSimilar: typeof exaFindSimilar;
  resolveApiKey?: typeof resolveExaApiKey;
}

export function createExaSearchTool(
  dependencies: ExaSearchToolDependencies = { exaSearch, exaFindSimilar },
): Tool<ExaSearchToolInput, SearchProviderOutput> {
  const getKey = dependencies.resolveApiKey ?? resolveExaApiKey;
  return {
    id: "exa.search",
    version: '1.0.0',
    category: 'search',
    sourceClass: 'public_intelligence',
    cost: { unit: 'request', estimatedCents: EXA_REQUEST_COST_CENTS, external: true },
    rateLimit: { rps: 5, concurrency: 5 },
    compliance: {
      sourcePolicy: 'none',
      respectsRobots: false,
      personalData: false,
      allowedPurpose: ['discovery'],
      reversible: true,
      authRequired: true,
      risk: 'low',
    },
    capabilities: { produces: ['domain'], accepts: ['keywords', 'domain'] },
    idempotencyKey: (input) => `exa.search:${stableKey(input)}`,
    durableResultStrategy: {
      kind: "typed_projection",
      schema: CATALOG_RESULT_PROJECTION_SCHEMAS["exa.search"],
    },
    durableReplayResult: (result) => ({
      data: {
        results: result.data.results.flatMap((item) => {
          const url = publicOrigin(item.url);
          return url ? [{ url }] : [];
        }),
      },
      costCents: result.costCents,
      ...(result.degraded === undefined ? {} : { degraded: result.degraded }),
    }),
    healthCheck: async () =>
      getKey()
        ? { healthy: true, detail: 'exa' }
        : { healthy: false, detail: 'EXA_API_KEY not configured' },
    physicalWireObservation: 'before_each_wire',
    execute: async (input, ctx) => {
      if (!input || typeof input !== 'object') {
        throw new Error('EXA_SEARCH_INPUT_INVALID: input must be an object');
      }
      const mode = input.mode ?? 'search';
      if (mode !== 'search' && mode !== 'find_similar') {
        throw new Error('EXA_SEARCH_INPUT_INVALID: unsupported mode');
      }
      const numResults = normalizeBoundedCount(input.numResults, 10, 'EXA_SEARCH_INPUT_INVALID');
      const query =
        mode === 'search' ? normalizeQueryString(input.query, 'EXA_SEARCH_INPUT_INVALID') : undefined;
      const similarUrl =
        mode === 'find_similar' ? sanitizeSearchProviderUrl(input.similarUrl) : undefined;
      if (mode === 'find_similar' && !similarUrl) {
        throw new Error('EXA_SEARCH_INPUT_INVALID: valid similarUrl required for find_similar');
      }
      const apiKey = getKey();
      if (!apiKey) {
        return { data: { results: [] }, costCents: 0, degraded: true };
      }
      await assertToolExternalActionAuthorized(ctx);
      const beforeRequest = async () => {
        await assertToolExternalActionAuthorized(ctx);
        await ctx.beforePhysicalWire?.();
      };
      const response =
        mode === 'find_similar'
          ? await dependencies.exaFindSimilar(
              { url: similarUrl!, numResults, excludeDomains: input.excludeDomains },
              { apiKey, beforeRequest },
            )
          : await dependencies.exaSearch(
              {
                query: query!,
                numResults,
                excludeDomains: input.excludeDomains,
                includeDomains: input.includeDomains,
                category: input.category,
              },
              { apiKey, beforeRequest },
            );
      return {
        data: { results: durableSearchHits(response.hits) },
        costCents: response.billed ? EXA_REQUEST_COST_CENTS : 0,
      };
    },
  };
}

export const exaSearchTool = createExaSearchTool();

export interface GooglePlacesToolDependencies {
  googlePlacesSearchText: typeof googlePlacesSearchText;
  resolveApiKey?: typeof resolveGoogleMapsApiKey;
}

export function createGooglePlacesSearchTool(
  dependencies: GooglePlacesToolDependencies = { googlePlacesSearchText },
): Tool<GooglePlacesToolInput, GooglePlacesToolOutput> {
  const getKey = dependencies.resolveApiKey ?? resolveGoogleMapsApiKey;
  return {
    id: "google_places.search",
    version: '1.0.0',
    category: 'structured_source',
    sourceClass: 'industry_data',
    cost: { unit: 'request', estimatedCents: GOOGLE_PLACES_REQUEST_COST_CENTS, external: true },
    rateLimit: { rps: 5, concurrency: 5 },
    compliance: {
      sourcePolicy: 'none',
      respectsRobots: false,
      personalData: false,
      allowedPurpose: ['discovery'],
      reversible: true,
      authRequired: true,
      risk: 'low',
    },
    capabilities: { produces: ['company', 'domain'], accepts: ['keywords'] },
    idempotencyKey: (input) => `google_places.search:${stableKey(input)}`,
    durableResultStrategy: {
      kind: "typed_projection",
      schema: CATALOG_RESULT_PROJECTION_SCHEMAS["google_places.search"],
    },
    // D4 §3.2.3：Google Places 持久回放只保留 placeId（不跨缓存固化名称/网址/地址）。
    durableReplayResult: (result) => ({
      data: {
        places: result.data.places.map((item) => ({ placeId: item.placeId })),
      },
      costCents: result.costCents,
      ...(result.degraded === undefined ? {} : { degraded: result.degraded }),
    }),
    healthCheck: async () =>
      getKey()
        ? { healthy: true, detail: 'google-places' }
        : { healthy: false, detail: 'GOOGLE_MAPS_API_KEY not configured' },
    physicalWireObservation: 'before_each_wire',
    execute: async (input, ctx) => {
      if (!input || typeof input !== 'object') {
        throw new Error('GOOGLE_PLACES_INPUT_INVALID: input must be an object');
      }
      const textQuery = normalizeQueryString(input.textQuery, 'GOOGLE_PLACES_INPUT_INVALID');
      const maxResultCount = normalizeBoundedCount(
        input.maxResultCount,
        10,
        'GOOGLE_PLACES_INPUT_INVALID',
      );
      const apiKey = getKey();
      if (!apiKey) {
        return { data: { places: [] }, costCents: 0, degraded: true };
      }
      await assertToolExternalActionAuthorized(ctx);
      const response = await dependencies.googlePlacesSearchText(
        {
          textQuery,
          maxResultCount,
          regionCode: input.regionCode,
          languageCode: input.languageCode,
        },
        {
          apiKey,
          beforeRequest: async () => {
            await assertToolExternalActionAuthorized(ctx);
            await ctx.beforePhysicalWire?.();
          },
        },
      );
      return {
        data: { places: durablePlaceHits(response.places) },
        costCents: response.billed ? GOOGLE_PLACES_REQUEST_COST_CENTS : 0,
      };
    },
  };
}

export const googlePlacesSearchTool = createGooglePlacesSearchTool();

export interface BraveSearchToolDependencies {
  braveSearch: typeof braveSearch;
  resolveApiKey?: typeof resolveBraveSearchApiKey;
}

export function createBraveSearchTool(
  dependencies: BraveSearchToolDependencies = { braveSearch },
): Tool<BraveSearchToolInput, SearchProviderOutput> {
  const getKey = dependencies.resolveApiKey ?? resolveBraveSearchApiKey;
  return {
    id: "brave.search",
    version: '1.0.0',
    category: 'search',
    sourceClass: 'public_intelligence',
    cost: { unit: 'request', estimatedCents: BRAVE_REQUEST_COST_CENTS, external: true },
    rateLimit: { rps: 5, concurrency: 5 },
    compliance: {
      sourcePolicy: 'none',
      respectsRobots: false,
      personalData: false,
      allowedPurpose: ['discovery'],
      reversible: true,
      authRequired: true,
      risk: 'low',
    },
    capabilities: { produces: ['domain'], accepts: ['keywords'] },
    idempotencyKey: (input) => `brave.search:${stableKey(input)}`,
    durableResultStrategy: {
      kind: "typed_projection",
      schema: CATALOG_RESULT_PROJECTION_SCHEMAS["brave.search"],
    },
    durableReplayResult: (result) => ({
      data: {
        results: result.data.results.flatMap((item) => {
          const url = publicOrigin(item.url);
          return url ? [{ url }] : [];
        }),
      },
      costCents: result.costCents,
      ...(result.degraded === undefined ? {} : { degraded: result.degraded }),
    }),
    healthCheck: async () =>
      getKey()
        ? { healthy: true, detail: 'brave' }
        : { healthy: false, detail: 'BRAVE_SEARCH_API_KEY not configured' },
    physicalWireObservation: 'before_each_wire',
    execute: async (input, ctx) => {
      if (!input || typeof input !== 'object') {
        throw new Error('BRAVE_SEARCH_INPUT_INVALID: input must be an object');
      }
      const query = normalizeQueryString(input.query, 'BRAVE_SEARCH_INPUT_INVALID');
      const count = normalizeBoundedCount(input.count, 10, 'BRAVE_SEARCH_INPUT_INVALID');
      const apiKey = getKey();
      if (!apiKey) {
        return { data: { results: [] }, costCents: 0, degraded: true };
      }
      await assertToolExternalActionAuthorized(ctx);
      const response = await dependencies.braveSearch(
        { query, count, country: input.country, searchLang: input.searchLang },
        {
          apiKey,
          beforeRequest: async () => {
            await assertToolExternalActionAuthorized(ctx);
            await ctx.beforePhysicalWire?.();
          },
        },
      );
      return {
        data: { results: durableSearchHits(response.hits) },
        costCents: response.billed ? BRAVE_REQUEST_COST_CENTS : 0,
      };
    },
  };
}

export const braveSearchTool = createBraveSearchTool();

function durablePersonSearchHits(hits: readonly SearchProviderHit[]): SearchProviderResultItem[] {
  return hits
    .flatMap((hit): SearchProviderResultItem[] => {
      const url = sanitizeSearchProviderUrl(hit.url);
      if (
        !url ||
        url.length > URL_MAX_CHARS ||
        !isDurableText(url) ||
        !isPersonProfileUrl(url)
      ) {
        return [];
      }
      const title =
        typeof hit.title === 'string' ? durableTitle(hit.title, TITLE_MAX_CHARS) : null;
      return [title === null ? { url } : { url, title }];
    })
    .slice(0, SEARCH_PROVIDER_MAX_RESULTS);
}

function replayPersonSearchResult(result: {
  data: SearchProviderOutput;
  costCents: number;
  degraded?: boolean;
}) {
  return {
    data: {
      results: result.data.results.map((item) =>
        typeof item.title === 'string' && item.title.length > 0
          ? { url: item.url, title: item.title }
          : { url: item.url },
      ),
    },
    costCents: result.costCents,
    ...(result.degraded === undefined ? {} : { degraded: result.degraded }),
  };
}

export function createSocialSerperSearchTool(
  dependencies: SerperSearchToolDependencies = { serperSearch },
): Tool<SocialSerperSearchToolInput, SearchProviderOutput> {
  const getKey = dependencies.resolveApiKey ?? resolveSerperApiKey;
  return {
    id: "social.search_serper",
    version: '1.0.0',
    category: 'search',
    sourceClass: 'public_intelligence',
    cost: { unit: 'request', estimatedCents: SERPER_REQUEST_COST_CENTS, external: true },
    rateLimit: { rps: 5, concurrency: 5 },
    compliance: {
      sourcePolicy: 'none',
      respectsRobots: false,
      personalData: true,
      allowedPurpose: ['discovery', 'enrichment'],
      reversible: true,
      authRequired: true,
      risk: 'medium',
    },
    capabilities: { produces: ['contact'], accepts: ['keywords'] },
    idempotencyKey: (input) => `social.search_serper:${stableKey(input)}`,
    durableResultStrategy: {
      kind: "typed_projection",
      schema: CATALOG_RESULT_PROJECTION_SCHEMAS["social.search_serper"],
    },
    durableReplayResult: replayPersonSearchResult,
    healthCheck: async () =>
      getKey()
        ? { healthy: true, detail: 'serper-people' }
        : { healthy: false, detail: 'SERPER_API_KEY not configured' },
    physicalWireObservation: 'before_each_wire',
    execute: async (input, ctx) => {
      if (!input || typeof input !== 'object') {
        throw new Error('SOCIAL_SERPER_INPUT_INVALID: input must be an object');
      }
      const query = normalizeQueryString(input.query, 'SOCIAL_SERPER_INPUT_INVALID');
      const num = normalizeBoundedCount(input.num, 10, 'SOCIAL_SERPER_INPUT_INVALID');
      const apiKey = getKey();
      if (!apiKey) {
        return { data: { results: [] }, costCents: 0, degraded: true };
      }
      await assertToolExternalActionAuthorized(ctx);
      const response = await dependencies.serperSearch(
        { query, num, gl: input.gl, hl: input.hl },
        {
          apiKey,
          beforeRequest: async () => {
            await assertToolExternalActionAuthorized(ctx);
            await ctx.beforePhysicalWire?.();
          },
        },
      );
      return {
        data: { results: durablePersonSearchHits(response.hits) },
        costCents: response.billed ? SERPER_REQUEST_COST_CENTS : 0,
      };
    },
  };
}

export const socialSerperSearchTool = createSocialSerperSearchTool();

export interface SocialExaPeopleToolDependencies {
  exaSearch: typeof exaSearch;
  resolveApiKey?: typeof resolveExaApiKey;
}

export function createSocialExaPeopleTool(
  dependencies: SocialExaPeopleToolDependencies = { exaSearch },
): Tool<SocialExaPeopleToolInput, SearchProviderOutput> {
  const getKey = dependencies.resolveApiKey ?? resolveExaApiKey;
  return {
    id: "social.search_exa_people",
    version: '1.0.0',
    category: 'search',
    sourceClass: 'public_intelligence',
    cost: { unit: 'request', estimatedCents: EXA_REQUEST_COST_CENTS, external: true },
    rateLimit: { rps: 5, concurrency: 5 },
    compliance: {
      sourcePolicy: 'none',
      respectsRobots: false,
      personalData: true,
      allowedPurpose: ['discovery', 'enrichment'],
      reversible: true,
      authRequired: true,
      risk: 'medium',
    },
    capabilities: { produces: ['contact'], accepts: ['keywords'] },
    idempotencyKey: (input) => `social.search_exa_people:${stableKey(input)}`,
    durableResultStrategy: {
      kind: "typed_projection",
      schema: CATALOG_RESULT_PROJECTION_SCHEMAS["social.search_exa_people"],
    },
    durableReplayResult: replayPersonSearchResult,
    healthCheck: async () =>
      getKey()
        ? { healthy: true, detail: 'exa-people' }
        : { healthy: false, detail: 'EXA_API_KEY not configured' },
    physicalWireObservation: 'before_each_wire',
    execute: async (input, ctx) => {
      if (!input || typeof input !== 'object') {
        throw new Error('SOCIAL_EXA_PEOPLE_INPUT_INVALID: input must be an object');
      }
      const query = normalizeQueryString(input.query, 'SOCIAL_EXA_PEOPLE_INPUT_INVALID');
      const numResults = normalizeBoundedCount(input.numResults, 10, 'SOCIAL_EXA_PEOPLE_INPUT_INVALID');
      const apiKey = getKey();
      if (!apiKey) {
        return { data: { results: [] }, costCents: 0, degraded: true };
      }
      await assertToolExternalActionAuthorized(ctx);
      const response = await dependencies.exaSearch(
        { query, numResults, includeDomains: input.includeDomains, category: 'people' },
        {
          apiKey,
          beforeRequest: async () => {
            await assertToolExternalActionAuthorized(ctx);
            await ctx.beforePhysicalWire?.();
          },
        },
      );
      return {
        data: { results: durablePersonSearchHits(response.hits) },
        costCents: response.billed ? EXA_REQUEST_COST_CENTS : 0,
      };
    },
  };
}

export const socialExaPeopleTool = createSocialExaPeopleTool();

/** 注册 L0 实时付费搜索/地点工具及受治理个人搜人工具（由 registerBuiltinTools 调用）。 */
export function registerSearchProviderTools(registry: ToolRegistry): ToolRegistry {
  registry.register(serperSearchTool as Tool);
  registry.register(braveSearchTool as Tool);
  registry.register(exaSearchTool as Tool);
  registry.register(googlePlacesSearchTool as Tool);
  registry.register(socialSerperSearchTool as Tool);
  registry.register(socialExaPeopleTool as Tool);
  return registry;
}
