/** Bounded clients for official organization identity registries. */

import { createHash } from 'node:crypto';
import { gunzipSync, inflateSync } from 'node:zlib';
import {
  isValidNpiIdentifier,
  isValidSirenIdentifier,
  normalizeCikIdentifier,
  normalizeRorIdentifier,
} from '../discovery/organization-identity-v2';
import {
  EgressBlockedError,
  requestPublicHttp,
  type PublicHttpResponse,
} from './guarded-http';

export interface OfficialRegistryProvenance {
  sourceUrl: string;
  fetchedAt: string;
  contentHash: string;
  parserVersion: string;
}

export interface OfficialRegistrySearchResult<T> {
  records: T[];
  nextCursor?: string;
  total?: number;
  provenance: OfficialRegistryProvenance;
}

export interface RorOrganization {
  rorId: string;
  name: string;
  country?: string;
  reportedDomains: string[];
  types: string[];
}

export const ROR_ORGANIZATION_TYPES = ['archive', 'company', 'education', 'facility', 'funder', 'government', 'healthcare', 'nonprofit', 'other'] as const;

export interface SecOrganization {
  cik: string;
  name: string;
  ticker?: string;
  exchange?: string;
  entityType?: 'operating';
}

export interface FrenchOrganization {
  siren: string;
  name: string;
  activityCode?: string;
  city?: string;
  postalCode?: string;
}

