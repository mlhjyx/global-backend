import { gunzipSync } from 'node:zlib';
import { decodeHttpTextWithCharset } from '../adapters/bounded-fetch-response';
import { searchCompaniesNative } from '../adapters/companies-house';
import { requestPublicHttp, type PublicHttpResponse } from '../adapters/guarded-http';
import { searchOpenCorporatesCompaniesNative } from '../adapters/opencorporates-api';
import { searchAwardNoticesNative } from '../adapters/ted-api';
import { queryAlgoliaExhibitorPage } from '../adapters/trade-fair-algolia-native';
import type { AlgoliaFairConfig, FairExhibitor } from '../adapters/trade-fair-algolia';
import { TRADE_FAIRS } from '../adapters/trade-fair-catalog';
import { assertToolExternalActionAuthorized, type ToolContext, type ToolResult } from './tool-contract';
import type {
  CompaniesHouseInput, CompaniesHouseOutput, HttpGetInput, HttpGetOutput,
  OpenCorporatesSearchInput, OpenCorporatesSearchOutput, TedSearchInput, TedSearchOutput,
} from './source-tools';

type NativeContext = ToolContext & Required<Pick<ToolContext, 'dispatchDiscoveryV3Wire'>>;

export const HTTP_GET_UA = 'Mozilla/5.0 (compatible; GlobalBot/1.0)';
export const MAX_HTTP_GET_ARTIFACT_BYTES = 3_000_000;
const HTTP_GET_NATIVE_HEADERS = new Set(['accept', 'accept-language', 'user-agent']);

export async function executeHttpGetNative(input: HttpGetInput, ctx: NativeContext): Promise<ToolResult<HttpGetOutput>> {
  const method = input.method ?? 'GET';
  const timeoutMs = input.timeoutMs ?? 15_000;
  if ((method !== 'GET' && method !== 'HEAD') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('HTTP_GET_NATIVE_REQUEST_INVALID');
  }
  const unsafeHeaders = Object.entries(input.headers ?? {}).some(([name, value]) =>
    !HTTP_GET_NATIVE_HEADERS.has(name.toLowerCase()) || typeof value !== 'string' || value.length > 500 || /[\r\n]/u.test(value),
  );
  if (unsafeHeaders) throw new Error('HTTP_GET_NATIVE_HEADERS_INVALID');
  const res = await requestPublicHttp(input.url, {
    method,
    timeoutMs,
    headers: { 'User-Agent': HTTP_GET_UA, ...input.headers },
    maxBytes: MAX_HTTP_GET_ARTIFACT_BYTES,
    maxRedirects: 0,
  }, {
    authorizeExternalAction: ctx.authorizeExternalAction,
    dispatchPhysicalWire: ctx.dispatchDiscoveryV3Wire,
  });
  return httpGetResult(res, method);
}

function decodeHttpGetArtifactText(body: Buffer, contentType?: string): string {
  let text: string;
  try {
    text = decodeHttpTextWithCharset(body, contentType, { strictWithoutDeclaredCharset: true });
  } catch {
    throw new Error('HTTP_GET_ARTIFACT_UTF8_INVALID');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_HTTP_GET_ARTIFACT_BYTES) throw new Error('HTTP_GET_ARTIFACT_TOO_LARGE');
  return text;
}

export function httpGetResult(res: PublicHttpResponse, method?: 'GET' | 'HEAD'): ToolResult<HttpGetOutput> {
  // Some sitemaps contain gzip bytes without a Content-Encoding header.
  let body = res.body;
  if (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b) {
    try {
      body = gunzipSync(body, { maxOutputLength: MAX_HTTP_GET_ARTIFACT_BYTES });
    } catch {
      throw new Error('HTTP_GET_ARTIFACT_GZIP_INVALID_OR_TOO_LARGE');
    }
  }
  return {
    data: {
      status: res.status,
      ok: res.ok,
      mediaType: 'text/plain',
      text: method === 'HEAD' ? '' : decodeHttpGetArtifactText(body, res.headers['content-type']),
      finalUrl: res.finalUrl,
    },
    costCents: 0,
  };
}

export async function executeTedNative(input: TedSearchInput, ctx: NativeContext): Promise<ToolResult<TedSearchOutput>> {
  if (input.kind !== 'award') throw new Error('TED_NATIVE_AWARD_REQUIRED');
  await assertToolExternalActionAuthorized(ctx);
  return {
    data: { awards: await searchAwardNoticesNative(input.params, ctx.dispatchDiscoveryV3Wire) },
    costCents: 0,
  };
}

export async function executeCompaniesHouseNative(input: CompaniesHouseInput, ctx: NativeContext): Promise<ToolResult<CompaniesHouseOutput>> {
  if (input.op !== 'search') throw new Error('CH_NATIVE_COMPANY_SEARCH_REQUIRED');
  await assertToolExternalActionAuthorized(ctx);
  return {
    data: { companies: await searchCompaniesNative(input.query, input.limit, ctx.dispatchDiscoveryV3Wire) },
    costCents: 0,
  };
}

interface TradeFairAlgoliaLegacyInput {
  cfg: AlgoliaFairConfig;
  limit?: number;
}

export interface TradeFairAlgoliaPageInput {
  fairSlug: string;
  page: number;
  limit?: number;
}

export type TradeFairAlgoliaInput = TradeFairAlgoliaLegacyInput | TradeFairAlgoliaPageInput;

export interface TradeFairAlgoliaOutput {
  exhibitors: FairExhibitor[];
  pagination?: { fairSlug: string; page: number; hasNextPage: boolean };
}

export function isTradeFairAlgoliaPage(input: TradeFairAlgoliaInput): input is TradeFairAlgoliaPageInput {
  return 'fairSlug' in input && !('cfg' in input);
}

export async function executeAlgoliaNative(input: TradeFairAlgoliaInput, ctx: NativeContext): Promise<ToolResult<TradeFairAlgoliaOutput>> {
  if (!isTradeFairAlgoliaPage(input)) throw new Error('ALGOLIA_NATIVE_PAGE_REQUIRED');
  const fair = TRADE_FAIRS.find((entry) => entry.slug === input.fairSlug);
  if (!fair) throw new Error('ALGOLIA_NATIVE_FAIR_UNREGISTERED');
  await assertToolExternalActionAuthorized(ctx);
  const { exhibitors, hasNextPage } = await queryAlgoliaExhibitorPage(fair.algolia, input.page, input.limit, ctx.dispatchDiscoveryV3Wire);
  return {
    data: { exhibitors, pagination: { fairSlug: fair.slug, page: input.page, hasNextPage } },
    costCents: 0,
  };
}

export async function executeOpenCorporatesNative(input: OpenCorporatesSearchInput, ctx: NativeContext): Promise<ToolResult<OpenCorporatesSearchOutput>> {
  const apiToken = process.env.OPENCORPORATES_API_TOKEN?.trim();
  if (!apiToken) return { data: { companies: [] }, costCents: 0, degraded: true };
  await assertToolExternalActionAuthorized(ctx);
  return {
    data: { companies: await searchOpenCorporatesCompaniesNative(input, apiToken, ctx.dispatchDiscoveryV3Wire) },
    costCents: 0,
  };
}
