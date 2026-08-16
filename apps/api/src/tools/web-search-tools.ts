import { createHash } from 'node:crypto';
import {
  requestPublicHttp,
  type PublicHttpDependencies,
  type PublicHttpRequestOptions,
  type PublicHttpResponse,
} from '../adapters/guarded-http';
import type { Tool, ToolContext, ToolResult } from './tool-contract';

export type GovernedSearchBackend = 'serper' | 'brave';

export interface GovernedWebSearchInput {
  q: string;
  count?: number;
  country?: string;
  language?: string;
}

export interface GovernedWebSearchResult {
  title: string;
  url: string;
  content: string;
  engine: GovernedSearchBackend;
}

export interface GovernedWebSearchOutput {
  results: GovernedWebSearchResult[];
}

type PublicHttpRequester = (
  url: string,
  options?: PublicHttpRequestOptions,
  dependencies?: PublicHttpDependencies,
) => Promise<PublicHttpResponse>;

interface SearchToolDependencies {
  readCredential: () => string | undefined;
  request: PublicHttpRequester;
}

// Brave's current official contract caps q at 400 characters; use the stricter
// shared bound so fallback never changes whether the same query is admissible.
const MAX_QUERY_CHARS = 400;
const MAX_RESULTS = 20;
const MAX_RESPONSE_BYTES = 512_000;
const SEARCH_TIMEOUT_MS = 12_000;

export class SearchBackendUnavailableError extends Error {
  constructor(readonly backend: GovernedSearchBackend, reason: string) {
    super(`${backend} search backend unavailable: ${reason}`);
    this.name = 'SearchBackendUnavailableError';
  }
}

class InvalidSearchResponseError extends Error {
  constructor(backend: GovernedSearchBackend) {
    super(`${backend} search response payload is invalid`);
    this.name = 'InvalidSearchResponseError';
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function normalizedInput(input: GovernedWebSearchInput) {
  const q = input.q.trim();
  if (q.length === 0 || q.length > MAX_QUERY_CHARS || q.split(/\s+/u).length > 50) {
    throw new TypeError(`search query must contain 1..${MAX_QUERY_CHARS} characters and at most 50 words`);
  }
  const requestedCount = input.count ?? 10;
  if (!Number.isFinite(requestedCount)) throw new TypeError('search result count is invalid');
  const count = Math.max(1, Math.min(MAX_RESULTS, Math.trunc(requestedCount)));
  const country = normalizeLocalePart(input.country, 2, 'country');
  const language = normalizeLocalePart(input.language, 10, 'language');
  return { q, count, country, language };
}

function normalizeLocalePart(value: string | undefined, max: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z]{2}(?:-[a-z]{2})?$/.test(normalized) || normalized.length > max) {
    throw new TypeError(`search ${label} is invalid`);
  }
  return normalized;
}

function requiredCredential(
  backend: GovernedSearchBackend,
  reader: () => string | undefined,
): string {
  const value = reader()?.trim();
  if (!value) throw new SearchBackendUnavailableError(backend, 'credential_missing');
  return value;
}

function wireDependencies(ctx: ToolContext): PublicHttpDependencies {
  return {
    authorizeExternalAction: ctx.authorizeExternalAction,
    onRequestStarted: ctx.markExternalRequestStarted,
    beforeRequest: async () => {
      await ctx.reauthorizeProviderStatus?.();
      await ctx.reauthorizeSourcePolicy?.();
    },
  };
}

function parseJson(response: PublicHttpResponse, backend: GovernedSearchBackend): unknown {
  if (!response.ok) throw new SearchBackendUnavailableError(backend, `upstream_http_${response.status}`);
  try {
    return JSON.parse(response.text) as unknown;
  } catch {
    throw new InvalidSearchResponseError(backend);
  }
}