export interface NppesOrganization {
  npi: string;
  name: string;
  status?: string;
  city?: string;
  state?: string;
  taxonomyDescriptions: string[];
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function fail(source: string): never {
  throw new Error(`${source.toUpperCase()}_SCHEMA_CHANGED`);
}

export function normalizeRorId(value: string): string | null {
  return normalizeRorIdentifier(value);
}

export function normalizeCik(value: string): string | null {
  return normalizeCikIdentifier(value);
}

export function validNpi(value: string): boolean {
  return isValidNpiIdentifier(value);
}

export function parseRorResponse(value: unknown): RorOrganization[] {
  const root = object(value);
  if (!root || !Array.isArray(root.items)) fail('ror');
  const allowedTypes = new Set<string>(ROR_ORGANIZATION_TYPES);
  return root.items.map((raw) => {
    const item = object(raw);
    const rorId = item && text(item.id) ? normalizeRorId(text(item.id)!) : null;
    const names = array(item?.names).map(object).filter(Boolean) as Record<string, unknown>[];
    const displayNames = names.filter((entry) => array(entry.types).includes('ror_display'));
    const name = displayNames[0];
    const displayName = text(name?.value);
    const status = text(item?.status);
    const types = array(item?.types).flatMap((entry) => text(entry) ? [text(entry)!.toLowerCase()] : []);
    if (
      !item || !rorId || displayNames.length !== 1 || !displayName || displayName.length > 300 || status !== 'active' ||
      types.length === 0 || types.length > 16 || types.some((type) => !allowedTypes.has(type))
    ) fail('ror');
    const countries = [...new Set(array(item.locations).flatMap((entry) => {
      const code = text(object(object(entry)?.geonames_details)?.country_code)?.toUpperCase();
      if (code && !/^[A-Z]{2}$/u.test(code)) fail('ror');
      return code ? [code] : [];
    }))];
    const country = countries.length === 1 ? countries[0] : undefined;
    const reportedDomains = [...new Set(array(item.domains).flatMap((entry) => {
      const domain = text(entry)?.toLowerCase().replace(/^www\./u, '').replace(/\.$/u, '');
      return domain && domain.length <= 253 && /^[a-z0-9.-]+$/u.test(domain) && domain.includes('.')
        && !domain.includes('..') && domain !== 'localhost' && !/^\d+(?:\.\d+){3}$/u.test(domain)
        ? [domain]
        : [];
    }))].slice(0, 10);
    return {
      rorId,
      name: displayName,
      country,
      reportedDomains,
      types,
    };
  });
}

export function parseSecCompanyDirectory(value: unknown): SecOrganization[] {
  const root = object(value);
  if (
    !root ||
    JSON.stringify(root.fields) !== JSON.stringify(['cik', 'name', 'ticker', 'exchange']) ||
    !Array.isArray(root.data) ||
    root.data.length > 25_000
  ) fail('sec_edgar');
  return root.data.map((raw) => {
    if (!Array.isArray(raw) || raw.length !== 4) fail('sec_edgar');
    const cik = normalizeCik(String(raw[0] ?? ''));
    const name = text(raw[1]);
    const ticker = text(raw[2])?.toUpperCase();
    const exchange = text(raw[3]);
    if (
      !cik || !name || name.length > 300 || !ticker || ticker.length > 16 ||
      !/^[A-Z0-9.-]+$/u.test(ticker) || (exchange !== undefined && exchange.length > 80)
    ) fail('sec_edgar');
    return { cik, name, ticker, exchange };
  });
}

export function parseSecSubmission(value: unknown, requestedCik: string): SecOrganization {
  const item = object(value);
  const cik = normalizeCik(String(item?.cik ?? ''));
  const name = text(item?.name);
  const entityType = text(item?.entityType);
  if (
    !item || !cik || cik !== requestedCik || !name || name.length > 300 ||
    entityType !== 'operating'
  ) fail('sec_edgar');
  return {
    cik,
    name,
    entityType,
  };
}

export function parseFrenchResponse(value: unknown): FrenchOrganization[] {
  const root = object(value);
  if (!root || !Array.isArray(root.results)) fail('fr_company');
  return root.results.flatMap((raw) => {
    const item = object(raw);
    const siren = text(item?.siren);
    // nom_raison_sociale is intentionally required: sole-trader personal-name
    // records are not admitted into the organization pool.
    const name = text(item?.nom_raison_sociale);
    const head = object(item?.siege);
    if (!item || !name) return [];
    if (!siren || !isValidSirenIdentifier(siren)) fail('fr_company');
    return [{
      siren,
      name,
      activityCode: text(head?.activite_principale),
      city: text(head?.libelle_commune) ?? text(head?.commune),
      postalCode: text(head?.code_postal),
    }];
  });
}

export function parseNppesResponse(value: unknown): NppesOrganization[] {
  const root = object(value);
  if (!root || !Array.isArray(root.results)) fail('nppes');
  return root.results.flatMap((raw) => {
    const item = object(raw);
    // Hard boundary: NPI-1 individuals never enter company discovery even if
    // an upstream response ignores our enumeration_type=NPI-2 query filter.
    if (!item || item.enumeration_type !== 'NPI-2') return [];
    const npi = String(item.number ?? '');
    const basic = object(item.basic);
    const name = text(basic?.organization_name);
    if (!validNpi(npi) || !name) fail('nppes');
    const primary = object(array(item.addresses).find((entry) => object(entry)?.address_purpose === 'LOCATION'));
    return [{
      npi,
      name,
      status: text(basic?.status),
      city: text(primary?.city),
      state: text(primary?.state),
      taxonomyDescriptions: array(item.taxonomies).flatMap((entry) => {
        const description = text(object(entry)?.desc);
        return description ? [description] : [];
      }),
    }];
  });
}

const MAX_OFFICIAL_REGISTRY_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface OfficialRegistryHttpDependencies {
  request?: typeof requestPublicHttp;
  env?: NodeJS.ProcessEnv;
}

function boundedResponseBody(
  response: PublicHttpResponse,
  source: string,
): { body: string; contentHash: string } {
  const declaredLength = response.headers['content-length'];
  if (declaredLength && Number(declaredLength) > MAX_OFFICIAL_REGISTRY_RESPONSE_BYTES) {
    throw new Error(`${source.toUpperCase()}_RESPONSE_TOO_LARGE`);
  }
  if (response.body.byteLength > MAX_OFFICIAL_REGISTRY_RESPONSE_BYTES) {
    throw new Error(`${source.toUpperCase()}_RESPONSE_TOO_LARGE`);
  }
  const contentEncoding = response.headers['content-encoding']?.trim().toLowerCase();
  let decodedBytes = response.body;
  try {
    if (contentEncoding === 'gzip' || contentEncoding === 'x-gzip') {
      decodedBytes = gunzipSync(response.body, { maxOutputLength: MAX_OFFICIAL_REGISTRY_RESPONSE_BYTES });
    } else if (contentEncoding === 'deflate') {
      decodedBytes = inflateSync(response.body, { maxOutputLength: MAX_OFFICIAL_REGISTRY_RESPONSE_BYTES });
    } else if (contentEncoding && contentEncoding !== 'identity') {
      throw new Error(`${source.toUpperCase()}_CONTENT_ENCODING_INVALID`);
    }
  } catch (error) {
    if (error instanceof Error && error.message === `${source.toUpperCase()}_CONTENT_ENCODING_INVALID`) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(`${source.toUpperCase()}_RESPONSE_TOO_LARGE`, { cause: error });
    }
    throw new Error(`${source.toUpperCase()}_RESPONSE_DECOMPRESSION_INVALID`, { cause: error });
  }
  if (decodedBytes.byteLength > MAX_OFFICIAL_REGISTRY_RESPONSE_BYTES) {
    throw new Error(`${source.toUpperCase()}_RESPONSE_TOO_LARGE`);
  }
  try {
    const body = new TextDecoder('utf-8', { fatal: true }).decode(decodedBytes);
    return {
      body,
      contentHash: createHash('sha256').update(decodedBytes).digest('hex'),
    };
  } catch {
    throw new Error(`${source.toUpperCase()}_INVALID_UTF8`);
  }
}

