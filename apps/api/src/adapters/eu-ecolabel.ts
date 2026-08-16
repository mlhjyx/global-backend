import { createHash } from 'node:crypto';
import {
  ExternalHttpActionDeniedError,
  requestPublicHttp,
  type PublicHttpResponse,
} from './guarded-http';

export interface EuEcolabelProduct {
  licenceNumber: string;
  expirationDate?: string;
  decision?: string;
  groupName?: string;
  licenceHolder: string;
  licenceHolderCountry: string;
  licenceHolderCountryCode: string;
  itemId: string;
  productName?: string;
}

export interface EuEcolabelProductsPage {
  records: EuEcolabelProduct[];
  nextCursor?: string;
  provenance: {
    sourceUrl: string;
    fetchedAt: string;
    contentHash: string;
    parserVersion: 'ec-env-data-ecolabel-products-v2/1';
  };
}

export interface EuEcolabelDependencies {
  request?: typeof requestPublicHttp;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SAFE_FIELDS = [
  'licence_number',
  'expiration_date',
  'decision',
  'group_name',
  'licence_holder',
  'licence_holder_country',
  'item_id',
  'product_name',
] as const;
const LEGAL_FORM_SUFFIX = /(?:\b(?:AG|APS|AS|AB|BV|CORP(?:ORATION)?|DOO|EURL|GMBH|INC(?:ORPORATED)?|KG|KFT|LDA|LIMITED|LLC|LLP|LTD|MBH|NV|OY|OYJ|PLC|SARL|SAS|SE|SLU|SRO|SRL|ZRT)\.?|\bS\.?\s*(?:A|L|R\s*L|P\s*A)\.?|\bSP\.?\s*Z\.?\s*O\.?\s*O\.?)$/iu;
const ORGANIZATION_PREFIX = /^(?:ASSOCIATION|AUTHORITY|COOPERATIVE|FOUNDATION|INSTITUTE|MINISTRY|MUNICIPALITY|UNIVERSIT(?:Y|À|ÄT|É))\b/iu;
const EEA_COUNTRIES = {
  AT: 'Austria', BE: 'Belgium', BG: 'Bulgaria', HR: 'Croatia', CY: 'Cyprus', CZ: 'Czechia',
  DK: 'Denmark', EE: 'Estonia', FI: 'Finland', FR: 'France', DE: 'Germany', GR: 'Greece',
  HU: 'Hungary', IS: 'Iceland', IE: 'Ireland', IT: 'Italy', LV: 'Latvia', LI: 'Liechtenstein',
  LT: 'Lithuania', LU: 'Luxembourg', MT: 'Malta', NL: 'Netherlands', NO: 'Norway', PL: 'Poland',
  PT: 'Portugal', RO: 'Romania', SK: 'Slovakia', SI: 'Slovenia', ES: 'Spain', SE: 'Sweden',
} as const;

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const text = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ');
  return normalized && normalized.length <= max ? normalized : undefined;
};

const integer = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function exact(value: string): string {
  return value.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

/** Bounded scheme-jurisdiction map; non-EEA source labels are not identity inputs. */
export function normalizeEuEcolabelCountry(value: string): { code: string; sourceName: string } | undefined {
  const normalized = exact(value);
  for (const [code, sourceName] of Object.entries(EEA_COUNTRIES)) {
    if (normalized === exact(code) || normalized === exact(sourceName)) return { code, sourceName };
  }
  return undefined;
}

export function isClearlyEuEcolabelOrganization(value: string): boolean {
  const normalized = value.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ');
  if (!normalized || normalized.length > 200 || ['all', 'any', 'companies', 'products'].includes(exact(normalized))) return false;
  return LEGAL_FORM_SUFFIX.test(normalized) || ORGANIZATION_PREFIX.test(normalized);
}

function parseItemId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFKC').trim();
  return /^[1-9]\d{0,15}$/u.test(normalized) ? normalized : undefined;
}

function parseExpirationDate(value: unknown): string | undefined {
  const candidate = text(value, 40);
  return candidate && !Number.isNaN(new Date(candidate).getTime()) ? candidate : undefined;
}

