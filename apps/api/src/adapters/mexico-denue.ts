import { createHash } from 'node:crypto';
import {
  ExternalHttpActionDeniedError,
  requestPublicHttp,
  type PublicHttpResponse,
} from './guarded-http';

export interface MexicoDenueOrganization {
  clee: string;
  denueId: string;
  name: string;
  legalName: string;
  economicActivity?: string;
  size?: string;
  state?: string;
  municipality?: string;
  locality?: string;
  establishmentType?: string;
  website?: string;
}

export interface MexicoDenuePage {
  records: MexicoDenueOrganization[];
  nextCursor?: string;
  provenance: {
    sourceUrl: string;
    fetchedAt: string;
    contentHash: string;
    parserVersion: 'denue-nombre-v1/1';
  };
}

export interface MexicoDenueDependencies {
  request?: typeof requestPublicHttp;
  env?: NodeJS.ProcessEnv;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CORPORATE_SUFFIX = /,\s*(?:S\.?\s*A\.?(?:\s+DE\s+C\.?\s*V\.?)?|S\.?\s+DE\s+R\.?\s*L\.?(?:\s+DE\s+C\.?\s*V\.?)?|S\.?\s*C\.?|A\.?\s*C\.?|I\.?\s*A\.?\s*P\.?|S\.?\s*A\.?\s*P\.?\s*I\.?(?:\s+DE\s+C\.?\s*V\.?)?|S\.?\s*A\.?\s*S\.?(?:\s+DE\s+C\.?\s*V\.?)?|S\.?\s*N\.?\s*C\.?|S\.?\s*F\.?\s*C\.?)$/iu;
const PUBLIC_ORGANIZATION_PREFIX = /^(?:ASOCIACI[OÓ]N|AYUNTAMIENTO|GOBIERNO|INSTITUCI[OÓ]N|INSTITUTO|MUNICIPIO|SECRETAR[IÍ]A|UNIVERSIDAD)\b/iu;

function isClearlyLegalOrganization(value: string): boolean {
  return CORPORATE_SUFFIX.test(value) || PUBLIC_ORGANIZATION_PREFIX.test(value);
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const text = (value: unknown, max = 500): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ');
  return normalized && normalized.length <= max ? normalized : undefined;
};

function safeWebsite(value: unknown): string | undefined {
  const candidate = text(value, 500);
  if (!candidate) return undefined;
  try {
    const url = new URL(/^https?:\/\//iu.test(candidate) ? candidate : `https://${candidate}`);
    const hostname = url.hostname.toLowerCase();
    if (
      !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !hostname.includes('.') || hostname === 'localhost' || /^\d+(?:\.\d+){3}$/u.test(hostname)
    ) return undefined;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

export function isValidPublishedClee(value: string): boolean {
  return /^\d{26}[MSU]\d$/u.test(value) && !/^0{26}/u.test(value);
}

/**
 * Raw-boundary allowlist. DENUE publishes no Razon_social for natural-person
 * establishments; the legal-form marker is an additional fail-closed guard.
 */
export function parseMexicoDenueResponse(value: unknown, maximumRows = 20): MexicoDenueOrganization[] {
  if (!Array.isArray(value) || value.length > maximumRows) throw new Error('DENUE_SCHEMA_CHANGED');
  return value.flatMap((raw) => {
    const item = object(raw);
    const clee = text(item?.CLEE, 28)?.toUpperCase();
    const denueId = text(item?.Id, 10);
    const name = text(item?.Nombre, 300);
    const legalName = text(item?.Razon_social, 300);
    if (!item || !clee || !denueId || !name || !legalName) return [];
    if (!isValidPublishedClee(clee) || !/^\d{10}$/u.test(denueId) || !isClearlyLegalOrganization(legalName)) return [];
    return [{
      clee,
      denueId,
      name,
      legalName,
      economicActivity: text(item.Clase_actividad, 500),
      size: text(item.Estrato, 100),
      state: text(item.Entidad_federativa, 120) ?? text(item.Entidad, 120),
      municipality: text(item.Municipio, 120),
      locality: text(item.Localidad, 120),
      establishmentType: text(item.Tipo, 80),
      website: safeWebsite(item.Sitio_internet),
    }];
  });
}

function exactName(value: string): string {
  return value.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ').toLocaleLowerCase('es-MX');
}

export async function searchMexicoDenue(
  input: { query: string; stateCode: string; start: number; limit: number },
  beforeRequest?: () => Promise<void>,
  dependencies: MexicoDenueDependencies = {},
): Promise<MexicoDenuePage> {
  const query = typeof input.query === 'string' ? input.query.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ') : '';
  if (!query || query.length > 200 || exactName(query) === 'todos' || /[*?,;]/u.test(query)) {
    throw new Error('DENUE_EXACT_QUERY_REQUIRED');
  }
  if (!/^(?:0[1-9]|[12]\d|3[0-2])$/u.test(input.stateCode)) throw new Error('DENUE_STATE_CODE_INVALID');
  if (!Number.isSafeInteger(input.start) || input.start < 1 || input.start > 481) throw new Error('DENUE_START_INVALID');
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20) throw new Error('DENUE_LIMIT_INVALID');
  const token = (dependencies.env ?? process.env).MEXICO_DENUE_TOKEN?.trim() ?? '';
  if (!token || token.length > 500 || /[\s/\r\n]/u.test(token)) throw new Error('DENUE_TOKEN_REQUIRED');

  const end = input.start + input.limit - 1;
  const publicPath = `/app/api/denue/v1/consulta/Nombre/${encodeURIComponent(query)}/${input.stateCode}/${input.start}/${end}`;
  const secretUrl = `https://www.inegi.org.mx${publicPath}/${encodeURIComponent(token)}`;
  let response: PublicHttpResponse;
  try {
    response = await (dependencies.request ?? requestPublicHttp)(secretUrl, {
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
    throw new Error('DENUE_REQUEST_FAILED', { cause: error });
  }
  if (response.finalUrl !== secretUrl) throw new Error('DENUE_FINAL_URL_INVALID');
  if (!response.ok) throw new Error(`DENUE_HTTP_${response.status}`);
  if (!response.headers['content-type']?.toLowerCase().includes('json')) throw new Error('DENUE_CONTENT_TYPE_INVALID');
  if (response.body.byteLength > MAX_RESPONSE_BYTES) throw new Error('DENUE_RESPONSE_TOO_LARGE');

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
  } catch {
    throw new Error('DENUE_INVALID_UTF8');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(decoded) as unknown;
  } catch {
    throw new Error('DENUE_INVALID_JSON');
  }
  const sanitized = parseMexicoDenueResponse(raw, input.limit);
  const expected = exactName(query);
  const records = sanitized.filter((record) =>
    exactName(record.name) === expected || exactName(record.legalName) === expected
  );
  const sanitizedBytes = JSON.stringify(records);
  return {
    records,
    ...(Array.isArray(raw) && raw.length === input.limit && end < 500 ? { nextCursor: String(end + 1) } : {}),
    provenance: {
      sourceUrl: `https://www.inegi.org.mx${publicPath}/REDACTED_TOKEN`,
      fetchedAt: new Date().toISOString(),
      contentHash: createHash('sha256').update(sanitizedBytes).digest('hex'),
      parserVersion: 'denue-nombre-v1/1',
    },
  };
}
