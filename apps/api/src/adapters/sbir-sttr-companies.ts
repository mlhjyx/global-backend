import { createHash } from 'node:crypto';
import {
  ExternalHttpActionDeniedError,
  requestPublicHttp,
  type PublicHttpResponse,
} from './guarded-http';

export interface SbirSttrCompany {
  sourceId: string;
  companyName: string;
  officialProfileUrl?: string;
  uei?: string;
  state?: string;
  awardCount?: number;
}

export interface SbirSttrCompanyPage {
  records: SbirSttrCompany[];
  nextCursor?: string;
  provenance: {
    sourceUrl: string;
    fetchedAt: string;
    contentHash: string;
    parserVersion: 'sbir-sttr-company-v1/1';
  };
}

export interface SbirSttrCompanyDependencies {
  request?: typeof requestPublicHttp;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const text = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ');
  return normalized && normalized.length <= max ? normalized : undefined;
};

function sourceId(value: unknown): string | undefined {
  const normalized = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === 'string'
      ? value.normalize('NFKC').trim()
      : '';
  return /^[1-9]\d{0,17}$/u.test(normalized) ? normalized : undefined;
}

function uei(value: unknown): string | undefined {
  const normalized = text(value, 12)?.toUpperCase();
  return normalized && /^[A-Z0-9]{12}$/u.test(normalized) ? normalized : undefined;
}

function state(value: unknown): string | undefined {
  const normalized = text(value, 2)?.toUpperCase();
  return normalized && /^[A-Z]{2}$/u.test(normalized) ? normalized : undefined;
}

function awardCount(value: unknown): number | undefined {
  const normalized = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d{1,6}$/u.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  return Number.isSafeInteger(normalized) && normalized >= 0 && normalized <= 999_999
    ? normalized
    : undefined;
}

function officialProfileUrl(value: unknown): string | undefined {
  const raw = text(value, 500);
  if (!raw) return undefined;
  try {
    const url = new URL(raw, 'https://www.sbir.gov');
    if (
      url.protocol !== 'https:' || url.hostname !== 'www.sbir.gov' || url.username || url.password || url.hash ||
      !/^\/portfolio\/\d+\/?$/u.test(url.pathname)
    ) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function exactName(value: string): string {
  return value.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

/**
 * The official Company API also returns street addresses, DUNS, ownership
 * demographics and company URLs. Only this organization-level allowlist is
 * admitted to the Provider boundary.
 */
export function parseSbirSttrCompanyResponse(value: unknown, maximumRows = 10): SbirSttrCompany[] {
  if (!Array.isArray(value) || value.length > maximumRows) throw new Error('SBIR_SCHEMA_CHANGED');
  return value.flatMap((raw) => {
    const row = object(raw);
    const normalizedSourceId = sourceId(row?.firm_nid);
    const companyName = text(row?.company_name, 255);
    if (!row || !normalizedSourceId || !companyName) return [];
    return [{
      sourceId: normalizedSourceId,
      companyName,
      officialProfileUrl: officialProfileUrl(row.sbir_url),
      uei: uei(row.uei),
      state: state(row.state),
      awardCount: awardCount(row.number_awards),
    }];
  });
}

export async function searchSbirSttrCompanies(
  input: { query: string; start: number; limit: number },
  beforeRequest?: () => Promise<void>,
  dependencies: SbirSttrCompanyDependencies = {},
): Promise<SbirSttrCompanyPage> {
  const query = typeof input.query === 'string'
    ? input.query.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ')
    : '';
  if (
    !query || query.length > 200 || ['all', 'any', 'companies', 'businesses'].includes(exactName(query)) ||
    /[*?,;]/u.test(query)
  ) throw new Error('SBIR_EXACT_QUERY_REQUIRED');
  if (
    !Number.isSafeInteger(input.start) || input.start < 0 || input.start > 49 ||
    !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10 ||
    input.start + input.limit > 50
  ) throw new Error('SBIR_PAGE_INVALID');

  const url = new URL('https://api.www.sbir.gov/public/api/firm');
  url.searchParams.set('name', query);
  url.searchParams.set('rows', String(input.limit));
  url.searchParams.set('start', String(input.start));
  url.searchParams.set('format', 'json');
  url.searchParams.set('sort', 'name');

  let response: PublicHttpResponse;
  try {
    response = await (dependencies.request ?? requestPublicHttp)(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeoutMs: 20_000,
      maxBytes: MAX_RESPONSE_BYTES,
      maxRedirects: 0,
    }, {
      authorizeExternalAction: async () => {
        await beforeRequest?.();
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ExternalHttpActionDeniedError) throw error;
    throw new Error('SBIR_REQUEST_FAILED', { cause: error });
  }
  if (response.finalUrl !== url.toString()) throw new Error('SBIR_FINAL_URL_INVALID');
  if (!response.ok) throw new Error(`SBIR_HTTP_${response.status}`);
  if (!response.headers['content-type']?.toLowerCase().includes('json')) {
    throw new Error('SBIR_CONTENT_TYPE_INVALID');
  }
  if (response.body.byteLength > MAX_RESPONSE_BYTES) throw new Error('SBIR_RESPONSE_TOO_LARGE');

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
  } catch {
    throw new Error('SBIR_INVALID_UTF8');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(decoded) as unknown;
  } catch {
    throw new Error('SBIR_INVALID_JSON');
  }
  const records = parseSbirSttrCompanyResponse(raw, input.limit)
    .filter((record) => exactName(record.companyName) === exactName(query));
  return {
    records,
    ...(Array.isArray(raw) && raw.length === input.limit && input.start + input.limit < 50
      ? { nextCursor: String(input.start + input.limit) }
      : {}),
    provenance: {
      sourceUrl: url.toString(),
      fetchedAt: new Date().toISOString(),
      contentHash: createHash('sha256').update(JSON.stringify(records)).digest('hex'),
      parserVersion: 'sbir-sttr-company-v1/1',
    },
  };
}