async function jsonRequest(
  source: string,
  url: string,
  options: {
    headers?: Record<string, string>;
    beforeRequest?: () => Promise<void>;
    parserVersion: string;
    request?: typeof requestPublicHttp;
  },
): Promise<{ value: unknown; provenance: OfficialRegistryProvenance }> {
  const requestedUrl = new URL(url);
  const authorizeExternalAction = async (): Promise<boolean> => {
    await options.beforeRequest?.();
    return true;
  };
  let response: PublicHttpResponse;
  try {
    response = await (options.request ?? requestPublicHttp)(
      requestedUrl.toString(),
      {
        method: 'GET',
        headers: { Accept: 'application/json', ...options.headers },
        timeoutMs: 20_000,
        maxBytes: MAX_OFFICIAL_REGISTRY_RESPONSE_BYTES,
        // Official registry contracts are fixed endpoints. A redirect is a
        // contract change, not permission to follow another wire destination.
        maxRedirects: 0,
      },
      { authorizeExternalAction },
    );
  } catch (error) {
    if (error instanceof EgressBlockedError && error.code === 'response_too_large') {
      throw new Error(`${source.toUpperCase()}_RESPONSE_TOO_LARGE`, { cause: error });
    }
    throw error;
  }
  if (response.finalUrl !== requestedUrl.toString()) {
    throw new Error(`${source.toUpperCase()}_FINAL_URL_INVALID`);
  }
  if (!response.ok) throw new Error(`OFFICIAL_REGISTRY_HTTP_${response.status}`);
  if (!response.headers['content-type']?.toLowerCase().includes('json')) {
    throw new Error(`${source.toUpperCase()}_CONTENT_TYPE_INVALID`);
  }
  const fetchedAt = new Date().toISOString();
  const { body, contentHash } = boundedResponseBody(response, source);
  try {
    return {
      value: JSON.parse(body) as unknown,
      provenance: {
        sourceUrl: response.finalUrl,
        fetchedAt,
        contentHash,
        parserVersion: options.parserVersion,
      },
    };
  } catch {
    throw new Error(`${source.toUpperCase()}_INVALID_JSON`);
  }
}