export function parseEuEcolabelProductsResponse(
  value: unknown,
  expectedOffset: number,
  expectedLimit: number,
): { records: EuEcolabelProduct[]; total: number } {
  const root = object(value);
  const meta = object(root?.meta);
  const total = integer(meta?.total);
  const count = integer(meta?.count);
  const offset = integer(meta?.offset);
  const limit = integer(meta?.limit);
  if (
    !root || !Array.isArray(root.data) || !meta || total === undefined || count === undefined ||
    offset !== expectedOffset || limit !== expectedLimit || count !== root.data.length ||
    root.data.length > expectedLimit || total < count
  ) throw new Error('EU_ECOLABEL_SCHEMA_CHANGED');

  const records = root.data.flatMap((raw): EuEcolabelProduct[] => {
    const item = object(raw);
    const licenceNumber = text(item?.licence_number, 80);
    const licenceHolder = text(item?.licence_holder, 200);
    const licenceHolderCountry = text(item?.licence_holder_country, 100);
    const country = licenceHolderCountry ? normalizeEuEcolabelCountry(licenceHolderCountry) : undefined;
    const itemId = parseItemId(item?.item_id);
    if (
      !item || !licenceNumber || !/^[\p{L}\d][\p{L}\d ./_-]{1,79}$/u.test(licenceNumber) ||
      !licenceHolder || !isClearlyEuEcolabelOrganization(licenceHolder) ||
      !licenceHolderCountry || !country || !/^[\p{L}][\p{L} .'-]{1,99}$/u.test(licenceHolderCountry) || !itemId
    ) return [];
    return [{
      licenceNumber,
      expirationDate: parseExpirationDate(item.expiration_date),
      decision: text(item.decision, 100),
      groupName: text(item.group_name, 200),
      licenceHolder,
      licenceHolderCountry,
      licenceHolderCountryCode: country.code,
      itemId,
      productName: text(item.product_name, 300),
    }];
  });
  return { records, total };
}

export async function searchEuEcolabelProducts(
  input: { organizationName: string; country: string; offset: number; limit: number },
  beforeRequest?: () => Promise<void>,
  dependencies: EuEcolabelDependencies = {},
): Promise<EuEcolabelProductsPage> {
  const organizationName = typeof input.organizationName === 'string'
    ? input.organizationName.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ')
    : '';
  const country = typeof input.country === 'string' ? normalizeEuEcolabelCountry(input.country) : undefined;
  if (!isClearlyEuEcolabelOrganization(organizationName) || /[*?,;]/u.test(organizationName)) {
    throw new Error('EU_ECOLABEL_EXACT_ORGANIZATION_REQUIRED');
  }
  if (!country) {
    throw new Error('EU_ECOLABEL_COUNTRY_REQUIRED');
  }
  if (
    !Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > 99 ||
    !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20 ||
    input.offset + input.limit > 100
  ) throw new Error('EU_ECOLABEL_PAGE_INVALID');

  const url = new URL('https://apps.data.env.service.ec.europa.eu/dataquery/v2/ecolabel/products');
  url.searchParams.set('offset', String(input.offset));
  url.searchParams.set('limit', String(input.limit));
  url.searchParams.set('fields', SAFE_FIELDS.join(','));
  url.searchParams.set('order_by', 'licence_number,item_id');
  url.searchParams.set('licence_holder', organizationName);
  url.searchParams.set('licence_holder_country', country.sourceName);

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
    throw new Error('EU_ECOLABEL_REQUEST_FAILED', { cause: error });
  }
  if (response.finalUrl !== url.toString()) throw new Error('EU_ECOLABEL_FINAL_URL_INVALID');
  if (!response.ok) throw new Error(`EU_ECOLABEL_HTTP_${response.status}`);
  if (!response.headers['content-type']?.toLowerCase().includes('json')) throw new Error('EU_ECOLABEL_CONTENT_TYPE_INVALID');
  if (response.body.byteLength > MAX_RESPONSE_BYTES) throw new Error('EU_ECOLABEL_RESPONSE_TOO_LARGE');

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
  } catch {
    throw new Error('EU_ECOLABEL_INVALID_UTF8');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(decoded) as unknown;
  } catch {
    throw new Error('EU_ECOLABEL_INVALID_JSON');
  }
  const parsed = parseEuEcolabelProductsResponse(raw, input.offset, input.limit);
  const records = parsed.records.filter((item) =>
    exact(item.licenceHolder) === exact(organizationName) && item.licenceHolderCountryCode === country.code
  );
  const nextOffset = input.offset + input.limit;
  return {
    records,
    ...(nextOffset < parsed.total && nextOffset < 100 ? { nextCursor: String(nextOffset) } : {}),
    provenance: {
      sourceUrl: url.toString(),
      fetchedAt: new Date().toISOString(),
      contentHash: createHash('sha256').update(JSON.stringify(records)).digest('hex'),
      parserVersion: 'ec-env-data-ecolabel-products-v2/1',
    },
  };
}
