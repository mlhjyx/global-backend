import { createHash } from 'node:crypto';
import {
  ExternalHttpActionDeniedError,
  requestPublicHttp,
  type PublicHttpResponse,
} from './guarded-http';

export interface FmcsaQcmobileCarrier {
  usdotNumber: string;
  legalName: string;
  dbaName?: string;
  allowedToOperate?: 'Y' | 'N';
  outOfService?: 'Y' | 'N';
  state?: string;
}

export interface FmcsaQcmobilePage {
  records: FmcsaQcmobileCarrier[];
  nextCursor?: string;
  provenance: {
    sourceUrl: string;
    fetchedAt: string;
    contentHash: string;
    parserVersion: 'fmcsa-qcmobile-v1/1';
  };
}

export interface FmcsaQcmobileDependencies {
  request?: typeof requestPublicHttp;
  env?: NodeJS.ProcessEnv;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CORPORATE_SUFFIX = /\b(?:CORP(?:ORATION)?|INC(?:ORPORATED)?|L\.?\s*L\.?\s*C\.?|LTD|LIMITED|L\.?\s*P\.?|L\.?\s*L\.?\s*P\.?|P\.?\s*L\.?\s*C\.?|ASSOCIATION|AUTHORITY|DISTRICT|UNIVERSITY|COLLEGE)\.?$/iu;
const PUBLIC_ORGANIZATION_PREFIX = /^(?:CITY|COUNTY|STATE|TOWN|TOWNSHIP|VILLAGE)\s+OF\b|^(?:DEPARTMENT|GOVERNMENT|MUNICIPALITY|UNIVERSITY|COLLEGE)\b/iu;

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const text = (value: unknown, max = 300): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ');
  return normalized && normalized.length <= max ? normalized : undefined;
};

export function normalizeUsdotNumber(value: unknown): string | undefined {
  const normalized = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === 'string'
      ? value.normalize('NFKC').trim()
      : '';
  return /^[1-9]\d{0,7}$/u.test(normalized) ? normalized : undefined;
}

export function isClearlyFmcsaOrganization(value: string): boolean {
  const normalized = value.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ');
  return CORPORATE_SUFFIX.test(normalized) || PUBLIC_ORGANIZATION_PREFIX.test(normalized);
}

function yesNo(value: unknown): 'Y' | 'N' | undefined {
  const normalized = text(value, 1)?.toUpperCase();
  return normalized === 'Y' || normalized === 'N' ? normalized : undefined;
}

/**
 * QCMobile carrier rows can contain sole proprietors, phones, email and exact
 * addresses. This allowlist admits only clearly organizational carrier facts.
 */
export function parseFmcsaQcmobileResponse(value: unknown, maximumRows = 10): FmcsaQcmobileCarrier[] {
  const root = object(value);
  if (!root || !Array.isArray(root.content) || root.content.length > maximumRows) {
    throw new Error('FMCSA_SCHEMA_CHANGED');
  }
  return root.content.flatMap((raw) => {
    const carrier = object(object(raw)?.carrier);
    const usdotNumber = normalizeUsdotNumber(carrier?.dotNumber);
    const legalName = text(carrier?.legalName, 200);
    const country = text(carrier?.phyCountry, 80)?.toUpperCase();
    if (!carrier || !usdotNumber || !legalName || !isClearlyFmcsaOrganization(legalName)) return [];
    if (country && !['US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA'].includes(country)) return [];
    const state = text(carrier.phyState, 2)?.toUpperCase();
    return [{
      usdotNumber,
      legalName,
      dbaName: text(carrier.dbaName, 200),
      allowedToOperate: yesNo(carrier.allowToOperate ?? carrier.allowedToOperate),
      outOfService: yesNo(carrier.outOfService),
      state: state && /^[A-Z]{2}$/u.test(state) ? state : undefined,
    }];
  });
}

function exactName(value: string): string {
  return value.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

export async function searchFmcsaQcmobile(
  input: { query: string; start: number; limit: number },
  beforeRequest?: () => Promise<void>,
  dependencies: FmcsaQcmobileDependencies = {},
): Promise<FmcsaQcmobilePage> {
  const query = typeof input.query === 'string' ? input.query.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ') : '';
  if (!query || query.length > 200 || ['all', 'any', 'carriers'].includes(exactName(query)) || /[*?,;]/u.test(query)) {
    throw new Error('FMCSA_EXACT_QUERY_REQUIRED');
  }
  if (
    !Number.isSafeInteger(input.start) || input.start < 0 || input.start > 49 ||
    !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10 ||
    input.start + input.limit > 50
  ) throw new Error('FMCSA_PAGE_INVALID');

  const webKey = (dependencies.env ?? process.env).FMCSA_QCMOBILE_WEB_KEY?.trim() ?? '';
  if (!webKey || webKey.length > 500 || /\s/u.test(webKey)) throw new Error('FMCSA_WEB_KEY_REQUIRED');

  const publicUrl = new URL(`https://mobile.fmcsa.dot.gov/qc/services/carriers/name/${encodeURIComponent(query)}`);
  publicUrl.searchParams.set('start', String(input.start));
  publicUrl.searchParams.set('size', String(input.limit));
  const secretUrl = new URL(publicUrl);
  secretUrl.searchParams.set('webKey', webKey);
  let response: PublicHttpResponse;
  try {
    response = await (dependencies.request ?? requestPublicHttp)(secretUrl.toString(), {
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
    throw new Error('FMCSA_REQUEST_FAILED', { cause: error });
  }
  if (response.finalUrl !== secretUrl.toString()) throw new Error('FMCSA_FINAL_URL_INVALID');
  if (!response.ok) throw new Error(`FMCSA_HTTP_${response.status}`);
  if (!response.headers['content-type']?.toLowerCase().includes('json')) throw new Error('FMCSA_CONTENT_TYPE_INVALID');
  if (response.body.byteLength > MAX_RESPONSE_BYTES) throw new Error('FMCSA_RESPONSE_TOO_LARGE');

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
  } catch {
    throw new Error('FMCSA_INVALID_UTF8');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(decoded) as unknown;
  } catch {
    throw new Error('FMCSA_INVALID_JSON');
  }
  const records = parseFmcsaQcmobileResponse(raw, input.limit);
  const rawCount = object(raw)?.content;
  const publicProvenanceUrl = new URL(publicUrl);
  publicProvenanceUrl.searchParams.set('webKey', 'REDACTED');
  return {
    records,
    ...(Array.isArray(rawCount) && rawCount.length === input.limit && input.start + input.limit < 50
      ? { nextCursor: String(input.start + input.limit) }
      : {}),
    provenance: {
      sourceUrl: publicProvenanceUrl.toString(),
      fetchedAt: new Date().toISOString(),
      contentHash: createHash('sha256').update(JSON.stringify(records)).digest('hex'),
      parserVersion: 'fmcsa-qcmobile-v1/1',
    },
  };
}