export async function searchRorOrganizations(
  input: { query: string; country: string; types: string[]; limit: number; page?: number },
  beforeRequest?: () => Promise<void>,
  dependencies: OfficialRegistryHttpDependencies = {},
): Promise<OfficialRegistrySearchResult<RorOrganization>> {
  const query = typeof input.query === 'string' ? input.query.trim().normalize('NFKC') : '';
  if (!query) throw new Error('ROR_SEARCH_CRITERION_REQUIRED');
  if (query.length > 300) throw new Error('ROR_QUERY_TOO_LONG');
  const country = typeof input.country === 'string' ? input.country.trim().toUpperCase() : '';
  if (!/^[A-Z]{2}$/u.test(country)) throw new Error('ROR_COUNTRY_INVALID');
  const types = Array.isArray(input.types)
    ? input.types.map((value) => typeof value === 'string' ? value.trim().toLowerCase() : '')
    : [];
  if (types.length !== 1 || !(ROR_ORGANIZATION_TYPES as readonly string[]).includes(types[0] ?? '')) {
    throw new Error('ROR_TYPE_INVALID');
  }
  const limit = Number.isSafeInteger(input.limit) ? Math.max(1, Math.min(input.limit, 20)) : 10;
  const page = Number.isSafeInteger(input.page) ? Number(input.page) : 1;
  if (page < 1 || page > 500) throw new Error('ROR_PAGE_INVALID');
  const url = new URL('https://api.ror.org/v2/organizations');
  url.searchParams.set('query', query);
  const filters = [
    `country.country_code:${country}`,
    ...types.map((type) => `types:${type}`),
  ];
  if (filters.length) url.searchParams.set('filter', filters.join(','));
  url.searchParams.set('page', String(page));
  const response = await jsonRequest('ror', url.toString(), {
    beforeRequest,
    parserVersion: 'ror-v2.1/2',
    request: dependencies.request,
  });
  const root = object(response.value);
  const total = Number(root?.number_of_results);
  if (!Number.isSafeInteger(total) || total < 0 || total > 10_000) fail('ror');
  const records = parseRorResponse(response.value).slice(0, limit);
  const lastPage = Math.min(500, Math.ceil(total / 20));
  return {
    records,
    total,
    ...(page < lastPage ? { nextCursor: String(page + 1) } : {}),
    provenance: response.provenance,
  };
}

function secEdgarHeaders(dependencies: OfficialRegistryHttpDependencies): Record<string, string> {
  const userAgent = (dependencies.env ?? process.env).SEC_EDGAR_USER_AGENT?.trim() ?? '';
  const contactMatch = userAgent.match(/^[^\s].*\s+[^\s@]+@([^\s@]+\.[^\s@]+)$/u);
  const contactDomain = contactMatch?.[1]?.toLocaleLowerCase('en-US') ?? '';
  const reservedContactDomain =
    ['example.com', 'example.net', 'example.org'].includes(contactDomain) ||
    /(?:^|\.)(?:example|invalid|test)$/u.test(contactDomain);
  if (
    userAgent.length < 6 || userAgent.length > 160 || /[\r\n]/u.test(userAgent) ||
    !contactMatch || reservedContactDomain
  ) {
    throw new Error('SEC_EDGAR_USER_AGENT_REQUIRED');
  }
  return { 'User-Agent': userAgent, 'Accept-Encoding': 'gzip, deflate' };
}

function normalizedSecName(value: string): string {
  return value.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

export async function searchSecCompanyDirectory(
  input: { query: string; limit: number },
  beforeRequest?: () => Promise<void>,
  dependencies: OfficialRegistryHttpDependencies = {},
): Promise<OfficialRegistrySearchResult<SecOrganization>> {
  const query = typeof input.query === 'string' ? input.query.normalize('NFKC').trim() : '';
  if (!query || query.length > 300) throw new Error('SEC_EDGAR_EXACT_QUERY_REQUIRED');
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 5) {
    throw new Error('SEC_EDGAR_LIMIT_INVALID');
  }
  const exactTicker = /^[A-Za-z0-9.-]{1,16}$/u.test(query) ? query.toUpperCase() : undefined;
  const exactName = normalizedSecName(query);
  const response = await jsonRequest('sec_edgar', 'https://www.sec.gov/files/company_tickers_exchange.json', {
    headers: secEdgarHeaders(dependencies),
    beforeRequest,
    parserVersion: 'sec-edgar-company-tickers-exchange/1',
    request: dependencies.request,
  });
  const records = parseSecCompanyDirectory(response.value)
    .filter((item) =>
      (exactTicker && item.ticker === exactTicker) ||
      normalizedSecName(item.name) === exactName,
    )
    .slice(0, input.limit);
  return { records, total: records.length, provenance: response.provenance };
}