function boundedText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function publicHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function publicOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}/`;
  } catch {
    return null;
  }
}

function durableReplay(result: ToolResult<GovernedWebSearchOutput>): ToolResult<GovernedWebSearchOutput> {
  return {
    data: {
      results: result.data.results.flatMap((item) => {
        const url = publicOrigin(item.url);
        return url ? [{ url } as GovernedWebSearchResult] : [];
      }),
    },
    costCents: result.costCents,
    ...(result.degraded === undefined ? {} : { degraded: result.degraded }),
  };
}

const sharedTool = {
  version: '1.0.0',
  category: 'search' as const,
  sourceClass: 'public_intelligence' as const,
  cost: { unit: 'request' as const, estimatedCents: 1, external: true },
  rateLimit: { rps: 1, concurrency: 2 },
  capabilities: {
    produces: ['domain'] as ('domain')[],
    accepts: ['keywords'] as ('keywords')[],
  },
  durableReplayResult: durableReplay,
};

export function createSerperSearchTool(
  dependencies: Partial<SearchToolDependencies> = {},
): Tool<GovernedWebSearchInput, GovernedWebSearchOutput> {
  const readCredential = dependencies.readCredential ?? (() => process.env.SERPER_API_KEY);
  const request = dependencies.request ?? requestPublicHttp;
  return {
    ...sharedTool,
    id: 'serper.search',
    compliance: {
      sourcePolicy: 'required',
      policyDomain: 'google.serper.dev',
      providerKey: 'public_web',
      requiresExplicitPurpose: true,
      respectsRobots: false,
      personalData: false,
      allowedPurpose: ['discovery'],
      reversible: true,
      authRequired: true,
      risk: 'medium',
    },
    idempotencyKey: (input) => `serper.search:${hash(normalizedInput(input))}`,
    healthCheck: async () => ({
      healthy: Boolean(readCredential()?.trim()),
      detail: readCredential()?.trim() ? 'credential_configured_unprobed' : 'credential_missing',
    }),
    execute: async (input, ctx) => {
      const normalized = normalizedInput(input);
      const credential = requiredCredential('serper', readCredential);
      const payload = {
        q: normalized.q,
        num: normalized.count,
        ...(normalized.country ? { gl: normalized.country } : {}),
        ...(normalized.language ? { hl: normalized.language } : {}),
      };
      const response = await request(
        'https://google.serper.dev/search',
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-API-KEY': credential,
          },
          body: JSON.stringify(payload),
          timeoutMs: SEARCH_TIMEOUT_MS,
          maxBytes: MAX_RESPONSE_BYTES,
          maxRedirects: 0,
          redirect: 'manual',
        },
        wireDependencies(ctx),
      );
      const raw = parseJson(response, 'serper') as { organic?: unknown };
      if (!Array.isArray(raw.organic)) throw new InvalidSearchResponseError('serper');
      const results = raw.organic.slice(0, normalized.count).flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const candidate = item as Record<string, unknown>;
        const url = publicHttpUrl(candidate.link);
        if (!url) return [];
        return [{
          title: boundedText(candidate.title, 300),
          url,
          content: boundedText(candidate.snippet, 1_000),
          engine: 'serper' as const,
        }];
      });
      return { data: { results }, costCents: 1 };
    },
  };
}

export function createBraveSearchTool(
  dependencies: Partial<SearchToolDependencies> = {},
): Tool<GovernedWebSearchInput, GovernedWebSearchOutput> {
  const readCredential = dependencies.readCredential ?? (() => process.env.BRAVE_SEARCH_API_KEY);
  const request = dependencies.request ?? requestPublicHttp;
  return {
    ...sharedTool,
    id: 'brave.search',
    compliance: {
      sourcePolicy: 'required',
      policyDomain: 'api.search.brave.com',
      providerKey: 'public_web',
      requiresExplicitPurpose: true,
      respectsRobots: false,
      personalData: false,
      allowedPurpose: ['discovery'],
      reversible: true,
      authRequired: true,
      risk: 'medium',
    },
    idempotencyKey: (input) => `brave.search:${hash(normalizedInput(input))}`,
    healthCheck: async () => ({
      healthy: Boolean(readCredential()?.trim()),
      detail: readCredential()?.trim() ? 'credential_configured_unprobed' : 'credential_missing',
    }),
    execute: async (input, ctx) => {
      const normalized = normalizedInput(input);
      const credential = requiredCredential('brave', readCredential);
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', normalized.q);
      url.searchParams.set('count', String(normalized.count));
      if (normalized.country) url.searchParams.set('country', normalized.country);
      if (normalized.language) url.searchParams.set('search_lang', normalized.language);
      const response = await request(
        url.toString(),
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'X-Subscription-Token': credential,
          },
          timeoutMs: SEARCH_TIMEOUT_MS,
          maxBytes: MAX_RESPONSE_BYTES,
          maxRedirects: 0,
          redirect: 'manual',
        },
        wireDependencies(ctx),
      );
      const raw = parseJson(response, 'brave') as { web?: { results?: unknown } };
      if (!raw.web || !Array.isArray(raw.web.results)) throw new InvalidSearchResponseError('brave');
      const results = raw.web.results.slice(0, normalized.count).flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const candidate = item as Record<string, unknown>;
        const resultUrl = publicHttpUrl(candidate.url);
        if (!resultUrl) return [];
        return [{
          title: boundedText(candidate.title, 300),
          url: resultUrl,
          content: boundedText(candidate.description, 1_000),
          engine: 'brave' as const,
        }];
      });
      return { data: { results }, costCents: 1 };
    },
  };
}

export const serperSearchTool = createSerperSearchTool();
export const braveSearchTool = createBraveSearchTool();