export async function fetchSecSubmissionOrganization(
  input: { cik: string; expectedName: string },
  beforeRequest?: () => Promise<void>,
  dependencies: OfficialRegistryHttpDependencies = {},
): Promise<OfficialRegistrySearchResult<SecOrganization>> {
  const cik = normalizeCik(input.cik);
  const expectedName = typeof input.expectedName === 'string' ? normalizedSecName(input.expectedName) : '';
  if (!cik) throw new Error('SEC_EDGAR_CIK_INVALID');
  if (!expectedName || expectedName.length > 300) throw new Error('SEC_EDGAR_EXPECTED_NAME_REQUIRED');
  const response = await jsonRequest('sec_edgar', `https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: secEdgarHeaders(dependencies),
    beforeRequest,
    parserVersion: 'sec-edgar-submissions/2',
    request: dependencies.request,
  });
  const record = parseSecSubmission(response.value, cik);
  if (normalizedSecName(record.name) !== expectedName) throw new Error('SEC_EDGAR_DIRECTORY_BINDING_MISMATCH');
  return { records: [record], total: 1, provenance: response.provenance };
}

export async function searchFrenchOrganizations(
  input: { query: string; limit: number },
  beforeRequest?: () => Promise<void>,
  dependencies: OfficialRegistryHttpDependencies = {},
): Promise<OfficialRegistrySearchResult<FrenchOrganization>> {
  const query = typeof input.query === 'string' ? input.query.trim().slice(0, 300) : '';
  if (!query) throw new Error('FR_COMPANY_SEARCH_CRITERION_REQUIRED');
  const limit = Number.isSafeInteger(input.limit) ? Math.max(1, Math.min(input.limit, 25)) : 10;
  const url = new URL('https://recherche-entreprises.api.gouv.fr/search');
  url.searchParams.set('q', query);
  url.searchParams.set('page', '1');
  url.searchParams.set('per_page', String(limit));
  const response = await jsonRequest('fr_company', url.toString(), {
    beforeRequest,
    parserVersion: 'recherche-entreprises/1',
    request: dependencies.request,
  });
  return { records: parseFrenchResponse(response.value).slice(0, limit), provenance: response.provenance };
}

export async function searchNppesOrganizations(
  input: { organizationName?: string; npi?: string; state?: string; limit: number },
  beforeRequest?: () => Promise<void>,
  dependencies: OfficialRegistryHttpDependencies = {},
): Promise<OfficialRegistrySearchResult<NppesOrganization>> {
  const limit = Number.isSafeInteger(input.limit) ? Math.max(1, Math.min(input.limit, 200)) : 10;
  const url = new URL('https://npiregistry.cms.hhs.gov/api/');
  url.searchParams.set('version', '2.1');
  url.searchParams.set('enumeration_type', 'NPI-2');
  if (typeof input.npi === 'string' && input.npi.trim()) {
    const npi = input.npi.trim();
    if (!isValidNpiIdentifier(npi)) throw new Error('NPPES_NPI_INVALID');
    url.searchParams.set('number', npi);
  } else if (typeof input.organizationName === 'string' && input.organizationName.trim()) {
    url.searchParams.set('organization_name', input.organizationName.trim().slice(0, 300));
  } else {
    throw new Error('NPPES_SEARCH_CRITERION_REQUIRED');
  }
  if (typeof input.state === 'string' && input.state.trim()) {
    const state = input.state.trim().toUpperCase();
    if (!/^[A-Z]{2}$/u.test(state)) throw new Error('NPPES_STATE_INVALID');
    url.searchParams.set('state', state);
  }
  url.searchParams.set('limit', String(limit));
  const response = await jsonRequest('nppes', url.toString(), {
    beforeRequest,
    parserVersion: 'nppes-v2.1/1',
    request: dependencies.request,
  });
  const records = parseNppesResponse(response.value);
  if (url.searchParams.has('number') && records.some((record) => record.npi !== url.searchParams.get('number'))) {
    throw new Error('NPPES_EXACT_ID_MISMATCH');
  }
  return { records: records.slice(0, limit), provenance: response.provenance };
}
